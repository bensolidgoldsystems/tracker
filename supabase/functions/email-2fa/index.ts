// Solid Gold Systems Tracker - email two-factor codes.
// After a password sign-in, the Tracker asks this function to email a 6-digit code,
// then sends the code back to verify. A verified sign-in session is recorded in
// public.verified_sessions, which the database checks before showing any Tracker data.
// Secrets: RESEND_API_KEY (required), RESEND_FROM (optional).
import { createClient } from "npm:@supabase/supabase-js@2";

const ALLOWED_ORIGINS = ["https://tracker.solidgoldsystems.com", "https://solidgoldtracker.netlify.app"];
const FROM = Deno.env.get("RESEND_FROM") || "SGS Tracker <tracker@solidgoldsystems.com>";
const CODE_MINUTES = 10;          // code lifetime
const MAX_ATTEMPTS = 5;           // wrong guesses per code
const MAX_SENDS = 5;              // codes per user per 15 minutes
const TRUST_DAYS = 30;            // how long a verified sign-in lasts (ends sooner if they sign out)

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
function claims(token: string): Record<string, any> {
  try {
    const p = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(p + "=".repeat((4 - (p.length % 4)) % 4)));
  } catch (_) { return {}; }
}
async function sha256(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function sixDigits() {
  const n = new Uint32Array(1);
  crypto.getRandomValues(n);
  return String(n[0] % 1000000).padStart(6, "0");
}
function same(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function emailHtml(code: string) {
  return `<!doctype html><html><body style="margin:0;background:#080808;font-family:Arial,Helvetica,sans-serif;color:#ffffff">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#080808;padding:32px 16px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:440px;background:#101010;border:1px solid #2a2a2a;border-radius:12px">
<tr><td style="padding:28px 28px 8px;font-size:13px;letter-spacing:2px;color:#F5D85A;font-weight:bold">SGS TRACKER</td></tr>
<tr><td style="padding:0 28px;font-size:16px;line-height:1.5;color:#dddddd">Your sign-in code:</td></tr>
<tr><td style="padding:14px 28px 6px;font-size:36px;letter-spacing:10px;font-weight:bold;color:#ffffff">${code}</td></tr>
<tr><td style="padding:6px 28px 28px;font-size:13px;line-height:1.5;color:#999999">It expires in ${CODE_MINUTES} minutes. If you didn't just sign in to tracker.solidgoldsystems.com, someone has your password: change it right away.</td></tr>
</table></td></tr></table></body></html>`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return json(req, 405, { error: "Method not allowed" });

  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: me, error: meErr } = await admin.auth.getUser(token);
  if (meErr || !me?.user?.email) return json(req, 401, { error: "Not signed in" });
  const user = me.user;
  const sessionId = String(claims(token).session_id || "");
  if (!/^[0-9a-f-]{36}$/.test(sessionId)) return json(req, 400, { error: "Sign in again" });

  // Only Tracker team members get codes.
  const { data: member } = await admin.from("team_members").select("email").ilike("email", user.email!).maybeSingle();
  if (!member) return json(req, 403, { error: "This account doesn't have Tracker access." });

  let body: any = {};
  try { body = await req.json(); } catch (_) { /* empty */ }
  const action = String(body.action || "");

  try {
    if (action === "send") {
      const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
      const { count } = await admin.from("mfa_email_codes").select("id", { count: "exact", head: true })
        .eq("user_id", user.id).gte("created_at", since);
      if ((count || 0) >= MAX_SENDS) return json(req, 429, { error: "Too many codes requested. Wait 15 minutes and try again." });

      const key = Deno.env.get("RESEND_API_KEY");
      if (!key) return json(req, 500, { error: "Email isn't set up yet (RESEND_API_KEY missing)." });

      const code = sixDigits();
      await admin.from("mfa_email_codes").update({ used_at: new Date().toISOString() })
        .eq("session_id", sessionId).is("used_at", null);   // older codes for this sign-in stop working
      const { error: insErr } = await admin.from("mfa_email_codes").insert({
        user_id: user.id, session_id: sessionId, code_hash: await sha256(sessionId + ":" + code),
        expires_at: new Date(Date.now() + CODE_MINUTES * 60 * 1000).toISOString(),
      });
      if (insErr) throw insErr;

      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: FROM, to: [user.email], subject: "Your Tracker sign-in code: " + code,
          html: emailHtml(code),
          text: "Your SGS Tracker sign-in code: " + code + "\nIt expires in " + CODE_MINUTES + " minutes.",
        }),
      });
      if (!res.ok) {
        console.error("[email-2fa] resend error", res.status, await res.text());
        return json(req, 502, { error: "Couldn't send the email. Try again in a minute." });
      }
      const masked = user.email!.replace(/^(.{2}).*(@.*)$/, "$1•••$2");
      return json(req, 200, { ok: true, sent_to: masked });
    }

    if (action === "verify") {
      const code = String(body.code || "").replace(/\D/g, "");
      if (code.length !== 6) return json(req, 400, { error: "Enter the 6-digit code." });
      const { data: row } = await admin.from("mfa_email_codes").select("*")
        .eq("session_id", sessionId).eq("user_id", user.id).is("used_at", null)
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (!row || new Date(row.expires_at) < new Date()) return json(req, 400, { error: "That code expired. Send a new one." });
      if (row.attempts >= MAX_ATTEMPTS) return json(req, 400, { error: "Too many wrong codes. Send a new one." });
      await admin.from("mfa_email_codes").update({ attempts: row.attempts + 1 }).eq("id", row.id);
      if (!same(row.code_hash, await sha256(sessionId + ":" + code))) {
        const left = MAX_ATTEMPTS - row.attempts - 1;
        return json(req, 400, { error: left > 0 ? "Wrong code. " + left + " tries left." : "Too many wrong codes. Send a new one." });
      }
      await admin.from("mfa_email_codes").update({ used_at: new Date().toISOString() }).eq("id", row.id);
      const { error: vErr } = await admin.from("verified_sessions").upsert({
        session_id: sessionId, user_id: user.id, verified_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + TRUST_DAYS * 86400000).toISOString(),
      }, { onConflict: "session_id" });
      if (vErr) throw vErr;
      // housekeeping
      await admin.from("verified_sessions").delete().lt("expires_at", new Date().toISOString());
      await admin.from("mfa_email_codes").delete().lt("created_at", new Date(Date.now() - 86400000).toISOString());
      return json(req, 200, { ok: true });
    }

    if (action === "signout") {
      await admin.from("verified_sessions").delete().eq("session_id", sessionId);
      return json(req, 200, { ok: true });
    }

    return json(req, 400, { error: "Unknown action" });
  } catch (e) {
    console.error("[email-2fa]", action, e);
    return json(req, 500, { error: "Something went wrong. Try again." });
  }
});
