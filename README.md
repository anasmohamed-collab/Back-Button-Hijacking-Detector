# Back Button Hijacking Detector

A **production-ready Chrome Extension (Manifest V3)** for SEO QA specialists.  
Detects back-button hijacking behavior on any webpage — fully offline, no external APIs, no build step.

---

## What Is Back Button Hijacking?

Back button hijacking occurs when a webpage manipulates the browser's history stack or intercepts navigation events so that pressing the Back button does **not** return the user to the previous page. Instead, the user may be:

- Trapped in a navigation loop on the same site
- Redirected to an ad, interstitial, or unrelated URL
- Shown a popup or full-screen overlay that blocks exit
- Silently kept on the page via `beforeunload` listeners

This is a negative UX signal and may affect crawlability and user engagement metrics relevant to SEO.

---

## Installation (Developer / Unpacked Mode)

1. Download or clone this repository so all files are in a single folder.
2. Open Chrome and navigate to `chrome://extensions`.
3. Enable **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked**.
5. Select the root folder containing `manifest.json`.
6. The extension icon (blue shield with orange warning badge) will appear in the Chrome toolbar.  
   Pin it via the puzzle-piece menu if needed.

> **Chrome version requirement:** Chrome 95 or later (required for `scripting.executeScript` with `world: "MAIN"`).

---

## How to Run a Test

1. In Chrome, open any article or news page you want to test (navigate to the URL manually).
2. Click the extension icon to open the popup.
3. Confirm the URL shown in the popup matches the page you want to test.
4. Click **Start Test**.
5. A new background tab will open automatically — do not close it.
6. The popup will show live progress through five stages:
   - **Preparing** — creating the test environment with a controlled referrer page
   - **Loading** — navigating the test tab to the target URL
   - **Monitoring** — waiting 8 seconds while recording History API calls, event listeners, and loaded scripts
   - **Testing Back** — triggering a Back navigation and observing the result
   - **Analyzing** — scoring all collected signals
7. A result badge (**Safe / Medium Risk / High Risk / Critical**) appears with a plain-English explanation.
8. Expand **Developer Details** for the full technical breakdown.
9. Use **Copy Report** or **Download JSON** to save the result.

---

## Risk Levels Explained

### ✅ Safe
Back navigation returned to the expected previous page with no suspicious behavior. No action required.  
_Consider also testing on mobile Chrome/Safari, where behavior can differ._

### ⚠ Medium Risk
The page uses browser History API calls (`pushState` / `replaceState`) or registers navigation event listeners (`popstate`, `beforeunload`), **but Back navigation still worked correctly**. This is common in infinite-scroll news pages and single-page apps.  
_Review whether history modifications are necessary and test manually on mobile._

### 🔶 High Risk
Back navigation **did not return to the previous page**. The user remained on the tested site or was redirected to another internal URL. This strongly indicates history manipulation designed to delay or prevent exit.  
_Audit all scripts using `history.pushState`, `history.replaceState`, `popstate`, `beforeunload`, or interstitial logic._

### 🔴 Critical
Back navigation triggered a **popup, new tab, external redirect, or navigation loop**. The user is actively trapped. This is the most severe form of back button hijacking.  
_Immediately escalate to the development and ad-ops teams. Identify and remove or reconfigure the offending scripts._

---

## How the Test Works (Technical)

### Controlled Referrer Method
Because a Chrome extension cannot inspect the full browser history stack, the extension uses a **controlled referrer approach**:

1. A new tab is opened and navigated to the extension's own `referrer.html` page — this becomes the known "previous" history entry.
2. The same tab is then navigated to the **target URL** — building a two-entry history stack: `[referrer.html → target]`.
3. After 8 seconds of monitoring, `chrome.tabs.goBack()` is called.
4. The extension checks where the tab ends up.
   - **If it lands on `referrer.html`** → Back worked correctly (Safe or Medium).
   - **If it stays on the target site** → Back was blocked or hijacked (High Risk).
   - **If it opens new tabs or redirects externally** → Active hijacking (Critical).

### What Is Monitored
The extension injects a script into the **page's JavaScript context** (bypassing CSP via `world: "MAIN"`) that monkey-patches:

| Signal | Method |
|---|---|
| `history.pushState` calls | Patched directly |
| `history.replaceState` calls | Patched directly |
| `popstate` / `beforeunload` / `unload` / `pagehide` / `hashchange` listeners | `EventTarget.prototype.addEventListener` patch |
| `window.open` calls | Patched directly |
| `location.assign` / `location.replace` | Patched with fallback to URL polling |
| URL changes (via `location.href =`) | 400 ms polling loop |
| DOM overlays / interstitials | `MutationObserver` in content script |
| Third-party script categories | DOM script-tag scan |
| New tabs spawned during/after Back | `chrome.tabs.onCreated` in background |

### Verdict Is Behavior-Based
The final score is **not** determined by whether `pushState` or `replaceState` was detected. Those APIs are used legitimately by millions of news and media sites for infinite scroll and SPA routing.  
The verdict is primarily driven by **what actually happens after Back is pressed**.

---

## Known Limitations

| Limitation | Notes |
|---|---|
| **Single back-press** | The test presses Back once. Pages that add exactly one fake entry may require two presses — this test would classify that as High Risk. |
| **Server-side redirects** | If the target page immediately 301/302-redirects, the test runs on the redirected destination, not the original URL. The "Actual Loaded URL" field in Developer Details will show the difference. |
| **CSP blocking injected script** | `world: "MAIN"` injection bypasses page CSP. However, on extremely locked-down pages (e.g., certain banking portals) injection may still silently fail. History API patching will then not be available, but behavioral scoring (final URL check, new-tab detection) still works. |
| **Mobile Chrome / Safari** | This extension runs on desktop Chrome only. Mobile browsers handle back gestures differently and may show different behavior. Always perform a manual back-button test on iOS Safari and Android Chrome for high-risk URLs. |
| **Infinite scroll false positives** | Pages with legitimate infinite scroll will push multiple history entries. If scroll occurred during the 8-second wait, Back may land on an intermediate scroll position rather than `referrer.html`. The extension will report **High Risk** in this case. Cross-reference with the `pushState count` and `URL changes during wait` fields in Developer Details. |
| **Login-gated pages** | Pages that redirect unauthenticated users to a login screen will be tested against the login page, not the original article. |
| **Service worker lifecycle** | If Chrome kills the extension's background service worker mid-test (rare), the test will be marked as an error. Simply run it again. |
| **Extension pages cannot be tested** | `chrome://`, `chrome-extension://`, and `edge://` URLs cannot be tested. The extension will show an error if you try. |

---

## Why Results Are Behavior-Based (Not API-Based)

Early detection approaches flagged any use of `history.pushState` as suspicious. This produces many false positives because virtually every modern news website uses the History API for:

- **Infinite scroll** — updating the URL as the user scrolls through articles
- **SPA routing** — navigating between sections without a full page reload
- **Canonical URL normalization** — using `replaceState` to clean up tracking parameters

The BBHD extension treats History API usage as **evidence to consider**, not as a verdict. It assigns **Medium Risk** only when Back still works, and escalates to **High Risk** only when Back actually fails to leave the site.

---

## Recommended Manual Validation Steps (Mobile)

After running the extension test, validate manually on mobile for any Medium Risk or higher result:

1. **Android Chrome** — Open the URL, wait 5–10 seconds, tap the back button (bottom navigation bar). Does it leave the page?
2. **iOS Safari** — Open the URL, wait 5–10 seconds, tap the `‹` back button in the browser toolbar. Does it return to the previous page? Try the back swipe gesture from the left edge.
3. **Check for interstitials** — Look for any popup, consent wall, or overlay that appears immediately when you press Back.
4. **Check the address bar** — After pressing Back, does the URL change to the previous page or does it stay on the tested domain?

---

## Privacy Note

**All testing runs entirely within your local browser. No data ever leaves your device.**

- No external API calls are made.
- No URLs, page content, or test results are transmitted anywhere.
- Test results are stored in `chrome.storage.session` (cleared when Chrome closes) and exist only in your browser.
- The extension has no analytics, no telemetry, and no remote configuration.

---

## File Structure

```
Back-Button-Hijacking-Detector/
├── manifest.json       — Extension manifest (MV3)
├── background.js       — Service worker: test orchestration and scoring
├── content.js          — Isolated-world content script: event relay and overlay detection
├── injected.js         — Main-world script: History API and event patching
├── popup.html          — Extension popup UI
├── popup.css           — Popup styles
├── popup.js            — Popup controller
├── referrer.html       — Controlled referrer page (previous history entry)
├── icons/
│   ├── icon16.svg
│   ├── icon48.svg
│   └── icon128.svg
└── README.md
```

---

## Permissions Used

| Permission | Reason |
|---|---|
| `activeTab` | Read the URL of the currently active tab to populate the popup |
| `scripting` | Inject `content.js` (isolated world) and `injected.js` (main world) into the test tab |
| `tabs` | Create the test tab, navigate it, call `goBack()`, and detect new tabs |
| `storage` | Persist test state in `chrome.storage.session` so the popup survives being closed and reopened mid-test |
| `host_permissions: <all_urls>` | Required by `scripting` to inject scripts into any domain |

No browsing history, cookies, or page content is accessed beyond what is needed for the navigation behavior test.
