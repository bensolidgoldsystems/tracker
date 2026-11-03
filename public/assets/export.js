/* Solid Gold Systems Tracker - Finance export: Meta ad spend SGS paid, by month, as a branded Excel file.
   For the accountant: what hit our cards for SGS's own ads and for client ads we pay for.
     SGS's own ads  - card charges on SGS's own ad account(s), read live from Meta (meta-sync own_charges).
                      If Meta can't be reached, daily spend from Meta is used instead (and the file says so).
     Client ads     - money_entries category ad_spend (Meta billing charges on our cards, by charge date).
   reports.js calls SGSExport.open({ d, from, to, T }) with its loaded data and the Finance range. */
(function () {
  "use strict";
  var EXCELJS = "https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js";
  var INK = "FF0B0B0B", INK2 = "FF1A1A1A", GOLD = "FFF5D85A", GOLD_DIM = "FFC9A800", GOLD_SOFT = "FFFDF6D8", LINE = "FFE6E1CF", GREY = "FF6B6B6B";
  var MONEY = '"$"#,##0.00;[Red]-"$"#,##0.00;"–"';
  var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var MONTH_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

  function ym(s) { return String(s || "").slice(0, 7); }
  function monthsBetween(a, b) {
    var out = [], y = +a.slice(0, 4), m = +a.slice(5, 7);
    while (out.length < 240) {
      var k = y + "-" + String(m).padStart(2, "0");
      out.push(k);
      if (k >= b) { break; }
      m++; if (m > 12) { m = 1; y++; }
    }
    return out;
  }
  function lastDay(k) { var d = new Date(Date.UTC(+k.slice(0, 4), +k.slice(5, 7), 0)); return d.toISOString().slice(0, 10); }
  function short(k) { return MON[+k.slice(5, 7) - 1] + " " + k.slice(0, 4); }
  function long(k) { return MONTH_LONG[+k.slice(5, 7) - 1] + " " + k.slice(0, 4); }
  function todayLong() { var t = new Date(); return MON[t.getMonth()] + " " + t.getDate() + ", " + t.getFullYear(); }
  function asDate(s) { return new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10))); }
  function col(n) { var s = ""; while (n > 0) { var r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; }

  var loading = null;
  function loadLib() {
    if (window.ExcelJS) { return Promise.resolve(); }
    if (!loading) {
      loading = new Promise(function (ok, bad) {
        var sc = document.createElement("script"); sc.src = EXCELJS; sc.onload = ok;
        sc.onerror = function () { loading = null; bad(new Error("Couldn't load the Excel tool. Check your connection and try again.")); };
        document.head.appendChild(sc);
      });
    }
    return loading;
  }

  /* ---------- data ---------- */
  async function gather(ctx, from, to) {
    var d = ctx.d, T = ctx.T, keys = monthsBetween(from, to);
    var inRange = function (k) { return k >= from && k <= to; };
    var byClient = {}; d.clients.forEach(function (c) { byClient[c.id] = c; });
    var acctName = {}; (d.accounts || []).forEach(function (a) { acctName[a.ad_account_id] = a.name || ""; });
    var acctLabel = function (id) { return !id ? "" : acctName[id] && acctName[id] !== id ? acctName[id] + " (" + id + ")" : id; };

    // Client ad spend SGS paid: Meta charges on our cards, dated by the charge.
    var client = d.entries.filter(function (e) { return e.category === "ad_spend" && inRange(ym(e.entry_date || e.month)); }).map(function (e) {
      var c = byClient[e.client_id];
      return { date: e.entry_date || ym(e.month) + "-01", month: ym(e.entry_date || e.month), who: c ? c.business_name : "No client", own: false,
        account: acctLabel(e.ad_account_id),
        card: e.payment_method || "", txn: /^meta:[^:]+$/.test(e.external_ref || "") ? e.external_ref.slice(5) : "", amount: Number(e.amount) || 0,
        note: e.note || "" };
    });

    // SGS's own ads: card charges straight from Meta.
    var own = [], ownBasis = "charges";
    try {
      var r = await T.fn("meta-sync", { action: "own_charges", since: from + "-01", until: lastDay(to) });
      if (!r || !r.ok) { throw new Error("Meta not connected"); }
      own = (r.charges || []).map(function (x) {
        return { date: x.date, month: ym(x.date), who: "Solid Gold Systems (own ads)", own: true,
          account: acctLabel(x.account), card: x.card || "", txn: x.txn || "", amount: Number(x.amount) || 0, note: "" };
      });
    } catch (e) {
      ownBasis = "spend";
      Object.keys(d.ownSpend || {}).filter(inRange).forEach(function (k) {
        own.push({ date: k + "-01", month: k, who: "Solid Gold Systems (own ads)", own: true, account: "", card: "", txn: "", amount: Math.round(d.ownSpend[k] * 100) / 100, note: "Monthly spend from Meta (charges couldn't be read)" });
      });
    }
    var all = own.concat(client).sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : a.who < b.who ? -1 : 1; });

    var clientNames = [];
    client.forEach(function (x) { if (clientNames.indexOf(x.who) === -1) { clientNames.push(x.who); } });
    clientNames.sort(function (a, b) { return a.localeCompare(b); });
    return { keys: keys, all: all, own: own, client: client, clientNames: clientNames, ownBasis: ownBasis };
  }

  /* ---------- workbook ---------- */
  function banner(ws, logoId, width, title, sub, at) {
    at = at || 2;
    for (var r = 1; r <= 4; r++) {
      ws.getRow(r).height = r === 1 ? 10 : r === 4 ? 12 : 26;
      for (var c = 1; c <= width; c++) { ws.getCell(r, c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: INK } }; }
    }
    if (logoId != null) { ws.addImage(logoId, { tl: { col: 0.25, row: 1.05 }, ext: { width: 118, height: 45 } }); }
    var t = ws.getCell(2, at); t.value = title; t.font = { name: "Calibri", size: 16, bold: true, color: { argb: GOLD } }; t.alignment = { vertical: "bottom" };
    var s = ws.getCell(3, at); s.value = sub; s.font = { name: "Calibri", size: 10, color: { argb: "FFBDBDBD" } }; s.alignment = { vertical: "top" };
    // Gold rule under the banner.
    ws.getRow(5).height = 4;
    for (var c2 = 1; c2 <= width; c2++) { ws.getCell(5, c2).fill = { type: "pattern", pattern: "solid", fgColor: { argb: GOLD } }; }
    ws.getRow(6).height = 10;
  }
  function header(ws, row, labels, alignRightFrom) {
    var r = ws.getRow(row); r.height = 22;
    labels.forEach(function (l, i) {
      var cell = r.getCell(i + 1); cell.value = l;
      cell.font = { bold: true, color: { argb: INK }, size: 10.5 };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: GOLD } };
      cell.alignment = { vertical: "middle", horizontal: i + 1 >= alignRightFrom ? "right" : "left", indent: i + 1 >= alignRightFrom ? 0 : 1 };
      cell.border = { bottom: { style: "thin", color: { argb: GOLD_DIM } } };
    });
  }
  function bodyRow(ws, row, n, zebra) {
    var r = ws.getRow(row); r.height = 18;
    for (var c = 1; c <= n; c++) {
      var cell = r.getCell(c);
      cell.font = cell.font && cell.font.bold ? cell.font : { size: 10.5, color: { argb: INK2 } };
      cell.border = { bottom: { style: "hair", color: { argb: LINE } } };
      if (zebra) { cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFAF9F5" } }; }
      if (!cell.alignment) { cell.alignment = (c === 1 ? { vertical: "middle", horizontal: "left", indent: 1 } : { vertical: "middle" }); }
    }
  }
  function totalRow(ws, row, n, label) {
    var r = ws.getRow(row); r.height = 22;
    r.getCell(1).value = label;
    for (var c = 1; c <= n; c++) {
      var cell = r.getCell(c);
      cell.font = { bold: true, size: 11, color: { argb: INK } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: GOLD_SOFT } };
      cell.border = { top: { style: "medium", color: { argb: INK } }, bottom: { style: "double", color: { argb: INK } } };
      cell.alignment = (c === 1 ? { vertical: "middle", horizontal: "left", indent: 1 } : { vertical: "middle" });
    }
  }
  function money(cell) { cell.numFmt = MONEY; cell.alignment = { vertical: "middle", horizontal: "right" }; }
  function note(ws, row, text, n) {
    ws.mergeCells(row, 1, row, n);
    var c = ws.getCell(row, 1); c.value = text; c.font = { italic: true, size: 9.5, color: { argb: GREY } }; c.alignment = { wrapText: true, vertical: "top", indent: 1 };
    ws.getRow(row).height = Math.max(16, Math.ceil(text.length / (n * 14)) * 14);
  }

  async function build(data, from, to) {
    var X = window.ExcelJS;
    var wb = new X.Workbook();
    wb.creator = "Solid Gold Systems Tracker"; wb.created = new Date(); wb.company = "Solid Gold Systems";
    var logoId = null;
    try {
      var buf = await (await fetch("/assets/logo.png", { cache: "force-cache" })).arrayBuffer();
      logoId = wb.addImage({ buffer: buf, extension: "png" });
    } catch (e) { /* logo is optional */ }
    var period = from === to ? long(from) : long(from) + " – " + long(to);
    var sub = period + "  ·  Card charges  ·  Generated " + todayLong();
    var keys = data.keys;
    var sumBy = function (rows, k) { return rows.filter(function (x) { return x.month === k; }).reduce(function (s, x) { return s + x.amount; }, 0); };
    var ownLabel = data.ownBasis === "charges" ? "SGS's own ads" : "SGS's own ads (spend)";

    /* Summary */
    var ws = wb.addWorksheet("Summary", { views: [{ showGridLines: false, state: "frozen", ySplit: 7 }], properties: { tabColor: { argb: GOLD } },
      pageSetup: { orientation: "portrait", fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } } });
    ws.columns = [{ width: 22 }, { width: 22 }, { width: 26 }, { width: 20 }, { width: 2 }];
    banner(ws, logoId, 5, "Meta ad spend paid by SGS", sub);
    header(ws, 7, ["Month", ownLabel, "Client ads (paid by SGS)", "Total"], 2);
    var r0 = 8;
    keys.forEach(function (k, i) {
      var row = ws.getRow(r0 + i);
      row.getCell(1).value = long(k);
      row.getCell(2).value = Math.round(sumBy(data.own, k) * 100) / 100;
      row.getCell(3).value = Math.round(sumBy(data.client, k) * 100) / 100;
      row.getCell(4).value = { formula: "SUM(B" + (r0 + i) + ":C" + (r0 + i) + ")" };
      bodyRow(ws, r0 + i, 4, i % 2 === 1);
      [2, 3, 4].forEach(function (c) { money(row.getCell(c)); });
      row.getCell(4).font = { bold: true, size: 10.5, color: { argb: INK } };
    });
    var rt = r0 + keys.length;
    totalRow(ws, rt, 4, "Total");
    ["B", "C", "D"].forEach(function (L, i) { var c = ws.getCell(rt, i + 2); c.value = { formula: "SUM(" + L + r0 + ":" + L + (rt - 1) + ")" }; money(c); });
    note(ws, rt + 2, "What this shows: Meta ad charges that hit Solid Gold Systems' cards, by the date Meta charged the card. " +
      "\"SGS's own ads\" is our own advertising. \"Client ads\" is ad spend we paid to Meta on clients' behalf (clients reimburse or prepay this; see Finance in Tracker for prepayments). " +
      "Every charge, with Meta's transaction ID, is on the All charges sheet.", 4);
    if (data.ownBasis !== "charges") { note(ws, rt + 4, "Note: Meta's billing charges for SGS's own account couldn't be read when this file was made, so the own-ads column is Meta's monthly spend instead of card charges.", 4); }

    /* By client */
    var nCols = keys.length + 2;
    var wc = wb.addWorksheet("By client", { views: [{ showGridLines: false, state: "frozen", xSplit: 1, ySplit: 7 }], properties: { tabColor: { argb: INK } },
      pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
    var mw = Math.max(13, Math.ceil(56 / keys.length));   // short ranges: wider months so the banner fits
    wc.columns = [{ width: 34 }].concat(keys.map(function () { return { width: mw }; })).concat([{ width: 16 }]);
    banner(wc, logoId, nCols, "Ad spend by month and client", sub);
    header(wc, 7, ["Paid for"].concat(keys.map(short)).concat(["Total"]), 2);
    var who = [{ name: "Solid Gold Systems (own ads)", rows: data.own }].concat(data.clientNames.map(function (n) {
      return { name: n, rows: data.client.filter(function (x) { return x.who === n; }) };
    }));
    who.forEach(function (w, i) {
      var rr = 8 + i, row = wc.getRow(rr);
      row.getCell(1).value = w.name;
      keys.forEach(function (k, j) { var c = row.getCell(j + 2); c.value = Math.round(sumBy(w.rows, k) * 100) / 100; money(c); });
      var tc = row.getCell(nCols); tc.value = { formula: "SUM(B" + rr + ":" + col(nCols - 1) + rr + ")" }; money(tc);
      bodyRow(wc, rr, nCols, i % 2 === 1);
      tc.font = { bold: true, size: 10.5, color: { argb: INK } };
      if (i === 0) { row.getCell(1).font = { bold: true, size: 10.5, color: { argb: INK } }; }
    });
    var ct = 8 + who.length;
    totalRow(wc, ct, nCols, "Total");
    for (var j = 2; j <= nCols; j++) { var c = wc.getCell(ct, j); c.value = { formula: "SUM(" + col(j) + "8:" + col(j) + (ct - 1) + ")" }; money(c); }

    /* All charges */
    var wa = wb.addWorksheet("All charges", { views: [{ showGridLines: false, state: "frozen", ySplit: 7 }], properties: { tabColor: { argb: GOLD_DIM } },
      pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
    wa.columns = [{ width: 13 }, { width: 11 }, { width: 32 }, { width: 34 }, { width: 16 }, { width: 38 }, { width: 14 }];
    banner(wa, logoId, 7, "Every Meta charge", sub, 3);
    header(wa, 7, ["Date", "Month", "Paid for", "Ad account", "Card", "Meta transaction ID", "Amount"], 7);
    data.all.forEach(function (x, i) {
      var rr = 8 + i, row = wa.getRow(rr);
      row.getCell(1).value = asDate(x.date); row.getCell(1).numFmt = "mmm d, yyyy";
      row.getCell(2).value = short(x.month);
      row.getCell(3).value = x.who;
      row.getCell(4).value = x.account;
      row.getCell(5).value = x.card;
      row.getCell(6).value = x.txn || x.note;
      row.getCell(7).value = x.amount;
      bodyRow(wa, rr, 7, i % 2 === 1);
      money(row.getCell(7));
      row.getCell(1).alignment = { vertical: "middle", horizontal: "left", indent: 1 };
      if (x.own) { row.getCell(3).font = { bold: true, size: 10.5, color: { argb: INK } }; }
    });
    var at = 8 + data.all.length;
    totalRow(wa, at, 7, "Total (" + data.all.length + " charge" + (data.all.length === 1 ? "" : "s") + ")");
    var atc = wa.getCell(at, 7); atc.value = { formula: "SUBTOTAL(9,G8:G" + (at - 1) + ")" }; money(atc);
    if (data.all.length) { wa.autoFilter = { from: { row: 7, column: 1 }, to: { row: at - 1, column: 7 } }; }

    [ws, wc, wa].forEach(function (s) { s.headerFooter.oddFooter = "&L&8Solid Gold Systems · Meta ad spend&R&8Page &P of &N"; });
    return wb.xlsx.writeBuffer();
  }

  /* ---------- whole Finance page ---------- */
  var SHEET = { secPnl: "Profit & loss", secSum: "Summary", secRev: "Revenue", secPpl: "Pay per lead", secAds: "Ad spend & prepaid" };
  async function buildFinance(data, from, to) {
    var X = window.ExcelJS;
    var wb = new X.Workbook();
    wb.creator = "Solid Gold Systems Tracker"; wb.created = new Date(); wb.company = "Solid Gold Systems";
    var logoId = null;
    try { logoId = wb.addImage({ buffer: await (await fetch("/assets/logo.png", { cache: "force-cache" })).arrayBuffer(), extension: "png" }); } catch (e) { /* optional */ }
    var period = from === to ? long(from) : long(from) + " – " + long(to);
    var sub = period + "  ·  Finance  ·  Generated " + todayLong();
    var keys = data.keys, used = {};
    data.sections.forEach(function (sec, si) {
      var name = (SHEET[sec.id] || sec.title).replace(/[\[\]:*?\/\\]/g, "").slice(0, 31);
      while (used[name]) { name = name.slice(0, 28) + " " + (++used[name]); }
      used[name] = 1;
      var hasStatus = sec.rows.some(function (r) { return r.status; });
      var first = hasStatus ? 3 : 2, n = first + keys.length;   // columns: name, [status], months..., total
      var ws = wb.addWorksheet(name, { views: [{ showGridLines: false, state: "frozen", xSplit: 1, ySplit: 7 }], properties: { tabColor: { argb: si === 0 ? GOLD : si % 2 ? INK : GOLD_DIM } },
        pageSetup: { orientation: keys.length > 4 ? "landscape" : "portrait", fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } } });
      var mw = Math.max(13, Math.ceil((hasStatus ? 44 : 56) / keys.length));
      ws.columns = [{ width: 40 }].concat(hasStatus ? [{ width: 13 }] : []).concat(keys.map(function () { return { width: mw }; })).concat([{ width: 16 }]);
      banner(ws, logoId, n, sec.title, sub);
      header(ws, 7, [sec.id === "secPnl" ? "Profit & loss" : sec.id === "secSum" ? "" : "Client"].concat(hasStatus ? ["Status"] : []).concat(keys.map(short)).concat(["Total"]), first);
      var rr = 8, zebra = 0;
      sec.rows.forEach(function (r) {
        var row = ws.getRow(rr);
        var lab = row.getCell(1); lab.value = r.label;
        if (hasStatus) { row.getCell(2).value = r.status || null; }
        r.values.forEach(function (x, j) {
          var c = row.getCell(first + j);
          if (x.v != null && x.v !== 0) { c.value = x.v; }
          if (x.note) { c.note = x.note; }
        });
        if (r.kind !== "head" && r.kind !== "group" && r.total != null) { row.getCell(n).value = r.total; }
        if (r.kind === "total") {
          var keep = lab.value; totalRow(ws, rr, n, keep);
        } else if (r.kind === "key") {
          row.height = 22;
          for (var c1 = 1; c1 <= n; c1++) { var kc = row.getCell(c1); kc.fill = { type: "pattern", pattern: "solid", fgColor: { argb: INK } }; kc.font = { bold: true, size: 11, color: { argb: GOLD } }; kc.alignment = c1 === 1 ? { vertical: "middle", horizontal: "left", indent: 1 } : { vertical: "middle" }; }
        } else if (r.kind === "head" || r.kind === "group") {
          row.height = 20; zebra = 0;
          for (var c2 = 1; c2 <= n; c2++) {
            var hc = row.getCell(c2);
            hc.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF1EEE4" } };
            hc.font = { bold: true, size: 10.5, color: { argb: INK } };
            hc.border = { top: { style: "thin", color: { argb: LINE } } };
            hc.alignment = c2 === 1 ? { vertical: "middle", horizontal: "left", indent: 1 + (r.indent || 0) } : { vertical: "middle" };
          }
          if (r.info) { var ic = row.getCell(first); ic.value = r.info; ic.font = { italic: true, size: 9.5, color: { argb: GREY } }; }
          if (hasStatus && r.status) { row.getCell(2).font = { size: 9.5, bold: true, color: { argb: r.status === "Active" ? "FF2E7D32" : GREY } }; }
        } else {
          bodyRow(ws, rr, n, (zebra++) % 2 === 1);
          lab.alignment = { vertical: "middle", horizontal: "left", indent: 1 + (r.indent || 0) * 2 };
          if (r.kind === "ref") { for (var c3 = 1; c3 <= n; c3++) { row.getCell(c3).font = { italic: true, size: 9.5, color: { argb: GREY } }; } }
          if (hasStatus && r.status) { row.getCell(2).font = { size: 9.5, color: { argb: r.status === "Active" ? "FF2E7D32" : GREY } }; }
          row.getCell(n).font = { bold: true, size: 10.5, color: { argb: INK } };
        }
        for (var c4 = first; c4 <= n; c4++) { money(row.getCell(c4)); }
        if (r.kind === "group" && r.info) { row.getCell(first).alignment = { vertical: "middle", horizontal: "left" }; }
        rr++;
      });
      if (sec.sub) { note(ws, rr + 1, sec.sub, n); }
      ws.headerFooter.oddFooter = "&L&8Solid Gold Systems · Finance · " + name + "&R&8Page &P of &N";
    });
    return wb.xlsx.writeBuffer();
  }

  /* ---------- month-end package: ad spend Excel + statement PDFs + statement checks ---------- */
  var JSZIP = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
  function loadZip() {
    if (window.JSZip) { return Promise.resolve(); }
    return new Promise(function (ok, bad) {
      var sc = document.createElement("script"); sc.src = JSZIP; sc.onload = ok;
      sc.onerror = function () { bad(new Error("Couldn't load the zip tool. Check your connection and try again.")); };
      document.head.appendChild(sc);
    });
  }
  async function gatherPackage(ctx, from, to) {
    var d = await window.SGSReports.data();
    return { ad: await gather({ d: d, T: ctx.T }, from, to), files: await window.SGSStatements.files(from, to) };
  }
  async function buildChecks(checks, from, to) {
    var X = window.ExcelJS, S = window.SGSStatements;
    var wb = new X.Workbook();
    wb.creator = "Solid Gold Systems Tracker"; wb.created = new Date(); wb.company = "Solid Gold Systems";
    var logoId = null;
    try { logoId = wb.addImage({ buffer: await (await fetch("/assets/logo.png", { cache: "force-cache" })).arrayBuffer(), extension: "png" }); } catch (e) { /* optional */ }
    var sub = (from === to ? long(from) : long(from) + " – " + long(to)) + "  ·  Bank & card statements  ·  Generated " + todayLong();
    function sheet(name, title, widths, heads, rows, rightFrom, opts) {
      opts = opts || {};
      var ws = wb.addWorksheet(name, { views: [{ showGridLines: false, state: "frozen", ySplit: 7 }], properties: { tabColor: { argb: opts.tab || GOLD } },
        pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
      ws.columns = widths.map(function (w) { return { width: w }; });
      banner(ws, logoId, widths.length, title, sub, opts.at || 2);
      header(ws, 7, heads, rightFrom);
      rows.forEach(function (r, i) {
        var row = ws.getRow(8 + i);
        r.forEach(function (v, j) { var c = row.getCell(j + 1); c.value = v; });
        bodyRow(ws, 8 + i, heads.length, i % 2 === 1);
        (opts.money || []).forEach(function (j) { money(row.getCell(j)); });
        (opts.dates || []).forEach(function (j) { var c = row.getCell(j); if (c.value instanceof Date) { c.numFmt = "mmm d, yyyy"; c.alignment = { vertical: "middle", horizontal: "left", indent: 1 }; } });
        if (opts.flag && opts.flag(r)) { for (var k = 1; k <= heads.length; k++) { row.getCell(k).font = { size: 10.5, color: { argb: "FFB3261E" }, bold: k === 1 }; } }
      });
      if (!rows.length) { var e = ws.getCell(8, 1); e.value = opts.empty || "Nothing here."; e.font = { italic: true, color: { argb: GREY } }; }
      else if (opts.filter) { ws.autoFilter = { from: { row: 7, column: 1 }, to: { row: 7 + rows.length, column: heads.length } }; }
      ws.headerFooter.oddFooter = "&L&8Solid Gold Systems · Statement checks&R&8Page &P of &N";
      return ws;
    }
    var sum = checks.map(function (c) {
      var missing = c.coverage.filter(function (x) { return !x.ok; }).map(function (x) { return S.acctName(x.account) + (x.statements.length ? " (part)" : ""); });
      return [long(c.month), missing.length ? "Missing: " + missing.join(", ") : "All uploaded",
        c.meta.matched.length, c.meta.cardOnly.length + c.meta.trackerOnly.length,
        c.stripe.matched.length, c.stripe.bankOnly.length + c.stripe.stripeOnly.length,
        c.payments.matched.length, c.payments.bankOnly.length + c.payments.cardOnly.length,
        c.unlabeled.length];
    });
    var ws = sheet("Summary", "Statement checks", [18, 46, 11, 11, 11, 11, 12, 12, 11],
      ["Month", "Statements", "Meta ✓", "Meta ✗", "Stripe ✓", "Stripe ✗", "Card pay ✓", "Card pay ✗", "No label"], sum, 3,
      { flag: function (r) { return r[3] || r[5] || r[7]; } });
    note(ws, 9 + sum.length, "✓ = lines up with Tracker, ✗ = needs a look (listed on the To check sheet). Meta = Meta ad charges on the cards vs. the charges Tracker has for client ads and SGS's own ads. Stripe = Stripe payouts vs. Stripe deposits in the bank. Card pay = payments from the bank vs. payments received on the cards. No label = other statement lines nobody has labeled yet.", 9);

    var issues = [];
    checks.forEach(function (c) {
      var mm = long(c.month);
      c.meta.cardOnly.forEach(function (x) { issues.push([mm, "Meta charge on the card, not in Tracker", asDate(x.date), "Card ··" + x.card, x.txn.description, -x.amt]); });
      c.meta.trackerOnly.forEach(function (x) { issues.push([mm, "Meta charge in Tracker, not on the card", asDate(x.date), "Card ··" + x.card, x.who, -x.amt]); });
      c.stripe.bankOnly.forEach(function (x) { issues.push([mm, "Stripe deposit with no matching payout", asDate(x.date), "Bank", x.txn.description, x.amt]); });
      c.stripe.stripeOnly.forEach(function (x) { issues.push([mm, "Stripe payout not in the bank", asDate(x.date), "Bank", x.id, x.amt]); });
      c.payments.bankOnly.forEach(function (x) { issues.push([mm, "Card payment from the bank, not on the card", asDate(x.date), "Bank", x.txn.description, -x.amt]); });
      c.payments.cardOnly.forEach(function (x) { issues.push([mm, "Card payment not from this bank", asDate(x.date), "Card ··" + x.card, x.txn.description, x.amt]); });
      c.unlabeled.forEach(function (t) { issues.push([mm, "Needs a label", asDate(t.txn_date), S.acctName(c.acct[t.account_id]), t.description, Number(t.amount)]); });
    });
    sheet("To check", "Needs a look", [16, 38, 14, 22, 48, 14], ["Month", "Check", "Date", "Account", "Detail", "Amount"], issues, 6,
      { money: [6], dates: [3], filter: true, tab: INK, empty: "Everything lines up." });

    var lines = [];
    checks.forEach(function (c) { c.txns.forEach(function (t) { lines.push([asDate(t.txn_date), S.acctName(c.acct[t.account_id]), t.description, t._what || "Needs a label", Number(t.amount)]); }); });
    sheet("All lines", "Every statement line", [14, 26, 52, 32, 14], ["Date", "Account", "Statement line", "What it is", "Amount"], lines, 5,
      { money: [5], dates: [1], filter: true, tab: GOLD_DIM });

    var byLabel = [];
    checks.forEach(function (c) { c.labeled.forEach(function (l) { byLabel.push([long(c.month), l.label, l.n, Math.round(l.sum * 100) / 100]); }); });
    sheet("By label", "Other spending by label", [18, 34, 10, 16], ["Month", "Label", "Lines", "Total"], byLabel, 3, { money: [4], tab: INK });
    return wb.xlsx.writeBuffer();
  }
  async function buildPackage(data, from, to) {
    await loadZip();
    var range = from + (to !== from ? "_to_" + to : "");
    var zip = new window.JSZip();
    zip.file("SGS-Meta-Ad-Spend_" + range + ".xlsx", await build(data.ad, from, to));
    for (var i = 0; i < data.files.length; i++) {
      var f = data.files[i], s = f.statement, name = window.SGSStatements.acctName(f.account).replace(/[\\/:*?"<>|·]+/g, "").replace(/\s+/g, " ").trim();
      zip.file("Statements/" + name + "/" + name + " - " + long((s.period_end || s.month).slice(0, 7)) + ".pdf", await window.SGSStatements.download(s));
    }
    return zip.generateAsync({ type: "blob", compression: "DEFLATE" });
  }

  /* ---------- modals ---------- */
  function rangeModal(ctx, o) {
    var T = ctx.T, $ = T.$;
    T.modal("<h2>" + o.title + "</h2><p class='muted' style='margin:-8px 0 14px'>" + o.blurb + "</p>" +
      "<div class='g3' style='grid-template-columns:1fr 1fr'><div class='fld'><label for='exFrom'>From</label><input class='inp' type='month' id='exFrom' value='" + ctx.from + "'></div>" +
      "<div class='fld'><label for='exTo'>To</label><input class='inp' type='month' id='exTo' value='" + ctx.to + "'></div></div>" +
      "<div class='mfoot'><button class='btn' id='mCancel'>Cancel</button><button class='btn gold' id='exGo'>" + (o.button || "Download Excel") + "</button></div>");
    $("mCancel").onclick = T.closeModal;
    $("exGo").onclick = async function () {
      var from = $("exFrom").value, to = $("exTo").value, btn = this;
      if (!/^\d{4}-\d{2}$/.test(from) || !/^\d{4}-\d{2}$/.test(to)) { T.toast("Pick both months"); return; }
      if (from > to) { var t = from; from = to; to = t; }
      btn.disabled = true; btn.textContent = "Building...";
      try {
        var res = await Promise.all([loadLib(), o.gather(from, to)]);
        var out = await o.build(res[1], from, to);
        var a = document.createElement("a");
        a.href = URL.createObjectURL(out instanceof Blob ? out : new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
        a.download = o.file + "_" + from + (to !== from ? "_to_" + to : "") + "." + (o.ext || "xlsx");
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 60000);
        T.closeModal(); T.toast(o.done);
      } catch (e) { T.fail(e); btn.disabled = false; btn.textContent = o.button || "Download Excel"; }
    };
  }
  function open(ctx) {
    rangeModal(ctx, { title: "Export ad spend", file: "SGS-Meta-Ad-Spend", done: "Ad spend exported",
      blurb: "An Excel file of the Meta ad charges SGS paid, by month: our own ads and the client ads we pay for, with every charge listed.",
      gather: function (f, t) { return gather(ctx, f, t); }, build: build });
  }
  function openFinance(ctx) {
    rangeModal(ctx, { title: "Export Finance", file: "SGS-Finance", done: "Finance exported",
      blurb: "An Excel file of everything on the Finance page for these months: profit &amp; loss, summary, revenue, pay per lead, ad spend and partner payouts, one sheet each.",
      gather: ctx.tables, build: buildFinance });
  }

  function openPackage(ctx) {
    rangeModal(ctx, { title: "Month-end package", file: "SGS-Month-End", ext: "zip", done: "Month-end package downloaded", button: "Download zip",
      blurb: "One zip for the accountant: the ad spend Excel and the bank and credit card statements for these months (one per account per month, by closing date).",
      gather: function (f, t) { return gatherPackage(ctx, f, t); }, build: buildPackage });
  }

  window.SGSExport = { open: open, openFinance: openFinance, openPackage: openPackage, _buildChecks: buildChecks, _gather: gather, _build: build, _buildFinance: buildFinance, _months: monthsBetween };
})();
