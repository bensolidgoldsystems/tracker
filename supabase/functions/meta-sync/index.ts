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
// Called daily by pg_cron (x-cron-secret header) and by "Sync now" in Tracker Settings
// (signed-in team member whose sign-in passed email 2FA).
// Secrets: META_ACCESS_TOKEN (system user token, ads_read), optional META_API_VERSION.
// Cron secret: Supabase Vault 'meta_sync_secret' (see supabase/sql/meta-sync.sql).
import { createClient } from "npm:@supabase/supabase-js@2";

const ALLOWED_ORIGINS = ["https://tracker.solidgoldsystems.com", "https://solidgoldtracker.netlify.app"];
const GRAPH = "https://graph.facebook.com/" + (Deno.env.get("META_API_VERSION") || "v23.0");
const FIRST_DAY = "2026-01-01";     // first sync goes back to here
const REFRESH_DAYS = 3;             // Meta adjusts recent days; re-pull them each run
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

async function graph(path: string, params: Record<string, string>, token: string) {
  const u = new URL(path.startsWith("http") ? path : GRAPH + path);
  if (!path.startsWith("http")) {
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    u.searchParams.set("access_token", token);
  }
  const res = await fetch(u.toString());
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    const e = body.error || {};
    throw new Error((e.message || ("HTTP " + res.status)) + (e.code ? " (code " + e.code + ")" : ""));
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
  let since = csvCut ? addDays(csvCut, 1) : FIRST_DAY;
  if (lastApi && lastApi.length) { const s2 = addDays(lastApi[0].entry_date, -7); if (s2 > since) since = s2; }
  const events = await graphAll("/act_" + acct + "/activities", {
    fields: "event_time,event_type,extra_data", since: since, until: ymd(new Date()), limit: "500",
  }, token);
  const rows: any[] = [];
  for (const ev of events) {
    if (ev.event_type !== "ad_account_billing_charge") continue;
    const x = parseExtra(ev.extra_data);
    const cents = Number(x.new_value ?? x.amount ?? x.charge_amount);
    if (!isFinite(cents) || !cents) continue;
    const date = nyDate(ev.event_time);
    if (csvCut && date <= csvCut) continue;            // already covered by the billing report
    const txn = String(x.transaction_id || x.txn_id || "");
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
  const newer = billing.filter((e) => !csvCut || nyDate(e.event_time) > csvCut);
  if (newer.length && !rows.length) {
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

// Pull a lead's contact basics out of its form answers.
function contactOf(fields: any[]) {
  const get = (re: RegExp) => { const f = (fields || []).find((x) => re.test(String(x.name || ""))); return f && f.values ? String(f.values[0] || "") : ""; };
  const full = get(/^full[_ ]?name$/i) || [get(/^first[_ ]?name$/i), get(/^last[_ ]?name$/i)].filter(Boolean).join(" ");
  return { name: full, email: get(/e-?mail/i), phone: get(/phone/i) };
}

// Leads from instant forms on every Page we can read, matched to clients by ad account
// (or by Page for leads with no ad, e.g. organic or test leads).
async function syncLeads(token: string, acctClient: Record<string, string>) {
  let added = 0;
  const problems: string[] = [];
  let pages: any[] = [];
  try { pages = await graphAll("/me/accounts", { fields: "id,name,access_token", limit: "100" }, token); }
  catch (e) { return { added, problems: ["pages: " + (e as Error).message] }; }
  const adAcct: Record<string, string> = {};
  for (const pg of pages) {
    const ptoken = pg.access_token || token;
    try {
      const { data: known } = await db.from("meta_pages").select("client_id").eq("page_id", pg.id).maybeSingle();
      let pageClient: string | null = (known && known.client_id) || null;
      const forms = await graphAll("/" + pg.id + "/leadgen_forms", { fields: "id,name,status", limit: "100" }, ptoken);
      for (const f of forms) {
        const { data: last } = await db.from("meta_leads").select("created_time").eq("form_id", f.id).order("created_time", { ascending: false }).limit(1);
        const params: Record<string, string> = { fields: "id,created_time,ad_id,ad_name,adset_name,campaign_name,form_id,field_data,is_organic,platform", limit: "500" };
        if (last && last.length) {
          const since = Math.floor(new Date(last[0].created_time).getTime() / 1000) - 86400;
          params.filtering = JSON.stringify([{ field: "time_created", operator: "GREATER_THAN", value: since }]);
        }
        const leads = await graphAll("/" + f.id + "/leads", params, ptoken);
        if (!leads.length) continue;
        const rows = [];
        for (const l of leads) {
          let acct = "";
          if (l.ad_id) {
            if (adAcct[l.ad_id] === undefined) {
              try { const ad = await graph("/" + l.ad_id, { fields: "account_id" }, token); adAcct[l.ad_id] = String(ad.account_id || ""); }
              catch (_) { adAcct[l.ad_id] = ""; }
            }
            acct = adAcct[l.ad_id];
          }
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
      await db.from("meta_pages").upsert({ page_id: String(pg.id), name: pg.name || "", client_id: pageClient, forms: forms.length, last_synced_at: new Date().toISOString(), last_error: "" }, { onConflict: "page_id" });
    } catch (e) {
      const msg = String((e as Error).message || e).slice(0, 400);
      problems.push((pg.name || pg.id) + ": " + msg);
      await db.from("meta_pages").upsert({ page_id: String(pg.id), name: pg.name || "", last_error: msg }, { onConflict: "page_id" });
    }
  }
  return { added, problems };
}

async function runSync(trigger: string, sinceOverride?: string) {
  const token = Deno.env.get("META_ACCESS_TOKEN") || "";
  if (!token) return { ok: false, configured: false, message: "Meta isn't connected yet (META_ACCESS_TOKEN not set)." };
  const { data: run } = await db.from("meta_sync_runs").insert({ trigger }).select("id").single();
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
    // 3. Individual leads from instant forms.
    const lr = await syncLeads(token, acctClient);
    const message = (lr.added ? lr.added + " new lead(s). " : "") + (lr.problems.length ? "Leads: " + lr.problems.join(" | ").slice(0, 400) + ". " : "") + (charges ? charges + " new card charge(s). " : "") + (problems.length ? problems.length + " account(s) failed: " + problems.join(" | ").slice(0, 850) : "");
    await db.from("meta_sync_runs").update({ finished_at: new Date().toISOString(), ok: !problems.length, accounts, rows, message }).eq("id", run?.id);
    return { ok: !problems.length, configured: true, accounts, rows, message };
  } catch (e) {
    const message = String((e as Error).message || e).slice(0, 900);
    await db.from("meta_sync_runs").update({ finished_at: new Date().toISOString(), ok: false, accounts, rows, message }).eq("id", run?.id);
    return { ok: false, configured: true, accounts, rows, message };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return json(req, 405, { error: "Method not allowed" });

  // The daily schedule sends a secret kept in Supabase Vault (read with the service key).
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
  if (body.action === "status") {
    return json(req, 200, { configured: !!Deno.env.get("META_ACCESS_TOKEN") });
  }
  const since = /^\d{4}-\d{2}-\d{2}$/.test(String(body.since || "")) ? String(body.since) : undefined;
  return json(req, 200, await runSync(fromCron ? "schedule" : "manual", since));
});
