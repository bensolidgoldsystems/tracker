/* Solid Gold Systems Tracker - Ad Leads tab (#adleads, #adleads/<client id>, #adleads/unmatched)
   Every lead from Meta instant forms (public.meta_leads, synced each morning by meta-sync),
   grouped by client, with the lead's details and form answers. Cost per lead uses the daily
   spend in public.meta_daily. */
(function () {
  "use strict";
  var T = null;
  var RANGES = [["month", "This month"], ["30", "Last 30 days"], ["year", "This year"], ["all", "All time"]];
  var view = { range: "month", q: "" };
  var d = null, el = null;

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
  function when(iso) {
    var t = new Date(iso);
    return t.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + " · " + t.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  }
  function rangeStart() {
    var now = new Date();
    if (view.range === "month") { return ymd(new Date(now.getFullYear(), now.getMonth(), 1)); }
    if (view.range === "30") { return ymd(new Date(Date.now() - 29 * 864e5)); }
    if (view.range === "year") { return now.getFullYear() + "-01-01"; }
    return "0000-01-01";
  }
  function inRange(isoOrDay) { return String(isoOrDay).slice(0, 10) >= rangeStart(); }
  function localDay(iso) { return ymd(new Date(iso)); }
  function phone(p) {
    var x = String(p || "").replace(/\D/g, "");
    if (x.length === 11 && x[0] === "1") { x = x.slice(1); }
    return x.length === 10 ? "(" + x.slice(0, 3) + ") " + x.slice(3, 6) + "-" + x.slice(6) : (p || "");
  }
  function prettyField(name) { return String(name || "").replace(/_/g, " ").replace(/\?$/, "").replace(/^\w/, function (c) { return c.toUpperCase(); }); }

  async function load() {
    var res = await Promise.all([
      q(T.sb.from("clients").select("id,business_name,status,meta_ad_account_ids").order("business_name")),
      all(function () { return T.sb.from("meta_leads").select("*").order("created_time", { ascending: false }).order("id"); }),
      all(function () { return T.sb.from("meta_daily").select("ad_account_id,day,spend,leads").order("day").order("ad_account_id"); }),
      q(T.sb.from("meta_pages").select("*")),
      q(T.sb.from("meta_sync_runs").select("started_at,ok,message").order("started_at", { ascending: false }).limit(1))
    ]);
    d = { clients: res[0], leads: res[1], daily: res[2], pages: res[3], run: res[4][0] || null };
  }

  function statsFor(c) {
    var accts = c ? (c.meta_ad_account_ids || []) : [];
    var leads = d.leads.filter(function (l) { return c ? l.client_id === c.id : !l.client_id; });
    var r = leads.filter(function (l) { return inRange(localDay(l.created_time)); });
    var spend = 0, metaCount = 0;
    d.daily.forEach(function (x) { if (accts.indexOf(x.ad_account_id) !== -1 && inRange(x.day)) { spend += Number(x.spend || 0); metaCount += Number(x.leads || 0); } });
    return { all: leads, inRange: r, spend: spend, metaCount: metaCount, last: leads[0] ? leads[0].created_time : null };
  }

  async function route(hash, container) {
    el = container;
    el.innerHTML = '<p class="muted" style="padding:24px">Loading...</p>';
    try { await load(); } catch (e) { T.fail(e); el.innerHTML = '<p class="muted" style="padding:24px">' + esc(e.message) + "</p>"; return; }
    var m = String(hash).match(/^#adleads\/([0-9a-f-]{36}|unmatched)/);
    if (m) { drawClient(m[1]); } else { drawList(); }
  }

  function rangeSeg() {
    return '<div class="seg" role="group" aria-label="Date range">' + RANGES.map(function (r) {
      return '<button class="seg-b' + (view.range === r[0] ? " on" : "") + '" data-range="' + r[0] + '">' + r[1] + "</button>";
    }).join("") + "</div>";
  }
  function wireRange(redraw) {
    el.querySelectorAll("[data-range]").forEach(function (b) { b.onclick = function () { view.range = b.dataset.range; redraw(); }; });
  }
  function syncNote() {
    var r = d.run;
    return '<p class="muted al-sync">Leads come from Meta instant forms and refresh every morning' +
      (r ? " (last refresh " + esc(new Date(r.started_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })) + ")" : "") +
      '. <button class="linkbtn" id="alSync">Refresh now</button></p>';
  }
  function wireSync(again) {
    var b = $("alSync");
    if (!b) { return; }
    b.onclick = async function () {
      b.disabled = true; b.textContent = "Refreshing...";
      try { var r = await T.fn("meta-sync", {}); T.toast(r.ok ? (r.message || "Up to date") : (r.message || "Refresh had a problem"), 7000); }
      catch (e) { T.fail(e); }
      route(again, el);
    };
  }

  /* ---------- all clients ---------- */
  function drawList() {
    var rows = d.clients.map(function (c) { return { c: c, s: statsFor(c) }; })
      .filter(function (x) { return x.s.all.length || x.s.metaCount || ((x.c.meta_ad_account_ids || []).length && x.c.status !== "churned"); })
      .sort(function (a, b) { return b.s.inRange.length - a.s.inRange.length || b.s.metaCount - a.s.metaCount || a.c.business_name.localeCompare(b.c.business_name); });
    var un = statsFor(null);
    var total = rows.reduce(function (n, x) { return n + x.s.inRange.length; }, 0) + un.inRange.length;
    var spend = rows.reduce(function (n, x) { return n + x.s.spend; }, 0);
    var metaTotal = rows.reduce(function (n, x) { return n + x.s.metaCount; }, 0);
    var noLeadsYet = !d.leads.length;

    el.innerHTML = '<div class="cl-wrap al">' +
      '<div class="cl-head"><div><h1>Ad Leads</h1><p class="muted">Every lead your Meta ads brought in, by client.</p></div>' + rangeSeg() + "</div>" +
      '<div class="stats">' +
        stat("Leads", total, "With name and contact info") +
        stat("Meta lead count", metaTotal, "Includes website-form leads") +
        stat("Ad spend", money(spend), "") +
        stat("Cost per lead", metaTotal ? money(spend / metaTotal) : "—", "") +
      "</div>" +
      (noLeadsYet ? '<div class="hintbox">No individual leads have come through yet. Once lead access is turned on for the Meta connection, every instant-form lead shows up here with name, phone, email and answers. The counts below already come from Meta.</div>' : "") +
      '<div class="al-table"><div class="al-row al-th"><span>Client</span><span>Leads</span><span>Meta count</span><span>Cost per lead</span><span>Last lead</span></div>' +
      rows.map(function (x) {
        return '<a class="al-row" href="#adleads/' + x.c.id + '"><span class="al-name"><b>' + esc(x.c.business_name) + "</b><small>" + esc(x.c.status) + "</small></span>" +
          '<span class="al-n' + (x.s.inRange.length ? "" : " zero") + '">' + x.s.inRange.length + "</span><span>" + x.s.metaCount + "</span><span>" + (x.s.metaCount ? money(x.s.spend / x.s.metaCount) : "—") + "</span>" +
          "<span>" + (x.s.last ? esc(when(x.s.last)) : '<span class="muted">—</span>') + "</span></a>";
      }).join("") +
      (un.all.length ? '<a class="al-row al-un" href="#adleads/unmatched"><span class="al-name"><b>Not matched to a client</b><small>Assign these to the right client</small></span><span class="al-n">' + un.inRange.length + "</span><span></span><span></span><span>" + esc(when(un.last)) + "</span></a>" : "") +
      (rows.length ? "" : '<p class="muted" style="padding:16px">No clients with Meta ad accounts yet. Link ad accounts in Settings → Meta ads.</p>') +
      "</div>" + syncNote() + "</div>";
    wireRange(drawList);
    wireSync("#adleads");
  }
  function stat(label, value, sub) { return '<div class="stat"><span>' + esc(label) + "</span><b>" + esc(value) + "</b>" + (sub ? "<small>" + esc(sub) + "</small>" : "") + "</div>"; }

  /* ---------- one client ---------- */
  function drawClient(id) {
    var c = id === "unmatched" ? null : d.clients.filter(function (x) { return x.id === id; })[0];
    if (id !== "unmatched" && !c) { el.innerHTML = '<div class="cl-wrap"><a class="back" href="#adleads">← Ad Leads</a><p class="muted">Client not found.</p></div>'; return; }
    var s = statsFor(c);
    var qv = view.q.toLowerCase();
    var list = s.inRange.filter(function (l) {
      if (!qv) { return true; }
      return [l.name, l.email, l.phone, l.campaign_name, l.ad_name, l.form_name].join(" ").toLowerCase().indexOf(qv) !== -1 ||
        JSON.stringify(l.fields || []).toLowerCase().indexOf(qv) !== -1;
    });
    var week = s.all.filter(function (l) { return localDay(l.created_time) >= ymd(new Date(Date.now() - 6 * 864e5)); }).length;

    el.innerHTML = '<div class="cl-wrap al">' +
      '<a class="back" href="#adleads">← Ad Leads</a>' +
      '<div class="cl-head"><div><h1>' + esc(c ? c.business_name : "Not matched to a client") + "</h1>" +
        (c ? '<p class="muted"><a href="#client/' + c.id + '">Client profile</a> · <a href="#ppl/' + c.id + '">Pay per lead</a></p>' : '<p class="muted">Leads from Pages or ads Tracker couldn\'t tie to a client. Pick the client for each one.</p>') + "</div>" +
        rangeSeg() + "</div>" +
      '<div class="stats">' +
        stat("Leads", s.inRange.length, "In this range") +
        stat("Last 7 days", week, "") +
        (c ? stat("Meta lead count", s.metaCount, "Includes website-form leads") + stat("Cost per lead", s.metaCount ? money(s.spend / s.metaCount) : "—", money(s.spend) + " spent") : "") +
      "</div>" +
      '<div class="board-bar al-bar"><input class="inp search" id="alQ" type="search" placeholder="Search name, phone, email, answers..." value="' + esc(view.q) + '" aria-label="Search leads">' +
        '<span class="spacer"></span><button class="btn sm" id="alCsv"' + (list.length ? "" : " disabled") + ">Download CSV</button></div>" +
      '<div class="al-leads">' + (list.length ? list.map(function (l, i) { return leadRow(l, i, !c); }).join("") :
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
  }

  function leadRow(l, i, unmatched) {
    var fields = (l.fields || []).map(function (f) {
      return "<dt>" + esc(prettyField(f.name)) + "</dt><dd>" + esc((f.values || []).join(", ")) + "</dd>";
    }).join("");
    var tel = (l.phone || "").replace(/[^\d+]/g, "");
    return '<div class="al-lead">' +
      '<button type="button" class="al-sum" aria-expanded="false">' +
        '<span class="al-when">' + esc(when(l.created_time)) + "</span>" +
        '<span class="al-who"><b>' + esc(l.name || "No name") + "</b><small>" + esc([phone(l.phone), l.email].filter(Boolean).join(" · ")) + "</small></span>" +
        '<span class="al-src">' + esc(l.campaign_name || (l.is_organic ? "Organic" : l.form_name || "")) + "<small>" + esc(l.ad_name || l.form_name || "") + "</small></span>" +
        '<span class="al-chev" aria-hidden="true">▾</span></button>' +
      '<div class="al-detail">' +
        '<div class="al-actions">' + (tel ? '<a class="btn sm" href="tel:' + esc(tel) + '">Call</a><a class="btn sm" href="sms:' + esc(tel) + '">Text</a>' : "") +
          (l.email ? '<a class="btn sm" href="mailto:' + esc(l.email) + '">Email</a>' : "") +
          (unmatched ? '<select class="inp al-assign" data-assign="' + esc(l.id) + '" aria-label="Client for this lead"><option value="">Pick the client...</option>' +
            d.clients.map(function (c) { return '<option value="' + c.id + '">' + esc(c.business_name) + "</option>"; }).join("") + "</select>" : "") + "</div>" +
        '<dl class="kv al-fields">' + fields +
          "<dt>Form</dt><dd>" + esc(l.form_name || l.form_id) + "</dd>" +
          (l.adset_name ? "<dt>Ad set</dt><dd>" + esc(l.adset_name) + "</dd>" : "") +
          (l.platform ? "<dt>Platform</dt><dd>" + esc(l.platform === "ig" ? "Instagram" : l.platform === "fb" ? "Facebook" : l.platform) + "</dd>" : "") +
          "<dt>Meta lead ID</dt><dd>" + esc(l.id) + "</dd></dl></div></div>";
  }

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
    var a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = (c ? c.business_name : "unmatched").replace(/[^\w]+/g, "-") + "-leads-" + ymd(new Date()) + ".csv";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 60000);
  }

  window.SGSAdLeads = { init: function (h) { T = h; }, route: route };
})();
