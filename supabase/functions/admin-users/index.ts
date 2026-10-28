// Solid Gold Systems Tracker - admin user management.
// Deployed as a Supabase Edge Function (no Netlify credits).
// Every call must come from a signed-in Tracker admin whose sign-in passed email 2FA.
import { createClient } from "npm:@supabase/supabase-js@2";

const TRACKER_URL = "https://tracker.solidgoldsystems.com/";
const ALLOWED_ORIGINS = ["https://tracker.solidgoldsystems.com", "https://solidgoldtracker.netlify.app"];

const url = Deno.env.get("SUPABASE_URL")!;
function serviceKey(): string {
  try {
    const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
    if (keys.default) return keys.default;
  } catch (_) { /* fall back to legacy key */ }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
}
const admin = createClient(url, serviceKey(), { auth: { persistSession: false, autoRefreshToken: false } });

function cors(req: Request) {
  const origin = req.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
function json(req: Request, status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors(req), "Content-Type": "application/json" } });
}
function decodeJwt(token: string): Record<string, unknown> {
  try {
    const p = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(p + "=".repeat((4 - (p.length % 4)) % 4)));
  } catch (_) { return {}; }
}
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function allUsers() {
  const out: any[] = [];
  for (let page = 1; page < 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    out.push(...data.users);
    if (data.users.length < 1000) break;
  }
  return out;
}
async function findUser(email: string) {
  return (await allUsers()).find((u) => (u.email || "").toLowerCase() === email.toLowerCase()) || null;
}
async function adminCount() {
  const { count } = await admin.from("team_members").select("email", { count: "exact", head: true }).eq("role", "admin");
  return count || 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return json(req, 405, { error: "Method not allowed" });

  // ---- who is calling? ----
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: me, error: meErr } = await admin.auth.getUser(token);
  if (meErr || !me?.user?.email) return json(req, 401, { error: "Not signed in" });
  const sessionId = String(decodeJwt(token).session_id || "");
  const { data: vs } = await admin.from("verified_sessions").select("session_id")
    .eq("session_id", /^[0-9a-f-]{36}$/.test(sessionId) ? sessionId : "00000000-0000-0000-0000-000000000000")
    .eq("user_id", me.user.id).gt("expires_at", new Date().toISOString()).maybeSingle();
  if (!vs) return json(req, 403, { error: "2FA required" });
  const myEmail = me.user.email.toLowerCase();
  const { data: myRow } = await admin.from("team_members").select("role").ilike("email", myEmail).maybeSingle();
  if (myRow?.role !== "admin") return json(req, 403, { error: "Admins only" });

  let body: any = {};
  try { body = await req.json(); } catch (_) { /* empty */ }
  const action = String(body.action || "");
  const email = String(body.email || "").trim().toLowerCase();
  const role = body.role === "admin" ? "admin" : "member";

  try {
    if (action === "list") {
      const [{ data: rows, error }, users, { data: sessions }] = await Promise.all([
        admin.from("team_members").select("*").order("created_at"),
        allUsers(),
        admin.from("verified_sessions").select("user_id, verified_at").gt("expires_at", new Date().toISOString()),
      ]);
      if (error) throw error;
      const lastVerified = new Map<string, string>();
      (sessions || []).forEach((v: any) => {
        const prev = lastVerified.get(v.user_id);
        if (!prev || v.verified_at > prev) lastVerified.set(v.user_id, v.verified_at);
      });
      const byEmail = new Map(users.map((u) => [(u.email || "").toLowerCase(), u]));
      const members = (rows || []).map((r: any) => {
        const u: any = byEmail.get(r.email.toLowerCase());
        return {
          email: r.email, role: r.role, invited_by: r.invited_by, invited_at: r.invited_at, added_at: r.created_at,
          has_account: !!u,
          status: !u ? "no account" : !u.last_sign_in_at ? "invited" : "active",
          last_sign_in_at: u?.last_sign_in_at || null,
          last_verified_at: u ? (lastVerified.get(u.id) || null) : null,
          is_me: r.email.toLowerCase() === myEmail,
        };
      });
      return json(req, 200, { ok: true, members });
    }

    if (!EMAIL.test(email)) return json(req, 400, { error: "Enter a valid email" });

    if (action === "invite") {
      const { error: upErr } = await admin.from("team_members").upsert(
        { email, role, invited_by: myEmail, invited_at: new Date().toISOString() }, { onConflict: "email" });
      if (upErr) throw upErr;
      const existing = await findUser(email);
      if (!existing) {
        const { error } = await admin.auth.admin.inviteUserByEmail(email, { redirectTo: TRACKER_URL });
        if (!error) return json(req, 200, { ok: true, emailed: true });
        // Email couldn't be sent (e.g. no custom SMTP yet): create the invite as a link instead.
        const gl = await admin.auth.admin.generateLink({ type: "invite", email, options: { redirectTo: TRACKER_URL } });
        if (gl.error) throw gl.error;
        return json(req, 200, { ok: true, emailed: false, link: gl.data.properties.action_link, note: error.message });
      }
      const gl = await admin.auth.admin.generateLink({ type: "magiclink", email, options: { redirectTo: TRACKER_URL } });
      if (gl.error) throw gl.error;
      return json(req, 200, { ok: true, emailed: false, link: gl.data.properties.action_link, note: "They already have an account; share this sign-in link." });
    }

    if (action === "link") {
      const u = await findUser(email);
      const gl = await admin.auth.admin.generateLink({ type: u ? "magiclink" : "invite", email, options: { redirectTo: TRACKER_URL } });
      if (gl.error) throw gl.error;
      return json(req, 200, { ok: true, link: gl.data.properties.action_link });
    }

    if (action === "set_role") {
      if (email === myEmail && role !== "admin") return json(req, 400, { error: "You can't remove your own admin role" });
      const { error } = await admin.from("team_members").update({ role }).eq("email", email);
      if (error) throw error;
      return json(req, 200, { ok: true });
    }

    if (action === "remove") {
      if (email === myEmail) return json(req, 400, { error: "You can't remove yourself" });
      const { data: row } = await admin.from("team_members").select("role").eq("email", email).maybeSingle();
      if (row?.role === "admin" && (await adminCount()) <= 1) return json(req, 400, { error: "Keep at least one admin" });
      const { error } = await admin.from("team_members").delete().eq("email", email);
      if (error) throw error;
      const u = await findUser(email);
      if (u) {
        await admin.from("verified_sessions").delete().eq("user_id", u.id);
        const d = await admin.auth.admin.deleteUser(u.id); if (d.error) throw d.error;
      }
      return json(req, 200, { ok: true });
    }

    if (action === "sign_out") {
      // Ends their verified sign-ins: next visit they need a new email code.
      const u = await findUser(email);
      if (!u) return json(req, 404, { error: "No account for that email" });
      const { error } = await admin.from("verified_sessions").delete().eq("user_id", u.id);
      if (error) throw error;
      return json(req, 200, { ok: true });
    }

    return json(req, 400, { error: "Unknown action" });
  } catch (e) {
    console.error("[admin-users]", action, email, e);
    return json(req, 500, { error: (e as Error).message || "Something went wrong" });
  }
});
