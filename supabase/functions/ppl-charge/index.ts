// Solid Gold Systems Tracker - pay-per-lead charging through Stripe.
// Called from the Pay per lead tab by signed-in team members (email 2FA verified).
//   action "info"   {client_id}            -> card on file; records past lead charges from Stripe
//   action "charge" {client_id, day, leads} -> charges the saved card "N Leads - MM/DD/YY"
// Secret: STRIPE_SECRET_KEY (restricted key: Customers read, Charges read, PaymentMethods read,
// PaymentIntents write).
import { createClient } from "npm:@supabase/supabase-js@2";

const ALLOWED_ORIGINS = ["https://tracker.solidgoldsystems.com", "https://solidgoldtracker.netlify.app"];
const url = Deno.env.get("SUPABASE_URL")!;
function serviceKey(): string {
  try {
    const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
    if (keys.default) return keys.default;
  } catch (_) { /* legacy key */ }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
}
const db = createClient(url, serviceKey(), { auth: { persistSession: false, autoRefreshToken: false } });

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

// Who is calling: must pass is_team() (team member + verified, active session).
async function caller(token: string): Promise<string | null> {
  if (!token) return null;
  const user = createClient(url, Deno.env.get("SUPABASE_ANON_KEY") || "", {
    auth: { persistSession: false }, global: { headers: { Authorization: "Bearer " + token } },
  });
  const { data: ok } = await user.rpc("is_team");
  if (ok !== true) return null;
  const { data } = await user.auth.getUser(token);
  return (data && data.user && data.user.email) || "team";
}

async function stripe(method: string, path: string, params?: Record<string, string>, idem?: string) {
  const key = Deno.env.get("STRIPE_SECRET_KEY") || "";
  const headers: Record<string, string> = { Authorization: "Bearer " + key };
  let body: string | undefined;
  let u = "https://api.stripe.com/v1" + path;
  if (params && method === "GET") u += "?" + new URLSearchParams(params).toString();
  if (params && method !== "GET") { body = new URLSearchParams(params).toString(); headers["Content-Type"] = "application/x-www-form-urlencoded"; }
  if (idem) headers["Idempotency-Key"] = idem;
  const res = await fetch(u, { method, headers, body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = data.error || {};
    const err = new Error(e.message || ("Stripe error " + res.status)) as Error & { code?: string; decline?: string };
    err.code = e.code; err.decline = e.decline_code;
    throw err;
  }
  return data;
}

// "3 Leads - 10/27/26", "1 Lead - 10/2/2026"
const DESC = /(\d+)\s*leads?\s*[-–]\s*(\d{1,2})\/(\d{1,2})\/(\d{2,4})/i;
function parseDesc(s: string) {
  const m = DESC.exec(s || "");
  if (!m) return null;
  const y = m[4].length === 2 ? 2000 + Number(m[4]) : Number(m[4]);
  return { leads: Number(m[1]), day: y + "-" + m[2].padStart(2, "0") + "-" + m[3].padStart(2, "0") };
}
function mdy(day: string) { const [y, m, d] = day.split("-"); return Number(m) + "/" + Number(d) + "/" + y.slice(2); }

async function loadClient(id: string) {
  const { data: c } = await db.from("clients").select("id,business_name,stripe_customer_ids").eq("id", id).maybeSingle();
  if (!c) throw new Error("Client not found");
  const { data: svc } = await db.from("client_services").select("price,status").eq("client_id", id).eq("billing_type", "per_lead").neq("status", "ended").limit(1);
  return { c, price: svc && svc[0] ? Number(svc[0].price) : 0 };
}

// Card on file: the customer's default payment method, else their first saved card.
async function cardOnFile(customers: string[]) {
  for (const cus of customers) {
    try {
      const c = await stripe("GET", "/customers/" + cus, { "expand[]": "invoice_settings.default_payment_method" });
      let pm = c.invoice_settings && c.invoice_settings.default_payment_method;
      if (!pm || typeof pm === "string") {
        const list = await stripe("GET", "/customers/" + cus + "/payment_methods", { type: "card", limit: "1" });
        pm = list.data && list.data[0];
      }
      if (pm && pm.id) {
        const card = pm.card || {};
        return { customer: cus, payment_method: pm.id, label: (card.brand ? card.brand.charAt(0).toUpperCase() + card.brand.slice(1) : "Card") + " ··" + (card.last4 || "") };
      }
    } catch (_) { /* try the next customer */ }
  }
  return null;
}

// Record past lead charges from Stripe (description "N Leads - date") so billed days show up.
async function importHistory(clientId: string, customers: string[]) {
  let added = 0;
  for (const cus of customers) {
    const all: any[] = [];
    let after = "";
    for (let i = 0; i < 20; i++) {
      // Same start date as stripe-sync, so imported rows aren't removed again by its cleanup.
      const p: Record<string, string> = { customer: cus, limit: "100", "created[gte]": String(Math.floor(new Date("2026-01-01T00:00:00-05:00").getTime() / 1000)) };
      if (after) p.starting_after = after;
      const list = await stripe("GET", "/charges", p);
      all.push(...(list.data || []));
      if (!list.has_more || !(list.data || []).length) break;
      after = list.data[list.data.length - 1].id;
    }
    const rows = [];
    for (const ch of all) {
      if (ch.status !== "succeeded" || ch.refunded) continue;
      const p = parseDesc(ch.description || "");
      if (!p) continue;
      rows.push({
        client_id: clientId, category: "per_lead", month: p.day.slice(0, 7) + "-01", entry_date: p.day,
        // Full amount: partial refunds are recorded as their own rows by stripe-sync.
        amount: ch.amount / 100, quantity: p.leads, source: "stripe",
        external_ref: "stripe:" + ch.id, payment_method: ch.payment_method_details && ch.payment_method_details.card ? "Card ··" + ch.payment_method_details.card.last4 : "Stripe",
        note: ch.description,
      });
    }
    if (rows.length) {
      const { data } = await db.from("money_entries").upsert(rows, { onConflict: "external_ref", ignoreDuplicates: true }).select("id");
      added += (data || []).length;
    }
  }
  return added;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return json(req, 405, { error: "Method not allowed" });
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const who = await caller(token);
  if (!who) return json(req, 403, { error: "Not allowed" });
  let body: any = {};
  try { body = await req.json(); } catch (_) { /* empty */ }
  if (!Deno.env.get("STRIPE_SECRET_KEY")) return json(req, 200, { ok: false, configured: false, error: "Stripe isn't connected yet." });
  const clientId = String(body.client_id || "");
  if (!/^[0-9a-f-]{36}$/.test(clientId)) return json(req, 400, { error: "Missing client" });

  try {
    const { c, price } = await loadClient(clientId);
    const customers: string[] = (c.stripe_customer_ids || []).filter((x: string) => /^cus_/.test(x));

    if (body.action === "info") {
      const imported = customers.length ? await importHistory(clientId, customers) : 0;
      const card = customers.length ? await cardOnFile(customers) : null;
      return json(req, 200, { ok: true, configured: true, price, card: card ? card.label : null, imported });
    }

    if (body.action === "charge") {
      const day = String(body.day || "");
      const leads = Math.floor(Number(body.leads));
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return json(req, 400, { error: "Pick a day" });
      if (!(leads >= 1 && leads <= 500)) return json(req, 400, { error: "Enter how many leads" });
      if (!(price > 0)) return json(req, 400, { error: "Set this client's price per lead first (Clients → services)." });
      if (!customers.length) return json(req, 400, { error: "This client has no Stripe customer linked." });
      // A charge that never finished (function stopped mid-way) doesn't block the day forever.
      await db.from("money_entries").delete().eq("client_id", clientId).like("external_ref", "pending:%")
        .lt("created_at", new Date(Date.now() - 15 * 60000).toISOString());
      // Never bill the same day twice by accident.
      const { data: prior } = await db.from("money_entries").select("id,amount,quantity").eq("client_id", clientId)
        .eq("category", "per_lead").eq("entry_date", day);
      if (prior && prior.length && !body.again) {
        return json(req, 409, { error: "This day was already billed (" + prior.map((p: any) => (p.quantity || "?") + " leads, $" + p.amount).join("; ") + ").", already: true });
      }
      const card = await cardOnFile(customers);
      if (!card) return json(req, 400, { error: "No saved card for this client in Stripe." });
      const amount = Math.round(leads * price * 100);
      const desc = leads + " Lead" + (leads === 1 ? "" : "s") + " - " + mdy(day);
      // Claim the day first: a second charge for the same day (another tab, a double click) hits the
      // unique external_ref and stops here instead of charging the card again.
      const pending = "pending:ppl:" + clientId + ":" + day + (body.again ? ":" + Date.now() : "");
      const { data: claim, error: claimErr } = await db.from("money_entries").insert({
        client_id: clientId, category: "per_lead", month: day.slice(0, 7) + "-01", entry_date: day, amount: amount / 100,
        quantity: leads, source: "manual", external_ref: pending, payment_method: card.label, note: desc + " (charging...)", created_by: who,
      }).select("id").single();
      if (claimErr || !claim) return json(req, 409, { error: "This day is being charged or was already billed. Refresh and check.", already: true });
      let pi: any;
      try {
        pi = await stripe("POST", "/payment_intents", {
          amount: String(amount), currency: "usd", customer: card.customer, payment_method: card.payment_method,
          off_session: "true", confirm: "true", description: desc, statement_descriptor_suffix: "LEADS",
          "metadata[tracker_client_id]": clientId, "metadata[lead_day]": day, "metadata[leads]": String(leads), "metadata[charged_by]": who,
        }, "ppl-" + claim.id);   // one key per attempt: the day claim above already stops duplicates
      } catch (e) {
        await db.from("money_entries").delete().eq("id", claim.id);
        throw e;
      }
      if (pi.status !== "succeeded") {
        await db.from("money_entries").delete().eq("id", claim.id);
        return json(req, 402, { error: "Payment didn't go through (" + pi.status + ")." });
      }
      const ref = "stripe:" + (pi.latest_charge || pi.id);
      const { error: upErr } = await db.from("money_entries").update({ source: "stripe", external_ref: ref, note: desc }).eq("id", claim.id);
      // The hourly Stripe sync may have recorded this charge already: then drop the placeholder.
      if (upErr) await db.from("money_entries").delete().eq("id", claim.id);
      return json(req, 200, { ok: true, amount: amount / 100, description: desc, card: card.label });
    }
    return json(req, 400, { error: "Unknown action" });
  } catch (e) {
    const err = e as Error & { code?: string; decline?: string };
    const msg = err.code === "card_declined" ? "Card declined" + (err.decline ? " (" + err.decline.replace(/_/g, " ") + ")" : "") + "."
      : err.code === "authentication_required" ? "The bank wants the client to approve this charge. Send them a payment link instead."
      : err.message;
    return json(req, 402, { error: msg });
  }
});
