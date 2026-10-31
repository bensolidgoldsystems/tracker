/* Solid Gold Systems Tracker - Money: Overview, Reports (the bookkeeping sheet), Meta.
   Every amount lives in public.money_entries (one row per amount in a month).
   Ad spend = actual Meta charges on our cards: imported billing reports (source meta_csv) and,
   after that, charges pulled from Meta's activity log every hour (source meta_api).
   Daily spend in public.meta_daily is only used for lead counts.
   tracker.js calls SGSReports.init(helpers), then:
     SGSReports.overview(el)        #overview (home)
     SGSReports.reports(el, hash)   #finance (also #reports), Finance tab
     SGSReports.metaSettings(el)    Settings page
     SGSReports.clientPanel(el, c)  money panel on a client page */
(function () {
  "use strict";
  var T = null;
  var M3 = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var CAT = {
    revenue: "Revenue", per_lead: "Pay per lead", ad_spend: "Ad spend (our cards)",
    ad_reimbursement: "Ad spend prepaid", partner_payout: "Paid to partner",
    video_shoot: "Video shoot collected", card_fee: "Card fee covered"
  };
  var SOURCE = { manual: "Added in Tracker", sheet: "Bookkeeping sheet", meta_csv: "Meta billing report", meta_api: "Meta (synced)", stripe: "Stripe" };
  var STATUS_LABEL = { onboarding: "Onboarding", active: "Active", paused: "Paused", churned: "Churned" };
  var d = null;   // loaded data

  /* ---------- helpers ---------- */
  function esc(s) { return T.esc(s); }
  function $(id) { return document.getElementById(id); }
  function money(n, opts) {
    opts = opts || {};
    var v = Number(n || 0);
    if (!v && opts.blank) { return ""; }
    var frac = Math.round(Math.abs(v) * 100) % 100 !== 0;
    var s = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: frac ? 2 : 0, maximumFractionDigits: frac ? 2 : 0 });
    return (v < 0 ? "-$" : "$") + s;
  }
  function ym(dateStr) { return String(dateStr).slice(0, 7); }               // "2026-10"
  function monthKey(y, m) { return y + "-" + String(m + 1).padStart(2, "0"); } // m: 0-11
  function todayStr() { var t = new Date(); return t.getFullYear() + "-" + String(t.getMonth() + 1).padStart(2, "0") + "-" + String(t.getDate()).padStart(2, "0"); }
  function monthLong(key) { var p = key.split("-"); return new Date(+p[0], +p[1] - 1, 15).toLocaleDateString("en-US", { month: "long", year: "numeric" }); }
  function dateShort(s) { return s ? new Date(s + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" }) : ""; }
  async function q(promise) { var r = await promise; if (r.error) { throw r.error; } return r.data; }
  // PostgREST returns at most 1,000 rows per request: page through.
  async function all(make) {
    var out = [], size = 1000;
    for (var from = 0; from < 100000; from += size) {
      var rows = await q(make().range(from, from + size - 1));
      out = out.concat(rows);
      if (rows.length < size) { break; }
    }
    return out;
  }
  function byId(list, id) { for (var i = 0; i < list.length; i++) { if (list[i].id === id) { return list[i]; } } return null; }
  function weFront(c) { return /^sgs_/.test(c.ad_spend_mode || ""); }

  // Same rule as the Clients page: Active/Paused follow the ads (Meta dates first, see adstate.js).
  function statusOf(c) {
    if (c.status !== "active" && c.status !== "paused") { return c.status; }
    var st = window.SGSAds.state(d.events, c.id);
    if (!st) { return c.status; }
    return st === "live" ? "active" : "paused";
  }
  function statusBadge(st) {
    var cls = st === "active" ? "ok" : st === "onboarding" ? "gold" : st === "paused" ? "warn" : "";
    return '<span class="badge ' + cls + '">' + esc(STATUS_LABEL[st] || st) + "</span>";
  }

  /* ---------- data ---------- */
  // Data is reused for 30 seconds (moving between Overview, Finance, client pages); saves reload it.
  var loadedAt = 0, CACHE_MS = 30000;
  async function load(force) {
    if (!force && d && Date.now() - loadedAt < CACHE_MS) { applyLive(); return d; }
    var res = await Promise.all([
      q(T.sb.from("clients").select("*").order("business_name")),
      q(T.sb.from("partners").select("*").order("name")),
      q(T.sb.from("client_services").select("*")),
      q(T.sb.from("services").select("id,name")),
      all(function () { return T.sb.from("ad_events").select("*").order("event_date").order("id"); }),
      all(function () { return T.sb.from("money_entries").select("*").order("entry_date", { ascending: true, nullsFirst: true }).order("id"); }),
      all(function () { return T.sb.from("meta_daily").select("ad_account_id,day,leads").gt("leads", 0).order("day").order("ad_account_id"); }),
      q(T.sb.from("meta_ad_accounts").select("*").order("name")),
      q(T.sb.from("meta_sync_runs").select("*").order("started_at", { ascending: false }).limit(5)),
      q(T.sb.from("stripe_sync_runs").select("*").not("finished_at", "is", null).order("started_at", { ascending: false }).limit(1)).catch(function () { return []; }),
      q(T.sb.from("qbo_pnl").select("*").eq("id", 1)).catch(function () { return []; }),
      q(T.sb.from("meta_leads").select("client_id,created_time").not("voided_at", "is", null)).catch(function () { return []; })
    ]);
    d = { clients: res[0], partners: res[1], cs: res[2], services: res[3], events: res[4], entries: res[5], daily: res[6], accounts: res[7], runs: res[8], stripeRun: res[9][0] || null, pnl: res[10][0] || null, voided: res[11] };
    index();
    applyLive();
    loadedAt = Date.now();
    return d;
  }

  // Precompute per client per month: sums by category, synced spend and leads.
  function index() {
    var cell = {};              // cell[clientId][ym][cat] = sum
    function add(cid, key, cat, v) {
      cid = cid || "none";
      cell[cid] = cell[cid] || {}; cell[cid][key] = cell[cid][key] || {};
      cell[cid][key][cat] = (cell[cid][key][cat] || 0) + v;
    }
    // Last imported Meta charge per ad account: synced spend counts only after it.
    var cutoff = {};
    d.entries.forEach(function (e) {
      add(e.client_id, ym(e.month), e.category, Number(e.amount));
      if (e.source === "meta_csv" && e.ad_account_id && e.entry_date && (!cutoff[e.ad_account_id] || e.entry_date > cutoff[e.ad_account_id])) {
        cutoff[e.ad_account_id] = e.entry_date;
      }
    });
    var acctClient = {};
    d.clients.forEach(function (c) { (c.meta_ad_account_ids || []).forEach(function (a) { acctClient[a] = c; }); });
    d.daily.forEach(function (r) {
      var c = acctClient[r.ad_account_id];
      if (!c) { return; }
      if (Number(r.leads)) { add(c.id, ym(r.day), "leads", Number(r.leads)); }
    });
    // Voided leads don't count (Meta's daily count still includes them).
    (d.voided || []).forEach(function (l) { if (l.client_id) { var t = new Date(l.created_time); add(l.client_id, t.getFullYear() + "-" + String(t.getMonth() + 1).padStart(2, "0"), "leads", -1); } });
    d.cell = cell; d.cutoff = cutoff; d.acctClient = acctClient;
    d.acctById = {}; d.accounts.forEach(function (a) { d.acctById[a.ad_account_id] = a; });
  }
  function val(cid, key, cat) { return ((d.cell[cid] || {})[key] || {})[cat] || 0; }
  function spent(cid, key) { return val(cid, key, "ad_spend") + val(cid, key, "synced_spend"); }
  function hasAny(cid, cats, year) {
    var months = d.cell[cid] || {};
    return Object.keys(months).some(function (k) {
      return k.slice(0, 4) === String(year) && cats.some(function (cat) { return months[k][cat]; });
    });
  }
  function perLeadServices(cid) { return d.cs.filter(function (x) { return x.client_id === cid && x.billing_type === "per_lead" && x.status !== "ended"; }); }
  function monthlyServices(cid) { return d.cs.filter(function (x) { return x.client_id === cid && x.billing_type === "monthly" && x.status === "active"; }); }
  // Running ad balance (prepaid minus spent) through the end of a month. Negative = they owe us.
  function adBalance(cid, throughKey) {
    var months = d.cell[cid] || {}, b = 0;
    Object.keys(months).forEach(function (k) {
      if (k <= throughKey) { b += (months[k].ad_reimbursement || 0) - (months[k].ad_spend || 0) - (months[k].synced_spend || 0); }
    });
    return b;
  }
  function monthTotals(key) {
    var t = { revenue: 0, per_lead: 0, spend: 0, reimb: 0, payout: 0, shoot: 0, fee: 0 };
    Object.keys(d.cell).forEach(function (cid) {
      var m = d.cell[cid][key]; if (!m) { return; }
      t.revenue += m.revenue || 0; t.per_lead += m.per_lead || 0;
      t.spend += (m.ad_spend || 0) + (m.synced_spend || 0);
      t.reimb += m.ad_reimbursement || 0; t.payout += m.partner_payout || 0;
      t.shoot += m.video_shoot || 0; t.fee += m.card_fee || 0;
    });
    t.income = t.revenue + t.per_lead;
    t.net = t.income + t.reimb + t.shoot + t.fee - t.spend - t.payout;
    return t;
  }
  // Spend at Meta not yet charged to the card, for a client's linked accounts.
  function unbilled(c) {
    var total = 0, cards = [], at = null, any = false;
    (c.meta_ad_account_ids || []).forEach(function (id) {
      var a = d.acctById[id];
      if (!a || a.balance == null) { return; }
      any = true; total += Number(a.balance);
      if (a.funding_source && cards.indexOf(a.funding_source) === -1) { cards.push(a.funding_source); }
      if (!at || a.balance_at > at) { at = a.balance_at; }
    });
    return any ? { amount: total, cards: cards, at: at } : null;
  }
  function unbilledText(u) {
    return money(u.amount, { cents: true }) + " not yet charged" + (u.cards.length ? " (" + u.cards.join(", ") + ")" : "");
  }
  function unbSum() {
    var sum = 0, n = 0;
    d.clients.forEach(function (c) { if (weFront(c)) { var u = unbilled(c); if (u) { sum += u.amount; n++; } } });
    return { sum: sum, n: n };
  }
  function asOf(at) { return at ? "As of " + new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : ""; }
  /* Live balances: ask Meta for each account's balance now and update every "not yet charged"
     amount on screen in place. Runs when Overview / Finance / a client page opens, then every
     5 minutes while one of them is on screen. */
  var liveAt = 0, liveTimer = null, liveCache = null;
  function applyLive() {
    if (!liveCache || !d) { return; }
    d.accounts.forEach(function (a) {
      var b = liveCache.balances[a.ad_account_id];
      if (b && (!a.balance_at || a.balance_at <= liveCache.at)) { a.balance = b.balance; a.funding_source = b.funding_source || a.funding_source; a.balance_at = liveCache.at; }
    });
  }
  async function liveBalances(force) {
    if (!force && Date.now() - liveAt < 60000) { paintUnb(); return; }
    liveAt = Date.now();
    try {
      var r = await T.fn("meta-sync", { action: "balances" });
      if (r && r.balances) { liveCache = { at: r.at, balances: r.balances }; }
    } catch (e) { /* keep the last synced numbers */ }
    paintUnb();
    if (!liveTimer) {
      liveTimer = setInterval(function () {
        if (document.visibilityState === "visible" && unbOnScreen()) { liveBalances(true); }
      }, 300000);
    }
  }
  // Views are hidden, not removed, so check that a balance is in the view being shown.
  function unbOnScreen() {
    return Array.prototype.some.call(document.querySelectorAll("[data-unb]"), function (n) { return n.offsetParent !== null; });
  }
  function paintUnb() {
    if (!d) { return; }
    applyLive();
    document.querySelectorAll("[data-unb]").forEach(function (n) {
      var id = n.getAttribute("data-unb");
      if (id === "all") { var s = unbSum(); n.textContent = money(s.sum, { cents: true }); return; }
      var c = byId(d.clients, id), u = c && unbilled(c);
      if (!u) { return; }
      n.textContent = (n.hasAttribute("data-unb-label") ? "At Meta: " : "") + unbilledText(u);
      n.title = asOf(u.at);
    });
  }
  function clientName(cid) { var c = byId(d.clients, cid); return c ? c.business_name : "No client"; }

  /* ======================================================================
     OVERVIEW
     ====================================================================== */
  async function overview(el) {
    el.innerHTML = '<p class="muted" style="padding:24px">Loading...</p>';
    var leadsNew = 0;
    try {
      await load();
      var lr = await T.sb.from("leads").select("id", { count: "exact", head: true }).eq("stage", "new");
      leadsNew = lr.count || 0;
    } catch (e) { T.fail(e); el.innerHTML = '<p class="muted" style="padding:24px">' + esc(e.message) + "</p>"; return; }

    var now = new Date(), y = now.getFullYear(), key = monthKey(y, now.getMonth());
    var prevKey = monthKey(now.getMonth() ? y : y - 1, now.getMonth() ? now.getMonth() - 1 : 11);
    var t = monthTotals(key), tp = monthTotals(prevKey);
    var ytd = 0, bars = [];
    for (var m = 0; m <= now.getMonth(); m++) { var mt = monthTotals(monthKey(y, m)); ytd += mt.income; bars.push({ m: M3[m], v: mt.income, net: mt.net }); }
    var max = Math.max.apply(null, bars.map(function (b) { return b.v; }).concat([1]));
    var current = d.clients.filter(function (c) { return statusOf(c) !== "churned"; });
    var mrr = current.filter(function (c) { return statusOf(c) !== "paused"; }).reduce(function (s, c) {
      return s + monthlyServices(c.id).reduce(function (a, x) { return a + Number(x.price || 0); }, 0);
    }, 0);

    el.innerHTML = '<div class="cl-wrap ov">' +
      '<div class="cl-head"><div><h1>Overview</h1><p class="muted">' + esc(monthLong(key)) + " so far</p></div>" +
      '<div class="cl-actions"><a class="btn" href="#finance">Open Finance</a></div></div>' +
      '<div class="stats">' +
        kpi("Revenue this month", money(t.income), compare(t.income, tp.income)) +
        kpi("Ad spend on our cards", money(t.spend), "Prepaid by clients " + money(t.reimb)) +
        kpi("Partner payouts", money(t.payout), "") +
        (function () {
          var s = unbSum();
          return s.n ? kpi("At Meta, not yet charged", money(s.sum, { cents: true }), "Live from Meta · will hit our cards next").replace("<b>", '<b data-unb="all">') : "";
        })() +
        kpi("Net this month", money(t.net), "Revenue + prepaid − spend − payouts", t.net < 0 ? "bad" : "") +
        kpi("Revenue " + y + " to date", money(ytd), "") +
        kpi("Monthly recurring", money(mrr), current.length + " current clients") +
      "</div>" +
      '<div class="ov-grid"><div>' +
        '<div class="panel"><h2>Needs attention</h2><ul class="todo scroll-block" id="ovTodo">' + attention(key, leadsNew) + "</ul></div>" +
      "</div><aside>" +
        '<div class="panel"><h2>Revenue by month</h2><div class="bars">' + bars.map(function (b) {
          return '<div class="bar" title="' + esc(b.m + ": " + money(b.v) + " revenue, " + money(b.net) + " net") + '"><small>' + esc(b.v ? "$" + (b.v >= 1000 ? (b.v / 1000).toFixed(1) + "k" : Math.round(b.v)) : "") + '</small><i style="height:' + Math.max(2, Math.round(b.v / max * 82)) + '%"></i><span>' + esc(b.m) + "</span></div>";
        }).join("") + "</div></div>" +
        metaStatusPanel() +
      "</aside></div></div>";
    wireReminders(el);
    liveBalances();
  }
  function kpi(label, value, sub, cls) {
    return '<div class="stat' + (cls ? " " + cls : "") + '"><span>' + esc(label) + "</span><b>" + esc(value) + "</b>" + (sub ? "<small>" + esc(sub) + "</small>" : "") + "</div>";
  }
  function compare(a, b) {
    if (!b) { return "Last month " + money(b); }
    var pct = Math.round((a - b) / b * 100);
    return "Last month " + money(b) + " (" + (pct >= 0 ? "+" : "") + pct + "%)";
  }
  function attention(key, leadsNew) {
    var items = [];
    var dayOfMonth = new Date().getDate();
    // Ad spend we fronted that hasn't been covered by a prepayment.
    d.clients.forEach(function (c) {
      if (c.ad_spend_mode === "sgs_included") { return; }   // our cost, nothing to collect
      if (!weFront(c) && !hasAny(c.id, ["ad_spend", "synced_spend"], key.slice(0, 4))) { return; }
      var b = adBalance(c.id, key);
      if (b < -25) {
        items.push({ pri: 1, html: '<b>' + esc(c.business_name) + "</b> owes " + money(-b, { cents: true }) + " in ad spend we fronted" + ' <a href="#finance">Finance</a>' });
      }
    });
    // Active monthly clients with nothing recorded this month (after the 5th).
    if (dayOfMonth > 5) {
      d.clients.forEach(function (c) {
        if (statusOf(c) !== "active" || !monthlyServices(c.id).length) { return; }
        if (!val(c.id, key, "revenue")) {
          items.push({ pri: 2, html: "No payment recorded for <b>" + esc(c.business_name) + "</b> in " + esc(monthLong(key)) + ' <a href="#finance">Add it</a>' });
        }
      });
    }
    // Pay-per-lead: leads from Meta this month, and missing lead prices.
    d.clients.forEach(function (c) {
      if (statusOf(c) === "churned") { return; }
      var pl = perLeadServices(c.id);
      if (!pl.length) { return; }
      var leads = val(c.id, key, "leads");
      if (leads) {
        var price = Number(pl[0].price || 0);
        items.push({ pri: 2, html: "<b>" + esc(c.business_name) + "</b>: " + leads + " lead" + (leads === 1 ? "" : "s") + " this month" +
          (price ? " (" + money(leads * price) + " at " + money(price) + "/lead, " + money(val(c.id, key, "per_lead")) + " billed)" : "") +
          ' <a href="#ppl/' + c.id + '">Charge</a>' });
      }
      if (!Number(pl[0].price)) {
        items.push({ pri: 3, html: "Set a lead price for <a href=\"#client/" + c.id + "\">" + esc(c.business_name) + "</a>" });
      }
    });
    adReminders(items);
    var onb = d.clients.filter(function (c) { return statusOf(c) === "onboarding"; });
    if (onb.length) {
      items.push({ pri: 3, html: onb.length + " client" + (onb.length === 1 ? "" : "s") + " onboarding: " + onb.map(function (c) { return '<a href="#client/' + c.id + '">' + esc(c.business_name) + "</a>"; }).join(", ") });
    }
    if (leadsNew) { items.push({ pri: 2, html: leadsNew + " new website lead" + (leadsNew === 1 ? "" : "s") + ' waiting <a href="#leads">Open</a>' }); }
    var run = d.runs[0];
    var sr = d.stripeRun;
    if (sr && sr.ok === false) { items.push({ pri: 1, html: "Last Stripe sync had a problem: " + esc(sr.message || "unknown error") }); }
    (sr && sr.unmatched || []).forEach(function (u) {
      items.push({ pri: 2, html: "Stripe payments from <b>" + esc(u.name || "unknown customer") + "</b> (" + money(u.amount, { cents: true }) + ") aren't linked to a client. Add their Stripe customer on the client page." });
    });
    if (!run) { items.push({ pri: 3, html: 'Meta isn\'t connected yet. Ad spend and leads will update every hour once it is. <a href="#settings">Settings</a>' }); }
    else if (run.ok === false) { items.push({ pri: 1, html: "Last Meta sync had a problem: " + esc(run.message || "unknown error") + ' <a href="#settings">Settings</a>' }); }
    if (!items.length) { return '<li class="ok">All caught up.</li>'; }
    return items.sort(function (a, b) { return a.pri - b.pri; }).map(function (i) { return '<li class="p' + i.pri + (i.cls ? " " + i.cls : "") + '">' + i.html + "</li>"; }).join("");
  }
  /* Ads went live / paused (from Meta) -> start or pause billing. Each stays until Done is clicked
     (sets ad_events.seen_at). Billing-cycle charges due in the next 2 days show on their own. */
  var REMIND_DAYS = 14;
  function adReminders(items) {
    var t = todayStr(), cutoff = (function () { var x = new Date(); x.setDate(x.getDate() - REMIND_DAYS); return x.getFullYear() + "-" + String(x.getMonth() + 1).padStart(2, "0") + "-" + String(x.getDate()).padStart(2, "0"); })();
    d.events.filter(function (e) {
      return e.source === "meta" && !e.seen_at && e.event_date >= cutoff && e.event_date <= t && /^(launched|relaunched|paused)$/.test(e.kind);
    }).sort(function (a, b) { return a.event_date < b.event_date ? 1 : -1; }).forEach(function (e) {
      var c = byId(d.clients, e.client_id); if (!c) { return; }
      var name = '<a href="#client/' + c.id + '"><b>' + esc(c.business_name) + "</b></a>";
      var mo = monthlyServices(c.id).concat(d.cs.filter(function (x) { return x.client_id === c.id && x.billing_type === "monthly" && x.status === "paused"; }));
      var price = mo.reduce(function (a, x) { return a + Number(x.price || 0); }, 0);
      var ppl = perLeadServices(c.id).length;
      var what = e.kind === "paused"
        ? "Ads paused for " + name + " on " + esc(dateShort(e.event_date)) + ". " + (price ? "Pause their billing (" + money(price) + "/mo)." : ppl ? "No new leads to bill while paused." : "Pause billing if they have any.")
        : "Ads went live for " + name + " on " + esc(dateShort(e.event_date)) + (e.kind === "relaunched" ? " (back on)" : "") + ". " +
          (price ? (e.kind === "relaunched" ? "Restart their billing" : "Start their subscription") + " (" + money(price) + "/mo)." : ppl ? "Lead billing is on." : "Start charging them.");
      items.push({ pri: 0, cls: e.kind === "paused" ? "ad-off" : "ad-on", html: what +
        ' <button class="btn sm done-btn" data-seen="' + e.id + '">Done</button>' });
    });
    d.clients.forEach(function (c) {
      if (statusOf(c) === "churned") { return; }
      var st = window.SGSAds.state(d.events, c.id);
      if (st !== "live" && window.SGSAds.delivering(d.accounts, c)) {
        items.push({ pri: 1, cls: "ad-on", html: 'A campaign is on in Meta for <a href="#client/' + c.id + '"><b>' + esc(c.business_name) + "</b></a> but nothing has spent yet. Billing starts the day it does." });
      }
      if (st !== "live" || !d.cs.some(function (x) { return x.client_id === c.id && x.billing_type === "monthly" && x.status !== "ended"; })) { return; }
      var b = window.SGSAds.cycle(d.events, c.id);
      if (!b) { return; }
      var price = monthlyServices(c.id).reduce(function (a, x) { return a + Number(x.price || 0); }, 0);
      var link = '<a href="#client/' + c.id + '"><b>' + esc(c.business_name) + "</b></a>";
      if (b.day === 1 && b.cycle > 1) {
        items.push({ pri: 1, html: link + ": billing cycle " + b.cycle + " starts today" + (price ? ". Charge " + money(price) + "." : ".") });
      } else if (b.daysLeft <= 1) {
        items.push({ pri: 2, html: link + ": billing cycle " + (b.cycle + 1) + " starts " + esc(dateShort(b.nextCharge)) + (price ? " (" + money(price) + ")" : "") + "." });
      }
    });
  }
  function wireReminders(el) {
    el.querySelectorAll("[data-seen]").forEach(function (btn) {
      btn.onclick = async function () {
        btn.disabled = true;
        try {
          await q(T.sb.from("ad_events").update({ seen_at: new Date().toISOString() }).eq("id", btn.dataset.seen));
          var e = byId(d.events, btn.dataset.seen); if (e) { e.seen_at = new Date().toISOString(); }
          var li = btn.closest("li"); if (li) { li.remove(); }
          var ul = $("ovTodo"); if (ul && !ul.children.length) { ul.innerHTML = '<li class="ok">All caught up.</li>'; }
        } catch (err) { btn.disabled = false; T.fail(err); }
      };
    });
  }
  function metaStatusPanel() {
    var run = d.runs[0];
    var linked = Object.keys(d.acctClient).length;
    return '<div class="panel"><h2>Meta</h2><p class="muted" style="font-size:14px">' +
      (run ? (run.ok ? "Last synced " : "Last sync failed ") + esc(new Date(run.finished_at || run.started_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })) + "." : "Not connected yet.") +
      " " + linked + " ad account" + (linked === 1 ? "" : "s") + ' linked to clients. <a href="#settings">Manage</a></p></div>';
  }

  /* ======================================================================
     REPORTS (the bookkeeping sheet)
     ====================================================================== */
  var view = { range: "ytd", from: "", to: "" };
  var RANGES = [["month", "This month"], ["lastmonth", "Last month"], ["quarter", "This quarter"], ["lastquarter", "Last quarter"],
    ["ytd", "Year to date"], ["12m", "Last 12 months"], ["lastyear", "Last year"], ["custom", "Custom"]];
  // Months (YYYY-MM) in the selected Finance range.
  function rangeKeys() {
    var now = new Date(), y = now.getFullYear(), m = now.getMonth(), q = Math.floor(m / 3) * 3;
    var span = function (y1, m1, y2, m2) { var out = []; for (var yy = y1, mm = m1; yy < y2 || (yy === y2 && mm <= m2); mm++) { if (mm > 11) { mm = 0; yy++; } if (yy > y2 || (yy === y2 && mm > m2)) { break; } out.push(monthKey(yy, mm)); } return out; };
    var pm = m ? m - 1 : 11, py = m ? y : y - 1;
    switch (view.range) {
      case "month": return [monthKey(y, m)];
      case "lastmonth": return [monthKey(py, pm)];
      case "quarter": return span(y, q, y, q + 2);
      case "lastquarter": return q ? span(y, q - 3, y, q - 1) : span(y - 1, 9, y - 1, 11);
      case "12m": return m === 11 ? span(y, 0, y, 11) : span(y - 1, m + 1, y, m);
      case "lastyear": return span(y - 1, 0, y - 1, 11);
      case "custom":
        var f = view.from || monthKey(y, 0), t = view.to || monthKey(y, m);
        if (f > t) { var x = f; f = t; t = x; }
        return span(+f.slice(0, 4), +f.slice(5) - 1, +t.slice(0, 4), +t.slice(5) - 1);
      default: return span(y, 0, y, m);
    }
  }
  function rangeLabel(keys) {
    var r = RANGES.filter(function (x) { return x[0] === view.range; })[0];
    var name = function (k) { return M3[+k.slice(5) - 1] + " " + k.slice(0, 4); };
    var span = keys.length === 1 ? name(keys[0]) : name(keys[0]) + " – " + name(keys[keys.length - 1]);
    return (r && view.range !== "custom" ? r[1] + " · " : "") + span;
  }
  function colLabel(keys) {
    var multi = keys.length && keys[0].slice(0, 4) !== keys[keys.length - 1].slice(0, 4);
    return function (k) { return M3[+k.slice(5) - 1] + (multi ? " ’" + k.slice(2, 4) : ""); };
  }
  function hasAnyIn(cid, cats, keys) {
    var months = d.cell[cid] || {};
    return keys.some(function (k) { return months[k] && cats.some(function (cat) { return months[k][cat]; }); });
  }
  async function reports(el, hash) {
    var m = String(hash || "").match(/^#(?:reports|finance)\/(\d{4})/);
    if (m) { view.range = "custom"; view.from = m[1] + "-01"; view.to = m[1] + "-12"; }
    el.innerHTML = '<p class="muted" style="padding:24px">Loading...</p>';
    try { await load(); } catch (e) { T.fail(e); el.innerHTML = '<p class="muted" style="padding:24px">' + esc(e.message) + "</p>"; return; }
    drawReports(el);
    liveBalances();
  }
  function drawReports(el) {
    var keys = rangeKeys(), lbl = colLabel(keys), y = rangeLabel(keys);
    var curKey = monthKey(new Date().getFullYear(), new Date().getMonth());
    var future = function (k) { return k > curKey; };
    var clients = d.clients.slice();

    // Which clients appear in each section.
    var revRows = clients.filter(function (c) {
      return hasAnyIn(c.id, ["revenue"], keys) || (statusOf(c) !== "churned" && !perLeadServices(c.id).length && (monthlyServices(c.id).length || statusOf(c) === "onboarding"));
    });
    var pplRows = clients.filter(function (c) { return hasAnyIn(c.id, ["per_lead"], keys) || (statusOf(c) !== "churned" && perLeadServices(c.id).length); });
    var adRows = clients.filter(function (c) { return hasAnyIn(c.id, ["ad_spend", "synced_spend", "ad_reimbursement"], keys) || (weFront(c) && statusOf(c) !== "churned"); });
    var payRows = clients.filter(function (c) { return hasAnyIn(c.id, ["partner_payout", "video_shoot"], keys); });
    var feeRows = clients.filter(function (c) { return hasAnyIn(c.id, ["card_fee"], keys); });

    function head(first) {
      return "<colgroup><col class='c-name'><col class='c-st'>" + keys.map(function () { return "<col>"; }).join("") + "<col class='c-tot'></colgroup>" +
        "<thead><tr><th class='sticky'>" + esc(first) + "</th><th class='st'>Status</th>" +
        keys.map(function (k) { return "<th" + (k === curKey ? " class='now'" : "") + ">" + lbl(k) + "</th>"; }).join("") + "<th class='tot'>Total</th></tr></thead>";
    }
    function row(c, cat, opts) {
      opts = opts || {};
      var total = 0;
      var tds = keys.map(function (k) {
        var v = cat === "spend" ? spent(c.id, k) : val(c.id, k, cat);
        total += v;
        var sub = "";
        if (cat === "per_lead") {
          var leads = val(c.id, k, "leads");
          if (leads) { sub = "<small>" + leads + " lead" + (leads === 1 ? "" : "s") + "</small>"; }
        }
        if (cat === "spend" && val(c.id, k, "synced_spend")) { sub = "<small>incl. synced</small>"; }
        return "<td class='c" + (k === curKey ? " now" : "") + (future(k) ? " fut" : "") + "' data-c='" + c.id + "' data-k='" + k + "' data-cat='" + (cat === "spend" ? "ad_spend" : cat) + "' tabindex='0'>" +
          (v ? money(v, { cents: cat === "spend" || cat === "ad_reimbursement" }) : "") + sub + "</td>";
      }).join("");
      return "<tr><th class='sticky'>" + (opts.label ? "<span class='sub'>" + esc(opts.label) + "</span>" : '<a href="#client/' + c.id + '">' + esc(c.business_name) + "</a>") + "</th>" +
        "<td class='st'>" + (opts.label ? "" : statusBadge(statusOf(c))) + "</td>" + tds + "<td class='tot'>" + (total ? money(total, { cents: cat === "spend" || cat === "ad_reimbursement" }) : "") + "</td></tr>";
    }
    function totalRow(label, fn, cents) {
      var sum = 0;
      return "<tfoot><tr><th class='sticky'>" + esc(label) + "</th><td class='st'></td>" + keys.map(function (k) {
        var v = fn(k); sum += v;
        return "<td" + (k === curKey ? " class='now'" : "") + ">" + (v ? money(v, { cents: cents }) : "") + "</td>";
      }).join("") + "<td class='tot'>" + money(sum, { cents: cents }) + "</td></tr></tfoot>";
    }
    function sumCat(rows, cat) { return function (k) { return rows.reduce(function (s, c) { return s + (cat === "spend" ? spent(c.id, k) : val(c.id, k, cat)); }, 0); }; }
    function section(id, title, sub, table, addCat) {
      return '<section class="rep-sec" id="' + id + '"><div class="rep-h"><h2>' + esc(title) + "</h2>" +
        (addCat ? '<button class="btn sm" data-add="' + addCat + '">+ Add amount</button>' : "") + "</div>" +
        (sub ? '<p class="muted rep-sub">' + sub + "</p>" : "") +
        '<div class="sheet-wrap"><table class="sheet">' + table + "</table></div></section>";
    }

    // Summary
    var sumKeys = keys.map(monthTotals);
    function sumLine(label, f, cls) {
      var tot = 0;
      return "<tr class='" + (cls || "") + "'><th class='sticky'>" + esc(label) + "</th><td class='st'></td>" + sumKeys.map(function (t, i) {
        var v = f(t); tot += v;
        return "<td" + (keys[i] === curKey ? " class='now'" : "") + ">" + (v ? money(v) : "") + "</td>";
      }).join("") + "<td class='tot'>" + money(tot) + "</td></tr>";
    }
    var summary = head("Month") + "<tbody>" +
      sumLine("Revenue (retainers + one-time)", function (t) { return t.revenue; }) +
      sumLine("Pay per lead", function (t) { return t.per_lead; }) +
      sumLine("Ad spend prepaid", function (t) { return t.reimb; }) +
      sumLine("Ad spend on our cards", function (t) { return -t.spend; }, "neg") +
      sumLine("Video shoots collected", function (t) { return t.shoot; }) +
      sumLine("Card fees covered", function (t) { return t.fee; }) +
      sumLine("Paid to " + ((d.partners[0] || {}).name || "partner"), function (t) { return -t.payout; }, "neg") +
      "</tbody><tfoot>" + sumLine("Net", function (t) { return t.net; }) + "</tfoot>";

    // Ad spend: three lines per client.
    var adBody = adRows.map(function (c) {
      var bal = "<tr class='bal'><th class='sticky'><span class='sub'>Balance</span></th><td class='st'></td>" + keys.map(function (k) {
        if (future(k) || !hasThrough(c.id, k)) { return "<td" + (k === curKey ? " class='now'" : "") + "></td>"; }
        var b = adBalance(c.id, k);
        return "<td class='" + (b < 0 ? "neg" : "pos") + (k === curKey ? " now" : "") + "'>" + money(b, { cents: true }) + "</td>";
      }).join("") + "<td class='tot'></td></tr>";
      return "<tbody class='grp'>" +
        "<tr class='grp-h'><th class='sticky'><a href=\"#client/" + c.id + "\">" + esc(c.business_name) + "</a></th><td class='st'>" + statusBadge(statusOf(c)) + "</td><td colspan='" + (keys.length + 1) + "' class='mode'>" + esc(modeLabel(c)) + (unbilled(c) ? " · <b class='unb' data-unb='" + c.id + "' data-unb-label title='" + esc(asOf(unbilled(c).at)) + "'>At Meta: " + esc(unbilledText(unbilled(c))) + "</b>" : "") + "</td></tr>" +
        (c.ad_spend_mode === "sgs_included" ? row(c, "spend", { label: "Spent (our cost)" }) :
          row(c, "spend", { label: "Spent" }) + row(c, "ad_reimbursement", { label: "Prepaid" }) + bal) + "</tbody>";
    }).join("");

    var partnerName = (d.partners[0] || {}).name || "partner";
    el.innerHTML = '<div class="cl-wrap rep">' +
      '<div class="cl-head"><div><h1>Finance</h1><p class="muted">' + esc(y) + ". Click any month to see or add amounts.</p></div></div>" +
      '<div class="fin-range"><div class="seg" role="group" aria-label="Time frame">' + RANGES.map(function (r) {
        return '<button class="seg-b' + (view.range === r[0] ? " on" : "") + '" data-frange="' + r[0] + '">' + r[1] + "</button>";
      }).join("") + "</div>" +
      (view.range === "custom" ? '<div class="al-dates"><label>From <input class="inp" type="month" id="finFrom" value="' + keys[0] + '"></label><label>To <input class="inp" type="month" id="finTo" value="' + keys[keys.length - 1] + '"></label></div>' : "") + "</div>" +
      '<nav class="rep-nav"><a href="#" data-jump="secPnl">Profit &amp; loss</a><a href="#" data-jump="secSum">Summary</a><a href="#" data-jump="secRev">Revenue</a><a href="#" data-jump="secPpl">Pay per lead</a><a href="#" data-jump="secAds">Ad spend</a><a href="#" data-jump="secPay">Pay ' + esc(partnerName) + "</a></nav>" +
      pnlSection(y, keys, curKey, lbl) +
      section("secSum", "Summary", "", summary) +
      section("secRev", "Revenue", "Retainers, websites and other one-time work, by the month it was billed.",
        head("Client") + "<tbody>" + revRows.map(function (c) { return row(c, "revenue"); }).join("") + "</tbody>" + totalRow("Total revenue", sumCat(revRows, "revenue")), "revenue") +
      section("secPpl", "Pay per lead", "Amounts billed. Lead counts come from Meta once it's connected.",
        head("Client") + "<tbody>" + pplRows.map(function (c) { return row(c, "per_lead"); }).join("") + "</tbody>" + totalRow("Total pay per lead", sumCat(pplRows, "per_lead")), "per_lead") +
      section("secAds", "Ad spend and prepayments", "Spent = actual Meta charges on our cards (5978, 0719), from billing reports and synced from Meta every hour. Prepaid = what the client paid us up front for ad spend. Balance = prepaid minus spent so far; below zero means they owe us.",
        head("Client") + adBody + totalRow("Total spent", sumCat(adRows, "spend"), true).replace("<tfoot>", "<tfoot class='multi'>").replace("</tfoot>", "") +
        totalRow("Total prepaid", sumCat(adRows, "ad_reimbursement"), true).replace("<tfoot>", "").replace("</tfoot>", "") + "</tfoot>", "ad_reimbursement") +
      section("secPay", "Pay " + partnerName, "Paid = what we paid " + esc(partnerName) + " (we pay before the shoot). Collected = what the client paid us for the shoot ($600 each, from Stripe). Card fees = the 3% clients pay on top when they use a card for shoots or ad prepays.",
        head("Client") + payRows.map(function (c) {
          return "<tbody class='grp'><tr class='grp-h'><th class='sticky'><a href=\"#client/" + c.id + "\">" + esc(c.business_name) + "</a></th><td class='st'>" + statusBadge(statusOf(c)) + "</td><td colspan='" + (keys.length + 1) + "'></td></tr>" +
            row(c, "partner_payout", { label: "Paid " + partnerName }) + row(c, "video_shoot", { label: "Collected for shoots" }) + "</tbody>";
        }).join("") +
        totalRow("Total paid " + partnerName, sumCat(payRows, "partner_payout")).replace("<tfoot>", "<tfoot class='multi'>").replace("</tfoot>", "") +
        totalRow("Total collected for shoots", sumCat(payRows, "video_shoot")).replace("<tfoot>", "").replace("</tfoot>", "") +
        totalRow("Card fees covered (all clients)", sumCat(feeRows, "card_fee"), true).replace("<tfoot>", "").replace("</tfoot>", "") + "</tfoot>", "partner_payout") +
      "</div>";

    el.querySelectorAll("td.c").forEach(function (td) {
      td.onclick = function () { editCell(td.dataset.c, td.dataset.k, td.dataset.cat, el); };
      td.onkeydown = function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); td.onclick(); } };
    });
    el.querySelectorAll("[data-add]").forEach(function (b) { b.onclick = function () { addAmount(b.dataset.add, el); }; });
    el.querySelectorAll("[data-frange]").forEach(function (b) {
      b.onclick = function () {
        if (b.dataset.frange === "custom" && view.range !== "custom") { var ks = rangeKeys(); view.from = ks[0]; view.to = ks[ks.length - 1]; }
        view.range = b.dataset.frange; drawReports(el); liveBalances();
      };
    });
    ["finFrom", "finTo"].forEach(function (id) {
      var i = $(id);
      if (i) { i.onchange = function () { if (i.value) { view[id === "finFrom" ? "from" : "to"] = i.value; drawReports(el); liveBalances(); } }; }
    });
    el.querySelectorAll("[data-jump]").forEach(function (a) {
      a.onclick = function (e) { e.preventDefault(); var s = $(a.dataset.jump); if (s) { s.scrollIntoView({ behavior: "smooth", block: "start" }); } };
    });
    // Start the sheets scrolled so the current month is in view on small screens.
    el.querySelectorAll(".sheet-wrap").forEach(function (w) {
      var now = w.querySelector("th.now");
      if (now && w.scrollWidth > w.clientWidth) { w.scrollLeft = Math.max(0, now.offsetLeft - w.clientWidth / 2); }
    });
  }
  function hasThrough(cid, key) {
    var months = d.cell[cid] || {};
    return Object.keys(months).some(function (k) { return k <= key && (months[k].ad_spend || months[k].synced_spend || months[k].ad_reimbursement); });
  }
  function modeLabel(c) {
    return {
      sgs_prepaid: "We pay Meta, client prepays us", sgs_partner: "We pay Meta, client prepays monthly",
      sgs_included: "We pay Meta, built into their price", client_pays: "Client pays Meta directly", none: "Ad spend setup not set"
    }[c.ad_spend_mode || "none"] || "";
  }

  /* ---------- cell detail / add / edit ---------- */
  function editCell(cid, key, cat, el, editId) {
    var c = byId(d.clients, cid);
    var rows = d.entries.filter(function (e) { return e.client_id === cid && ym(e.month) === key && e.category === cat; });
    var synced = cat === "ad_spend" ? val(cid, key, "synced_spend") : 0;
    var leads = val(cid, key, "leads");
    var editing = editId ? byId(d.entries, editId) : null;
    var total = rows.reduce(function (s, e) { return s + Number(e.amount); }, 0) + synced;
    var price = cat === "per_lead" ? Number((perLeadServices(cid)[0] || {}).price || 0) : 0;

    T.modal("<h2>" + esc(c ? c.business_name : "No client") + "</h2>" +
      "<p class='muted' style='margin:-8px 0 14px'>" + esc(CAT[cat] + " · " + monthLong(key)) + " · <b style='color:var(--text)'>" + money(total, { cents: true }) + "</b></p>" +
      (cat === "per_lead" && leads ? "<p class='hintbox'>Meta reports " + leads + " lead" + (leads === 1 ? "" : "s") + " this month" + (price ? " → " + money(leads * price) + " at " + money(price) + "/lead." : ".") + "</p>" : "") +
      (rows.length || synced ? "<ul class='entries'>" + rows.map(function (e) {
        var locked = e.source === "meta_csv" || e.source === "meta_api";
        return "<li><span class='amt'>" + money(e.amount, { cents: true }) + "</span><span class='what'>" +
          esc([e.entry_date ? dateShort(e.entry_date) : "", e.payment_method, e.note].filter(Boolean).join(" · ") || "—") +
          "<small>" + esc(SOURCE[e.source] || e.source) + (e.created_by ? " · " + esc(e.created_by) : "") + "</small></span>" +
          (locked ? "" : "<span class='act'><button class='btn sm ghost' data-edit='" + e.id + "'>Edit</button><button class='btn sm ghost danger' data-del='" + e.id + "' aria-label='Delete'>×</button></span>") + "</li>";
      }).join("") + (synced ? "<li><span class='amt'>" + money(synced, { cents: true }) + "</span><span class='what'>Daily spend from Meta<small>Meta (synced)</small></span></li>" : "") + "</ul>"
        : "<p class='muted' style='font-size:14px'>Nothing recorded yet.</p>") +
      "<h3>" + (editing ? "Edit amount" : "Add an amount") + "</h3>" +
      "<div class='g3'><div class='fld'><label for='meAmt'>Amount ($)</label><input class='inp' id='meAmt' type='number' step='0.01' inputmode='decimal' value='" + (editing ? esc(editing.amount) : "") + "'></div>" +
      "<div class='fld'><label for='meDate'>Date <span class='opt'>optional</span></label><input class='inp' id='meDate' type='date' value='" + esc(editing ? editing.entry_date || "" : (key === ym(todayStr()) ? todayStr() : "")) + "'></div>" +
      "<div class='fld'><label for='meNote'>Note <span class='opt'>optional</span></label><input class='inp' id='meNote' value='" + esc(editing ? editing.note : "") + "' placeholder='" + (cat === "per_lead" ? "e.g. 4 leads - 10/28/26" : "e.g. Zelle, Stripe invoice") + "'></div></div>" +
      "<div class='mfoot'><button class='btn' id='mCancel'>Close</button><button class='btn gold' id='mSave'>" + (editing ? "Save changes" : "Add") + "</button></div>");
    $("mCancel").onclick = T.closeModal;
    document.querySelectorAll("[data-edit]").forEach(function (b) { b.onclick = function () { editCell(cid, key, cat, el, b.dataset.edit); }; });
    document.querySelectorAll("[data-del]").forEach(function (b) {
      b.onclick = async function () {
        if (!confirm("Delete this amount?")) { return; }
        try { await q(T.sb.from("money_entries").delete().eq("id", b.dataset.del)); await load(true); drawReports(el); editCell(cid, key, cat, el); T.toast("Deleted"); }
        catch (e) { T.fail(e); }
      };
    });
    $("meAmt").focus();
    $("mSave").onclick = async function () {
      var btn = this;
      var amt = parseFloat($("meAmt").value);
      if (!isFinite(amt) || !amt) { T.toast("Enter an amount"); return; }
      var date = $("meDate").value || null;
      // Pay per lead is billed by lead day: without it the Pay per lead tab can't see the day was billed.
      if (cat === "per_lead" && !date) { T.toast("Pick the day the leads came in"); return; }
      if (btn.disabled) { return; }
      btn.disabled = true;
      var row = { amount: Math.round(amt * 100) / 100, entry_date: date, note: $("meNote").value.trim() };
      if (date) { row.month = date.slice(0, 7) + "-01"; }   // a date in another month counts in that month
      try {
        if (editing) {
          await q(T.sb.from("money_entries").update(row).eq("id", editing.id));
        } else {
          var me = await T.sb.auth.getUser();
          row.client_id = cid; row.category = cat; row.month = row.month || key + "-01"; row.source = "manual";
          row.created_by = (me.data && me.data.user && me.data.user.email) || "";
          if (cat === "partner_payout") { row.partner_id = (c && c.partner_id) || ((d.partners[0] || {}).id || null); }
          await q(T.sb.from("money_entries").insert(row));
        }
      } catch (e) { btn.disabled = false; T.fail(e); return; }
      // Saved. If only the refresh fails, don't offer Save again (that would add it twice).
      T.toast(editing ? "Saved" : "Added");
      try { await load(true); drawReports(el); editCell(cid, key, cat, el); }
      catch (e) { T.closeModal(); T.toast("Saved. Refresh the page to see it."); }
    };
  }
  function addAmount(cat, el) {
    var now = new Date();
    var opts = d.clients.slice().sort(function (a, b) {
      var ca = statusOf(a) === "churned" ? 1 : 0, cb = statusOf(b) === "churned" ? 1 : 0;
      return ca - cb || a.business_name.localeCompare(b.business_name);
    });
    T.modal("<h2>Add " + esc(CAT[cat].toLowerCase()) + "</h2>" +
      "<div class='g3'><div class='fld'><label for='aaClient'>Client</label><select class='inp' id='aaClient'>" +
      opts.map(function (c) { return "<option value='" + c.id + "'>" + esc(c.business_name) + (statusOf(c) === "churned" ? " (churned)" : "") + "</option>"; }).join("") + "</select></div>" +
      "<div class='fld'><label for='aaMonth'>Month</label><select class='inp' id='aaMonth'>" + (function () {
        var ks = rangeKeys(), cur = monthKey(now.getFullYear(), now.getMonth());
        if (ks.indexOf(cur) === -1) { ks = ks.concat([cur]); }
        return ks.map(function (k) { return "<option value='" + k + "'" + (k === cur ? " selected" : "") + ">" + M3[+k.slice(5) - 1] + " " + k.slice(0, 4) + "</option>"; }).join("");
      })() + "</select></div>" +
      "<div class='fld'><label for='aaAmt'>Amount ($)</label><input class='inp' id='aaAmt' type='number' step='0.01' inputmode='decimal'></div></div>" +
      "<div class='g3' style='margin-top:12px'><div class='fld'><label for='aaDate'>" + (cat === "per_lead" ? "Lead day" : "Date <span class='opt'>optional</span>") + "</label><input class='inp' id='aaDate' type='date'></div>" +
      "<div class='fld' style='grid-column:span 2'><label for='aaNote'>Note <span class='opt'>optional</span></label><input class='inp' id='aaNote'></div></div>" +
      "<div class='mfoot'><button class='btn' id='mCancel'>Cancel</button><button class='btn gold' id='mSave'>Add</button></div>");
    $("mCancel").onclick = T.closeModal;
    $("mSave").onclick = async function () {
      var amt = parseFloat($("aaAmt").value);
      if (!isFinite(amt) || !amt) { T.toast("Enter an amount"); return; }
      var date = $("aaDate").value || null;
      if (cat === "per_lead" && !date) { T.toast("Pick the day the leads came in"); return; }
      var btn = this;
      if (btn.disabled) { return; }
      btn.disabled = true;
      var cid = $("aaClient").value, c = byId(d.clients, cid);
      try {
        var me = await T.sb.auth.getUser();
        var row = { client_id: cid, category: cat, month: (date ? date.slice(0, 7) : $("aaMonth").value) + "-01", entry_date: date, amount: Math.round(amt * 100) / 100, note: $("aaNote").value.trim(), source: "manual",
          created_by: (me.data && me.data.user && me.data.user.email) || "" };
        if (cat === "partner_payout") { row.partner_id = (c && c.partner_id) || ((d.partners[0] || {}).id || null); }
        await q(T.sb.from("money_entries").insert(row));
      }
      catch (e) { btn.disabled = false; T.fail(e); return; }
      T.closeModal(); T.toast("Added");
      try { await load(true); drawReports(el); } catch (e) { T.toast("Added. Refresh the page to see it."); }
    };
  }

  /* ======================================================================
     CLIENT PAGE PANEL
     ====================================================================== */
  async function clientPanel(el, c) {
    try { await load(); } catch (e) { el.innerHTML = ""; return; }
    var y = new Date().getFullYear(), curKey = monthKey(y, new Date().getMonth());
    var tot = { revenue: 0, per_lead: 0, spend: 0, reimb: 0, payout: 0, leads: 0 };
    M3.forEach(function (_, i) {
      var k = monthKey(y, i);
      tot.revenue += val(c.id, k, "revenue"); tot.per_lead += val(c.id, k, "per_lead");
      tot.spend += spent(c.id, k); tot.reimb += val(c.id, k, "ad_reimbursement");
      tot.payout += val(c.id, k, "partner_payout"); tot.leads += val(c.id, k, "leads");
    });
    var bal = adBalance(c.id, curKey);
    var lines = [
      ["Revenue " + y, money(tot.revenue + tot.per_lead)],
      tot.leads ? ["Leads from Meta " + y, String(tot.leads)] : null,
      tot.spend || weFront(c) ? ["Ad spend on our cards", money(tot.spend, { cents: true })] : null,
      tot.reimb || weFront(c) ? ["Ad spend prepaid", money(tot.reimb, { cents: true })] : null,
      (tot.spend || tot.reimb) && c.ad_spend_mode !== "sgs_included" ? ["Ad balance", '<b class="' + (bal < 0 ? "neg" : "pos") + '">' + money(bal, { cents: true }) + "</b>" + (bal < 0 ? " owed to us" : "")] : null,
      unbilled(c) ? ["Waiting to charge at Meta", '<span data-unb="' + c.id + '">' + esc(unbilledText(unbilled(c))) + "</span>"] : null,
      tot.payout ? ["Paid to partner", money(tot.payout)] : null
    ].filter(Boolean);
    el.innerHTML = '<div class="panel"><h2>Money <a class="btn sm" href="#finance">Finance</a></h2><dl class="kv">' +
      lines.map(function (l) { return "<dt>" + esc(l[0]) + "</dt><dd>" + (String(l[1]).indexOf("<") === 0 ? l[1] : esc(l[1])) + "</dd>"; }).join("") + "</dl></div>";
    if (unbilled(c)) { liveBalances(); }
  }

  /* ======================================================================
     SETTINGS: META CONNECTION
     ====================================================================== */
  async function metaSettings(el) {
    el.innerHTML = '<div class="panel"><h2>Meta ads</h2><p class="muted">Loading...</p></div>';
    var configured = false;
    try {
      await load(true);
      var st = await T.fn("meta-sync", { action: "status" });
      configured = !!(st && st.configured);
    } catch (e) { /* show as not connected */ }
    var run = d.runs[0];
    var known = {};
    d.accounts.forEach(function (a) { known[a.ad_account_id] = a; });
    Object.keys(d.acctClient).forEach(function (id) { if (!known[id]) { known[id] = { ad_account_id: id, name: "", last_error: "" }; } });
    var list = Object.keys(known).map(function (k) { return known[k]; }).sort(function (a, b) {
      var ca = d.acctClient[a.ad_account_id] ? 0 : 1, cb = d.acctClient[b.ad_account_id] ? 0 : 1;
      return ca - cb || String(a.name || "").localeCompare(String(b.name || ""));
    });
    el.innerHTML = '<div class="panel"><h2>Meta ads <span class="badge ' + (configured ? "ok" : "warn") + '">' + (configured ? "Connected" : "Not connected") + "</span></h2>" +
      "<p class='muted' style='font-size:14px;margin-bottom:12px'>" +
      (configured ? "Spend, leads and card charges sync every hour for every ad account our Meta system user can see." :
        "Once the Meta access token is added in Supabase, spend and leads sync every hour. Until then, ad spend comes from the billing reports already imported.") + "</p>" +
      (run ? "<p style='font-size:14px;margin-bottom:12px'>Last sync: " + esc(new Date(run.started_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })) + " · " +
        (run.ok ? "<span style='color:var(--ok)'>OK</span>, " + run.accounts + " accounts, " + run.rows + " days updated" : "<span style='color:var(--bad)'>" + esc(run.message || "failed") + "</span>") + "</p>" : "") +
      "<div class='addfiles' style='margin-bottom:14px'><button class='btn gold' id='metaSync'" + (configured ? "" : " disabled") + ">Sync now</button></div>" +
      "<h3 class='h3'>Ad accounts</h3><div class='acct-list'>" + (list.length ? list.map(function (a) {
        var c = d.acctClient[a.ad_account_id];
        return "<div class='acct'><div><b>" + esc(a.name || "Ad account") + "</b><small>" + esc(a.ad_account_id) + (a.balance != null ? " · " + esc(money(a.balance, { cents: true })) + " not yet charged" : "") + (a.funding_source ? " · " + esc(a.funding_source) : "") +
          (a.last_synced_at ? " · synced " + esc(new Date(a.last_synced_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })) : "") +
          (a.last_error ? " · <span style='color:var(--bad)'>" + esc(a.last_error) + "</span>" : "") + "</small></div>" +
          "<select class='inp' data-acct='" + esc(a.ad_account_id) + "' aria-label='Client for ad account " + esc(a.ad_account_id) + "'><option value=''>Not a client</option>" +
          d.clients.map(function (x) { return "<option value='" + x.id + "'" + (c && c.id === x.id ? " selected" : "") + ">" + esc(x.business_name) + "</option>"; }).join("") + "</select></div>";
      }).join("") : "<p class='muted'>No ad accounts yet.</p>") + "</div></div>";

    var btn = $("metaSync");
    if (btn) {
      btn.onclick = async function () {
        btn.disabled = true; btn.textContent = "Syncing...";
        try {
          var r = await T.fn("meta-sync", {});
          T.toast(r.ok ? "Synced " + r.accounts + " accounts" : (r.message || "Sync had a problem"), 6000);
        } catch (e) { T.fail(e); }
        metaSettings(el);
      };
    }
    el.querySelectorAll("[data-acct]").forEach(function (s) {
      s.onchange = async function () {
        var acct = s.dataset.acct, to = s.value;
        try {
          // Remove from whichever client has it, then add to the chosen one.
          var owners = d.clients.filter(function (x) { return (x.meta_ad_account_ids || []).indexOf(acct) !== -1; });
          for (var i = 0; i < owners.length; i++) {
            await q(T.sb.from("clients").update({ meta_ad_account_ids: owners[i].meta_ad_account_ids.filter(function (z) { return z !== acct; }) }).eq("id", owners[i].id));
          }
          if (to) {
            var target = byId(d.clients, to);
            await q(T.sb.from("clients").update({ meta_ad_account_ids: (target.meta_ad_account_ids || []).filter(function (z) { return z !== acct; }).concat([acct]) }).eq("id", to));
          }
          T.toast("Saved");
          metaSettings(el);
        } catch (e) { T.fail(e); }
      };
    });
  }

  /* ---------- QuickBooks: Profit & Loss by month ---------- */
  /* Combined profit & loss. Income, client ad spend and Stripe fees come from Tracker (Stripe +
     Meta + what's entered by hand); every other expense comes from QuickBooks. QuickBooks' own
     client ad spend line is left out because Tracker's Meta charges are the source of truth. */
  var AD_SPEND_QBO = /meta ad spend|client ad spend/i;
  function pnlSection(y, keys, curKey, lbl) {
    var p = d.pnl;
    var hasQbo = !!(p && p.rows && p.rows.length);
    var cids = Object.keys(d.cell);
    var sum = function (cat) { return keys.map(function (k) { return cids.reduce(function (s, cid) { return s + val(cid, k, cat); }, 0); }); };
    var add = function (a, b) { return a.map(function (v, i) { return v + b[i]; }); };
    var neg = function (a) { return a.map(function (v) { return -v; }); };
    var zero = keys.map(function () { return 0; });
    var col = keys.map(function (k) { return hasQbo ? p.months.indexOf(k.slice(0, 7)) : -1; });
    var qv = function (r) { return col.map(function (i) { return i >= 0 && r.values ? r.values[i] : 0; }); };

    var inc = { revenue: sum("revenue"), ppl: sum("per_lead"), prepaid: sum("ad_reimbursement"), shoot: sum("video_shoot"), cardfee: sum("card_fee") };
    var income = [inc.revenue, inc.ppl, inc.prepaid, inc.shoot, inc.cardfee].reduce(add, zero);
    var adSpend = keys.map(function (k) { return cids.reduce(function (s, cid) { return s + spent(cid, k); }, 0); });
    var fees = sum("stripe_fee");
    var gross = add(income, neg(add(adSpend, fees)));

    var expRows = [], expTotal = zero;
    if (hasQbo) {
      p.rows.forEach(function (r) {
        if (!/^(COGS|Expenses|OtherExpenses)$/.test(r.group || "") || AD_SPEND_QBO.test(r.name)) { return; }
        if (r.kind === "line") { expTotal = add(expTotal, qv(r)); expRows.push({ name: r.name, depth: r.depth, v: qv(r) }); }
        else if (r.kind === "header" && r.depth > 0) { expRows.push({ name: r.name, depth: r.depth, head: true }); }
      });
    }
    var net = add(gross, neg(expTotal));
    var qboIncome = zero;
    if (hasQbo) { p.rows.forEach(function (r) { if (r.kind === "total" && /^total income$/i.test(r.name)) { qboIncome = qv(r); } }); }

    function line(name, v, cls, depth) {
      var tot = 0;
      // Each amount below zero shows red (gross and net profit rows color by sign, month by month).
      var tds = v.map(function (x, j) { tot += x; var c = (keys[j] === curKey ? "now" : "") + (x < 0 ? " neg" : ""); return "<td" + (c.trim() ? " class='" + c.trim() + "'" : "") + ">" + (x ? money(x) : "") + "</td>"; }).join("");
      return "<tr class='" + (cls || "pl-l") + "'><th class='sticky' style='padding-left:" + (14 + (depth || 1) * 14) + "px'>" + esc(name) + "</th><td class='st'></td>" + tds + "<td class='tot" + (tot < 0 ? " neg" : "") + "'>" + (tot ? money(tot) : "") + "</td></tr>";
    }
    function head(name, depth) {
      return "<tr class='pl-h'><th class='sticky' style='padding-left:" + (14 + (depth || 0) * 14) + "px'>" + esc(name) + "</th><td class='st'></td>" + keys.map(function () { return "<td></td>"; }).join("") + "<td class='tot'></td></tr>";
    }
    var key = function (name, v) { var t = v.reduce(function (a, b) { return a + b; }, 0); return line(name, v, "pl-t pl-key" + (t < 0 ? " neg" : ""), 0); };

    var body = head("Income (Tracker)") +
      line("Retainers and one-time work", inc.revenue) + line("Pay per lead", inc.ppl) + line("Ad spend prepaid by clients", inc.prepaid) +
      line("Video shoots collected", inc.shoot) + line("Card fees clients covered", inc.cardfee) +
      line("Total income", income, "pl-t", 0) +
      head("Cost of delivery (Tracker)") +
      line("Client ad spend (Meta)", adSpend) + line("Stripe fees", fees) +
      line("Total cost of delivery", add(adSpend, fees), "pl-t", 0) +
      key("Gross profit", gross) +
      head("Expenses (QuickBooks)") +
      (hasQbo ? expRows.map(function (r) { return r.head ? head(r.name, r.depth) : line(r.name, r.v, "pl-l", r.depth); }).join("") : "") +
      line("Total expenses", expTotal, "pl-t", 0) +
      key("Net profit", net) +
      (hasQbo ? line("For reference: QuickBooks total income", qboIncome, "pl-ref", 0) : "");

    var thead = "<colgroup><col class='c-name'><col class='c-st'>" + keys.map(function () { return "<col>"; }).join("") + "<col class='c-tot'></colgroup>" +
      "<thead><tr><th class='sticky'>Profit &amp; loss</th><th class='st'></th>" + keys.map(function (k) { return "<th" + (k === curKey ? " class='now'" : "") + ">" + lbl(k) + "</th>"; }).join("") + "<th class='tot'>Total</th></tr></thead>";
    var note = hasQbo ? "Income, client ad spend and Stripe fees come from Tracker. All other expenses come from QuickBooks" + (p.company_name ? " (" + esc(p.company_name) + ")" : "") +
        ", updated every hour" + (p.fetched_at ? ", last " + esc(new Date(p.fetched_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })) : "") +
        ". QuickBooks' own client ad spend line is left out." + (fees.some(Boolean) ? "" : " Stripe fees show once the Stripe key can read balances.")
      : (p && p.ok === false ? "QuickBooks had a problem: " + esc(p.message) + ". Reconnect it in Settings. " : "") + 'Connect QuickBooks in <a href="#settings">Settings</a> to add your other expenses.';
    return '<section class="rep-sec" id="secPnl"><div class="rep-h"><h2>Profit &amp; loss</h2></div><p class="muted rep-sub">' + note + "</p>" +
      '<div class="sheet-wrap"><table class="sheet pl">' + thead + "<tbody>" + body + "</tbody></table></div></section>";
  }

  async function qboSettings(el) {
    if (!el) { return; }
    el.innerHTML = '<div class="panel"><h2>QuickBooks</h2><p class="muted">Loading...</p></div>';
    var st = {};
    try { st = await T.fn("qbo-auth", { action: "status" }); } catch (e) { st = { error: e.message }; }
    var flag = (location.hash.match(/qbo=(\w+)/) || [])[1];
    var note = { connected: "QuickBooks is connected.", cancelled: "Connecting was cancelled.", expired: "That sign-in link expired. Try again.", failed: "QuickBooks didn't accept the connection. Check the Client ID and Secret in Supabase and try again." }[flag];
    el.innerHTML = '<div class="panel"><h2>QuickBooks</h2>' +
      (note ? '<div class="hintbox">' + esc(note) + "</div>" : "") +
      (st.connected ?
        '<p>Connected' + (st.company ? " to <b>" + esc(st.company) + "</b>" : "") + (st.connected_by ? " by " + esc(st.connected_by) : "") + ". Tracker reads your Profit &amp; Loss every hour; it never changes anything in QuickBooks.</p>" +
        (st.last ? '<p class="muted">Last update ' + esc(new Date(st.last.fetched_at).toLocaleString("en-US")) + (st.last.ok === false ? " · problem: " + esc(st.last.message) : "") + "</p>" : "") +
        '<div style="display:flex;gap:8px;flex-wrap:wrap">' + (st.last && st.last.ok === false ? '<button class="btn sm gold" id="qboGo">Reconnect QuickBooks</button>' : "") + '<button class="btn sm" id="qboSync">Update now</button><button class="btn sm ghost" id="qboOff">Disconnect</button></div>'
      : st.configured ?
        '<p class="muted">Show income, expenses and profit from your books on the Finance page. Tracker only reads from QuickBooks.</p><button class="btn gold" id="qboGo">Connect QuickBooks</button>'
      : '<p class="muted">To connect, add <code>QBO_CLIENT_ID</code> and <code>QBO_CLIENT_SECRET</code> (from your Intuit developer app) in Supabase → Edge Functions → Secrets, then come back here.</p>') +
      "</div>";
    if ($("qboGo")) {
      $("qboGo").onclick = async function () {
        this.disabled = true;
        try { var r = await T.fn("qbo-auth", { action: "start" }); if (r.url) { location.href = r.url; } else { T.toast(r.error || "Couldn't start"); this.disabled = false; } }
        catch (e) { T.fail(e); this.disabled = false; }
      };
    }
    if ($("qboSync")) {
      $("qboSync").onclick = async function () {
        this.disabled = true; this.textContent = "Updating...";
        try { var r = await T.fn("qbo-auth", { action: "sync" }); T.toast(r.ok ? "QuickBooks updated" : (r.message || "Problem updating"), 6000); } catch (e) { T.fail(e); }
        qboSettings(el);
      };
      $("qboOff").onclick = async function () {
        if (!window.confirm("Disconnect QuickBooks? The Profit & Loss section stops updating.")) { return; }
        try { await T.fn("qbo-auth", { action: "disconnect" }); } catch (e) { T.fail(e); }
        qboSettings(el);
      };
    }
  }

  window.SGSReports = {
    init: function (helpers) { T = helpers; },
    invalidate: function () { loadedAt = 0; },
    overview: overview, reports: reports, metaSettings: metaSettings, clientPanel: clientPanel, qboSettings: qboSettings
  };
})();
