/* Solid Gold Systems - website intake form */
(function () {
  "use strict";
  var S = window.SGS_SCHEMA, C = window.SGS_CONFIG;
  var STORE = "sgs-intake-draft-v1";
  var files = {};          // kind -> [File]
  var fieldEls = {};       // id -> wrapper element
  var $ = function (id) { return document.getElementById(id); };

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }

  /* ---------- render ---------- */
  function labelHtml(f) {
    return esc(f.label) + (f.req ? '<span class="req">*</span>' : '<span class="opt">' + esc(f.labelNote || "optional") + "</span>");
  }

  function renderField(f) {
    var w = document.createElement("div");
    w.className = "fld" + (f.half ? "" : " full");
    w.dataset.id = f.id;
    var id = "f_" + f.id, html = "";
    if (f.type === "note") {
      w.className = "note";
      w.innerHTML = "<span>🔒</span><span><b>Don't put passwords in this form.</b> " + esc(f.text.replace(/^Don't put passwords in this form\.\s*/, "")) + "</span>";
      return w;
    }
    if (f.type === "check") {
      w.innerHTML = '<label class="checkrow"><input type="checkbox" id="' + id + '" name="' + f.id + '"> ' + esc(f.label) + "</label>";
      return w;
    }
    if (f.type === "choice" || f.type === "multi") {
      html = '<span class="lbl" id="' + id + '_l">' + labelHtml(f) + '</span><div class="chips" role="group" aria-labelledby="' + id + '_l">' +
        f.options.map(function (o) { return '<button type="button" class="chip" aria-pressed="false" data-v="' + esc(o) + '">' + esc(o) + "</button>"; }).join("") + "</div>";
    } else if (f.type === "files") {
      files[f.kind] = [];
      html = '<span class="lbl">' + labelHtml(f) + '</span>' +
        '<label class="drop" for="' + id + '"><strong>' + esc(f.btn) + "</strong><span>" + esc(f.btnSub || "") + "</span></label>" +
        '<input class="sr-only" type="file" id="' + id + '" ' + (f.max > 1 ? "multiple " : "") + 'accept="' + esc(f.accept) + '">' +
        '<div class="thumbs" data-thumbs="' + f.kind + '"></div>';
    } else {
      var common = ' id="' + id + '" name="' + f.id + '" class="inp"' + (f.ph ? ' placeholder="' + esc(f.ph) + '"' : "") +
        (f.req ? " required" : "") + (f.auto ? ' autocomplete="' + f.auto + '"' : "") + (f.mode ? ' inputmode="' + f.mode + '"' : "");
      html = '<label for="' + id + '">' + labelHtml(f) + "</label>" +
        (f.type === "textarea"
          ? "<textarea" + common + ' rows="' + (f.rows || 3) + '"></textarea>'
          : '<input type="' + (f.type === "url" ? "text" : f.type) + '"' + common + (f.type === "url" ? ' inputmode="url"' : "") + ">");
    }
    if (f.hint) { html += '<span class="hint">' + esc(f.hint) + "</span>"; }
    html += '<span class="errmsg">' + (f.type === "email" ? "Enter a valid email." : "This one's required.") + "</span>";
    w.innerHTML = html;
    return w;
  }

  function render() {
    var root = $("sections");
    S.SECTIONS.forEach(function (sec) {
      var el = document.createElement("section");
      el.className = "sec";
      el.innerHTML = "<h2><span>" + sec.num + "</span>" + esc(sec.title) + "</h2>" + (sec.sub ? '<p class="sub">' + esc(sec.sub) + "</p>" : '<div style="height:18px"></div>');
      var g = document.createElement("div");
      g.className = "grid";
      sec.fields.forEach(function (f) { var w = renderField(f); fieldEls[f.id] = w; g.appendChild(w); });
      el.appendChild(g);
      root.appendChild(el);
    });
  }

  /* ---------- values ---------- */
  function getValue(f) {
    var w = fieldEls[f.id];
    if (f.type === "choice") { var b = w.querySelector('.chip[aria-pressed="true"]'); return b ? b.dataset.v : ""; }
    if (f.type === "multi") { return Array.prototype.map.call(w.querySelectorAll('.chip[aria-pressed="true"]'), function (b) { return b.dataset.v; }); }
    if (f.type === "check") { return w.querySelector("input").checked; }
    if (f.type === "files" || f.type === "note") { return null; }
    return w.querySelector(".inp").value.trim();
  }

  function setValue(f, v) {
    var w = fieldEls[f.id];
    if (!w || v == null) { return; }
    if (f.type === "choice" || f.type === "multi") {
      var vals = Array.isArray(v) ? v : [v];
      w.querySelectorAll(".chip").forEach(function (b) { b.setAttribute("aria-pressed", vals.indexOf(b.dataset.v) !== -1 ? "true" : "false"); });
    } else if (f.type === "check") { w.querySelector("input").checked = !!v; }
    else if (f.type !== "files" && f.type !== "note") { w.querySelector(".inp").value = v; }
  }

  function collect() {
    var a = {};
    S.allFields().forEach(function (f) {
      var v = getValue(f);
      if (v === null) { return; }
      if (Array.isArray(v) ? v.length : (v === true || (typeof v === "string" && v))) { a[f.id] = v; }
    });
    return a;
  }

  /* ---------- autosave (per-browser convenience only) ---------- */
  var saveT;
  function save() {
    clearTimeout(saveT);
    saveT = setTimeout(function () { try { localStorage.setItem(STORE, JSON.stringify(collect())); } catch (e) { /* private mode */ } }, 300);
  }
  function restore() {
    var d = null;
    try { d = JSON.parse(localStorage.getItem(STORE) || "null"); } catch (e) { d = null; }
    if (d) { S.allFields().forEach(function (f) { if (d[f.id] != null) { setValue(f, d[f.id]); } }); }
  }

  /* Prefill from the link we text them, e.g. ?name={{contact.name}}&email=...&cid={{contact.id}} */
  var params = new URLSearchParams(location.search);
  function prefill() {
    var map = {
      contact_name: params.get("name") || [params.get("first_name"), params.get("last_name")].filter(Boolean).join(" "),
      contact_email: params.get("email"),
      business_phone: params.get("phone"),
      business_name: params.get("business") || params.get("company_name")
    };
    S.allFields().forEach(function (f) { if (map[f.id] && !getValue(f)) { setValue(f, map[f.id]); } });
  }

  /* ---------- progress ---------- */
  function progress() {
    var all = S.allFields().filter(function (f) { return f.type !== "note" && f.type !== "check"; });
    var done = all.filter(function (f) {
      if (f.type === "files") { return files[f.kind].length > 0; }
      var v = getValue(f);
      return Array.isArray(v) ? v.length : !!v;
    }).length;
    var pct = Math.round(done / all.length * 100);
    $("pctLabel").textContent = pct + "% complete";
    $("pctBar").style.width = pct + "%";
  }

  /* ---------- files ---------- */
  function fieldByKind(kind) { return S.allFields().filter(function (f) { return f.kind === kind; })[0]; }

  function addFiles(kind, list) {
    var f = fieldByKind(kind);
    Array.prototype.forEach.call(list, function (file) {
      if (files[kind].length >= f.max) { return; }
      var dupe = files[kind].some(function (x) { return x.name === file.name && x.size === file.size; });
      if (!dupe) { files[kind].push(file); }
    });
    if (list.length && files[kind].length >= f.max) { alert("That's the limit for this section (" + f.max + "). For more, add a photo link above."); }
    drawThumbs(kind);
    progress();
  }

  function drawThumbs(kind) {
    var box = document.querySelector('[data-thumbs="' + kind + '"]');
    box.querySelectorAll("img,video").forEach(function (m) { if (m.src.indexOf("blob:") === 0) { URL.revokeObjectURL(m.src); } });
    box.innerHTML = "";
    files[kind].forEach(function (file, i) {
      var t = document.createElement("div");
      t.className = "thumb";
      var type = file.type || "";
      if (/^image\/(jpeg|png|gif|webp|svg\+xml|avif)$/.test(type)) {
        var img = document.createElement("img"); img.alt = ""; img.src = URL.createObjectURL(file); t.appendChild(img);
      } else if (/^video\//.test(type)) {
        var v = document.createElement("video"); v.muted = true; v.src = URL.createObjectURL(file); t.appendChild(v);
      } else {
        var d = document.createElement("div"); d.className = "doc"; d.textContent = (file.name.split(".").pop() || "file").toUpperCase(); t.appendChild(d);
      }
      var n = document.createElement("div"); n.className = "fname"; n.textContent = file.name; t.appendChild(n);
      var x = document.createElement("button"); x.type = "button"; x.className = "x"; x.setAttribute("aria-label", "Remove " + file.name); x.textContent = "×";
      x.onclick = function () { files[kind].splice(i, 1); drawThumbs(kind); progress(); };
      t.appendChild(x);
      box.appendChild(t);
    });
  }

  /* ---------- validation ---------- */
  var EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  function validate() {
    var first = null;
    S.allFields().forEach(function (f) {
      var w = fieldEls[f.id];
      if (!w || f.type === "note" || f.type === "files" || f.type === "check") { return; }
      var v = getValue(f), bad = false;
      if (f.req && (Array.isArray(v) ? !v.length : !v)) { bad = true; }
      if (!bad && f.type === "email" && v && !EMAIL.test(v)) { bad = true; }
      w.classList.toggle("err", bad);
      if (bad && !first) { first = w; }
    });
    if (first) {
      first.scrollIntoView({ behavior: "smooth", block: "center" });
      var i = first.querySelector(".inp,.chip"); if (i) { setTimeout(function () { i.focus({ preventScroll: true }); }, 350); }
    }
    return !first;
  }

  /* ---------- submit ---------- */
  function overlay(text, pct) {
    $("overlay").classList.remove("hidden");
    $("ovText").textContent = text;
    $("ovBar").style.width = Math.max(4, pct) + "%";
  }

  async function postJson(url, body) {
    var res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    var data = {};
    try { data = await res.json(); } catch (e) { /* ignore */ }
    if (!res.ok || !data.ok) { throw new Error(data.error || "Something went wrong (" + res.status + ")"); }
    return data;
  }

  async function submit(e) {
    e.preventDefault();
    $("formErr").classList.add("hidden");
    if (!validate()) { return; }
    var btn = $("submitBtn");
    btn.disabled = true;

    var queue = [];
    Object.keys(files).forEach(function (kind) { files[kind].forEach(function (file) { queue.push({ kind: kind, file: file }); }); });

    try {
      overlay("Saving your answers...", 3);
      var start = await postJson("/.netlify/functions/intake-start", {
        answers: collect(),
        files: queue.map(function (q) { return { kind: q.kind, name: q.file.name, size: q.file.size, type: q.file.type }; }),
        hp: document.querySelector('input[name="company_site"]').value,
        cid: params.get("cid") || ""
      });

      var failed = [];
      if (start.lead_id && queue.length) {
        var client = window.supabase.createClient(C.supabaseUrl, C.supabaseAnonKey, { auth: { persistSession: false } });
        var bucket = client.storage.from(C.bucket);
        var total = queue.reduce(function (s, q) { return s + q.file.size; }, 0) || 1, sent = 0, doneCount = 0, next = 0;

        var worker = async function () {
          while (next < start.uploads.length) {
            var u = start.uploads[next++], q = queue[u.i], ok = false;
            for (var attempt = 0; attempt < 3 && !ok; attempt++) {
              var r = await bucket.uploadToSignedUrl(u.path, u.token, q.file, { contentType: q.file.type || "application/octet-stream" });
              ok = !r.error;
            }
            if (!ok) { failed.push(q.file.name); }
            sent += q.file.size; doneCount++;
            overlay("Uploading files " + doneCount + " of " + queue.length + "...", 5 + sent / total * 85);
          }
        };
        await Promise.all([worker(), worker(), worker()]);
      }

      if (start.lead_id) {
        overlay("Finishing up...", 95);
        await postJson("/.netlify/functions/intake-complete", { lead_id: start.lead_id, token: start.token });
      }

      try { localStorage.removeItem(STORE); } catch (err) { /* ignore */ }
      $("overlay").classList.add("hidden");
      $("formView").classList.add("hidden");
      $("doneView").classList.remove("hidden");
      if (failed.length) {
        $("doneWarn").textContent = failed.length + " file(s) didn't upload (" + failed.slice(0, 5).join(", ") + "). Text or email them to us and we'll add them.";
        $("doneWarn").classList.remove("hidden");
      }
      window.scrollTo(0, 0);
    } catch (err) {
      $("overlay").classList.add("hidden");
      $("formErr").textContent = err.message + " Your answers are saved on this device. Please try again.";
      $("formErr").classList.remove("hidden");
      btn.disabled = false;
    }
  }

  /* ---------- wire up ---------- */
  render();
  restore();
  prefill();
  progress();

  var form = $("intake");
  form.addEventListener("input", function (e) { var w = e.target.closest(".fld"); if (w) { w.classList.remove("err"); } save(); progress(); });
  form.addEventListener("change", function (e) {
    if (e.target.type === "file") {
      var kind = fieldByKindFromInput(e.target);
      addFiles(kind, e.target.files);
      e.target.value = "";
      return;
    }
    save(); progress();
  });
  form.addEventListener("click", function (e) {
    var chip = e.target.closest(".chip");
    if (!chip) { return; }
    var w = chip.closest(".fld"), f = S.allFields().filter(function (x) { return x.id === w.dataset.id; })[0];
    if (f.type === "choice") {
      var on = chip.getAttribute("aria-pressed") === "true";
      w.querySelectorAll(".chip").forEach(function (b) { b.setAttribute("aria-pressed", "false"); });
      chip.setAttribute("aria-pressed", on ? "false" : "true");
    } else {
      chip.setAttribute("aria-pressed", chip.getAttribute("aria-pressed") === "true" ? "false" : "true");
    }
    w.classList.remove("err"); save(); progress();
  });
  function fieldByKindFromInput(input) { return input.closest(".fld").querySelector("[data-thumbs]").dataset.thumbs; }

  document.querySelectorAll(".drop").forEach(function (d) {
    var kind = d.closest(".fld").querySelector("[data-thumbs]").dataset.thumbs;
    ["dragenter", "dragover"].forEach(function (ev) { d.addEventListener(ev, function (e) { e.preventDefault(); d.classList.add("over"); }); });
    ["dragleave", "drop"].forEach(function (ev) { d.addEventListener(ev, function (e) { e.preventDefault(); d.classList.remove("over"); }); });
    d.addEventListener("drop", function (e) { addFiles(kind, e.dataTransfer.files); });
  });
  form.addEventListener("submit", submit);
  window.addEventListener("beforeunload", function (e) { if (!$("overlay").classList.contains("hidden")) { e.preventDefault(); e.returnValue = ""; } });
})();
