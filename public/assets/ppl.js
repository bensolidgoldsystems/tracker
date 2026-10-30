/* Solid Gold Systems Tracker - Pay per lead tab (#ppl, #ppl/<client id>)
   Daily lead counts from Meta (meta_daily), what's been billed (money_entries per_lead),
   and a Charge button per day that bills the client's saved card through the ppl-charge
   Edge Function ("3 Leads - 10/27/26"). */
(function () {
  "use strict";
  var T = null;
  var DAYS = 45;
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

  async function load() {
    var since = ymd(new Date(Date.now() - DAYS * 864e5));
    var res = await Promise.all([
      q(T.sb.from("clients").select("id,business_name,status,meta_ad_account_ids,stripe_customer_ids").order("business_name")),
      q(T.sb.from("client_services").select("client_id,billing_type,price,status").eq("billing_type", "per_lead")),
      q(T.sb.from("meta_daily").select("ad_account_id,day,leads,spend").gte("day", since).order("day")),
      q(T.sb.from("money_entries").select("*").eq("category", "per_lead").gte("entry_date", since).order("entry_date")),
      q(T.sb.from("meta_sync_runs").select("started_at,ok").order("started_at", { ascending: false }).limit(1))
    ]);
    var svc = res[1].filter(function (s) { return s.status !== "ended"; });
    var clients = res[0].filter(function (c) { return c.status !== "churned" && svc.some(function (s) { return s.client_id === c.id; }); });
    return { clients: clients, svc: svc, daily: res[2], billed: res[3], lastSync: res[4][0] || null, since: since };
  }

  var el = null, data = null, routeGen = 0;
  async function route(hash, container) {
    var gen = ++routeGen;
    el = container;
    el.innerHTML = '<p class="muted" style="padding:24px">Loading...</p>';
    var next;
    try { next = await load(); } catch (e) { if (gen === routeGen) { T.fail(e); el.innerHTML = '<p class="muted" style="padding:24px">' + esc(e.message) + "</p>"; } return; }
    if (gen !== routeGen) { return; }
    data = next;
    var m = String(hash).match(/^#ppl\/([0-9a-f-]{36})/);
    var id = m ? m[1] : (data.clients[0] && data.clients[0].id);
    draw(id);
  }

  function priceOf(cid) { var s = data.svc.filter(function (x) { return x.client_id === cid; })[0]; return s ? Number(s.price || 0) : 0; }
  function leadsByDay(c) {
    var accts = c.meta_ad_account_ids || [], out = {};
    data.daily.forEach(function (r) { if (accts.indexOf(r.ad_account_id) !== -1 && Number(r.leads)) { out[r.day] = (out[r.day] || 0) + Number(r.leads); } });
    return out;
  }
  function billedByDay(cid) {
    var out = {};
    data.billed.forEach(function (e) { if (e.client_id === cid && e.entry_date) { (out[e.entry_date] = out[e.entry_date] || []).push(e); } });
    return out;
  }

  function draw(cid) {
    var c = data.clients.filter(function (x) { return x.id === cid; })[0];
    if (!data.clients.length) {
      el.innerHTML = '<div class="cl-wrap"><div class="cl-head"><h1>Pay per lead</h1></div><p class="muted">No pay-per-lead clients yet. Add a "per lead" service to a client and they show up here.</p></div>';
      return;
    }
    if (!c) { c = data.clients[0]; }
    shown = c.id;
    var price = priceOf(c.id), leads = leadsByDay(c), billed = billedByDay(c.id);
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
    days[today] = 1; days[ymd(new Date(Date.now() - 864e5))] = 1;
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
        stat("Leads this month", mLeads, "From Meta") +
        stat("Billed this month", money(mBilled), mBilledLeads + " leads") +
        stat("Not billed yet", unbilledLeads + " leads", unbilledDays ? unbilledDays + " day" + (unbilledDays === 1 ? "" : "s") + (price ? " · " + money(unbilledLeads * price) : "") : "All caught up", unbilledLeads ? "warn" : "") +
      "</div>" +
      '<div id="pplBanner"></div>' +
      '<div class="panel ppl-days"><div class="ppl-row ppl-th"><span>Day</span><span>Meta leads</span><span>Charge</span><span></span></div>' +
      list.map(function (dd) {
        var n = leads[dd] || 0, b = billed[dd];
        var right;
        if (b) {
          right = '<span class="ppl-billed"><span class="badge ok">Billed</span> ' + b.map(function (e) {
            return esc((e.quantity ? e.quantity + " lead" + (e.quantity === 1 ? "" : "s") + " · " : "") + money(e.amount));
          }).join(", ") + '</span><button class="btn sm ghost" data-again="' + dd + '">Charge again</button>';
        } else if (dd === today) {
          right = '<span class="muted ppl-note">Charge tomorrow, once the day is done</span><span></span>';
        } else {
          right = '<span class="ppl-charge"><input class="inp" type="number" min="0" max="500" step="1" inputmode="numeric" value="' + n + '" data-n="' + dd + '" aria-label="Leads to charge for ' + dd + '"><span class="ppl-amt" data-amt="' + dd + '">' + (price ? money(n * price) : "") + "</span></span>" +
            '<button class="btn sm gold" data-charge="' + dd + '"' + (n && price ? "" : " disabled") + ">Charge</button>";
        }
        return '<div class="ppl-row' + (b ? " done" : n ? " due" : "") + '"><span class="ppl-day">' + dayLabel(dd) + '</span><span class="ppl-n">' + (n || "<span class='muted'>0</span>") + "</span>" + right + "</div>";
      }).join("") + "</div>" +
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
    $("pplSync").onclick = async function () {
      var btn = $("pplSync"); btn.disabled = true; btn.textContent = "Refreshing...";
      try { var r = await T.fn("meta-sync", {}); T.toast(r.ok ? "Leads refreshed" : (r.message || "Refresh had a problem"), 5000); }
      catch (e) { T.fail(e); }
      route("#ppl/" + c.id, el);
    };
    cardInfo(c);
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
      if (info && info.imported) { T.toast("Found " + info.imported + " earlier lead charge(s) in Stripe"); data = await load(); if (onClient(c.id)) { draw(c.id); } return; }
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
        data = await load(); draw(c.id);
      } catch (e) {
        btn.disabled = false; btn.textContent = "Try again";
        T.toast(e.message, 7000);
      }
    };
  }

  window.SGSPpl = { init: function (h) { T = h; }, route: route };
})();
