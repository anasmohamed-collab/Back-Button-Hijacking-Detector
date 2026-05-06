/**
 * injected.js — runs in the MAIN (page) world via scripting.executeScript.
 * Monkey-patches History API, addEventListener, window.open, and location
 * methods, then dispatches CustomEvents back to content.js in the ISOLATED world.
 */
(function () {
  if (window.__bbhd_injected) return;
  window.__bbhd_injected = true;

  /* ------------------------------------------------------------------ */
  /* Helper: dispatch a typed event that content.js will receive         */
  /* ------------------------------------------------------------------ */
  function emit(type, detail) {
    document.dispatchEvent(
      new CustomEvent('__bbhd_event', {
        detail: Object.assign({ type, ts: Date.now() }, detail),
      })
    );
  }

  /* ------------------------------------------------------------------ */
  /* 1. history.pushState                                                 */
  /* ------------------------------------------------------------------ */
  const _pushState = history.pushState.bind(history);
  history.pushState = function (state, title, url) {
    emit('pushState', { from: location.href, to: String(url ?? '') });
    return _pushState(state, title, url);
  };

  /* ------------------------------------------------------------------ */
  /* 2. history.replaceState                                              */
  /* ------------------------------------------------------------------ */
  const _replaceState = history.replaceState.bind(history);
  history.replaceState = function (state, title, url) {
    emit('replaceState', { from: location.href, to: String(url ?? '') });
    return _replaceState(state, title, url);
  };

  /* ------------------------------------------------------------------ */
  /* 3. EventTarget.prototype.addEventListener — track key events        */
  /* ------------------------------------------------------------------ */
  const TRACKED = new Set([
    'popstate',
    'beforeunload',
    'unload',
    'pagehide',
    'hashchange',
  ]);
  const _addEventListener = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, listener, opts) {
    if (TRACKED.has(type) && (this === window || this === document)) {
      emit('eventListener', { eventType: type });
    }
    return _addEventListener.call(this, type, listener, opts);
  };

  /* ------------------------------------------------------------------ */
  /* 4. window.open                                                       */
  /* ------------------------------------------------------------------ */
  const _windowOpen = window.open.bind(window);
  window.open = function (url, target, features) {
    emit('windowOpen', { url: String(url ?? ''), target: String(target ?? '') });
    return _windowOpen(url, target, features);
  };

  /* ------------------------------------------------------------------ */
  /* 5. location.assign / location.replace                               */
  /*    These are non-configurable on some browsers; use try/catch.      */
  /* ------------------------------------------------------------------ */
  try {
    const _assign = location.assign.bind(location);
    // eslint-disable-next-line no-extend-native
    location.assign = function (url) {
      emit('locationAssign', { url: String(url) });
      return _assign(url);
    };
  } catch (_) { /* read-only in strict CSP — fallback: URL polling below */ }

  try {
    const _replace = location.replace.bind(location);
    location.replace = function (url) {
      emit('locationReplace', { url: String(url) });
      return _replace(url);
    };
  } catch (_) { /* read-only — URL polling covers this */ }

  /* ------------------------------------------------------------------ */
  /* 6. URL-change polling (catches location.href = "..." assignments)   */
  /* ------------------------------------------------------------------ */
  let lastHref = location.href;
  const urlPoll = setInterval(function () {
    if (location.href !== lastHref) {
      emit('urlChange', { from: lastHref, to: location.href });
      lastHref = location.href;
    }
  }, 400);

  /* ------------------------------------------------------------------ */
  /* 7. hashchange on window (belt-and-suspenders)                       */
  /* ------------------------------------------------------------------ */
  window.addEventListener('hashchange', function (e) {
    emit('hashChange', { from: e.oldURL, to: e.newURL });
  });

  /* ------------------------------------------------------------------ */
  /* 8. Third-party script detection                                      */
  /* ------------------------------------------------------------------ */
  function classifyScripts() {
    const pageHost = location.hostname;
    const srcs = Array.from(document.querySelectorAll('script[src]'))
      .map(function (s) { return s.src; })
      .filter(function (src) {
        try { return new URL(src).hostname !== pageHost; } catch (_) { return false; }
      });

    const cats = {
      googleAdManager: [],
      adSense: [],
      taboola: [],
      outbrain: [],
      pushNotification: [],
      cmp: [],
      socialEmbed: [],
      other: [],
    };

    const rules = [
      [/googletag|doubleclick|googleadservices/i, 'googleAdManager'],
      [/adsbygoogle|googlesyndication/i, 'adSense'],
      [/taboola/i, 'taboola'],
      [/outbrain/i, 'outbrain'],
      [/onesignal|pushwoosh|webpushr|aimtell|pushcrew|sendpulse/i, 'pushNotification'],
      [/cookielaw|cookiebot|quantcast|trustarc|onetrust|usercentrics|didomi|consentmanager|crownpeak/i, 'cmp'],
      [/facebook\.net|twitter\.com|instagram\.com|tiktok\.com|youtube\.com|linkedin\.com|pinterest/i, 'socialEmbed'],
    ];

    const bucketed = new Set();
    srcs.forEach(function (src) {
      for (let i = 0; i < rules.length; i++) {
        if (rules[i][0].test(src)) {
          cats[rules[i][1]].push(src);
          bucketed.add(src);
          break;
        }
      }
      if (!bucketed.has(src)) cats.other.push(src);
    });

    emit('thirdPartyScripts', { all: srcs.slice(0, 60), categories: cats });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', classifyScripts);
  } else {
    classifyScripts();
  }
  /* Re-scan after 4 s for dynamically injected scripts */
  setTimeout(classifyScripts, 4000);

  /* Announce injection */
  emit('injected', { url: location.href });
})();
