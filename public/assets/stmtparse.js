/* Solid Gold Systems Tracker - reads bank and credit card statement PDFs (Chase business checking and
   Chase cards; other banks' "MM/DD description amount" layouts mostly work too).
   Runs in the browser (window.SGSStmtParse) and in Node for tests (module.exports).
     lines = await textLines(pdfDocument)       // pdf.js document -> text lines, page by page
     result = parse(lines)                       // -> { kind, last4, periodStart, periodEnd, opening, closing, txns, check }
   Amounts: money in (deposits, card payments/credits) > 0, money out (withdrawals, card charges) < 0.
   check.ok is true when opening + transactions = closing, which proves every line was read. */
(function (root) {
  "use strict";

  // pdf.js text items -> lines (same y), left to right, with a double space where there's a gap.
  async function textLines(pdf) {
    var out = [];
    for (var p = 1; p <= pdf.numPages; p++) {
      var page = await pdf.getPage(p);
      var tc = await page.getTextContent();
      var rows = [];
      tc.items.forEach(function (it) {
        if (!it.str || !it.str.trim()) { return; }
        var x = it.transform[4], y = it.transform[5];
        var row = null;
        for (var i = 0; i < rows.length; i++) { if (Math.abs(rows[i].y - y) < 2.5) { row = rows[i]; break; } }
        if (!row) { row = { y: y, items: [] }; rows.push(row); }
        row.items.push({ x: x, w: it.width || 0, s: it.str });
      });
      rows.sort(function (a, b) { return b.y - a.y; });
      rows.forEach(function (r) {
        r.items.sort(function (a, b) { return a.x - b.x; });
        var line = "", end = null, prev = null;
        r.items.forEach(function (it) {
          // Bold text is often drawn twice at the same spot: keep one copy.
          if (prev && prev.s === it.s && Math.abs(prev.x - it.x) < 1.5) { return; }
          prev = it;
          if (end !== null) { var gap = it.x - end; line += gap > 3 ? "  " : gap > 0.8 ? " " : ""; }
          line += it.s; end = it.x + it.w;
        });
        out.push(line.replace(/\s+$/, ""));
      });
      out.push("\f");   // page break
    }
    return out;
  }

  var MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  function pad(n) { return String(n).padStart(2, "0"); }
  function money(s) {
    if (s == null) { return null; }
    var t = String(s).replace(/[$,\s]/g, ""), neg = /^-|-$|^\(.*\)$/.test(t);
    var v = parseFloat(t.replace(/[-()]/g, ""));
    return isFinite(v) ? (neg ? -v : v) : null;
  }
  function ymd(y, m, d) { y = +y; if (y < 100) { y += 2000; } return y + "-" + pad(m) + "-" + pad(d); }
  var AMT = "-?\\(?\\$?(?:[\\d,]+)?\\.\\d{2}\\)?-?";

  // Short, readable description (bank ACH lines are long).
  function clean(desc) {
    var d = desc.replace(/\s+/g, " ").trim();
    var co = /Orig CO Name:\s*(.+?)\s+Orig ID/i.exec(d);
    if (co) {
      var what = /Descr:\s*([^:]+?)\s+(?:Sec:|Trace)/i.exec(d);
      return (co[1].replace(/[&,.\s]+$/, "") + (what && !/^(transfer|ach|web)$/i.test(what[1].trim()) ? " · " + what[1].trim() : what ? " · " + what[1].trim() : "")).slice(0, 160);
    }
    d = d.replace(/^\d{1,2}\/\d{1,2}\s+/, "");                              // "10/09 Payment To Chase Card..."
    d = d.replace(/^(Zelle Payment (?:From|To) .+?)\s+(?=\S*\d)[A-Za-z0-9]{8,}$/i, "$1");   // Zelle reference code
    return d.slice(0, 160);
  }
  // A short key for a merchant, used to remember labels ("HIGHLEVEL LLC", "ZELLE PAYMENT TO JAKE MOSCATO").
  function merchantKey(desc) {
    var u = String(desc || "").toUpperCase().replace(/\s+/g, " ").trim();
    var z = /^(ZELLE PAYMENT (?:FROM|TO) .+)$/.exec(u);
    if (z) { return z[1].split(" ").slice(0, 6).join(" "); }
    if (/PAYMENT TO CHASE CARD/.test(u)) { return u.replace(/.*(PAYMENT TO CHASE CARD ENDING IN \d{4}).*/, "$1"); }
    var out = [];
    u.split(" ").some(function (t, i) {
      if (i > 0 && (/\d{4,}/.test(t) || /\.(COM|IO|US|CO|NET|ORG)\b/.test(t) || /^\d{3}-/.test(t) || /^[A-Z]{2}$/.test(t))) { return true; }
      out.push(t); return out.length >= 3;
    });
    return out.join(" ").replace(/\s*·.*$/, "").trim();
  }

  function parse(lines) {
    var text = lines.join("\n").replace(/[ \t]+/g, " ");
    var res = { kind: "", last4: "", periodStart: null, periodEnd: null, opening: null, closing: null, txns: [], check: null, notes: [] };

    // What kind of statement, which account.
    res.kind = /ACCOUNT ACTIVITY/.test(text) && /Previous Balance/i.test(text) ? "card" : /Beginning Balance/i.test(text) || /DEPOSITS AND ADDITIONS/i.test(text) ? "bank" : /Previous Balance/i.test(text) ? "card" : "bank";
    var acct = /Account Number:?\s*([X\d\s*-]{4,40})/i.exec(text);
    if (acct) { var digits = acct[1].replace(/\D/g, ""); res.last4 = digits.slice(-4); }

    // Statement period.
    var m = /Opening\/Closing Date\s+(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s*-\s*(\d{1,2})\/(\d{1,2})\/(\d{2,4})/i.exec(text);
    if (m) { res.periodStart = ymd(m[3], m[1], m[2]); res.periodEnd = ymd(m[6], m[4], m[5]); }
    if (!m) {
      m = /([A-Z][a-z]+)\s+(\d{1,2}),\s*(\d{4})\s+(?:through|to|-)\s+([A-Z][a-z]+)\s+(\d{1,2}),\s*(\d{4})/.exec(text);
      if (m && MONTHS[m[1].slice(0, 3).toLowerCase()] && MONTHS[m[4].slice(0, 3).toLowerCase()]) {
        res.periodStart = ymd(m[3], MONTHS[m[1].slice(0, 3).toLowerCase()], m[2]);
        res.periodEnd = ymd(m[6], MONTHS[m[4].slice(0, 3).toLowerCase()], m[5]);
      }
    }
    if (!res.periodEnd) {
      m = /(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s*(?:-|to|through)\s*(\d{1,2})\/(\d{1,2})\/(\d{2,4})/i.exec(text);
      if (m) { res.periodStart = ymd(m[3], m[1], m[2]); res.periodEnd = ymd(m[6], m[4], m[5]); }
    }

    // Opening / closing balances.
    var o = new RegExp("(?:Previous|Beginning|Opening|Starting) Balance\\s+(?:\\d+\\s+)?(" + AMT + ")", "i").exec(text);
    var c = new RegExp("(?:New|Ending|Closing) Balance\\s+(?:\\d+\\s+)?(" + AMT + ")", "i").exec(text);
    if (o) { res.opening = money(o[1]); }
    if (c) { res.closing = money(c[1]); }

    // Year for MM/DD dates: the statement's end year (a December line on a January statement is last year).
    var endY = res.periodEnd ? +res.periodEnd.slice(0, 4) : new Date().getFullYear();
    var endM = res.periodEnd ? +res.periodEnd.slice(5, 7) : 12;
    function dateOf(mm, dd) { mm = +mm; return ymd(mm > endM + 1 ? endY - 1 : endY, mm, dd); }

    // Walk the lines, keeping track of which section we're in.
    var section = null, last = null;
    var TXN = new RegExp("^\\s*(\\d{1,2})/(\\d{1,2})(?:/\\d{2,4})?\\s+(.+?)\\s+(" + AMT + ")\\s*$");
    var SKIP = /^(page \d|\(continued\)|date\b|date of|transaction\s|total\b|account number|\*start\*|\*end\*|[A-Z][a-z]+ \d{1,2}, \d{4} through)/i;
    lines.forEach(function (raw) {
      var line = raw.replace(/\s+$/, "");
      var t = line.trim();
      if (!t || t === "\f") { last = null; return; }
      var up = t.toUpperCase().replace(/\s+/g, " ");
      // Section headings.
      if (/^\*end\*/i.test(t)) { section = null; last = null; return; }
      if (!/\d+\.\d{2}/.test(t)) {
        if (/^(DEPOSITS AND ADDITIONS|DEPOSITS|CREDITS|ADDITIONS)\b/.test(up)) { section = "in"; last = null; return; }
        if (/^(ELECTRONIC WITHDRAWALS|ATM & DEBIT CARD WITHDRAWALS|ATM AND DEBIT CARD WITHDRAWALS|CHECKS PAID|OTHER WITHDRAWALS|WITHDRAWALS|FEES|SERVICE FEES|CARD PURCHASES)\b/.test(up)) { section = res.kind === "card" ? "card" : "out"; last = null; return; }
        if (/^ACCOUNT ACTIVITY/.test(up)) { section = "card"; last = null; return; }
        if (/^(DAILY ENDING BALANCE|CHECKING SUMMARY|INTEREST CHARGES|\d{4} TOTALS YEAR-TO-DATE|ACCOUNT SUMMARY|YOUR ACCOUNT MESSAGES|IMPORTANT NEWS|INFORMATION ABOUT YOUR ACCOUNT)/.test(up)) { section = null; last = null; return; }
      }
      if (!section) { return; }
      var x = TXN.exec(t);
      if (x && !/^(beginning|ending|previous|new) balance/i.test(x[3]) && !/^total\b/i.test(x[3])) {
        var amt = money(x[4]);
        var signed = section === "in" ? Math.abs(amt) : section === "out" ? -Math.abs(amt) : -amt;   // card: charges show positive, payments negative
        last = { date: dateOf(x[1], x[2]), raw: x[3], amount: Math.round(signed * 100) / 100 };
        res.txns.push(last);
        return;
      }
      // A bank description that runs onto the next line(s).
      if (last && res.kind === "bank" && !SKIP.test(t) && last.raw.length < 400) { last.raw += " " + t; return; }
      last = null;
    });
    res.txns.forEach(function (x) { x.description = clean(x.raw); delete x.raw; });

    // Does it add up? (bank: opening + in - out = closing; card: balance owed goes up with charges)
    var sum = Math.round(res.txns.reduce(function (s, x) { return s + x.amount; }, 0) * 100) / 100;
    if (res.opening != null && res.closing != null) {
      var expect = res.kind === "card" ? res.opening - sum : res.opening + sum;
      var diff = Math.round((res.closing - expect) * 100) / 100;
      res.check = { ok: Math.abs(diff) < 0.01, diff: diff, sum: sum };
    }
    return res;
  }

  var api = { textLines: textLines, parse: parse, money: money, merchantKey: merchantKey, clean: clean };
  if (typeof module !== "undefined" && module.exports) { module.exports = api; } else { root.SGSStmtParse = api; }
})(typeof window !== "undefined" ? window : this);
