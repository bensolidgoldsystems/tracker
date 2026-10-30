/* Solid Gold Systems Tracker - ads on/off and billing cycles, shared by Clients and Overview.
   public.ad_events holds two kinds of rows:
     source 'meta'   - written by the meta-sync function from actual spend (and whether any campaign
                       is ACTIVE right now). These are the source of truth.
     source 'manual' - typed in Tracker (the Ads switch, past dates, scheduled dates, notes).
   A manual launch/pause within DEDUPE_DAYS of a Meta event in the same direction is treated as the
   same change and hidden (shown greyed in the timeline), so old hand-entered dates don't double up;
   so is a hand-entered change that doesn't change anything (a pause while Meta already shows paused).
   Billing cycle: 30 live days per cycle. Day 1 is the day ads went live; paused days don't count;
   the count carries on when ads relaunch and starts over after "stopped". */
(function () {
  "use strict";
  var DEDUPE_DAYS = 10, CYCLE_DAYS = 30;
  var ON = { launched: 1, relaunched: 1 }, OFF = { paused: 1, stopped: 1 };

  function today() { var t = new Date(); return t.getFullYear() + "-" + String(t.getMonth() + 1).padStart(2, "0") + "-" + String(t.getDate()).padStart(2, "0"); }
  function days(a, b) { return Math.round((new Date(b + "T12:00:00Z") - new Date(a + "T12:00:00Z")) / 864e5); }
  function addDays(s, n) { var d = new Date(s + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  function dir(k) { return ON[k] ? "on" : OFF[k] ? "off" : ""; }
  function newestFirst(a, b) { return a.event_date < b.event_date ? 1 : a.event_date > b.event_date ? -1 : ((a.created_at || "") < (b.created_at || "") ? 1 : -1); }

  // Mark manual events Meta already covers: e._replaced = true.
  function mark(all, clientId) {
    var mine = all.filter(function (e) { return e.client_id === clientId; });
    var meta = mine.filter(function (e) { return e.source === "meta"; });
    mine.forEach(function (e) {
      e._replaced = false;
      if (e.source === "meta" || !meta.length || e.kind === "stopped" || !dir(e.kind) || e.event_date > today()) { return; }
      // Same change as a nearby Meta date, unless Meta shows the opposite change in between
      // (then the hand-entered one is a newer, separate change and stands).
      e._replaced = meta.some(function (m) {
        if (dir(m.kind) !== dir(e.kind) || Math.abs(days(m.event_date, e.event_date)) > DEDUPE_DAYS) { return false; }
        var lo = m.event_date < e.event_date ? m.event_date : e.event_date, hi = m.event_date < e.event_date ? e.event_date : m.event_date;
        return !meta.some(function (o) { return dir(o.kind) && dir(o.kind) !== dir(e.kind) && o.event_date > lo && o.event_date <= hi; });
      });
    });
    // A hand-entered pause while already paused (or launch while live) changes nothing: drop it too.
    if (meta.length) {
      var t = today(), cur = "";
      mine.filter(function (e) { return dir(e.kind) && !e._replaced && e.event_date <= t; })
        .sort(function (a, b) { return -newestFirst(a, b); })
        .forEach(function (e) {
          if (e.source !== "meta" && e.kind !== "stopped" && dir(e.kind) === cur) { e._replaced = true; e._same = true; return; }
          cur = dir(e.kind);
        });
    }
    return mine;
  }
  // On/off events for a client, newest first (no notes, nothing Meta replaced).
  function events(all, clientId, includeFuture) {
    var t = today();
    return mark(all, clientId).filter(function (e) { return dir(e.kind) && !e._replaced && (includeFuture || e.event_date <= t); }).sort(newestFirst);
  }
  // "live", "paused", "stopped" or null, as of today.
  function state(all, clientId) {
    var ev = events(all, clientId);
    if (!ev.length) { return null; }
    return ON[ev[0].kind] ? "live" : ev[0].kind;
  }
  function liveSince(all, clientId) {
    var ev = events(all, clientId);
    return ev.length && ON[ev[0].kind] ? ev[0].event_date : null;
  }
  // Where the client is in its billing cycle today, or null if ads never went live.
  //   { live, cycle, day, liveDays, nextCharge (date, when live), daysLeft, cycleStart (when live) }
  function cycle(all, clientId) {
    var t = today();
    var ev = events(all, clientId).slice().reverse();
    var total = 0, from = null;
    ev.forEach(function (e) {
      if (ON[e.kind]) { if (!from) { from = e.event_date; } return; }
      if (from) { total += Math.max(0, days(from, e.event_date)); from = null; }
      if (e.kind === "stopped") { total = 0; }
    });
    var live = !!from;
    if (live) { total += days(from, t) + 1; }
    if (!total) { return null; }
    var n = Math.ceil(total / CYCLE_DAYS), d = total - (n - 1) * CYCLE_DAYS, left = CYCLE_DAYS - d;
    return {
      live: live, cycle: n, day: d, liveDays: total, daysLeft: left,
      nextCharge: live ? addDays(t, left + 1) : null,
      cycleStart: live && d <= days(from, t) + 1 ? addDays(t, 1 - d) : null
    };
  }
  // Is any linked Meta account running a campaign right now? true / false / null (unknown).
  function delivering(accounts, client) {
    var ids = client.meta_ad_account_ids || [], known = false, on = false;
    (accounts || []).forEach(function (a) {
      if (ids.indexOf(a.ad_account_id) === -1 || a.delivering == null) { return; }
      known = true; if (a.delivering) { on = true; }
    });
    return known ? on : null;
  }

  window.SGSAds = { events: events, mark: mark, state: state, liveSince: liveSince, cycle: cycle, delivering: delivering, CYCLE_DAYS: CYCLE_DAYS };
})();
