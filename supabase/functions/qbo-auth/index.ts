// Solid Gold Systems Tracker - QuickBooks Online (read only).
//   POST {action:"start"}   signed-in team member -> Intuit sign-in URL to connect QuickBooks
//   GET  ?code&state&realmId Intuit sends the person back here -> tokens saved -> back to Tracker
//   POST {action:"sync"}    cron (x-cron-secret) or team -> Profit & Loss by month -> public.qbo_pnl
//   POST {action:"status"}  team -> connected company + last sync
//   POST {action:"disconnect"} team -> forget the tokens
// Secrets: QBO_CLIENT_ID, QBO_CLIENT_SECRET (Intuit app "SGS Tracker", Accounting scope).
// Redirect URI registered on the Intuit app: <project>/functions/v1/qbo-auth
import { createClient } from "npm:@supabase/supabase-js@2";

const ALLOWED_ORIGINS = ["https://tracker.solidgoldsystems.com", "https://solidgoldtracker.netlify.app"];
const TRACKER = "https://tracker.solidgoldsystems.com";
const AUTH_URL = "https://appcenter.intuit.com/connect/oauth2";
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const API = "https://quickbooks.api.intuit.com/v3/company/";
const url = Deno.env.get("SUPABASE_URL")!;
const REDIRECT = url + "/functions/v1/qbo-auth";
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
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Vary": "Origin",
  };
}
function json(req: Request, status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors(req), "Content-Type": "application/json" } });
}
async function teamEmail(token: string): Promise<string | null> {
  if (!token) return null;
  const user = createClient(url, Deno.env.get("SUPABASE_ANON_KEY") || "", { auth: { persistSession: false }, global: { headers: { Authorization: "Bearer " + token } } });
  const { data: ok } = await user.rpc("is_team");
  if (ok !== true) return null;
  const { data } = await user.auth.getUser(token);
  return (data && data.user && data.user.email) || "team";
}
const basic = () => "Basic " + btoa((Deno.env.get("QBO_CLIENT_ID") || "") + ":" + (Deno.env.get("QBO_CLIENT_SECRET") || ""));

async function tokenCall(params: Record<string, string>) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { Authorization: basic(), Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error("QuickBooks sign-in failed: " + (body.error_description || body.error || res.status) + " (intuit_tid " + (res.headers.get("intuit_tid") || "n/a") + ")");
  return body;
}
function expiry(sec: number) { return new Date(Date.now() + (Number(sec) || 3600) * 1000 - 60000).toISOString(); }

// A working access token (refreshing it, and saving the new refresh token, when needed).
async function accessToken() {
  const { data: c } = await db.from("qbo_connection").select("*").eq("id", 1).maybeSingle();
  if (!c) throw new Error("QuickBooks isn't connected.");
  if (new Date(c.access_expires_at).getTime() > Date.now()) return c;
  const t = await tokenCall({ grant_type: "refresh_token", refresh_token: c.refresh_token });
  const upd = { access_token: t.access_token, refresh_token: t.refresh_token || c.refresh_token, access_expires_at: expiry(t.expires_in),
    refresh_expires_at: t.x_refresh_token_expires_in ? expiry(t.x_refresh_token_expires_in) : c.refresh_expires_at, updated_at: new Date().toISOString() };
  await db.from("qbo_connection").update(upd).eq("id", 1);
  return { ...c, ...upd };
}
async function qbo(c: any, path: string) {
  const res = await fetch(API + c.realm_id + path, { headers: { Authorization: "Bearer " + c.access_token, Accept: "application/json" } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const f = body.Fault && body.Fault.Error && body.Fault.Error[0];
    // intuit_tid identifies the request for Intuit support.
    throw new Error("QuickBooks: " + ((f && (f.Detail || f.Message)) || res.status) + " (intuit_tid " + (res.headers.get("intuit_tid") || "n/a") + ")");
  }
  return body;
}

// Profit & Loss report -> months + flat rows (section headers, accounts, totals) with a value per month.
function flatten(report: any) {
  const cols = (report.Columns && report.Columns.Column) || [];
  const months: string[] = [];
  const idx: number[] = [];
  cols.forEach((c: any, i: number) => {
    const sd = (c.MetaData || []).find((m: any) => m.Name === "StartDate");
    if (c.ColType === "Money" && sd && c.ColTitle !== "Total") { months.push(String(sd.Value).slice(0, 7)); idx.push(i); }
  });
  const rows: any[] = [];
  const num = (v: unknown) => { const n = parseFloat(String(v || "").replace(/,/g, "")); return isFinite(n) ? Math.round(n * 100) / 100 : 0; };
  const vals = (cd: any[]) => idx.map((i) => num(cd[i] && cd[i].value));
  const walk = (list: any[], depth: number, group: string) => {
    for (const r of list || []) {
      const g = r.group || group;
      if (r.type === "Section") {
        const h = r.Header && r.Header.ColData;
        if (h) rows.push({ kind: "header", name: h[0].value, depth, group: g, values: h.length > 1 && h.some((x: any, i: number) => i && x.value) ? vals(h) : null });
        if (r.Rows && r.Rows.Row) walk(r.Rows.Row, depth + (h ? 1 : 0), g);
        const s = r.Summary && r.Summary.ColData;
        if (s) rows.push({ kind: "total", name: s[0].value, depth, group: g, values: vals(s) });
      } else if (r.ColData) {
        rows.push({ kind: "line", name: r.ColData[0].value, depth, group: g, values: vals(r.ColData) });
      }
    }
  };
  walk((report.Rows && report.Rows.Row) || [], 0, "");
  return { months, rows };
}

async function sync() {
  try {
    const c = await accessToken();
    const year = new Date().getFullYear();
    const today = new Date().toISOString().slice(0, 10);
    const rep = await qbo(c, "/reports/ProfitAndLoss?start_date=" + (year - 1) + "-01-01&end_date=" + today + "&summarize_column_by=Month&minorversion=75");
    const { months, rows } = flatten(rep);
    let company = c.company_name;
    if (!company) {
      try { const info = await qbo(c, "/companyinfo/" + c.realm_id + "?minorversion=75"); company = (info.CompanyInfo && info.CompanyInfo.CompanyName) || ""; await db.from("qbo_connection").update({ company_name: company }).eq("id", 1); } catch (_) { /* optional */ }
    }
    await db.from("qbo_pnl").upsert({ id: 1, company_name: company, months, rows, fetched_at: new Date().toISOString(), ok: true, message: "" });
    return { ok: true, months: months.length, rows: rows.length };
  } catch (e) {
    const message = String((e as Error).message || e).slice(0, 500);
    console.error("qbo sync failed:", message);
    await db.from("qbo_pnl").upsert({ id: 1, ok: false, message, fetched_at: new Date().toISOString() });
    return { ok: false, message };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  const u = new URL(req.url);

  // Intuit sends the person back here after they approve.
  if (req.method === "GET") {
    const back = (q: string) => Response.redirect(TRACKER + "/#settings?qbo=" + q, 302);
    const state = u.searchParams.get("state") || "", code = u.searchParams.get("code") || "", realm = u.searchParams.get("realmId") || "";
    if (u.searchParams.get("error")) return back("cancelled");
    const { data: st } = await db.from("qbo_oauth_state").select("*").eq("state", state).maybeSingle();
    await db.from("qbo_oauth_state").delete().eq("state", state);
    if (!st || Date.now() - new Date(st.created_at).getTime() > 15 * 60000 || !code || !realm) return back("expired");
    try {
      const t = await tokenCall({ grant_type: "authorization_code", code, redirect_uri: REDIRECT });
      await db.from("qbo_connection").upsert({ id: 1, realm_id: realm, company_name: "", access_token: t.access_token, refresh_token: t.refresh_token,
        access_expires_at: expiry(t.expires_in), refresh_expires_at: t.x_refresh_token_expires_in ? expiry(t.x_refresh_token_expires_in) : null,
        connected_by: st.created_by, updated_at: new Date().toISOString() });
      await sync();
      return back("connected");
    } catch (e) { console.error("qbo connect failed:", (e as Error).message); return back("failed"); }
  }

  if (req.method !== "POST") return json(req, 405, { error: "Method not allowed" });
  let body: any = {};
  try { body = await req.json(); } catch (_) { /* empty */ }
  let fromCron = false;
  const sent = req.headers.get("x-cron-secret") || "";
  if (sent) { const { data: secret } = await db.rpc("meta_sync_secret"); fromCron = !!secret && sent === secret; }
  const who = fromCron ? "schedule" : await teamEmail((req.headers.get("authorization") || "").replace(/^Bearer\s+/i, ""));
  if (!who) return json(req, 403, { error: "Not allowed" });
  const configured = !!(Deno.env.get("QBO_CLIENT_ID") && Deno.env.get("QBO_CLIENT_SECRET"));

  if (body.action === "start") {
    if (!configured) return json(req, 200, { ok: false, configured: false, error: "Add QBO_CLIENT_ID and QBO_CLIENT_SECRET in Supabase first." });
    const state = crypto.randomUUID();
    await db.from("qbo_oauth_state").insert({ state, created_by: who });
    const p = new URLSearchParams({ client_id: Deno.env.get("QBO_CLIENT_ID")!, response_type: "code", scope: "com.intuit.quickbooks.accounting", redirect_uri: REDIRECT, state });
    return json(req, 200, { ok: true, url: AUTH_URL + "?" + p.toString() });
  }
  if (body.action === "status") {
    const { data: c } = await db.from("qbo_connection").select("company_name,connected_by,updated_at,refresh_expires_at").eq("id", 1).maybeSingle();
    const { data: p } = await db.from("qbo_pnl").select("fetched_at,ok,message").eq("id", 1).maybeSingle();
    return json(req, 200, { configured, connected: !!c, company: c && c.company_name, connected_by: c && c.connected_by, last: p });
  }
  if (body.action === "disconnect" && !fromCron) {
    await db.from("qbo_connection").delete().eq("id", 1);
    return json(req, 200, { ok: true });
  }
  if (body.action === "sync") {
    const { data: c } = await db.from("qbo_connection").select("id").eq("id", 1).maybeSingle();
    if (!c) return json(req, 200, { ok: false, connected: false });
    return json(req, 200, await sync());
  }
  return json(req, 400, { error: "Unknown action" });
});
