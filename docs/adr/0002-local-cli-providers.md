# 0002: Providers are reached only through the user's local CLIs

Date: 2026-10-02. Status: accepted.

## Context

Anthropic does not allow third parties to offer claude.ai login without approval. OpenAI says Codex app-server authentication is not permitted for commercial or hosted services. Antigravity's terms call third-party use of its Google sign-in a breach. Details: [research overview](../research/providers/README.md#auth-and-terms-of-service).

## Decision

- The ace daemon runs on the user's machine and drives the CLIs the user installed and logged into: `claude`, `codex`, `opencode`, Cursor's `agent`, and Antigravity's ACP server.
- Except for the official SDK login amendment below, ace never offers provider login. ace never stores or proxies provider credentials and has no hosted mode. Remote and mobile access means the user's own devices connecting to their own daemon.
- The daemon resolves each CLI from the user's PATH (or a user-set path), reads its version and auth status, and sends the user to the CLI's own login command when needed.

## Consequences

- We don't control CLI versions. Adapters must probe capabilities, generate schemas from the installed binary where possible, and decode unknown data leniently.
- Antigravity remains uncertain: its ACP server is a separate download, and Google-account sign-in from third-party software may still breach its terms. API-key auth is the default until that is clarified.

## Amendment: official SDK logins

Accepted 2026-10-02 by the repo owner. This section supersedes the CLI-only and
no-login clauses above for a provider's **official SDK local runtime**.
[ADR 0043](0043-cursor-sdk-local-runtime.md) selects this path for Cursor.

ace may host the SDK's own browser login flow when the SDK persists credentials
in its own credential store. Each provider instance has a separate store under
its private home. The SDK performs credential entry, minting, persistence and
authenticated provider requests. ace never stores, logs, displays or transmits
provider credentials through its own storage, clients, IPC or network code.
Key-bearing SDK return values remain inside the isolated SDK host and are
discarded. Sign-out stops the instance's hosts and deletes its SDK credential
store through the SDK. Provider-dashboard revocation is a separate user action.

User-supplied API keys may come only from the user's launch environment. ace provides no key
entry field or key-bearing RPC and persists no key in account records. The SDK
consumes the environment value directly. Environment authentication must remain
visible as a source even after stored-login sign-out.

The local runtime and accounts isolation must be verified for the pinned SDK
version. An official package name alone does not establish support. Other
providers' login restrictions remain binding; this amendment does not authorize
unofficial OAuth, a hosted ace service or a credential proxy.

For Cursor, the inspected implementation is `@cursor/sdk` 1.0.35,
`Cursor.auth.login`, `FileCredentialStore`, `resolveDefaultApiKey` and
`Cursor.auth.logout`. The [SDK audit](../research/providers/cursor-sdk.md#authentication-and-process-ownership)
cites the published code and [official authentication docs](https://cursor.com/docs/sdk/typescript#cursorauth).

## Amendment: supervised native CLI sign-in

Accepted by the owner's one-click CLI sign-in request. ace may supervise the installed
CLI's own login/logout process and relay only reviewed verification URLs, device codes
and non-secret fixed prompts over an ephemeral, operate-scoped session. The CLI owns
credential entry and persistence. Default native login uses the daemon's launch
environment and the CLI's normal profile. ace implements no OAuth protocol, token
exchange, credential store or API-key entry field. Output is bounded and never logged
or stored. Unsafe or unreviewed input flows return CLI terminal instructions. The
existing live auth terminal carries the native CLI interaction without history or replay.
The SDK amendment and ADR 0043 continue to govern Cursor SDK's separate local store.
See [the protocol and UI contract](../daemon/provider-login.md).

## Amendment: API keys handed to the CLI

Accepted 2026-10-07 by the repo owner. This supersedes the no-key-entry and
launch-environment-only restrictions above. The person pastes an API key in ace;
ace hands it straight to the CLI's own credential mechanism; the CLI stores it;
ace never saves it. An official SDK may own the credential file inside the
isolated instance home through its public credential-store API.

The key arrives over an authenticated operate-scope channel in a dedicated
message type, is held only in memory for the hand-off, written only to the child
process's stdin, never argv, never env of other processes, never logs, never
SQLite, never crash reports, never pushed to clients. Buffers are zeroed or
dropped after the hand-off. The protocol schema marks it secret and every logger
redaction path covers it. Failures report fixed messages only. Paired and remote
clients may submit a key only over the encrypted relay with operate scope.
After success, bump the login revision and refresh readiness and the model catalog.

`provider.login.apiKey` is the dedicated message. Local submission requires the
host token on the loopback listener. Paired clients use the encrypted
`provider_auth` relay channel; an ordinary paired WebSocket is refused even on
loopback. Session ownership, current scope and the awaiting-key state are checked
before a key is admitted. It never enters the durable command or event pipeline.
Transport and hand-off buffers are cleared, and string references are dropped.
JavaScript strings cannot be overwritten in place; no key-bearing diagnostic or
heap report is deliberately generated by this path.

Use only reviewed native mechanisms, gated against runtime version and help.
Codex uses `login --with-api-key`. OpenCode v1 uses its provider-selected API-key
prompt over stdin. The installed OpenCode v2.0.22 exposes `--answer` rather than a
reviewed stdin contract, so that version is unsupported. Claude and Pi are
unsupported until they expose a documented stdin credential-storage operation.
Do not implement a key helper, write their auth files, or inject a pasted key into
future launches. Cursor SDK 1.0.35 uses `FileCredentialStore.save` inside an
isolated credential worker. Only the SDK serializes or writes its credential file.

See [account and sign-in contract](../daemon/provider-login.md#provider-account-operations-and-api-keys)
for messages, capability reporting, fixtures and verification limits.

## Amendment: installed ACP agent sign-in

Accepted by the owner's 2026-10-08 request for Install and Sign in for every provider.
ace may supervise authentication advertised by the user's installed ACP agent,
including Antigravity's official ACP server. The agent owns OAuth, credential
entry, persistence and provider requests. ace sends only `initialize` and the
selected advertised `authenticate` method, or opens the agent's advertised
terminal command with its configured launch arguments and environment. Terminal
methods reconnect after exit; they do not also call `authenticate`.

This supersedes the default-to-API-key clause for Antigravity's agent-owned login.
It does not authorize an ace OAuth implementation, token exchange or credential
proxy. API-key-only ACP methods remain unsupported by this browser sign-in flow.
Only reviewed verification URLs and fixed progress cross the login session;
credential-shaped output is discarded. Live auth terminals have no history or
replay. Installation does not prove authentication. Confirmed ACP auth stores only
an account readiness fact, never credentials. Actual vendor sign-in and account
eligibility still require validation outside fake tests.

## Amendment: reading a stored token for usage only

Date: 2026-10-15. Approved by the owner. A narrow exception for usage reads, where the
provider's own CLI or SDK offers no usage read of its own:

- ace reads the CLI's existing stored token from that account's own CLI home (ace's private
  per-account home where it has one, else the CLI's standard location), in memory, at the
  moment of one usage read.
- It is sent only to that provider's official, read-only usage endpoint over HTTPS, on the
  same host the CLI itself uses. Redirects are refused, never followed.
- It is never stored, cached, logged, put in errors, events or telemetry, or sent to a client,
  another host or the relay. Results and failures are built from fixed words only.
- It is never refreshed or rotated, and ace never writes the CLI's credential files. An
  expired token (by its stored expiry) is never sent; it, or a 401 from the endpoint, reports
  "Sign in again in <CLI>" instead. No stored token at all reads nothing and reports nothing.
- A store every home shares (the macOS keychain) is read only for the account that is that
  login: the CLI's own `about` must name the account's known sign-in, or, when ace doesn't
  know it, the account must be its provider's only one. Never another account's limits.
- No account mutation of any kind.

Sources are declared as data in `@ace/accounts` (`usage-sources/builtin.ts`) and ship with
ace only: a remote registry entry cannot declare one. A CLI command or SDK call that reads
usage with its own credential is always preferred to a token source. Any provider or ACP agent
gets usage by adding an entry there, with no adapter code.

A declared meter is advisory unless its declaration says a full window refuses all work
(`holds`): it is shown on the Usage page but never holds queued messages or picks a migration
target (ADR 0053's definite-signal rule). The shipped sources are all advisory:

| Source                             | Endpoint                                                                                                                        | Confirmed against                                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Cursor                             | `api2.cursor.sh` `DashboardService/GetCurrentPeriodUsage` with the keychain token; plan from `cursor-agent about --format json` | cursor-agent 2026.10.01 bundle (`src/usage-data.ts`), a read-only call with a signed-in CLI |
| Gemini CLI (ACP `official:gemini`) | `cloudcode-pa.googleapis.com` `v1internal:loadCodeAssist` then `v1internal:retrieveUserQuota` with `~/.gemini/oauth_creds.json` | Gemini CLI 0.43 bundle (`CodeAssistServer`, `refreshUserQuota`)                             |
| OpenCode                           | `opencode.ai/zen/go/v1/usage` with the `opencode-go` key from `opencode.db` or `auth.json`                                      | a read-only call with a signed-in OpenCode 2.0.29                                           |

Antigravity is not shipped: `agy -p /usage --output-format json` could not be confirmed
against an installed `agy`, nor where its login is kept. Its entry is one declaration once the
command's answer has been checked.
