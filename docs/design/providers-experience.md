# Providers, sign-in and first run

How a person sees and fixes the coding agents ace drives: Settings → Providers, a provider's
own page, the sign-in dialog and first-run setup. Replaces the PR #190 surfaces. Behaviour and
data contracts are unchanged (`docs/daemon/provider-login.md`); this is the view on top.

## Principles

1. **Intuitive first.** One glance answers "can I start a thread, and what needs me?". Every
   provider says one short human status and offers at most one action.
2. **Clean.** Technical facts (versions, paths, how sign-in is reported) live on the provider's
   own page under About, never in a list.
3. **Premium and calm.** Rounded raised surfaces on the page, muted section labels, icon-led
   rows, generous spacing and restrained colour: colour only says state (green ready, amber
   needs you, red problem).
4. **Alive.** Rows answer hover and focus, pages and dialog steps arrive with a short rise,
   waiting breathes, success draws a check. All motion uses the motion tokens, so
   `prefers-reduced-motion` makes it instant.

## Information architecture

```
Settings → Providers                      /settings/providers
  On this computer   provider rows → their page
  Not installed      rows → their page (how to install)
  ACP agents         agents added by command, Add an agent
Provider page                             /settings/providers/$provider
  Header             mark, name, status line
  Callout            only when it needs the person: Sign in / Reconnect (or Install)
  Services           OpenCode and Pi: one card per service, + Connect a service
  Accounts           every account: who, how it signs in, Default, status, plan windows;
                     per-account menu; + Add account inline
  Usage              14 days of tokens, the API-price estimate, each account's share
  Models             default model, count, all models on demand
  About              version (+ Update available), runtime, location, terminal recipe
  Sign out           a quiet danger row (Remove for an ACP agent added by command)
Sign-in dialog                            opened from anywhere
First-run setup                           /setup
```

The provider page is a route rather than a sheet: it deep-links, the back button works, there
is room for models, and it is the same page on a phone. It loads lazily, like the overview.

## Status words

`readinessView` (`@ace/ui-core`) decides these, so Settings, setup and the dialog agree.

| State         | Tone    | Line in lists                                               | Action    |
| ------------- | ------- | ----------------------------------------------------------- | --------- |
| ready         | ready   | Signed in as ada@example.com · 4 services connected · Ready | none      |
| signed out    | action  | Sign in needed                                              | Sign in   |
| attention     | problem | Needs attention: Cursor sign-in has expired                 | Reconnect |
| unconfirmed   | idle    | Installed (on its page: sign-in not reported)               | none      |
| checking      | idle    | Checking…                                                   | none      |
| not installed | idle    | Not installed                                               | none      |
| turned off    | idle    | Turned off                                                  | none      |

Quieter actions (Sign in again, Sign out, connect another service) live on the provider page,
never in "…" menus on the list.

## Sign-in dialog

One centred column: the provider's mark in a tile, "Sign in to Codex", one line of reassurance
("Uses Codex's own sign-in. ace never sees your password."), then the step.

| Step (`state`)             | Shows                                                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| requesting, starting       | mark with a breathing ring, "Starting sign-in…", Cancel                                                                                           |
| awaiting_code_entry        | the code in large segmented monospace, Copy code (turns into Copied ✓), primary "Copy code and open sign-in page", waiting line, Cancel           |
| awaiting_browser           | "Finish in your browser"; the desktop app opens the page itself once, the button opens it again; waiting line, Cancel                             |
| awaiting_input + choices   | "Which service do you want to connect?" and a list: mark, name, one-line description, chevron                                                     |
| awaiting_input, no choices | "One more step", the CLI's fixed prompt quietly, Continue                                                                                         |
| verifying                  | "Checking your sign-in…"                                                                                                                          |
| succeeded                  | a check that draws itself, "You're signed in", "Signed in as …"; closes after 1.6 s                                                               |
| failed                     | a soft warning mark, the safe message, Try again (primary) and Close                                                                              |
| cancelled                  | "Sign-in cancelled", Try again and Close                                                                                                          |
| failed + manual            | "Finish in a terminal": numbered steps (open the terminal, the CLI's instruction, ace notices), the embedded terminal in place of step 1's button |

The code flow opens the browser only from the person's click ("Copy code and open sign-in
page"), since they need to read the code first. A browser-only flow opens the page as soon as
the link arrives in the desktop app, where the Sign in click already asked for it; in a browser
tab that would be a blocked pop-up, so the button does it.

## First-run setup

"Welcome to ace" and one sentence. A thin progress bar with "2 of 5 ready". Detected agents as
cards in a two-column grid: mark tile, name, status line, one action or a green check. The
suggested next card gets a ring. Agents that aren't installed sit in a quieter list below with
"How to install" revealing the command. A footer holds "Skip for now" (quiet, left) and
"Start a thread" (primary, right; shown once something is ready).

## Components

- `ProviderTile`: a provider or service mark in a rounded tile (sizes 32, 40, 48).
- `ReadinessLine`: a status dot in its tone plus the line.
- Overview row: the whole row is one link to the provider page; its action button sits above
  the link, so there is no nested interactive content.
- Dialog steps are keyed by state so each one arrives with `fx-rise-in`.
- New CSS is limited to two keyframes (ring breathe, check draw); everything else is utilities
  and existing tokens.

## Accounts, API keys, install and usage

The overview stays one status and one action per provider. Everything below lives on the
provider's page. "Live" means it works against today's daemon; "waiting" names the backend
branch it needs and the contract the UI expects, so the section slots in without a redesign.

### Accounts (live, on `accounts.*`)

One list per provider, the CLI's own sign-in first:

- Each row: an initial, the name (the CLI's own sign-in is named by `accountLabel`), how it
  signs in ("Claude Code's own sign-in" or "Added in ace"), a Default pill when the provider has
  more than one account, a status dot, and its plan windows (5-hour, weekly: used %, resets in).
- A "…" menu per row (the page's only menus): Sign in again, Make default, Rename (inline
  field, Enter saves, Escape cancels), Remove (confirm; the sign-in folder stays). The CLI's
  own sign-in offers only Sign in again.
- The last row is **Add account**: it expands in place to a name field and "Add and sign in",
  which calls `accounts.add` and immediately opens the sign-in dialog for the new instance
  (`provider.login.start { instance }`). No separate page.

Today this uses `accounts.add/rename/setDefault/remove` (scope `accounts`) and
`provider.login.start { instance }`. **Backend available in `feat/accounts-inline-api-keys`** replaces them
with `provider.accounts.list/add/rename/setDefault/remove/reauth`. The UI needs per account:
`id`, `label`, `isDefault`, `implicit`, `status`, and **`authMethod: "browser" | "api_key" | "unknown"`**,
which the row shows as "Browser sign-in" or "API key" (never any key material). All calls go
through one hook (`features/settings/account-actions.ts`), so the swap is local.

### API key sign-in (backend available in `feat/accounts-inline-api-keys`)

Where the provider supports it, the sign-in dialog's first step becomes a choice of two rows,
in the same list style as the service choices: "Sign in with browser" and "Use an API key".
The key step is one secure field (`type="password"`, no autocomplete, paste allowed), a primary
"Connect", and one line: "ace hands the key to {name}'s own login and doesn't keep it." After
it, the account reads "API key". The UI needs: a readiness or account capability saying API
keys are supported for this provider (or upstream), and the dedicated `provider.login.apiKey`
message that carries the key straight to the CLI. The daemon supplies `apiKey.supported` and
`awaiting_api_key`; the screen can expose the reserved choice when that capability is true.

### Install, update, remove (install command live; one-click waiting: `feat/provider-cli-install`)

- Not installed: the page's callout and Install section. Today: numbered steps with the
  install command to copy, then Check again. With the backend: a primary **Install** in the
  callout, then progress inline under it (a step label, a thin bar, and a calm collapsible log
  in monospace, last lines only), ending in the normal ready or sign-in state.
- Installed: About shows the version and, when readiness says `updateAvailable` (already in the
  schema, not yet reported), an "Update available" note; with the backend it becomes an
  **Update** button with the same inline progress.
- Uninstall sits in the About section's end as a quiet danger row, confirm first.
- The UI expects `provider.install.plan { provider, action: install | update | uninstall }`
  returning the steps and command it will run (shown before confirming), and
  `provider.install.run` streaming progress `{ state, step, log lines, exit }` like login
  progress, then a `providers.changed` push.

### Usage and cost (live in part)

- Live: each account's plan windows (from `accounts.list` quota), and the provider's last 14
  days from `usage.series` / `usage.summary` filtered to the provider: tokens per day, the
  total, what it would cost at API prices labelled "Estimate", and each account's share.
- Backend contract: `usage.series` supports provider/account filters and day/week/month
  buckets. `usage.summary` grouped by account supplies API `estimatedUsd`; subscription
  consumption stays in plan windows and tokens. Provider/account-filtered replies include
  matching current `accounts` records, price version/date/sources, and an explicit estimate
  label. The account shares gain a cost column for API consumption, with unpriced coverage
  shown when a model is unknown. `usage.limits_changed` pushes update the matching account;
  refresh on reconnect. See [usage contract](../../packages/usage/README.md#provider-detail-contract).
  No per-chat usage meter is added. Go/Zen quotas remain unavailable until a CLI reports them.

The backend contract is now documented in [provider account operations and API keys](../daemon/provider-login.md#provider-account-operations-and-api-keys). The UI integration can switch the account hook locally. Treat `authMethod: unknown` as unreported, show the key option only when `apiKey.supported` is true, and submit only through the dedicated key message after `awaiting_api_key`. Paired clients use the encrypted `provider_auth` channel.
