/* Solid Gold Systems Tracker - Pay per lead tab (#ppl, #ppl/<client id>)
   Daily lead counts from Meta (meta_daily), what's been billed (money_entries per_lead),
   and a Charge button per day that bills the client's saved card through the ppl-charge
   Edge Function ("3 Leads - 10/27/26").
   Investment: SGS pays for the video shoot (clients.ppl_shoot_cost, once, from the day ads start)
   and the ad spend (actual Meta spend; clients.ppl_daily_budget is only used to project ahead).
   Break-even counts money actually charged; valid leads not charged yet show as pending.
   Void: a bad lead (meta_leads / ghl_contacts .voided_at) comes off its day's billable count. */
(function () {
  "use strict";
  var T = null;
  var cardCache = {};     // client id -> {card, price, configured}

  function esc(s) { return T.esc(s); }
  function $(id) { return document.getElementById(id); }
  async function q(p) { var r = await p; if (r.error) { throw r.error; } return r.data; }
  function money(n) {
    var v = Number(n || 0), frac = Math.round(Math.abs(v) * 100) % 100 !== 0;
    return (v < 0 ? "-$" : "$") + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: frac ? 2 : 0, maximumFractionDigits: frac ? 2 : 0 });
  }
  function ymd(d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
  function dayLabel(s) {
    var n = new Date(), d = new Date(s + "T12:00:00"), t = ymd(n), y = ymd(new Date(n.getFullYear(), n.getMonth(), n.getDate() - 1));
    var name = s === t ? "Today" : s === y ? "Yesterday" : d.toLocaleDateString("en-US", { weekday: "short" });
    return "<b>" + esc(name) + "</b><small>" + esc(d.toLocaleDateString("en-US", { month: "short", day: "numeric" })) + "</small>";
  }

  function localDay(iso) { return ymd(new Date(iso)); }
  // Clients and prices, then everything for the client on screen (all its days, since ads started).
  async function load(wantId) {
    var res = await Promise.all([
      q(T.sb.from("clients").select("id,business_name,status,meta_ad_account_ids,stripe_customer_ids,ppl_shoot_cost,ppl_daily_budget,ppl_start").order("business_name")),
      q(T.sb.from("client_services").select("client_id,billing_type,price,status").eq("billing_type", "per_lead")),
      q(T.sb.from("meta_sync_runs").select("started_at,ok").order("started_at", { ascending: false }).limit(1))
    ]);
    var svc = res[1].filter(function (s) { return s.status !== "ended"; });
    var clients = res[0].filter(function (c) { return c.status !== "churned" && svc.some(function (s) { return s.client_id === c.id; }); });
    var out = { clients: clients, svc: svc, lastSync: res[2][0] || null, daily: [], billed: [], leads: [], events: [] };
    var c = clients.filter(function (x) { return x.id === wantId; })[0] || clients[0];
    if (!c) { return out; }
    var accts = (c.meta_ad_account_ids || []).filter(function (a) { return /^\d+$/.test(a); });
    var det = await Promise.all([
      accts.length ? q(T.sb.from("meta_daily").select("ad_account_id,day,leads,spend").in("ad_account_id", accts).order("day").limit(5000)) : Promise.resolve([]),
      q(T.sb.from("money_entries").select("*").eq("category", "per_lead").eq("client_id", c.id).order("entry_date").limit(5000)),
      q(T.sb.from("meta_leads").select("id,created_time,name,phone,email,campaign_name,ad_name,form_name,voided_at,void_reason,voided_by").eq("client_id", c.id).order("created_time", { ascending: false }).limit(5000)),
      q(T.sb.from("ghl_contacts").select("id,date_added,name,phone,email,campaign_name,form_name,source,facebook_lead_id,voided_at,void_reason,voided_by").eq("client_id", c.id).order("date_added", { ascending: false }).limit(5000)).catch(function () { return []; }),
      q(T.sb.from("ad_events").select("client_id,kind,event_date,source,created_at").eq("client_id", c.id))
    ]);
    out.daily = det[0]; out.billed = det[1]; out.events = det[4];
    // GHL contacts that are the same person as a Meta lead are already listed; the rest are website/funnel leads.
    var metaIds = {};
    det[2].forEach(function (l) { metaIds[l.id] = 1; });
    out.leads = det[2].map(function (l) { return Object.assign({ key: l.id, when: l.created_time, src: l.form_name || "Meta form" }, l); })
      .concat(det[3].filter(function (g) { return !(g.facebook_lead_id && metaIds[g.facebook_lead_id]); }).map(function (g) {
        return Object.assign({}, g, { key: "ghl:" + g.id, when: g.date_added, src: g.form_name || g.source || "Website form" });
      }))
      .sort(function (a, b) { return a.when < b.when ? 1 : -1; });
    out.leads.forEach(function (l) { l.day = localDay(l.when); });
    return out;
  }

  var el = null, data = null, routeGen = 0;
  async function route(hash, container) {
    var gen = ++routeGen;
    el = container;
    el.innerHTML = '<p class="muted" style="padding:24px">Loading...</p>';
    var next;
    var m = String(hash).match(/^#ppl\/([0-9a-f-]{36})/);
    try { next = await load(m ? m[1] : null); } catch (e) { if (gen === routeGen) { T.fail(e); el.innerHTML = '<p class="muted" style="padding:24px">' + esc(e.message) + "</p>"; } return; }
    if (gen !== routeGen) { return; }
    data = next;
    draw(m ? m[1] : (data.clients[0] && data.clients[0].id));
  }

  function priceOf(cid) { var s = data.svc.filter(function (x) { return x.client_id === cid; })[0]; return s ? Number(s.price || 0) : 0; }
  // Billable leads per day: Meta's daily count minus voided leads, or the leads listed that day if
  // that's more (Meta's daily totals lag behind the leads themselves by an hour or so).
  function leadsByDay(c) {
    var accts = c.meta_ad_account_ids || [], meta = {}, listed = {}, out = {};
    data.daily.forEach(function (r) { if (accts.indexOf(r.ad_account_id) !== -1 && Number(r.leads)) { meta[r.day] = (meta[r.day] || 0) + Number(r.leads); } });
    data.leads.forEach(function (l) { if (!l.voided_at) { listed[l.day] = (listed[l.day] || 0) + 1; } });
    var v = voidsByDay();
    Object.keys(meta).concat(Object.keys(listed)).forEach(function (d) {
      var n = Math.max((meta[d] || 0) - (v[d] || 0), listed[d] || 0, 0);
      if (n) { out[d] = n; }
    });
    return out;
  }
  function voidsByDay() { var v = {}; data.leads.forEach(function (l) { if (l.voided_at) { v[l.day] = (v[l.day] || 0) + 1; } }); return v; }
  function spendByDay(c) {
    var accts = c.meta_ad_account_ids || [], out = {};
    data.daily.forEach(function (r) { if (accts.indexOf(r.ad_account_id) !== -1 && Number(r.spend)) { out[r.day] = (out[r.day] || 0) + Number(r.spend); } });
    return out;
  }
  function billedByDay(cid) {
    var out = {};
    data.billed.forEach(function (e) { if (e.client_id === cid && e.entry_date) { (out[e.entry_date] = out[e.entry_date] || []).push(e); } });
    return out;
  }
  function isPending(e) { return /^pending:/.test(e.external_ref || ""); }
  // First day of the investment: set by hand, else the first day ads went live, else the first day with spend.
  function startOf(c, spend) {
    if (c.ppl_start) { return c.ppl_start; }
    var on = data.events.filter(function (e) { return e.kind === "launched" || e.kind === "relaunched"; }).map(function (e) { return e.event_date; }).sort();
    if (on.length) { return on[0]; }
    var d = Object.keys(spend).sort();
    return d[0] || ymd(new Date());
  }
  function addDays(s, n) { var d = new Date(s + "T12:00:00"); d.setDate(d.getDate() + n); return ymd(d); }
  function longDate(s) { return new Date(s + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); }

  /* Investment and break-even for one client. */
  function economics(c, price, leads, billed, spend) {
    var start = startOf(c, spend), today = ymd(new Date());
    var shoot = Number(c.ppl_shoot_cost != null ? c.ppl_shoot_cost : 600), budget = Number(c.ppl_daily_budget != null ? c.ppl_daily_budget : 50);
    var charged = 0, pending = 0, spent = 0, pendingLeads = 0, billedLeads = 0;
    var months = {}, daySet = {};
    function mo(k) { return months[k] || (months[k] = { leads: 0, charged: 0, pending: 0, spend: 0, shoot: 0 }); }
    Object.keys(spend).forEach(function (d) { if (d >= start && d <= today) { spent += spend[d]; mo(d.slice(0, 7)).spend += spend[d]; daySet[d] = 1; } });
    Object.keys(leads).forEach(function (d) {
      if (d < start || d > today) { return; }
      mo(d.slice(0, 7)).leads += leads[d]; daySet[d] = 1;
      var b = (billed[d] || []).filter(function (e) { return !isPending(e); });
      if (!b.length) { pending += leads[d] * price; pendingLeads += leads[d]; mo(d.slice(0, 7)).pending += leads[d] * price; }
    });
    Object.keys(billed).forEach(function (d) {
      if (d < start) { return; }
      billed[d].forEach(function (e) { if (isPending(e)) { return; } charged += Number(e.amount); billedLeads += Number(e.quantity || 0); mo(d.slice(0, 7)).charged += Number(e.amount); });
      daySet[d] = 1;
    });
    mo(start.slice(0, 7)).shoot = shoot;
    // Break-even day: walk day by day, charged in vs. shoot + spend out.
    var run = -shoot, evenOn = null, d = start;
    for (var i = 0; i < 1500 && d <= today; i++, d = addDays(d, 1)) {
      run -= spend[d] || 0;
      (billed[d] || []).forEach(function (e) { if (!isPending(e)) { run += Number(e.amount); } });
      if (run >= 0 && evenOn === null) { evenOn = d; } else if (run < 0) { evenOn = null; }
    }
    var invested = shoot + spent, net = charged - invested;
    // Projection at the last 14 days' pace (or since start, if shorter).
    var yest = addDays(today, -1), from = addDays(today, -14);
    if (from < start) { from = start; }
    var nDays = 0, recent = 0;
    for (var x = from; x <= yest; x = addDays(x, 1)) { nDays++; recent += leads[x] || 0; }
    var perDay = nDays ? recent / nDays : 0, dailyNet = perDay * price - budget;
    var remaining = invested - charged - pending;
    var proj = null;
    if (remaining > 0 && dailyNet > 0) { var days = Math.ceil(remaining / dailyNet); proj = { date: addDays(today, days), days: days }; }
    return {
      start: start, shoot: shoot, budget: budget, spent: spent, invested: invested, charged: charged, pending: pending, pendingLeads: pendingLeads,
      net: net, evenOn: net >= 0 ? evenOn : null, remaining: remaining, perDay: perDay, dailyNet: dailyNet, proj: proj,
      leadsNeeded: price ? Math.ceil(Math.max(0, remaining) / price) : null, months: months
    };
  }

  function draw(cid) {
    var c = data.clients.filter(function (x) { return x.id === cid; })[0];
    if (!data.clients.length) {
      el.innerHTML = '<div class="cl-wrap"><div class="cl-head"><h1>Pay per lead</h1></div><p class="muted">No pay-per-lead clients yet. Add a "per lead" service to a client and they show up here.</p></div>';
      return;
    }
    if (!c) { c = data.clients[0]; }
    shown = c.id;
    var price = priceOf(c.id), leads = leadsByDay(c), billed = billedByDay(c.id), spend = spendByDay(c), voids = voidsByDay();
    var ec = economics(c, price, leads, billed, spend);
    var month = ymd(new Date()).slice(0, 7);
    var mLeads = 0, mBilledLeads = 0, mBilled = 0, unbilledDays = 0, unbilledLeads = 0;
    Object.keys(leads).forEach(function (dd) { if (dd.slice(0, 7) === month) { mLeads += leads[dd]; } });
    Object.keys(billed).forEach(function (dd) {
      billed[dd].forEach(function (e) { if (dd.slice(0, 7) === month) { mBilledLeads += Number(e.quantity || 0); mBilled += Number(e.amount); } });
    });
    var today = ymd(new Date());
    Object.keys(leads).forEach(function (dd) { if (!billed[dd] && dd < today) { unbilledDays++; unbilledLeads += leads[dd]; } });

    // Rows: every day in the window that had leads or a charge, newest first; always show today and yesterday.
    var days = {};
    Object.keys(leads).forEach(function (k) { days[k] = 1; });
    Object.keys(billed).forEach(function (k) { days[k] = 1; });
    Object.keys(voids).forEach(function (k) { days[k] = 1; });
    Object.keys(spend).forEach(function (k) { if (k >= ec.start) { days[k] = 1; } });
    days[today] = 1; days[addDays(today, -1)] = 1;
    var list = Object.keys(days).sort().reverse();

    el.innerHTML = '<div class="cl-wrap ppl">' +
      '<div class="cl-head"><div><h1>Pay per lead</h1><p class="muted">Leads from Meta each day. Check the count, then charge the card on file.</p></div>' +
      '<div class="cl-actions"><button class="btn" id="pplSync">Refresh leads from Meta</button></div></div>' +
      '<div class="seg ppl-clients" role="tablist">' + data.clients.map(function (x) {
        return '<a class="seg-b' + (x.id === c.id ? " on" : "") + '" href="#ppl/' + x.id + '">' + esc(x.business_name) + "</a>";
      }).join("") + "</div>" +
      '<div class="stats">' +
        stat("Price per lead", price ? money(price) : "Not set", price ? "" : '<a href="#client/' + c.id + '">Set it on the client</a>') +
        stat("Card on file", '<em id="pplCard">Checking...</em>', "") +
        stat("Leads this month", mLeads, "From Meta, minus voided") +
        stat("Billed this month", money(mBilled), mBilledLeads + " leads") +
        stat("Not billed yet", unbilledLeads + " leads", unbilledDays ? unbilledDays + " day" + (unbilledDays === 1 ? "" : "s") + (price ? " · " + money(unbilledLeads * price) : "") : "All caught up", unbilledLeads ? "warn" : "") +
      "</div>" +
      '<div id="pplBanner"></div>' +
      investPanel(c, price, ec) +
      '<h2 class="ppl-h">By day</h2>' +
      '<div class="panel ppl-days scroll-block"><div class="ppl-row ppl-th"><span>Day</span><span>Leads</span><span>Ad spend · net</span><span>Charge</span><span></span></div>' +
      list.map(function (dd) {
        var n = leads[dd] || 0, b = billed[dd];
        var paidAmt = (b || []).filter(function (e) { return !isPending(e); }).reduce(function (a, e) { return a + Number(e.amount); }, 0);
        var paidQty = (b || []).filter(function (e) { return !isPending(e); }).reduce(function (a, e) { return a + Number(e.quantity || 0); }, 0);
        var sp = spend[dd] || 0, dayNet = (b ? paidAmt : n * price) - sp;
        var owed = voids[dd] && b && paidQty > n ? (paidQty - n) * price : 0;
        var mid = '<span class="ppl-sp">' + (sp ? money(sp) + '<small class="' + (dayNet < 0 ? "neg" : "pos") + '">' + (dayNet >= 0 ? "+" : "") + money(dayNet) + (b ? "" : " if charged") + "</small>" : '<span class="muted">—</span>') + "</span>";
        var right;
        if (b) {
          var charging = b.some(function (e) { return /^pending:/.test(e.external_ref || ""); });
          right = '<span class="ppl-billed">' + (charging ? '<span class="badge warn">Charging…</span> ' : '<span class="badge ok">Billed</span> ') + b.map(function (e) {
            return esc((e.quantity ? e.quantity + " lead" + (e.quantity === 1 ? "" : "s") + " · " : "") + money(e.amount));
          }).join(", ") + (owed ? ' <span class="badge warn" title="A lead on this day was voided after it was charged">' + money(owed) + " to refund/credit</span>" : "") +
            '</span><button class="btn sm ghost" data-again="' + dd + '">Charge again</button>';
        } else if (dd === today) {
          right = '<span class="muted ppl-note">Charge tomorrow, once the day is done</span><span></span>';
        } else {
          right = '<span class="ppl-charge"><input class="inp" type="number" min="0" max="500" step="1" inputmode="numeric" value="' + n + '" data-n="' + dd + '" aria-label="Leads to charge for ' + dd + '"><span class="ppl-amt" data-amt="' + dd + '">' + (price ? money(n * price) : "") + "</span></span>" +
            '<button class="btn sm gold" data-charge="' + dd + '"' + (n && price ? "" : " disabled") + ">Charge</button>";
        }
        return '<div class="ppl-row' + (b ? " done" : n ? " due" : "") + '"><span class="ppl-day">' + dayLabel(dd) + '</span><span class="ppl-n">' + (n || "<span class='muted'>0</span>") +
          (voids[dd] ? '<small class="ppl-void">' + voids[dd] + " voided</small>" : "") + "</span>" + mid + right + "</div>";
      }).join("") + "</div>" +
      leadsBlock(billed, today) +
      '<p class="muted" style="font-size:12px;margin-top:10px">Meta counts leads in the ad account\'s time zone and updates every hour (last refresh ' +
      esc(data.lastSync ? new Date(data.lastSync.started_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "never") +
      "). Charges show on Finance under Pay per lead.</p></div>";

    el.querySelectorAll("[data-n]").forEach(function (inp) {
      inp.oninput = function () {
        var v = Math.max(0, Math.floor(Number(inp.value) || 0)), dd = inp.dataset.n;
        el.querySelector('[data-amt="' + dd + '"]').textContent = price ? money(v * price) : "";
        el.querySelector('[data-charge="' + dd + '"]').disabled = !(v && price);
      };
    });
    el.querySelectorAll("[data-charge]").forEach(function (b) {
      b.onclick = function () { confirmCharge(c, b.dataset.charge, Math.floor(Number(el.querySelector('[data-n="' + b.dataset.charge + '"]').value) || 0), price, false); };
    });
    el.querySelectorAll("[data-again]").forEach(function (b) {
      b.onclick = function () { confirmCharge(c, b.dataset.again, leads[b.dataset.again] || 1, price, true); };
    });
    wireInvest(c);
    wireLeads(c);
    $("pplSync").onclick = async function () {
      var btn = $("pplSync"); btn.disabled = true; btn.textContent = "Refreshing...";
      // Just the new leads (a few seconds); the full Meta sync runs on its own every hour.
      try { var r = await T.fn("meta-sync", { action: "leads" }); T.toast(r.added ? r.added + " new lead" + (r.added === 1 ? "" : "s") : "Up to date", 4000); }
      catch (e) { T.fail(e); }
      route("#ppl/" + c.id, el);
    };
    cardInfo(c);
  }

  /* Investment & break-even panel. */
  function investPanel(c, price, ec) {
    var t = function (v) { return money(Math.round(v * 100) / 100); };
    var status = ec.net >= 0
      ? '<b class="pos">Broke even' + (ec.evenOn ? " on " + esc(longDate(ec.evenOn)) : "") + "</b> · " + t(ec.net) + " ahead"
      : '<b class="neg">' + t(-ec.net) + " to go</b>" + (ec.pending ? " · " + t(ec.pending) + " pending (" + ec.pendingLeads + " lead" + (ec.pendingLeads === 1 ? "" : "s") + " not charged yet)" : "");
    var proj = ec.remaining <= 0
      ? (ec.net < 0 ? "Charging the pending leads covers it." : "")
      : ec.proj ? "At the last 14 days' pace (" + ec.perDay.toFixed(1) + " leads/day, " + t(ec.budget) + "/day ad budget) you break even around <b>" + esc(longDate(ec.proj.date)) + "</b>, " + ec.proj.days + " day" + (ec.proj.days === 1 ? "" : "s") + " from now."
      : "Not on pace to break even: " + ec.perDay.toFixed(1) + " leads/day × " + t(price) + " is less than the " + t(ec.budget) + "/day ad budget.";
    var mk = Object.keys(ec.months).sort(), run = 0;
    var rows = mk.map(function (k) {
      var m = ec.months[k], net = m.charged - m.spend - m.shoot; run += net;
      var label = new Date(k + "-15T12:00:00").toLocaleDateString("en-US", { month: "short", year: "numeric" });
      return "<tr><th>" + esc(label) + "</th><td>" + m.leads + "</td><td>" + t(m.charged) + "</td><td class='muted'>" + (m.pending ? t(m.pending) : "—") + "</td><td>" + t(m.spend) + "</td><td>" + (m.shoot ? t(m.shoot) : "—") +
        "</td><td class='" + (net < 0 ? "neg" : "pos") + "'>" + t(net) + "</td><td class='" + (run < 0 ? "neg" : "pos") + "'><b>" + t(run) + "</b></td></tr>";
    }).join("");
    return '<div class="panel ppl-inv"><h2>Our investment <span class="muted ppl-inv-sub">since ' + esc(longDate(ec.start)) + ' · <button class="linkbtn" id="pplStart">change</button></span></h2>' +
      '<div class="ppl-inv-set"><label>Video shoot <span class="money-in"><span>$</span><input class="inp" id="pplShoot" inputmode="decimal" value="' + esc(ec.shoot) + '"></span></label>' +
      '<label>Daily ad budget <span class="money-in"><span>$</span><input class="inp" id="pplBudget" inputmode="decimal" value="' + esc(ec.budget) + '"></span></label>' +
      '<small class="muted">Spend below is the actual Meta spend; the daily budget is only used for the projection.</small></div>' +
      '<div class="ppl-inv-grid">' +
        '<div><span>Invested</span><b>' + t(ec.invested) + '</b><small>' + t(ec.shoot) + " shoot + " + t(ec.spent) + " ad spend</small></div>" +
        '<div><span>Charged</span><b>' + t(ec.charged) + '</b><small>' + (ec.pending ? "+ " + t(ec.pending) + " pending" : "Nothing pending") + "</small></div>" +
        '<div class="' + (ec.net >= 0 ? "pos" : "neg") + '"><span>Net</span><b>' + t(ec.net) + "</b><small>" + (ec.net >= 0 ? "Paid back" : ec.leadsNeeded != null ? "≈ " + ec.leadsNeeded + " more lead" + (ec.leadsNeeded === 1 ? "" : "s") + " covers it" : "") + "</small></div>" +
      "</div>" +
      '<p class="ppl-inv-status">' + status + (proj ? "<br><span class='muted'>" + proj + "</span>" : "") + "</p>" +
      '<div class="sheet-wrap"><table class="ppl-months"><thead><tr><th>Month</th><th>Leads</th><th>Charged</th><th>Pending</th><th>Ad spend</th><th>Shoot</th><th>Month net</th><th>Running total</th></tr></thead><tbody>' + rows + "</tbody></table></div></div>";
  }
  function wireInvest(c) {
    function save(field, input) {
      input.onchange = async function () {
        var v = parseFloat(String(input.value).replace(/[$,\s]/g, ""));
        if (!isFinite(v) || v < 0) { T.toast("Enter an amount"); return; }
        var patch = {}; patch[field] = v;
        try { await q(T.sb.from("clients").update(patch).eq("id", c.id)); c[field] = v; T.toast("Saved"); if (onClient(c.id)) { draw(c.id); } }
        catch (e) { T.fail(e); }
      };
    }
    save("ppl_shoot_cost", $("pplShoot"));
    save("ppl_daily_budget", $("pplBudget"));
    $("pplStart").onclick = function () {
      T.modal("<h2>Investment start</h2><p class='muted' style='font-size:14px'>The day the shoot and ad spend start counting. Leave empty to use the day ads went live.</p>" +
        "<div class='fld'><label for='psDate'>Start date</label><input class='inp' type='date' id='psDate' value='" + esc(c.ppl_start || "") + "'></div>" +
        "<div class='mfoot'><button class='btn' id='mCancel'>Cancel</button><button class='btn gold' id='mSave'>Save</button></div>");
      $("mCancel").onclick = T.closeModal;
      $("mSave").onclick = async function () {
        var v = $("psDate").value || null;
        try { await q(T.sb.from("clients").update({ ppl_start: v }).eq("id", c.id)); c.ppl_start = v; T.closeModal(); if (onClient(c.id)) { draw(c.id); } }
        catch (e) { T.fail(e); }
      };
    };
  }

  /* Every lead for the client, with Void / Undo. */
  var REASONS = ["Invalid number", "Duplicate", "Spam or test", "Outside service area", "Other"];
  function leadsBlock(billed, today) {
    var list = data.leads;
    return '<h2 class="ppl-h">All leads <span class="muted">' + list.length + "</span></h2>" +
      '<div class="panel ppl-leads scroll-block">' + (list.length ? '<div class="ppl-lead ppl-th"><span>When</span><span>Lead</span><span>Source</span><span>Status</span><span></span></div>' + list.map(function (l) {
        var paid = (billed[l.day] || []).some(function (e) { return !isPending(e); });
        var st = l.voided_at ? '<span class="badge">Voided</span><small>' + esc(l.void_reason || "") + "</small>"
          : paid ? '<span class="badge ok">Billed day</span>' : l.day === today ? '<span class="muted">Today</span>' : '<span class="badge warn">Not billed</span>';
        var tel = String(l.phone || "");
        return '<div class="ppl-lead' + (l.voided_at ? " voided" : "") + '"><span class="ppl-when">' + esc(new Date(l.when).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })) + "</span>" +
          '<span class="ppl-who"><b>' + esc(l.name || "No name") + "</b><small>" + esc([tel, l.email].filter(Boolean).join(" · ")) + "</small></span>" +
          '<span class="ppl-src">' + esc(l.campaign_name || l.src || "") + "</span>" +
          '<span class="ppl-st">' + st + "</span>" +
          (l.voided_at ? '<button class="btn sm ghost" data-unvoid="' + esc(l.key) + '">Undo</button>' : '<button class="btn sm ghost" data-void="' + esc(l.key) + '">Void</button>') + "</div>";
      }).join("") : '<p class="muted" style="padding:16px">No leads listed yet.</p>') + "</div>";
  }
  async function setVoid(key, reason) {
    var me = await T.sb.auth.getUser();
    var patch = reason ? { voided_at: new Date().toISOString(), void_reason: reason, voided_by: (me.data && me.data.user && me.data.user.email) || "" } : { voided_at: null, void_reason: "", voided_by: "" };
    var ghl = key.indexOf("ghl:") === 0;
    await q(T.sb.from(ghl ? "ghl_contacts" : "meta_leads").update(patch).eq("id", ghl ? key.slice(4) : key));
  }
  function wireLeads(c) {
    el.querySelectorAll("[data-void]").forEach(function (b) {
      b.onclick = function () {
        var l = data.leads.filter(function (x) { return x.key === b.dataset.void; })[0];
        T.modal("<h2>Void lead</h2><p class='muted' style='font-size:14px'>" + esc((l && l.name) || "This lead") + " won't be billed. If its day was already charged, the day shows the amount to refund or credit.</p>" +
          "<div class='fld'><label for='vdWhy'>Reason</label><select class='inp' id='vdWhy'>" + REASONS.map(function (r) { return "<option>" + esc(r) + "</option>"; }).join("") + "</select></div>" +
          "<div class='fld' style='margin-top:10px'><label for='vdNote'>Note <span class='opt'>optional</span></label><input class='inp' id='vdNote'></div>" +
          "<div class='mfoot'><button class='btn' id='mCancel'>Cancel</button><button class='btn gold' id='mSave'>Void lead</button></div>");
        $("mCancel").onclick = T.closeModal;
        $("mSave").onclick = async function () {
          var btn = $("mSave"); if (btn.disabled) { return; } btn.disabled = true;
          var note = $("vdNote").value.trim(), reason = $("vdWhy").value + (note ? ": " + note : "");
          try { await setVoid(b.dataset.void, reason); T.closeModal(); T.toast("Lead voided"); data = await load(c.id); if (onClient(c.id)) { draw(c.id); } }
          catch (e) { btn.disabled = false; T.fail(e); }
        };
      };
    });
    el.querySelectorAll("[data-unvoid]").forEach(function (b) {
      b.onclick = async function () {
        b.disabled = true;
        try { await setVoid(b.dataset.unvoid, null); T.toast("Void undone"); data = await load(c.id); if (onClient(c.id)) { draw(c.id); } }
        catch (e) { b.disabled = false; T.fail(e); }
      };
    });
  }

  function stat(label, value, sub, cls) {
    return '<div class="stat' + (cls ? " " + cls : "") + '"><span>' + esc(label) + "</span><b>" + (String(value).indexOf("<") === 0 ? value : esc(value)) + "</b>" + (sub ? "<small>" + sub + "</small>" : "") + "</div>";
  }

  var shown = null;   // client on screen right now
  function onClient(cid) { return shown === cid && location.hash.indexOf("#ppl") === 0; }
  async function cardInfo(c) {
    var info = cardCache[c.id];
    if (!info) {
      try { info = await T.fn("ppl-charge", { action: "info", client_id: c.id }); }
      catch (e) { info = { ok: false, error: e.message }; }
      // Only keep a found card; "no card" or an error is asked again next time.
      if (info && info.ok && info.card) { cardCache[c.id] = info; }
      if (!onClient(c.id)) { return; }
      if (info && info.imported) { T.toast("Found " + info.imported + " earlier lead charge(s) in Stripe"); data = await load(c.id); if (onClient(c.id)) { draw(c.id); } return; }
    }
    var cardEl = $("pplCard");
    if (!cardEl) { return; }
    if (info && info.configured === false) {
      cardEl.textContent = "—";
      $("pplBanner").innerHTML = '<div class="hintbox">Stripe isn\'t connected to Tracker yet, so charging is off. Add the Stripe key in Supabase (Edge Functions → Secrets → <code>STRIPE_SECRET_KEY</code>) and it turns on.</div>';
      el.querySelectorAll("[data-charge],[data-again]").forEach(function (b) { b.disabled = true; });
      return;
    }
    cardEl.textContent = info && info.card ? info.card : "No saved card";
    if (info && info.ok && !info.card) {
      $("pplBanner").innerHTML = '<div class="hintbox">No saved card for ' + esc(c.business_name) + ' in Stripe. Send them a payment link once to save their card.</div>';
      el.querySelectorAll("[data-charge],[data-again]").forEach(function (b) { b.disabled = true; });
    }
  }

  function confirmCharge(c, day, leads, price, again) {
    if (!(leads >= 1)) { T.toast("Enter how many leads"); return; }
    var info = cardCache[c.id] || {};
    var d = new Date(day + "T12:00:00");
    var desc = leads + " Lead" + (leads === 1 ? "" : "s") + " - " + (d.getMonth() + 1) + "/" + d.getDate() + "/" + String(d.getFullYear()).slice(2);
    T.modal("<h2>Charge " + esc(c.business_name) + "</h2>" +
      (again ? "<p class='hintbox'>This day was already billed. This makes a second, separate charge.</p>" : "") +
      "<dl class='kv' style='margin:6px 0 4px'>" +
      "<dt>Leads</dt><dd>" + leads + " × " + esc(money(price)) + "</dd>" +
      "<dt>Amount</dt><dd><b style='font-size:20px'>" + esc(money(leads * price)) + "</b></dd>" +
      "<dt>Card</dt><dd>" + esc(info.card || "Card on file") + "</dd>" +
      "<dt>Shows in Stripe as</dt><dd>" + esc(desc) + "</dd></dl>" +
      "<div class='mfoot'><button class='btn' id='mCancel'>Cancel</button><button class='btn gold' id='mSave'>Charge " + esc(money(leads * price)) + "</button></div>");
    $("mCancel").onclick = T.closeModal;
    $("mSave").onclick = async function () {
      var btn = $("mSave"); btn.disabled = true; btn.textContent = "Charging...";
      try {
        var r = await T.fn("ppl-charge", { action: "charge", client_id: c.id, day: day, leads: leads, again: !!again });
        if (!r || !r.ok) { throw new Error((r && r.error) || "Charge failed"); }
        T.closeModal();
        T.toast("Charged " + money(r.amount) + " to " + (r.card || "card") + " (" + r.description + ")", 6000);
        data = await load(c.id); if (onClient(c.id)) { draw(c.id); }
      } catch (e) {
        btn.disabled = false; btn.textContent = "Try again";
        T.toast(e.message, 7000);
      }
    };
  }

  window.SGSPpl = { init: function (h) { T = h; }, route: route };
})();
