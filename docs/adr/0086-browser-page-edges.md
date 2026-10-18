# 0086: Page edge cases in every browser engine

Date: 2026-10-17. Status: accepted. Amends [ADR 0067](0067-browser-parity.md),
[ADR 0083](0083-browser-v2-daemon-chrome.md), [ADR 0084](0084-use-my-chrome.md) and
[ADR 0085](0085-desktop-native-view-lifecycle.md).

## Context

The 2026-10-17 browser audit found pages that real browsers handle and ace's engines did not:
HTTP sign-ins, certificate warnings and OAuth popups (issue 948). Engines are named as in the
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

## Verification

Real-Chrome process tests (`page-edges.process.test.ts`) with local fixtures: a basic-auth
endpoint answered by the person (and cancelled), a self-signed HTTPS server proceeded past by
the person and refused to the agent, and an OAuth-style popup posting back to its opener through
`window.opener.postMessage`. Web tests drive the sign-in card and the certificate warning against
the fake daemon; a desktop unit test covers `CertificateExceptions`.

Not covered by tests: Electron's `certificate-error` path and the native popup for an agent's
tab (no Electron in the test run).
