/**
 * content.js — ISOLATED world content script.
 * Injected programmatically by background.js when a test starts.
 *
 * Responsibilities:
 *  - Receive CustomEvents from injected.js (MAIN world)
 *  - Maintain session data for this page load
 *  - Observe DOM mutations to detect overlays / interstitials
 *  - Answer queries from background.js
 */
(function () {
  if (window.__bbhd_content) return;
  window.__bbhd_content = true;

  /* ------------------------------------------------------------------ */
  /* Session state                                                         */
  /* ------------------------------------------------------------------ */
  const session = {
    initialUrl: location.href,
    pushStateCount: 0,
    replaceStateCount: 0,
    popstateListeners: 0,
    beforeunloadListeners: 0,
    unloadListeners: 0,
    pagehideListeners: 0,
    hashchangeListeners: 0,
    windowOpenCount: 0,
    urlChanges: [],        // { type, from, to, ts }
    thirdPartyScripts: {}, // categories from injected.js
    thirdPartyAll: [],
    overlayDetected: false,
    overlayDetails: null,
    rawEvents: [],
  };

  /* ------------------------------------------------------------------ */
  /* Receive events from injected.js (MAIN world → CustomEvent)          */
  /* ------------------------------------------------------------------ */
  document.addEventListener('__bbhd_event', function (e) {
    const d = e.detail;
    if (!d) return;

    /* Keep a bounded raw event log */
    if (session.rawEvents.length < 200) session.rawEvents.push(d);

    switch (d.type) {
      case 'pushState':
        session.pushStateCount++;
        session.urlChanges.push({ type: 'pushState', from: d.from, to: d.to, ts: d.ts });
        break;

      case 'replaceState':
        session.replaceStateCount++;
        session.urlChanges.push({ type: 'replaceState', from: d.from, to: d.to, ts: d.ts });
        break;

      case 'eventListener':
        switch (d.eventType) {
          case 'popstate':     session.popstateListeners++;     break;
          case 'beforeunload': session.beforeunloadListeners++; break;
          case 'unload':       session.unloadListeners++;       break;
          case 'pagehide':     session.pagehideListeners++;     break;
          case 'hashchange':   session.hashchangeListeners++;   break;
        }
        break;

      case 'windowOpen':
        session.windowOpenCount++;
        break;

      case 'urlChange':
      case 'locationAssign':
      case 'locationReplace':
      case 'hashChange':
        session.urlChanges.push({ type: d.type, from: d.from, to: d.to, ts: d.ts });
        break;

      case 'thirdPartyScripts':
        session.thirdPartyScripts = d.categories;
        session.thirdPartyAll = d.all || [];
        break;

      default:
        break;
    }

    /* Forward a lightweight summary to background so it stays up-to-date */
    safeSend({ action: 'contentUpdate', session: slimSession() });
  });

  /* ------------------------------------------------------------------ */
  /* Overlay / interstitial detection via MutationObserver               */
  /* ------------------------------------------------------------------ */
  function checkForOverlay() {
    const vw = window.innerWidth || 800;
    const vh = window.innerHeight || 600;
    const MIN_W = vw * 0.45;
    const MIN_H = vh * 0.25;
    const MIN_Z = 50;

    const candidates = document.querySelectorAll(
      'div, section, aside, article, dialog, [role="dialog"], [role="alertdialog"]'
    );

    for (let i = 0; i < candidates.length; i++) {
      const el = candidates[i];
      let style;
      try { style = window.getComputedStyle(el); } catch (_) { continue; }

      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;

      const pos = style.position;
      if (pos !== 'fixed' && pos !== 'absolute' && el.tagName !== 'DIALOG') continue;

      const z = parseInt(style.zIndex, 10);
      if (isNaN(z) && el.tagName !== 'DIALOG') continue;
      if (!isNaN(z) && z < MIN_Z) continue;

      let rect;
      try { rect = el.getBoundingClientRect(); } catch (_) { continue; }
      if (rect.width < MIN_W || rect.height < MIN_H) continue;

      /* Looks like an overlay */
      if (!session.overlayDetected) {
        session.overlayDetected = true;
        session.overlayDetails = {
          tag: el.tagName,
          id: el.id || '',
          cls: (typeof el.className === 'string' ? el.className : '').slice(0, 120),
          zIndex: z,
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
        safeSend({ action: 'overlayDetected', details: session.overlayDetails });
      }
      return;
    }
  }

  /* Run an initial check after a short delay */
  setTimeout(checkForOverlay, 800);

  /* Watch for DOM mutations that might add an overlay */
  const mutObs = new MutationObserver(function () {
    if (!session.overlayDetected) checkForOverlay();
  });
  try {
    mutObs.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'class', 'hidden', 'open'],
    });
  } catch (_) { /* best effort */ }

  /* ------------------------------------------------------------------ */
  /* Message handling (from background.js)                               */
  /* ------------------------------------------------------------------ */
  chrome.runtime.onMessage.addListener(function (msg, _sender, reply) {
    if (msg.action === 'getSessionData') {
      reply(slimSession());
      return true;
    }
    if (msg.action === 'scroll') {
      smoothScroll();
      reply({ ok: true });
      return true;
    }
    if (msg.action === 'ping') {
      reply({ alive: true, url: location.href });
      return true;
    }
  });

  /* ------------------------------------------------------------------ */
  /* Helpers                                                              */
  /* ------------------------------------------------------------------ */
  function slimSession() {
    return {
      initialUrl: session.initialUrl,
      pushStateCount: session.pushStateCount,
      replaceStateCount: session.replaceStateCount,
      popstateListeners: session.popstateListeners,
      beforeunloadListeners: session.beforeunloadListeners,
      unloadListeners: session.unloadListeners,
      pagehideListeners: session.pagehideListeners,
      hashchangeListeners: session.hashchangeListeners,
      windowOpenCount: session.windowOpenCount,
      urlChanges: session.urlChanges.slice(-50),
      thirdPartyScripts: session.thirdPartyScripts,
      thirdPartyAll: session.thirdPartyAll.slice(0, 40),
      overlayDetected: session.overlayDetected,
      overlayDetails: session.overlayDetails,
    };
  }

  function safeSend(msg) {
    try {
      chrome.runtime.sendMessage(msg, function () {
        void chrome.runtime.lastError; /* suppress unchecked error */
      });
    } catch (_) { /* service worker may be idle */ }
  }

  function smoothScroll() {
    window.scrollBy({ top: 350, behavior: 'smooth' });
    setTimeout(function () {
      window.scrollBy({ top: -350, behavior: 'smooth' });
    }, 900);
  }

  /* Announce readiness */
  safeSend({ action: 'contentReady', url: location.href });
})();
