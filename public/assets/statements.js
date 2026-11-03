/* Solid Gold Systems Tracker - Finance > Statements (#finance/statements[/YYYY-MM]).
   Bank and credit card statement PDFs are stored privately (bucket "statements"), read in the browser
   with pdf.js + stmtparse.js, and checked month by month against the rest of Tracker:
     1. Meta charges on the cards  <->  Meta charges Tracker knows (client ad spend + SGS's own ads)
     2. Stripe deposits in the bank <->  Stripe payouts (live from Stripe)
     3. Card payments from the bank <->  payments received on the card statements
     4. Everything else: labelled by hand once per merchant (fin_rules), or flagged "needs a label"
   A check runs on a calendar month using every statement line dated in it, so statements that close
   mid-month (the cards close on the 2nd and 27th) still line up with the bank's month.
   tracker.js calls SGSStatements.init(helpers) and .route(hash, el). export.js uses compute() and files(). */
(function () {
  "use strict";
  var T = null;
  var PDFJS = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
  var PDFJS_WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  var LABELS = ["Software & subscriptions", "Contractors", "Paid 633 Studios", "From 633 Studios", "Client payment", "Insurance",
    "Bank & card fees", "Office & equipment", "Meals & entertainment", "Travel", "Gifts", "Taxes", "Owner draw / transfer", "Refund", "Other"];
  var META = /FACEBK|FACEBOOK|PP\*METAPLATFOR|META ?PLATFORM/i;
  var STRIPE = /\bSTRIPE\b/i;
  var CARDPAY_BANK = /PAYMENT TO .*CARD|CARD ENDING IN|CREDIT CRD|CARDMEMBER SERV|EPAY.*CARD/i;
  var CARDPAY_CARD = /PAYMENT THANK YOU|AUTOMATIC PAYMENT|PAYMENT RECEIVED|AUTOPAY PAYMENT/i;

  var st = { accounts: [], statements: [], rules: [], loaded: 0, gen: 0 };

  /* ---------- small helpers ---------- */
  function $(id) { return document.getElementById(id); }
  function esc(s) { return T.esc(s); }
  async function q(p) { var r = await p; if (r.error) { throw r.error; } return r.data; }
  async function all(make) {
    var out = [];
    for (var from = 0; from < 100000; from += 1000) { var rows = await q(make().range(from, from + 999)); out = out.concat(rows); if (rows.length < 1000) { break; } }
    return out;
  }
  function ro() { return !!(T.readOnly && T.readOnly()); }
  function pad(n) { return String(n).padStart(2, "0"); }
  function addDays(s, n) { var d = new Date(s + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  function days(a, b) { return Math.round((new Date(b + "T12:00:00Z") - new Date(a + "T12:00:00Z")) / 864e5); }
  function lastDay(mk) { var d = new Date(Date.UTC(+mk.slice(0, 4), +mk.slice(5, 7), 0)); return d.toISOString().slice(0, 10); }
  function monthLong(mk) { return new Date(+mk.slice(0, 4), +mk.slice(5, 7) - 1, 15).toLocaleDateString("en-US", { month: "long", year: "numeric" }); }
  function dShort(s) { return s ? new Date(s + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" }) : ""; }
  function money(n) { var v = Number(n || 0); return (v < 0 ? "-$" : "$") + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function prevMonth() { var t = new Date(); t.setDate(1); t.setMonth(t.getMonth() - 1); return t.getFullYear() + "-" + pad(t.getMonth() + 1); }
  function last4Of(s) { var m = /(\d{4})\D*$/.exec(String(s || "")); return m ? m[1] : ""; }
  function acctName(a) { return a ? a.name + (a.last4 ? " ··" + a.last4 : "") : "Unknown account"; }
  function byId(list, id) { for (var i = 0; i < list.length; i++) { if (list[i].id === id) { return list[i]; } } return null; }

  function loadScript(src) {
    return new Promise(function (ok, bad) {
      var s = document.createElement("script"); s.src = src; s.onload = ok;
      s.onerror = function () { bad(new Error("Couldn't load the PDF reader. Check your connection and try again.")); };
      document.head.appendChild(s);
    });
  }
  async function pdfLib() {
    if (!window.pdfjsLib) { await loadScript(PDFJS); }
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
    return window.pdfjsLib;
  }

  /* ---------- data ---------- */
  async function load(force) {
    if (!force && Date.now() - st.loaded < 30000) { return; }
    var r = await Promise.all([
      q(T.sb.from("fin_accounts").select("*").order("sort")),
      all(function () { return T.sb.from("statements").select("*").order("period_end", { ascending: false }).order("id"); }),
      q(T.sb.from("fin_rules").select("*").order("pattern"))
    ]);
    st.accounts = r[0]; st.statements = r[1]; st.rules = r[2]; st.loaded = Date.now();
  }
  function invalidate() { st.loaded = 0; }
  function ruleFor(desc) {
    var key = window.SGSStmtParse.merchantKey(desc), best = null;
    st.rules.forEach(function (r) { if (key.indexOf(r.pattern) === 0 && (!best || r.pattern.length > best.pattern.length)) { best = r; } });
    return best;
  }
  function labelOf(t) { if (t.label) { return t.label; } var r = ruleFor(t.description); return r ? r.label : ""; }
  // Statements whose period overlaps [a, b].
  function overlapping(a, b) { return st.statements.filter(function (s) { return (s.period_start || s.month) <= b && (s.period_end || lastDay(s.month.slice(0, 7))) >= a; }); }
  function coveredAfter(acctId, date) { return covered(acctId, date) && covered(acctId, addDays(date, 3)); }
  function covered(acctId, date) {
    return st.statements.some(function (s) { return s.account_id === acctId && s.period_start && s.period_end && s.period_start <= date && s.period_end >= date; });
  }

  // Greedy matching: each item in A pairs with the closest-dated unused item in B of the same amount.
  function pairUp(A, B, maxDays, same) {
    var used = {}, pairs = [], unA = [];
    A.slice().sort(function (x, y) { return x.date < y.date ? -1 : 1; }).forEach(function (a) {
      var best = null, bd = 99;
      B.forEach(function (b, i) {
        if (used[i] || Math.abs(a.amt - b.amt) > 0.005 || (same && !same(a, b))) { return; }
        var dd = Math.abs(days(a.date, b.date));
        if (dd <= maxDays && dd < bd) { best = i; bd = dd; }
      });
      if (best === null) { unA.push(a); } else { used[best] = true; pairs.push({ a: a, b: B[best] }); }
    });
    return { pairs: pairs, unA: unA, unB: B.filter(function (b, i) { return !used[i]; }) };
  }

  /* The month's checks (also used by the month-end package). */
  async function compute(mk) {
    await load();
    var start = mk + "-01", end = lastDay(mk), lo = addDays(start, -10), hi = addDays(end, 10);
    var inMonth = function (d) { return d >= start && d <= end; };
    var res = await Promise.all([
      all(function () { return T.sb.from("statement_txns").select("*").gte("txn_date", lo).lte("txn_date", hi).order("txn_date").order("id"); }),
      all(function () { return T.sb.from("money_entries").select("id,client_id,entry_date,amount,payment_method,ad_account_id,source").eq("category", "ad_spend").gte("entry_date", lo).lte("entry_date", hi).order("entry_date").order("id"); }),
      q(T.sb.from("clients").select("id,business_name")),
      T.fn("meta-sync", { action: "own_charges", since: lo, until: hi }).catch(function (e) { return { ok: false, error: e.message }; }),
      T.fn("stripe-sync", { action: "payouts", since: lo, until: hi }).catch(function (e) { return { ok: false, error: e.message }; })
    ]);
    var txns = res[0], clientName = {};
    res[2].forEach(function (c) { clientName[c.id] = c.business_name; });
    var acct = {}; st.accounts.forEach(function (a) { acct[a.id] = a; });
    var cards = st.accounts.filter(function (a) { return a.kind === "card"; });
    var bank = st.accounts.filter(function (a) { return a.kind === "bank"; });
    var cardByLast4 = {}; cards.forEach(function (a) { cardByLast4[a.last4] = a; });
    var used = {};   // statement lines explained by a check
    var notes = [];

    // Coverage: is every day of the month in an uploaded statement, per account?
    var coverage = st.accounts.map(function (a) {
      var list = overlapping(start, end).filter(function (s) { return s.account_id === a.id; });
      var missing = [], d = start;
      while (d <= end) { if (!covered(a.id, d)) { missing.push(d); } d = addDays(d, 1); }
      // A statement that ends a day or three before month-end (weekend) still counts as covering the month.
      var nearEnd = list.length && missing.length && missing[missing.length - 1] === end && missing[0] > start && days(missing[0], end) <= 3 && missing.length === days(missing[0], end) + 1;
      return { account: a, statements: list, full: !missing.length, ok: !missing.length || !!nearEnd, missingFrom: missing[0] || null, missingTo: missing[missing.length - 1] || null, adds: list.every(function (s) { return !/does not add up/.test(s.parse_note); }) };
    });

    // 1. Meta charges on the cards.
    var stmtMeta = txns.filter(function (t) { return acct[t.account_id] && acct[t.account_id].kind === "card" && t.amount < 0 && META.test(t.description); })
      .map(function (t) { return { date: t.txn_date, amt: Math.round(-t.amount * 100) / 100, card: acct[t.account_id].last4, txn: t }; });
    var tracked = res[1].map(function (e) { return { date: e.entry_date, amt: Number(e.amount), card: last4Of(e.payment_method), who: clientName[e.client_id] || "Client ad spend", src: e.source }; });
    var own = res[3] && res[3].ok ? res[3].charges : [];
    if (!(res[3] && res[3].ok)) { notes.push("SGS's own Meta charges couldn't be read from Meta" + (res[3] && res[3].error ? " (" + res[3].error + ")" : "") + ", so they show as not in Tracker."); }
    // Meta only reports the card the account bills today, not the card each charge went on: match any card.
    own.forEach(function (c) { tracked.push({ date: c.date, amt: Number(c.amount), card: "", who: "SGS's own ads", src: "meta" }); });
    var meta = pairUp(stmtMeta, tracked, 4, function (a, b) { return !b.card || a.card === b.card; });
    meta.pairs.forEach(function (p) { used[p.a.txn.id] = "Meta ads · " + p.b.who; });
    meta.unA.forEach(function (a) { used[a.txn.id] = "Meta ads · not in Tracker"; });
    // A Tracker charge counts as missing only if the statement for its card (any card, when unknown) covers that day.
    var cardCovered = function (b) { return b.card ? !!(cardByLast4[b.card] && coveredAfter(cardByLast4[b.card].id, b.date)) : cards.every(function (c) { return coveredAfter(c.id, b.date); }); };
    var metaOut = {
      matched: meta.pairs.filter(function (p) { return inMonth(p.a.date); }),
      cardOnly: meta.unA.filter(function (a) { return inMonth(a.date); }),
      trackerOnly: meta.unB.filter(function (b) { return inMonth(b.date) && cardCovered(b); }),
      notCovered: meta.unB.filter(function (b) { return inMonth(b.date) && !cardCovered(b); })
    };

    // 2. Stripe payouts into the bank.
    var stripeIn = txns.filter(function (t) { return acct[t.account_id] && acct[t.account_id].kind === "bank" && t.amount > 0 && STRIPE.test(t.description); })
      .map(function (t) { return { date: t.txn_date, amt: Number(t.amount), txn: t }; });
    var payouts = res[4] && res[4].ok ? res[4].payouts.map(function (p) { return { date: p.arrival, amt: Number(p.amount), id: p.id }; }) : [];
    if (!(res[4] && res[4].ok)) { notes.push("Stripe payouts couldn't be read" + (res[4] && res[4].error ? " (" + res[4].error + ")" : "") + "."); }
    var sp = pairUp(stripeIn, payouts, 4);
    sp.pairs.forEach(function (p) { used[p.a.txn.id] = "Stripe payout"; });
    sp.unA.forEach(function (a) { used[a.txn.id] = "Stripe · no matching payout"; });
    var bankCovered = function (d) { return bank.some(function (b) { return coveredAfter(b.id, d); }); };
    var stripeOut = {
      matched: sp.pairs.filter(function (p) { return inMonth(p.a.date); }),
      bankOnly: sp.unA.filter(function (a) { return inMonth(a.date); }),
      stripeOnly: sp.unB.filter(function (b) { return inMonth(b.date) && bankCovered(b.date); }),
      available: !!(res[4] && res[4].ok)
    };

    // 3. Card payments: bank -> card.
    var bankPay = txns.filter(function (t) { return acct[t.account_id] && acct[t.account_id].kind === "bank" && t.amount < 0 && CARDPAY_BANK.test(t.description); })
      .map(function (t) { var m = /ENDING IN (\d{4})/i.exec(t.description); return { date: t.txn_date, amt: Math.round(-t.amount * 100) / 100, to: m ? m[1] : "", txn: t }; });
    var cardPay = txns.filter(function (t) { return acct[t.account_id] && acct[t.account_id].kind === "card" && t.amount > 0 && CARDPAY_CARD.test(t.description); })
      .map(function (t) { return { date: t.txn_date, amt: Number(t.amount), card: acct[t.account_id].last4, txn: t }; });
    var cp = pairUp(bankPay, cardPay, 5, function (a, b) { return !a.to || a.to === b.card; });
    cp.pairs.forEach(function (p) { used[p.a.txn.id] = "Card payment ··" + p.b.card; used[p.b.txn.id] = "Card payment from bank"; });
    cp.unA.forEach(function (a) { used[a.txn.id] = "Card payment ··" + (a.to || "?"); });
    cp.unB.forEach(function (b) { used[b.txn.id] = "Card payment"; });
    var payOut = {
      matched: cp.pairs.filter(function (p) { return inMonth(p.a.date) || inMonth(p.b.date); }),
      bankOnly: cp.unA.filter(function (a) { return inMonth(a.date) && a.to && cardByLast4[a.to] && coveredAfter(cardByLast4[a.to].id, a.date); }),
      waiting: cp.unA.filter(function (a) { return inMonth(a.date) && !(a.to && cardByLast4[a.to] && coveredAfter(cardByLast4[a.to].id, a.date)); }),
      cardOnly: cp.unB.filter(function (b) { return inMonth(b.date) && bankCovered(b.date); })
    };

    // 4. Everything else in the month.
    var rest = txns.filter(function (t) { return inMonth(t.txn_date) && !used[t.id]; });
    var labeled = {}, unlabeled = [];
    rest.forEach(function (t) {
      var l = labelOf(t);
      if (l) { labeled[l] = labeled[l] || { label: l, n: 0, sum: 0 }; labeled[l].n++; labeled[l].sum += Number(t.amount); }
      else { unlabeled.push(t); }
    });

    var issues = metaOut.cardOnly.length + metaOut.trackerOnly.length + stripeOut.bankOnly.length + stripeOut.stripeOnly.length + payOut.bankOnly.length + payOut.cardOnly.length;
    return {
      month: mk, start: start, end: end, coverage: coverage, notes: notes, acct: acct,
      meta: metaOut, stripe: stripeOut, payments: payOut,
      labeled: Object.keys(labeled).map(function (k) { return labeled[k]; }).sort(function (a, b) { return a.sum - b.sum; }),
      unlabeled: unlabeled, issues: issues,
      txns: txns.filter(function (t) { return inMonth(t.txn_date); }).map(function (t) { return Object.assign({}, t, { _what: used[t.id] || labelOf(t) || "" }); })
    };
  }

  // The latest month the bank statements cover (cards close mid-month), else last month.
  function defaultMonth() {
    var bankIds = st.accounts.filter(function (a) { return a.kind === "bank"; }).map(function (a) { return a.id; });
    var ends = st.statements.filter(function (s) { return bankIds.indexOf(s.account_id) !== -1 && s.period_end; }).map(function (s) { return s.period_end.slice(0, 7); }).sort();
    var mk = ends.length ? ends.pop() : st.statements.length ? st.statements.map(function (s) { return (s.period_end || s.month).slice(0, 7); }).sort().pop() : prevMonth();
    return mk > prevMonth() ? prevMonth() : mk;
  }

  /* ---------- page ---------- */
  async function route(hash, el) {
    var gen = ++st.gen;
    var m = /^#finance\/statements\/(\d{4}-\d{2})/.exec(hash);
    el.innerHTML = '<p class="muted" style="padding:24px">Loading...</p>';
    try { await load(true); } catch (e) { el.innerHTML = '<p class="muted" style="padding:24px">' + esc(e.message) + "</p>"; return; }
    if (gen !== st.gen) { return; }
    var mk = m ? m[1] : defaultMonth();
    draw(el, mk, gen);
  }

  async function draw(el, mk, gen) {
    var writer = !ro();
    el.innerHTML = '<div class="cl-wrap rep stm">' +
      '<a class="back" href="#finance">← Finance</a>' +
      '<div class="cl-head"><div><h1>Statements</h1><p class="muted">Bank and card statements, checked against everything else in Tracker.</p></div>' +
      '<div class="cl-actions">' + (writer ? '<label class="btn" for="stmFiles">Upload statements</label><input class="sr-only" type="file" id="stmFiles" accept="application/pdf,.pdf" multiple>' : "") +
      '<button class="btn gold" id="stmPackage">Month-end package</button></div></div>' +
      '<div class="fin-range"><div class="al-dates"><label>Month <input class="inp" type="month" id="stmMonth" value="' + mk + '"></label></div>' +
      '<span class="muted" style="font-size:13px">' + st.statements.length + " statement" + (st.statements.length === 1 ? "" : "s") + " saved</span></div>" +
      '<div id="stmBody"><p class="muted">Checking ' + esc(monthLong(mk)) + "...</p></div></div>";
    $("stmMonth").onchange = function () { if (/^\d{4}-\d{2}$/.test(this.value)) { location.hash = "finance/statements/" + this.value; } };
    $("stmPackage").onclick = function () { window.SGSExport.openPackage({ T: T, from: mk, to: mk }); };
    if (writer) { $("stmFiles").onchange = function () { var f = Array.prototype.slice.call(this.files); this.value = ""; if (f.length) { uploadFlow(f, el); } }; }
    var r;
    try { r = await compute(mk); } catch (e) { if (gen === st.gen) { $("stmBody").innerHTML = '<p class="muted">' + esc(e.message) + "</p>"; } return; }
    if (gen !== st.gen) { return; }
    $("stmBody").innerHTML = body(r, writer);
    wire(r, el);
  }

  function row(cells, cls) { return "<tr" + (cls ? " class='" + cls + "'" : "") + ">" + cells.map(function (c, i) { return "<td" + (i === cells.length - 1 ? " class='amt'" : "") + ">" + c + "</td>"; }).join("") + "</tr>"; }
  function table(head, rows) { return rows.length ? "<div class='scroll-block stm-tbl'><table class='sheet'><thead><tr>" + head.map(function (h, i) { return "<th" + (i === head.length - 1 ? " class='amt'" : "") + ">" + h + "</th>"; }).join("") + "</tr></thead><tbody>" + rows.join("") + "</tbody></table></div>" : ""; }
  function badge(ok, okText, badText) { return ok ? '<span class="badge ok">' + okText + "</span>" : '<span class="badge warn">' + badText + "</span>"; }
  function panel(title, status, inner) { return '<div class="panel stm-check"><h2><span>' + title + "</span>" + status + "</h2>" + inner + "</div>"; }

  function body(r, writer) {
    var A = function (id) { return r.acct[id]; };
    var cov = '<div class="stm-accts">' + r.coverage.map(function (c) {
      return '<div class="panel stm-acct"><div class="stm-acct-h"><b>' + esc(acctName(c.account)) + "</b>" +
        (c.full ? '<span class="badge ok">Covered</span>' : c.ok ? '<span class="badge">Through ' + dShort(addDays(c.missingFrom, -1)) + "</span>" : '<span class="badge warn">' + (c.statements.length ? "Missing " + dShort(c.missingFrom) + (c.missingTo !== c.missingFrom ? "–" + dShort(c.missingTo) : "") : "Not uploaded") + "</span>") + "</div>" +
        (c.statements.length ? c.statements.map(function (s) {
          return '<div class="stm-file"><span>' + esc(dShort(s.period_start) + " – " + dShort(s.period_end)) + (s.parse_note ? ' <small class="' + (/does not add up/.test(s.parse_note) ? "bad" : "ok") + '">' + esc(s.parse_note) + "</small>" : "") + "</span>" +
            '<span class="stm-file-a"><a href="#" data-pdf="' + s.id + '">PDF</a> · <a href="#" data-lines="' + s.id + '">Lines</a>' + (writer ? ' · <a href="#" data-del="' + s.id + '" class="danger">Remove</a>' : "") + "</span></div>";
        }).join("") : '<p class="muted" style="font-size:13px">No statement covers this month yet.</p>') + "</div>";
    }).join("") + "</div>";

    var m = r.meta, s = r.stripe, p = r.payments;
    var metaInner =
      (m.cardOnly.length ? "<h3>On the card, not in Tracker</h3>" + table(["Date", "Card", "Statement line", "Amount"], m.cardOnly.map(function (x) { return row([dShort(x.date), "··" + esc(x.card), esc(x.txn.description), money(x.amt)], "bad"); })) : "") +
      (m.trackerOnly.length ? "<h3>In Tracker, not on the card</h3>" + table(["Date", "Card", "For", "Amount"], m.trackerOnly.map(function (x) { return row([dShort(x.date), "··" + esc(x.card), esc(x.who), money(x.amt)], "bad"); })) : "") +
      (m.notCovered.length ? '<p class="muted" style="font-size:13px">' + m.notCovered.length + " Meta charge(s) in Tracker (" + money(m.notCovered.reduce(function (t, x) { return t + x.amt; }, 0)) + ") fall on or after a card statement's closing date; they'll be checked when the next statement is uploaded.</p>" : "") +
      (m.matched.length ? "<details><summary>" + m.matched.length + " matched · " + money(m.matched.reduce(function (t, x) { return t + x.a.amt; }, 0)) + "</summary>" +
        table(["Date", "Card", "For", "Amount"], m.matched.map(function (x) { return row([dShort(x.a.date), "··" + esc(x.a.card), esc(x.b.who), money(x.a.amt)]); })) + "</details>" : "");
    var stripeInner = !s.available ? '<p class="muted">Couldn\'t read payouts from Stripe right now.</p>' :
      (s.bankOnly.length ? "<h3>Stripe deposits with no matching payout</h3>" + table(["Date", "Bank line", "Amount"], s.bankOnly.map(function (x) { return row([dShort(x.date), esc(x.txn.description), money(x.amt)], "bad"); })) : "") +
      (s.stripeOnly.length ? "<h3>Stripe payouts not in the bank</h3>" + table(["Arrives", "Payout", "Amount"], s.stripeOnly.map(function (x) { return row([dShort(x.date), esc(x.id), money(x.amt)], "bad"); })) : "") +
      (s.matched.length ? "<details><summary>" + s.matched.length + " matched · " + money(s.matched.reduce(function (t, x) { return t + x.a.amt; }, 0)) + "</summary>" +
        table(["Date", "Payout", "Amount"], s.matched.map(function (x) { return row([dShort(x.a.date), esc(x.b.id), money(x.a.amt)]); })) + "</details>" : (s.bankOnly.length || s.stripeOnly.length ? "" : '<p class="muted">No Stripe payouts this month.</p>'));
    var payInner =
      (p.bankOnly.length ? "<h3>Paid from the bank, not on the card</h3>" + table(["Date", "Bank line", "Amount"], p.bankOnly.map(function (x) { return row([dShort(x.date), esc(x.txn.description), money(x.amt)], "bad"); })) : "") +
      (p.cardOnly.length ? "<h3>Card payments not from this bank</h3>" + table(["Date", "Card", "Amount"], p.cardOnly.map(function (x) { return row([dShort(x.date), "··" + esc(x.card), money(x.amt)], "bad"); })) : "") +
      (p.waiting.length ? '<p class="muted" style="font-size:13px">' + p.waiting.length + " payment(s) go to a card whose statement for those days isn't uploaded yet.</p>" : "") +
      (p.matched.length ? "<details><summary>" + p.matched.length + " matched · " + money(p.matched.reduce(function (t, x) { return t + x.a.amt; }, 0)) + "</summary>" +
        table(["Paid", "To card", "Amount"], p.matched.map(function (x) { return row([dShort(x.a.date), "··" + esc(x.b.card), money(x.a.amt)]); })) + "</details>" : (p.bankOnly.length || p.cardOnly.length ? "" : '<p class="muted">No card payments this month.</p>'));
    var opts = '<option value="">Label…</option>' + LABELS.map(function (l) { return "<option>" + esc(l) + "</option>"; }).join("") + '<option value="__new">Something else…</option>';
    var otherInner =
      (r.unlabeled.length ? "<h3>Needs a label</h3>" + table(["Date", "Statement line", "Label", "Amount"], r.unlabeled.map(function (t) {
        var sel = writer ? '<select class="inp sm stm-label" data-t="' + t.id + '">' + opts + "</select>" : "—";
        return row([dShort(t.txn_date), esc(t.description) + "<small class='stm-acct-n'>" + esc(acctName(A(t.account_id))) + "</small>" + (writer ? '<span class="stm-m">' + sel + "</span>" : ""), sel, money(t.amount)], "warn");
      })).replace("stm-tbl", "stm-tbl stm-lbl") : '<p class="muted">Every other line has a label.</p>') +
      (r.labeled.length ? "<h3>By label</h3>" + table(["Label", "Lines", "Total"], r.labeled.map(function (l) { return row([esc(l.label), String(l.n), money(l.sum)]); })) : "");

    var mOk = !m.cardOnly.length && !m.trackerOnly.length, sOk = !s.bankOnly.length && !s.stripeOnly.length, pOk = !p.bankOnly.length && !p.cardOnly.length;
    return cov +
      (r.notes.length ? '<p class="hintbox">' + r.notes.map(esc).join("<br>") + "</p>" : "") +
      '<div class="stats stm-sum">' +
      '<div class="stat"><small>Meta charges</small><b>' + m.matched.length + " matched</b><span>" + (mOk ? "All line up" : (m.cardOnly.length + m.trackerOnly.length) + " to check") + "</span></div>" +
      '<div class="stat"><small>Stripe payouts</small><b>' + s.matched.length + " matched</b><span>" + (sOk ? "All line up" : (s.bankOnly.length + s.stripeOnly.length) + " to check") + "</span></div>" +
      '<div class="stat"><small>Card payments</small><b>' + p.matched.length + " matched</b><span>" + (pOk ? "All line up" : (p.bankOnly.length + p.cardOnly.length) + " to check") + "</span></div>" +
      '<div class="stat"><small>Other lines</small><b>' + r.unlabeled.length + " need a label</b><span>" + r.labeled.reduce(function (t, l) { return t + l.n; }, 0) + " labeled</span></div></div>" +
      panel("Meta charges on the cards", badge(mOk, "Lines up", "Check"), metaInner || '<p class="muted">No Meta charges this month.</p>') +
      panel("Stripe payouts → bank", badge(sOk, "Lines up", "Check"), stripeInner) +
      panel("Card payments", badge(pOk, "Lines up", "Check"), payInner) +
      panel("Everything else", badge(!r.unlabeled.length, "All labeled", r.unlabeled.length + " to label"), otherInner);
  }

  function wire(r, el) {
    el.querySelectorAll("[data-pdf]").forEach(function (a) { a.onclick = function (e) { e.preventDefault(); openPdf(a.dataset.pdf); }; });
    el.querySelectorAll("[data-lines]").forEach(function (a) { a.onclick = function (e) { e.preventDefault(); showLines(a.dataset.lines); }; });
    el.querySelectorAll("[data-del]").forEach(function (a) {
      a.onclick = async function (e) {
        e.preventDefault();
        var s = byId(st.statements, a.dataset.del);
        if (!s || !confirm("Remove this " + acctName(byId(st.accounts, s.account_id)) + " statement (" + dShort(s.period_start) + " – " + dShort(s.period_end) + ")?")) { return; }
        try { await removeStatement(s); T.toast("Statement removed"); route(location.hash, el); } catch (err) { T.fail(err); }
      };
    });
    el.querySelectorAll(".stm-label").forEach(function (sel) {
      sel.onchange = async function () {
        var v = sel.value; if (!v) { return; }
        if (v === "__new") { v = (prompt("Label for this line:") || "").trim(); if (!v) { sel.value = ""; return; } }
        var t = r.unlabeled.filter(function (x) { return x.id === sel.dataset.t; })[0];
        await setLabel(t, v);
        route(location.hash, el);
      };
    });
  }

  // Label one line; remember it for the merchant so next month's lines get it too.
  async function setLabel(t, label) {
    var key = window.SGSStmtParse.merchantKey(t.description);
    try {
      if (key && key.length >= 3 && !/^(PAYMENT|ZELLE PAYMENT (FROM|TO))$/.test(key)) {
        var me = await T.sb.auth.getUser();
        await q(T.sb.from("fin_rules").upsert({ pattern: key, label: label, created_by: (me.data && me.data.user && me.data.user.email) || "" }, { onConflict: "pattern" }));
        await q(T.sb.from("statement_txns").update({ label: label }).eq("id", t.id));
        T.toast("Labeled. Lines from " + key + " get \"" + label + "\" from now on.", 3500);
      } else {
        await q(T.sb.from("statement_txns").update({ label: label }).eq("id", t.id));
        T.toast("Labeled");
      }
      invalidate();
    } catch (e) { T.fail(e); }
  }

  async function openPdf(id) {
    var s = byId(st.statements, id);
    var w = window.open("", "_blank");
    try {
      var r = await T.sb.storage.from("statements").createSignedUrl(s.file_path, 600);
      if (r.error) { throw r.error; }
      if (w) { w.location = r.data.signedUrl; } else { location.href = r.data.signedUrl; }
    } catch (e) { if (w) { w.close(); } T.fail(e); }
  }
  async function showLines(id) {
    var s = byId(st.statements, id), a = byId(st.accounts, s.account_id);
    var rows = await all(function () { return T.sb.from("statement_txns").select("*").eq("statement_id", id).order("txn_date").order("id"); });
    T.modal("<h2>" + esc(acctName(a)) + "</h2><p class='muted' style='margin:-8px 0 12px'>" + esc(dShort(s.period_start) + " – " + dShort(s.period_end)) + " · " + rows.length + " lines" +
      (s.opening_balance != null ? " · opening " + money(s.opening_balance) + " · closing " + money(s.closing_balance) : "") + "</p>" +
      table(["Date", "Line", "Label", "Amount"], rows.map(function (t) {
        var l = labelOf(t);
        var cell = ro() ? esc(l) : '<select class="inp sm" data-relabel="' + t.id + '"><option value="">' + (l ? "" : "Label…") + "</option>" +
          LABELS.concat(l && LABELS.indexOf(l) === -1 ? [l] : []).map(function (x) { return "<option" + (x === l ? " selected" : "") + ">" + esc(x) + "</option>"; }).join("") + "</select>";
        return row([dShort(t.txn_date), esc(t.description), cell, money(t.amount)], t.amount > 0 ? "in" : "");
      })) +
      "<p class='muted' style='font-size:12px;margin-top:8px'>Meta charges, Stripe deposits and card payments are matched automatically; labels are for everything else. A label applies to every line from the same merchant.</p>" +
      "<div class='mfoot'><button class='btn' id='mCancel'>Close</button></div>");
    $("mCancel").onclick = function () { T.closeModal(); if (dirty) { route(location.hash, $("reportsView")); } };
    var dirty = false;
    document.querySelectorAll("[data-relabel]").forEach(function (sel) {
      sel.onchange = async function () { if (!sel.value) { return; } var t = rows.filter(function (x) { return x.id === sel.dataset.relabel; })[0]; await setLabel(t, sel.value); await load(true); dirty = true; };
    });
  }
  async function removeStatement(s) {
    await q(T.sb.from("statements").delete().eq("id", s.id));
    await T.sb.storage.from("statements").remove([s.file_path]);
    invalidate();
  }

  /* ---------- upload ---------- */
  async function uploadFlow(files, el) {
    T.modal("<h2>Reading statements</h2><p class='muted' id='upMsg'>Opening " + files.length + " file(s)...</p><div class='mfoot'><button class='btn' id='mCancel'>Cancel</button></div>");
    $("mCancel").onclick = T.closeModal;
    var lib;
    try { lib = await pdfLib(); await load(true); } catch (e) { T.closeModal(); T.fail(e); return; }
    var items = [];
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      if ($("upMsg")) { $("upMsg").textContent = "Reading " + f.name + " (" + (i + 1) + " of " + files.length + ")..."; }
      try {
        var doc = await lib.getDocument({ data: new Uint8Array(await f.arrayBuffer()) }).promise;
        var p = window.SGSStmtParse.parse(await window.SGSStmtParse.textLines(doc));
        var a = st.accounts.filter(function (x) { return x.last4 && x.last4 === p.last4; })[0] ||
          st.accounts.filter(function (x) { return x.kind === p.kind && !x.last4; })[0] || null;
        items.push({ file: f, p: p, account: a ? a.id : "", month: (p.periodEnd || "").slice(0, 7) });
      } catch (e) { items.push({ file: f, error: "Couldn't read this PDF (" + e.message + ")" }); }
    }
    if (!$("upMsg")) { return; }   // cancelled
    var acctOpts = function (sel) { return '<option value="">Pick account…</option>' + st.accounts.map(function (a) { return '<option value="' + a.id + '"' + (a.id === sel ? " selected" : "") + ">" + esc(acctName(a)) + "</option>"; }).join(""); };
    T.modal("<h2>Save " + items.length + " statement" + (items.length === 1 ? "" : "s") + "</h2>" +
      "<p class='muted' style='margin:-8px 0 12px;font-size:13px'>Each one is checked: its lines have to add up from the opening to the closing balance.</p>" +
      "<div class='scroll-block'><table class='sheet stm-up'><thead><tr><th>File</th><th>Account</th><th>Period</th><th>Lines</th><th>Check</th></tr></thead><tbody>" +
      items.map(function (it, i) {
        if (it.error) { return "<tr class='bad'><td>" + esc(it.file.name) + "</td><td colspan='4'>" + esc(it.error) + "</td></tr>"; }
        var p = it.p, dup = st.statements.filter(function (s) { return s.account_id === it.account && s.period_end === p.periodEnd; })[0];
        return "<tr><td>" + esc(it.file.name) + (dup ? "<br><small class='muted'>Replaces the saved one</small>" : "") + "</td>" +
          "<td><select class='inp sm' data-acct='" + i + "'>" + acctOpts(it.account) + "</select>" + (p.last4 && !it.account ? "<br><small class='muted'>Ends in " + esc(p.last4) + "</small>" : "") + "</td>" +
          "<td>" + (p.periodStart ? esc(dShort(p.periodStart) + " – " + dShort(p.periodEnd) + ", " + p.periodEnd.slice(0, 4)) : "<span class='bad'>Not found</span>") + "</td>" +
          "<td>" + p.txns.length + "</td>" +
          "<td>" + (p.check ? (p.check.ok ? "<span class='badge ok'>Adds up</span>" : "<span class='badge warn'>Off by " + money(p.check.diff) + "</span>") : "<span class='badge'>No balances</span>") + "</td></tr>";
      }).join("") + "</tbody></table></div>" +
      "<div class='mfoot'><button class='btn' id='mCancel'>Cancel</button><button class='btn gold' id='upSave'>Save</button></div>");
    $("mCancel").onclick = T.closeModal;
    document.querySelectorAll("[data-acct]").forEach(function (s) { s.onchange = function () { items[+s.dataset.acct].account = s.value; }; });
    $("upSave").onclick = async function () {
      var ok = items.filter(function (it) { return !it.error; });
      if (ok.some(function (it) { return !it.account || !it.p.periodEnd; })) { T.toast("Pick the account for each statement"); return; }
      var btn = this; btn.disabled = true;
      var me = await T.sb.auth.getUser(), who = (me.data && me.data.user && me.data.user.email) || "";
      var saved = 0;
      try {
        for (var j = 0; j < ok.length; j++) {
          btn.textContent = "Saving " + (j + 1) + " of " + ok.length + "...";
          await saveOne(ok[j], who); saved++;
        }
        T.closeModal(); T.toast(saved + " statement" + (saved === 1 ? "" : "s") + " saved");
        invalidate();
        var last = defaultMonth();
        if (location.hash === "#finance/statements/" + last) { route(location.hash, el); } else { location.hash = "finance/statements/" + last; }
      } catch (e) { T.fail(e); btn.disabled = false; btn.textContent = "Save"; invalidate(); }
    };
  }

  async function saveOne(it, who) {
    var p = it.p, a = byId(st.accounts, it.account);
    // Same account and closing date as one already saved: replace it.
    var old = st.statements.filter(function (s) { return s.account_id === a.id && s.period_end === p.periodEnd; });
    for (var i = 0; i < old.length; i++) { await removeStatement(old[i]); }
    if (a.kind === "bank" && !a.last4 && p.last4) { await q(T.sb.from("fin_accounts").update({ last4: p.last4 }).eq("id", a.id)); a.last4 = p.last4; }
    var path = a.id + "/" + p.periodEnd + "-" + Date.now().toString(36) + ".pdf";
    var up = await T.sb.storage.from("statements").upload(path, await it.file.arrayBuffer(), { contentType: "application/pdf", upsert: false });
    if (up.error) { throw up.error; }
    var note = p.check ? (p.check.ok ? "Adds up" : "Does not add up (off by " + money(p.check.diff) + ")") : "No opening/closing balance found";
    var month = p.periodEnd.slice(0, 7) + "-01";
    var rows = await q(T.sb.from("statements").upsert({
      account_id: a.id, month: month, period_start: p.periodStart, period_end: p.periodEnd, file_path: path, file_name: it.file.name, file_size: it.file.size,
      opening_balance: p.opening, closing_balance: p.closing, parse_note: note, uploaded_by: who, uploaded_at: new Date().toISOString()
    }, { onConflict: "account_id,month" }).select("id"));
    var sid = rows[0].id;
    await q(T.sb.from("statement_txns").delete().eq("statement_id", sid));
    var txns = p.txns.map(function (t) { return { statement_id: sid, account_id: a.id, txn_date: t.date, description: t.description, amount: t.amount }; });
    for (var k = 0; k < txns.length; k += 500) { await q(T.sb.from("statement_txns").insert(txns.slice(k, k + 500))); }
    st.statements = st.statements.filter(function (s) { return !(s.account_id === a.id && s.month === month); });
    st.statements.push({ id: sid, account_id: a.id, month: month, period_start: p.periodStart, period_end: p.periodEnd, file_path: path });
  }

  // Statements overlapping a range of months, for the month-end package.
  async function files(from, to) {
    await load(true);
    return overlapping(from + "-01", lastDay(to)).map(function (s) {
      return { statement: s, account: byId(st.accounts, s.account_id) };
    }).sort(function (a, b) { return (a.account.sort - b.account.sort) || (a.statement.period_end < b.statement.period_end ? -1 : 1); });
  }
  async function download(s) {
    var r = await T.sb.storage.from("statements").download(s.file_path);
    if (r.error) { throw r.error; }
    return r.data;
  }

  window.SGSStatements = {
    init: function (helpers) { T = helpers; }, route: route, compute: compute, files: files, download: download, invalidate: invalidate,
    acctName: acctName, labelOf: labelOf
  };
})();
