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
