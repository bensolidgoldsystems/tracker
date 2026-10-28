/* Solid Gold Systems Tracker - Clients module
   Client profiles, contacts, partners (633 Studios), services with custom prices, ad timeline.
   tracker.js calls SGSClients.init(helpers) once, then SGSClients.route(hash, el) for
   #clients, #client/<id>, #partner/<id>. */
(function () {
  "use strict";
  var T = null;                 // shared helpers from tracker.js
  var data = { clients: [], services: [], partners: [], cs: [], events: [] };
  var filter = { q: "", status: "current" };

  var STATUS = [
    { id: "onboarding", label: "Onboarding" },
    { id: "active", label: "Active" },
    { id: "paused", label: "Paused" },
    { id: "churned", label: "Churned" }
  ];
  var BILLING = { one_time: "One-time", monthly: "Monthly", per_lead: "Per lead" };
  var CS_STATUS = { active: "Active", paused: "Paused", ended: "Ended", completed: "Completed" };
  var SPEND = {
    none: "No ads / not tracked",
    client_pays: "Client pays Meta directly",
    sgs_prepaid: "SGS pays Meta, client prepays SGS",
    sgs_partner: "SGS pays Meta, partner reimburses monthly"
  };
  var CADENCE = { "": "—", weekly: "Weekly", biweekly: "Every 2 weeks", monthly: "Monthly" };
  var PAY = { stripe: "Stripe", zelle: "Zelle", check: "Check", ach: "ACH", other: "Other" };
  var EVENT = { launched: "Ads launched", relaunched: "Ads relaunched", paused: "Ads paused", stopped: "Ads stopped", note: "Note" };

  /* ---------- helpers ---------- */
  function esc(s) { return T.esc(s); }
  function $(id) { return document.getElementById(id); }
  function money(n, cents) {
    if (n === null || n === undefined || n === "") { return "—"; }
    var v = Number(n);
    return "$" + v.toLocaleString("en-US", { minimumFractionDigits: cents || v % 1 ? 2 : 0, maximumFractionDigits: 2 });
  }
  function dateLong(d) { return d ? new Date(d + (String(d).length === 10 ? "T12:00:00" : "")).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—"; }
  function today() { var d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
  function byId(list, id) { return list.filter(function (x) { return x.id === id; })[0] || null; }
  function svc(id) { return byId(data.services, id); }
  function partner(id) { return byId(data.partners, id); }
  function clientServices(clientId) { return data.cs.filter(function (x) { return x.client_id === clientId; }); }
  function priceLabel(cs) {
    var p = money(cs.price);
    if (cs.billing_type === "monthly") { return p + "/mo"; }
    if (cs.billing_type === "per_lead") { return p + "/lead"; }
    return p + " one-time";
  }
  function statusBadge(st) {
    var cls = st === "active" ? "ok" : st === "onboarding" ? "gold" : st === "paused" ? "warn" : "";
    var label = (byId(STATUS, st) || {}).label || st;
    return '<span class="badge ' + cls + '">' + esc(label) + "</span>";
  }
  // Monthly recurring for one client: active monthly services (paused clients count as 0).
  function monthlyOf(client) {
    if (status(client) === "churned" || status(client) === "paused") { return 0; }
    return clientServices(client.id).filter(function (x) { return x.status === "active" && x.billing_type === "monthly"; })
      .reduce(function (s, x) { return s + Number(x.price || 0); }, 0);
  }
  function perLeadOf(client) {
    return clientServices(client.id).filter(function (x) { return x.status === "active" && x.billing_type === "per_lead"; });
  }
  function adEvents(clientId, includeFuture) {
    var t = today();
    return data.events.filter(function (e) { return e.client_id === clientId && e.kind !== "note" && (includeFuture || e.event_date <= t); })
      .sort(function (a, b) { return a.event_date < b.event_date ? 1 : a.event_date > b.event_date ? -1 : (a.created_at < b.created_at ? 1 : -1); });
  }
  // Start of the current live stretch (most recent launch/relaunch), or null.
  function adsLiveSince(clientId) {
    var ev = adEvents(clientId);
    if (!ev.length || (ev[0].kind !== "launched" && ev[0].kind !== "relaunched")) { return null; }
    return ev[0].event_date;
  }
  // "live", "paused", "stopped" or null, as of today.
  function adsState(clientId) {
    var ev = adEvents(clientId);
    if (!ev.length) { return null; }
    return ev[0].kind === "launched" || ev[0].kind === "relaunched" ? "live" : ev[0].kind;
  }
  function nextScheduled(clientId) {
    var t = today();
    var ev = data.events.filter(function (e) { return e.client_id === clientId && e.kind !== "note" && e.event_date > t; })
      .sort(function (a, b) { return a.event_date < b.event_date ? -1 : 1; });
    return ev[0] || null;
  }
  // Active/Paused follow the ads switch (including scheduled dates once they arrive).
  function status(c) {
    if (c.status !== "active" && c.status !== "paused") { return c.status; }
    var st = adsState(c.id);
    if (!st) { return c.status; }
    return st === "live" ? "active" : "paused";
  }
  async function q(promise) {
    var r = await promise;
    if (r.error) { throw r.error; }
    return r.data;
  }

  /* ---------- data ---------- */
  async function loadAll() {
    var res = await Promise.all([
      q(T.sb.from("clients").select("*").order("business_name")),
      q(T.sb.from("services").select("*").order("sort")),
      q(T.sb.from("partners").select("*").order("name")),
      q(T.sb.from("client_services").select("*").order("created_at")),
      q(T.sb.from("ad_events").select("*").order("event_date", { ascending: false }))
    ]);
    data.clients = res[0]; data.services = res[1]; data.partners = res[2]; data.cs = res[3]; data.events = res[4];
  }

  /* ---------- router ---------- */
  var el = null;
  async function route(hash, container) {
    el = container;
    el.innerHTML = '<p class="muted" style="padding:24px">Loading...</p>';
    try { await loadAll(); } catch (e) { T.fail(e); el.innerHTML = '<p class="muted" style="padding:24px">' + esc(e.message) + "</p>"; return; }
    var m;
    if ((m = hash.match(/^#client\/([0-9a-f-]{36})/))) { renderClient(m[1]); }
    else if ((m = hash.match(/^#partner\/([0-9a-f-]{36})/))) { renderPartner(m[1]); }
    else { renderList(); }
  }
  function refresh() { route(location.hash, el); }

  /* ================= CLIENT LIST ================= */
  function renderList() {
    var current = data.clients.filter(function (c) { return status(c) !== "churned"; });
    var mrr = current.reduce(function (s, c) { return s + monthlyOf(c); }, 0);
    var ppl = current.filter(function (c) { return perLeadOf(c).length; }).length;
    var viaPartner = current.filter(function (c) { return c.partner_id; }).length;

    el.innerHTML =
      '<div class="cl-wrap">' +
      '<div class="cl-head"><h1>Clients</h1><div class="cl-actions"><button class="btn gold" id="newClient">+ New client</button></div></div>' +
      '<div class="stats">' +
        stat("Active clients", data.clients.filter(function (c) { return status(c) === "active"; }).length) +
        stat("Onboarding", data.clients.filter(function (c) { return status(c) === "onboarding"; }).length) +
        stat("Paused", data.clients.filter(function (c) { return status(c) === "paused"; }).length) +
        stat("Monthly recurring", money(mrr)) +
        stat("Pay-per-lead clients", ppl) +
        stat("Via partners", viaPartner) +
      "</div>" +
      '<div class="board-bar cl-bar"><input class="inp search" id="clSearch" type="search" placeholder="Search clients..." aria-label="Search clients" value="' + esc(filter.q) + '">' +
      '<div class="seg" role="group" aria-label="Filter by status">' +
        [["current", "Current"], ["active", "Active"], ["onboarding", "Onboarding"], ["paused", "Paused"], ["churned", "Churned"], ["all", "All"]].map(function (f) {
          return '<button class="seg-b' + (filter.status === f[0] ? " on" : "") + '" data-f="' + f[0] + '">' + f[1] + "</button>";
        }).join("") + "</div></div>" +
      '<div class="cl-table" id="clTable"></div>' +
      (data.partners.length ? '<p class="muted cl-partners">Partners: ' + data.partners.map(function (p) { return '<a href="#partner/' + p.id + '">' + esc(p.name) + "</a>"; }).join(" · ") + "</p>" : "") +
      "</div>";

    $("newClient").onclick = newClient;
    $("clSearch").oninput = function (e) { filter.q = e.target.value; drawTable(); };
    el.querySelectorAll(".seg-b").forEach(function (b) {
      b.onclick = function () { filter.status = b.dataset.f; el.querySelectorAll(".seg-b").forEach(function (x) { x.classList.toggle("on", x === b); }); drawTable(); };
    });
    drawTable();
  }
  function stat(label, value) { return '<div class="stat"><span>' + esc(label) + "</span><b>" + esc(value) + "</b></div>"; }

  function drawTable() {
    var qv = filter.q.toLowerCase();
    var rows = data.clients.filter(function (c) {
      if (filter.status === "current" && status(c) === "churned") { return false; }
      if (filter.status !== "current" && filter.status !== "all" && status(c) !== filter.status) { return false; }
      if (!qv) { return true; }
      var p = partner(c.partner_id);
      return [c.business_name, c.industry, p && p.name].join(" ").toLowerCase().indexOf(qv) !== -1;
    });
    var box = $("clTable");
    if (!rows.length) {
      box.innerHTML = '<div class="empty-state">' + (data.clients.length ? "No clients match." : 'No clients yet. Click <b>+ New client</b>, or open a closed website lead and choose <b>More → Convert to client</b>.') + "</div>";
      return;
    }
    box.innerHTML = '<div class="cl-row cl-th"><span>Client</span><span>Services</span><span>Monthly</span><span>Ads</span></div>' +
      rows.map(function (c) {
        var p = partner(c.partner_id);
        var list = clientServices(c.id).filter(function (x) { return x.status === "active"; });
        var ppl = perLeadOf(c);
        var live = adsLiveSince(c.id), st = adsState(c.id), nx = nextScheduled(c.id);
        return '<a class="cl-row" href="#client/' + c.id + '">' +
          '<span class="cl-name"><b>' + esc(c.business_name) + "</b>" + statusBadge(status(c)) + (p ? '<span class="badge">' + esc(p.name) + "</span>" : "") + "</span>" +
          '<span class="cl-svcs">' + (list.length ? list.map(function (x) { return '<i class="chip-s">' + esc((svc(x.service_id) || {}).name || "Service") + "</i>"; }).join("") : '<span class="muted">—</span>') + "</span>" +
          '<span class="cl-money"><b>' + money(monthlyOf(c)) + "</b>" + (ppl.length ? "<small>+ " + ppl.map(function (x) { return money(x.price) + "/lead"; }).join(", ") + "</small>" : "") + "</span>" +
          '<span class="cl-ads">' + (st ? (st === "live" ? '<span class="badge ok">Live</span>' : '<span class="badge warn">' + esc(EVENT[st] || st) + "</span>") : '<span class="muted">—</span>') +
          (live ? "<small>since " + esc(dateLong(live)) + "</small>" : "") +
          (nx ? "<small>" + esc(nx.kind === "paused" || nx.kind === "stopped" ? "Pausing " : "Going live ") + esc(dateLong(nx.event_date)) + "</small>" : "") + "</span>" +
          "</a>";
      }).join("");
  }

  /* ================= NEW CLIENT ================= */
  function partnerOptions(sel) {
    return '<option value="">None (direct client)</option>' + data.partners.map(function (p) {
      return '<option value="' + p.id + '"' + (p.id === sel ? " selected" : "") + ">" + esc(p.name) + "</option>";
    }).join("");
  }
  function newClient() {
    T.modal('<h2>New client</h2><div class="mgrid">' +
      fld("ncName", "Business name", '<input class="inp" id="ncName" required>', true) +
      fld("ncStatus", "Status", sel("ncStatus", STATUS.map(function (s) { return [s.id, s.label]; }), "onboarding")) +
      fld("ncStart", "Start date", '<input class="inp" type="date" id="ncStart" value="' + today() + '">') +
      fld("ncPartner", "Came through a partner?", '<select class="inp" id="ncPartner">' + partnerOptions("") + "</select>") +
      fld("ncPay", "Pays by", sel("ncPay", Object.keys(PAY).map(function (k) { return [k, PAY[k]]; }), "stripe")) +
      '<div class="fld full hidden" id="ncPartnerSvc"><label class="mchecks"><input type="checkbox" id="ncAddMgmt" checked> <span id="ncPartnerSvcLabel"></span></label></div>' +
      '</div><div class="mfoot"><button class="btn" id="mCancel">Cancel</button><button class="btn gold" id="mSave">Create client</button></div>');
    function syncPartner() {
      var p = partner($("ncPartner").value);
      $("ncPartnerSvc").classList.toggle("hidden", !p);
      if (p) {
        $("ncPartnerSvcLabel").textContent = "Add Meta Ad Management at " + money(p.default_monthly_rate) + "/mo, billed to " + p.name;
        $("ncPay").value = p.payment_method || "zelle";
      }
    }
    $("ncPartner").onchange = syncPartner;
    $("mCancel").onclick = T.closeModal;
    $("mSave").onclick = async function () {
      var name = $("ncName").value.trim();
      if (!name) { T.toast("Enter the business name"); return; }
      try {
        var c = await q(T.sb.from("clients").insert({
          business_name: name, status: $("ncStatus").value, start_date: $("ncStart").value || null,
          partner_id: $("ncPartner").value || null, payment_method: $("ncPay").value
        }).select().single());
        var p = partner(c.partner_id);
        if (p && $("ncAddMgmt").checked) {
          var mgmt = data.services.filter(function (s) { return s.name === "Meta Ad Management"; })[0];
          if (mgmt) {
            await q(T.sb.from("client_services").insert({
              client_id: c.id, service_id: mgmt.id, billing_type: "monthly", price: p.default_monthly_rate || 0,
              billed_to: "partner", start_date: c.start_date, status: "active"
            }));
          }
        }
        T.closeModal();
        location.hash = "client/" + c.id;
      } catch (e) { T.fail(e); }
    };
  }

  /* small form builders */
  function fld(id, label, control, full) { return '<div class="fld' + (full ? " full" : "") + '"><label for="' + id + '">' + esc(label) + "</label>" + control + "</div>"; }
  function sel(id, pairs, value) {
    return '<select class="inp" id="' + id + '">' + pairs.map(function (p) { return '<option value="' + esc(p[0]) + '"' + (String(p[0]) === String(value) ? " selected" : "") + ">" + esc(p[1]) + "</option>"; }).join("") + "</select>";
  }
  function inp(id, value, attrs) { return '<input class="inp" id="' + id + '" value="' + esc(value == null ? "" : value) + '"' + (attrs || "") + ">"; }

  /* ================= CLIENT PROFILE ================= */
  function renderClient(id) {
    var c = byId(data.clients, id);
    if (!c) { el.innerHTML = '<div class="cl-wrap"><a class="back" href="#clients">← Clients</a><p class="muted">Client not found.</p></div>'; return; }
    var p = partner(c.partner_id);
    var list = clientServices(c.id);
    var ppl = perLeadOf(c);
    var live = adsLiveSince(c.id), st = adsState(c.id), nx = nextScheduled(c.id);
    if (status(c) !== c.status) {   // a scheduled pause/relaunch date has arrived: store it
      c.status = status(c);
      T.sb.from("clients").update({ status: c.status }).eq("id", c.id).then(function () {});
    }

    el.innerHTML = '<div class="cl-wrap">' +
      '<a class="back" href="#clients">← Clients</a>' +
      '<div class="lead-head"><div><h1>' + esc(c.business_name) + "</h1>" +
      '<div class="sub">' + statusBadge(status(c)) + (p ? ' <a class="badge" href="#partner/' + p.id + '">via ' + esc(p.name) + "</a>" : "") +
      (c.industry ? " · " + esc(c.industry) : "") + (c.website ? " · " + T.linkify(c.website) : "") + "</div></div>" +
      '<div class="lead-actions"><button class="btn gold" id="cInvite">Website form link</button><button class="btn" id="cEdit">Edit details</button><button class="btn ghost" id="cMore">More</button></div></div>' +

      '<div class="metarow">' +
        '<div class="fld"><label for="cStatus">Status</label>' + sel("cStatus", STATUS.map(function (s) { return [s.id, s.label]; }), c.status) + "</div>" +
        '<div class="fld"><label>Monthly recurring</label><div class="metaval">' + money(monthlyOf(c)) + (ppl.length ? " <small>+ " + ppl.map(function (x) { return money(x.price) + "/lead"; }).join(", ") + "</small>" : "") + "</div></div>" +
        '<div class="fld"><label>Client since</label><div class="metaval">' + esc(dateLong(c.start_date)) + "</div></div>" +
        '<div class="fld"><label>Ads</label><div class="ads-switch">' +
          '<button class="switch' + (st === "live" ? " on" : "") + '" id="adsToggle" role="switch" aria-checked="' + (st === "live") + '" aria-label="Ads live"><i></i></button>' +
          "<span><b>" + (st === "live" ? "Live" : st ? "Paused" : "Not live yet") + "</b><small>" +
          (st === "live" ? "since " + esc(dateLong(live)) : st ? "since " + esc(dateLong((adEvents(c.id)[0] || {}).event_date)) : "") +
          (nx ? (st ? " · " : "") + (nx.kind === "paused" || nx.kind === "stopped" ? "pausing " : "going live ") + esc(dateLong(nx.event_date)) : "") +
          "</small></span></div></div>" +
      "</div>" +

      '<div class="layout"><div>' +
        servicesPanel(c, list) +
        adsPanel(c) +
      "</div><aside>" +
        detailsPanel(c, p) +
        contactsPanel(c) +
      "</aside></div></div>";
    wireClient(c);
    loadContacts(c);
  }

  function servicesPanel(c, list) {
    var rows = list.slice().sort(function (a, b) {
      var ra = a.status === "active" ? 0 : 1, rb = b.status === "active" ? 0 : 1;
      return ra - rb || ((svc(a.service_id) || {}).sort || 0) - ((svc(b.service_id) || {}).sort || 0);
    });
    return '<div class="panel"><h2>Services &amp; pricing <button class="btn sm gold" id="addSvc">+ Add service</button></h2>' +
      (rows.length ? '<div class="svc-list">' + rows.map(function (x) {
        var s = svc(x.service_id) || {};
        var dates = (x.start_date ? "From " + dateLong(x.start_date) : "") + (x.end_date ? " to " + dateLong(x.end_date) : "");
        return '<button class="svc-row' + (x.status === "active" ? "" : " off") + '" data-cs="' + x.id + '">' +
          '<span class="svc-main"><b>' + esc(s.name || "Service") + (x.tier ? " · " + esc(x.tier) : "") + "</b>" +
          "<small>" + esc(BILLING[x.billing_type]) + (x.billed_to === "partner" ? " · billed to partner" : "") + (dates ? " · " + esc(dates) : "") + (x.notes ? " · " + esc(x.notes) : "") + "</small>" +
          (x.cost != null && x.cost_partner_id ? '<small class="payout">We pay ' + esc((partner(x.cost_partner_id) || {}).name || "partner") + " " + esc(money(x.cost)) + " · margin " + esc(money(Number(x.price || 0) - Number(x.cost || 0))) + "</small>" : "") + "</span>" +
          '<span class="svc-price">' + esc(priceLabel(x)) + (x.status === "active" ? "" : '<small>' + esc(CS_STATUS[x.status]) + "</small>") + "</span></button>";
      }).join("") + "</div>" : '<p class="muted" style="font-size:14px">No services yet. Add what this client gets, at their price.</p>') +
      "</div>";
  }

  function adsPanel(c) {
    var ev = data.events.filter(function (e) { return e.client_id === c.id; });
    return '<div class="panel"><h2>Ads <span class="hbtns"><button class="btn sm" id="editAds">Edit ad setup</button><button class="btn sm" id="addEvent">+ Add past date or note</button></span></h2>' +
      '<dl class="ans"><dt>Meta ad account(s)</dt><dd>' + (c.meta_ad_account_ids && c.meta_ad_account_ids.length ? c.meta_ad_account_ids.map(esc).join(", ") : '<span class="muted">Not set. Needed to match Meta billing reports.</span>') + "</dd><span></span></dl>" +
      '<dl class="ans"><dt>Ad spend</dt><dd>' + esc(SPEND[c.ad_spend_mode] || "—") +
        ((c.ad_spend_mode === "sgs_prepaid" || c.ad_spend_mode === "sgs_partner") && (c.prepay_cadence || c.prepay_amount) ? "<br><small class='muted'>" + (c.ad_spend_mode === "sgs_partner" ? "Partner prepays " : "Client prepays ") + esc(money(c.prepay_amount)) + " " + esc((CADENCE[c.prepay_cadence] || "").toLowerCase()) + "</small>" : "") +
      "</dd><span></span></dl>" +
      '<h3 class="sub-h">Timeline</h3>' +
      (ev.length ? '<ul class="timeline">' + ev.map(function (e) {
        return '<li class="tl-' + e.kind + '"><b>' + esc(dateLong(e.event_date)) + "</b> " + esc(EVENT[e.kind] || e.kind) +
          (e.ad_account_id ? ' <span class="muted">(' + esc(e.ad_account_id) + ")</span>" : "") + (e.note ? " · " + esc(e.note) : "") +
          ' <button class="linkbtn" data-delev="' + e.id + '" aria-label="Delete">Remove</button></li>';
      }).join("") + "</ul>" : '<p class="muted" style="font-size:14px">No launches logged yet.</p>') +
      "</div>";
  }

  function detailsPanel(c, p) {
    function row(label, val) { return '<dl class="ans"><dt>' + esc(label) + "</dt><dd>" + (val || '<span class="muted">—</span>') + "</dd><span></span></dl>"; }
    return '<div class="panel"><h2>Details</h2>' +
      row("Billed", p ? "Through " + esc(p.name) + " (partner)" : "Directly") +
      row("Pays by", esc(PAY[c.payment_method] || c.payment_method)) +
      row("Address", esc(c.address)) +
      row("Stripe customer" + ((c.stripe_customer_ids || []).length > 1 ? "s" : ""), (c.stripe_customer_ids || []).map(function (id) { return '<a href="https://dashboard.stripe.com/customers/' + esc(id) + '" target="_blank" rel="noopener">' + esc(id) + "</a>"; }).join("<br>")) +
      row("GHL contact", esc(c.ghl_contact_id)) +
      (c.lead_id ? row("Website lead", '<a href="#lead/' + c.lead_id + '">Open intake</a>') : "") +
      row("Notes", c.notes ? '<span style="white-space:pre-wrap">' + esc(c.notes) + "</span>" : "") +
      "</div>";
  }

  function contactsPanel(c) {
    return '<div class="panel"><h2>Contacts <button class="btn sm gold" id="addContact">+ Add</button></h2><div id="contactList"><p class="muted">Loading...</p></div></div>';
  }

  var contacts = [];
  async function loadContacts(c) {
    try {
      contacts = await q(T.sb.from("client_contacts").select("*").eq("client_id", c.id).order("is_primary", { ascending: false }).order("created_at"));
    } catch (e) { T.fail(e); return; }
    var box = $("contactList");
    if (!box) { return; }
    box.innerHTML = contacts.length ? contacts.map(function (k) {
      return '<div class="ct">' +
        '<div class="ct-top"><b>' + esc(k.name || "Unnamed") + "</b>" + (k.is_primary ? ' <span class="badge gold">Primary</span>' : "") + (k.role ? ' <span class="muted">' + esc(k.role) + "</span>" : "") +
        '<button class="linkbtn" data-ct="' + k.id + '">Edit</button></div>' +
        (k.email ? '<a href="mailto:' + esc(k.email) + '">' + esc(k.email) + "</a>" : "") + (k.email && k.phone ? " · " : "") +
        (k.phone ? '<a href="tel:' + esc(k.phone) + '">' + esc(k.phone) + "</a>" : "") +
        (k.notes ? '<small class="muted">' + esc(k.notes) + "</small>" : "") + "</div>";
    }).join("") : '<p class="muted" style="font-size:14px">No contacts yet.</p>';
    box.querySelectorAll("[data-ct]").forEach(function (b) { b.onclick = function () { editContact(c, byId(contacts, b.dataset.ct)); }; });
  }

  function wireClient(c) {
    $("cStatus").onchange = async function (e) {
      try { await q(T.sb.from("clients").update({ status: e.target.value }).eq("id", c.id)); T.toast("Status updated"); refresh(); }
      catch (err) { T.fail(err); }
    };
    $("cEdit").onclick = function () { editClient(c); };
    $("cInvite").onclick = function () { inviteLinks(c); };
    $("cMore").onclick = function () { clientMore(c); };
    $("addSvc").onclick = function () { editService(c, null); };
    el.querySelectorAll("[data-cs]").forEach(function (b) { b.onclick = function () { editService(c, byId(data.cs, b.dataset.cs)); }; });
    $("editAds").onclick = function () { editAds(c); };
    $("adsToggle").onclick = function () { toggleAds(c); };
    $("addEvent").onclick = function () { addEvent(c); };
    el.querySelectorAll("[data-delev]").forEach(function (b) {
      b.onclick = async function () {
        if (!confirm("Remove this timeline entry?")) { return; }
        try { await q(T.sb.from("ad_events").delete().eq("id", b.dataset.delev)); refresh(); } catch (e) { T.fail(e); }
      };
    });
    $("addContact").onclick = function () { editContact(c, null); };
  }

  /* ----- edit client details ----- */
  function editClient(c) {
    T.modal("<h2>Edit details</h2><div class='mgrid'>" +
      fld("ecName", "Business name", inp("ecName", c.business_name), true) +
      fld("ecIndustry", "Industry", inp("ecIndustry", c.industry)) +
      fld("ecWebsite", "Website", inp("ecWebsite", c.website)) +
      fld("ecAddress", "Address", inp("ecAddress", c.address), true) +
      fld("ecStart", "Client since", inp("ecStart", c.start_date || "", ' type="date"')) +
      fld("ecPartner", "Partner", '<select class="inp" id="ecPartner">' + partnerOptions(c.partner_id) + "</select>") +
      fld("ecPay", "Pays by", sel("ecPay", Object.keys(PAY).map(function (k) { return [k, PAY[k]]; }), c.payment_method)) +
      fld("ecStripe", "Stripe customer ID(s)", inp("ecStripe", (c.stripe_customer_ids || []).join(", "), ' placeholder="cus_... (separate several with commas)"')) +
      fld("ecGhl", "GHL contact ID", inp("ecGhl", c.ghl_contact_id)) +
      fld("ecNotes", "Notes", '<textarea class="inp" id="ecNotes" rows="4">' + esc(c.notes) + "</textarea>", true) +
      "</div><div class='mfoot'><button class='btn' id='mCancel'>Cancel</button><button class='btn gold' id='mSave'>Save</button></div>");
    $("mCancel").onclick = T.closeModal;
    $("mSave").onclick = async function () {
      var name = $("ecName").value.trim();
      if (!name) { T.toast("Business name is required"); return; }
      try {
        await q(T.sb.from("clients").update({
          business_name: name, industry: $("ecIndustry").value.trim(), website: $("ecWebsite").value.trim(),
          address: $("ecAddress").value.trim(), start_date: $("ecStart").value || null, partner_id: $("ecPartner").value || null,
          payment_method: $("ecPay").value, stripe_customer_ids: $("ecStripe").value.split(/[,\s]+/).map(function (x) { return x.trim(); }).filter(Boolean), ghl_contact_id: $("ecGhl").value.trim(),
          notes: $("ecNotes").value
        }).eq("id", c.id));
        T.closeModal(); T.toast("Saved"); refresh();
      } catch (e) { T.fail(e); }
    };
  }

  /* ----- services: add / edit, with price history ----- */
  async function editService(c, x) {
    var p = partner(c.partner_id);
    var active = data.services.filter(function (s) { return s.active || (x && s.id === x.service_id); });
    var cur = x || { service_id: (active[0] || {}).id, billing_type: (active[0] || {}).default_billing_type, price: (active[0] || {}).default_price, tier: "", billed_to: p ? "partner" : "client", start_date: today(), end_date: null, status: "active", notes: "" };
    T.modal("<h2>" + (x ? "Edit service" : "Add service") + "</h2><div class='mgrid'>" +
      fld("esSvc", "Service", sel("esSvc", active.map(function (s) { return [s.id, s.name]; }), cur.service_id)) +
      fld("esType", "Billing", '<select class="inp" id="esType"></select>') +
      fld("esPrice", "Price", '<div class="money-in"><span>$</span><input class="inp" id="esPrice" inputmode="decimal" value="' + esc(cur.price == null ? "" : cur.price) + '"><em id="esPer"></em></div>') +
      fld("esTier", "Tier / package", '<input class="inp" id="esTier" list="esTiers" value="' + esc(cur.tier) + '" placeholder="Optional"><datalist id="esTiers"></datalist>') +
      (p ? fld("esBilled", "Billed to", sel("esBilled", [["partner", p.name + " (partner)"], ["client", "The client directly"]], cur.billed_to)) : "") +
      fld("esStatus", "Status", sel("esStatus", Object.keys(CS_STATUS).map(function (k) { return [k, CS_STATUS[k]]; }), cur.status)) +
      fld("esStart", "Start date", inp("esStart", cur.start_date || "", ' type="date"')) +
      fld("esEnd", "End date", inp("esEnd", cur.end_date || "", ' type="date"')) +
      fld("esPayP", "We pay out to", '<select class="inp" id="esPayP"><option value="">Nobody (we deliver it)</option>' + data.partners.map(function (pp) { return '<option value="' + pp.id + '"' + (pp.id === cur.cost_partner_id ? " selected" : "") + ">" + esc(pp.name) + "</option>"; }).join("") + "</select>") +
      '<div class="fld" id="esPayW"><label for="esPay">Payout amount</label><div class="money-in"><span>$</span><input class="inp" id="esPay" inputmode="decimal" value="' + esc(cur.cost == null ? "" : cur.cost) + '"><em id="esPayPer"></em></div></div>' +
      fld("esNotes", "Notes", inp("esNotes", cur.notes, ' placeholder="e.g. included in package, 2 posts/month"'), true) +
      "</div><div id='esHistory'></div>" +
      "<div class='mfoot'>" + (x ? "<button class='btn danger' id='mDel' style='margin-right:auto'>Remove</button>" : "") +
      "<button class='btn' id='mCancel'>Cancel</button><button class='btn gold' id='mSave'>Save</button></div>");

    function syncSvc(first) {
      var s = svc($("esSvc").value) || {};
      var types = (s.billing_types && s.billing_types.length ? s.billing_types : ["one_time", "monthly", "per_lead"]);
      var keep = first ? cur.billing_type : (types.indexOf($("esType").value) !== -1 ? $("esType").value : s.default_billing_type);
      if (x && x.billing_type && types.indexOf(x.billing_type) === -1) { types = types.concat([x.billing_type]); }
      $("esType").innerHTML = types.map(function (t) { return '<option value="' + t + '"' + (t === keep ? " selected" : "") + ">" + BILLING[t] + "</option>"; }).join("");
      $("esTiers").innerHTML = (s.tiers || []).map(function (t) { return '<option value="' + esc(t) + '">'; }).join("");
      if (!first && !x && s.default_price != null) { $("esPrice").value = s.default_price; }
      syncPer();
    }
    function syncPer() {
      var t = $("esType").value, per = t === "monthly" ? "/ month" : t === "per_lead" ? "/ lead" : "total";
      $("esPer").textContent = per; $("esPayPer").textContent = per;
      $("esPayW").classList.toggle("hidden", !$("esPayP").value);
    }
    $("esPayP").onchange = function () {
      if ($("esPayP").value && !$("esPay").value) { var s0 = svc($("esSvc").value) || {}; if (/video/i.test(s0.name || "")) { $("esPay").value = 600; } }
      syncPer();
    };
    $("esSvc").onchange = function () { syncSvc(false); };
    $("esType").onchange = syncPer;
    syncSvc(true);

    if (x) {
      try {
        var hist = await q(T.sb.from("client_service_price_history").select("*").eq("client_service_id", x.id).order("changed_at", { ascending: false }).limit(10));
        if (hist.length && $("esHistory")) {
          $("esHistory").innerHTML = '<h3>Price history</h3><ul class="hist">' + hist.map(function (h) {
            return "<li>" + esc(dateLong(h.changed_at.slice(0, 10))) + ": " + esc(money(h.old_price)) + " " + esc(BILLING[h.old_billing_type] || "") +
              " → <b>" + esc(money(h.new_price)) + " " + esc(BILLING[h.new_billing_type] || "") + "</b>" + (h.changed_by ? ' <span class="muted">by ' + esc(h.changed_by) + "</span>" : "") + "</li>";
          }).join("") + "</ul>";
        }
      } catch (e) { /* history is a nice-to-have */ }
    }

    $("mCancel").onclick = T.closeModal;
    if (x) {
      $("mDel").onclick = async function () {
        if (!confirm("Remove this service from the client? To keep the record, set the status to Ended instead.")) { return; }
        try { await q(T.sb.from("client_services").delete().eq("id", x.id)); T.closeModal(); refresh(); } catch (e) { T.fail(e); }
      };
    }
    $("mSave").onclick = async function () {
      var price = parseFloat(String($("esPrice").value).replace(/[$,\s]/g, ""));
      if (isNaN(price) || price < 0) { T.toast("Enter a price (0 if included)"); return; }
      var row = {
        service_id: $("esSvc").value, billing_type: $("esType").value, price: price, tier: $("esTier").value.trim(),
        billed_to: $("esBilled") ? $("esBilled").value : "client", status: $("esStatus").value,
        start_date: $("esStart").value || null, end_date: $("esEnd").value || null, notes: $("esNotes").value.trim(),
        cost_partner_id: $("esPayP").value || null,
        cost: $("esPayP").value ? (parseFloat(String($("esPay").value).replace(/[$,\s]/g, "")) || 0) : null
      };
      try {
        if (x) { await q(T.sb.from("client_services").update(row).eq("id", x.id)); }
        else { row.client_id = c.id; await q(T.sb.from("client_services").insert(row)); }
        T.closeModal(); T.toast("Saved"); refresh();
      } catch (e) { T.fail(e); }
    };
  }

  /* ----- ads ----- */
  function editAds(c) {
    T.modal("<h2>Ad setup</h2><div class='mgrid'>" +
      fld("eaAcct", "Meta ad account ID(s)", inp("eaAcct", (c.meta_ad_account_ids || []).join(", "), ' placeholder="e.g. 1603428494246121"'), true) +
      '<p class="muted full" style="font-size:12px;margin-top:-6px">In Ads Manager or on the billing report ("Account: …"). Separate several with commas.</p>' +
      fld("eaMode", "Who pays Meta?", sel("eaMode", Object.keys(SPEND).map(function (k) { return [k, SPEND[k]]; }), c.ad_spend_mode), true) +
      '<div class="fld" id="eaCadW">' + '<label for="eaCad">Client prepays</label>' + sel("eaCad", Object.keys(CADENCE).map(function (k) { return [k, CADENCE[k]]; }), c.prepay_cadence) + "</div>" +
      '<div class="fld" id="eaAmtW"><label for="eaAmt">Prepay amount</label><div class="money-in"><span>$</span><input class="inp" id="eaAmt" inputmode="decimal" value="' + esc(c.prepay_amount == null ? "" : c.prepay_amount) + '"></div></div>' +
      "</div><div class='mfoot'><button class='btn' id='mCancel'>Cancel</button><button class='btn gold' id='mSave'>Save</button></div>");
    function sync() { var on = $("eaMode").value === "sgs_prepaid" || $("eaMode").value === "sgs_partner"; $("eaCadW").classList.toggle("hidden", !on); $("eaAmtW").classList.toggle("hidden", !on); $("eaCadW").querySelector("label").textContent = $("eaMode").value === "sgs_partner" ? "Partner prepays" : "Client prepays"; }
    $("eaMode").onchange = sync; sync();
    $("mCancel").onclick = T.closeModal;
    $("mSave").onclick = async function () {
      var ids = $("eaAcct").value.split(/[,\s]+/).map(function (s) { return s.replace(/^act_/, "").trim(); }).filter(Boolean);
      var mode = $("eaMode").value;
      var amt = parseFloat(String($("eaAmt").value).replace(/[$,\s]/g, ""));
      try {
        await q(T.sb.from("clients").update({
          meta_ad_account_ids: ids, ad_spend_mode: mode,
          prepay_cadence: mode === "sgs_prepaid" || mode === "sgs_partner" ? $("eaCad").value : "",
          prepay_amount: (mode === "sgs_prepaid" || mode === "sgs_partner") && !isNaN(amt) ? amt : null
        }).eq("id", c.id));
        T.closeModal(); T.toast("Saved"); refresh();
      } catch (e) { T.fail(e); }
    };
  }

  // Flip ads live/paused on a date (today by default; future dates are scheduled).
  function toggleAds(c) {
    var goingLive = adsState(c.id) !== "live";
    var everLaunched = data.events.some(function (e) { return e.client_id === c.id && (e.kind === "launched" || e.kind === "relaunched"); });
    var kind = goingLive ? (everLaunched ? "relaunched" : "launched") : "paused";
    T.modal("<h2>" + (goingLive ? "Turn ads on" : "Pause ads") + "</h2><div class='mgrid'>" +
      fld("tgDate", goingLive ? "Ads go live on" : "Ads pause on", inp("tgDate", today(), ' type="date"')) +
      fld("tgNote", "Note", inp("tgNote", "", ' placeholder="Optional, e.g. ' + (goingLive ? "new creative, $50/day" : "client asked to pause for the winter") + '"')) +
      "<p class='muted full' style='font-size:12px'>" + (goingLive
        ? "Marks " + esc(c.business_name) + " as Active on that date."
        : "Marks " + esc(c.business_name) + " as Paused on that date. Pick a future date to schedule it.") + "</p>" +
      "</div><div class='mfoot'><button class='btn' id='mCancel'>Cancel</button><button class='btn gold' id='mSave'>" + (goingLive ? "Turn on" : "Pause") + "</button></div>");
    $("mCancel").onclick = T.closeModal;
    $("mSave").onclick = async function () {
      var d = $("tgDate").value;
      if (!d) { T.toast("Pick a date"); return; }
      try {
        await q(T.sb.from("ad_events").insert({ client_id: c.id, kind: kind, event_date: d, ad_account_id: (c.meta_ad_account_ids || [])[0] || "", note: $("tgNote").value.trim() }));
        if (d <= today() && c.status !== "churned") {
          await q(T.sb.from("clients").update({ status: goingLive ? "active" : "paused" }).eq("id", c.id));
        }
        T.closeModal(); T.toast(d <= today() ? (goingLive ? "Ads are live" : "Ads paused") : "Scheduled for " + dateLong(d)); refresh();
      } catch (e) { T.fail(e); }
    };
  }

  function addEvent(c) {
    var accts = c.meta_ad_account_ids || [];
    T.modal("<h2>Log ad launch or change</h2><div class='mgrid'>" +
      fld("aeKind", "What happened", sel("aeKind", Object.keys(EVENT).map(function (k) { return [k, EVENT[k]]; }), "note")) +
      fld("aeDate", "Date", inp("aeDate", today(), ' type="date"')) +
      (accts.length > 1 ? fld("aeAcct", "Ad account", sel("aeAcct", [["", "All / not specific"]].concat(accts.map(function (a) { return [a, a]; })), "")) : "") +
      fld("aeNote", "Note", inp("aeNote", "", ' placeholder="Optional, e.g. new creative, budget $50/day"'), true) +
      "</div><div class='mfoot'><button class='btn' id='mCancel'>Cancel</button><button class='btn gold' id='mSave'>Save</button></div>");
    $("mCancel").onclick = T.closeModal;
    $("mSave").onclick = async function () {
      if (!$("aeDate").value) { T.toast("Pick a date"); return; }
      try {
        await q(T.sb.from("ad_events").insert({
          client_id: c.id, kind: $("aeKind").value, event_date: $("aeDate").value,
          ad_account_id: $("aeAcct") ? $("aeAcct").value : (accts[0] || ""), note: $("aeNote").value.trim()
        }));
        var k = $("aeKind").value;
        if (k !== "note" && $("aeDate").value <= today() && c.status !== "churned") {
          var willBe = (k === "launched" || k === "relaunched") ? "active" : "paused";
          var latest = adEvents(c.id)[0];
          if (!latest || latest.event_date <= $("aeDate").value) {
            await q(T.sb.from("clients").update({ status: willBe }).eq("id", c.id));
          }
        }
        T.closeModal(); refresh();
      } catch (e) { T.fail(e); }
    };
  }

  /* ----- contacts ----- */
  function editContact(c, k) {
    var cur = k || { name: "", role: "", email: "", phone: "", is_primary: !contacts.length, notes: "" };
    T.modal("<h2>" + (k ? "Edit contact" : "Add contact") + "</h2><div class='mgrid'>" +
      fld("ctName", "Name", inp("ctName", cur.name)) +
      fld("ctRole", "Role", inp("ctRole", cur.role, ' list="ctRoles" placeholder="Owner, office manager, billing..."') + '<datalist id="ctRoles"><option value="Owner"><option value="Office manager"><option value="Billing"><option value="Marketing"></datalist>') +
      fld("ctEmail", "Email", inp("ctEmail", cur.email, ' type="email"')) +
      fld("ctPhone", "Phone", inp("ctPhone", cur.phone, ' type="tel"')) +
      fld("ctNotes", "Notes", inp("ctNotes", cur.notes), true) +
      '<div class="fld full mchecks"><label><input type="checkbox" id="ctPrimary"' + (cur.is_primary ? " checked" : "") + "> Primary contact</label></div>" +
      "</div><div class='mfoot'>" + (k ? "<button class='btn danger' id='mDel' style='margin-right:auto'>Delete</button>" : "") +
      "<button class='btn' id='mCancel'>Cancel</button><button class='btn gold' id='mSave'>Save</button></div>");
    $("mCancel").onclick = T.closeModal;
    if (k) {
      $("mDel").onclick = async function () {
        if (!confirm("Delete this contact?")) { return; }
        try { await q(T.sb.from("client_contacts").delete().eq("id", k.id)); T.closeModal(); loadContacts(c); } catch (e) { T.fail(e); }
      };
    }
    $("mSave").onclick = async function () {
      var row = { name: $("ctName").value.trim(), role: $("ctRole").value.trim(), email: $("ctEmail").value.trim(), phone: $("ctPhone").value.trim(), notes: $("ctNotes").value.trim(), is_primary: $("ctPrimary").checked };
      if (!row.name && !row.email && !row.phone) { T.toast("Add a name, email or phone"); return; }
      try {
        if (row.is_primary) { await q(T.sb.from("client_contacts").update({ is_primary: false }).eq("client_id", c.id)); }
        if (k) { await q(T.sb.from("client_contacts").update(row).eq("id", k.id)); }
        else { row.client_id = c.id; await q(T.sb.from("client_contacts").insert(row)); }
        T.closeModal(); loadContacts(c);
      } catch (e) { T.fail(e); }
    };
  }

  /* ----- private website intake links (skip the short form + booking) ----- */
  var INTAKE_URL = "https://websites.solidgoldsystems.com/intake/";
  function newToken() {
    var b = new Uint8Array(24); crypto.getRandomValues(b);
    return btoa(String.fromCharCode.apply(null, b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  async function inviteLinks(c) {
    var list = [];
    try { list = await q(T.sb.from("intake_invites").select("*").eq("client_id", c.id).order("created_at", { ascending: false }).limit(10)); }
    catch (e) { T.fail(e); return; }
    var now = new Date();
    var open = list.filter(function (i) { return !i.used_at && new Date(i.expires_at) > now; })[0];
    function stateOf(i) {
      if (i.used_at) { return '<span class="badge ok">Submitted ' + esc(dateLong(i.used_at.slice(0, 10))) + "</span>" + (i.lead_id ? ' <a href="#lead/' + i.lead_id + '">Open lead</a>' : ""); }
      if (new Date(i.expires_at) < now) { return '<span class="badge">Expired</span>'; }
      return '<span class="badge gold">Open until ' + esc(dateLong(i.expires_at.slice(0, 10))) + "</span>";
    }
    T.modal("<h2>Website form link</h2>" +
      "<p class='muted' style='font-size:14px;margin-bottom:12px'>A private link that takes " + esc(c.business_name) + " straight to the detailed website form, skipping the short form and booking. It works once and expires after 14 days. Their info is pre-filled, and the submission lands in Website Leads linked to this client.</p>" +
      (open ? "<div class='inv-link'><p>Current link:</p><div class='addfiles'><input class='inp' readonly id='ivUrl' value='" + esc(INTAKE_URL + "?invite=" + open.token) + "'><button class='btn' id='ivCopy'>Copy link</button></div>" +
        "<div class='addfiles' style='margin-top:8px'><a class='btn sm' id='ivText'>Text it</a><a class='btn sm' id='ivMail'>Email it</a></div></div>" : "") +
      (list.length ? "<h3>Links sent</h3><ul class='hist'>" + list.map(function (i) { return "<li>" + esc(dateLong(i.created_at.slice(0, 10))) + (i.created_by ? " by " + esc(i.created_by) : "") + " · " + stateOf(i) + "</li>"; }).join("") + "</ul>" : "") +
      "<div class='mfoot'><button class='btn' id='mCancel'>Close</button><button class='btn gold' id='ivNew'>" + (open ? "Make a new link" : "Create link") + "</button></div>");
    $("mCancel").onclick = T.closeModal;
    if (open) {
      var url = INTAKE_URL + "?invite=" + open.token;
      var first = "";
      try { var ct = (await q(T.sb.from("client_contacts").select("*").eq("client_id", c.id).order("is_primary", { ascending: false }).limit(1)))[0] || {}; first = (ct.name || "").split(" ")[0]; var ph = ct.phone || "", em = ct.email || ""; } catch (e) { /* optional */ }
      var msg = "Hi" + (first ? " " + first : "") + "! Here's your private link to send us everything for your new website (logo, photos, services). It takes about 10 minutes: " + url;
      $("ivCopy").onclick = function () { T.copyText(url); };
      $("ivText").href = "sms:" + (ph || "") + "?&body=" + encodeURIComponent(msg);
      $("ivMail").href = "mailto:" + (em || "") + "?subject=" + encodeURIComponent("Your website form") + "&body=" + encodeURIComponent(msg);
    }
    $("ivNew").onclick = async function () {
      try {
        if (open) { await q(T.sb.from("intake_invites").update({ expires_at: new Date().toISOString() }).eq("id", open.id)); }
        var me = await T.sb.auth.getUser();
        await q(T.sb.from("intake_invites").insert({ token: newToken(), client_id: c.id, created_by: (me.data && me.data.user && me.data.user.email) || "" }));
        T.toast(open ? "New link created; the old one no longer works" : "Link created");
        inviteLinks(c);
      } catch (e) { T.fail(e); }
    };
  }

  function clientMore(c) {
    T.modal("<h2>More</h2><p class='muted' style='font-size:14px;margin-bottom:14px'>Client ID " + esc(c.id) + "</p>" +
      "<div style='display:flex;flex-direction:column;gap:10px;align-items:flex-start'>" +
      "<button class='btn danger' id='cmDel'>Delete this client and all its records</button></div>" +
      "<p class='muted' style='font-size:12px;margin-top:10px'>To keep history, set the status to Churned instead of deleting.</p>" +
      "<div class='mfoot'><button class='btn' id='mCancel'>Close</button></div>");
    $("mCancel").onclick = T.closeModal;
    $("cmDel").onclick = async function () {
      if (!confirm("Delete " + c.business_name + "? Contacts, services and the ad timeline are deleted too. This can't be undone.")) { return; }
      try { await q(T.sb.from("clients").delete().eq("id", c.id)); T.closeModal(); T.toast("Client deleted"); location.hash = "clients"; } catch (e) { T.fail(e); }
    };
  }

  /* ================= PARTNER PAGE ================= */
  function renderPartner(id) {
    var p = partner(id);
    if (!p) { el.innerHTML = '<div class="cl-wrap"><a class="back" href="#clients">← Clients</a><p class="muted">Partner not found.</p></div>'; return; }
    var theirs = data.clients.filter(function (c) { return c.partner_id === p.id; });
    var owed = theirs.filter(function (c) { return status(c) !== "churned" && status(c) !== "paused"; }).reduce(function (s, c) {
      return s + clientServices(c.id).filter(function (x) { return x.status === "active" && x.billed_to === "partner" && x.billing_type === "monthly"; })
        .reduce(function (t, x) { return t + Number(x.price || 0); }, 0);
    }, 0);
    var payouts = data.cs.filter(function (x) { return x.cost_partner_id === p.id && x.cost != null; });
    var payMonthly = payouts.filter(function (x) { var cl = byId(data.clients, x.client_id); return x.status === "active" && x.billing_type === "monthly" && cl && status(cl) !== "churned" && status(cl) !== "paused"; })
      .reduce(function (s, x) { return s + Number(x.cost || 0); }, 0);
    el.innerHTML = '<div class="cl-wrap"><a class="back" href="#clients">← Clients</a>' +
      '<div class="lead-head"><div><h1>' + esc(p.name) + '</h1><div class="sub">Partner · pays by ' + esc(PAY[p.payment_method] || p.payment_method) + "</div></div>" +
      '<div class="lead-actions"><button class="btn" id="pEdit">Edit partner</button></div></div>' +
      '<div class="stats">' + stat("Clients", theirs.filter(function (c) { return status(c) !== "churned"; }).length) + stat("Expected per month", money(owed)) + stat("Default rate", money(p.default_monthly_rate) + "/client") + stat("We pay them / month", money(payMonthly)) + "</div>" +
      '<div class="panel"><h2>Clients</h2>' +
      (theirs.length ? theirs.map(function (c) {
        var mine = clientServices(c.id).filter(function (x) { return x.status === "active"; });
        var toPartner = mine.filter(function (x) { return x.billed_to === "partner" && x.billing_type === "monthly"; }).reduce(function (s, x) { return s + Number(x.price || 0); }, 0);
        var direct = mine.filter(function (x) { return x.billed_to === "client"; });
        return '<a class="cl-row p-row" href="#client/' + c.id + '"><span class="cl-name"><b>' + esc(c.business_name) + "</b>" + statusBadge(status(c)) + "</span>" +
          '<span class="cl-money"><b>' + money(toPartner) + "/mo</b><small>from " + esc(p.name) + "</small></span>" +
          '<span class="cl-money">' + (direct.length ? "<b>" + direct.length + " upsell" + (direct.length > 1 ? "s" : "") + "</b><small>billed to client</small>" : '<span class="muted">—</span>') + "</span></a>";
      }).join("") : '<p class="muted" style="font-size:14px">No clients linked yet. Pick this partner when creating or editing a client.</p>') +
      "</div>" +
      '<div class="panel"><h2>We pay ' + esc(p.name) + "</h2>" +
      (payouts.length ? payouts.map(function (x) {
        var cl = byId(data.clients, x.client_id) || {}, s0 = svc(x.service_id) || {};
        return '<a class="svc-row' + (x.status === "active" ? "" : " off") + '" href="#client/' + cl.id + '"><span class="svc-main"><b>' + esc(cl.business_name || "") + "</b><small>" + esc(s0.name || "") + " · " + esc(BILLING[x.billing_type]) + (x.status === "active" ? "" : " · " + esc(CS_STATUS[x.status])) + "</small></span>" +
          '<span class="svc-price">' + esc(money(x.cost)) + (x.billing_type === "monthly" ? "/mo" : "") + "</span></a>";
      }).join("") : '<p class="muted" style="font-size:14px">Nothing yet. On a service (e.g. a video shoot), set "We pay out to" ' + esc(p.name) + ".</p>") + "</div>" +
      '<div class="panel"><h2>Details</h2>' +
      '<dl class="ans"><dt>Contact</dt><dd>' + esc([p.contact_name, p.email, p.phone].filter(Boolean).join(" · ") || "—") + "</dd><span></span></dl>" +
      '<dl class="ans"><dt>Stripe name suffix</dt><dd>' + (p.stripe_suffix ? "Customers named “Client - " + esc(p.stripe_suffix) + "”" : "—") + "</dd><span></span></dl>" +
      '<dl class="ans"><dt>Notes</dt><dd style="white-space:pre-wrap">' + esc(p.notes || "—") + "</dd><span></span></dl></div></div>";
    $("pEdit").onclick = function () { editPartner(p); };
  }

  function editPartner(p) {
    var cur = p || { name: "", stripe_suffix: "", contact_name: "", email: "", phone: "", default_monthly_rate: 600, payment_method: "zelle", notes: "" };
    T.modal("<h2>" + (p ? "Edit partner" : "Add partner") + "</h2><div class='mgrid'>" +
      fld("ptName", "Partner name", inp("ptName", cur.name)) +
      fld("ptSuffix", "Name used in Stripe", inp("ptSuffix", cur.stripe_suffix, ' placeholder="e.g. 633 Studios"')) +
      fld("ptContact", "Contact name", inp("ptContact", cur.contact_name)) +
      fld("ptEmail", "Email", inp("ptEmail", cur.email, ' type="email"')) +
      fld("ptPhone", "Phone", inp("ptPhone", cur.phone, ' type="tel"')) +
      fld("ptRate", "Default monthly rate per client", '<div class="money-in"><span>$</span><input class="inp" id="ptRate" inputmode="decimal" value="' + esc(cur.default_monthly_rate) + '"></div>') +
      fld("ptPay", "Pays by", sel("ptPay", Object.keys(PAY).map(function (k) { return [k, PAY[k]]; }), cur.payment_method)) +
      fld("ptNotes", "Notes", '<textarea class="inp" id="ptNotes" rows="3">' + esc(cur.notes) + "</textarea>", true) +
      "</div><div class='mfoot'><button class='btn' id='mCancel'>Cancel</button><button class='btn gold' id='mSave'>Save</button></div>");
    $("mCancel").onclick = T.closeModal;
    $("mSave").onclick = async function () {
      var row = {
        name: $("ptName").value.trim(), stripe_suffix: $("ptSuffix").value.trim(), contact_name: $("ptContact").value.trim(),
        email: $("ptEmail").value.trim(), phone: $("ptPhone").value.trim(), payment_method: $("ptPay").value, notes: $("ptNotes").value,
        default_monthly_rate: parseFloat(String($("ptRate").value).replace(/[$,\s]/g, "")) || 0
      };
      if (!row.name) { T.toast("Enter the partner's name"); return; }
      try {
        if (p) { await q(T.sb.from("partners").update(row).eq("id", p.id)); }
        else { await q(T.sb.from("partners").insert(row)); }
        T.closeModal(); T.toast("Saved");
        if (location.hash === "#settings") { renderSettings($("settingsExtra")); } else { refresh(); }
      } catch (e) { T.fail(e); }
    };
  }

  /* ================= SETTINGS: services catalog + partners ================= */
  async function renderSettings(box) {
    if (!box) { return; }
    try {
      var res = await Promise.all([q(T.sb.from("services").select("*").order("sort")), q(T.sb.from("partners").select("*").order("name"))]);
      data.services = res[0]; data.partners = res[1];
    } catch (e) { box.innerHTML = ""; return; }
    box.innerHTML =
      '<div class="panel"><h2>Services catalog <button class="btn sm gold" id="svcAdd">+ Add service</button></h2>' +
      '<p class="muted" style="font-size:13px;margin-bottom:8px">The list you pick from on each client. Default prices only pre-fill; each client keeps their own price.</p>' +
      data.services.map(function (s) {
        return '<button class="svc-row' + (s.active ? "" : " off") + '" data-svc="' + s.id + '"><span class="svc-main"><b>' + esc(s.name) + "</b><small>" +
          esc(s.billing_types.map(function (t) { return BILLING[t]; }).join(" / ")) + (s.tiers.length ? " · tiers: " + esc(s.tiers.join(", ")) : "") + (s.active ? "" : " · hidden") + "</small></span>" +
          '<span class="svc-price">' + (s.default_price != null ? esc(money(s.default_price)) : '<span class="muted">No default</span>') + "</span></button>";
      }).join("") + "</div>" +
      '<div class="panel"><h2>Partners <button class="btn sm gold" id="ptAdd">+ Add partner</button></h2>' +
      (data.partners.length ? data.partners.map(function (p) {
        return '<a class="svc-row" href="#partner/' + p.id + '"><span class="svc-main"><b>' + esc(p.name) + "</b><small>Pays by " + esc(PAY[p.payment_method] || p.payment_method) + "</small></span>" +
          '<span class="svc-price">' + esc(money(p.default_monthly_rate)) + "/client</span></a>";
      }).join("") : '<p class="muted">No partners yet.</p>') + "</div>";
    $("svcAdd").onclick = function () { editCatalog(null); };
    $("ptAdd").onclick = function () { editPartner(null); };
    box.querySelectorAll("[data-svc]").forEach(function (b) { b.onclick = function () { editCatalog(byId(data.services, b.dataset.svc)); }; });
  }

  function editCatalog(s) {
    var cur = s || { name: "", description: "", billing_types: ["one_time"], default_billing_type: "one_time", default_price: null, tiers: [], active: true, sort: (data.services.length + 1) * 10 };
    T.modal("<h2>" + (s ? "Edit service" : "Add service") + "</h2><div class='mgrid'>" +
      fld("scName", "Name", inp("scName", cur.name), true) +
      fld("scDesc", "Description", inp("scDesc", cur.description), true) +
      '<div class="fld full"><span class="lbl">Can be billed</span><div class="mchecks">' + Object.keys(BILLING).map(function (t) {
        return '<label><input type="checkbox" class="scType" value="' + t + '"' + (cur.billing_types.indexOf(t) !== -1 ? " checked" : "") + "> " + BILLING[t] + "</label>";
      }).join("") + "</div></div>" +
      fld("scDefType", "Default billing", sel("scDefType", Object.keys(BILLING).map(function (k) { return [k, BILLING[k]]; }), cur.default_billing_type)) +
      fld("scPrice", "Default price", '<div class="money-in"><span>$</span><input class="inp" id="scPrice" inputmode="decimal" value="' + esc(cur.default_price == null ? "" : cur.default_price) + '" placeholder="Optional"></div>') +
      fld("scTiers", "Tiers / packages", inp("scTiers", cur.tiers.join(", "), ' placeholder="Optional, comma separated: Basic, Growth, Pro"'), true) +
      '<div class="fld full mchecks"><label><input type="checkbox" id="scActive"' + (cur.active ? " checked" : "") + "> Show when adding services to clients</label></div>" +
      "</div><div class='mfoot'><button class='btn' id='mCancel'>Cancel</button><button class='btn gold' id='mSave'>Save</button></div>");
    $("mCancel").onclick = T.closeModal;
    $("mSave").onclick = async function () {
      var types = Array.prototype.map.call(document.querySelectorAll(".scType:checked"), function (x) { return x.value; });
      var def = $("scDefType").value;
      if (!$("scName").value.trim()) { T.toast("Enter a name"); return; }
      if (!types.length) { T.toast("Pick at least one billing option"); return; }
      if (types.indexOf(def) === -1) { def = types[0]; }
      var price = parseFloat(String($("scPrice").value).replace(/[$,\s]/g, ""));
      var row = {
        name: $("scName").value.trim(), description: $("scDesc").value.trim(), billing_types: types, default_billing_type: def,
        default_price: isNaN(price) ? null : price, tiers: $("scTiers").value.split(",").map(function (t) { return t.trim(); }).filter(Boolean),
        active: $("scActive").checked
      };
      try {
        if (s) { await q(T.sb.from("services").update(row).eq("id", s.id)); }
        else { row.sort = cur.sort; await q(T.sb.from("services").insert(row)); }
        T.closeModal(); T.toast("Saved"); renderSettings($("settingsExtra"));
      } catch (e) { T.fail(e); }
    };
  }

  /* ================= WEBSITE LEAD -> CLIENT ================= */
  async function convertLead(lead) {
    if (lead.client_id) { T.toast("This lead already belongs to a client"); location.hash = "client/" + lead.client_id; return; }
    try {
      var existing = await q(T.sb.from("clients").select("id").eq("lead_id", lead.id).limit(1));
      if (existing.length) { T.toast("Already a client. Opening it."); location.hash = "client/" + existing[0].id; return; }
      var a = lead.answers || {};
      var c = await q(T.sb.from("clients").insert({
        business_name: lead.business_name || a.business_name || "New client",
        status: "onboarding", start_date: today(), industry: a.lp_industry || "",
        website: a.current_website || a.lp_website_url || "", address: a.business_address || "",
        ghl_contact_id: lead.ghl_contact_id || "", lead_id: lead.id,
        notes: lead.draft_url ? "Draft site: " + lead.draft_url : ""
      }).select().single());
      if (lead.contact_name || lead.email || lead.phone) {
        await q(T.sb.from("client_contacts").insert({ client_id: c.id, name: lead.contact_name || "", role: "Owner", email: lead.email || "", phone: lead.phone || "", is_primary: true }));
      }
      var services = await q(T.sb.from("services").select("*"));
      var build = services.filter(function (s) { return s.name === "Website Build"; })[0];
      if (build) {
        await q(T.sb.from("client_services").insert({ client_id: c.id, service_id: build.id, billing_type: "one_time", price: build.default_price || 0, start_date: today(), status: "active" }));
      }
      if (lead.stage !== "closed") { await T.sb.from("leads").update({ stage: "closed" }).eq("id", lead.id); }
      T.toast("Client created");
      location.hash = "client/" + c.id;
    } catch (e) { T.fail(e); }
  }

  window.SGSClients = {
    init: function (helpers) { T = helpers; },
    route: route,
    renderSettings: renderSettings,
    convertLead: convertLead
  };
})();
