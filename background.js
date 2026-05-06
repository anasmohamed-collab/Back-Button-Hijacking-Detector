/**
 * background.js — MV3 Service Worker
 *
 * Orchestrates the back-button hijacking test:
 *   1. Create a dedicated test tab.
 *   2. Navigate to the extension's referrer.html (controlled entry point).
 *   3. Navigate forward to the target URL.
 *   4. Inject monitoring scripts.
 *   5. Wait 8 seconds, scroll, collect pre-back data.
 *   6. Trigger chrome.tabs.goBack().
 *   7. Wait up to 5 seconds for navigation to settle.
 *   8. Collect final URL, score the result, persist, notify popup.
 */

'use strict';

const REFERRER_URL  = chrome.runtime.getURL('referrer.html');
const WAIT_MS       = 8000;   // monitoring window
const BACK_WAIT_MS  = 5000;   // time after goBack() to observe
const SETTLE_MS     = 800;    // post-load settle delay

/* ------------------------------------------------------------------ */
/* Persistent test state (in-memory; mirrored to storage.session)     */
/* ------------------------------------------------------------------ */
let state = makeIdleState();

function makeIdleState() {
  return {
    phase: 'idle',       // idle | preparing | loading | monitoring | testing | analyzing | done | error
    targetUrl: '',
    referrerUrl: REFERRER_URL,
    testTabId: null,
    startedAt: null,
    error: null,
    /* live session data from content script */
    session: null,
    /* post-analysis */
    result: null,
    finalUrl: null,
    newTabsOpenedCount: 0,
    /* history-length snapshots for flooding detection */
    initialHistoryLength: null,
    finalHistoryLength: null,
  };
}

function persist() {
  chrome.storage.session.set({ bbhdState: state }).catch(() => {});
}

function setPhase(phase, extra) {
  state.phase = phase;
  if (extra) Object.assign(state, extra);
  persist();
  broadcastStatus();
}

function broadcastStatus() {
  chrome.runtime.sendMessage({ action: 'statusUpdate', state }).catch(() => {});
}

/* ------------------------------------------------------------------ */
/* Message router                                                       */
/* ------------------------------------------------------------------ */
chrome.runtime.onMessage.addListener(function (msg, sender, reply) {
  switch (msg.action) {
    case 'startTest':
      startTest(msg.url).catch(function (err) {
        setPhase('error', { error: err.message });
      });
      reply({ ok: true });
      break;

    case 'cancelTest':
      cancelTest();
      reply({ ok: true });
      break;

    case 'getState':
      reply(state);
      break;

    case 'contentReady':
    case 'contentUpdate':
      if (sender.tab && sender.tab.id === state.testTabId && msg.session) {
        state.session = msg.session;
        persist();
      }
      break;

    case 'overlayDetected':
      if (sender.tab && sender.tab.id === state.testTabId) {
        if (state.session) state.session.overlayDetected = true;
        persist();
      }
      break;
  }
  return true;
});

/* ------------------------------------------------------------------ */
/* Main test orchestration                                              */
/* ------------------------------------------------------------------ */
async function startTest(targetUrl) {
  /* Clean up any previous test tab */
  await maybeCloseTab(state.testTabId);

  state = makeIdleState();
  state.targetUrl = targetUrl;
  state.startedAt = Date.now();
  setPhase('preparing');

  /* Track new tabs spawned by the test page */
  let newTabCount = 0;
  function onTabCreated(tab) {
    if (tab.openerTabId === state.testTabId) {
      newTabCount++;
      /* Close rogue tabs to avoid polluting the user's browser */
      chrome.tabs.remove(tab.id).catch(() => {});
    }
  }
  chrome.tabs.onCreated.addListener(onTabCreated);

  try {
    /* ---- Step 1: open tab at referrer ---- */
    const tab = await chrome.tabs.create({ url: REFERRER_URL, active: false });
    state.testTabId = tab.id;
    persist();

    await waitForLoad(tab.id);

    /* ---- Step 2: navigate to target ---- */
    setPhase('loading');
    await chrome.tabs.update(tab.id, { url: targetUrl });
    await waitForLoad(tab.id);

    /* Record actual URL after any server-side redirects */
    const loadedTab = await chrome.tabs.get(tab.id).catch(() => null);
    const actualLoadedUrl = loadedTab ? loadedTab.url : targetUrl;

    /* ---- Step 3: inject scripts ---- */
    await injectMonitoring(tab.id);

    /* Capture history.length baseline before any scroll / ad activity */
    state.initialHistoryLength = await readHistoryLength(tab.id);
    persist();

    /* ---- Step 4: monitor for WAIT_MS ---- */
    setPhase('monitoring');
    await sleep(WAIT_MS);

    /* Human-like scroll to trigger lazy ads/scripts */
    await scrollPage(tab.id);
    await sleep(1200);

    /* Capture history.length after scroll — delta reveals flooding */
    state.finalHistoryLength = await readHistoryLength(tab.id);
    persist();

    /* Snapshot session data before back */
    const preBack = await querySessionData(tab.id);
    if (preBack) state.session = preBack;

    const urlChangesBeforeBack = (state.session?.urlChanges || []).length;
    persist();

    /* ---- Step 5: back navigation ---- */
    setPhase('testing');

    newTabCount = 0; /* reset so we only count post-back opens */

    let navCompleted = false;
    const navPromise = new Promise(function (resolve) {
      function onUpdated(tabId, info) {
        if (tabId === tab.id && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(onUpdated);
          navCompleted = true;
          setTimeout(resolve, SETTLE_MS);
        }
      }
      chrome.tabs.onUpdated.addListener(onUpdated);
      /* Fallback: resolve after BACK_WAIT_MS regardless */
      setTimeout(function () {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }, BACK_WAIT_MS);
    });

    await chrome.tabs.goBack(tab.id).catch(() => {});
    await navPromise;

    /* ---- Step 6: collect post-back state ---- */
    setPhase('analyzing');

    const finalTab = await chrome.tabs.get(tab.id).catch(() => null);
    const finalUrl = finalTab ? finalTab.url : 'unknown';
    state.finalUrl = finalUrl;
    state.newTabsOpenedCount = newTabCount;

    /* Get post-back session data if content script is still alive */
    const postBack = await querySessionData(tab.id).catch(() => null);
    const urlChangesAfterBack = postBack
      ? (postBack.urlChanges || []).slice(urlChangesBeforeBack)
      : [];

    if (postBack) state.session = postBack;

    /* ---- Step 7: score ---- */
    const result = score({
      targetUrl,
      actualLoadedUrl,
      finalUrl,
      referrerUrl: REFERRER_URL,
      session: state.session || {},
      urlChangesAfterBack,
      newTabsOpened: newTabCount,
      navCompleted,
      initialHistoryLength: state.initialHistoryLength,
      finalHistoryLength: state.finalHistoryLength,
    });

    state.result = result;
    setPhase('done');

    /* Close test tab after a short pause so user can see it went back */
    setTimeout(function () { maybeCloseTab(tab.id); }, 1500);

  } catch (err) {
    setPhase('error', { error: err.message });
  } finally {
    chrome.tabs.onCreated.removeListener(onTabCreated);
  }
}

function cancelTest() {
  maybeCloseTab(state.testTabId);
  state = makeIdleState();
  persist();
  broadcastStatus();
}

/* ------------------------------------------------------------------ */
/* Scoring engine                                                       */
/* ------------------------------------------------------------------ */
function score(ctx) {
  const {
    targetUrl,
    actualLoadedUrl,
    finalUrl,
    referrerUrl,
    session,
    urlChangesAfterBack,
    newTabsOpened,
    initialHistoryLength,
    finalHistoryLength,
  } = ctx;

  let targetHost = '';
  try { targetHost = new URL(targetUrl).hostname; } catch (_) {}

  let finalHost = '';
  try { finalHost = new URL(finalUrl).hostname; } catch (_) {}

  const isReferrer             = finalUrl === referrerUrl;
  const isExtensionPage        = finalUrl.startsWith('chrome-extension://');
  const stayedOnSite           = (finalHost === targetHost) && !isReferrer && finalHost !== '';
  const redirectedOut          = (finalHost !== targetHost) && !isExtensionPage && !isReferrer && finalHost !== '';
  const redirectedToOtherExtPage = isExtensionPage && !isReferrer;

  const ps  = session.pushStateCount        || 0;
  const rs  = session.replaceStateCount     || 0;
  const pop = session.popstateListeners     || 0;
  const bu  = session.beforeunloadListeners || 0;
  const wo  = session.windowOpenCount       || 0;

  const scripts = session.thirdPartyScripts || {};
  const hasSuspiciousScripts = (scripts.pushNotification || []).length > 0;

  /* ---------------------------------------------------------------- */
  /* History flooding detection                                         */
  /* ---------------------------------------------------------------- */

  /* Derive per-call timestamps from the already-recorded urlChanges */
  const pushStateTimestamps = (session.urlChanges || [])
    .filter(function (c) { return c.type === 'pushState'; })
    .map(function (c) { return c.ts; });

  const replaceStateTimestamps = (session.urlChanges || [])
    .filter(function (c) { return c.type === 'replaceState'; })
    .map(function (c) { return c.ts; });

  /* Delta in browser history.length over the monitoring window */
  const historyDelta =
    (finalHistoryLength != null && initialHistoryLength != null)
      ? finalHistoryLength - initialHistoryLength
      : null;

  /* Burst: 3+ pushState calls within any 5-second window */
  const burstPushState = detectBurstActivity(pushStateTimestamps, 3, 5000);

  const totalUrlChanges = (session.urlChanges || []).length;

  /*
   * Flooding is suspected when any of these are true:
   *   - history.length grew by more than 3 entries
   *   - 3+ pushState calls arrived in a 5-second burst
   *   - 3+ pushState calls total AND 3+ URL changes (heavy churn)
   *
   * NOTE: flooding alone never triggers Critical. It is a supporting
   * signal that adjusts Medium → "verify" and High → "flooding amplified".
   */
  const historyFloodingSuspected =
    (historyDelta !== null && historyDelta > 3) ||
    burstPushState ||
    (ps >= 3 && totalUrlChanges >= 3);

  /* Infinite scroll is the probable cause when pushState is involved */
  const possibleInfiniteScroll = historyFloodingSuspected && ps > 0;

  /*
   * A "suspicious signal" is anything that could explain why Back failed.
   * If Back failed but NONE of these are present the test is inconclusive —
   * the test environment itself (tab timing, CSP, pre-existing history stack)
   * may have interfered rather than the page hijacking the Back button.
   */
  const hasAnySuspiciousSignal =
    ps > 0 ||
    rs > 0 ||
    pop > 0 ||
    bu > 0 ||
    wo > 0 ||
    session.overlayDetected ||
    urlChangesAfterBack.length > 0 ||
    newTabsOpened > 0 ||
    redirectedOut ||
    (historyDelta !== null && historyDelta > 0) ||
    totalUrlChanges > 0 ||
    hasSuspiciousScripts;

  /* Inconclusive: back failed, but nothing to explain why */
  const isInconclusive = !isReferrer && !hasAnySuspiciousSignal;

  /* ---------------------------------------------------------------- */
  /* Scoring                                                            */
  /* ---------------------------------------------------------------- */
  let risk = 0; // 0=safe 1=medium 2=high 3=critical
  const reasons = [];

  /* ---- CRITICAL ---- */
  if (newTabsOpened > 0) {
    reasons.push(`${newTabsOpened} new browser tab(s) opened during or immediately after Back navigation`);
    risk = Math.max(risk, 3);
  }
  if (redirectedOut) {
    reasons.push(`Back button redirected to an unrelated external URL: ${finalUrl}`);
    risk = Math.max(risk, 3);
  }
  if (wo > 0 && !isReferrer) {
    reasons.push(`window.open() called ${wo} time(s); page may have triggered a popup`);
    risk = Math.max(risk, 3);
  }
  if (urlChangesAfterBack.length >= 3) {
    reasons.push(`${urlChangesAfterBack.length} URL changes detected after Back — possible navigation loop`);
    risk = Math.max(risk, 3);
  }

  /* ---- HIGH ---- */
  /* Skip this block entirely when the result is inconclusive — no supporting
     signals means we cannot attribute the Back failure to the page itself. */
  if (!isReferrer && !redirectedOut && risk < 2 && !isInconclusive) {
    if (stayedOnSite) {
      reasons.push('Back button did not return to the previous page — user remained on the tested site');
      risk = Math.max(risk, 2);
    } else if (redirectedToOtherExtPage) {
      reasons.push('Back returned to a different extension page rather than the expected referrer');
      risk = Math.max(risk, 2);
    }
  }
  if (!isReferrer && (ps > 0 || rs > 0)) {
    let msg = `History API calls detected (${ps} pushState, ${rs} replaceState) and Back did not return to referrer`;
    if (historyFloodingSuspected) {
      msg += historyDelta !== null
        ? `. History grew by +${historyDelta} entries — aggressive flooding likely contributed to Back navigation failure`
        : '. Burst or aggressive history manipulation detected';
    }
    reasons.push(msg);
    risk = Math.max(risk, 2);
  }
  /* Flooding without explicit pushState/replaceState detection */
  if (!isReferrer && historyFloodingSuspected && ps === 0 && rs === 0) {
    reasons.push(
      `History flooding detected (history.length grew by +${historyDelta}) ` +
      `without detected pushState/replaceState calls — navigation scripts may be manipulating history indirectly`
    );
    risk = Math.max(risk, 2);
  }
  if (session.overlayDetected && !isReferrer) {
    reasons.push('A full-screen overlay or interstitial was detected while the page prevented Back navigation');
    risk = Math.max(risk, 2);
  }
  if (bu > 0 && !isReferrer) {
    reasons.push(`${bu} beforeunload listener(s) detected — may be blocking Back navigation`);
    risk = Math.max(risk, 2);
  }
  if (urlChangesAfterBack.length > 0 && urlChangesAfterBack.length < 3 && stayedOnSite) {
    reasons.push(`${urlChangesAfterBack.length} URL change(s) occurred after Back while still on the tested site`);
    risk = Math.max(risk, 2);
  }

  /* ---- MEDIUM (only when Back returned correctly) ---- */
  if (isReferrer) {
    if (ps > 0 || rs > 0) {
      if (historyFloodingSuspected) {
        /* Flooding detected — give a more specific, SEO-friendly explanation */
        const deltaStr = historyDelta !== null ? ` (history.length grew by +${historyDelta})` : '';
        const scrollNote = possibleInfiniteScroll
          ? ' This pattern is typical of infinite article scroll — each new article section pushes a history entry.'
          : '';
        reasons.push(
          `History flooding suspected${deltaStr}: ${ps} pushState call(s), ${rs} replaceState call(s) detected ` +
          `during the monitoring window. Back still returned correctly.${scrollNote}`
        );
      } else {
        reasons.push(
          `History API used (${ps} pushState, ${rs} replaceState) — Back still returned correctly. ` +
          `Common in infinite scroll; verify no fake entries were added.`
        );
      }
      risk = Math.max(risk, 1);
    }
    if (pop > 0) {
      reasons.push(`${pop} popstate listener(s) registered — Back navigation functioned correctly`);
      risk = Math.max(risk, 1);
    }
    if (bu > 0) {
      reasons.push(`${bu} beforeunload listener(s) detected — Back still worked but warrants review`);
      risk = Math.max(risk, 1);
    }
    if (hasSuspiciousScripts) {
      reasons.push('Push notification script(s) detected — typically associated with aggressive re-engagement tactics');
      risk = Math.max(risk, 1);
    }
    if (session.overlayDetected) {
      reasons.push('A large overlay was detected during monitoring but Back navigation succeeded');
      risk = Math.max(risk, 1);
    }
    /* Flooding with no pushState detected (e.g. replaceState-only or indirect) */
    if (historyFloodingSuspected && ps === 0 && rs === 0) {
      reasons.push(
        historyDelta !== null
          ? `History grew by +${historyDelta} entries during monitoring despite no direct pushState/replaceState calls — a third-party script may be modifying history`
          : 'Burst history activity detected despite no direct API calls — possible indirect manipulation'
      );
      risk = Math.max(risk, 1);
    }
  }

  /* ---- SAFE fallback ---- */
  if (isReferrer && risk === 0) {
    reasons.push('Back navigation returned to the expected previous page with no suspicious behavior detected');
  }

  /* ---- INCONCLUSIVE (back failed but zero supporting signals) ---- */
  if (isInconclusive) {
    reasons.push(
      'Back navigation did not return to the expected referrer, but no suspicious signals were detected ' +
      '(pushState: 0, replaceState: 0, redirects: 0, overlays: No, new tabs: 0, URL changes: 0, ' +
      'history.length delta: 0). This may be a test-environment issue rather than back button hijacking.'
    );
  }

  /* ---------------------------------------------------------------- */
  /* Build level label and context-sensitive text                       */
  /* ---------------------------------------------------------------- */
  const LEVELS = ['Safe', 'Medium Risk', 'High Risk', 'Critical'];
  const level  = isInconclusive ? 'Test Inconclusive' : LEVELS[risk];

  const MANUAL_CHECK_TIP =
    'Manual check: open the article in a fresh tab, run ' +
    'console.log(window.history.length) in DevTools Console, scroll normally ' +
    'for 5–10 seconds, then run it again. If the number increases by more than 2–3, ' +
    'the page is flooding browser history.';

  /* Base text maps */
  const summaryMap = {
    'Safe':
      'The page returned to the previous page correctly after pressing Back. ' +
      'No suspicious navigation behavior was detected during this test.',
    'Medium Risk':
      'The page shows some browser history modification (common in infinite scroll or single-page apps), ' +
      'but Back navigation still functioned correctly. ' +
      'Manual review and mobile testing are recommended.',
    'High Risk':
      'The page did not return to the expected previous page after pressing Back. ' +
      'This indicates browser history manipulation or a back-button-triggered ad, popup, or redirect.',
    'Critical':
      'Critical back button hijacking detected. The page triggered a popup, new tab, external redirect, ' +
      'or navigation loop when Back was pressed — trapping the user.',
    'Test Inconclusive':
      'The Back test did not return to the expected referrer, but the extension did not detect any clear ' +
      'browser history manipulation, redirect, popup, or overlay. This may be a test-environment issue ' +
      'or a behavior that requires manual validation.',
  };

  const causeMap = {
    'Safe':        'No significant third-party script interference detected.',
    'Medium Risk': 'A third-party ad, infinite scroll, or analytics script may be using history.pushState for legitimate purposes. Behavior appears controlled.',
    'High Risk':   'A third-party ad, popup, recommendation, or navigation script is likely manipulating browser history to delay or prevent Back navigation.',
    'Critical':    'A third-party ad, interstitial, push-notification, or redirect script is actively hijacking the Back button, opening popups, or creating navigation loops.',
    'Test Inconclusive':
      'No browser history manipulation, redirect, popup, overlay, or suspicious script behavior was detected. ' +
      'The Back navigation failure may be caused by the extension test environment (tab timing, pre-existing ' +
      'history stack, or CSP restrictions) rather than the page itself.',
  };

  const actionMap = {
    'Safe':
      'No action required. Consider also testing on mobile Chrome and Safari where back button behavior can differ from desktop.',
    'Medium Risk':
      'Review any infinite scroll implementation and confirm history.pushState is used only for legitimate URL updates. Run a manual back-button test on mobile.',
    'High Risk':
      'Ask the development and ad-ops teams to audit scripts using history.pushState, history.replaceState, popstate, beforeunload, redirects, or interstitial logic.',
    'Critical':
      'Immediately investigate and remove or reconfigure the scripts causing back button hijacking. This is a serious UX and potential SEO issue. Escalate to development and ad-ops teams.',
    'Test Inconclusive':
      'Manually test the URL from a Google search result or mobile browser and check DevTools history ' +
      'behavior before escalating to development. In DevTools, open the Console and run ' +
      'console.log(window.history.length) before and after pressing Back to observe any change.',
  };

  /* Override with flooding-specific, SEO-friendly text where relevant */
  let summary           = summaryMap[level];
  let likelyCause       = causeMap[level];
  let recommendedAction = actionMap[level];

  if (possibleInfiniteScroll) {
    if (level === 'Medium Risk') {
      summary =
        'The page appears to add multiple browser history entries during scrolling. ' +
        'Back navigation still worked correctly in this test, but users may need to press ' +
        'Back several times before leaving the site.';
      likelyCause =
        'Possible infinite article scroll is adding too many browser history entries. ' +
        'The page uses history.pushState() as the user scrolls through articles — common in news sites — ' +
        'but the number of entries added during this short test is higher than expected.';
      recommendedAction =
        'Review the infinite scroll implementation and ensure history.pushState is not called ' +
        'more frequently than necessary. Each call adds a history entry; users may need many ' +
        'Back presses to leave the site. ' + MANUAL_CHECK_TIP;
    } else if (level === 'High Risk') {
      likelyCause =
        'Aggressive browser history flooding — likely from infinite article scroll using ' +
        'history.pushState — combined with other navigation behavior prevented the Back button ' +
        'from returning to the previous page.';
      recommendedAction =
        'Ask the development team to audit the infinite scroll implementation and limit pushState ' +
        'frequency. Users on mobile are especially affected. ' + MANUAL_CHECK_TIP;
    }
  } else if (historyFloodingSuspected && level === 'Medium Risk') {
    likelyCause =
      'Browser history is growing faster than expected. This may be caused by a third-party ' +
      'script, navigation logic, or replaceState calls that run on page load or during ad rendering.';
    recommendedAction = actionMap[level] + ' ' + MANUAL_CHECK_TIP;
  }

  /* ---------------------------------------------------------------- */
  /* Build suspicious script list                                       */
  /* ---------------------------------------------------------------- */
  const suspiciousScriptList = [...(scripts.pushNotification || [])].slice(0, 20);

  /* ---------------------------------------------------------------- */
  /* Return result                                                      */
  /* ---------------------------------------------------------------- */
  return {
    level,
    risk,
    summary,
    likelyCause,
    recommendedAction,
    reasons,
    details: {
      initialUrl: targetUrl,
      actualLoadedUrl,
      finalUrlAfterBack: finalUrl,
      expectedReferrerUrl: referrerUrl,
      backReturnedToReferrer: isReferrer,
      waitTimeSeconds: WAIT_MS / 1000,
      /* History flooding fields */
      initialHistoryLength: initialHistoryLength ?? null,
      finalHistoryLength:   finalHistoryLength   ?? null,
      historyLengthDelta:   historyDelta,
      pushStateTimestamps,
      replaceStateTimestamps,
      urlChangesDuringMonitoring: totalUrlChanges,
      historyFloodingSuspected,
      possibleInfiniteScrollDetected: possibleInfiniteScroll,
      /* Existing fields */
      pushStateCount: ps,
      replaceStateCount: rs,
      popstateListeners: pop,
      beforeunloadListeners: bu,
      unloadListeners: session.unloadListeners || 0,
      pagehideListeners: session.pagehideListeners || 0,
      hashchangeListeners: session.hashchangeListeners || 0,
      windowOpenCount: wo,
      newTabsOpenedAfterBack: newTabsOpened,
      urlChangesDuringWait: totalUrlChanges,
      urlChangesAfterBack: urlChangesAfterBack.length,
      overlayDetectedDuringTest: session.overlayDetected || false,
      overlayDetails: session.overlayDetails || null,
      thirdPartyScriptsSummary: {
        googleAdManager:  (scripts.googleAdManager  || []).length,
        adSense:          (scripts.adSense           || []).length,
        taboola:          (scripts.taboola           || []).length,
        outbrain:         (scripts.outbrain          || []).length,
        pushNotification: (scripts.pushNotification  || []).length,
        cmp:              (scripts.cmp               || []).length,
        socialEmbed:      (scripts.socialEmbed       || []).length,
        other:            (scripts.other             || []).length,
      },
      suspiciousScripts: suspiciousScriptList,
      allThirdPartyScripts: session.thirdPartyAll || [],
      classificationReasons: reasons,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Burst-activity detector                                             */
/* Returns true if `count` or more timestamps fall within `windowMs`. */
/* ------------------------------------------------------------------ */
function detectBurstActivity(timestamps, count, windowMs) {
  if (!timestamps || timestamps.length < count) return false;
  const sorted = timestamps.slice().sort(function (a, b) { return a - b; });
  for (let i = 0; i <= sorted.length - count; i++) {
    if (sorted[i + count - 1] - sorted[i] <= windowMs) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Read window.history.length from the page's MAIN world               */
/* ------------------------------------------------------------------ */
async function readHistoryLength(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: function () { return window.history.length; },
    });
    return (results && results[0] && results[0].result != null)
      ? results[0].result
      : null;
  } catch (_) {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Utilities                                                            */
/* ------------------------------------------------------------------ */
function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

function waitForLoad(tabId, timeout = 30000) {
  return new Promise(function (resolve) {
    /* Check if already loaded */
    chrome.tabs.get(tabId, function (tab) {
      if (chrome.runtime.lastError || !tab) { resolve(); return; }
      if (tab.status === 'complete') { setTimeout(resolve, SETTLE_MS); return; }

      const timer = setTimeout(function () {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }, timeout);

      function listener(id, info) {
        if (id === tabId && info.status === 'complete') {
          clearTimeout(timer);
          chrome.tabs.onUpdated.removeListener(listener);
          setTimeout(resolve, SETTLE_MS);
        }
      }
      chrome.tabs.onUpdated.addListener(listener);
    });
  });
}

async function injectMonitoring(tabId) {
  /* Isolated world first (content.js) */
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content.js'],
    world: 'ISOLATED',
  }).catch(() => {});

  /* Main world (injected.js) — bypasses page CSP */
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['injected.js'],
    world: 'MAIN',
  }).catch(() => {});

  await sleep(400);
}

async function scrollPage(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: function () {
      window.scrollBy({ top: 400, behavior: 'smooth' });
      setTimeout(function () { window.scrollBy({ top: -400, behavior: 'smooth' }); }, 900);
    },
  }).catch(() => {});
}

function querySessionData(tabId) {
  return new Promise(function (resolve) {
    chrome.tabs.sendMessage(tabId, { action: 'getSessionData' }, function (resp) {
      void chrome.runtime.lastError;
      resolve(resp || null);
    });
  });
}

function maybeCloseTab(tabId) {
  if (!tabId) return Promise.resolve();
  return chrome.tabs.remove(tabId).catch(() => {});
}

/* ------------------------------------------------------------------ */
/* Restore state after service worker restart                           */
/* ------------------------------------------------------------------ */
chrome.storage.session.get('bbhdState', function (res) {
  if (res.bbhdState) {
    state = res.bbhdState;
    /* If service worker was killed mid-test, mark it as an error */
    if (state.phase !== 'idle' && state.phase !== 'done' && state.phase !== 'error') {
      state.phase = 'error';
      state.error = 'Test interrupted — the browser extension runtime was restarted. Please run the test again.';
      persist();
    }
  }
});
