/* Solid Gold Systems Tracker - Client Leads tab (#adleads, #adleads/<client id>, #adleads/unmatched)
   Every lead from Meta instant forms (public.meta_leads, synced each morning by meta-sync),
   grouped by client, with the lead's details and form answers. Ad spend comes from the daily
   numbers in public.meta_daily. Each client can be sent a branded PDF report for any dates. */
(function () {
  "use strict";
  var T = null;
  var RANGES = [["7", "Last 7 days"], ["month", "This month"], ["30", "Last 30 days"], ["year", "This year"], ["all", "All time"], ["custom", "Custom"]];
  var view = { range: "month", from: "", to: "", q: "" };
  var d = null, el = null;
  var SGS = (window.SGS_CONFIG && window.SGS_CONFIG.sgsMeta) || { adAccounts: [], pages: [] };
  var sgsView = { by: "campaign", sort: "spend" };
  // SGS's own leads (not tied to a client) live on the SGS Leads tab, not under "not matched".
  function isSgs(l) { return l.is_sgs === true || !l.client_id && (SGS.pages.indexOf(l.page_id) !== -1 || SGS.adAccounts.indexOf(l.ad_account_id) !== -1); }

  function esc(s) { return T.esc(s); }
  function $(id) { return document.getElementById(id); }
  async function q(p) { var r = await p; if (r.error) { throw r.error; } return r.data; }
  async function all(make) {
    var out = [];
    for (var from = 0; from < 50000; from += 1000) {
      var rows = await q(make().range(from, from + 999));
      out = out.concat(rows);
      if (rows.length < 1000) { break; }
    }
    return out;
  }
  function ymd(x) { return x.getFullYear() + "-" + String(x.getMonth() + 1).padStart(2, "0") + "-" + String(x.getDate()).padStart(2, "0"); }
  function money(n) { var v = Number(n || 0); return "$" + v.toLocaleString("en-US", { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 }); }
  function money2(n) { return "$" + Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function when(iso) {
    var t = new Date(iso);
    return t.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + " · " + t.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  }
  function longDate(day) { return new Date(day + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); }
  function today() { return ymd(new Date()); }

  /* The window being looked at, as [from, to] calendar days (inclusive). */
  function windowDays() {
    var now = new Date();
    if (view.range === "month") { return [ymd(new Date(now.getFullYear(), now.getMonth(), 1)), today()]; }
    if (view.range === "7") { return [ymd(new Date(Date.now() - 6 * 864e5)), today()]; }
    if (view.range === "30") { return [ymd(new Date(Date.now() - 29 * 864e5)), today()]; }
    if (view.range === "year") { return [now.getFullYear() + "-01-01", today()]; }
    if (view.range === "custom") {
      var f = view.from || ymd(new Date(now.getFullYear(), now.getMonth(), 1)), t = view.to || today();
      return f <= t ? [f, t] : [t, f];
    }
    return ["0000-01-01", "9999-12-31"];
  }
  function between(day, w) { day = String(day).slice(0, 10); return day >= w[0] && day <= w[1]; }
  function localDay(iso) { return ymd(new Date(iso)); }
  function phone(p) {
    var x = String(p || "").replace(/\D/g, "");
    if (x.length === 11 && x[0] === "1") { x = x.slice(1); }
    return x.length === 10 ? "(" + x.slice(0, 3) + ") " + x.slice(3, 6) + "-" + x.slice(6) : (p || "");
  }
  function prettyField(name) { return String(name || "").replace(/_/g, " ").replace(/\?$/, "").replace(/^\w/, function (c) { return c.toUpperCase(); }); }

  async function load(withAds) {
    var res = await Promise.all([
      q(T.sb.from("clients").select("id,business_name,status,meta_ad_account_ids").order("business_name")),
      all(function () { return T.sb.from("meta_leads").select("*").order("created_time", { ascending: false }).order("id"); }),
      all(function () { return T.sb.from("meta_daily").select("ad_account_id,day,spend,leads").order("day").order("ad_account_id"); }),
      q(T.sb.from("meta_pages").select("*")),
      q(T.sb.from("meta_sync_runs").select("started_at,ok,message").order("started_at", { ascending: false }).limit(1)),
      all(function () { return T.sb.from("ghl_contacts").select("*").or("is_sgs.eq.true,client_id.not.is.null").order("date_added", { ascending: false }).order("id"); }).catch(function () { return []; }),
      withAds ? all(function () { return T.sb.from("meta_ad_daily").select("*").in("ad_account_id", SGS.adAccounts).order("day").order("ad_id"); }).catch(function () { return []; }) : Promise.resolve([])
    ]);
    d = { clients: res[0], leads: mergeGhl(res[1], res[5]), daily: res[2], pages: res[3], run: res[4][0] || null, ads: res[6] };
  }

  /* GHL leads: the same person from a Meta lead form gets their GHL pipeline stage; everyone else
     (website forms, funnels, leads older than Meta's 90 days) is added as a lead of their own. */
  function mergeGhl(meta, ghl) {
    var byFb = {};
    meta.forEach(function (l) { byFb[l.id] = l; });
    var out = meta.slice();
    (ghl || []).forEach(function (g) {
      var m = g.facebook_lead_id && byFb[g.facebook_lead_id];
      if (m) { m.stage = g.stage_name; m.pipeline = g.pipeline_name; m.ghl_id = g.id; if (g.is_sgs && !m.client_id) { m.is_sgs = true; } return; }
      var fields = (g.custom || []).map(function (f) { return { name: f.name || "Answer", values: f.values }; });
      if (g.company) { fields.unshift({ name: "Business", values: [g.company] }); }
      if (g.landing_url) { fields.push({ name: "Landing page", values: [g.landing_url] }); }
      if (g.source || g.session_source) { fields.push({ name: "Source", values: [[g.source, g.session_source].filter(Boolean).join(" · ")] }); }
      out.push({
        id: "ghl:" + g.id, ghl_id: g.id, created_time: g.date_added, client_id: g.client_id, is_sgs: g.is_sgs, ad_account_id: g.ad_account_id,
        page_id: "", form_id: "", form_name: g.form_name || g.source || "Website form", ad_id: g.ad_id, ad_name: g.ad_name, adset_name: "",
        campaign_name: g.campaign_name, is_organic: false,
        platform: g.facebook_lead_id ? "fb" : "web", name: g.name, email: g.email, phone: g.phone, fields: fields,
        stage: g.stage_name, pipeline: g.pipeline_name, fromGhl: true
      });
    });
    return out.sort(function (a, b) { return a.created_time < b.created_time ? 1 : a.created_time > b.created_time ? -1 : 0; });
  }
  function stageClass(s) {
    s = String(s || "").toLowerCase();
    if (/sold|closed|won|client/.test(s)) { return "won"; }
    if (/booked|showed|appointment/.test(s)) { return "booked"; }
    if (/not interested|lost|no show|dead/.test(s)) { return "lost"; }
    return "open";
  }
  function isBooked(l) { var c = stageClass(l.stage); return c === "booked" || c === "won"; }

  /* Leads, spend and Meta's own lead count for one client (or unmatched leads) in window w. */
  function statsFor(c, w) {
    w = w || windowDays();
    var accts = c ? (c.meta_ad_account_ids || []) : [];
    var leads = d.leads.filter(function (l) { return c ? l.client_id === c.id : !l.client_id && !isSgs(l); });
    var r = leads.filter(function (l) { return between(localDay(l.created_time), w); });
    var spend = 0, metaCount = 0, byDay = {};
    d.daily.forEach(function (x) {
      if (accts.indexOf(x.ad_account_id) !== -1 && between(x.day, w)) {
        spend += Number(x.spend || 0); metaCount += Number(x.leads || 0);
        var b = byDay[x.day] || (byDay[x.day] = { spend: 0, meta: 0 });
        b.spend += Number(x.spend || 0); b.meta += Number(x.leads || 0);
      }
    });
    // Meta's count also includes leads from website forms, which aren't listed here.
    var total = Math.max(r.length, metaCount);
    return { all: leads, inRange: r, spend: spend, metaCount: metaCount, total: total, cpl: total && spend ? spend / total : null, byDay: byDay, last: leads[0] ? leads[0].created_time : null };
  }

  async function route(hash, container) {
    el = container;
    // Client Leads and SGS Leads share element ids; keep only the one on screen in the page.
    ["adLeadsView", "sgsView"].forEach(function (id) { var v = $(id); if (v && v !== container) { v.innerHTML = ""; } });
    el.innerHTML = '<p class="muted" style="padding:24px">Loading...</p>';
    var sgs = /^#sgs/.test(hash);
    try { await load(sgs); } catch (e) { T.fail(e); el.innerHTML = '<p class="muted" style="padding:24px">' + esc(e.message) + "</p>"; return; }
    if (sgs) { drawSgs(); return; }
    var m = String(hash).match(/^#adleads\/([0-9a-f-]{36}|unmatched)/);
    if (m) { drawClient(m[1]); } else { drawList(); }
  }

  function rangeBar() {
    var w = windowDays();
    return '<div class="al-range"><div class="seg" role="group" aria-label="Date range">' + RANGES.map(function (r) {
      return '<button class="seg-b' + (view.range === r[0] ? " on" : "") + '" data-range="' + r[0] + '">' + r[1] + "</button>";
    }).join("") + "</div>" +
      (view.range === "custom" ? '<div class="al-dates"><label>From <input class="inp" type="date" id="alFrom" value="' + w[0] + '" max="' + today() + '"></label>' +
        '<label>To <input class="inp" type="date" id="alTo" value="' + w[1] + '" max="' + today() + '"></label></div>' : "") + "</div>";
  }
  function wireRange(redraw) {
    el.querySelectorAll("[data-range]").forEach(function (b) {
      b.onclick = function () {
        if (b.dataset.range === "custom" && view.range !== "custom") { var w = windowDays(); view.from = w[0] < "1000" ? today().slice(0, 8) + "01" : w[0]; view.to = w[1] > today() ? today() : w[1]; }
        view.range = b.dataset.range; redraw();
      };
    });
    ["alFrom", "alTo"].forEach(function (id) {
      var i = $(id);
      if (i) { i.onchange = function () { if (i.value) { view[id === "alFrom" ? "from" : "to"] = i.value; redraw(); } }; }
    });
  }
  function windowLabel() {
    var w = windowDays();
    if (view.range === "all") { return "All time"; }
    return longDate(w[0]) + " – " + longDate(w[1]);
  }
  function syncNote() {
    var r = d.run;
    return '<p class="muted al-sync">Leads come from Meta lead forms and GHL (website forms and funnels) and refresh every morning' +
      (r ? " (last refresh " + esc(new Date(r.started_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })) + ")" : "") +
      '. <button class="linkbtn" id="alSync">Refresh now</button></p>';
  }
  function wireSync(again) {
    var b = $("alSync");
    if (!b) { return; }
    b.onclick = async function () {
      b.disabled = true; b.textContent = "Refreshing...";
      try {
        var res = await Promise.all([T.fn("meta-sync", {}), T.fn("ghl-sync", {}).catch(function (e) { return { ok: false, message: "GHL: " + e.message }; })]);
        var bad = res.filter(function (r) { return !r.ok; });
        T.toast(bad.length ? bad.map(function (r) { return r.message || "Refresh had a problem"; }).join(" · ") : "Up to date. " + (res[0].message || ""), 7000);
      }
      catch (e) { T.fail(e); }
      route(again, el);
    };
  }
  function stat(label, value, sub) { return '<div class="stat"><span>' + esc(label) + "</span><b>" + esc(value) + "</b>" + (sub ? "<small>" + esc(sub) + "</small>" : "") + "</div>"; }

  /* ---------- all clients ---------- */
  function drawList() {
    var rows = d.clients.map(function (c) { return { c: c, s: statsFor(c) }; })
      .filter(function (x) { return x.s.all.length || x.s.metaCount || x.s.spend || ((x.c.meta_ad_account_ids || []).length && x.c.status !== "churned"); })
      .sort(function (a, b) { return b.s.total - a.s.total || b.s.spend - a.s.spend || a.c.business_name.localeCompare(b.c.business_name); });
    var un = statsFor(null);
    var listed = rows.reduce(function (n, x) { return n + x.s.inRange.length; }, 0) + un.inRange.length;
    var total = rows.reduce(function (n, x) { return n + x.s.total; }, 0);
    var spend = rows.reduce(function (n, x) { return n + x.s.spend; }, 0);

    el.innerHTML = '<div class="cl-wrap al">' +
      '<div class="cl-head"><div><h1>Client Leads</h1><p class="muted">Every lead your Meta ads brought in, by client. ' + esc(windowLabel()) + ".</p></div>" + rangeBar() + "</div>" +
      '<div class="stats">' +
        stat("Leads", total, listed + " with contact info") +
        stat("Ad spend", money(spend), "All clients") +
        stat("Cost per lead", total ? money2(spend / total) : "—", "") +
        stat("Clients with leads", rows.filter(function (x) { return x.s.total; }).length, "") +
      "</div>" +
      (!d.leads.length ? '<div class="hintbox">No individual leads have come through yet. Once lead access is turned on for the Meta connection, every instant-form lead shows up here with name, phone, email and answers.</div>' : "") +
      '<div class="al-table"><div class="al-row al-th"><span>Client</span><span>Leads</span><span>Ad spend</span><span>Cost per lead</span><span>Last lead</span></div>' +
      rows.map(function (x) {
        return '<a class="al-row" href="#adleads/' + x.c.id + '"><span class="al-name"><b>' + esc(x.c.business_name) + "</b><small>" + esc(x.c.status) + "</small></span>" +
          '<span class="al-n' + (x.s.total ? "" : " zero") + '">' + x.s.total + (x.s.metaCount > x.s.inRange.length ? '<small title="Meta counted more leads than came through instant forms (website forms)">' + x.s.inRange.length + " listed</small>" : "") + "</span>" +
          '<span class="al-sp">' + (x.s.spend ? money(x.s.spend) : '<span class="muted">$0</span>') + "</span>" +
          "<span>" + (x.s.cpl != null ? money2(x.s.cpl) : "—") + "</span>" +
          "<span>" + (x.s.last ? esc(when(x.s.last)) : '<span class="muted">—</span>') + "</span></a>";
      }).join("") +
      (un.all.length ? '<a class="al-row al-un" href="#adleads/unmatched"><span class="al-name"><b>Not matched to a client</b><small>Assign these to the right client</small></span><span class="al-n">' + un.inRange.length + "</span><span></span><span></span><span>" + esc(when(un.last)) + "</span></a>" : "") +
      (rows.length ? "" : '<p class="muted" style="padding:16px">No clients with Meta ad accounts yet. Link ad accounts in Settings → Meta ads.</p>') +
      "</div>" + syncNote() + "</div>";
    wireRange(drawList);
    wireSync("#adleads");
  }

  /* ---------- one client ---------- */
  function drawClient(id) {
    var c = id === "unmatched" ? null : d.clients.filter(function (x) { return x.id === id; })[0];
    if (id !== "unmatched" && !c) { el.innerHTML = '<div class="cl-wrap"><a class="back" href="#adleads">← Client Leads</a><p class="muted">Client not found.</p></div>'; return; }
    var s = statsFor(c);
    var qv = view.q.toLowerCase();
    var list = s.inRange.filter(function (l) {
      if (!qv) { return true; }
      return [l.name, l.email, l.phone, l.campaign_name, l.ad_name, l.form_name].join(" ").toLowerCase().indexOf(qv) !== -1 ||
        JSON.stringify(l.fields || []).toLowerCase().indexOf(qv) !== -1;
    });
    var week = s.all.filter(function (l) { return localDay(l.created_time) >= ymd(new Date(Date.now() - 6 * 864e5)); }).length;

    el.innerHTML = '<div class="cl-wrap al">' +
      '<a class="back" href="#adleads">← Client Leads</a>' +
      '<div class="cl-head"><div><h1>' + esc(c ? c.business_name : "Not matched to a client") + "</h1>" +
        (c ? '<p class="muted">' + esc(windowLabel()) + ' · <a href="#client/' + c.id + '">Client profile</a> · <a href="#ppl/' + c.id + '">Pay per lead</a></p>' : '<p class="muted">Leads from Pages or ads Tracker couldn\'t tie to a client. Pick the client for each one.</p>') + "</div>" +
        rangeBar() + "</div>" +
      '<div class="stats">' +
        stat("Leads", c ? s.total : s.inRange.length, c && s.metaCount > s.inRange.length ? s.inRange.length + " listed below, the rest came from website forms" : "In this range") +
        (c ? stat("Ad spend", money2(s.spend), "In this range") + stat("Cost per lead", s.cpl != null ? money2(s.cpl) : "—", "") : "") +
        stat("Last 7 days", week, "Leads listed") +
      "</div>" +
      '<div class="board-bar al-bar"><input class="inp search" id="alQ" type="search" placeholder="Search name, phone, email, answers..." value="' + esc(view.q) + '" aria-label="Search leads">' +
        '<span class="spacer"></span><button class="btn sm" id="alCsv"' + (list.length ? "" : " disabled") + ">Download CSV</button>" +
        (c ? '<button class="btn sm gold" id="alPdf">Client report (PDF)</button>' : "") + "</div>" +
      '<div class="al-leads">' + (list.length ? list.map(function (l) { return leadRow(l, !c); }).join("") :
        '<p class="muted" style="padding:18px">' + (s.all.length ? "No leads match." : "No leads yet in this range.") + "</p>") + "</div>" +
      syncNote() + "</div>";

    wireRange(function () { drawClient(id); });
    wireSync("#adleads/" + id);
    $("alQ").oninput = function (e) { view.q = e.target.value; var pos = e.target.selectionStart; drawClient(id); var inp = $("alQ"); inp.focus(); inp.setSelectionRange(pos, pos); };
    el.querySelectorAll(".al-lead > button.al-sum").forEach(function (b) { b.onclick = function () { b.parentNode.classList.toggle("open"); b.setAttribute("aria-expanded", b.parentNode.classList.contains("open")); }; });
    el.querySelectorAll("[data-assign]").forEach(function (sel) {
      sel.onchange = async function () {
        try {
          await q(T.sb.from("meta_leads").update({ client_id: sel.value || null }).eq("id", sel.dataset.assign));
          T.toast("Lead moved"); await load(); drawClient(id);
        } catch (e) { T.fail(e); }
      };
    });
    $("alCsv").onclick = function () { downloadCsv(c, list); };
    if (c) { $("alPdf").onclick = function () { reportDialog(c); }; }
  }

  function leadRow(l, unmatched) {
    var fields = (l.fields || []).map(function (f) {
      return "<dt>" + esc(prettyField(f.name)) + "</dt><dd>" + esc((f.values || []).join(", ")) + "</dd>";
    }).join("");
    var tel = (l.phone || "").replace(/[^\d+]/g, "");
    return '<div class="al-lead">' +
      '<button type="button" class="al-sum" aria-expanded="false">' +
        '<span class="al-when">' + esc(when(l.created_time)) + "</span>" +
        '<span class="al-who"><b>' + esc(l.name || "No name") + (l.stage ? ' <em class="al-stage st-' + stageClass(l.stage) + '">' + esc(l.stage) + "</em>" : "") + "</b><small>" + esc([phone(l.phone), l.email].filter(Boolean).join(" · ")) + "</small></span>" +
        '<span class="al-src">' + esc(l.campaign_name || (l.is_organic ? "Organic" : l.form_name || "")) + "<small>" + esc(l.ad_name || l.form_name || "") + "</small></span>" +
        '<span class="al-chev" aria-hidden="true">▾</span></button>' +
      '<div class="al-detail">' +
        '<div class="al-actions">' + (tel ? '<a class="btn sm" href="tel:' + esc(tel) + '">Call</a><a class="btn sm" href="sms:' + esc(tel) + '">Text</a>' : "") +
          (l.email ? '<a class="btn sm" href="mailto:' + esc(l.email) + '">Email</a>' : "") +
          (unmatched ? '<select class="inp al-assign" data-assign="' + esc(l.id) + '" aria-label="Client for this lead"><option value="">Pick the client...</option>' +
            d.clients.map(function (c) { return '<option value="' + c.id + '">' + esc(c.business_name) + "</option>"; }).join("") + "</select>" : "") + "</div>" +
        '<dl class="kv al-fields">' + fields +
          "<dt>Form</dt><dd>" + esc(l.form_name || l.form_id) + "</dd>" +
          (l.pipeline ? "<dt>GHL pipeline</dt><dd>" + esc(l.pipeline + (l.stage ? " · " + l.stage : "")) + "</dd>" : "") +
          (l.adset_name ? "<dt>Ad set</dt><dd>" + esc(l.adset_name) + "</dd>" : "") +
          (l.platform ? "<dt>Platform</dt><dd>" + esc(platformName(l.platform)) + "</dd>" : "") +
          (l.fromGhl ? "" : "<dt>Meta lead ID</dt><dd>" + esc(l.id) + "</dd>") + "</dl></div></div>";
  }
  function platformName(p) { return p === "ig" ? "Instagram" : p === "fb" ? "Facebook" : p === "web" ? "Website" : p || ""; }

  function downloadCsv(c, list) {
    var names = [];
    list.forEach(function (l) { (l.fields || []).forEach(function (f) { if (names.indexOf(f.name) === -1) { names.push(f.name); } }); });
    var head = ["Date", "Name", "Phone", "Email", "Campaign", "Ad set", "Ad", "Form", "Platform"].concat(names.map(prettyField));
    var rows = list.map(function (l) {
      var byName = {}; (l.fields || []).forEach(function (f) { byName[f.name] = (f.values || []).join(", "); });
      return [new Date(l.created_time).toLocaleString("en-US"), l.name, l.phone, l.email, l.campaign_name, l.adset_name, l.ad_name, l.form_name, l.platform]
        .concat(names.map(function (n) { return byName[n] || ""; }));
    });
    var csv = [head].concat(rows).map(function (r) { return r.map(function (v) { v = String(v == null ? "" : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(","); }).join("\n");
    save(new Blob([csv], { type: "text/csv" }), (c ? c.business_name : "unmatched").replace(/[^\w]+/g, "-") + "-leads-" + today() + ".csv");
  }
  function save(blob, name) {
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 60000);
  }

  /* ---------- branded PDF report ---------- */
  function reportDialog(c) {
    var w = windowDays();
    var from = w[0] < "1000" ? (d.leads.filter(function (l) { return l.client_id === c.id; }).map(function (l) { return localDay(l.created_time); }).sort()[0] || today()) : w[0];
    var to = w[1] > today() ? today() : w[1];
    T.modal("<h2>Client report: " + esc(c.business_name) + "</h2>" +
      '<p class="muted" style="margin-top:0">A branded PDF you can send to the client: leads, ad spend and every lead\'s details for the dates you pick.</p>' +
      '<div class="al-dates al-dates-m"><label>From <input class="inp" type="date" id="rpFrom" value="' + from + '" max="' + today() + '"></label>' +
      '<label>To <input class="inp" type="date" id="rpTo" value="' + to + '" max="' + today() + '"></label></div>' +
      '<div class="al-quick">' + [["Last 7 days", 6], ["Last 14 days", 13], ["Last 30 days", 29]].map(function (p) { return '<button type="button" class="btn sm" data-days="' + p[1] + '">' + p[0] + "</button>"; }).join("") +
        '<button type="button" class="btn sm" data-month="0">This month</button><button type="button" class="btn sm" data-month="1">Last month</button></div>' +
      '<label class="al-check"><input type="checkbox" id="rpSpend" checked> Show ad spend and cost per lead</label>' +
      '<label class="al-check"><input type="checkbox" id="rpLeads" checked> List every lead with contact info and answers</label>' +
      '<p class="muted" id="rpSum" style="margin-bottom:0"></p>' +
      "<div class='mfoot'><button class='btn' id='mCancel'>Cancel</button><button class='btn gold' id='mSave'>Download PDF</button></div>");
    function sum() {
      var f = $("rpFrom").value, t = $("rpTo").value;
      if (!f || !t) { $("rpSum").textContent = ""; return; }
      var s = statsFor(c, f <= t ? [f, t] : [t, f]);
      $("rpSum").textContent = s.total + " lead" + (s.total === 1 ? "" : "s") + " · " + money2(s.spend) + " ad spend in these dates.";
    }
    document.querySelectorAll("[data-days]").forEach(function (b) { b.onclick = function () { $("rpFrom").value = ymd(new Date(Date.now() - Number(b.dataset.days) * 864e5)); $("rpTo").value = today(); sum(); }; });
    document.querySelectorAll("[data-month]").forEach(function (b) {
      b.onclick = function () {
        var n = new Date(), m = new Date(n.getFullYear(), n.getMonth() - Number(b.dataset.month), 1);
        var end = b.dataset.month === "0" ? n : new Date(m.getFullYear(), m.getMonth() + 1, 0);
        $("rpFrom").value = ymd(m); $("rpTo").value = ymd(end); sum();
      };
    });
    $("rpFrom").onchange = $("rpTo").onchange = sum; sum();
    $("mCancel").onclick = T.closeModal;
    $("mSave").onclick = async function () {
      var f = $("rpFrom").value, t = $("rpTo").value;
      if (!f || !t) { T.toast("Pick both dates"); return; }
      if (f > t) { var x = f; f = t; t = x; }
      var b = $("mSave"); b.disabled = true; b.textContent = "Making PDF...";
      try {
        await buildPdf(c, [f, t], { spend: $("rpSpend").checked, leads: $("rpLeads").checked });
        T.closeModal();
      } catch (e) { T.fail(e); b.disabled = false; b.textContent = "Download PDF"; }
    };
  }

  function loadScript(src) {
    return new Promise(function (ok, bad) {
      var s = document.createElement("script"); s.src = src; s.onload = ok;
      s.onerror = function () { bad(new Error("Couldn't load the PDF maker. Check your connection and try again.")); };
      document.head.appendChild(s);
    });
  }
  async function pdfLib() {
    if (!(window.jspdf && window.jspdf.jsPDF)) { await loadScript("https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js"); }
    if (!window.jspdf.jsPDF.API.autoTable) { await loadScript("https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.4/dist/jspdf.plugin.autotable.min.js"); }
    return window.jspdf.jsPDF;
  }
  function logoData() {
    return new Promise(function (ok) {
      var img = new Image();
      img.onload = function () {
        var cv = document.createElement("canvas"); cv.width = img.naturalWidth; cv.height = img.naturalHeight;
        cv.getContext("2d").drawImage(img, 0, 0);
        ok({ data: cv.toDataURL("image/png"), w: img.naturalWidth, h: img.naturalHeight });
      };
      img.onerror = function () { ok(null); };
      img.src = "/assets/logo.png";
    });
  }
  // The PDF's built-in font only covers basic Latin characters.
  function pdfText(s) {
    return String(s == null ? "" : s).replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/…/g, "...")
      .normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^\x20-\x7e\n]/g, "").trim();
  }

  async function buildPdf(c, w, opt) {
    var JsPDF = await pdfLib();
    var logo = await logoData();
    var s = statsFor(c, w);
    var leads = s.inRange.slice().sort(function (a, b) { return a.created_time < b.created_time ? -1 : 1; });
    var doc = new JsPDF({ unit: "pt", format: "letter" });
    var W = 612, M = 40;
    var GOLD = [245, 216, 90], GOLDD = [201, 168, 0], INK = [17, 17, 17], GREY = [110, 110, 110], LINE = [226, 222, 208], PAPER = [250, 248, 241];
    var range = longDate(w[0]) + "  -  " + longDate(w[1]);
    var nDays = Math.round((new Date(w[1] + "T12:00:00") - new Date(w[0] + "T12:00:00")) / 864e5) + 1;

    // Header band
    doc.setFillColor(8, 8, 8); doc.rect(0, 0, W, 118, "F");
    doc.setFillColor.apply(doc, GOLD); doc.rect(0, 118, W, 3, "F");
    if (logo) { var lh = 52, lw = lh * logo.w / logo.h; doc.addImage(logo.data, "PNG", M - 6, 32, lw, lh); }
    doc.setTextColor.apply(doc, GOLD); doc.setFont("helvetica", "bold"); doc.setFontSize(9);
    doc.text("LEAD REPORT", W - M, 42, { align: "right", charSpace: 2 });
    doc.setTextColor(255, 255, 255); doc.setFontSize(20);
    doc.text(pdfText(c.business_name), W - M, 68, { align: "right", maxWidth: 330 });
    doc.setFont("helvetica", "normal"); doc.setFontSize(10.5); doc.setTextColor(190, 190, 190);
    doc.text(range, W - M, 88, { align: "right" });

    // Stat cards
    var y = 150;
    var cards = [["TOTAL LEADS", String(s.total)]];
    if (opt.spend) { cards.push(["AD SPEND", money2(s.spend)], ["COST PER LEAD", s.cpl != null ? money2(s.cpl) : "-"]); }
    cards.push(["LEADS PER DAY", (s.total / nDays).toFixed(1)]);
    var gap = 12, cw = (W - 2 * M - gap * (cards.length - 1)) / cards.length;
    cards.forEach(function (k, i) {
      var x = M + i * (cw + gap);
      doc.setFillColor.apply(doc, PAPER); doc.setDrawColor.apply(doc, LINE); doc.roundedRect(x, y, cw, 66, 6, 6, "FD");
      doc.setFillColor.apply(doc, GOLDD); doc.rect(x + 14, y + 12, 18, 2.5, "F");
      doc.setFont("helvetica", "bold"); doc.setFontSize(7.5); doc.setTextColor.apply(doc, GREY);
      doc.text(k[0], x + 14, y + 28, { charSpace: 0.8 });
      doc.setFontSize(20); doc.setTextColor.apply(doc, INK); doc.text(k[1], x + 14, y + 53);
    });
    y += 66;
    if (s.metaCount > s.inRange.length) {
      y += 16; doc.setFont("helvetica", "normal"); doc.setFontSize(8.5); doc.setTextColor.apply(doc, GREY);
      doc.text("Includes " + (s.total - s.inRange.length) + " lead(s) from website forms counted by Meta. The leads listed below came in through Facebook and Instagram lead forms.", M, y, { maxWidth: W - 2 * M });
    }

    // Leads per day (by week for long ranges)
    y += 34;
    var buckets = [], perDay = {};
    leads.forEach(function (l) { var k = localDay(l.created_time); perDay[k] = (perDay[k] || 0) + 1; });
    Object.keys(s.byDay).forEach(function (k) { perDay[k] = Math.max(perDay[k] || 0, s.byDay[k].meta); });
    var weekly = nDays > 45, step = weekly ? 7 : 1;
    for (var t0 = new Date(w[0] + "T12:00:00"); ymd(t0) <= w[1]; t0 = new Date(t0.getTime() + step * 864e5)) {
      var n = 0, sp = 0, k0 = ymd(t0);
      for (var j = 0; j < step; j++) { var kk = ymd(new Date(t0.getTime() + j * 864e5)); if (kk > w[1]) { break; } n += perDay[kk] || 0; sp += s.byDay[kk] ? s.byDay[kk].spend : 0; }
      buckets.push({ day: k0, n: n, spend: sp });
    }
    doc.setFont("helvetica", "bold"); doc.setFontSize(12); doc.setTextColor.apply(doc, INK);
    doc.text(weekly ? "Leads per week" : "Leads per day", M, y);
    if (opt.spend) {
      doc.setFont("helvetica", "normal"); doc.setFontSize(8.5); doc.setTextColor.apply(doc, GREY);
      doc.setFillColor.apply(doc, GOLD); doc.rect(W - M - 150, y - 7, 8, 8, "F"); doc.text("Leads", W - M - 138, y);
      doc.setDrawColor(40, 40, 40); doc.setLineWidth(1.2); doc.line(W - M - 92, y - 3, W - M - 78, y - 3); doc.text("Ad spend", W - M - 72, y);
    }
    var ch = 130, cy = y + 14, cx = M + 22, cwid = W - 2 * M - 22;
    var maxN = Math.max(1, Math.max.apply(null, buckets.map(function (b) { return b.n; })));
    var niceMax = maxN <= 4 ? maxN : Math.ceil(maxN / 4) * 4;
    doc.setLineWidth(0.5); doc.setDrawColor.apply(doc, LINE); doc.setFontSize(7.5); doc.setTextColor.apply(doc, GREY);
    for (var g = 0; g <= 4; g++) {
      var gy = cy + ch - ch * g / 4; doc.line(cx, gy, cx + cwid, gy);
      var lab = niceMax * g / 4; if (lab % 1 === 0 || g === 4) { doc.text(String(Math.round(lab * 10) / 10), cx - 6, gy + 2.5, { align: "right" }); }
    }
    var bw = cwid / buckets.length;
    buckets.forEach(function (b, i) {
      var h = ch * b.n / niceMax;
      if (h > 0) { doc.setFillColor.apply(doc, GOLD); doc.rect(cx + i * bw + bw * 0.18, cy + ch - h, bw * 0.64, h, "F"); }
      var every = Math.ceil(buckets.length / 12);
      if (i % every === 0) {
        var dt = new Date(b.day + "T12:00:00");
        doc.setTextColor.apply(doc, GREY); doc.text((dt.getMonth() + 1) + "/" + dt.getDate(), cx + i * bw + bw / 2, cy + ch + 11, { align: "center" });
      }
    });
    if (opt.spend) {
      var maxS = Math.max(1, Math.max.apply(null, buckets.map(function (b) { return b.spend; })));
      doc.setDrawColor(40, 40, 40); doc.setLineWidth(1.2);
      var pts = buckets.map(function (b, i) { return [cx + i * bw + bw / 2, cy + ch - ch * 0.92 * b.spend / maxS]; });
      for (var p = 1; p < pts.length; p++) { doc.line(pts[p - 1][0], pts[p - 1][1], pts[p][0], pts[p][1]); }
      if (pts.length === 1) { doc.circle(pts[0][0], pts[0][1], 1.5, "F"); }
      doc.setFontSize(7.5); doc.setTextColor.apply(doc, GREY); doc.text("Spend peak " + money(maxS) + (weekly ? "/wk" : "/day"), cx + cwid, cy - 4, { align: "right" });
    }
    y = cy + ch + 34;

    // Where leads came from
    var camp = {};
    leads.forEach(function (l) { var k = pdfText(l.campaign_name) || (l.is_organic ? "Organic" : "Other"); camp[k] = (camp[k] || 0) + 1; });
    var campRows = Object.keys(camp).sort(function (a, b) { return camp[b] - camp[a]; }).map(function (k) { return [k, String(camp[k]), Math.round(100 * camp[k] / leads.length) + "%"]; });
    var plat = {};
    leads.forEach(function (l) { var k = platformName(l.platform) || "Other"; plat[k] = (plat[k] || 0) + 1; });
    var tableStyle = {
      theme: "plain", margin: { left: M, right: M, bottom: 50 },
      styles: { font: "helvetica", fontSize: 9, textColor: INK, cellPadding: { top: 6, bottom: 6, left: 8, right: 8 }, lineColor: LINE, lineWidth: { bottom: 0.5 } },
      headStyles: { fillColor: [8, 8, 8], textColor: GOLD, fontStyle: "bold", fontSize: 8, lineWidth: 0 },
      alternateRowStyles: { fillColor: PAPER }
    };
    if (campRows.length) {
      doc.setFont("helvetica", "bold"); doc.setFontSize(12); doc.setTextColor.apply(doc, INK);
      doc.text("Where the leads came from", M, y);
      doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor.apply(doc, GREY);
      doc.text(Object.keys(plat).map(function (k) { return k + ": " + plat[k]; }).join("    "), W - M, y, { align: "right" });
      doc.autoTable(Object.assign({}, tableStyle, {
        startY: y + 10, head: [["CAMPAIGN", "LEADS", "SHARE"]], body: campRows,
        columnStyles: { 1: { halign: "right", cellWidth: 70 }, 2: { halign: "right", cellWidth: 70 } }
      }));
      y = doc.lastAutoTable.finalY + 30;
    }

    // Every lead
    if (opt.leads && leads.length) {
      if (y > 640) { doc.addPage(); y = 60; }
      doc.setFont("helvetica", "bold"); doc.setFontSize(12); doc.setTextColor.apply(doc, INK);
      doc.text("Lead details (" + leads.length + ")", M, y);
      var skip = /^(full[_ ]?name|first[_ ]?name|last[_ ]?name|e-?mail|phone(_number)?)$/i;
      doc.autoTable(Object.assign({}, tableStyle, {
        startY: y + 10,
        head: [["DATE", "NAME", "PHONE / EMAIL", "ANSWERS"]],
        body: leads.map(function (l) {
          var t = new Date(l.created_time);
          var answers = (l.fields || []).filter(function (f) { return !skip.test(f.name); })
            .map(function (f) { return pdfText(prettyField(f.name)) + ": " + pdfText((f.values || []).join(", ")); }).join("\n");
          return [t.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + "\n" + t.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }),
            pdfText(l.name) || "-", [pdfText(phone(l.phone)), pdfText(l.email)].filter(Boolean).join("\n") || "-", answers || "-"];
        }),
        styles: Object.assign({}, tableStyle.styles, { fontSize: 8.5, valign: "top" }),
        columnStyles: { 0: { cellWidth: 62, textColor: GREY }, 1: { cellWidth: 110, fontStyle: "bold" }, 2: { cellWidth: 150 } }
      }));
    } else if (!leads.length) {
      doc.setFont("helvetica", "normal"); doc.setFontSize(10); doc.setTextColor.apply(doc, GREY);
      doc.text("No leads came in through lead forms in these dates.", M, y);
    }

    // Footer on every page
    var pages = doc.getNumberOfPages();
    for (var pg = 1; pg <= pages; pg++) {
      doc.setPage(pg);
      doc.setDrawColor.apply(doc, LINE); doc.setLineWidth(0.5); doc.line(M, 752, W - M, 752);
      doc.setFont("helvetica", "bold"); doc.setFontSize(8); doc.setTextColor.apply(doc, INK);
      doc.text("SOLID GOLD SYSTEMS", M, 766, { charSpace: 1 });
      doc.setFont("helvetica", "normal"); doc.setTextColor.apply(doc, GREY);
      doc.text("solidgoldsystems.com", M + doc.getTextWidth("SOLID GOLD SYSTEMS") + 26, 766);
      doc.text(pdfText(c.business_name) + "  |  " + range + "  |  Page " + pg + " of " + pages, W - M, 766, { align: "right" });
    }
    doc.setProperties({ title: pdfText(c.business_name) + " Lead Report " + w[0] + " to " + w[1], author: "Solid Gold Systems", creator: "Solid Gold Systems Tracker" });
    save(doc.output("blob"), c.business_name.replace(/[^\w]+/g, "-").replace(/^-|-$/g, "") + "-Lead-Report-" + w[0] + "-to-" + w[1] + ".pdf");
  }

  /* ---------- SGS's own leads and ad spend (#sgs) ---------- */
  function drawSgs() {
    var w = windowDays();
    var leads = d.leads.filter(function (l) { return isSgs(l) && between(localDay(l.created_time), w); });
    var spend = 0, metaLeads = 0, byDay = {};
    d.daily.forEach(function (x) {
      if (SGS.adAccounts.indexOf(x.ad_account_id) !== -1 && between(x.day, w)) {
        spend += Number(x.spend || 0); metaLeads += Number(x.leads || 0);
        var b = byDay[x.day] || (byDay[x.day] = { spend: 0, leads: 0 }); b.spend += Number(x.spend || 0); b.leads += Number(x.leads || 0);
      }
    });
    leads.forEach(function (l) { var k = localDay(l.created_time); var b = byDay[k] || (byDay[k] = { spend: 0, leads: 0, forms: 0 }); b.forms = (b.forms || 0) + 1; });
    var ads = (d.ads || []).filter(function (x) { return between(x.day, w); });
    var imp = 0, clicks = 0;
    ads.forEach(function (x) { imp += Number(x.impressions || 0); clicks += Number(x.link_clicks || x.clicks || 0); });
    var total = Math.max(leads.length, metaLeads);

    // Breakdown by campaign / ad set / ad: spend and clicks from Meta's ad-level numbers,
    // leads = Meta's count or the form leads we have, whichever is higher.
    var keyOf = { campaign: function (x) { return x.campaign_name || "(no campaign)"; }, adset: function (x) { return x.adset_name || "(no ad set)"; }, ad: function (x) { return x.ad_name || "(no ad)"; } };
    var parentOf = { campaign: function () { return ""; }, adset: function (x) { return x.campaign_name || ""; }, ad: function (x) { return [x.campaign_name, x.adset_name].filter(Boolean).join(" › "); } };
    var by = sgsView.by, rows = {};
    function row(k, parent) { return rows[k] || (rows[k] = { name: k, parent: parent, spend: 0, imp: 0, clicks: 0, meta: 0, forms: 0, booked: 0 }); }
    ads.forEach(function (x) {
      var r = row(keyOf[by](x), parentOf[by](x));
      r.spend += Number(x.spend || 0); r.imp += Number(x.impressions || 0); r.clicks += Number(x.link_clicks || x.clicks || 0); r.meta += Number(x.leads || 0);
    });
    leads.forEach(function (l) {
      var x = { campaign_name: l.campaign_name, adset_name: l.adset_name, ad_name: l.ad_name };
      if (!l.ad_id && l.is_organic) { x = { campaign_name: "Organic", adset_name: "Organic", ad_name: "Organic" }; }
      if (!l.ad_id && !l.campaign_name && l.fromGhl) { x = { campaign_name: "Website / direct", adset_name: "Website / direct", ad_name: "Website / direct" }; }
      var rr = row(keyOf[by](x), /^(Organic|Website \/ direct)$/.test(x.campaign_name) ? "" : parentOf[by](x));
      rr.forms++; if (isBooked(l)) { rr.booked++; }
    });
    var list = Object.keys(rows).map(function (k) { var r = rows[k]; r.leads = Math.max(r.meta, r.forms); r.cpl = r.leads && r.spend ? r.spend / r.leads : null; return r; })
      .filter(function (r) { return r.spend || r.leads; });
    var sorts = { spend: function (a, b) { return b.spend - a.spend; }, leads: function (a, b) { return b.leads - a.leads || b.spend - a.spend; },
      cpl: function (a, b) { return (a.cpl == null ? 1e9 : a.cpl) - (b.cpl == null ? 1e9 : b.cpl); } };
    list.sort(sorts[sgsView.sort] || sorts.spend);
    var best = list.filter(function (r) { return r.cpl != null && r.leads >= 2; }).sort(sorts.cpl)[0];

    var qv = view.q.toLowerCase();
    var shown = leads.filter(function (l) {
      return !qv || [l.name, l.email, l.phone, l.campaign_name, l.adset_name, l.ad_name, l.form_name].join(" ").toLowerCase().indexOf(qv) !== -1 || JSON.stringify(l.fields || []).toLowerCase().indexOf(qv) !== -1;
    });
    var seg = function (key, opts, cur) {
      return '<div class="seg sm" role="group">' + opts.map(function (o) { return '<button class="seg-b' + (cur === o[0] ? " on" : "") + '" data-' + key + '="' + o[0] + '">' + o[1] + "</button>"; }).join("") + "</div>";
    };

    el.innerHTML = '<div class="cl-wrap al">' +
      '<div class="cl-head"><div><h1>SGS Leads</h1><p class="muted">Solid Gold Systems\' own leads: Meta ads, website and funnels (from GHL). ' + esc(windowLabel()) + ".</p></div>" + rangeBar() + "</div>" +
      '<div class="stats">' +
        stat("Leads", total, leads.length + " with contact info" + (metaLeads > leads.length ? " (Meta counted " + metaLeads + ")" : "")) +
        stat("Ad spend", money2(spend), "") +
        stat("Cost per lead", total && spend ? money2(spend / total) : "—", best ? "Best: " + best.name.slice(0, 40) + " (" + money2(best.cpl) + ")" : "") +
        stat("Booked calls", leads.filter(isBooked).length, leads.length ? Math.round(100 * leads.filter(isBooked).length / leads.length) + "% of leads · " + leads.filter(function (l) { return stageClass(l.stage) === "won"; }).length + " sold" : "") +
        stat("Link clicks", clicks.toLocaleString("en-US"), imp ? (100 * clicks / imp).toFixed(2) + "% CTR · " + (clicks ? money2(spend / clicks) + " per click" : "") : "") +
      "</div>" +
      sgsChart(w, byDay) +
      '<div class="al-sec"><h2>What\'s working</h2>' + seg("by", [["campaign", "Campaigns"], ["adset", "Ad sets"], ["ad", "Ads"]], by) +
        '<span class="spacer"></span>' + seg("sort", [["spend", "Most spend"], ["leads", "Most leads"], ["cpl", "Cheapest lead"]], sgsView.sort) + "</div>" +
      '<div class="al-table sg-table"><div class="al-row sg-row al-th"><span>' + { campaign: "Campaign", adset: "Ad set", ad: "Ad" }[by] + "</span><span>Spend</span><span>Leads</span><span>Cost per lead</span><span>Booked</span><span>Clicks</span><span>CTR</span></div>" +
        (list.length ? list.map(function (r) {
          return '<div class="al-row sg-row"><span class="al-name"><b>' + esc(r.name) + "</b>" + (r.parent ? "<small>" + esc(r.parent) + "</small>" : "") + "</span>" +
            "<span>" + money2(r.spend) + '</span><span class="al-n' + (r.leads ? "" : " zero") + '">' + r.leads + "</span>" +
            "<span" + (best && r === best ? ' class="sg-best"' : "") + ">" + (r.cpl != null ? money2(r.cpl) : "—") + "</span>" +
            "<span>" + (r.booked ? '<b class="sg-bk">' + r.booked + "</b>" : '<span class="muted">0</span>') + "</span>" +
            "<span>" + (r.clicks ? r.clicks.toLocaleString("en-US") : "—") + "</span><span>" + (r.imp ? (100 * r.clicks / r.imp).toFixed(2) + "%" : "—") + "</span></div>";
        }).join("") : '<p class="muted" style="padding:16px">' + (d.ads && d.ads.length ? "No ad activity in these dates." : "Ad-level numbers start with the next Meta refresh.") + "</p>") +
      "</div>" +
      '<div class="al-sec"><h2>Leads (' + leads.length + ")</h2></div>" +
      '<div class="board-bar al-bar"><input class="inp search" id="alQ" type="search" placeholder="Search name, phone, email, campaign, ad..." value="' + esc(view.q) + '" aria-label="Search leads">' +
        '<span class="spacer"></span><button class="btn sm" id="alCsv"' + (shown.length ? "" : " disabled") + ">Download CSV</button></div>" +
      '<div class="al-leads">' + (shown.length ? shown.map(function (l) { return leadRow(l, false); }).join("") :
        '<p class="muted" style="padding:18px">' + (leads.length ? "No leads match." : "No form leads in these dates.") + "</p>") + "</div>" +
      syncNote() + "</div>";

    wireRange(drawSgs);
    wireSync("#sgs");
    el.querySelectorAll("[data-by]").forEach(function (b) { b.onclick = function () { sgsView.by = b.dataset.by; drawSgs(); }; });
    el.querySelectorAll("[data-sort]").forEach(function (b) { b.onclick = function () { sgsView.sort = b.dataset.sort; drawSgs(); }; });
    $("alQ").oninput = function (e) { view.q = e.target.value; var pos = e.target.selectionStart; drawSgs(); var inp = $("alQ"); inp.focus(); inp.setSelectionRange(pos, pos); };
    el.querySelectorAll(".al-lead > button.al-sum").forEach(function (b) { b.onclick = function () { b.parentNode.classList.toggle("open"); b.setAttribute("aria-expanded", b.parentNode.classList.contains("open")); }; });
    $("alCsv").onclick = function () { downloadCsv({ business_name: "SGS" }, shown); };
  }

  /* Leads per day (bars) with ad spend (line), as inline SVG. */
  function sgsChart(w, byDay) {
    var from = w[0] < "1000" ? (Object.keys(byDay).sort()[0] || today()) : w[0], to = w[1] > today() ? today() : w[1];
    var days = [];
    for (var t = new Date(from + "T12:00:00"); ymd(t) <= to && days.length < 800; t = new Date(t.getTime() + 864e5)) { days.push(ymd(t)); }
    var weekly = days.length > 60, pts = [];
    for (var i = 0; i < days.length; i += weekly ? 7 : 1) {
      var n = 0, sp = 0;
      for (var j = i; j < Math.min(days.length, i + (weekly ? 7 : 1)); j++) { var b = byDay[days[j]]; if (b) { n += Math.max(b.leads || 0, b.forms || 0); sp += b.spend || 0; } }
      pts.push({ day: days[i], n: n, spend: sp });
    }
    if (!pts.length) { return ""; }
    var W = 1000, H = 190, pad = 24, bw = (W - pad) / pts.length;
    var maxN = Math.max(1, Math.max.apply(null, pts.map(function (p) { return p.n; })));
    var maxS = Math.max(1, Math.max.apply(null, pts.map(function (p) { return p.spend; })));
    var bars = pts.map(function (p, i) {
      var h = (H - 30) * p.n / maxN;
      return '<rect x="' + (pad + i * bw + bw * 0.18).toFixed(1) + '" y="' + (H - 18 - h).toFixed(1) + '" width="' + (bw * 0.64).toFixed(1) + '" height="' + h.toFixed(1) + '" rx="2" class="sg-bar"><title>' + esc(p.day) + ": " + p.n + " leads, " + money2(p.spend) + "</title></rect>";
    }).join("");
    var line = pts.map(function (p, i) { return (i ? "L" : "M") + (pad + i * bw + bw / 2).toFixed(1) + " " + (H - 18 - (H - 34) * p.spend / maxS).toFixed(1); }).join(" ");
    var every = Math.ceil(pts.length / 10);
    var labels = pts.map(function (p, i) {
      if (i % every) { return ""; }
      var dt = new Date(p.day + "T12:00:00");
      return '<text x="' + (pad + i * bw + bw / 2).toFixed(1) + '" y="' + (H - 3) + '" text-anchor="middle">' + (dt.getMonth() + 1) + "/" + dt.getDate() + "</text>";
    }).join("");
    return '<div class="sg-chart"><div class="sg-legend"><span><i class="sg-k-bar"></i>Leads' + (weekly ? " per week" : " per day") + '</span><span><i class="sg-k-line"></i>Ad spend</span><span class="muted">Peak ' + maxN + " leads · " + money(maxS) + "</span></div>" +
      '<svg viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none" role="img" aria-label="Leads and ad spend over time">' +
      '<line x1="' + pad + '" x2="' + W + '" y1="' + (H - 18) + '" y2="' + (H - 18) + '" class="sg-axis"/>' + bars +
      '<path d="' + line + '" class="sg-line" vector-effect="non-scaling-stroke"/>' + labels + "</svg></div>";
  }

  window.SGSAdLeads = { init: function (h) { T = h; }, route: route };
})();
