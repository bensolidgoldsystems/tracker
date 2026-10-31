// Solid Gold Systems Tracker - Meta Marketing API sync.
// For every ad account the SGS system user can see:
//   - daily spend and leads -> public.meta_daily (leads drive pay-per-lead; spend is for reference)
//   - for clients whose ad spend SGS pays: the actual card charges ("billing charge" events in the
//     account's activity log) -> public.money_entries (category ad_spend, source meta_api).
//     Charges carry Meta's transaction ID, the same one the billing report CSV shows, so nothing is
//     counted twice; only charges after the last imported CSV charge for that account are added.
//   - the account's current balance (spend not yet charged to the card) and which card it bills.
//   - individual leads from instant forms on every Page the system user can see (needs the Page
//     assigned with Leads access and the token to include leads_retrieval, pages_show_list,
//     pages_read_engagement, pages_manage_ads) -> public.meta_leads, matched to clients by ad account.
//   - when each client's ads went live / paused -> public.ad_events (source 'meta').
// Called by pg_cron (x-cron-secret header; full sync hourly, {action:"leads"} every 2 minutes) and by "Sync now" in Tracker Settings
// (signed-in team member whose sign-in passed email 2FA).
// Secrets: META_ACCESS_TOKEN (system user token, ads_read), optional META_API_VERSION.
// Cron secret: Supabase Vault 'meta_sync_secret' (see supabase/sql/meta-sync.sql).
import { createClient } from "npm:@supabase/supabase-js@2";

const ALLOWED_ORIGINS = ["https://tracker.solidgoldsystems.com", "https://solidgoldtracker.netlify.app"];
const GRAPH = "https://graph.facebook.com/" + (Deno.env.get("META_API_VERSION") || "v23.0");
const FIRST_DAY = "2026-01-01";     // first sync goes back to here
const REFRESH_DAYS = 7;             // Meta adjusts recent days (late-attributed leads, spend credits): re-pull them each run
// SGS's own ad account(s): also pulled per ad (campaign / ad set / ad) for the SGS Leads tab.
const OWN_ACCOUNTS = (Deno.env.get("META_OWN_ACCOUNTS") || "1399902944415343").split(",").map((x) => x.trim()).filter(Boolean);

const url = Deno.env.get("SUPABASE_URL")!;
function serviceKey(): string {
  try {
    const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
    if (keys.default) return keys.default;
  } catch (_) { /* fall back to legacy key */ }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
}
const db = createClient(url, serviceKey(), { auth: { persistSession: false, autoRefreshToken: false } });

function cors(req: Request) {
  const origin = req.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
function json(req: Request, status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors(req), "Content-Type": "application/json" } });
}
function ymd(d: Date) { return d.toISOString().slice(0, 10); }
function addDays(s: string, n: number) { const d = new Date(s + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return ymd(d); }

async function isTeam(token: string): Promise<boolean> {
  if (!token) return false;
  const anon = Deno.env.get("SUPABASE_ANON_KEY") || "";
  const user = createClient(url, anon, { auth: { persistSession: false }, global: { headers: { Authorization: "Bearer " + token } } });
  const { data, error } = await user.rpc("is_team");
  return !error && data === true;
}

// Tokens never go in error text (errors are stored and shown in Settings).
const redact = (s: string) => String(s).replace(/access_token=[^&\s"']+/g, "access_token=…");
async function graph(path: string, params: Record<string, string>, token: string) {
  const u = new URL(path.startsWith("http") ? path : GRAPH + path);
  if (!path.startsWith("http")) for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  // The token goes in the header (paging links from Meta carry their own: use it as-is).
  const auth = u.searchParams.get("access_token") || token;
  u.searchParams.delete("access_token");
  let res: Response;
  try { res = await fetch(u.toString(), { headers: { Authorization: "Bearer " + auth } }); }
  catch (e) { throw new Error(redact("Network error calling Meta: " + ((e as Error).message || e))); }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    const e = body.error || {};
    throw new Error(redact((e.message || ("HTTP " + res.status)) + (e.code ? " (code " + e.code + ")" : "")));
  }
  return body;
}
async function graphAll(path: string, params: Record<string, string>, token: string) {
  const out: any[] = [];
  let page = await graph(path, params, token);
  for (let i = 0; i < 50; i++) {
    out.push(...(page.data || []));
    const next = page.paging && page.paging.next;
    if (!next) break;
    page = await graph(next, {}, token);
  }
  return out;
}
function leadCount(actions: any[] | undefined): number {
  const a = actions || [];
  const pick = (t: string) => { const x = a.find((y) => y.action_type === t); return x ? Number(x.value) || 0 : null; };
  return pick("lead") ?? pick("onsite_conversion.lead_grouped") ?? pick("offsite_conversion.fb_pixel_lead") ?? 0;
}

// Calendar date in New York for a Meta timestamp.
function nyDate(iso: string): string {
  const d = new Date(iso);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
function parseExtra(x: unknown): Record<string, any> {
  if (!x) return {};
  if (typeof x === "object") return x as Record<string, any>;
  try { return JSON.parse(String(x)); } catch (_) { return {}; }
}
// Card charges from the account's activity log -> money_entries (ad_spend, meta_api).
async function syncCharges(acct: string, clientId: string, token: string, card0: string): Promise<number> {
  // Start after the last imported billing-report charge, or a week before the last synced one.
  const { data: lastCsv } = await db.from("money_entries").select("entry_date").eq("ad_account_id", acct).eq("source", "meta_csv")
    .order("entry_date", { ascending: false }).limit(1);
  const { data: lastApi } = await db.from("money_entries").select("entry_date").eq("ad_account_id", acct).eq("source", "meta_api")
    .order("entry_date", { ascending: false }).limit(1);
  const csvCut = lastCsv && lastCsv.length ? lastCsv[0].entry_date : null;
  let since = csvCut || FIRST_DAY;
  if (lastApi && lastApi.length) { const s2 = addDays(lastApi[0].entry_date, -7); if (s2 > since) since = s2; }
  const events = await graphAll("/act_" + acct + "/activities", {
    fields: "event_time,event_type,extra_data", since: since, until: ymd(new Date()), limit: "500",
  }, token);
  const rows: any[] = [];
  let skipped = 0;
  for (const ev of events) {
    if (ev.event_type !== "ad_account_billing_charge") continue;
    const x = parseExtra(ev.extra_data);
    const cents = Number(x.new_value ?? x.amount ?? x.charge_amount);
    if (!isFinite(cents) || !cents) continue;
    const date = nyDate(ev.event_time);
    const txn = String(x.transaction_id || x.txn_id || "");
    // Billing-report rows share the meta:<transaction id> reference, so those dedupe on their own.
    if (csvCut && date <= csvCut && !txn) { skipped++; continue; }
    const card = String(x.payment_method || x.funding_source || x.card || card0 || "");
    rows.push({
      client_id: clientId, category: "ad_spend", month: date.slice(0, 7) + "-01", entry_date: date,
      amount: Math.round(cents) / 100, source: "meta_api", ad_account_id: acct,
      external_ref: "meta:" + (txn || ev.event_time + ":" + cents),
      payment_method: card.slice(0, 60), note: txn ? "" : "Meta charge (no transaction ID)",
    });
  }
  // Billing events we couldn't read: surface one so the format can be fixed (shows in Settings).
  const billing = events.filter((e) => e.event_type === "ad_account_billing_charge");
  if (billing.length > skipped && !rows.length) {
    throw new Error("Couldn't read billing charges; sample: " + JSON.stringify(billing[0].extra_data).slice(0, 300));
  }
  if (!rows.length) return 0;
  const { data, error } = await db.from("money_entries").upsert(rows, { onConflict: "external_ref", ignoreDuplicates: true }).select("id");
  if (error) throw error;
  return (data || []).length;
}

// Daily numbers per ad -> public.meta_ad_daily.
async function syncAdDaily(acct: string, token: string, sinceOverride?: string): Promise<number> {
  let since = sinceOverride || FIRST_DAY;
  if (!sinceOverride) {
    const { data: last } = await db.from("meta_ad_daily").select("day").eq("ad_account_id", acct).order("day", { ascending: false }).limit(1);
    if (last && last.length) since = addDays(last[0].day, -REFRESH_DAYS);
  }
  const until = ymd(new Date());
  let n = 0;
  for (let start = since; start <= until; start = addDays(start, 90)) {
    const end = addDays(start, 89) < until ? addDays(start, 89) : until;
    const rows = await graphAll("/act_" + acct + "/insights", {
      level: "ad", time_increment: "1",
      fields: "campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,spend,impressions,clicks,inline_link_clicks,actions",
      time_range: JSON.stringify({ since: start, until: end }), limit: "500",
    }, token);
    if (!rows.length) continue;
    const up = rows.map((r) => ({
      ad_id: String(r.ad_id), day: r.date_start, ad_account_id: acct,
      campaign_id: String(r.campaign_id || ""), campaign_name: r.campaign_name || "", adset_id: String(r.adset_id || ""), adset_name: r.adset_name || "",
      ad_name: r.ad_name || "", spend: Number(r.spend) || 0, impressions: Number(r.impressions) || 0, clicks: Number(r.clicks) || 0,
      link_clicks: Number(r.inline_link_clicks) || 0, leads: leadCount(r.actions), synced_at: new Date().toISOString(),
    }));
    const { error } = await db.from("meta_ad_daily").upsert(up, { onConflict: "ad_id,day" });
    if (error) throw error;
    n += up.length;
  }
  return n;
}

// Ads live / paused per client, from Meta: a day is "live" when the client's accounts spent $1+;
// a gap of more than GAP_DAYS without spend means the ads were paused (dated the day after the last
// spend). Today's state also uses whether any campaign is ACTIVE, so a pause shows within the hour.
const GAP_DAYS = 3;
async function syncAdEvents(clients: any[], delivering: Record<string, boolean>) {
  const today = nyDate(new Date().toISOString());
  let made = 0;
  for (const c of clients) {
    const accts = (c.meta_ad_account_ids || []).filter((x: string) => /^\d+$/.test(x));
    if (!accts.length) continue;
    // Couldn't check one of the accounts this run: leave this client's dates as they are.
    if (accts.some((a: string) => delivering[a] === undefined)) continue;
    const spend: Record<string, number> = {};
    for (let from = 0; from < 20000; from += 1000) {
      const { data } = await db.from("meta_daily").select("day,spend").in("ad_account_id", accts).gt("spend", 0).order("day").order("ad_account_id").range(from, from + 999);
      for (const r of data || []) spend[r.day] = (spend[r.day] || 0) + Number(r.spend);
      if (!data || data.length < 1000) break;
    }
    const days = Object.keys(spend).filter((k) => spend[k] >= 1).sort();
    if (!days.length) continue;
    const gap = (a: string, b: string) => Math.round((new Date(b + "T12:00:00Z").getTime() - new Date(a + "T12:00:00Z").getTime()) / 864e5);
    const events: { kind: string; day: string; note: string }[] = [];
    let start = days[0], last = days[0];
    const close = (s0: string, e0: string, isLast: boolean) => {
      events.push({ kind: events.length ? "relaunched" : "launched", day: s0, note: "From Meta: ads started spending" });
      const active = accts.some((a: string) => delivering[a]);
      const stale = gap(e0, today) > GAP_DAYS;
      if (!isLast || stale || (!active && accts.every((a: string) => delivering[a] !== undefined))) {
        const pd = addDays(e0, 1) > today ? today : addDays(e0, 1);
        events.push({ kind: "paused", day: pd, note: stale ? "From Meta: no ad spend since " + e0 : "From Meta: no active campaigns" });
      }
    };
    for (let i = 1; i < days.length; i++) {
      if (gap(last, days[i]) > GAP_DAYS) { close(start, last, false); start = days[i]; }
      last = days[i];
    }
    close(start, last, true);
    const rows = events.map((e) => ({ client_id: c.id, kind: e.kind, event_date: e.day, note: e.note, source: "meta", ad_account_id: accts[0] }));
    const { data: old } = await db.from("ad_events").select("id,kind,event_date,seen_at").eq("client_id", c.id).eq("source", "meta");
    const want = new Set(rows.map((r) => r.kind + "|" + r.event_date));
    const staleRows = (old || []).filter((o: any) => !want.has(o.kind + "|" + o.event_date));
    const have = new Set((old || []).map((o: any) => o.kind + "|" + o.event_date));
    const add: any[] = rows.filter((r) => !have.has(r.kind + "|" + r.event_date));
    // A date that only moved a few days (Meta revised a day's spend) keeps its "Done" from Overview.
    for (const r of add) {
      const was = staleRows.find((o: any) => o.seen_at && o.kind === r.kind && Math.abs(gap(o.event_date, r.event_date)) <= 3);
      if (was) r.seen_at = was.seen_at;
    }
    if (staleRows.length) await db.from("ad_events").delete().in("id", staleRows.map((o: any) => o.id));
    for (const r of add) {
      const { error } = await db.from("ad_events").insert(r);
      if (error && error.code !== "23505") throw error;   // 23505: another run just added the same date
      if (!error) made++;
    }
  }
  return made;
}

// Pull a lead's contact basics out of its form answers.
function contactOf(fields: any[]) {
  const get = (re: RegExp) => { const f = (fields || []).find((x) => re.test(String(x.name || ""))); return f && f.values ? String(f.values[0] || "") : ""; };
  const full = get(/^full[_ ]?name$/i) || [get(/^first[_ ]?name$/i), get(/^last[_ ]?name$/i)].filter(Boolean).join(" ");
  return { name: full, email: get(/e-?mail/i), phone: get(/phone/i) };
}

// Leads from instant forms on every Page we can read, matched to clients by ad account
// (or by Page for leads with no ad, e.g. organic or test leads).
// quick (the 2-minute job): only ACTIVE forms, and only leads newer than the last one stored
// (with a 10-minute overlap). The hourly run re-checks every form with a 1-day overlap.
async function syncLeads(token: string, acctClient: Record<string, string>, quick = false) {
  let added = 0;
  const problems: string[] = [];
  let pages: any[] = [];
  try { pages = await graphAll("/me/accounts", { fields: "id,name,access_token", limit: "100" }, token); }
  catch (e) { return { added, problems: ["pages: " + (e as Error).message] }; }
  // Newest stored lead per form, and each Page's client, in two queries.
  const latest: Record<string, string> = {};
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from("meta_form_latest").select("form_id,latest").range(from, from + 999);
    if (error) throw error;
    for (const r of data || []) latest[r.form_id] = r.latest;
    if (!data || data.length < 1000) break;
  }
  const pageClients: Record<string, string | null> = {}, pausedUntil: Record<string, string> = {};
  { const { data } = await db.from("meta_pages").select("page_id,client_id,paused_until"); for (const r of data || []) { pageClients[r.page_id] = r.client_id; if (r.paused_until) pausedUntil[r.page_id] = r.paused_until; } }
  const nowIso = new Date().toISOString();
  // Ad -> ad account, from what's already stored; Meta is asked only for new ads, 50 at a time.
  const adAcct: Record<string, string> = {};
  async function accountsFor(adIds: string[]) {
    const want = [...new Set(adIds.filter((a) => a && adAcct[a] === undefined))];
    for (let i = 0; i < want.length; i += 25) {
      const { data } = await db.from("meta_leads").select("ad_id,ad_account_id").in("ad_id", want.slice(i, i + 25)).neq("ad_account_id", "").limit(1000);
      for (const r of data || []) adAcct[r.ad_id] = r.ad_account_id;
    }
    const ask = want.filter((a) => adAcct[a] === undefined);
    for (let i = 0; i < ask.length; i += 50) {
      try {
        const r = await graph("/", { ids: ask.slice(i, i + 50).join(","), fields: "account_id" }, token);
        for (const id of ask.slice(i, i + 50)) adAcct[id] = String((r[id] && r[id].account_id) || "");
      } catch (_) {
        // One deleted or unreadable ad fails the whole batch: look the rest up one at a time.
        for (const id of ask.slice(i, i + 50)) {
          try { const a = await graph("/" + id, { fields: "account_id" }, token); adAcct[id] = String(a.account_id || ""); }
          catch (_) { adAcct[id] = ""; }
        }
      }
    }
  }
  for (const pg of pages) {
    const ptoken = pg.access_token || token;
    // Meta throttled this Page's lead calls recently: leave it alone until the pause ends.
    if (pausedUntil[pg.id] && pausedUntil[pg.id] > nowIso) continue;
    try {
      let pageClient: string | null = pageClients[pg.id] || null;
      let forms = await graphAll("/" + pg.id + "/leadgen_forms", { fields: "id,name,status", limit: "100" }, ptoken);
      const formCount = forms.length;
      // The 2-minute check only looks at active forms that have had leads before; brand-new or
      // never-used forms are picked up by the hourly run (keeps us under Meta's per-Page limit).
      if (quick) forms = forms.filter((f) => (!f.status || f.status === "ACTIVE") && latest[f.id]);
      for (const f of forms) {
        const params: Record<string, string> = { fields: "id,created_time,ad_id,ad_name,adset_name,campaign_name,form_id,field_data,is_organic,platform", limit: "500" };
        if (latest[f.id]) {
          const since = Math.floor(new Date(latest[f.id]).getTime() / 1000) - (quick ? 600 : 86400);
          params.filtering = JSON.stringify([{ field: "time_created", operator: "GREATER_THAN", value: since }]);
        }
        const leads = await graphAll("/" + f.id + "/leads", params, ptoken);
        if (!leads.length) continue;
        await accountsFor(leads.map((l: any) => String(l.ad_id || "")));
        const rows = [];
        for (const l of leads) {
          const acct = l.ad_id ? adAcct[l.ad_id] || "" : "";
          const client = (acct && acctClient[acct]) || pageClient || null;
          if (!pageClient && acct && acctClient[acct]) pageClient = acctClient[acct];
          const c = contactOf(l.field_data);
          rows.push({
            id: String(l.id), created_time: l.created_time, client_id: client, ad_account_id: acct, page_id: String(pg.id),
            form_id: String(f.id), form_name: f.name || "", ad_id: String(l.ad_id || ""), ad_name: l.ad_name || "",
            adset_name: l.adset_name || "", campaign_name: l.campaign_name || "", is_organic: !!l.is_organic,
            platform: l.platform || "", name: c.name, email: c.email, phone: c.phone, fields: l.field_data || [],
            synced_at: new Date().toISOString(),
          });
        }
        // Keep any client someone set by hand in Tracker: only fill client_id on new leads.
        const { data: ins, error } = await db.from("meta_leads").upsert(rows, { onConflict: "id", ignoreDuplicates: true }).select("id");
        if (error) throw error;
        added += (ins || []).length;
      }
      if (!quick || pageClient !== (pageClients[pg.id] || null)) {
        await db.from("meta_pages").upsert({ page_id: String(pg.id), name: pg.name || "", client_id: pageClient, forms: formCount, last_synced_at: new Date().toISOString(), last_error: "" }, { onConflict: "page_id" });
      }
    } catch (e) {
      const msg = String((e as Error).message || e).slice(0, 400);
      if (/\(code (80005|4|17|32|613)\)/.test(msg)) {
        // Rate limit: not a failure. Pause this Page for 30 minutes; the other Pages carry on.
        await db.from("meta_pages").upsert({ page_id: String(pg.id), name: pg.name || "", paused_until: new Date(Date.now() + 30 * 60000).toISOString(), last_error: "Meta rate limit: paused 30 minutes" }, { onConflict: "page_id" });
        continue;
      }
      problems.push((pg.name || pg.id) + ": " + msg);
      await db.from("meta_pages").upsert({ page_id: String(pg.id), name: pg.name || "", last_error: msg }, { onConflict: "page_id" });
    }
  }
  return { added, problems };
}

async function runSync(trigger: string, sinceOverride?: string) {
  const token = Deno.env.get("META_ACCESS_TOKEN") || "";
  if (!token) return { ok: false, configured: false, message: "Meta isn't connected yet (META_ACCESS_TOKEN not set)." };
  // A run the platform stopped at its time limit never finished: close it out.
  await db.from("meta_sync_runs").update({ finished_at: new Date().toISOString(), ok: false, message: "Timed out" })
    .is("finished_at", null).lt("started_at", new Date(Date.now() - 15 * 60000).toISOString());
  const { data: run, error: runErr } = await db.from("meta_sync_runs").insert({ trigger }).select("id").single();
  if (runErr) return { ok: false, configured: true, message: "Couldn't start the sync: " + runErr.message };
  let rows = 0, accounts = 0;
  const problems: string[] = [];
  try {
    // 1. Ad accounts the system user can see, plus any linked on a client in Tracker.
    const seen = await graphAll("/me/adaccounts", { fields: "account_id,name,currency,account_status,business_name", limit: "200" }, token);
    const ids = new Set<string>(seen.map((a) => String(a.account_id)));
    if (seen.length) {
      await db.from("meta_ad_accounts").upsert(seen.map((a) => ({
        ad_account_id: String(a.account_id), name: a.name || "", currency: a.currency || "USD",
        account_status: a.account_status ?? null, owner_name: a.business_name || "",
      })), { onConflict: "ad_account_id" });
    }
    const { data: linked } = await db.from("clients").select("id,ad_spend_mode,meta_ad_account_ids");
    const payer: Record<string, string> = {};   // ad account -> client id, when SGS pays Meta
    const acctClient: Record<string, string> = {};   // ad account -> client id
    for (const c of linked || []) for (const id of c.meta_ad_account_ids || []) {
      if (!/^\d+$/.test(id)) continue;
      ids.add(id); acctClient[id] = c.id;
      if (/^sgs_/.test(c.ad_spend_mode || "")) payer[id] = c.id;
    }
    let charges = 0;

    // 2. Daily spend + leads per account.
    const until = ymd(new Date());
    for (const id of ids) {
      accounts++;
      try {
        let since = sinceOverride || FIRST_DAY;
        if (!sinceOverride) {
          const { data: last } = await db.from("meta_daily").select("day").eq("ad_account_id", id).order("day", { ascending: false }).limit(1);
          if (last && last.length) since = addDays(last[0].day, -REFRESH_DAYS);
        }
        // Pull in 90-day windows to keep each response small.
        for (let start = since; start <= until; start = addDays(start, 90)) {
          const end = addDays(start, 89) < until ? addDays(start, 89) : until;
          const days = await graphAll("/act_" + id + "/insights", {
            level: "account", time_increment: "1", fields: "spend,impressions,clicks,actions",
            time_range: JSON.stringify({ since: start, until: end }), limit: "500",
          }, token);
          if (days.length) {
            const up = days.map((d) => ({
              ad_account_id: id, day: d.date_start, spend: Number(d.spend) || 0, leads: leadCount(d.actions),
              impressions: Number(d.impressions) || 0, clicks: Number(d.clicks) || 0, synced_at: new Date().toISOString(),
            }));
            const { error } = await db.from("meta_daily").upsert(up, { onConflict: "ad_account_id,day" });
            if (error) throw error;
            rows += up.length;
          }
        }
        // Balance waiting to be charged, and the card on file.
        let card = "";
        try {
          const a = await graph("/act_" + id, { fields: "balance,amount_spent,funding_source_details" }, token);
          card = String((a.funding_source_details && a.funding_source_details.display_string) || "");
          await db.from("meta_ad_accounts").upsert({
            ad_account_id: id, balance: a.balance != null ? Number(a.balance) / 100 : null,
            amount_spent: a.amount_spent != null ? Number(a.amount_spent) / 100 : null,
            funding_source: card, balance_at: new Date().toISOString(),
          }, { onConflict: "ad_account_id" });
        } catch (e) { problems.push(id + " (balance): " + String((e as Error).message || e)); }
        if (payer[id]) charges += await syncCharges(id, payer[id], token, card);
        if (OWN_ACCOUNTS.includes(id)) {
          try { rows += await syncAdDaily(id, token, sinceOverride); }
          catch (e) { problems.push(id + " (ads): " + String((e as Error).message || e)); }
        }
        await db.from("meta_ad_accounts").upsert({ ad_account_id: id, last_synced_at: new Date().toISOString(), last_error: "" }, { onConflict: "ad_account_id" });
      } catch (e) {
        const msg = String((e as Error).message || e);
        problems.push(id + ": " + msg);
        await db.from("meta_ad_accounts").upsert({ ad_account_id: id, last_error: msg.slice(0, 500) }, { onConflict: "ad_account_id" });
      }
    }
    // 3. Is anything running right now? (an ACTIVE campaign in the account)
    const delivering: Record<string, boolean> = {};
    for (const id of ids) {
      if (!acctClient[id]) continue;
      try {
        const r = await graph("/act_" + id + "/campaigns", { effective_status: JSON.stringify(["ACTIVE"]), fields: "id", limit: "1" }, token);
        delivering[id] = !!(r.data && r.data.length);
        await db.from("meta_ad_accounts").upsert({ ad_account_id: id, delivering: delivering[id], delivering_at: new Date().toISOString() }, { onConflict: "ad_account_id" });
      } catch (_) { /* unknown: spend history decides */ }
    }
    let adEvents = 0;
    try { adEvents = await syncAdEvents(linked || [], delivering); }
    catch (e) { problems.push("ads on/off: " + String((e as Error).message || e)); }

    // 4. Individual leads from instant forms.
    const lr = await syncLeads(token, acctClient);
    const message = (adEvents ? adEvents + " ads on/off change(s). " : "") + (lr.added ? lr.added + " new lead(s). " : "") + (lr.problems.length ? "Leads: " + lr.problems.join(" | ").slice(0, 400) + ". " : "") + (charges ? charges + " new card charge(s). " : "") + (problems.length ? problems.length + " account(s) failed: " + problems.join(" | ").slice(0, 850) : "");
    const ok = !problems.length && !lr.problems.length;
    await db.from("meta_sync_runs").update({ finished_at: new Date().toISOString(), ok, accounts, rows, message }).eq("id", run?.id);
    return { ok, configured: true, accounts, rows, message };
  } catch (e) {
    const message = redact(String((e as Error).message || e)).slice(0, 900);
    await db.from("meta_sync_runs").update({ finished_at: new Date().toISOString(), ok: false, accounts, rows, message }).eq("id", run?.id);
    return { ok: false, configured: true, accounts, rows, message };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return json(req, 405, { error: "Method not allowed" });

  // The schedule sends a secret kept in Supabase Vault (read with the service key).
  let fromCron = false;
  const sent = req.headers.get("x-cron-secret") || "";
  if (sent) {
    const { data: secret } = await db.rpc("meta_sync_secret");
    fromCron = !!secret && sent === secret;
  }
  if (!fromCron) {
    const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!(await isTeam(token))) return json(req, 403, { error: "Not allowed" });
  }
  let body: any = {};
  try { body = await req.json(); } catch (_) { /* empty */ }

  // Read-only check: billing charges Meta reports for one account since a date (nothing is saved).
  if (body.action === "charges_preview" && /^\d+$/.test(String(body.account || ""))) {
    const t = Deno.env.get("META_ACCESS_TOKEN") || "";
    const ev = await graphAll("/act_" + body.account + "/activities", {
      fields: "event_time,event_type,extra_data", since: String(body.since || FIRST_DAY), until: ymd(new Date()), limit: "500",
    }, t);
    const billing = ev.filter((e) => e.event_type === "ad_account_billing_charge");
    return json(req, 200, { events: ev.length, types: [...new Set(ev.map((e) => e.event_type))], billing: billing.slice(0, 40) });
  }
  // Live balances (spend Meta hasn't charged to the card yet) for every account linked to a client.
  if (body.action === "balances") {
    const t = Deno.env.get("META_ACCESS_TOKEN") || "";
    if (!t) return json(req, 200, { configured: false });
    const { data: cl } = await db.from("clients").select("meta_ad_account_ids");
    const ids = [...new Set((cl || []).flatMap((c: any) => c.meta_ad_account_ids || []).filter((x: string) => /^\d+$/.test(x)))];
    const at = new Date().toISOString();
    const balances: Record<string, unknown> = {};
    await Promise.all(ids.map(async (id) => {
      try {
        const a = await graph("/act_" + id, { fields: "balance,funding_source_details" }, t);
        const b = { balance: a.balance != null ? Number(a.balance) / 100 : null, funding_source: String((a.funding_source_details && a.funding_source_details.display_string) || "") };
        balances[id] = b;
        await db.from("meta_ad_accounts").upsert({ ad_account_id: id, ...b, balance_at: at }, { onConflict: "ad_account_id" });
      } catch (_) { /* keep the last known balance */ }
    }));
    return json(req, 200, { ok: true, at, balances });
  }
  // Leads only (every 2 minutes from pg_cron): new instant-form leads, nothing else.
  if (body.action === "leads") {
    const t = Deno.env.get("META_ACCESS_TOKEN") || "";
    if (!t) return json(req, 200, { configured: false });
    const { data: cl } = await db.from("clients").select("id,meta_ad_account_ids");
    const acctClient: Record<string, string> = {};
    for (const c of cl || []) for (const id of c.meta_ad_account_ids || []) if (/^\d+$/.test(id)) acctClient[id] = c.id;
    const lr = await syncLeads(t, acctClient, true);
    return json(req, 200, { ok: !lr.problems.length, added: lr.added, problems: lr.problems });
  }
  if (body.action === "status") {
    return json(req, 200, { configured: !!Deno.env.get("META_ACCESS_TOKEN") });
  }
  const since = /^\d{4}-\d{2}-\d{2}$/.test(String(body.since || "")) ? String(body.since) : undefined;
  return json(req, 200, await runSync(fromCron ? "schedule" : "manual", since));
});
