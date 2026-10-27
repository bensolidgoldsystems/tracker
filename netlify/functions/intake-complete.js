/* Step 2 of an intake submission, called after the browser finishes uploading.
   Records which files actually landed in storage, marks the lead complete,
   and updates the contact in GoHighLevel. */

const { BUCKET, sb, reply, readJson, pushToGhl } = require("../lib/shared");

const CLIENT_KINDS = ["logo", "icon", "photos", "reviews"];

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") { return reply(405, { ok: false, error: "Method not allowed" }); }

  let body;
  try { body = readJson(event); } catch (e) { return reply(400, { ok: false, error: "Bad request" }); }
  const leadId = String(body.lead_id || "");
  const token = String(body.token || "");
  if (!/^[0-9a-f-]{36}$/.test(leadId) || token.length < 20) { return reply(400, { ok: false, error: "Bad request" }); }

  try {
    const rows = await sb("/rest/v1/leads?id=eq." + leadId + "&select=*", { method: "GET" });
    const lead = rows && rows[0];
    if (!lead || !lead.submit_token || lead.submit_token !== token) { return reply(403, { ok: false, error: "Not allowed" }); }

    // List what really arrived (don't trust the browser's word for it).
    const found = [];
    for (const kind of CLIENT_KINDS) {
      const list = await sb("/storage/v1/object/list/" + BUCKET, {
        method: "POST",
        body: JSON.stringify({ prefix: leadId + "/" + kind + "/", limit: 1000, offset: 0 })
      });
      (list || []).forEach(function (o) {
        if (!o.id) { return; } // folder placeholder
        const meta = o.metadata || {};
        found.push({
          lead_id: leadId,
          kind,
          path: leadId + "/" + kind + "/" + o.name,
          name: o.name.replace(/^\d{3}-/, ""),
          size: Number(meta.size || 0),
          mime: meta.mimetype || "",
          source: "client"
        });
      });
    }

    if (found.length) {
      await sb("/rest/v1/lead_files?on_conflict=path", {
        method: "POST",
        headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
        body: JSON.stringify(found)
      });
    }

    const ghl = await pushToGhl(lead, found.length);

    await sb("/rest/v1/leads?id=eq." + leadId, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        intake_status: "complete",
        submit_token: null,
        ghl_contact_id: (ghl && ghl.contactId) || lead.ghl_contact_id || null
      })
    });

    return reply(200, { ok: true, files: found.length });
  } catch (e) {
    console.error("[intake-complete] failed:", e.message, leadId);
    return reply(500, { ok: false, error: "Could not finish the submission" });
  }
};
