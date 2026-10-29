// Solid Gold Systems Tracker - Stripe sync (read-only on Stripe's side).
// Every paid invoice and standalone charge since FIRST_DAY becomes money_entries rows, by the day
// it was paid, split by invoice line:
//   "Ad Spend Pre Payment" / projected spend  -> ad_reimbursement (prepaid ad spend)
//   "Video ..." / "shoot"                     -> video_shoot ($600 per shoot goes to the videographer)
//   "N Leads" / "Qualified Lead"              -> per_lead
//   anything else (management, websites)      -> revenue
// Card payments on prepays and shoots carry a 3% surcharge; the extra is recorded as card_fee.
// Spreadsheet rows for months Stripe now covers move to money_entries_superseded (cash/Zelle rows stay).
// Auth: x-cron-secret (Vault meta_sync_secret) or a signed-in team member.
// Secret: STRIPE_SECRET_KEY (restricted: Invoices read, Charges read, Customers read).
import { createClient } from "npm:@supabase/supabase-js@2";

const ALLOWED_ORIGINS = ["https://tracker.solidgoldsystems.com", "https://solidgoldtracker.netlify.app"];
const FIRST_DAY = "2026-01-01";
const SHOOT_PRICE = 600;          // what the videographer is paid per shoot
const CARD_SURCHARGE = 0.03;
const STRIPE_CATS = ["revenue", "per_lead", "ad_reimbursement", "video_shoot", "card_fee"];

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

async function stripe(path: string, params: Record<string, string> = {}) {
  const u = "https://api.stripe.com/v1" + path + "?" + new URLSearchParams(params).toString();
  const res = await fetch(u, { headers: { Authorization: "Bearer " + (Deno.env.get("STRIPE_SECRET_KEY") || "") } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(((body.error && body.error.message) || "Stripe error " + res.status) + " [" + path + "]");
  return body;
}
async function stripeAll(path: string, params: Record<string, string>) {
  const out: any[] = [];
  let after = "";
  for (let i = 0; i < 50; i++) {
    const p = { ...params, limit: "100" } as Record<string, string>;
    if (after) p.starting_after = after;
    const r = await stripe(path, p);
    out.push(...(r.data || []));
    if (!r.has_more || !r.data.length) break;
    after = r.data[r.data.length - 1].id;
  }
  return out;
}

function nyDate(unix: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(unix * 1000));
}
const cents = (n: number) => Math.round(n * 100) / 100;
const norm = (s: string) => String(s || "").toLowerCase().replace(/-\s*633 studios?/g, "").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

function classify(desc: string): string {
  const s = String(desc || "");
  if (/ad spend|pre ?-?payment|prepay|reimburs|projected spend/i.test(s)) return "ad_reimbursement";
  if (/video|shoot/i.test(s)) return "video_shoot";
  if (/\bleads?\b/i.test(s) && !/lead-?gen/i.test(s)) return "per_lead";
  return "revenue";
}
// Base amount + card fee covered. Prepays: a 3% surcharge shows as amount = base * 1.03 with a
// whole-dollar base. Shoots: everything above $600 per shoot.
function splitFee(cat: string, amount: number, qty: number): [number, number] {
  if (cat === "video_shoot") {
    const base = Math.min(amount, SHOOT_PRICE * Math.max(1, qty));
    return [cents(base), cents(amount - base)];
  }
  if (cat === "ad_reimbursement") {
    const base = amount / (1 + CARD_SURCHARGE);
    if (Math.abs(base - Math.round(base)) < 0.006 && amount - base > 0.5) return [Math.round(base), cents(amount - Math.round(base))];
  }
  return [amount, 0];
}
function leadQty(desc: string, qty: number): number | null {
  const m = /(\d+)\s*leads?\b/i.exec(desc || "");
  return m ? Number(m[1]) : qty || null;
}

async function runSync(dry = false) {
  if (!Deno.env.get("STRIPE_SECRET_KEY")) return { ok: false, configured: false, message: "Stripe isn't connected." };
  const { data: run } = dry ? { data: null } : await db.from("stripe_sync_runs").insert({}).select("id").single();
  try {
    const since = String(Math.floor(new Date(FIRST_DAY + "T00:00:00-05:00").getTime() / 1000));
    const invoices = await stripeAll("/invoices", { status: "paid", "created[gte]": since });
    const charges = await stripeAll("/charges", { "created[gte]": since });

    // Stripe customer -> client (linked IDs first, then by name; name matches get linked).
    const { data: clients } = await db.from("clients").select("id,business_name,stripe_customer_ids");
    const byCus: Record<string, string> = {};
    for (const c of clients || []) for (const id of c.stripe_customer_ids || []) byCus[id] = c.id;
    const linkNew: Record<string, string[]> = {};
    const clientFor = (cus: string, name: string): string | null => {
      if (!cus) return null;
      if (byCus[cus]) return byCus[cus];
      const n = norm(name);
      if (!n) return null;
      for (const c of clients || []) {
        const b = norm(c.business_name), first = b.split(" ")[0];
        if (b === n || b.startsWith(n) || n.startsWith(b) || (first.length > 4 && n.split(" ")[0] === first)) {
          byCus[cus] = c.id; (linkNew[c.id] = linkNew[c.id] || []).push(cus); return c.id;
        }
      }
      return null;
    };

    const rows: any[] = [];
    const unmatched: Record<string, { name: string; amount: number; count: number }> = {};
    const push = (clientId: string | null, cusName: string, cat: string, day: string, amount: number, ref: string, note: string, qty: number | null) => {
      if (!amount) return;
      if (!clientId) { const u = unmatched[cusName] = unmatched[cusName] || { name: cusName, amount: 0, count: 0 }; u.amount = cents(u.amount + amount); u.count++; }
      rows.push({ client_id: clientId, category: cat, month: day.slice(0, 7) + "-01", entry_date: day, amount: cents(amount), source: "stripe",
        external_ref: ref, payment_method: "Stripe", note: note.slice(0, 200), quantity: qty });
    };

    for (const inv of invoices) {
      if (!inv.amount_paid) continue;
      const paidAt = (inv.status_transitions && inv.status_transitions.paid_at) || inv.created;
      const day = nyDate(paidAt);
      const name = inv.customer_name || "";
      const clientId = clientFor(String(inv.customer || ""), name);
      const lines = ((inv.lines && inv.lines.data) || []).filter((l: any) => l.amount);
      const sum = lines.reduce((s: number, l: any) => s + l.amount, 0);
      const factor = sum > 0 ? inv.amount_paid / sum : 0;
      if (!lines.length || !factor) {
        push(clientId, name, classify(inv.description || ""), day, inv.amount_paid / 100, "stripe:" + inv.id, (inv.number || "") + " " + (inv.description || ""), null);
        continue;
      }
      for (const l of lines) {
        const amt = cents(l.amount * factor / 100);
        const cat = classify(l.description);
        const qty = l.quantity || 1;
        const [base, fee] = splitFee(cat, amt, qty);
        const ref = "stripe:" + inv.id + ":" + l.id;
        const note = (inv.number ? "Invoice " + inv.number + ": " : "") + (l.description || "");
        push(clientId, name, cat, day, base, ref, note, cat === "per_lead" ? leadQty(l.description, qty) : cat === "video_shoot" ? qty : null);
        if (fee) push(clientId, name, "card_fee", day, fee, ref + ":fee", "3% card fee covered: " + note, null);
      }
    }
    // Charges not tied to an invoice (one-off charges, pay-per-lead charges from Tracker), and refunds.
    for (const ch of charges) {
      if (ch.status !== "succeeded" || !ch.paid) continue;
      const cus = typeof ch.customer === "string" ? ch.customer : (ch.customer && ch.customer.id) || "";
      const name = (ch.billing_details && ch.billing_details.name) || "";
      const clientId = clientFor(cus, name);
      const viaInvoice = /invoice|subscription/i.test(ch.description || "");
      if (!viaInvoice) {
        const cat = classify(ch.description || "");
        const amt = ch.amount / 100;
        const [base, fee] = splitFee(cat, amt, 1);
        push(clientId, name, cat, nyDate(ch.created), base, "stripe:" + ch.id, ch.description || "Stripe charge", cat === "per_lead" ? leadQty(ch.description, 1) : null);
        if (fee) push(clientId, name, "card_fee", nyDate(ch.created), fee, "stripe:" + ch.id + ":fee", "3% card fee covered: " + (ch.description || ""), null);
      }
      if (ch.amount_refunded) {
        const refunds = await stripe("/refunds", { charge: ch.id, limit: "10" });
        for (const r of refunds.data || []) {
          if (r.status !== "succeeded") continue;
          push(clientId, name, viaInvoice ? "revenue" : classify(ch.description || ""), nyDate(r.created), -r.amount / 100, "stripe:" + r.id, "Refund: " + (ch.description || ""), null);
        }
      }
    }

    if (dry) {
      // Preview only: totals by client / category / month, and what the spreadsheet rows would become.
      const names: Record<string, string> = {};
      for (const c of clients || []) names[c.id] = c.business_name;
      const sum: Record<string, number> = {};
      for (const r of rows) { const k = (names[r.client_id] || "?" ) + " | " + r.category + " | " + r.month.slice(0, 7); sum[k] = cents((sum[k] || 0) + r.amount); }
      return { ok: true, dry: true, rows: rows.length, totals: sum, unmatched: Object.values(unmatched), link: linkNew };
    }
    // Save: Stripe rows are the source of truth for these categories.
    for (const [cid, ids] of Object.entries(linkNew)) {
      const c = (clients || []).find((x) => x.id === cid);
      await db.from("clients").update({ stripe_customer_ids: [...new Set([...(c?.stripe_customer_ids || []), ...ids])] }).eq("id", cid);
    }
    // Pay-per-lead charges made from Tracker already exist (with who charged and the card): leave them.
    const ppl = rows.filter((r) => r.category === "per_lead"), rest = rows.filter((r) => r.category !== "per_lead");
    for (const [list, ignore] of [[rest, false], [ppl, true]] as [any[], boolean][]) {
      for (let i = 0; i < list.length; i += 500) {
        const { error } = await db.from("money_entries").upsert(list.slice(i, i + 500), { onConflict: "external_ref", ignoreDuplicates: ignore });
        if (error) throw error;
      }
    }
    const keep = new Set(rows.map((r) => r.external_ref));
    const { data: old } = await db.from("money_entries").select("id,external_ref").eq("source", "stripe").in("category", STRIPE_CATS);
    const stale = (old || []).filter((o: any) => !keep.has(o.external_ref)).map((o: any) => o.id);
    for (let i = 0; i < stale.length; i += 200) await db.from("money_entries").delete().in("id", stale.slice(i, i + 200));

    // Spreadsheet rows from a client's first Stripe-paid month on are replaced (cash/Zelle rows stay).
    const first: Record<string, string> = {};
    for (const r of rows) {
      if (!r.client_id || !["revenue", "ad_reimbursement", "per_lead"].includes(r.category)) continue;
      const k = r.client_id + "|" + r.category;
      if (!first[k] || r.month < first[k]) first[k] = r.month;
    }
    const { data: sheet } = await db.from("money_entries").select("*").eq("source", "sheet").in("category", ["revenue", "ad_reimbursement", "per_lead"]);
    const replace = (sheet || []).filter((e: any) => {
      const f = first[e.client_id + "|" + e.category];
      return f && e.month >= f && !/cash|zelle/i.test(e.payment_method || "");
    });
    if (replace.length) {
      const { error } = await db.from("money_entries_superseded").upsert(replace, { onConflict: "id" });
      if (error) throw error;
      await db.from("money_entries").delete().in("id", replace.map((e: any) => e.id));
    }

    const um = Object.values(unmatched);
    const message = rows.length + " Stripe entries" + (replace.length ? ", " + replace.length + " spreadsheet rows replaced" : "") + (um.length ? ", " + um.length + " customer(s) not matched to a client" : "");
    await db.from("stripe_sync_runs").update({ finished_at: new Date().toISOString(), ok: true, entries: rows.length, message, unmatched: um }).eq("id", run?.id);
    return { ok: true, configured: true, entries: rows.length, replaced: replace.length, unmatched: um, message };
  } catch (e) {
    const message = String((e as Error).message || e).slice(0, 900);
    await db.from("stripe_sync_runs").update({ finished_at: new Date().toISOString(), ok: false, message }).eq("id", run?.id);
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
  return json(req, 200, await runSync(!!body.dry));
});
