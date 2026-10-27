/* Solid Gold Systems - Tracker app */
(function () {
  "use strict";
  var S = window.SGS_SCHEMA, C = window.SGS_CONFIG;
  var sb = window.supabase.createClient(C.supabaseUrl, C.supabaseAnonKey);
  var bucket = sb.storage.from(C.bucket);
  var $ = function (id) { return document.getElementById(id); };
  var leads = [];
  var current = null;      // { lead, files, urls }
  var INTAKE_URL = "https://websites.solidgoldsystems.com/intake/";

  /* ---------- utils ---------- */
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function toast(msg, ms) {
    var t = $("toast"); t.textContent = msg; t.classList.remove("hidden");
    clearTimeout(toast.t); toast.t = setTimeout(function () { t.classList.add("hidden"); }, ms || 2600);
  }
  function fail(err) { console.error(err); toast("Error: " + ((err && err.message) || err), 5000); }
  function fmtDate(d) { return d ? new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : ""; }
  function fmtSize(b) { return b > 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB"; }
  function linkify(s) {
    return esc(s).replace(/(https?:\/\/[^\s<]+|(?:www\.)[^\s<]+)/g, function (u) {
      var href = /^https?:/.test(u) ? u : "https://" + u;
      return '<a href="' + href + '" target="_blank" rel="noopener">' + u + "</a>";
    });
  }
  function copyText(text) {
    if (navigator.clipboard) { navigator.clipboard.writeText(text).then(function () { toast("Copied"); }, function () { prompt("Copy:", text); }); }
    else { prompt("Copy:", text); }
  }
  function isImage(f) { return /^image\/(jpeg|png|gif|webp|svg\+xml|avif)$/.test(f.mime) || /\.(jpe?g|png|gif|webp|svg|avif)$/i.test(f.name); }
  function isVideo(f) { return /^video\//.test(f.mime) || /\.(mp4|mov|webm|m4v)$/i.test(f.name); }
  function kindLabel(id) { var k = S.FILE_KINDS.filter(function (x) { return x.id === id; })[0]; return k ? k.label : id; }
  function stageLabel(id) { var s = S.STAGES.filter(function (x) { return x.id === id; })[0]; return s ? s.label : id; }

  /* ---------- checklist math ---------- */
  function checklistState(lead, files) {
    var a = lead.answers || {}, cl = lead.checklist || {}, total = 0, done = 0;
    S.CHECKLIST.forEach(function (sec) {
      sec.items.forEach(function (it) { total++; if (cl[it.id] === "done" || cl[it.id] === "na") { done++; } });
    });
    return { total: total, done: done, pct: total ? Math.round(done / total * 100) : 0, a: a, cl: cl, files: files || [] };
  }

  /* ---------- auth ---------- */
  function showAuth(msg, bad) {
    $("appView").classList.add("hidden");
    $("authView").classList.remove("hidden");
    $("authMsg").textContent = msg || "";
    $("authMsg").classList.toggle("bad", !!bad);
  }

  async function enterApp() {
    var r = await sb.rpc("is_team");
    if (r.error || !r.data) {
      await sb.auth.signOut();
      showAuth("This account doesn't have Tracker access.", true);
      return;
    }
    $("authView").classList.add("hidden");
    $("appView").classList.remove("hidden");
    await loadLeads();
    route();
  }

  $("loginForm").addEventListener("submit", async function (e) {
    e.preventDefault();
    $("authMsg").textContent = "Signing in...";
    var r = await sb.auth.signInWithPassword({ email: $("loginEmail").value.trim(), password: $("loginPass").value });
    if (r.error) { showAuth(r.error.message, true); return; }
    enterApp();
  });
  $("forgotBtn").addEventListener("click", async function () {
    var email = $("loginEmail").value.trim();
    if (!email) { showAuth("Enter your email first.", true); return; }
    var r = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + "/" });
    showAuth(r.error ? r.error.message : "Check your email for a reset link.", !!r.error);
  });
  $("resetForm").addEventListener("submit", async function (e) {
    e.preventDefault();
    var r = await sb.auth.updateUser({ password: $("newPass").value });
    if (r.error) { showAuth(r.error.message, true); return; }
    $("resetForm").classList.add("hidden"); $("loginForm").classList.remove("hidden");
    toast("Password saved"); enterApp();
  });
  $("signOut").addEventListener("click", async function () { await sb.auth.signOut(); location.hash = ""; showAuth("Signed out."); });

  /* ---------- data ---------- */
  async function loadLeads() {
    var r = await sb.from("leads").select("*, lead_files(kind)").order("created_at", { ascending: false });
    if (r.error) { fail(r.error); return; }
    leads = r.data;
    renderBoard();
  }

  async function saveLead(patch, quiet) {
    if (!current) { return; }
    var r = await sb.from("leads").update(patch).eq("id", current.lead.id).select().single();
    if (r.error) { fail(r.error); return false; }
    current.lead = Object.assign(current.lead, r.data);
    var i = leads.findIndex(function (l) { return l.id === current.lead.id; });
    if (i !== -1) { leads[i] = Object.assign(leads[i], r.data); }
    if (!quiet) { toast("Saved"); }
    return true;
  }

  /* ---------- board ---------- */
  function renderBoard() {
    var q = ($("search").value || "").toLowerCase();
    var board = $("board");
    board.innerHTML = "";
    S.STAGES.forEach(function (st) {
      var list = leads.filter(function (l) {
        if (l.stage !== st.id) { return false; }
        if (!q) { return true; }
        return [l.business_name, l.contact_name, l.email, l.phone].join(" ").toLowerCase().indexOf(q) !== -1;
      });
      var col = document.createElement("div");
      col.className = "col"; col.dataset.stage = st.id;
      col.innerHTML = "<h2>" + esc(st.label) + "<b>" + list.length + "</b></h2>" + (list.length ? "" : '<div class="empty">No leads</div>');
      list.forEach(function (l) {
        var cs = checklistState(l, l.lead_files);
        var a = document.createElement("a");
        a.className = "card"; a.href = "#lead/" + l.id; a.draggable = true; a.dataset.id = l.id;
        a.innerHTML = '<div class="biz">' + esc(l.business_name || "Untitled lead") + "</div>" +
          '<div class="who">' + esc(l.contact_name || l.email || "") + "</div>" +
          '<div class="pbar"><i style="width:' + cs.pct + '%"></i></div>' +
          '<div class="row"><span>Checklist ' + cs.done + "/" + cs.total + " · " + (l.lead_files || []).length + " files</span>" +
          (l.intake_status === "uploading" ? '<span class="badge warn">Uploading</span>' : l.source === "manual" ? '<span class="badge">Manual</span>' : "<span>" + fmtDate(l.created_at) + "</span>") + "</div>";
        a.addEventListener("dragstart", function (e) { e.dataTransfer.setData("text/plain", l.id); a.classList.add("dragging"); });
        a.addEventListener("dragend", function () { a.classList.remove("dragging"); });
        col.appendChild(a);
      });
      col.addEventListener("dragover", function (e) { e.preventDefault(); col.classList.add("drag"); });
      col.addEventListener("dragleave", function () { col.classList.remove("drag"); });
      col.addEventListener("drop", async function (e) {
        e.preventDefault(); col.classList.remove("drag");
        var id = e.dataTransfer.getData("text/plain"), l = leads.filter(function (x) { return x.id === id; })[0];
        if (!l || l.stage === st.id) { return; }
        var r = await sb.from("leads").update({ stage: st.id }).eq("id", id);
        if (r.error) { fail(r.error); return; }
        l.stage = st.id; renderBoard(); toast("Moved to " + st.label);
      });
      board.appendChild(col);
    });
  }
  $("search").addEventListener("input", renderBoard);
  $("refresh").addEventListener("click", function () { loadLeads().then(function () { toast("Refreshed"); }); });
  $("copyIntake").addEventListener("click", function () { copyText(INTAKE_URL); });
  $("newLead").addEventListener("click", async function () {
    var name = prompt("Business name for the new lead:");
    if (!name) { return; }
    var r = await sb.from("leads").insert({ business_name: name.trim(), source: "manual", intake_status: "manual", answers: { business_name: name.trim() } }).select().single();
    if (r.error) { fail(r.error); return; }
    r.data.lead_files = [];
    leads.unshift(r.data);
    location.hash = "lead/" + r.data.id;
  });

  /* ---------- routing ---------- */
  function route() {
    var m = location.hash.match(/^#lead\/([0-9a-f-]{36})/);
    if (m) { openLead(m[1]); }
    else {
      current = null;
      $("leadView").classList.add("hidden");
      $("boardView").classList.remove("hidden");
      renderBoard();
    }
  }
  window.addEventListener("hashchange", function () { if (!$("appView").classList.contains("hidden")) { route(); } });

  /* ---------- lead detail ---------- */
  async function openLead(id) {
    $("boardView").classList.add("hidden");
    var view = $("leadView");
    view.classList.remove("hidden");
    view.innerHTML = '<a class="back" href="#">← All leads</a><p class="muted">Loading...</p>';
    var r = await sb.from("leads").select("*").eq("id", id).single();
    if (r.error) { view.innerHTML = '<a class="back" href="#">← All leads</a><p class="muted">Lead not found.</p>'; return; }
    var f = await sb.from("lead_files").select("*").eq("lead_id", id).order("kind").order("path");
    current = { lead: r.data, files: f.data || [], urls: {} };
    await signUrls();
    renderLead();
    window.scrollTo(0, 0);
  }

  async function signUrls() {
    var paths = current.files.map(function (f) { return f.path; });
    current.urls = {};
    if (!paths.length) { return; }
    var r = await bucket.createSignedUrls(paths, 3600);
    (r.data || []).forEach(function (x) { if (x.signedUrl) { current.urls[x.path] = x.signedUrl; } });
  }

  function renderLead() {
    var l = current.lead, a = l.answers || {};
    var view = $("leadView");
    var cs = checklistState(l, current.files);
    var gmail = l.email ? '<a href="mailto:' + esc(l.email) + '">' + esc(l.email) + "</a>" : "";
    var tel = l.phone ? '<a href="tel:' + esc(l.phone) + '">' + esc(l.phone) + "</a>" : "";

    var html = '<a class="back" href="#">← All leads</a>' +
      '<div class="lead-head"><div><h1>' + esc(l.business_name || "Untitled lead") + "</h1>" +
      '<div class="sub">' + [esc(l.contact_name), gmail, tel, "Submitted " + fmtDate(l.created_at)].filter(Boolean).join(" · ") +
      (l.intake_status === "uploading" ? ' · <span class="badge warn">Upload unfinished</span>' : "") + "</div></div>" +
      '<div class="lead-actions">' +
      '<button class="btn gold" id="exportBtn">Export build kit (.zip)</button>' +
      '<button class="btn" id="editBtn">Edit info</button>' +
      '<button class="btn ghost" id="moreBtn" aria-haspopup="true">More</button></div></div>' +

      '<div class="metarow">' +
      '<div class="fld"><label for="mStage">Stage</label><select class="inp" id="mStage">' +
      S.STAGES.map(function (s) { return '<option value="' + s.id + '"' + (s.id === l.stage ? " selected" : "") + ">" + esc(s.label) + "</option>"; }).join("") + "</select></div>" +
      '<div class="fld"><label for="mStart">Start date</label><input class="inp" type="date" id="mStart" value="' + esc(l.start_date || "") + '"></div>' +
      '<div class="fld"><label for="mLaunch">Launch date</label><input class="inp" type="date" id="mLaunch" value="' + esc(l.launch_date || "") + '"></div>' +
      '<div class="fld"><label for="mDraft">Draft site URL</label><input class="inp" type="url" id="mDraft" placeholder="https://...netlify.app" value="' + esc(l.draft_url || "") + '"></div>' +
      "</div>" +

      '<div class="layout"><div>' + filesPanel() + answersPanels(a) + "</div>" +
      '<aside class="side">' + checklistPanel(cs) +
      '<div class="panel"><h2>Internal notes</h2><textarea class="inp notes" id="mNotes" placeholder="Call notes, what they liked, changes to make...">' + esc(l.internal_notes || "") + "</textarea></div>" +
      "</aside></div>";
    view.innerHTML = html;
    wireLead();
  }

  function answersPanels(a) {
    return S.SECTIONS.filter(function (sec) {
      // the short-form section only shows when the lead came through websites.solidgoldsystems.com
      return !sec.internal || sec.fields.some(function (f) { return a[f.id]; });
    }).map(function (sec) {
      var rows = sec.fields.filter(function (f) { return f.type !== "note" && f.type !== "files"; }).map(function (f) {
        var v = a[f.id];
        var txt = Array.isArray(v) ? v.join(", ") : v === true ? "Yes" : (v || "");
        return '<dl class="ans"><dt>' + esc(f.label) + "</dt>" +
          (txt ? "<dd>" + linkify(txt) + '</dd><button class="copy" data-copy="' + esc(txt) + '" title="Copy">⧉</button>' : '<dd class="none">—</dd><span></span>') + "</dl>";
      }).join("");
      return '<div class="panel"><h2><span><span class="n">' + sec.num + "</span>" + esc(sec.title) + "</span></h2>" + rows + "</div>";
    }).join("");
  }

  function filesPanel() {
    var byKind = {};
    current.files.forEach(function (f) { (byKind[f.kind] = byKind[f.kind] || []).push(f); });
    var total = current.files.reduce(function (s, f) { return s + Number(f.size || 0); }, 0);
    var body = S.FILE_KINDS.filter(function (k) { return byKind[k.id]; }).map(function (k) {
      return '<div class="kind"><h3>' + esc(k.label) + ' <span class="badge">' + byKind[k.id].length + "</span>" +
        (k.source === "sgs" ? '<span class="badge gold">SGS</span>' : "") + "</h3>" +
        '<div class="fthumbs">' + byKind[k.id].map(function (f) {
          var url = current.urls[f.path], inner;
          if (url && isImage(f)) { inner = '<img loading="lazy" alt="" src="' + esc(url) + '">'; }
          else if (url && isVideo(f)) { inner = '<video muted preload="metadata" src="' + esc(url) + '#t=0.5"></video>'; }
          else { inner = '<div class="doc">' + esc((f.name.split(".").pop() || "file").toUpperCase()) + "</div>"; }
          return '<div class="fthumb" data-path="' + esc(f.path) + '" tabindex="0" role="button" aria-label="Open ' + esc(f.name) + '">' + inner + '<div class="fname">' + esc(f.name) + "</div></div>";
        }).join("") + "</div></div>";
    }).join("");
    var link = (current.lead.answers || {}).photos_link;
    return '<div class="panel"><h2>Files <span class="muted" style="font-family:var(--body);font-size:13px">' + current.files.length + " files · " + fmtSize(total) + "</span></h2>" +
      (link ? '<p style="font-size:14px;margin-bottom:8px">Photo link: ' + linkify(link) + "</p>" : "") +
      (body || '<p class="muted" style="font-size:14px">No files yet.</p>') +
      '<div class="kind"><h3>Add files</h3><div class="addfiles"><select class="inp" id="addKind">' +
      S.FILE_KINDS.map(function (k) { return '<option value="' + k.id + '"' + (k.id === "banner" ? " selected" : "") + ">" + esc(k.label) + "</option>"; }).join("") +
      '</select><label class="btn" for="addInput">Choose files</label><input class="sr-only" type="file" id="addInput" multiple></div></div></div>';
  }

  function checklistPanel(cs) {
    return '<div class="panel"><h2>Build checklist</h2>' +
      '<div class="bigbar"><div class="pbar"><i style="width:' + cs.pct + '%"></i></div><span>' + cs.done + "/" + cs.total + "</span></div>" +
      S.CHECKLIST.map(function (sec) {
        var d = sec.items.filter(function (it) { return cs.cl[it.id]; }).length;
        return '<div class="cl-sec"><h3><span>' + esc(sec.title) + "</span><span>" + d + "/" + sec.items.length + "</span></h3>" +
          sec.items.map(function (it) {
            var st = cs.cl[it.id] || "", from = it.from && it.from(cs.a, cs.files);
            return '<div class="cl-item' + (st === "na" ? " na" : "") + '"><input type="checkbox" id="cl_' + it.id + '" data-cl="' + it.id + '"' + (st === "done" ? " checked" : "") + (st === "na" ? " disabled" : "") + ">" +
              '<label for="cl_' + it.id + '">' + esc(it.label) + (from ? '<span class="from">from intake</span>' : "") + (it.note ? "<small>" + esc(it.note) + "</small>" : "") + "</label>" +
              '<button class="na-btn" data-na="' + it.id + '" title="Not needed for this site">N/A</button></div>';
          }).join("") + "</div>";
      }).join("") + "</div>";
  }

  function wireLead() {
    var l = current.lead;
    $("mStage").addEventListener("change", function (e) { saveLead({ stage: e.target.value }); });
    $("mStart").addEventListener("change", function (e) { saveLead({ start_date: e.target.value || null }); });
    $("mLaunch").addEventListener("change", function (e) { saveLead({ launch_date: e.target.value || null }); });
    $("mDraft").addEventListener("change", function (e) { saveLead({ draft_url: e.target.value.trim() }); });
    var nt;
    $("mNotes").addEventListener("input", function (e) { clearTimeout(nt); nt = setTimeout(function () { saveLead({ internal_notes: e.target.value }, true); }, 700); });
    $("exportBtn").addEventListener("click", exportZip);
    $("editBtn").addEventListener("click", editInfo);
    $("moreBtn").addEventListener("click", moreMenu);

    var view = $("leadView");
    view.querySelectorAll("[data-copy]").forEach(function (b) { b.addEventListener("click", function () { copyText(b.dataset.copy); }); });
    view.querySelectorAll("[data-cl]").forEach(function (cb) {
      cb.addEventListener("change", function () { setChecklist(cb.dataset.cl, cb.checked ? "done" : ""); });
    });
    view.querySelectorAll("[data-na]").forEach(function (b) {
      b.addEventListener("click", function () { var id = b.dataset.na; setChecklist(id, (l.checklist || {})[id] === "na" ? "" : "na"); });
    });
    view.querySelectorAll(".fthumb").forEach(function (t) {
      var open = function () { openViewer(t.dataset.path); };
      t.addEventListener("click", open);
      t.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
    });
    $("addInput").addEventListener("change", function (e) { uploadFiles($("addKind").value, e.target.files); e.target.value = ""; });
  }

  async function setChecklist(id, state) {
    var cl = Object.assign({}, current.lead.checklist || {});
    if (state) { cl[id] = state; } else { delete cl[id]; }
    var ok = await saveLead({ checklist: cl }, true);
    if (ok) {
      var side = document.querySelector(".side");
      var notes = $("mNotes").value;
      var scroll = side.scrollTop;
      side.innerHTML = checklistPanel(checklistState(current.lead, current.files)) +
        '<div class="panel"><h2>Internal notes</h2><textarea class="inp notes" id="mNotes" placeholder="Call notes, what they liked, changes to make...">' + esc(notes) + "</textarea></div>";
      side.scrollTop = scroll;
      wireSide();
    }
  }
  function wireSide() {
    var l = current.lead, side = document.querySelector(".side");
    side.querySelectorAll("[data-cl]").forEach(function (cb) { cb.addEventListener("change", function () { setChecklist(cb.dataset.cl, cb.checked ? "done" : ""); }); });
    side.querySelectorAll("[data-na]").forEach(function (b) { b.addEventListener("click", function () { var id = b.dataset.na; setChecklist(id, (l.checklist || {})[id] === "na" ? "" : "na"); }); });
    var nt;
    $("mNotes").addEventListener("input", function (e) { clearTimeout(nt); nt = setTimeout(function () { saveLead({ internal_notes: e.target.value }, true); }, 700); });
  }

  /* ---------- uploads from the Tracker (full quality, straight to storage) ---------- */
  function safeName(n) { return (String(n).normalize("NFKD").replace(/[^\w.\-]+/g, "-").replace(/-+/g, "-").replace(/^[-.]+/, "") || "file").slice(-90); }

  async function uploadFiles(kind, list) {
    if (!list || !list.length) { return; }
    var id = current.lead.id, rows = [], n = 0;
    for (var i = 0; i < list.length; i++) {
      var file = list[i];
      toast("Uploading " + (i + 1) + " of " + list.length + "...", 60000);
      var path = id + "/" + kind + "/" + Date.now().toString(36) + "-" + safeName(file.name);
      var r = await bucket.upload(path, file, { contentType: file.type || "application/octet-stream", upsert: false });
      if (r.error) { fail(r.error); continue; }
      rows.push({ lead_id: id, kind: kind, path: path, name: file.name, size: file.size, mime: file.type || "", source: "sgs" });
      n++;
    }
    if (rows.length) {
      var ins = await sb.from("lead_files").insert(rows);
      if (ins.error) { fail(ins.error); return; }
    }
    toast(n + " file(s) added");
    openLead(id);
    var l = leads.filter(function (x) { return x.id === id; })[0];
    if (l) { l.lead_files = (l.lead_files || []).concat(rows.map(function (r) { return { kind: r.kind }; })); }
  }

  /* ---------- viewer ---------- */
  function openViewer(path) {
    var list = current.files, i = list.findIndex(function (f) { return f.path === path; });
    var v = $("viewer");
    function show() {
      var f = list[i], url = current.urls[f.path] || "";
      var media = isImage(f) ? '<img src="' + esc(url) + '" alt="' + esc(f.name) + '">'
        : isVideo(f) ? '<video src="' + esc(url) + '" controls autoplay></video>'
        : '<p class="muted">No preview for this file type.</p>';
      v.innerHTML = '<div class="viewer-bar"><span>' + esc(kindLabel(f.kind)) + " · " + esc(f.name) + " · " + fmtSize(f.size) + "</span>" +
        '<span style="display:flex;gap:8px"><a class="btn sm" href="' + esc(url) + '&download=' + encodeURIComponent(f.name) + '">Download</a>' +
        '<button class="btn sm danger" id="vDel">Delete</button><button class="btn sm" id="vClose">Close</button></span></div>' +
        '<div class="viewer-body">' + media + "</div>" +
        (list.length > 1 ? '<button class="viewer-nav prev" id="vPrev" aria-label="Previous">‹</button><button class="viewer-nav next" id="vNext" aria-label="Next">›</button>' : "");
      $("vClose").onclick = close;
      $("vDel").onclick = function () { deleteFiles([f]).then(close); };
      if ($("vPrev")) { $("vPrev").onclick = function () { i = (i - 1 + list.length) % list.length; show(); }; $("vNext").onclick = function () { i = (i + 1) % list.length; show(); }; }
    }
    function close() { v.classList.add("hidden"); v.innerHTML = ""; document.removeEventListener("keydown", keys); }
    function keys(e) {
      if (e.key === "Escape") { close(); }
      if (e.key === "ArrowLeft" && $("vPrev")) { $("vPrev").click(); }
      if (e.key === "ArrowRight" && $("vNext")) { $("vNext").click(); }
    }
    v.classList.remove("hidden"); show();
    document.addEventListener("keydown", keys);
  }

  async function deleteFiles(list) {
    if (!list.length) { return; }
    if (!confirm("Delete " + list.length + " file(s)? This can't be undone.")) { return; }
    var r = await bucket.remove(list.map(function (f) { return f.path; }));
    if (r.error) { fail(r.error); return; }
    var d = await sb.from("lead_files").delete().in("id", list.map(function (f) { return f.id; }));
    if (d.error) { fail(d.error); return; }
    toast("Deleted " + list.length + " file(s)");
    await loadLeads();
    openLead(current.lead.id);
  }

  /* ---------- more menu ---------- */
  function moreMenu() {
    var l = current.lead;
    modal('<h2>More</h2>' +
      '<p class="muted" style="font-size:14px;margin-bottom:14px">Lead ID ' + esc(l.id) + (l.ghl_contact_id ? " · GHL contact " + esc(l.ghl_contact_id) : "") + "</p>" +
      '<div style="display:flex;flex-direction:column;gap:10px;align-items:flex-start">' +
      '<button class="btn" id="mmCopy">Copy intake link pre-filled for this lead</button>' +
      '<button class="btn" id="mmClear">Delete all files (keep the info)</button>' +
      '<button class="btn danger" id="mmDel">Delete this lead completely</button></div>' +
      '<div class="mfoot"><button class="btn" id="mmClose">Close</button></div>');
    $("mmClose").onclick = closeModal;
    $("mmCopy").onclick = function () {
      var p = new URLSearchParams({ name: l.contact_name || "", email: l.email || "", phone: l.phone || "", business: l.business_name || "" });
      copyText(INTAKE_URL + "?" + p.toString()); closeModal();
    };
    $("mmClear").onclick = function () { closeModal(); deleteFiles(current.files.slice()); };
    $("mmDel").onclick = async function () {
      if (!confirm("Delete " + (l.business_name || "this lead") + " and all its files? This can't be undone.")) { return; }
      if (current.files.length) { await bucket.remove(current.files.map(function (f) { return f.path; })); }
      var r = await sb.from("leads").delete().eq("id", l.id);
      if (r.error) { fail(r.error); return; }
      closeModal(); leads = leads.filter(function (x) { return x.id !== l.id; }); location.hash = ""; toast("Lead deleted");
    };
  }

  /* ---------- edit info ---------- */
  function editInfo() {
    var a = current.lead.answers || {};
    var html = "<h2>Edit info</h2>" + S.SECTIONS.map(function (sec) {
      var fields = sec.fields.filter(function (f) { return f.type !== "note" && f.type !== "files"; });
      return "<h3>" + sec.num + " " + esc(sec.title) + '</h3><div class="mgrid">' + fields.map(function (f) {
        var id = "e_" + f.id, v = a[f.id];
        if (f.type === "textarea") { return '<div class="fld full"><label for="' + id + '">' + esc(f.label) + '</label><textarea class="inp" id="' + id + '" rows="3">' + esc(v || "") + "</textarea></div>"; }
        if (f.type === "choice") {
          return '<div class="fld"><label for="' + id + '">' + esc(f.label) + '</label><select class="inp" id="' + id + '"><option value=""></option>' +
            f.options.map(function (o) { return "<option" + (o === v ? " selected" : "") + ">" + esc(o) + "</option>"; }).join("") + "</select></div>";
        }
        if (f.type === "multi") {
          var arr = Array.isArray(v) ? v : [];
          return '<div class="fld"><span class="lbl">' + esc(f.label) + '</span><div class="mchecks" id="' + id + '">' +
            f.options.map(function (o) { return '<label><input type="checkbox" value="' + esc(o) + '"' + (arr.indexOf(o) !== -1 ? " checked" : "") + "> " + esc(o) + "</label>"; }).join("") + "</div></div>";
        }
        if (f.type === "check") { return '<div class="fld full mchecks"><label><input type="checkbox" id="' + id + '"' + (v ? " checked" : "") + "> " + esc(f.label) + "</label></div>"; }
        return '<div class="fld"><label for="' + id + '">' + esc(f.label) + '</label><input class="inp" id="' + id + '" value="' + esc(v || "") + '"></div>';
      }).join("") + "</div>";
    }).join("") + '<div class="mfoot"><button class="btn" id="eCancel">Cancel</button><button class="btn gold" id="eSave">Save</button></div>';
    modal(html);
    $("eCancel").onclick = closeModal;
    $("eSave").onclick = async function () {
      var next = Object.assign({}, a);
      S.allFields().forEach(function (f) {
        var el = $("e_" + f.id);
        if (!el) { return; }
        var v;
        if (f.type === "multi") { v = Array.prototype.map.call(el.querySelectorAll("input:checked"), function (x) { return x.value; }); }
        else if (f.type === "check") { v = el.checked; }
        else { v = el.value.trim(); }
        if ((Array.isArray(v) && !v.length) || v === "" || v === false) { delete next[f.id]; } else { next[f.id] = v; }
      });
      var ok = await saveLead({
        answers: next,
        business_name: next.business_name || "",
        contact_name: next.contact_name || "",
        email: next.contact_email || "",
        phone: next.business_phone || ""
      });
      if (ok) { closeModal(); renderLead(); }
    };
  }

  function modal(html) { $("modalCard").innerHTML = html; $("modal").classList.remove("hidden"); }
  function closeModal() { $("modal").classList.add("hidden"); $("modalCard").innerHTML = ""; }
  $("modal").addEventListener("click", function (e) { if (e.target.id === "modal") { closeModal(); } });

  /* ---------- export build kit ---------- */
  function slug(s) { return String(s || "lead").replace(/[^\w]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "lead"; }

  function briefMarkdown(l, files) {
    var a = l.answers || {}, cs = checklistState(l, files), out = [];
    out.push("# " + (l.business_name || "Untitled lead") + " — Website Build Brief", "");
    out.push("- **Stage:** " + stageLabel(l.stage));
    out.push("- **Submitted:** " + new Date(l.created_at).toLocaleString("en-US"));
    if (l.start_date) { out.push("- **Start date:** " + l.start_date); }
    if (l.launch_date) { out.push("- **Launch date:** " + l.launch_date); }
    if (l.draft_url) { out.push("- **Draft site:** " + l.draft_url); }
    out.push("- **Exported:** " + new Date().toLocaleString("en-US"), "");
    S.SECTIONS.forEach(function (sec) {
      out.push("## " + sec.num + " " + sec.title, "");
      sec.fields.forEach(function (f) {
        if (f.type === "note") { return; }
        if (f.type === "files") {
          var n = files.filter(function (x) { return x.kind === f.kind; }).length;
          out.push("- **" + f.label + ":** " + (n ? n + " file(s) in the `" + folderFor(f.kind) + "` folder" : "_none uploaded_"));
          return;
        }
        var v = a[f.id], txt = Array.isArray(v) ? v.join(", ") : v === true ? "Yes" : (v || "");
        if (txt.indexOf("\n") !== -1) { out.push("- **" + f.label + ":**", "", txt.split("\n").map(function (x) { return "  > " + x; }).join("\n"), ""); }
        else { out.push("- **" + f.label + ":** " + (txt || "_not provided_")); }
      });
      out.push("");
    });
    out.push("## Build checklist (" + cs.done + "/" + cs.total + ")", "");
    S.CHECKLIST.forEach(function (sec) {
      out.push("### " + sec.title);
      sec.items.forEach(function (it) {
        var st = cs.cl[it.id], from = it.from && it.from(a, files);
        out.push("- [" + (st === "done" ? "x" : " ") + "] " + it.label + (st === "na" ? " — N/A" : "") + (from ? " _(from intake)_" : "") + (it.note ? " — " + it.note : ""));
      });
      out.push("");
    });
    var missing = [];
    S.CHECKLIST.forEach(function (sec) { sec.items.forEach(function (it) { if (!cs.cl[it.id] && !(it.from && it.from(a, files))) { missing.push(it.label); } }); });
    if (missing.length) { out.push("## Still missing", "", missing.map(function (m) { return "- " + m; }).join("\n"), ""); }
    if (l.internal_notes) { out.push("## Internal notes", "", l.internal_notes, ""); }
    out.push("## Files", "");
    if (!files.length) { out.push("_No files._"); }
    files.forEach(function (f) { out.push("- `" + folderFor(f.kind) + "/" + f.name + "` (" + fmtSize(f.size) + (f.source === "sgs" ? ", added by SGS" : "") + ")"); });
    return out.join("\n") + "\n";
  }

  function folderFor(kind) {
    var i = S.FILE_KINDS.findIndex(function (k) { return k.id === kind; });
    return String(i + 1).padStart(2, "0") + "-" + kind.replace(/_/g, "-");
  }

  async function exportZip() {
    var btn = $("exportBtn"), l = current.lead, files = current.files;
    btn.disabled = true;
    try {
      var zip = new JSZip(), root = zip.folder("SGS-Build-Kit_" + slug(l.business_name) + "_" + new Date().toISOString().slice(0, 10));
      root.file("BRIEF.md", briefMarkdown(l, files));
      root.file("brief.json", JSON.stringify({ lead: l, files: files.map(function (f) { return { kind: f.kind, folder: folderFor(f.kind), name: f.name, size: f.size, mime: f.mime, source: f.source }; }), schema: { sections: S.SECTIONS.map(function (s) { return { id: s.id, title: s.title, fields: s.fields.map(function (f) { return { id: f.id, label: f.label }; }) }; }) } }, null, 2));
      await signUrls();
      var used = {};
      for (var i = 0; i < files.length; i++) {
        var f = files[i];
        btn.textContent = "Downloading " + (i + 1) + "/" + files.length + "...";
        var res = await fetch(current.urls[f.path]);
        if (!res.ok) { throw new Error("Couldn't download " + f.name); }
        var name = f.name, key = folderFor(f.kind) + "/" + name, n = 1;
        while (used[key]) { name = f.name.replace(/(\.[^.]*)?$/, "-" + (++n) + "$1"); key = folderFor(f.kind) + "/" + name; }
        used[key] = true;
        root.file(key, await res.blob(), { binary: true });
      }
      btn.textContent = "Zipping...";
      var blob = await zip.generateAsync({ type: "blob", compression: "STORE" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "SGS-Build-Kit_" + slug(l.business_name) + ".zip";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 60000);
      toast("Build kit downloaded");
    } catch (e) { fail(e); }
    btn.disabled = false;
    btn.textContent = "Export build kit (.zip)";
  }

  /* ---------- start ---------- */
  sb.auth.onAuthStateChange(function (event) {
    if (event === "PASSWORD_RECOVERY") {
      $("appView").classList.add("hidden");
      $("authView").classList.remove("hidden");
      $("loginForm").classList.add("hidden");
      $("resetForm").classList.remove("hidden");
    }
  });
  sb.auth.getSession().then(function (r) {
    if (location.hash.indexOf("type=recovery") !== -1) { return; }
    if (r.data && r.data.session) { enterApp(); } else { showAuth(); }
  });
})();
