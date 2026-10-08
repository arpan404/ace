# Native provider sign-in and first run

The app runs the installed CLI's own login process. The CLI performs OAuth and writes
its credentials. ace publishes reviewed verification links, device codes and fixed
prompts, with no raw login output, credential field, transcript, scrollback or replay.
Default CLI sign-in inherits the daemon's launch environment and normal home. A
registered managed `instance` selects that profile explicitly. Host-registered
non-managed profiles cannot be changed through this API.

Cursor is one SDK-backed provider under ADR 0043. Sign-in uses
`createCursorLoginDriver(instance, accountDriver).start(signal)` from
`@ace/adapter-cursor`, through the accounts-owned SDK driver and its registered
credential store. There is no Cursor CLI discovery, implicit CLI account or native
CLI login fallback. Legacy `cursor-cli-default` requests map to the SDK default.

## UI contract

Use `Client.request(...)` for correlated calls and `Client.onMessage(...)` for pushes.
The worker client carries these service messages too. All login operations require
`operate`, including polling challenges. The authenticated device owns a session;
another device cannot poll, input or cancel it. Login challenges stay in daemon memory.
They never enter the durable event log or client outbox. Existing account-management
operations keep their `accounts` scope.

```ts
const started = await client.request({ type: "provider.login.start", provider: "codex" });
// started.result = { ok: true, progress: { session, provider, action, state, ... } }
// or { ok: false, error: "forbidden" | "unavailable" | "busy" | "not_found" | "invalid_input" }

await client.request({ type: "provider.login.input", session, input: { confirm: true } });
await client.request({ type: "provider.login.input", session, input: { value: "enter" } });
await client.request({
  type: "provider.login.input",
  session,
  input: { choice: "github-copilot" },
});
await client.request({ type: "provider.login.poll", session });
await client.request({ type: "provider.login.cancel", session });
await client.request({ type: "provider.logout", provider: "codex" });
```

`provider.login.start` and `provider.logout` accept optional `instance`. The default
ignores ace's isolated-account default selection for native CLIs and updates the
normal CLI profile. The Cursor SDK uses its selected SDK instance.

A `provider.login.progress` push contains `progress`, with:

| Field                                        | Meaning                                                                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `session`, `provider`, `instance?`, `action` | Session identity and login/logout target                                                                                 |
| `state`                                      | `starting`, `awaiting_browser`, `awaiting_code_entry`, `awaiting_input`, `verifying`, `succeeded`, `failed`, `cancelled` |
| `sequence`                                   | Increasing snapshot sequence; discard older snapshots for this session                                                   |
| `expiresAt`                                  | Daemon timestamp for the bounded challenge lifetime                                                                      |
| `url?`, `userCode?`                          | Ephemeral browser challenge; display the code and an Open browser button                                                 |
| `prompt?`, `choices?`                        | Fixed Enter prompt or `{ id, label }` choices                                                                            |
| `message?`, `hint?`                          | Safe categories and instructions, never provider diagnostic text                                                         |
| `manual?`                                    | `{ action: "open_terminal", command, instruction, instance?, terminalId? }`                                              |

Open `url` on the **client's device**, after the person requests it. Do not call the
daemon browser service for sign-in. Codex prefers `--device-auth` when advertised.
Native CLI browser suppression uses `--no-browser` when advertised and `BROWSER=echo`;
CLI releases that bypass those conventions still control their own browser behavior.
The SDK host already sets `openBrowser: false`.

Do not render a free-text login input. Only send an advertised choice or Enter while
`awaiting_input`. Browser device codes belong in the provider's browser page. OAuth
callback/paste codes, API keys, passwords and arbitrary domains have no input variant.
Unsupported prompts use the native terminal fallback. Changes to output patterns need
new synthetic fixtures and review before they can be relayed.

Attach the push listener before starting. A progress push can race the start reply;
key both by `session`. `poll` returns the current snapshot and attaches the connection
for future pushes. A disconnected client can reconnect as the same paired device and
poll its session. A daemon restart loses all sessions; refresh readiness and start again.
Terminal states clear the browser challenge. Timeout results have a one-minute grace
period for their terminal action. At most 32 sessions are retained for ten
minutes, with one active job per provider/profile. Cancellation and expiry await process
group cleanup. Failed cleanup keeps the profile busy and exposes a `verifying` cleanup
message until a cancellation retry can drain it. The SDK host bounds its browser operation to five minutes.

## Native terminal fallback

A failed progress snapshot with `manual` supports this action:

```ts
const opened = await client.request({ type: "provider.login.terminal", session });
const terminalId = opened.result.ok && opened.result.progress.manual?.terminalId;
// Subscribe using terminal.request, omit threadId, and show the native CLI terminal.
await client.request({
  type: "terminal.request",
  operation: {
    op: "subscribe",
    terminalId,
    subscriptionId: "provider-auth",
    fromOffset: 0,
  },
});
```

This uses the existing live auth PTY, with explicit executable arguments, no shell
interpolation, no history and no output capture. The CLI owns terminal input. The
terminal belongs to that socket, requires `operate`, and stops on disconnect or after
ten minutes. After completion, refresh readiness. Other sockets and late subscribers
cannot replay its output. `accounts.login/logout` terminals continue to require `accounts`.
Generic ACP and Antigravity return instructions only; no reviewed auth terminal is
available through this native-provider service.

## Provider support

| Provider    | Supervised path                                                                               | Fallback                                                                                                                   |
| ----------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Codex       | `codex login`, device auth when advertised; `codex logout`                                    | Unsupported help/version or input prompt                                                                                   |
| Claude Code | `claude auth login`, `--claudeai` when advertised; `claude auth logout`                       | Paste authorization code, key input or unsupported setup                                                                   |
| OpenCode    | Upstream choices; Copilot via advertised `--provider` and `--method`; GitHub.com confirmation | Go, Zen, OpenAI, Anthropic, other upstreams, Enterprise domain and logout use `opencode auth login/logout` in the terminal |
| Pi          | Upstream choices and native `/login` or `/logout` instructions                                | Pi's interactive editor has no reviewed standalone safe login command                                                      |
| Cursor      | Accounts-owned SDK browser stream and SDK logout                                              | SDK availability/auth errors stay SDK errors; no CLI fallback                                                              |

Patterns are gated to the reviewed CLI version families: Codex 0/1, Claude 2, OpenCode
1/2. Cursor uses the pinned SDK runtime. Version/help probes are metadata-only. We
have not tested real OAuth sessions or subscription entitlement. Unknown CLI output
is private; parsing has an 8 KiB pending-line bound and a 256 KiB total-output bound.
A CLI with a changed transcript may need the terminal fallback even in those families.

## Readiness and onboarding

```ts
await client.request({ type: "providers.request", operation: "readiness" });
await client.request({ type: "onboarding.query" });
await client.request({ type: "onboarding.dismiss", dismissed: true });
```

`readiness` and `providers.changed` return one effective row per provider for Settings. Existing `list` and
`refresh` operations preserve their runtime-level diagnostic rows. `onboarding.query`
returns `{ ok: true, dismissed, providers, ready, next: { action, provider? } }`.
`next.action` is `start_thread`, `sign_in`, `install`, `refresh` or `configure`.
Read-only clients may query. Dismissal requires `operate` and persists per authenticated
device in `onboarding.sqlite`; it does not dismiss setup for another device.

Readiness is `not_installed`, `installed_signed_out`, `signed_in`, `needs_attention`
or `not_configured`. Rows retain CLI version, a non-secret account label when exposed,
installation instructions and an install command when appropriate. Probe errors and
known exhausted accounts need attention. Unreported CLI auth remains usable. Connected
upstreams make OpenCode and Pi usable while `auth` continues to report whether the CLI
confirmed sign-in; this does not assert subscription entitlement. Cursor readiness
comes only from the SDK. Its installed `state: not_configured` row maps to
`installed_signed_out` with the "Sign in to Cursor" action. `updateAvailable` is optional and omitted: no package-registry network
request was added solely to compare versions.

A completed login bumps the account login revision, replaces that model catalog's
generation, refreshes models and provider status, then pushes `models.changed` and
`providers.changed`. `succeeded` follows those operations and process cleanup. Neither
status probes nor model refreshes send an inference prompt.

## Fake daemon

The fake uses the same request and push schemas. Defaults exercise Codex device codes,
Claude/Cursor browser links, and OpenCode/Pi provider choices followed by Enter and
a device code. The upstream Go/Zen/Anthropic choices exercise terminal fallback.
Fixtures can set `daemon.services.providerLogin.scenarios[provider]` to `device_code`,
`browser`, `choice` or `failure`. Complete a browser/device flow with
`daemon.services.providerLogin.complete(session, success)`; completion is explicit so
UI tests do not depend on wall time. Cancel, failure, expiry, scope checks and device
ownership are observable through the API. The fake's in-memory dismissal survives a
client reconnect, and resets when its daemon is replaced.

## Sources and fixtures

Implementation is fresh code based on ace's account/process owners and primary command
references: [Codex CLI](https://developers.openai.com/codex/cli/reference),
[Claude CLI](https://code.claude.com/docs/en/cli-reference),
[OpenCode CLI](https://opencode.ai/docs/cli/),
[OpenCode providers](https://opencode.ai/v2/docs/providers),
[Pi quickstart](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/quickstart.md)
and [Cursor SDK auth](https://cursor.com/docs/sdk/typescript#cursorauth).
The transcript JSON under `apps/daemon/src/__fixtures__/provider-login/` is synthetic,
version-tagged fake output. It contains no recorded login or real credential.

## Provider account operations and API keys

The provider-page backend uses the additive `provider.accounts.*` family. Old
`accounts.*` requests remain supported; daemon removal delegates to the same logout-first path and preserves the old reply shape. Replies have type
`provider.accounts.result`, with `{ ok: true, accounts, apiKey, progress? }` or
`{ ok: false, error, instanceId? }`. A failed start never publishes a newly staged account;
its ephemeral `instanceId` identifies the attempted login, rather than a reusable account.

| Request                        | Fields beyond `requestId`                                                         | Scope   |
| ------------------------------ | --------------------------------------------------------------------------------- | ------- |
| `provider.accounts.list`       | `provider`                                                                        | read    |
| `provider.accounts.add`        | `provider`, `label?`, `method: login \| api_key`, `upstream?`                     | operate |
| `provider.accounts.rename`     | `provider`, `instanceId`, `label`                                                 | operate |
| `provider.accounts.setDefault` | `provider`, `instanceId`                                                          | operate |
| `provider.accounts.remove`     | `provider`, `instanceId`, `confirm: true`, `deleteHome?: boolean` (default false) | operate |
| `provider.accounts.reauth`     | `provider`, `instanceId`, `method?: login \| api_key`, `upstream?`                | operate |

Add stages a newly isolated account and starts its sign-in immediately. Use
`progress.session` with the existing polling, cancellation and progress messages.
New accounts are staged in the registry and excluded from lists, default selection and
thread scheduling until authentication succeeds. Failed or cancelled login removes its
managed home before publishing terminal progress; existing accounts survive reauthentication
cancellation. Staging is persisted so restart recovery discards abandoned login homes.
A manual fallback keeps its staged home hidden until the CLI terminal verifies sign-in,
or cancellation, expiry or shutdown removes it. Account rows include
`id`, `label`, `implicit`, `isDefault`, `status` using the existing availability
values, `authMethod: browser | api_key | unknown`, `signedInAs?`, `quota`,
`usageSummary` and `apiKey`. `usageSummary` reuses sanitized quota counters; it is
not an authoritative billing estimate. `apiKey` is `{ supported, reason?, upstreams? }`
and also appears on readiness rows. Never show a key or a key prefix.

For key sign-in, add or reauthenticate with `method: api_key`. Direct
`provider.login.start` also accepts that method. OpenCode requires an upstream
from `openai`, `anthropic`, `openrouter`, `opencode`. Wait for
`awaiting_api_key`, then submit the dedicated message:

```ts
{
  type: "provider.login.apiKey",
  requestId: "submit-key",
  session: "session-from-start",
  apiKey: "pasted-key",
}
```

This field is secret and write-only in the schema, bounded to 8192 characters,
and excludes whitespace and terminal control characters. It is not a
`provider.login.input` variant. The client's service calls never persist or
replay it and drop their key references after sending. The daemon checks the
session-owning device, operate scope and state before creating an owned buffer.
Only the child stdin receives the bytes. Output is bounded, drained and discarded;
no raw failure text crosses the wire. Success follows child cleanup, account
revision invalidation and readiness/model refresh.

Host-token loopback clients may submit directly. Paired clients, including those
on loopback, must use the encrypted relay with `hello.channel: provider_auth`.
`authenticatedChannel(options, "provider_auth")` exposes this dedicated route.
Ordinary paired/TLS WebSockets reject key submission. The relay rechecks operate
scope on requests and pushes. A device cannot submit to another device's session.

Remove waits for Codex/Claude/Cursor's native logout and refuses on failure.
It preserves the instance home unless `deleteHome: true`. Deletion validates the
private direct child of the daemon data directory and never removes implicit CLI
homes. OpenCode/Pi have no reviewed unattended logout here and permit unregistering
only with the home preserved.

### Verified credential paths

| Runtime                        | Path                                                                                        | Evidence and limitation                                                                                                                                                                                                                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex 0.159.1                  | `codex login --with-api-key`, stdin                                                         | Installed help explicitly names stdin; version/help gates admit reviewed 0/1 families.                                                                                                                                                                                                                      |
| Claude 2.1.286                 | unsupported                                                                                 | `auth login --help` offers browser subscription/Console login. An env key or `apiKeyHelper` would require ace storage or future env injection.                                                                                                                                                              |
| OpenCode v1                    | `auth login --provider <upstream> --method "Manually enter API Key"`, password prompt stdin | [CLI reference](https://opencode.ai/docs/cli/#login) documents flags; [provider guide](https://opencode.ai/docs/providers/#using-api-keys) documents key entry. Synthetic prompt fixtures cover the hand-off.                                                                                               |
| OpenCode 2.0.22 installed here | unsupported                                                                                 | Installed help uses positional targets, method IDs and `--answer`; no reviewed stdin credential contract. Do not put a key in `--answer`.                                                                                                                                                                   |
| Pi 0.85.1                      | unsupported                                                                                 | Installed `auth --help` exposes read/check commands, not stdin storage. `--api-key` is argv; env/user-managed auth files do not meet this policy.                                                                                                                                                           |
| Cursor SDK 1.0.35              | isolated stdin worker → `FileCredentialStore.save`                                          | [SDK auth docs](https://cursor.com/docs/sdk/typescript#cursorauth) and the pinned public credential-store declarations; tests use the SDK's real file store without provider calls. [Cursor network configuration](https://cursor.com/docs/enterprise/network-configuration) identifies the backend domain. |

Installed metadata probes ran on 2026-10-07. No real keys, OAuth exchanges,
provider prompts or recorder sessions ran. OpenCode v1 stdin compatibility is
covered by fakes; the installed v2 runtime is deliberately refused. Real key
validity, quota and subscription entitlement remain the provider's responsibility.

The fake daemon supplies three accounts per native provider, both auth methods,
inline add/rename/default/remove/reauth and explicit login completion. API-key
submission completes immediately; setting
`daemon.services.providerLogin.scenarios[provider] = "failure"` rejects it.
Claude/Pi key additions return `unsupported`; read-only mutations return `forbidden`.
