/* Shared helpers for the Tracker's Netlify functions.
   Talks to Supabase (REST + Storage) with the service key and to GoHighLevel. */

const BUCKET = "intake";
const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_VERSION = "2021-07-28";
const TRACKER_URL = process.env.TRACKER_URL || "https://tracker.solidgoldsystems.com";

function env() {
  const url = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!url || !key) { throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set"); }
  return { url, key };
}

/* New-style secret keys (sb_secret_...) go in the apikey header only;
   legacy JWT service_role keys also go in Authorization. */
function sbHeaders(extra) {
  const { key } = env();
  const h = Object.assign({ apikey: key, "Content-Type": "application/json" }, extra || {});
  if (key.indexOf("eyJ") === 0) { h.Authorization = "Bearer " + key; }
  return h;
}

async function sb(path, opts) {
  const { url } = env();
  const res = await fetch(url + path, Object.assign({}, opts, { headers: sbHeaders((opts && opts.headers) || {}) }));
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  if (!res.ok) {
    const err = new Error("Supabase " + res.status + " on " + path + ": " + text.slice(0, 300));
    err.status = res.status;
    throw err;
  }
  return data;
}

function reply(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify(body)
  };
}

function readJson(event) {
  const body = event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString("utf8") : (event.body || "");
  return JSON.parse(body || "{}");
}

function safeName(name) {
  const base = String(name || "file").normalize("NFKD").replace(/[^\w.\-]+/g, "-").replace(/-+/g, "-").replace(/^[-.]+/, "");
  return (base || "file").slice(-90);
}

/* ---------- GoHighLevel (best effort: never blocks a submission) ---------- */

function ghlHeaders(token) {
  return { Authorization: "Bearer " + token, Version: GHL_VERSION, "Content-Type": "application/json", Accept: "application/json" };
}

async function pushToGhl(lead, fileCount) {
  const token = process.env.GHL_TOKEN;
  const locationId = process.env.GHL_LOCATION_ID;
  if (!token || !locationId) { return { skipped: "GHL not configured" }; }

  const a = lead.answers || {};
  const parts = String(lead.contact_name || "").trim().split(/\s+/);
  const contact = {
    locationId,
    firstName: parts[0] || "",
    lastName: parts.slice(1).join(" "),
    name: lead.contact_name || "",
    companyName: lead.business_name || undefined,
    source: "Website Intake Form"
  };
  if (lead.email) { contact.email = lead.email; }
  if (lead.phone) { contact.phone = lead.phone; }

  let contactId = lead.ghl_contact_id || null;
  try {
    const res = await fetch(GHL_BASE + "/contacts/upsert", { method: "POST", headers: ghlHeaders(token), body: JSON.stringify(contact) });
    const text = await res.text();
    if (res.ok) {
      const data = JSON.parse(text || "{}");
      contactId = (data.contact && data.contact.id) || data.id || contactId;
    } else {
      console.warn("[intake] GHL upsert failed:", res.status, text.slice(0, 300));
    }
  } catch (e) { console.warn("[intake] GHL upsert error:", e && e.message); }

  if (!contactId) { return { error: "no contact id" }; }

  try {
    await fetch(GHL_BASE + "/contacts/" + contactId + "/tags", {
      method: "POST", headers: ghlHeaders(token), body: JSON.stringify({ tags: ["website-intake-complete"] })
    });
  } catch (e) { console.warn("[intake] GHL tag error:", e && e.message); }

  const note = [
    "- Website intake form submitted -",
    "Business:   " + (lead.business_name || "-"),
    "Top service: " + (a.service_1 || "-"),
    "Domain:     " + (a.has_domain || "-") + (a.domain_1 ? " (" + a.domain_1 + ")" : ""),
    "Files uploaded: " + fileCount + (a.photos_link ? " + photo link" : ""),
    "",
    "Open in Tracker: " + TRACKER_URL + "/#lead/" + lead.id
  ].join("\n");
  try {
    await fetch(GHL_BASE + "/contacts/" + contactId + "/notes", {
      method: "POST", headers: ghlHeaders(token), body: JSON.stringify({ body: note })
    });
  } catch (e) { console.warn("[intake] GHL note error:", e && e.message); }

  return { contactId };
}

module.exports = { BUCKET, sb, reply, readJson, safeName, pushToGhl };
