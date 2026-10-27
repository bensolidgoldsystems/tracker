/* Step 1 of an intake submission.
   Saves the answers as a new lead and hands back one-time signed upload URLs,
   so the browser sends photos straight to Supabase Storage at full quality
   (no Netlify body-size limit, no compression). */

const crypto = require("crypto");
const { BUCKET, sb, reply, readJson, safeName } = require("../lib/shared");

const REQUIRED = ["business_name", "contact_name", "contact_email", "business_phone", "service_1", "services_list", "has_domain", "leads_email"];
const KIND_LIMITS = { logo: 5, icon: 3, photos: 80, reviews: 20 };
const MAX_BYTES = 500 * 1024 * 1024;
const MAX_TEXT = 6000;

exports.handler = async function (event) {
  if (event.httpMethod === "GET") { return reply(200, { ok: true, fn: "intake-start" }); }
  if (event.httpMethod !== "POST") { return reply(405, { ok: false, error: "Method not allowed" }); }

  let body;
  try { body = readJson(event); } catch (e) { return reply(400, { ok: false, error: "Could not read submission" }); }

  // Bots fill the hidden field. Pretend success, store nothing.
  if (body.hp) { return reply(200, { ok: true, lead_id: null, token: null, uploads: [] }); }

  const raw = body.answers && typeof body.answers === "object" ? body.answers : {};
  const answers = {};
  Object.keys(raw).slice(0, 120).forEach(function (k) {
    const v = raw[k];
    if (Array.isArray(v)) { answers[k] = v.slice(0, 20).map(function (x) { return String(x).slice(0, 200); }); }
    else if (typeof v === "boolean") { answers[k] = v; }
    else if (v !== null && v !== undefined) { answers[k] = String(v).slice(0, MAX_TEXT).trim(); }
  });

  const missing = REQUIRED.filter(function (k) { return !answers[k]; });
  if (missing.length) { return reply(400, { ok: false, error: "Missing required fields", missing }); }

  const files = Array.isArray(body.files) ? body.files : [];
  const counts = {};
  for (const f of files) {
    if (!f || !KIND_LIMITS[f.kind]) { return reply(400, { ok: false, error: "Unknown file type" }); }
    counts[f.kind] = (counts[f.kind] || 0) + 1;
    if (counts[f.kind] > KIND_LIMITS[f.kind]) { return reply(400, { ok: false, error: "Too many " + f.kind + " files" }); }
    if (Number(f.size) > MAX_BYTES) { return reply(400, { ok: false, error: "A file is over 500 MB: " + f.name }); }
  }

  const token = crypto.randomBytes(24).toString("hex");
  const ghlId = typeof body.cid === "string" && /^[A-Za-z0-9]{6,64}$/.test(body.cid) ? body.cid : null;

  try {
    const rows = await sb("/rest/v1/leads", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        stage: "build",
        intake_status: files.length ? "uploading" : "complete",
        business_name: answers.business_name,
        contact_name: answers.contact_name,
        email: answers.contact_email,
        phone: answers.business_phone,
        answers,
        submit_token: token,
        ghl_contact_id: ghlId,
        source: "intake"
      })
    });
    const lead = rows[0];

    const uploads = await Promise.all(files.map(async function (f, i) {
      const path = lead.id + "/" + f.kind + "/" + String(i + 1).padStart(3, "0") + "-" + safeName(f.name);
      const signed = await sb("/storage/v1/object/upload/sign/" + BUCKET + "/" + path.split("/").map(encodeURIComponent).join("/"), {
        method: "POST", body: "{}"
      });
      const t = (signed && (signed.token || new URL("http://x" + signed.url).searchParams.get("token"))) || null;
      return { i, path, token: t };
    }));

    return reply(200, { ok: true, lead_id: lead.id, token, uploads });
  } catch (e) {
    console.error("[intake-start] failed:", e.message, JSON.stringify({ business: answers.business_name, email: answers.contact_email }));
    return reply(500, { ok: false, error: "We couldn't save your form. Please try again." });
  }
};
