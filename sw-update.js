// sw-update.js — Plotline service-worker auto-upgrade.
//
// Included by app.html, index.html and console.html. The SW shell cache is
// cache-first, so a stale version keeps serving the old app forever unless
// something notices a new version and takes over. This script does that
// automatically: it checks for a new worker, activates it without a prompt,
// and reloads the page once the new worker controls it.
//
// Nothing here uses navigator.serviceWorker APIs when unsupported (very old
// browsers): Plotline simply runs online-cached as before.
(function () {
  'use strict';

  var RELOAD_GUARD = 'plotline-sw-reload';
  if (!('serviceWorker' in navigator)) return;

  var refreshing = false;
  var hadController = Boolean(navigator.serviceWorker.controller);

  // Reload exactly once when a new worker takes control of this page.
  navigator.serviceWorker.addEventListener('controllerchange', function () {
    if (!hadController || refreshing) {
      hadController = true; // first install passing through: stay on this load
      return;
    }
    refreshing = true;
    try {
      var stamped = sessionStorage.getItem(RELOAD_GUARD);
      if (stamped === String(Date.now() - (Date.now() % 10000))) return;
      sessionStorage.setItem(RELOAD_GUARD, String(Date.now() - (Date.now() % 10000)));
    } catch (e) { /* sessionStorage unavailable; the boolean still guards */ }
    window.location.reload();
  });

  function adoptWaiting(reg) {
    var waiting = reg && reg.waiting;
    if (waiting && reg.active) waiting.postMessage({ type: 'SKIP_WAITING' });
  }

  function watch(reg) {
    // A new worker is already waiting (installed during a previous visit).
    adoptWaiting(reg);
    // Any worker that appears later also gets adopted immediately.
    reg.addEventListener('updatefound', function () {
      var nw = reg.installing || null;
      nw && nw.addEventListener('statechange', function () {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) adoptWaiting(reg);
      });
    });
    // Poll periodically so a long-lived open tab still converges.
    setInterval(function () { reg.update().catch(function () {}); }, 15 * 60 * 1000);
  }

  function refreshNow() { navigator.serviceWorker.getRegistration().then(function (r) { r && r.update().catch(function () {}); }); }

  window.addEventListener('focus', refreshNow);
  window.addEventListener('online', refreshNow);
  window.addEventListener('visibilitychange', function () { if (!document.hidden) refreshNow(); });

  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
    .then(watch)
    .catch(function () { /* offline-first still works without the worker */ });
})();
