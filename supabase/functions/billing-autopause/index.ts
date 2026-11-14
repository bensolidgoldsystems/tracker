// Solid Gold Systems Tracker - pause ad billing while a client's ads are off.
// Hourly (after meta-sync): for each client with billing_autopause on and not churned, across every Stripe
// customer linked to the client (their own and the partner's, e.g. "Client - 633 Studios"):
//   ads off 3+ days (latest ads event is paused/stopped 3+ days ago and no campaign is delivering)
//     -> pause collection on their ad spend prepayment and ad management subscriptions (invoices voided while paused)
//   ads never went live (no ads events yet, nothing delivering) -> paused right away
//   a scheduled (not started) ad subscription can't be paused, so while ads aren't live and it would start
//     within a day, its start (and its phases) move back a day; it starts once the ads are live
//   ads live again (a campaign is delivering, or the latest event is launched/relaunched)
//     -> resume the subscriptions THIS function paused (metadata sgs_autopaused); a pause made by hand
//        in Stripe is never resumed here.
// Only ad subscriptions are touched (ad spend, Meta ad management, The Solid Gold System); websites, Shopify,
// video and anything else never.
// Every change is logged in billing_events. {"dry": true} returns what it would do and changes nothing.
// Auth: x-cron-secret (Vault meta_sync_secret) or a signed-in team member.
// Secret: STRIPE_BILLING_KEY (restricted: Subscriptions write, Products read, Prices read).
import { createClient } from "npm:@supabase/supabase-js@2";

const ALLOWED_ORIGINS = ["https://tracker.solidgoldsystems.com", "https://solidgoldtracker.netlify.app"];
const OFF_DAYS = 3;
const AD_SUB = /ad spend|pre ?-?payment|prepay|ad management|ad account management|solid gold system|lead generation/i;
const NOT_AD = /website|shopify|video|\berp\b/i;
const ON = ["launched", "relaunched"], OFF = ["paused", "stopped"];

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

async function stripe(method: "GET" | "POST", path: string, params: Record<string, string> = {}) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch("https://api.stripe.com/v1" + path + (method === "GET" && qs ? "?" + qs : ""), {
    method,
    headers: { Authorization: "Bearer " + (Deno.env.get("STRIPE_BILLING_KEY") || ""), ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
    body: method === "POST" ? qs : undefined,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(((body.error && body.error.message) || "Stripe error " + res.status) + " [" + path + "]");
  return body;
}

function nyToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function daysBetween(a: string, b: string) { return Math.round((new Date(b + "T12:00:00Z").getTime() - new Date(a + "T12:00:00Z").getTime()) / 864e5); }

// Move a not-started schedule (and every phase) back so it starts a day from now. Stripe needs the
// phases sent in full, so each phase's items and settings are copied as they are.
async function holdSchedule(sc: any) {
  const now = Math.floor(Date.now() / 1000), start = sc.phases[0].start_date;
  const shift = Math.max(0, now + 86400 - start);
  if (!shift) return;
  const p: Record<string, string> = { "metadata[sgs_held]": "1" };
  sc.phases.forEach((ph: any, i: number) => {
    const k = "phases[" + i + "]";
    if (i === 0) p[k + "[start_date]"] = String(start + shift);
    if (ph.end_date) p[k + "[end_date]"] = String(ph.end_date + shift);
    (ph.items || []).forEach((it: any, j: number) => {
      p[k + "[items][" + j + "][price]"] = typeof it.price === "string" ? it.price : it.price.id;
      p[k + "[items][" + j + "][quantity]"] = String(it.quantity || 1);
    });
    if (ph.collection_method) p[k + "[collection_method]"] = ph.collection_method;
    if (ph.invoice_settings && ph.invoice_settings.days_until_due) p[k + "[invoice_settings][days_until_due]"] = String(ph.invoice_settings.days_until_due);
    if (ph.proration_behavior) p[k + "[proration_behavior]"] = ph.proration_behavior;
    if (ph.default_payment_method) p[k + "[default_payment_method]"] = typeof ph.default_payment_method === "string" ? ph.default_payment_method : ph.default_payment_method.id;
  });
  await stripe("POST", "/subscription_schedules/" + sc.id, p);
}

// The same problem is logged once until someone clicks Done on it (the job runs every hour).
async function logError(client_id: string, subscription_id: string, reason: string, amount: number | null) {
  const { data: had } = await db.from("billing_events").select("id").eq("client_id", client_id).eq("action", "error").eq("reason", reason).is("seen_at", null).limit(1);
  if (!had || !had.length) await db.from("billing_events").insert({ client_id, subscription_id, action: "error", reason, amount });
}

async function run(dry: boolean) {
  if (!Deno.env.get("STRIPE_BILLING_KEY")) return { ok: false, configured: false, message: "Add the STRIPE_BILLING_KEY secret (Subscriptions write, Products read, Prices read)." };
  const today = nyToday();
  const { data: clients, error } = await db.from("clients").select("id,business_name,status,meta_ad_account_ids,stripe_customer_ids,billing_autopause")
    .neq("status", "churned").eq("billing_autopause", true);
  if (error) throw error;
  const ids = (clients || []).map((c: any) => c.id);
  const [{ data: events }, { data: accts }] = await Promise.all([
    db.from("ad_events").select("client_id,kind,event_date,created_at").in("client_id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"])
      .order("event_date", { ascending: false }).order("created_at", { ascending: false }),
    db.from("meta_ad_accounts").select("ad_account_id,delivering"),
  ]);
  const delivering: Record<string, boolean | null> = {};
  for (const a of accts || []) delivering[a.ad_account_id] = a.delivering;
  const latest: Record<string, any> = {};
  for (const e of events || []) if (!latest[e.client_id]) latest[e.client_id] = e;

  const products: Record<string, any> = {};
  async function isAd(price: any): Promise<boolean> {
    price = price || {};
    const pid = typeof price.product === "string" ? price.product : price.product && price.product.id;
    let name = price.nickname || "";
    if (pid) {
      if (!products[pid]) products[pid] = await stripe("GET", "/products/" + pid);
      name += " " + (products[pid].name || "");
    }
    return AD_SUB.test(name) && !NOT_AD.test(name);
  }
  const prices: Record<string, any> = {};
  async function priceOf(id: string) { if (!prices[id]) prices[id] = await stripe("GET", "/prices/" + id); return prices[id]; }

  const actions: any[] = [];
  for (const c of clients || []) {
    const cus = (c.stripe_customer_ids || []).filter((x: string) => /^cus_/.test(x));
    const acc = (c.meta_ad_account_ids || []).filter((x: string) => /^\d+$/.test(x));
    if (!cus.length || !acc.length) continue;
    const ev = latest[c.id];
    const live = acc.some((a: string) => delivering[a] === true) || (ev && ON.includes(ev.kind));
    const offFor = !ev ? 9999 : OFF.includes(ev.kind) ? daysBetween(ev.event_date, today) : -1;
    const off = !live && offFor >= OFF_DAYS;
    const notLive = !live;
    for (const cu of cus) {
      let subs: any[] = [];
      try { subs = (await stripe("GET", "/subscriptions", { customer: cu, status: "active", limit: "20" })).data || []; }
      catch (e) { actions.push({ client_id: c.id, client: c.business_name, subscription_id: "", action: "error", reason: String((e as Error).message || e).slice(0, 300) }); continue; }
      // Scheduled ad subscriptions wait for the ads: while they aren't live, a schedule about to start
      // (within a day) is pushed back a day. When the ads go live it simply starts on its (new) date.
      if (notLive) {
        let sch: any[] = [];
        try { sch = (await stripe("GET", "/subscription_schedules", { customer: cu, scheduled: "true", limit: "10" })).data || []; }
        catch (e) { actions.push({ client_id: c.id, client: c.business_name, subscription_id: "", action: "error", reason: "Couldn't read scheduled subscriptions: " + String((e as Error).message || e).slice(0, 250) }); }
        for (const sc of sch) {
          const ph = (sc.phases || [])[0];
          if (!ph || sc.status !== "not_started" || ph.start_date * 1000 > Date.now() + 26 * 3600e3) continue;
          let ad = false, amount = 0;
          for (const it of ph.items || []) { const pr = await priceOf(typeof it.price === "string" ? it.price : it.price.id); if (await isAd(pr)) { ad = true; amount += (pr.unit_amount || 0) * (it.quantity || 1) / 100; } }
          if (!ad) continue;
          actions.push({ client_id: c.id, client: c.business_name, subscription_id: sc.id, action: "held", amount, schedule: sc,
            reason: "Ads aren't live yet, so its start moved back a day (it starts once the ads are live)" });
        }
      }
      for (const s of subs) {
        const items = (s.items && s.items.data) || [];
        let ad = false;
        for (const it of items) { if (await isAd(it.price)) { ad = true; break; } }
        if (!ad) continue;
        const amount = items.reduce((t: number, it: any) => t + ((it.price && it.price.unit_amount) || 0) * (it.quantity || 1), 0) / 100;
        const mine = !!(s.metadata && s.metadata.sgs_autopaused);
        if (off && !s.pause_collection) {
          actions.push({ client_id: c.id, client: c.business_name, subscription_id: s.id, action: "paused", amount, reason: ev ? "Ads off " + offFor + " days (since " + ev.event_date + ")" : "Ads haven't gone live yet" });
        } else if (live && s.pause_collection && mine) {
          actions.push({ client_id: c.id, client: c.business_name, subscription_id: s.id, action: "resumed", amount, reason: "Ads are live again" });
        }
      }
    }
  }
  if (dry) return { ok: true, dry: true, actions: actions.map(({ schedule: _s, ...a }) => a) };

  let done = 0;
  for (const a of actions) {
    if (a.action === "error") { await logError(a.client_id, "", a.reason, null); continue; }
    if (a.action === "warning") {
      // Once per schedule.
      const { data: had } = await db.from("billing_events").select("id").eq("subscription_id", a.subscription_id).eq("action", "warning").limit(1);
      if (!had || !had.length) await db.from("billing_events").insert({ client_id: a.client_id, subscription_id: a.subscription_id, action: "warning", reason: a.reason, amount: a.amount });
      continue;
    }
    if (a.action === "held") {
      try {
        await holdSchedule(a.schedule);
        // Logged once per schedule (it moves a day at a time until the ads are live).
        const { data: had } = await db.from("billing_events").select("id").eq("subscription_id", a.subscription_id).eq("action", "warning").limit(1);
        if (!had || !had.length) await db.from("billing_events").insert({ client_id: a.client_id, subscription_id: a.subscription_id, action: "warning", amount: a.amount,
          reason: "A $" + a.amount + " ad subscription was about to start, but the ads aren't live. Holding it: it starts once the ads are live." });
        done++;
      } catch (e) { await logError(a.client_id, a.subscription_id, "Couldn't hold the scheduled subscription: " + String((e as Error).message || e).slice(0, 300), a.amount); }
      continue;
    }
    try {
      if (a.action === "paused") {
        await stripe("POST", "/subscriptions/" + a.subscription_id, { "pause_collection[behavior]": "void", "metadata[sgs_autopaused]": today });
      } else {
        await stripe("POST", "/subscriptions/" + a.subscription_id, { "pause_collection": "", "metadata[sgs_autopaused]": "" });
      }
      await db.from("billing_events").insert({ client_id: a.client_id, subscription_id: a.subscription_id, action: a.action, reason: a.reason, amount: a.amount });
      done++;
    } catch (e) {
      await logError(a.client_id, a.subscription_id, (a.action === "paused" ? "Couldn't pause: " : "Couldn't resume: ") + String((e as Error).message || e).slice(0, 300), a.amount);
    }
  }
  return { ok: true, changed: done, actions: actions.map(({ schedule: _s, ...a }) => a) };
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
  try { return json(req, 200, await run(!!body.dry)); }
  catch (e) { return json(req, 200, { ok: false, message: String((e as Error).message || e).slice(0, 500) }); }
});
