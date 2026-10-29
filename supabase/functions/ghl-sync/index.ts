// Solid Gold Systems Tracker - GoHighLevel sync (read-only on GHL's side).
// Pulls contacts from SGS's GHL account that came from ads, SGS's funnels or a client pipeline
// -> public.ghl_contacts, with the campaign/ad they came from, their pipeline stage, and whether
// they belong to SGS or a client (matched by the ad's Meta ad account, else by pipeline name).
// Website-form leads Meta can't hand over show up in Tracker this way.
// Auth: x-cron-secret (Vault meta_sync_secret, daily schedule) or a signed-in team member.
// Secrets: GHL_API_KEY (private integration token), GHL_LOCATION_ID, META_ACCESS_TOKEN (to look
// up which ad account an ad belongs to).
import { createClient } from "npm:@supabase/supabase-js@2";

const ALLOWED_ORIGINS = ["https://tracker.solidgoldsystems.com", "https://solidgoldtracker.netlify.app"];
const API = "https://services.leadconnectorhq.com";
const GRAPH = "https://graph.facebook.com/" + (Deno.env.get("META_API_VERSION") || "v23.0");
const FIRST_DAY = "2026-01-01";
const RESYNC_DAYS = 60;   // re-read recent contacts each run so pipeline stages stay current
const OWN_ACCOUNTS = (Deno.env.get("META_OWN_ACCOUNTS") || "1399902944415343").split(",").map((x) => x.trim()).filter(Boolean);
const SGS_PIPELINES = ["sgs leads", "$500 website", "$3k contractor investment"];

const url = Deno.env.get("SUPABASE_URL")!;
function serviceKey(): string {
  try { const k = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}"); if (k.default) return k.default; } catch (_) { /* legacy */ }
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
async function isTeam(token: string): Promise<boolean> {
  if (!token) return false;
  const user = createClient(url, Deno.env.get("SUPABASE_ANON_KEY") || "", { auth: { persistSession: false }, global: { headers: { Authorization: "Bearer " + token } } });
  const { data, error } = await user.rpc("is_team");
  return !error && data === true;
}

async function ghl(path: string, init: RequestInit = {}, tries = 3): Promise<any> {
  const res = await fetch(API + path, {
    ...init,
    headers: { Authorization: "Bearer " + (Deno.env.get("GHL_API_KEY") || ""), Version: "2021-07-28", Accept: "application/json", "Content-Type": "application/json" },
  });
  if (res.status === 429 && tries > 1) { await new Promise((r) => setTimeout(r, 2500)); return ghl(path, init, tries - 1); }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body.message || body.error || "HTTP " + res.status) + " [" + path.split("?")[0] + "]");
  return body;
}

// Which Meta ad account an ad belongs to (known ads first, then one Graph call per new ad).
async function adAccounts(adIds: string[]): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  const want = [...new Set(adIds.filter(Boolean))];
  if (!want.length) return map;
  for (const [table, col] of [["meta_ad_daily", "ad_account_id"], ["meta_leads", "ad_account_id"], ["ghl_contacts", "ad_account_id"]]) {
    for (let i = 0; i < want.length; i += 200) {
      const { data } = await db.from(table).select("ad_id," + col).in("ad_id", want.slice(i, i + 200)).neq(col, "");
      for (const r of (data || []) as any[]) map[r.ad_id] = r[col];
    }
  }
  const token = Deno.env.get("META_ACCESS_TOKEN") || "";
  for (const id of want) {
    if (map[id] || !token) continue;
    try {
      const r = await fetch(GRAPH + "/" + id + "?fields=account_id&access_token=" + encodeURIComponent(token));
      const b = await r.json();
      if (b && b.account_id) map[id] = String(b.account_id);
    } catch (_) { /* unknown ad */ }
  }
  return map;
}

function attrOf(c: any) {
  const a = [c.lastAttributionSource, c.attributionSource].find((x) => x && (x.adId || x.campaign || x.utmContent)) || c.lastAttributionSource || c.attributionSource || {};
  return {
    campaign_id: String(a.campaignId || ""), campaign_name: String(a.campaign || a.utm_campaign || ""), adset_id: String(a.adSetId || ""),
    ad_id: String(a.adId || ""), ad_name: String(a.utmContent || a.utm_content || ""), form_name: String(a.formName || ""),
    session_source: String(a.sessionSource || ""), landing_url: String(a.url || "").slice(0, 300),
  };
}
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9$ ]/g, " ").replace(/\s+/g, " ").trim();

async function runSync(full: boolean) {
  const loc = Deno.env.get("GHL_LOCATION_ID") || "";
  if (!loc || !Deno.env.get("GHL_API_KEY")) return { ok: false, configured: false, message: "GHL isn't connected yet." };
  const { data: run } = await db.from("ghl_sync_runs").insert({}).select("id").single();
  try {
    // Pipelines and stages by id.
    const pl = await ghl("/opportunities/pipelines?locationId=" + loc);
    const pipes: Record<string, string> = {}, stages: Record<string, string> = {};
    for (const p of pl.pipelines || []) { pipes[p.id] = p.name; for (const s of p.stages || []) stages[s.id] = s.name; }
    // Custom field names, when the token is allowed to read them.
    const fieldNames: Record<string, string> = {};
    try { const cf = await ghl("/locations/" + loc + "/customFields"); for (const f of cf.customFields || []) fieldNames[f.id] = f.name; } catch (_) { /* optional scope */ }

    // Since when: everything on the first run, then the last RESYNC_DAYS.
    const { count } = await db.from("ghl_contacts").select("id", { count: "exact", head: true });
    const since = full || !count ? FIRST_DAY : new Date(Date.now() - RESYNC_DAYS * 864e5).toISOString().slice(0, 10);

    // Contacts, newest first, until we pass `since`.
    const contacts: any[] = [];
    let after: unknown = null;
    for (let page = 0; page < 60; page++) {
      const body: Record<string, unknown> = { locationId: loc, pageLimit: 100, sort: [{ field: "dateAdded", direction: "desc" }] };
      if (after) body.searchAfter = after;
      const r = await ghl("/contacts/search", { method: "POST", body: JSON.stringify(body) });
      const list = r.contacts || [];
      let done = !list.length;
      for (const c of list) { if (String(c.dateAdded).slice(0, 10) < since) { done = true; break; } contacts.push(c); }
      if (done || list.length < 100) break;
      after = list[list.length - 1].searchAfter;
    }

    // Form submissions: Facebook lead IDs (to match Meta's leads) and website form answers.
    const subs: Record<string, any> = {};
    for (let page = 1; page <= 30; page++) {
      const r = await ghl("/forms/submissions?locationId=" + loc + "&limit=100&page=" + page + "&startAt=" + since);
      const list = r.submissions || [];
      for (const s of list) if (s.contactId && !subs[s.contactId]) subs[s.contactId] = s;
      if (list.length < 100) break;
    }

    const attrs = contacts.map(attrOf);
    const acctOf = await adAccounts(attrs.map((a) => a.ad_id));
    const { data: clients } = await db.from("clients").select("id,business_name,meta_ad_account_ids");
    const byAcct: Record<string, string> = {};
    for (const c of clients || []) for (const a of c.meta_ad_account_ids || []) byAcct[a] = c.id;
    const byPipeline = (name: string): string | null => {
      const n = norm(name); if (!n) return null;
      for (const c of clients || []) {
        const b = norm(c.business_name), first = b.split(" ")[0];
        if (b && (b.startsWith(n) || n.startsWith(b) || (first.length > 3 && n.startsWith(first)))) return c.id;
      }
      return null;
    };
    // Meta lead form -> client, from the leads Meta already gave us.
    const byForm: Record<string, string> = {};
    for (let from = 0; from < 20000; from += 1000) {
      const { data: fl } = await db.from("meta_leads").select("form_name,form_id,client_id").not("client_id", "is", null).range(from, from + 999);
      for (const r of fl || []) { if (r.form_name) byForm[r.form_name] = r.client_id; if (r.form_id) byForm[r.form_id] = r.client_id; }
      if (!fl || fl.length < 1000) break;
    }
    const { data: known } = await db.from("ghl_contacts").select("id,client_id,is_sgs").in("id", contacts.map((c) => c.id).slice(0, 5000));
    const kept: Record<string, any> = {};
    for (const k of known || []) kept[k.id] = k;

    const rows: any[] = [];
    contacts.forEach((c, i) => {
      const a = attrs[i];
      const opp = (c.opportunities || [])[0] || null;
      const pipeline = opp ? pipes[opp.pipelineId] || "" : "";
      const acct = a.ad_id ? acctOf[a.ad_id] || "" : "";
      const sub = subs[c.id];
      const tags: string[] = c.tags || [];
      const fromAds = !!(a.ad_id || a.campaign_id || /paid social/i.test(a.session_source));
      const sgsFunnel = SGS_PIPELINES.includes(norm(pipeline)) || tags.some((t) => /^lp-/.test(t)) || /website intake/i.test(c.source || "");
      if (!fromAds && !pipeline && !sgsFunnel) return;   // imports, manual adds, cold lists
      let clientId: string | null = acct ? byAcct[acct] || null : null;
      let sgs = OWN_ACCOUNTS.includes(acct) || (!clientId && sgsFunnel);
      const formId = String(((c.lastAttributionSource || {}).formId) || ((c.attributionSource || {}).formId) || "");
      const formName = a.form_name || (sub && sub.others && sub.others.facebookFormName) || "";
      if (!clientId && !sgs) clientId = byForm[formId] || byForm[formName] || null;
      if (!clientId && !sgs && pipeline) clientId = byPipeline(pipeline);
      const k = kept[c.id];
      if (k && (k.client_id || k.is_sgs) && !clientId && !sgs) { clientId = k.client_id; sgs = k.is_sgs; }   // keep hand-made assignments
      const custom = (c.customFields || []).filter((f: any) => f.value != null && f.value !== "")
        .map((f: any) => ({ name: fieldNames[f.id] || "", values: [Array.isArray(f.value) ? f.value.join(", ") : String(f.value)] }));
      const name = [c.firstName, c.lastName].filter(Boolean).join(" ") || c.contactName || "";
      rows.push({
        id: c.id, date_added: c.dateAdded, name, email: c.email || "", phone: c.phone || "", company: c.companyName || "",
        source: c.source || (sub && sub.others && sub.others.source) || "", tags, client_id: clientId, is_sgs: sgs, ad_account_id: acct,
        ...a, form_name: a.form_name || (sub && sub.others && sub.others.facebookFormName) || "",
        facebook_lead_id: String((sub && sub.others && sub.others.facebookLeadId) || ""),
        pipeline_name: pipeline, stage_name: opp ? stages[opp.pipelineStageId] || "" : "", opp_status: opp ? opp.status || "" : "",
        custom, synced_at: new Date().toISOString(),
      });
    });
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await db.from("ghl_contacts").upsert(rows.slice(i, i + 500), { onConflict: "id" });
      if (error) throw error;
    }
    const message = rows.length + " GHL leads updated (" + contacts.length + " contacts read since " + since + ")" + (Object.keys(fieldNames).length ? "" : ". Custom field names need the View Custom Fields permission");
    await db.from("ghl_sync_runs").update({ finished_at: new Date().toISOString(), ok: true, contacts: rows.length, message }).eq("id", run?.id);
    return { ok: true, configured: true, contacts: rows.length, message };
  } catch (e) {
    const message = String((e as Error).message || e).slice(0, 900);
    await db.from("ghl_sync_runs").update({ finished_at: new Date().toISOString(), ok: false, message }).eq("id", run?.id);
    return { ok: false, configured: true, message };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return json(req, 405, { error: "Method not allowed" });
  let fromCron = false;
  const sent = req.headers.get("x-cron-secret") || "";
  if (sent) { const { data: secret } = await db.rpc("meta_sync_secret"); fromCron = !!secret && sent === secret; }
  if (!fromCron && !(await isTeam((req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "")))) return json(req, 403, { error: "Not allowed" });
  let body: any = {};
  try { body = await req.json(); } catch (_) { /* empty */ }
  return json(req, 200, await runSync(!!body.full));
});
