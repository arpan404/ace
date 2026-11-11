# 0122: Outside MCP clients sign in to a machine

Status: accepted. Date: 2026-11-11. Owner decision of 2026-11-11: ace's relay carries hosted
assistants, approval happens in the ace app, and grants cover threads, the browser and computer
use. For issue #972. Builds on
[ADR 0110](0110-cloudflare-relay.md), [ADR 0111](0111-account-machine-access.md) and
[ADR 0114](0114-fastest-path.md). Amends [ADR 0002](0002-local-cli-providers.md) and
ADR 0110 with a narrow change to what ace's relay can read (see **Reach**). Webhook automations
(#975) would use the same public reach.

## Context

### What ace has today

`ace mcp enroll` (`apps/daemon/src/external-mcp/`) opens a second MCP endpoint for clients
outside ace: six tools (list, read and status of threads, start, send, task control), a `read` or
`operate` scope, an optional single project and a time limit. It works, but:

- **Restarts.** Enrollments live in memory. A daemon restart drops every client.
- **Reach.** The endpoint listens on `127.0.0.1`. A hosted assistant (claude.ai, ChatGPT) or a
  bot on another machine can't reach it, and ace's relay carries only Noise streams between ace's
  own apps and daemons.
- **Sign-in.** The person copies a bearer token into an environment variable. There is no OAuth:
  no `WWW-Authenticate` challenge and no protected-resource metadata, so clients that sign in by
  themselves can't.
- **Grants.** `operate` bundles start, message, steer and cancel. Nothing lets a client message
  threads without starting new ones, or stop work without starting it.
- **Attribution.** Commands are recorded under the generic `ace-agent` device, and `startedBy` is
  a fake thread id `external:<id>`. A thread doesn't say which client started it, and the record
  is deleted on revoke, so the name is lost.
- **Visibility.** Only the CLI lists and revokes enrollments. The apps don't show them.
- **Discovery.** No tool lists projects or models, so a client has to know ids already.

Retries are already safe: a start or send is keyed by `external:<enrollment>:<idempotencyKey>` and
recorded as a command receipt in SQLite, so a retry after a disconnect or restart runs once.

### What changed since #972 was filed (2026-10-18)

- **MCP 2026-07-28.** No `initialize` and no `Mcp-Session-Id`: each request carries its own
  version and capabilities, and any request can go to any instance. ace's server already speaks
  it. A stateless request is easy to forward one at a time through a relay.
- **Client registration.** The spec now prefers Client ID Metadata Documents (CIMD: the client's
  `client_id` is an HTTPS URL serving its metadata) and deprecates Dynamic Client Registration
  (DCR), keeping it for compatibility. Authorization servers should return `iss` (RFC 9207). Claude
  and ChatGPT both use CIMD when the server advertises it and otherwise fall back to DCR. Both need
  PKCE with S256.
- **ace's relay is live** on Cloudflare with accounts (ADR 0110, 0111), and a client reaches each
  machine over its fastest path (ADR 0114).
- **Spade** (draft `drafts/spade-daemon-access.md`) has the same problem: a party that is not the person's
  own device acting on a machine with narrower access than admin. The two should share one list of
  permissions and one place in the daemon that enforces them.

## Proposal

Reach and authorization stay separate. How a request arrives never decides what it may do; the
daemon decides that, the same way on every path.

### Authorization: the daemon is the authorization server

- The daemon serves OAuth 2.1 for its outside endpoint: protected-resource metadata (RFC 9728),
  authorization-server metadata (RFC 8414), `/authorize`, `/token`, and `iss` in every
  authorization response. Authorization code with PKCE S256 only. The `resource` parameter
  (RFC 8707) is required and must equal the URL the client is using; a token works only at that
  URL.
- Client registration: CIMD first. The daemon fetches the client's metadata URL itself (HTTPS
  only, public addresses only, size and time capped, cached) and checks the redirect URI against
  it. DCR stays, for clients without CIMD: registrations are stored, and one never used for an
  approved grant expires after a day. Clients registered through DCR are shown as unverified.
- Redirect URIs may be HTTPS, loopback HTTP, or a native app's private-use scheme (RFC 8252
  §7.1, such as Cursor's `cursor://…`), because desktop clients register those and refusing them
  locks those apps out; a private-use or loopback redirect reaches whatever app on the signing-in
  device claims it, so ace tells the approver the code goes to an app on that device.
- `ace mcp enroll` stays for terminal agents that take a pasted token, which the spec allows. It
  creates the same kind of grant, without OAuth.

### Consent happens in ace, not on the web page

The `/authorize` page is reachable by anyone who has the URL, and on the relay path ace's relay
can read it. So the page decides nothing. It shows the client's name and domain, what it asks for,
and a short match code, and says "Approve in ace on <machine>". The daemon sends the request to its
admin devices (the desktop app, and iOS by push, ADR 0106). The person checks the match code and
picks:

- **Access.** Read is always included and is the default. Each of these is its own tick:
  start threads, message and steer threads, stop threads, the browser, computer use.
- **Projects.** All, or chosen ones.
- **How long.** A day, 30 days (default), or until revoked.

Approving returns the code to the page, which redirects to the client. A machine code (ADR 0111)
protects this the same way it protects admin, because only an admin device can approve.

### Grants and tokens

- One SQLite table holds every outside grant, OAuth or CLI: client id, name, verified domain or
  "unverified", access, projects, created, expires, last used, revoked, and which device approved
  it. It migrates forward from the current schema. Revoking sets `revokedAt` and keeps the row, so
  history can still name the client.
- Tokens are random and stored hashed. Access tokens last an hour. Refresh tokens rotate on each
  use; reuse of an old one revokes the grant. No token outlives its grant.
- Every request reads the grant afresh, so revoking or expiring takes effect on the next request,
  including after a restart.
- Tokens and authorization responses never appear in tool results, transcripts or logs.

### Permissions

| Scope             | Allows                                                      |
| ----------------- | ----------------------------------------------------------- |
| `threads:read`    | Projects, models, threads, transcripts and whole-tree state |
| `threads:start`   | Start a thread in an allowed project                        |
| `threads:message` | Queue or steer a message on an allowed thread               |
| `threads:stop`    | Stop a thread's work                                        |
| `browser`         | The agent browser tools, in tabs the grant owns             |
| `computer`        | The screen tools                                            |

- A client only sees tools its grant allows. Calling a tool it lacks returns HTTP 403 with
  `insufficient_scope` and the needed scope, so a client can ask the person for more. Asking
  again is a new sign-in, approved in ace like the first, and makes a new grant: a metadata
  document's client_id is shared by everyone using that app, so it can't say whose grant to
  widen. An existing grant widens only when the person edits it in ace.
- No grant can answer approvals or questions. Provider approvals stay provider-native, and the
  person answers them in ace.
- Browser tabs a client opens belong to its grant (ADR 0104), are named after the client and close
  when the grant is revoked or loses `browser`. An outside client's browser can't open
  the person's own machine or network: loopback, link-local and private addresses (and names that
  resolve to them) are refused for it, whatever ace's own agents may open.
- Computer use keeps every rule it has for agents in ace threads: the "Apps agents can't use" list,
  locked use only when the person turned it on, and one run at a time. While a client is using the
  screen, ace shows one line, "Claude is using this Mac", with Stop. Stop takes `computer` off the grant, so a client calling in a
  loop can't carry on; the person adds it back in Settings. Revoking ends all of its work.
- Files and daemon settings are not offered. The scope names are the ones the Spade draft will use,
  so both are one list enforced in one daemon module.
- Discovery tools are added: projects and models (from the provider catalogue already in the
  daemon).

### Attribution

- A thread started by an outside client records `startedBy: { kind: "mcp_client", grantId,
name }`, and messages it sends carry a matching `MessageOrigin` kind. Commands are recorded under
  the grant, not `ace-agent`.
- The thread list and header say "Started by Claude (claude.ai)". The grant's row in Settings shows
  the threads it started and changed.

### Reach

Each path is off until the person turns it on, and each shows the URL to paste into the client.

1. **This computer.** `http://127.0.0.1:<port>/mcp`, as today.
2. **Tailscale.** The daemon's existing Tailscale TLS listener, with the ts.net certificate
   (ADR 0097), serves `/mcp`, for agents on the person's other machines.
3. **ace's relay.** `https://relay.acehq.dev/m/<hostId>/mcp`, for hosted assistants. Needs the
   machine signed in to an ace account, as relay registration already does.
4. **The person's own public URL** (Tailscale Funnel, a tunnel, a reverse proxy): the person
   enters its base URL and the daemon accepts it as a resource.

**How ace's relay carries it.** The Worker routes `/m/<hostId>/…` (the MCP endpoint and the OAuth
endpoints and metadata under it) to that host's Durable Object. The object asks the daemon over
its encrypted control session for a stream, the daemon opens a ticketed socket as it does for
`/join`, and the object forwards one request and its response, streaming included. Size limits,
per-IP and per-host rate limits, and no logging of paths beyond the host, bodies or headers.
Long-lived `subscriptions/listen` streams are capped per host, because an open stream keeps the
object awake and billed.

**What this changes in the relay's trust.** Hosted assistants speak only plain HTTPS MCP and need a
publicly trusted certificate, and a Worker can't pass TLS through to the daemon. So on this path
Cloudflare ends TLS and ace's relay sees the MCP requests and responses in plain text, tokens
included. It is trusted here like any TLS-ending proxy: it stores and logs none of it. The assistant
itself reads everything anyway. The protections: the path is off by default per machine; tokens are
short and only work at that URL; a relay can't approve a grant, because approval happens in ace's
end-to-end channel; and a person who doesn't want this uses Tailscale Funnel or their own URL,
where TLS ends on their machine. ace's own apps and daemons are unaffected: they still use Noise
end to end.

### The internal endpoint is untouched

Agents in ace threads keep their own MCP endpoint and credentials, with no setup step. The outside
endpoint stays a separate listener with its own tool registry, as now.

## Rejected

- **ace's account backend as the authorization server.** It works only with an account, puts every
  client's grant in ace's backend, and approval would be a web sign-in, weaker than approving in
  the app. A daemon on the person's own relay or Tailscale would need the backend anyway.
- **Outside clients as paired devices.** Device scopes open the whole wire protocol. Outside grants
  are per tool and per project.
- **Making the internal session endpoint public.**
- **Noise end to end for hosted assistants.** They can't speak it.

## Verification

- Local HTTP process tests against a real daemon: discovery and the 401 challenge, CIMD (served by
  a local HTTPS fixture) and DCR sign-in, approval through a connected admin client, each scope's
  allow and deny (including 403 `insufficient_scope`), browser tabs owned by a grant closing on
  revoke, Stop ending a client's screen work, read-only clients unable to change anything,
  project limits, expiry, revocation on the next request, refresh-token reuse revoking the grant,
  and grants, tokens and idempotent starts surviving a daemon restart.
- A Miniflare process test for the relay path: a request and a streamed response through the
  Worker and object to a daemon, rate limits, and nothing logged.
- A check that no token or authorization response appears in tool results, transcripts or logs.

## Open

- Whether hosted Spade uses this same OAuth path instead of its own grant kind.
