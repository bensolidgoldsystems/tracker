/* Solid Gold Systems - Tracker app */
(function () {
  "use strict";
  var S = window.SGS_SCHEMA, C = window.SGS_CONFIG;
  // Read the sign-in link type (invite / recovery / magiclink) before Supabase clears the URL.
  var LINK_TYPE = (location.hash.match(/[#&]type=([a-z_]+)/) || [])[1] || "";
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

  /* ---------- auth: password -> email code -> team check ---------- */
  var AUTH_STEPS = ["loginForm", "resetForm", "mfaForm"];
  function showStep(id, msg, bad) {
    $("appView").classList.add("hidden");
    $("authView").classList.remove("hidden");
    AUTH_STEPS.forEach(function (s) { $(s).classList.toggle("hidden", s !== id); });
    $("authCancel").classList.toggle("hidden", id === "loginForm");
    $("authMsg").textContent = msg || "";
    $("authMsg").classList.toggle("bad", !!bad);
    var first = $(id).querySelector("input");
    if (first) { setTimeout(function () { first.focus(); }, 50); }
  }
  function showAuth(msg, bad) { showStep("loginForm", msg, bad); }

  /* Call one of our Supabase Edge Functions; throws with the function's own error message. */
  async function fn(name, body) {
    var r = await sb.functions.invoke(name, { body: body });
    if (r.error) {
      var msg = r.error.message;
      try { var j = await r.error.context.json(); msg = j.error || msg; } catch (e) { /* keep default */ }
      throw new Error(msg);
    }
    return r.data;
  }

  async function gate() {
    var s = await sb.auth.getSession();
    var session = s.data && s.data.session;
    if (!session) { showAuth(); return; }
    var stored = 0;
    try { stored = Number(localStorage.getItem(LAST_KEY)) || 0; } catch (e) { /* storage blocked */ }
    if (!LINK_TYPE && stored && Date.now() - stored > IDLE_MS) {
      try { await fn("email-2fa", { action: "signout" }); } catch (e) { /* best effort */ }
      await sb.auth.signOut({ scope: "local" });
      showAuth("Signed out after 1 hour of inactivity.");
      return;
    }
    var meta = session.user.user_metadata || {};
    // Invited people and password resets choose a password first.
    if (LINK_TYPE === "invite" || LINK_TYPE === "recovery" || (LINK_TYPE === "magiclink" && !meta.password_set)) {
      $("resetTitle").textContent = LINK_TYPE === "recovery" ? "Choose a new password" : "Welcome! Choose a password";
      showStep("resetForm");
      return;
    }
    var v = await sb.rpc("session_verified");
    if (v.data === true) { enterApp(); return; }
    sendCode(true);
  }

  var resendAt = 0;
  async function sendCode(first) {
    showStep("mfaForm", "Sending code...");
    $("mfaCode").value = "";
    try {
      var d = await fn("email-2fa", { action: "send" });
      $("mfaSent").textContent = "We emailed a 6-digit code to " + d.sent_to + ". It expires in 10 minutes.";
      $("authMsg").textContent = first ? "" : "New code sent.";
      $("authMsg").classList.remove("bad");
      resendAt = Date.now() + 30000;
    } catch (e) {
      $("authMsg").textContent = e.message;
      $("authMsg").classList.add("bad");
      if (/access/i.test(e.message)) { await sb.auth.signOut(); showAuth(e.message, true); }
    }
  }
  $("resendCode").addEventListener("click", function () {
    var wait = Math.ceil((resendAt - Date.now()) / 1000);
    if (wait > 0) { $("authMsg").textContent = "You can request a new code in " + wait + "s."; return; }
    sendCode(false);
  });
  $("mfaForm").addEventListener("submit", async function (e) {
    e.preventDefault();
    var code = $("mfaCode").value.replace(/\D/g, "");
    if (code.length !== 6) { $("authMsg").textContent = "Enter the 6-digit code."; $("authMsg").classList.add("bad"); return; }
    $("authMsg").textContent = "Checking..."; $("authMsg").classList.remove("bad");
    try { await fn("email-2fa", { action: "verify", code: code }); enterApp(); }
    catch (err) { $("authMsg").textContent = err.message; $("authMsg").classList.add("bad"); }
  });

  var myRole = null;
  async function enterApp() {
    var r = await sb.rpc("is_team");
    if (r.error || !r.data) {
      await sb.auth.signOut();
      showAuth("This account doesn't have Tracker access.", true);
      return;
    }
    var role = await sb.rpc("my_role");
    myRole = role.data || "member";
    $("adminLink").classList.toggle("hidden", myRole !== "admin");
    $("authView").classList.add("hidden");
    $("appView").classList.remove("hidden");
    lastPing = 0;
    markActive(true);
    await loadLeads();
    route();
  }

  $("loginForm").addEventListener("submit", async function (e) {
    e.preventDefault();
    $("authMsg").textContent = "Signing in...";
    $("authMsg").classList.remove("bad");
    var r = await sb.auth.signInWithPassword({ email: $("loginEmail").value.trim(), password: $("loginPass").value });
    if (r.error) { showAuth(r.error.message, true); return; }
    LINK_TYPE = "";
    gate();
  });
  $("forgotBtn").addEventListener("click", async function () {
    var email = $("loginEmail").value.trim();
    if (!email) { showAuth("Enter your email first.", true); return; }
    var r = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + "/" });
    showAuth(r.error ? r.error.message : "Check your email for a reset link.", !!r.error);
  });
  $("resetForm").addEventListener("submit", async function (e) {
    e.preventDefault();
    var p1 = $("newPass").value, p2 = $("newPass2").value;
    if (p1.length < 8) { $("authMsg").textContent = "Use at least 8 characters."; $("authMsg").classList.add("bad"); return; }
    if (p1 !== p2) { $("authMsg").textContent = "Passwords don't match."; $("authMsg").classList.add("bad"); return; }
    var r = await sb.auth.updateUser({ password: p1, data: { password_set: true } });
    if (r.error) { $("authMsg").textContent = r.error.message; $("authMsg").classList.add("bad"); return; }
    LINK_TYPE = "";
    toast("Password saved");
    gate();
  });
  async function signOut(msg) {
    try { await fn("email-2fa", { action: "signout" }); } catch (e) { /* best effort */ }
    await sb.auth.signOut({ scope: "local" });   // this device only ("Sign out everywhere" is in Settings)
    location.hash = "";
    myRole = null;
    showAuth(msg || "Signed out.");
  }
  $("signOut").addEventListener("click", function () { signOut(); });

  /* ---------- inactivity timeout: 1 hour without activity = signed out ----------
     Shared across Tracker tabs via localStorage. While active, the Tracker pings the
     server every 5 minutes; the database also refuses data to sessions idle for an hour. */
  var IDLE_MS = 60 * 60 * 1000, PING_MS = 5 * 60 * 1000, LAST_KEY = "sgs-tracker-last-activity";
  var lastLocal = Date.now(), lastPing = 0, lastMark = 0;
  function appOpen() { return !$("appView").classList.contains("hidden"); }
  function lastActivity() {
    var stored = 0;
    try { stored = Number(localStorage.getItem(LAST_KEY)) || 0; } catch (e) { /* storage blocked */ }
    return Math.max(stored, lastLocal);
  }
  function markActive(force) {
    var now = Date.now();
    if (!force && now - lastMark < 15000) { return; }
    lastMark = now; lastLocal = now;
    try { localStorage.setItem(LAST_KEY, String(now)); } catch (e) { /* storage blocked */ }
    if (appOpen() && now - lastPing > PING_MS) {
      lastPing = now;
      fn("email-2fa", { action: "ping" }).then(function (d) { if (d && d.active === false) { idleOut(); } }, function () { /* offline: browser timer still applies */ });
    }
  }
  function idleOut() { if (appOpen()) { signOut("Signed out after 1 hour of inactivity."); } }
  function checkIdle() { if (appOpen() && Date.now() - lastActivity() > IDLE_MS) { idleOut(); } }
  ["mousedown", "mousemove", "keydown", "wheel", "touchstart", "scroll"].forEach(function (ev) {
    window.addEventListener(ev, function () { markActive(false); }, { passive: true, capture: true });
  });
  document.addEventListener("visibilitychange", function () { if (!document.hidden) { checkIdle(); } });
  setInterval(checkIdle, 30000);
  $("authCancel").addEventListener("click", function () { signOut(" "); });

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

  /* ---------- routing ----------
     #  or #clients ... Clients (clients.js)   #client/<id>  #partner/<id>
     #leads ... Website Leads board            #lead/<id>
     #admin  #settings */
  var VIEWS = ["clientsView", "boardView", "leadView", "adminView", "settingsView"];
  function show(id) {
    VIEWS.forEach(function (v) { $(v).classList.toggle("hidden", v !== id); });
    var h = location.hash;
    var onLeads = /^#(leads|lead\/)/.test(h), onClients = !onLeads && !/^#(admin|settings)/.test(h);
    $("tabLeads").classList.toggle("on", onLeads);
    $("tabClients").classList.toggle("on", onClients);
  }
  function route() {
    var h = location.hash;
    var m = h.match(/^#lead\/([0-9a-f-]{36})/);
    if (!m) { current = null; }
    if (h === "#settings") { show("settingsView"); openSettings(); }
    else if (h === "#admin" && myRole === "admin") { show("adminView"); openAdmin(); }
    else if (m) { show("leadView"); openLead(m[1]); }
    else if (h === "#leads") { show("boardView"); renderBoard(); }
    else { show("clientsView"); window.SGSClients.route(h, $("clientsView")); }
    window.scrollTo(0, 0);
  }
  window.addEventListener("hashchange", function () { if (!$("appView").classList.contains("hidden")) { route(); } });

  /* ---------- settings: my account ---------- */
  async function openSettings() {
    var view = $("settingsView");
    view.classList.remove("hidden");
    var s = await sb.auth.getSession();
    var email = (s.data && s.data.session && s.data.session.user.email) || "";
    view.innerHTML = '<a class="back" href="#">← Back</a>' +
      '<div class="lead-head"><div><h1>Settings</h1></div></div>' +
      '<div class="panel"><h2>Account</h2>' +
      '<dl class="ans"><dt>Email</dt><dd>' + esc(email) + '</dd><span></span></dl>' +
      '<dl class="ans"><dt>Role</dt><dd>' + (myRole === "admin" ? "Admin" : "Member") + '</dd><span></span></dl>' +
      '<dl class="ans"><dt>Two-factor</dt><dd>On. Each new sign-in needs a 6-digit code emailed to you.</dd><span></span></dl></div>' +
      '<div class="panel"><h2>Change password</h2>' +
      '<form id="pwForm" class="pw-form" novalidate>' +
      '<div class="fld"><label for="pw1">New password</label><input class="inp" id="pw1" type="password" autocomplete="new-password" minlength="8" required></div>' +
      '<div class="fld"><label for="pw2">Confirm new password</label><input class="inp" id="pw2" type="password" autocomplete="new-password" minlength="8" required></div>' +
      '<div class="fld hidden" id="pwNonceWrap"><label for="pwNonce">Code we just emailed you</label><input class="inp" id="pwNonce" inputmode="numeric" autocomplete="one-time-code"></div>' +
      '<div><button class="btn gold" type="submit" id="pwBtn">Update password</button></div>' +
      '</form><p class="muted" id="pwMsg" style="font-size:13px;margin-top:10px">At least 8 characters.</p></div>' +
      '<div id="settingsExtra"></div>' +
      '<div class="panel"><h2>Sign out</h2>' +
      '<p class="muted" style="font-size:14px;margin-bottom:12px">Signing out everywhere ends your Tracker sessions on every computer and phone. You\'ll need your password and a new code to get back in.</p>' +
      '<div class="addfiles"><button class="btn" id="soHere">Sign out of this device</button><button class="btn danger" id="soAll">Sign out everywhere</button></div></div>';

    var msg = $("pwMsg");
    function say(t, bad) { msg.textContent = t; msg.style.color = bad ? "var(--bad)" : ""; }
    $("pwForm").addEventListener("submit", async function (e) {
      e.preventDefault();
      var p1 = $("pw1").value, p2 = $("pw2").value, nonce = $("pwNonce").value.trim();
      if (p1.length < 8) { say("Use at least 8 characters.", true); return; }
      if (p1 !== p2) { say("Passwords don't match.", true); return; }
      var btn = $("pwBtn"); btn.disabled = true;
      var attrs = { password: p1, data: { password_set: true } };
      if (nonce) { attrs.nonce = nonce; }
      var r = await sb.auth.updateUser(attrs);
      btn.disabled = false;
      if (r.error) {
        // If Supabase's "secure password change" is on, it asks for a code first.
        if (/reauthenticat/i.test(r.error.message || "") || r.error.code === "reauthentication_needed") {
          await sb.auth.reauthenticate();
          $("pwNonceWrap").classList.remove("hidden");
          say("For security, we emailed you a code. Enter it above and click Update password again.");
          return;
        }
        say(r.error.message, true); return;
      }
      $("pw1").value = ""; $("pw2").value = ""; $("pwNonce").value = ""; $("pwNonceWrap").classList.add("hidden");
      say("Password updated.");
      toast("Password updated");
    });
    $("soHere").addEventListener("click", function () { signOut(); });   // this device only
    window.SGSClients.renderSettings($("settingsExtra"));
    $("soAll").addEventListener("click", async function () {
      if (!confirm("Sign out of the Tracker on every device?")) { return; }
      try { await fn("email-2fa", { action: "signout" }); } catch (e) { /* best effort */ }
      await sb.auth.signOut({ scope: "global" });
      location.hash = "";
      myRole = null;
      showAuth("Signed out everywhere.");
    });
  }

  /* ---------- admin: team & access ---------- */
  function ago(d) {
    if (!d) { return "Never"; }
    var s = (Date.now() - new Date(d).getTime()) / 1000;
    if (s < 3600) { return Math.max(1, Math.round(s / 60)) + " min ago"; }
    if (s < 86400) { return Math.round(s / 3600) + " hr ago"; }
    if (s < 86400 * 14) { return Math.round(s / 86400) + " days ago"; }
    return fmtDate(d);
  }

  async function openAdmin() {
    var view = $("adminView");
    view.classList.remove("hidden");
    view.innerHTML = '<a class="back" href="#">← Back</a>' +
      '<div class="lead-head"><div><h1>Team &amp; access</h1><div class="sub">Everyone signs in with their password plus a 6-digit code emailed to them.</div></div></div>' +
      '<div class="panel"><h2>Invite someone</h2>' +
      '<form id="invForm" class="inv-row" novalidate>' +
      '<div class="fld"><label for="invEmail">Email</label><input class="inp" id="invEmail" type="email" placeholder="name@solidgoldsystems.com" required></div>' +
      '<div class="fld"><label for="invRole">Role</label><select class="inp" id="invRole"><option value="member">Member</option><option value="admin">Admin</option></select></div>' +
      '<button class="btn gold" type="submit" id="invBtn">Send invite</button></form>' +
      '<p class="muted" style="font-size:13px;margin-top:10px"><b>Members</b> can see and work on all leads. <b>Admins</b> can also invite and remove people.</p>' +
      '<div id="invResult"></div></div>' +
      '<div class="panel"><h2>Team <span class="muted" id="teamCount" style="font-family:var(--body);font-size:13px"></span></h2><div id="teamList"><p class="muted">Loading...</p></div></div>';
    $("invForm").addEventListener("submit", async function (e) {
      e.preventDefault();
      var email = $("invEmail").value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { toast("Enter a valid email"); return; }
      var btn = $("invBtn"); btn.disabled = true; btn.textContent = "Sending...";
      try {
        var d = await fn("admin-users", { action: "invite", email: email, role: $("invRole").value });
        $("invEmail").value = "";
        showInviteResult(email, d);
        loadTeam();
      } catch (err) { fail(err); }
      btn.disabled = false; btn.textContent = "Send invite";
    });
    loadTeam();
  }

  function showInviteResult(email, d) {
    var box = $("invResult");
    if (d.emailed) {
      box.innerHTML = '<div class="inv-ok">Invitation emailed to <b>' + esc(email) + "</b>. They'll choose a password, then confirm a code sent to their email.</div>";
      return;
    }
    box.innerHTML = '<div class="inv-link"><p>' + (d.note && /account/.test(d.note) ? esc(d.note) : "The email couldn't be sent" + (d.note ? " (" + esc(d.note) + ")" : "") + ". Send them this link yourself:") + "</p>" +
      '<div class="addfiles"><input class="inp" readonly value="' + esc(d.link) + '" id="invLinkVal"><button class="btn" type="button" id="invCopy">Copy link</button></div>' +
      '<p class="muted" style="font-size:12px;margin-top:6px">The link works once and expires in 24 hours.</p></div>';
    $("invCopy").addEventListener("click", function () { copyText(d.link); });
  }

  async function loadTeam() {
    var list = $("teamList");
    try {
      var d = await fn("admin-users", { action: "list" });
      var m = d.members || [];
      $("teamCount").textContent = m.length + (m.length === 1 ? " person" : " people");
      list.innerHTML = '<div class="team">' + m.map(function (u) {
        var status = u.status === "active" ? '<span class="badge ok">Active</span>' : u.status === "invited" ? '<span class="badge warn">Invite pending</span>' : '<span class="badge">No account</span>';
        return '<div class="team-row" data-email="' + esc(u.email) + '">' +
          '<div class="team-who"><b>' + esc(u.email) + "</b>" + (u.is_me ? ' <span class="badge gold">You</span>' : "") +
          '<small>' + status + " · Last sign-in " + esc(ago(u.last_sign_in_at)) + (u.invited_by ? " · Invited by " + esc(u.invited_by) : "") + "</small></div>" +
          '<select class="inp team-role" aria-label="Role for ' + esc(u.email) + '"' + (u.is_me ? " disabled" : "") + ">" +
          '<option value="member"' + (u.role === "member" ? " selected" : "") + '>Member</option><option value="admin"' + (u.role === "admin" ? " selected" : "") + ">Admin</option></select>" +
          '<div class="team-actions">' +
          (u.status !== "active" ? '<button class="btn sm" data-act="link">Copy invite link</button>' : "") +
          (u.status === "active" && !u.is_me ? '<button class="btn sm ghost" data-act="sign_out" title="They will need a new email code next time">Sign out</button>' : "") +
          (u.is_me ? "" : '<button class="btn sm ghost danger" data-act="remove">Remove</button>') +
          "</div></div>";
      }).join("") + "</div>";
      list.querySelectorAll(".team-row").forEach(function (row) {
        var email = row.dataset.email;
        var sel = row.querySelector(".team-role");
        sel.addEventListener("change", async function () {
          try { await fn("admin-users", { action: "set_role", email: email, role: sel.value }); toast(email + " is now " + (sel.value === "admin" ? "an admin" : "a member")); }
          catch (err) { fail(err); loadTeam(); }
        });
        row.querySelectorAll("[data-act]").forEach(function (b) {
          b.addEventListener("click", async function () {
            var act = b.dataset.act;
            if (act === "remove" && !confirm("Remove " + email + " from the Tracker? Their account is deleted and they lose access right away.")) { return; }
            if (act === "sign_out" && !confirm("Sign " + email + " out? They'll need a new email code to get back in.")) { return; }
            b.disabled = true;
            try {
              var d = await fn("admin-users", { action: act, email: email });
              if (act === "link") { copyText(d.link); toast("Invite link copied. It works once and expires in 24 hours.", 4000); }
              if (act === "sign_out") { toast(email + " signed out"); }
              if (act === "remove") { toast(email + " removed"); loadTeam(); }
            } catch (err) { fail(err); }
            b.disabled = false;
          });
        });
      });
    } catch (err) {
      list.innerHTML = '<p class="muted">' + esc(err.message) + "</p>";
    }
  }

  /* ---------- lead detail ---------- */
  async function openLead(id) {
    $("boardView").classList.add("hidden");
    var view = $("leadView");
    view.classList.remove("hidden");
    view.innerHTML = '<a class="back" href="#leads">← Website leads</a><p class="muted">Loading...</p>';
    var r = await sb.from("leads").select("*").eq("id", id).single();
    if (r.error) { view.innerHTML = '<a class="back" href="#leads">← Website leads</a><p class="muted">Lead not found.</p>'; return; }
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

    var html = '<a class="back" href="#leads">← Website leads</a>' +
      '<div class="lead-head"><div><h1>' + esc(l.business_name || "Untitled lead") + "</h1>" +
      '<div class="sub">' + [esc(l.contact_name), gmail, tel, "Submitted " + fmtDate(l.created_at)].filter(Boolean).join(" · ") +
      (l.intake_status === "uploading" ? ' · <span class="badge warn">Upload unfinished</span>' : "") +
      (l.client_id ? ' · <a class="badge gold" href="#client/' + esc(l.client_id) + '">Existing client</a>' : "") + "</div></div>" +
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

      '<div class="layout"><div>' + bannerPanel() + filesPanel() + answersPanels(a) + "</div>" +
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
    current.files.forEach(function (f) { if (f.kind !== "banner") { (byKind[f.kind] = byKind[f.kind] || []).push(f); } });
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
      S.FILE_KINDS.filter(function (k) { return k.id !== "banner"; }).map(function (k) { return '<option value="' + k.id + '"' + (k.id === "headshots" ? " selected" : "") + ">" + esc(k.label) + "</option>"; }).join("") +
      '</select><label class="btn" for="addInput">Choose files</label><input class="sr-only" type="file" id="addInput" multiple></div></div></div>';
  }

  /* ---------- text preview banner (og:image) ---------- */
  function bannerFile() { return current.files.filter(function (f) { return f.kind === "banner"; })[0] || null; }
  function bannerExportName(f) { var ext = (f.name.match(/\.[a-z0-9]+$/i) || [".png"])[0].toLowerCase(); return "og-image" + ext; }

  function bannerPanel() {
    var b = bannerFile(), url = b && current.urls[b.path];
    return '<div class="panel banner-panel"><h2>Text preview banner' +
      (b ? '<span class="badge gold">In export as ' + esc(bannerExportName(b)) + "</span>" : '<span class="badge warn">Not added</span>') + "</h2>" +
      '<div class="banner-row">' +
      (b
        ? '<button class="banner-img" data-path="' + esc(b.path) + '" aria-label="Open banner">' + (url ? '<img alt="Text preview banner" src="' + esc(url) + '">' : "") + "</button>"
        : '<label class="banner-img empty" for="bannerInput"><strong>Upload banner</strong><span>1200 × 630 PNG or JPG</span></label>') +
      '<div class="banner-side"><p class="muted">The image people see when the site link is shared in a text, iMessage, Facebook or Slack. It exports as <code>' + (b ? esc(bannerExportName(b)) : "og-image.png") + "</code> at the top of the zip.</p>" +
      '<div class="addfiles"><label class="btn' + (b ? "" : " gold") + '" for="bannerInput">' + (b ? "Replace" : "Upload banner") + "</label>" +
      (b ? '<button class="btn ghost danger" id="bannerRemove">Remove</button>' : "") +
      '<input class="sr-only" type="file" id="bannerInput" accept="image/png,image/jpeg,image/webp"></div>' +
      (b ? '<p class="muted" style="font-size:12px;margin-top:8px">' + esc(b.name) + " · " + fmtSize(b.size) + '<span id="bannerDims"></span></p>' : "") +
      "</div></div></div>";
  }

  function wireBanner() {
    var b = bannerFile();
    $("bannerInput").addEventListener("change", function (e) { var f = e.target.files[0]; e.target.value = ""; if (f) { uploadBanner(f); } });
    if (b) {
      $("bannerRemove").addEventListener("click", function () { deleteFiles([b]); });
      var btn = document.querySelector(".banner-img[data-path]");
      if (btn) { btn.addEventListener("click", function () { openViewer(b.path); }); }
      var img = document.querySelector(".banner-img img");
      if (img) {
        img.addEventListener("load", function () {
          var ok = img.naturalWidth === 1200 && img.naturalHeight === 630;
          $("bannerDims").textContent = " · " + img.naturalWidth + " × " + img.naturalHeight + (ok ? "" : " (1200 × 630 recommended)");
        });
      }
    }
  }

  async function uploadBanner(file) {
    var id = current.lead.id, old = current.files.filter(function (f) { return f.kind === "banner"; });
    toast("Uploading banner...", 60000);
    var path = id + "/banner/" + Date.now().toString(36) + "-" + safeName(file.name);
    var r = await bucket.upload(path, file, { contentType: file.type || "image/png", upsert: false });
    if (r.error) { fail(r.error); return; }
    var ins = await sb.from("lead_files").insert({ lead_id: id, kind: "banner", path: path, name: file.name, size: file.size, mime: file.type || "", source: "sgs" });
    if (ins.error) { fail(ins.error); return; }
    if (old.length) {   // one banner per lead: the new one replaces the old
      await bucket.remove(old.map(function (f) { return f.path; }));
      await sb.from("lead_files").delete().in("id", old.map(function (f) { return f.id; }));
    }
    var cl = Object.assign({}, current.lead.checklist || {});
    cl.banner = "done";
    await saveLead({ checklist: cl }, true);
    toast("Banner saved");
    await loadLeads();
    openLead(id);
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
              '<label for="cl_' + it.id + '">' + esc(it.label) + (from ? '<span class="from">provided</span>' : "") + (it.note ? "<small>" + esc(it.note) + "</small>" : "") + "</label>" +
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
    wireBanner();
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
      (l.client_id ? '<a class="btn gold" href="#client/' + esc(l.client_id) + '" id="mmConvert">Open client</a>' : '<button class="btn gold" id="mmConvert">Convert to client</button>') +
      '<button class="btn" id="mmCopy">Copy intake link pre-filled for this lead</button>' +
      '<button class="btn" id="mmClear">Delete all files (keep the info)</button>' +
      '<button class="btn danger" id="mmDel">Delete this lead completely</button></div>' +
      '<div class="mfoot"><button class="btn" id="mmClose">Close</button></div>');
    $("mmClose").onclick = closeModal;
    $("mmConvert").onclick = function (e) { if (l.client_id) { closeModal(); return; } e.preventDefault(); closeModal(); window.SGSClients.convertLead(l); };
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
      closeModal(); leads = leads.filter(function (x) { return x.id !== l.id; }); location.hash = "leads"; toast("Lead deleted");
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
    var bn = files.filter(function (x) { return x.kind === "banner"; })[0];
    out.push("- **Text preview banner:** " + (bn ? "`" + bannerExportName(bn) + "` (top of this zip; use as og:image / twitter:image)" : "_not added yet_"));
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
        out.push("- [" + (st === "done" ? "x" : " ") + "] " + it.label + (st === "na" ? " — N/A" : "") + (from ? " _(provided)_" : "") + (it.note ? " — " + it.note : ""));
      });
      out.push("");
    });
    var missing = [];
    S.CHECKLIST.forEach(function (sec) { sec.items.forEach(function (it) { if (!cs.cl[it.id] && !(it.from && it.from(a, files))) { missing.push(it.label); } }); });
    if (missing.length) { out.push("## Still missing", "", missing.map(function (m) { return "- " + m; }).join("\n"), ""); }
    if (l.internal_notes) { out.push("## Internal notes", "", l.internal_notes, ""); }
    out.push("## Files", "");
    if (!files.length) { out.push("_No files._"); }
    files.forEach(function (f) { out.push("- `" + (f.kind === "banner" ? bannerExportName(f) : folderFor(f.kind) + "/" + f.name) + "` (" + fmtSize(f.size) + (f.source === "sgs" ? ", added by SGS" : "") + ")"); });
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
        if (f.kind === "banner") { root.file(bannerExportName(f), await res.blob(), { binary: true }); continue; }
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

  /* ---------- clients module (clients.js) ---------- */
  window.SGSClients.init({
    sb: sb, $: $, esc: esc, toast: toast, fail: fail, copyText: copyText, fmtDate: fmtDate,
    linkify: linkify, modal: modal, closeModal: closeModal
  });

  /* ---------- start ---------- */
  sb.auth.onAuthStateChange(function (event) {
    if (event === "PASSWORD_RECOVERY") { LINK_TYPE = "recovery"; gate(); }
  });
  gate();
})();
