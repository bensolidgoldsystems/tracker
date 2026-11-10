/* Solid Gold Systems Tracker - Ecom sites tab (#ecom, #ecom/<client id>)
   Shopify store clients, one at a time (like Pay per lead): build stage, store details, the build
   checklist, what they've paid us (money_entries, Stripe lines with "Shopify"/"ecom" are category
   ecom), and their store's sales by month (entered by hand: ecom_stores.sales).
   A client shows here once it has an ecom_stores row ("+ Add store client"). */
(function () {
  "use strict";
  var T = null;

  var STAGES = [["kickoff", "Kickoff"], ["building", "Building"], ["review", "Client review"], ["live", "Live"], ["paused", "Paused"]];
  var CHECKLIST = [
    ["Setup", [["account", "Shopify account and plan"], ["domain", "Domain connected"], ["theme", "Theme installed and set up"], ["brand", "Logo, colors and fonts"]]],
    ["Catalog", [["products", "Products added (titles, prices, variants)"], ["photos", "Product photos"], ["collections", "Collections and navigation"], ["inventory", "Inventory and SKUs"]]],
    ["Checkout", [["payments", "Payments (Shopify Payments / PayPal)"], ["shipping", "Shipping rates"], ["taxes", "Taxes"], ["policies", "Refund, privacy, shipping and terms pages"]]],
    ["Launch", [["pages", "Home, About and Contact pages"], ["emails", "Order emails branded"], ["tracking", "Meta pixel and Google Analytics"], ["apps", "Apps (reviews, email signup...)"], ["testorder", "Test order placed and refunded"], ["launched", "Password removed, store live"]]]
  ];
  var AFTER = [["", "Not decided"], ["handoff", "Hand off the keys"], ["per_change", "Pay per change"], ["monthly", "Monthly plan"]];
  var ECOM_SVC = /shopify|ecom|\berp\b/i, MGMT = /shopify store management/i;
  var INCOME = { ecom: "Ecom", revenue: "Other work", card_fee: "Card fee covered", per_lead: "Pay per lead", ad_reimbursement: "Ad spend prepaid", video_shoot: "Video shoot" };

  function esc(s) { return T.esc(s); }
  function $(id) { return document.getElementById(id); }
  async function q(p) { var r = await p; if (r.error) { throw r.error; } return r.data; }
  function ro() { return T.readOnly && T.readOnly(); }
  function money(n) {
    var v = Number(n || 0), frac = Math.round(Math.abs(v) * 100) % 100 !== 0;
    return (v < 0 ? "-$" : "$") + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: frac ? 2 : 0, maximumFractionDigits: frac ? 2 : 0 });
  }
  function fmtDay(s) { return s ? new Date(s + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : ""; }
  function monthName(k) { return new Date(k + "-01T12:00:00").toLocaleDateString("en-US", { month: "long", year: "numeric" }); }
  function href(u) { u = String(u || "").trim(); return !u ? "" : /^https?:\/\//i.test(u) ? u : "https://" + u; }
  function stat(label, value, sub, cls) { return '<div class="stat' + (cls ? " " + cls : "") + '"><span>' + esc(label) + "</span><b>" + value + "</b>" + (sub ? "<small>" + sub + "</small>" : "") + "</div>"; }

  var el = null, data = null, routeGen = 0, shown = null;
  async function load(wantId) {
    var res = await Promise.all([
      q(T.sb.from("ecom_stores").select("*")),
      q(T.sb.from("clients").select("id,business_name,status,lead_id,website").order("business_name")),
      q(T.sb.from("client_services").select("id,client_id,service_id,billing_type,price,status")),
      q(T.sb.from("services").select("id,name,description,active,default_price,billing_types,default_billing_type"))
    ]);
    var stores = {}; res[0].forEach(function (s) { stores[s.client_id] = s; });
    var out = { stores: stores, all: res[1], cs: res[2], services: res[3], entries: [] };
    out.clients = res[1].filter(function (c) { return stores[c.id]; });
    var c = out.clients.filter(function (x) { return x.id === wantId; })[0] || out.clients[0];
    if (c) {
      out.entries = await q(T.sb.from("money_entries").select("id,category,entry_date,month,amount,note,source,payment_method").eq("client_id", c.id)
        .in("category", Object.keys(INCOME)).order("entry_date", { ascending: false, nullsFirst: false }).limit(500));
    }
    return out;
  }

  async function route(hash, container) {
    var gen = ++routeGen;
    el = container;
    if (!data) { el.innerHTML = '<p class="muted" style="padding:24px">Loading...</p>'; }
    var m = String(hash).match(/^#ecom\/([0-9a-f-]{36})/), next;
    try { next = await load(m ? m[1] : null); } catch (e) { if (gen === routeGen) { T.fail(e); el.innerHTML = '<p class="muted" style="padding:24px">' + esc(e.message) + "</p>"; } return; }
    if (gen !== routeGen) { return; }
    data = next;
    draw(m ? m[1] : null);
  }
  function reload() { return route(location.hash, el); }

  function svcName(s) { var x = data.services.filter(function (v) { return v.id === s.service_id; })[0]; return x ? x.name : ""; }
  function storeServices(cid) {
    return data.cs.filter(function (s) { return s.client_id === cid && s.status !== "ended" && ECOM_SVC.test(svcName(s)); });
  }
  function svcByName(re) { return data.services.filter(function (v) { return re.test(v.name); })[0]; }
  function today() { var t = new Date(); return t.getFullYear() + "-" + String(t.getMonth() + 1).padStart(2, "0") + "-" + String(t.getDate()).padStart(2, "0"); }

  function draw(cid) {
    var head = '<div class="cl-head"><div><h1>Ecom sites</h1><p class="muted">Shopify store clients: build progress, store details, what they\'ve paid us and how their store is doing.</p></div>' +
      (ro() ? "" : '<div class="cl-actions"><button class="btn gold" id="ecAdd">+ Add store client</button></div>') + "</div>";
    if (!data.clients.length) {
      el.innerHTML = '<div class="cl-wrap ecom">' + head + '<div class="panel"><p class="muted">No store clients yet. Add one to start tracking the build.</p></div></div>';
      wireHead(); return;
    }
    var c = data.clients.filter(function (x) { return x.id === cid; })[0] || data.clients[0];
    shown = c.id;
    var st = data.stores[c.id], cl = st.checklist || {};
    var svcs = storeServices(c.id);
    var build = svcs.filter(function (s) { return s.billing_type === "one_time"; }).reduce(function (a, s) { return a + Number(s.price || 0); }, 0);
    var monthly = svcs.filter(function (s) { return s.billing_type === "monthly" && s.status === "active"; }).reduce(function (a, s) { return a + Number(s.price || 0); }, 0);
    var paidEcom = data.entries.filter(function (e) { return e.category === "ecom"; }).reduce(function (a, e) { return a + Number(e.amount); }, 0);
    var paidAll = data.entries.reduce(function (a, e) { return a + Number(e.amount); }, 0);
    var items = [], done = 0;
    CHECKLIST.forEach(function (g) { g[1].forEach(function (it) { items.push(it); if (cl[it[0]]) { done++; } }); });
    var due = build && monthly === 0 ? Math.max(0, build - paidEcom) : 0;
    var stageLabel = (STAGES.filter(function (s) { return s[0] === st.stage; })[0] || [0, st.stage])[1];

    // Store sales by month, newest first.
    var sales = st.sales || {}, months = Object.keys(sales).sort().reverse();
    var salesTot = months.reduce(function (a, k) { return a + Number(sales[k].revenue || 0); }, 0);

    el.innerHTML = '<div class="cl-wrap ecom">' + head +
      '<div class="seg ppl-clients" role="tablist">' + data.clients.map(function (x) {
        return '<a class="seg-b' + (x.id === c.id ? " on" : "") + '" href="#ecom/' + x.id + '">' + esc(x.business_name) + "</a>";
      }).join("") + "</div>" +
      '<div class="stats">' +
        stat("Stage", esc(stageLabel), st.launch_date ? (st.stage === "live" ? "Launched " : "Launch ") + esc(fmtDay(st.launch_date)) : "No launch date yet", st.stage === "live" ? "ok" : "") +
        stat("Build checklist", done + " / " + items.length, Math.round(done * 100 / items.length) + "% done") +
        stat("One-time work", build ? money(build) : "None yet", build ? svcs.filter(function (s) { return s.billing_type === "one_time"; }).map(function (s) { return esc(svcName(s)); }).join(", ") : "Add a service below") +
        stat("Monthly", monthly ? money(monthly) + "/mo" : "$0", monthly ? svcs.filter(function (s) { return s.billing_type === "monthly" && s.status === "active"; }).map(function (s) { return esc(svcName(s)); }).join(", ") : "No monthly plans") +
        stat("Paid us", money(paidAll), paidAll !== paidEcom ? money(paidEcom) + " for the store" : "All time, from Stripe and Tracker") +
        (build && !monthly ? stat("Balance due", money(due), due ? "One-time work minus paid" : "Paid in full", due ? "warn" : "") : "") +
      "</div>" +
      '<div class="panel ec-stages"><span class="ec-lbl">Stage</span><div class="seg">' + STAGES.map(function (s) {
        return '<button class="seg-b' + (st.stage === s[0] ? " on" : "") + '" data-stage="' + s[0] + '"' + (ro() ? " disabled" : "") + ">" + s[1] + "</button>";
      }).join("") + "</div>" +
      '<span class="ec-lbl">After launch</span><div class="seg">' + AFTER.map(function (a) {
        var lbl = a[0] === "per_change" ? "Pay per change" + (svcByName(/store changes/i) ? " (" + money(svcByName(/store changes/i).default_price) + ")" : "") :
          a[0] === "monthly" ? "Monthly plan" + (svcByName(MGMT) ? " (" + money(svcByName(MGMT).default_price) + "/mo)" : "") : a[1];
        return '<button class="seg-b' + ((st.after_launch || "") === a[0] ? " on" : "") + '" data-after="' + a[0] + '"' + (ro() ? " disabled" : "") + ">" + esc(lbl) + "</button>";
      }).join("") + "</div></div>" +
      '<div class="ec-grid">' +
        '<div class="panel ec-check"><h2>Build checklist</h2><div class="bigbar"><div class="pbar"><i style="width:' + Math.round(done * 100 / items.length) + '%"></i></div><span>' + done + "/" + items.length + "</span></div>" +
          CHECKLIST.map(function (g) {
            var gd = g[1].filter(function (it) { return cl[it[0]]; }).length;
            return '<div class="cl-sec"><h3><span>' + esc(g[0]) + "</span><span>" + gd + "/" + g[1].length + "</span></h3>" + g[1].map(function (it) {
              return '<div class="cl-item"><input type="checkbox" id="ec_' + it[0] + '" data-ck="' + it[0] + '"' + (cl[it[0]] ? " checked" : "") + (ro() ? " disabled" : "") + '><label for="ec_' + it[0] + '">' + esc(it[1]) + "</label></div>";
            }).join("") + "</div>";
          }).join("") + "</div>" +
        '<div class="ec-side">' +
          '<div class="panel"><div class="rep-h"><h2>Store</h2>' + (ro() ? "" : '<button class="btn sm" id="ecEdit">Edit</button>') + "</div>" +
            '<dl class="ec-dl">' +
              dl("Platform", esc(st.platform || "Shopify") + (st.plan ? " · " + esc(st.plan) : "")) +
              dl("Store", st.store_url ? '<a href="' + esc(href(st.store_url)) + '" target="_blank" rel="noopener">' + esc(st.store_url) + "</a>" : "") +
              dl("Shopify admin", st.admin_url ? '<a href="' + esc(href(st.admin_url)) + '" target="_blank" rel="noopener">Open admin</a>' : "") +
              dl("Domain", esc(st.domain)) +
              dl("Launch date", esc(fmtDay(st.launch_date))) +
              dl("Client", '<a href="#client/' + c.id + '">Client page</a>' + (c.lead_id ? ' · <a href="#lead/' + c.lead_id + '">Brief and files</a>' : "")) +
              (st.notes ? dl("Notes", T.linkify ? T.linkify(esc(st.notes)) : esc(st.notes), true) : "") +
            "</dl></div>" +
          '<div class="panel"><div class="rep-h"><h2>Services</h2>' + (ro() ? "" : '<button class="btn sm" id="ecSvc">+ Add</button>') + "</div>" +
            (svcs.length ? '<div class="ec-pay">' + svcs.map(function (s) {
              return '<div class="ec-pay-r"><span><b>' + esc(svcName(s)) + "</b><small>" + (s.billing_type === "monthly" ? "Monthly" : "One-time") + (s.start_date ? " · since " + esc(fmtDay(s.start_date)) : "") + "</small></span><span>" +
                (s.price != null ? money(s.price) + (s.billing_type === "monthly" ? "/mo" : "") : '<span class="muted">No price</span>') + "</span></div>";
            }).join("") + "</div>" : '<p class="muted">No store services yet.</p>') +
            '<p class="muted ec-foot">Change prices on the <a href="#client/' + c.id + '">client page</a>. Marketing (Meta ads) goes on the client like any ad client.</p></div>' +
          '<div class="panel"><h2>Payments</h2>' + (data.entries.length ? '<div class="ec-pay">' + data.entries.map(function (e) {
            return '<div class="ec-pay-r"><span><b>' + money(e.amount) + "</b><small>" + esc(INCOME[e.category] || e.category) + (e.note ? " · " + esc(e.note) : "") + "</small></span><span class='muted'>" + esc(fmtDay(e.entry_date) || monthName(String(e.month).slice(0, 7))) + "</span></div>";
          }).join("") + "</div>" : '<p class="muted">Nothing paid yet. Stripe invoices show up here within the hour.</p>') + "</div>" +
        "</div>" +
      "</div>" +
      '<h2 class="ppl-h">Store sales</h2>' +
      '<div class="panel"><p class="muted rep-sub">How their store is doing, by month (from their Shopify Analytics).' + (salesTot ? " Total so far: <b>" + money(salesTot) + "</b>." : "") + "</p>" +
        (months.length ? '<div class="ec-sales"><div class="ec-sales-r ec-th"><span>Month</span><span>Orders</span><span>Sales</span><span>Avg order</span><span></span></div>' + months.map(function (k) {
          var r = sales[k], o = Number(r.orders || 0), v = Number(r.revenue || 0);
          return '<div class="ec-sales-r"><span>' + esc(monthName(k)) + "</span><span>" + o + "</span><span>" + money(v) + "</span><span>" + (o ? money(Math.round(v / o * 100) / 100) : "—") + "</span><span>" +
            (ro() ? "" : '<button class="btn sm ghost" data-sale="' + k + '">Edit</button>') + "</span></div>";
        }).join("") + "</div>" : '<p class="muted">No months added yet.</p>') +
        (ro() ? "" : '<button class="btn sm" id="ecSale" style="margin-top:12px">+ Add a month</button>') +
      "</div>" +
      "</div>";
    wireHead();
    wire(c, st);
  }
  function dl(k, v, wide) { return v ? '<div class="' + (wide ? "wide" : "") + '"><dt>' + esc(k) + "</dt><dd>" + v + "</dd></div>" : ""; }

  async function save(cid, patch) {
    patch.updated_at = new Date().toISOString();
    await q(T.sb.from("ecom_stores").update(patch).eq("client_id", cid));
    Object.assign(data.stores[cid], patch);
  }

  function wire(c, st) {
    el.querySelectorAll("[data-stage]").forEach(function (b) {
      b.onclick = async function () {
        var stage = b.dataset.stage; if (stage === st.stage) { return; }
        var patch = { stage: stage };
        if (stage === "live" && !st.launch_date) { var t = new Date(); patch.launch_date = t.getFullYear() + "-" + String(t.getMonth() + 1).padStart(2, "0") + "-" + String(t.getDate()).padStart(2, "0"); }
        try { await save(c.id, patch); draw(c.id); T.toast("Stage: " + b.textContent); } catch (e) { T.fail(e); }
      };
    });
    // Checklist clicks are saved one after another, each on top of the last.
    var chain = Promise.resolve();
    el.querySelectorAll("[data-ck]").forEach(function (box) {
      box.onchange = function () {
        var id = box.dataset.ck, on = box.checked;
        chain = chain.then(async function () {
          var cl = Object.assign({}, data.stores[c.id].checklist || {});
          if (on) { cl[id] = new Date().toISOString(); } else { delete cl[id]; }
          try { await save(c.id, { checklist: cl }); } catch (e) { box.checked = !on; T.fail(e); return; }
          if (shown === c.id && !el.querySelector("[data-ck]:focus-visible")) { var y = window.scrollY; draw(c.id); window.scrollTo(0, y); }
        });
      };
    });
    if ($("ecEdit")) { $("ecEdit").onclick = function () { editStore(c, st); }; }
    if ($("ecSvc")) { $("ecSvc").onclick = function () { addService(c); }; }
    el.querySelectorAll("[data-after]").forEach(function (b) {
      b.onclick = async function () {
        var v = b.dataset.after; if (v === (st.after_launch || "")) { return; }
        var mgmt = svcByName(MGMT);
        var active = data.cs.filter(function (s) { return s.client_id === c.id && mgmt && s.service_id === mgmt.id && s.status === "active"; });
        try {
          await save(c.id, { after_launch: v });
          // The monthly plan is the Store Management service on the client: start it, or end it when they switch.
          if (v === "monthly" && mgmt && !active.length) {
            await q(T.sb.from("client_services").insert({ client_id: c.id, service_id: mgmt.id, billing_type: "monthly", price: mgmt.default_price, status: "active", start_date: today() }));
          }
          if (v !== "monthly" && active.length && confirm("End their " + mgmt.name + " ($" + Number(active[0].price || 0) + "/mo)?")) {
            await q(T.sb.from("client_services").update({ status: "ended", end_date: today() }).in("id", active.map(function (s) { return s.id; })));
          }
        } catch (e) { T.fail(e); }
        T.toast("After launch: " + b.textContent);
        reload();
      };
    });
    if ($("ecSale")) { $("ecSale").onclick = function () { editSale(c, st, null); }; }
    el.querySelectorAll("[data-sale]").forEach(function (b) { b.onclick = function () { editSale(c, st, b.dataset.sale); }; });
  }
  function wireHead() { if ($("ecAdd")) { $("ecAdd").onclick = addStore; } }

  function field(id, label, value, attrs) {
    return '<div class="fld"><label for="' + id + '">' + label + '</label><input class="inp" id="' + id + '" value="' + esc(value || "") + '"' + (attrs || "") + "></div>";
  }
  function editStore(c, st) {
    T.modal("<h2>Store details</h2><p class='muted' style='margin:-8px 0 14px'>" + esc(c.business_name) + "</p>" +
      "<div class='g3 ec-g2'>" + field("esPlat", "Platform", st.platform || "Shopify") + field("esPlan", "Shopify plan <span class='opt'>optional</span>", st.plan, ' placeholder="Basic, Shopify, Advanced..."') + "</div>" +
      "<div class='g3 ec-g2' style='margin-top:12px'>" + field("esUrl", "Store URL", st.store_url, ' placeholder="theirstore.com"') + field("esAdmin", "Shopify admin link", st.admin_url, ' placeholder="admin.shopify.com/store/..."') + "</div>" +
      "<div class='g3 ec-g2' style='margin-top:12px'>" + field("esDomain", "Domain <span class='opt'>optional</span>", st.domain, ' placeholder="Where it\'s registered, e.g. GoDaddy"') + field("esLaunch", "Launch date", st.launch_date, ' type="date"') + "</div>" +
      "<div class='fld' style='margin-top:12px'><label for='esNotes'>Notes <span class='opt'>optional</span></label><textarea class='inp' id='esNotes' rows='4'>" + esc(st.notes || "") + "</textarea></div>" +
      "<div class='mfoot'><button class='btn' id='mCancel'>Cancel</button><button class='btn gold' id='mSave'>Save</button></div>");
    $("mCancel").onclick = T.closeModal;
    $("mSave").onclick = async function () {
      var btn = this; if (btn.disabled) { return; } btn.disabled = true;
      try {
        await save(c.id, { platform: $("esPlat").value.trim() || "Shopify", plan: $("esPlan").value.trim(), store_url: $("esUrl").value.trim(), admin_url: $("esAdmin").value.trim(),
          domain: $("esDomain").value.trim(), launch_date: $("esLaunch").value || null, notes: $("esNotes").value.trim() });
      } catch (e) { btn.disabled = false; T.fail(e); return; }
      T.closeModal(); T.toast("Saved"); draw(c.id);
    };
  }

  function editSale(c, st, key) {
    var now = new Date(), def = key || (function () { var d = new Date(now.getFullYear(), now.getMonth() - 1, 1); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"); })();
    var r = (st.sales || {})[def] || {};
    T.modal("<h2>" + (key ? "Edit month" : "Add a month") + "</h2><p class='muted' style='margin:-8px 0 14px'>" + esc(c.business_name) + " · from their Shopify Analytics</p>" +
      "<div class='g3'>" + field("ssMonth", "Month", def, ' type="month"' + (key ? " disabled" : "")) + field("ssOrders", "Orders", r.orders != null ? r.orders : "", ' type="number" min="0" step="1" inputmode="numeric"') +
      field("ssRev", "Sales ($)", r.revenue != null ? r.revenue : "", ' type="number" min="0" step="0.01" inputmode="decimal"') + "</div>" +
      "<div class='mfoot'>" + (key ? "<button class='btn ghost' id='mDel' style='margin-right:auto'>Remove</button>" : "") + "<button class='btn' id='mCancel'>Cancel</button><button class='btn gold' id='mSave'>Save</button></div>");
    $("mCancel").onclick = T.closeModal;
    async function put(fn) {
      var sales = Object.assign({}, data.stores[c.id].sales || {});
      fn(sales);
      try { await save(c.id, { sales: sales }); } catch (e) { T.fail(e); return false; }
      T.closeModal(); draw(c.id); return true;
    }
    if ($("mDel")) { $("mDel").onclick = function () { put(function (s) { delete s[key]; }); }; }
    $("mSave").onclick = async function () {
      var m = $("ssMonth").value, o = parseInt($("ssOrders").value, 10), v = parseFloat($("ssRev").value);
      if (!/^\d{4}-\d{2}$/.test(m)) { T.toast("Pick the month"); return; }
      if (!isFinite(v) && !isFinite(o)) { T.toast("Enter orders or sales"); return; }
      var btn = this; if (btn.disabled) { return; } btn.disabled = true;
      if (!(await put(function (s) { s[m] = { orders: isFinite(o) ? o : 0, revenue: isFinite(v) ? Math.round(v * 100) / 100 : 0 }; }))) { btn.disabled = false; } else { T.toast("Saved"); }
    };
  }

  function addService(c) {
    var list = data.services.filter(function (v) { return v.active !== false && ECOM_SVC.test(v.name); });
    T.modal("<h2>Add a service</h2><p class='muted' style='margin:-8px 0 14px'>" + esc(c.business_name) + "</p>" +
      "<div class='g3 ec-g2'><div class='fld'><label for='svSel'>Service</label><select class='inp' id='svSel'>" + list.map(function (v) {
        return "<option value='" + v.id + "'>" + esc(v.name) + "</option>";
      }).join("") + "</select></div>" + field("svPrice", "Price ($)", "", ' type="number" min="0" step="1" inputmode="decimal"') + "</div>" +
      "<p class='muted' id='svHint' style='margin-top:10px'></p>" +
      "<div class='mfoot'><button class='btn' id='mCancel'>Cancel</button><button class='btn gold' id='mSave'>Add</button></div>");
    function pick() {
      var v = list.filter(function (x) { return x.id === $("svSel").value; })[0] || {};
      $("svPrice").value = v.default_price != null ? Number(v.default_price) : "";
      $("svHint").textContent = (v.description || "") + (v.default_billing_type === "monthly" ? " · billed monthly" : " · one-time");
    }
    $("svSel").onchange = pick; pick();
    $("mCancel").onclick = T.closeModal;
    $("mSave").onclick = async function () {
      var btn = this; if (btn.disabled) { return; } btn.disabled = true;
      var v = list.filter(function (x) { return x.id === $("svSel").value; })[0];
      var price = parseFloat($("svPrice").value);
      try {
        await q(T.sb.from("client_services").insert({ client_id: c.id, service_id: v.id, billing_type: v.default_billing_type || "one_time", price: isFinite(price) ? price : null, status: "active", start_date: today() }));
      } catch (e) { btn.disabled = false; T.fail(e); return; }
      T.closeModal(); T.toast(v.name + " added"); reload();
    };
  }

  // Pick an existing client or create one; optionally add the Shopify Store Build service.
  function addStore() {
    var build = data.services.filter(function (s) { return /shopify store build/i.test(s.name); })[0];
    var others = data.all.filter(function (c) { return !data.stores[c.id] && c.status !== "churned"; });
    T.modal("<h2>Add store client</h2>" +
      "<div class='fld'><label for='asClient'>Client</label><select class='inp' id='asClient'><option value='new'>New client...</option>" +
        others.map(function (c) { return "<option value='" + c.id + "'>" + esc(c.business_name) + "</option>"; }).join("") + "</select></div>" +
      "<div id='asNewWrap' class='fld' style='margin-top:12px'><label for='asName'>Business name</label><input class='inp' id='asName' placeholder='Must match the Stripe customer name so payments link up'></div>" +
      (build ? "<div class='g3 ec-g2' style='margin-top:12px'><label class='chk' style='align-self:end;padding-bottom:10px'><input type='checkbox' id='asSvc' checked> Add " + esc(build.name) + "</label>" +
        field("asPrice", "Build price ($)", build.default_price || "", ' type="number" min="0" step="1" inputmode="decimal"') + "</div>" : "") +
      "<div class='mfoot'><button class='btn' id='mCancel'>Cancel</button><button class='btn gold' id='mSave'>Add</button></div>");
    $("mCancel").onclick = T.closeModal;
    $("asClient").onchange = function () { $("asNewWrap").classList.toggle("hidden", this.value !== "new"); };
    $("mSave").onclick = async function () {
      var btn = this; if (btn.disabled) { return; }
      var cid = $("asClient").value, name = $("asName").value.trim();
      if (cid === "new" && !name) { T.toast("Enter the business name"); return; }
      btn.disabled = true;
      try {
        if (cid === "new") {
          var made = await q(T.sb.from("clients").insert({ business_name: name, status: "onboarding", start_date: new Date().toISOString().slice(0, 10) }).select("id").single());
          cid = made.id;
        }
        await q(T.sb.from("ecom_stores").insert({ client_id: cid, stage: "kickoff" }));
        if (build && $("asSvc").checked && !data.cs.some(function (s) { return s.client_id === cid && s.service_id === build.id; })) {
          await q(T.sb.from("client_services").insert({ client_id: cid, service_id: build.id, billing_type: "one_time", price: parseFloat($("asPrice").value) || null, status: "active", start_date: new Date().toISOString().slice(0, 10) }));
        }
      } catch (e) { btn.disabled = false; T.fail(e); return; }
      T.closeModal(); T.toast("Store client added");
      if (location.hash === "#ecom/" + cid) { reload(); } else { location.hash = "#ecom/" + cid; }
    };
  }

  window.SGSEcom = { init: function (shared) { T = shared; }, route: route };
})();
