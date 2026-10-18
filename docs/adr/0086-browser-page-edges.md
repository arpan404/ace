# 0086: Page edge cases in every browser engine

Date: 2026-10-17. Status: accepted. Amends [ADR 0067](0067-browser-parity.md),
[ADR 0083](0083-browser-v2-daemon-chrome.md), [ADR 0084](0084-use-my-chrome.md) and
[ADR 0085](0085-desktop-native-view-lifecycle.md).

## Context

The 2026-10-17 browser audit found pages that real browsers handle and ace's engines did not:
HTTP sign-ins, certificate warnings and OAuth popups (issue 948), sound (949), file pickers,
downloads and console warnings (950), and offline pages, printing and zoom (954). Engines are named as in the
audit: the desktop's native view (D), ace's Chrome (H) and Use my Chrome (U).

## Decision

### Sign-ins, certificates and popups (948)

**What only the person answers.** A site's HTTP sign-in and a certificate warning are answered
only from a person's client connection: `browser.auth.answer` and `browser.certificate.proceed`.
Neither is a `BrowserCommand`, so no agent tool can send them. ADR 0002 holds: credentials the
person types go from their client to the engine for that one request and are never stored,
logged or shown to an agent.

- **Sign-in (H).** ace's Chrome enables `Fetch.handleAuthRequests` for top-level documents.
  `Fetch.authRequired` becomes the tab's `pending_auth` (`authId`, origin, realm, scheme); the
  answer is passed to `Fetch.continueWithAuth` (`ProvideCredentials` or `CancelAuth`). A newer
  challenge cancels the older one; a committed page or a new target ends it. Like a dialog, a
  pending sign-in holds its tab: every command but a navigation or history step returns
  `{pending_auth, hint}`, so an agent learns that it needs the person. D keeps its own native
  prompt window (credentials stay in Electron's auth cache); U is the person's own Chrome.
- **Certificate warnings (D, H).** Both engines report a tab's `certificate_error` (`url`, error
  name) from its main document's network failure until a real page commits. The web panel shows
  it with "Proceed anyway (unsafe)". H then calls Chrome's own interstitial `proceed()`, which
  records the exception for that host and certificate until the browser restarts. D keeps
  `CertificateExceptions` (origin plus certificate fingerprint) per thread browser, in memory, and
  trusts only an exact match in `certificate-error`. The request carries the URL the person saw;
  a different warning refuses it. An agent's input, script or click on a tab showing a warning
  fails with `needs_person`: the interstitial's own "proceed" link is the person's too. It may
  still read the page or navigate away.
- **OAuth popups (D, H).** A `window.open` with features or a name (not `_blank`) needs its
  `window.opener`, so it gets a window of its own even from an agent's tab. In H it is adopted as
  a tab of the thread, opened by whoever drove its opener, shown only if the opener was the shown
  tab. The agent's next result from the opener carries `popups_opened` (tab id and URL) and the
  log gets a `popup` line. A plain new-tab open still loads in the agent's own tab. In D the
  popup is the native popup window the person already got, now also for an agent's tab; it is
  not a thread tab.

### Sound (949)

Background tabs and agents' tabs are muted; the tab the person watches plays. Tabs report
`audible` and `muted`, and the strip shows a speaker on an audible tab that the person toggles
(`browser.tabs.mute`, person-only like the requests above; the choice holds for that tab).

- **D.** `audioMuted` (pure): the person's choice if they made one, else muted unless the tab is
  placed in the panel and no agent uses it. The page reports `ace.audio {audible, muted}` and
  takes `ace.audio.mute`.
- **H.** Chrome has no per-tab mute over CDP and the screencast carries no sound, so ace's Chrome
  runs with `--mute-audio`: nothing it renders plays on the daemon's machine. It offers no toggle.
- **U.** The extension mutes every agent tab it opens or adopts (`chrome.tabs.update {muted}`),
  lists `audible`/`muted`, republishes when they change and takes the new `tabs.mute` operation
  for shared and agent tabs. The person's shared tabs keep their own sound.

### Files, downloads and the browser's warnings (950)

- **File picker (H).** ace's Chrome intercepts every file chooser
  (`Page.setInterceptFileChooserDialog`) and lists it as the tab's `file_chooser` (`multiple`);
  agents get the existing log hint to use `upload`. The web panel offers "Choose file…": the
  person's files go up as thread attachments (the composer's resumable upload, now shared in
  `lib/context-requests.ts`), then `browser.files.choose` names them. The daemon's socket reads
  each attachment for that device (`downloadAttachment`, 32 MiB each), writes it under its own
  name in the thread browser's directory and sets it with `DOM.setFileInputFiles`; the client
  releases the attachments afterwards. No files cancels. D keeps the native picker.
- **Use my Chrome downloads (U).** The extension (now with the `downloads` permission) reports
  only downloads a controlled tab started: it pairs the tab's `Page.downloadWillBegin` URL with
  the browser's download item and sends `download` events (name, state, size, final path) as it
  progresses. The thread lists them in Downloads and the agent's `downloads`; files stay where
  the browser saved them, so they are not artifacts.
- **The browser's own warnings (D, H, U).** Every engine enables `Log`; `Log.entryAdded` becomes a
  console log line typed by its level (`warning`, `error`, …) and prefixed with its source
  (`[security] …`), so mixed-content, CSP and certificate warnings reach the agent's logs
  alongside `console.warn`.

## Verification

Real-Chrome process tests (`page-edges.process.test.ts`) with local fixtures: a basic-auth
endpoint answered by the person (and cancelled), a self-signed HTTPS server proceeded past by
the person and refused to the agent, and an OAuth-style popup posting back to its opener through
`window.opener.postMessage`. Web tests drive the sign-in card, the certificate warning and the tab speaker against the fake
daemon; desktop unit tests cover `CertificateExceptions` and `audioMuted`. ace's Chrome is checked
to run muted; a Use my Chrome process test (real extension) opens an agent tab muted and unmutes
it from ace, and lists a download where the browser saved it. A file input in ace's Chrome takes
the person's file (read back by the page), the web panel uploads a picked file and names it, and
the conformance scenario `browser-warnings` (a CSP-blocked image) runs in every engine.

Not covered by tests: Electron's `certificate-error` and audio paths and the native popup for an
agent's tab (no Electron in the test run).
