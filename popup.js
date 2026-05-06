/**
 * popup.js — Extension popup controller.
 *
 * Reads state from chrome.storage.session (written by background.js),
 * also listens for live runtime messages so the UI updates in real-time
 * while the test is running.
 */

'use strict';

/* ------------------------------------------------------------------ */
/* DOM refs                                                             */
/* ------------------------------------------------------------------ */
const urlDisplay    = document.getElementById('urlDisplay');
const inputUrl      = document.getElementById('inputUrl');
const urlInputHint  = document.getElementById('urlInputHint');

const panelIdle     = document.getElementById('panelIdle');
const panelProgress = document.getElementById('panelProgress');
const panelResult   = document.getElementById('panelResult');
const panelError    = document.getElementById('panelError');

const btnStart      = document.getElementById('btnStart');
const btnCancel     = document.getElementById('btnCancel');
const btnRetest     = document.getElementById('btnRetest');
const btnRetryError = document.getElementById('btnRetryError');
const btnDevDetails = document.getElementById('btnDevDetails');
const btnCopy       = document.getElementById('btnCopy');
const btnDownload   = document.getElementById('btnDownload');
const devToggleLabel = document.getElementById('devToggleLabel');

const progressSteps = document.getElementById('progressSteps');
const progressNote  = document.getElementById('progressNote');
const steps         = Array.from(progressSteps.querySelectorAll('.step'));

const resultBadge   = document.getElementById('resultBadge');
const resultSummary = document.getElementById('resultSummary');
const resultCause   = document.getElementById('resultCause');
const resultAction  = document.getElementById('resultAction');
const reasonsList   = document.getElementById('reasonsList');
const detailsTable  = document.getElementById('detailsTable');
const scriptsTable  = document.getElementById('scriptsTable');
const suspiciousList= document.getElementById('suspiciousList');
const devDetails    = document.getElementById('devDetails');
const errorMsg      = document.getElementById('errorMsg');

/* ------------------------------------------------------------------ */
/* State                                                                */
/* ------------------------------------------------------------------ */
let currentTargetUrl = '';
let latestState      = null;

/* ------------------------------------------------------------------ */
/* Startup                                                              */
/* ------------------------------------------------------------------ */
document.addEventListener('DOMContentLoaded', async function () {
  /* Resolve the active tab URL and pre-populate the input */
  currentTargetUrl = await getActiveTabUrl();
  populateInput(currentTargetUrl, /* isTabUrl= */ true);
  renderUrlBar(currentTargetUrl);

  /* Load persisted state (test may already be running or done) */
  const stored = await chrome.storage.session.get('bbhdState');
  if (stored.bbhdState) {
    applyState(stored.bbhdState);
  } else {
    showPanel(panelIdle);
  }

  /* Keep URL bar in sync as the user edits the input */
  inputUrl.addEventListener('input', function () {
    clearInputError();
    const val = inputUrl.value.trim();
    if (val) {
      renderUrlBar(val);
      /* Show fallback hint when input is cleared back to empty */
      urlInputHint.textContent = '';
    } else {
      renderUrlBar(currentTargetUrl);
      setInputHint('Empty — will use current tab URL as fallback');
    }
  });

  /* Live updates from background while test is running */
  chrome.runtime.onMessage.addListener(function (msg) {
    if (msg.action === 'statusUpdate' && msg.state) {
      applyState(msg.state);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Button handlers                                                      */
/* ------------------------------------------------------------------ */
btnStart.addEventListener('click', function () {
  const url = resolveTestUrl();

  if (!url) {
    showInputError('Please enter a valid http or https URL.');
    return;
  }
  if (/^(chrome|chrome-extension|edge|about|data|javascript):/i.test(url)) {
    showInputError('Cannot test browser-internal pages. Enter a regular http/https URL.');
    return;
  }

  clearInputError();
  renderUrlBar(url);
  sendToBackground({ action: 'startTest', url });
  showPanel(panelProgress);
  setProgressPhase('preparing');
});

btnCancel.addEventListener('click', function () {
  sendToBackground({ action: 'cancelTest' });
  showPanel(panelIdle);
});

btnRetest.addEventListener('click', function () {
  /* Restore the input to the last tested URL so the user can retest or tweak it */
  if (latestState && latestState.targetUrl) {
    populateInput(latestState.targetUrl, /* isTabUrl= */ false);
    renderUrlBar(latestState.targetUrl);
  }
  showPanel(panelIdle);
});

btnRetryError.addEventListener('click', function () {
  showPanel(panelIdle);
});

btnDevDetails.addEventListener('click', function () {
  const hidden = devDetails.classList.toggle('hidden');
  devToggleLabel.textContent = hidden
    ? 'Show Developer Details ▼'
    : 'Hide Developer Details ▲';
});

btnCopy.addEventListener('click', function () {
  const text = buildPlainTextReport(latestState);
  navigator.clipboard.writeText(text).then(function () {
    const orig = btnCopy.textContent;
    btnCopy.textContent = 'Copied!';
    setTimeout(function () { btnCopy.textContent = orig; }, 1800);
  });
});

btnDownload.addEventListener('click', function () {
  if (!latestState) return;
  const json = JSON.stringify(latestState, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = 'bbhd-report.json';
  a.click();
  URL.revokeObjectURL(url);
});

/* ------------------------------------------------------------------ */
/* State → UI                                                           */
/* ------------------------------------------------------------------ */
function applyState(st) {
  latestState = st;

  /* Keep URL bar in sync */
  if (st.targetUrl) {
    currentTargetUrl = st.targetUrl;
    renderUrlBar(st.targetUrl);
  }

  switch (st.phase) {
    case 'idle':
      showPanel(panelIdle);
      break;

    case 'preparing':
    case 'loading':
    case 'monitoring':
    case 'testing':
    case 'analyzing':
      showPanel(panelProgress);
      setProgressPhase(st.phase);
      break;

    case 'done':
      if (st.result) {
        renderResult(st.result);
        showPanel(panelResult);
      }
      break;

    case 'error':
      errorMsg.textContent = st.error || 'An unexpected error occurred. Please try again.';
      showPanel(panelError);
      break;
  }
}

/* ------------------------------------------------------------------ */
/* Progress UI                                                          */
/* ------------------------------------------------------------------ */
const PHASE_ORDER = ['preparing', 'loading', 'monitoring', 'testing', 'analyzing'];
const PHASE_NOTES = {
  preparing:  'Opening a dedicated test tab with a controlled referrer page…',
  loading:    'Loading the target page in the test tab…',
  monitoring: 'Waiting 8 s while monitoring History API calls, event listeners, and scripts…',
  testing:    'Triggering Back navigation and observing the result…',
  analyzing:  'Scoring the collected signals…',
};

function setProgressPhase(phase) {
  const activeIdx = PHASE_ORDER.indexOf(phase);
  steps.forEach(function (step, i) {
    const p = step.dataset.phase;
    const idx = PHASE_ORDER.indexOf(p);
    step.classList.remove('done', 'active');
    if (idx < activeIdx)  step.classList.add('done');
    if (idx === activeIdx) step.classList.add('active');
  });
  progressNote.textContent = PHASE_NOTES[phase] || '';
}

/* ------------------------------------------------------------------ */
/* Result UI                                                            */
/* ------------------------------------------------------------------ */
function renderResult(result) {
  /* Badge */
  const BADGE_CLASS = {
    'Safe':             'badge-safe',
    'Medium Risk':      'badge-medium',
    'High Risk':        'badge-high',
    'Critical':         'badge-critical',
    'Test Inconclusive':'badge-inconclusive',
  };
  resultBadge.textContent = result.level;
  resultBadge.className   = 'result-badge ' + (BADGE_CLASS[result.level] || '');

  /* Text */
  resultSummary.textContent = result.summary || '';
  resultCause.textContent   = result.likelyCause || '';
  resultAction.textContent  = result.recommendedAction || '';

  /* Reasons */
  reasonsList.innerHTML = '';
  (result.reasons || []).forEach(function (r) {
    const li = document.createElement('li');
    li.textContent = r;
    reasonsList.appendChild(li);
  });

  /* Developer details table */
  const d = result.details || {};
  const rows = [
    ['Initial URL tested',         shortenUrl(d.initialUrl)],
    ['Actual loaded URL',          shortenUrl(d.actualLoadedUrl)],
    ['Final URL after Back',       shortenUrl(d.finalUrlAfterBack)],
    ['Expected referrer URL',      shortenUrl(d.expectedReferrerUrl)],
    ['Back → referrer?',           d.backReturnedToReferrer ? '✅ Yes' : '❌ No'],
    ['Wait time',                  (d.waitTimeSeconds || 8) + ' seconds'],
    ['pushState calls',            d.pushStateCount ?? 0],
    ['replaceState calls',         d.replaceStateCount ?? 0],
    ['popstate listeners',         d.popstateListeners ?? 0],
    ['beforeunload listeners',     d.beforeunloadListeners ?? 0],
    ['unload listeners',           d.unloadListeners ?? 0],
    ['pagehide listeners',         d.pagehideListeners ?? 0],
    ['hashchange listeners',       d.hashchangeListeners ?? 0],
    ['window.open calls',          d.windowOpenCount ?? 0],
    ['New tabs during Back',       d.newTabsOpenedAfterBack ?? 0],
    ['URL changes (during wait)',   d.urlChangesDuringWait ?? 0],
    ['URL changes (after Back)',    d.urlChangesAfterBack ?? 0],
    ['Overlay detected',           d.overlayDetectedDuringTest ? '⚠ Yes' : 'No'],
    /* ---- History flooding fields ---- */
    ['Initial history.length',     d.initialHistoryLength ?? '—'],
    ['Final history.length',       d.finalHistoryLength   ?? '—'],
    ['History length delta',       d.historyLengthDelta != null
                                     ? (d.historyLengthDelta > 0 ? '+' + d.historyLengthDelta : String(d.historyLengthDelta))
                                     : '—'],
    ['pushState timestamps',       (d.pushStateTimestamps   || []).length + ' recorded'],
    ['replaceState timestamps',    (d.replaceStateTimestamps|| []).length + ' recorded'],
    ['URL changes during monitoring', d.urlChangesDuringMonitoring ?? d.urlChangesDuringWait ?? '—'],
    ['History Flooding Suspected', d.historyFloodingSuspected          ? '⚠ Yes' : 'No'],
    ['Possible Infinite Scroll',   d.possibleInfiniteScrollDetected    ? '⚠ Yes' : 'No'],
  ];

  detailsTable.innerHTML = '';
  rows.forEach(function (row) {
    const tr = document.createElement('tr');
    const td1 = document.createElement('td');
    const td2 = document.createElement('td');
    td1.textContent = row[0];
    td2.textContent = String(row[1] ?? '—');
    tr.appendChild(td1);
    tr.appendChild(td2);
    detailsTable.appendChild(tr);
  });

  /* Third-party scripts summary */
  const s = d.thirdPartyScriptsSummary || {};
  const scriptRows = [
    ['Google Ad Manager / GPT', s.googleAdManager  ?? 0],
    ['AdSense',                 s.adSense           ?? 0],
    ['Taboola',                 s.taboola           ?? 0],
    ['Outbrain',                s.outbrain          ?? 0],
    ['Push Notification',       s.pushNotification  ?? 0],
    ['CMP / Consent',           s.cmp               ?? 0],
    ['Social Embeds',           s.socialEmbed       ?? 0],
    ['Other third-party',       s.other             ?? 0],
  ];

  scriptsTable.innerHTML = '';
  scriptRows.forEach(function (row) {
    const tr  = document.createElement('tr');
    const td1 = document.createElement('td');
    const td2 = document.createElement('td');
    td1.textContent = row[0];
    td2.textContent = row[1] + ' script(s)';
    td2.style.color = row[1] > 0 ? 'var(--gray1)' : 'var(--gray3)';
    tr.appendChild(td1);
    tr.appendChild(td2);
    scriptsTable.appendChild(tr);
  });

  /* Suspicious / flagged scripts */
  const flagged = d.suspiciousScripts || [];
  suspiciousList.innerHTML = '';
  if (flagged.length === 0) {
    const li = document.createElement('li');
    li.textContent = 'None flagged.';
    li.style.color = 'var(--gray3)';
    suspiciousList.appendChild(li);
  } else {
    flagged.forEach(function (src) {
      const li = document.createElement('li');
      li.textContent = src;
      suspiciousList.appendChild(li);
    });
  }
}

/* ------------------------------------------------------------------ */
/* Plain-text report builder                                            */
/* ------------------------------------------------------------------ */
function buildPlainTextReport(st) {
  if (!st || !st.result) return 'No report available.';
  const r = st.result;
  const d = r.details || {};

  const lines = [
    '=== Back Button Hijacking Detector Report ===',
    '',
    'Result: ' + r.level,
    '',
    'Summary:',
    r.summary,
    '',
    'Likely Cause:',
    r.likelyCause,
    '',
    'Recommended Action:',
    r.recommendedAction,
    '',
    'Detection Signals:',
    ...(r.reasons || []).map(function (x) { return '  • ' + x; }),
    '',
    '--- Technical Details ---',
    'Initial URL: '          + (d.initialUrl || ''),
    'Actual loaded URL: '    + (d.actualLoadedUrl || ''),
    'Final URL after Back: ' + (d.finalUrlAfterBack || ''),
    'Expected referrer: '    + (d.expectedReferrerUrl || ''),
    'Back → referrer: '      + (d.backReturnedToReferrer ? 'Yes' : 'No'),
    'Wait time: '            + (d.waitTimeSeconds || 8) + 's',
    'pushState calls: '      + (d.pushStateCount ?? 0),
    'replaceState calls: '   + (d.replaceStateCount ?? 0),
    'popstate listeners: '   + (d.popstateListeners ?? 0),
    'beforeunload listeners: '+ (d.beforeunloadListeners ?? 0),
    'window.open calls: '    + (d.windowOpenCount ?? 0),
    'New tabs after Back: '  + (d.newTabsOpenedAfterBack ?? 0),
    'URL changes (wait): '   + (d.urlChangesDuringWait ?? 0),
    'URL changes (back): '   + (d.urlChangesAfterBack ?? 0),
    'Overlay detected: '     + (d.overlayDetectedDuringTest ? 'Yes' : 'No'),
    '',
    'Generated by Back Button Hijacking Detector v1.0 — ' + new Date().toISOString(),
  ];
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */
function showPanel(panel) {
  [panelIdle, panelProgress, panelResult, panelError].forEach(function (p) {
    p.classList.add('hidden');
  });
  panel.classList.remove('hidden');
}

function renderUrlBar(url) {
  if (!url) return;
  urlDisplay.textContent = url;
  urlDisplay.title       = url;
}

function shortenUrl(url) {
  if (!url) return '—';
  try {
    const u = new URL(url);
    const path = u.pathname.length > 40
      ? u.pathname.slice(0, 38) + '…'
      : u.pathname;
    return u.hostname + path;
  } catch (_) {
    return url.length > 55 ? url.slice(0, 53) + '…' : url;
  }
}

function sendToBackground(msg) {
  chrome.runtime.sendMessage(msg, function () {
    void chrome.runtime.lastError;
  });
}

async function getActiveTabUrl() {
  return new Promise(function (resolve) {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      resolve(tabs && tabs[0] ? tabs[0].url || '' : '');
    });
  });
}

/* ------------------------------------------------------------------ */
/* URL input helpers                                                    */
/* ------------------------------------------------------------------ */

/**
 * Resolve the URL to test.
 * Priority: typed input → fallback to current tab URL.
 * Auto-prepends https:// when the user omits the protocol.
 * Returns null if the result is not a parseable http/https URL.
 */
function resolveTestUrl() {
  const raw = inputUrl.value.trim();
  const candidate = raw || currentTargetUrl;
  if (!candidate) return null;

  /* Auto-prepend scheme if the user typed "example.com/article" */
  const withScheme = /^https?:\/\//i.test(candidate)
    ? candidate
    : 'https://' + candidate;

  try {
    const parsed = new URL(withScheme);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      ? parsed.href
      : null;
  } catch (_) {
    return null;
  }
}

/** Pre-populate the URL input. Shows a hint when the value comes from the active tab. */
function populateInput(url, isTabUrl) {
  inputUrl.value = url || '';
  setInputHint(isTabUrl && url ? 'Pre-filled from your current tab — edit to test a different URL' : '');
}

function setInputHint(text) {
  urlInputHint.textContent = text;
  urlInputHint.classList.remove('hint-error');
}

function showInputError(text) {
  urlInputHint.textContent = text;
  urlInputHint.classList.add('hint-error');
  inputUrl.classList.add('input-error');
  inputUrl.focus();
}

function clearInputError() {
  urlInputHint.classList.remove('hint-error');
  inputUrl.classList.remove('input-error');
}
