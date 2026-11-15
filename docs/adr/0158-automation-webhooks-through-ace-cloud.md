# 0158: Signed webhooks start automations, reached through ace cloud

Status: proposed. Date: 2026-11-15. Decided by: the owner (2026-11-15: automation webhooks use
ace cloud's relayed path, as outside MCP does), the rest proposed in the PR for issue #975.
Builds on [ADR 0122](0122-outside-mcp-clients.md) (**Reach**, path 3) and
[ADR 0110](0110-cloudflare-relay.md).

## Context

An automation starts by hand, on a schedule, on a polled GitHub event or on a file change. It
can't start when an outside service pushes an event to ace: a deploy pipeline, a hosted CI
system, a bot. A webhook needs a request from outside this machine to reach the daemon.

ADR 0122 settled how outside callers reach a machine: ace cloud (`cloud.acehq.dev`, also still
`relay.acehq.dev`) forwards any HTTP request under `/m/<hostId>/` to that host's daemon over its
control session, with per-host limits (32 requests in flight, 1 MiB request bodies) and no logging
of paths, headers or bodies. Only outside MCP uses that path today, behind `remote.relayMcp`.

An earlier draft (removed from the MCP work) used a loopback-only listener on its own port. It
couldn't receive hosted webhooks without a tunnel, and its ephemeral port changed the URL on every
restart.

## Options considered

- **Reach: a listener of its own on a fixed port.** Loses for the same reasons as the earlier
  draft: hosted senders can't reach loopback, and opening a public port is what ADR 0122 exists to
  avoid.
- **Reach: ace cloud's forwarded HTTP (chosen).** No new public surface: same Worker, same
  limits, same control session. The person already signs the machine in for the relay.
- **Signing: a bearer secret, as Spade routines do (ADR 0129).** Simple, but the secret travels
  in every request, and ace cloud ends TLS (ADR 0122, "What this changes in the relay's trust"),
  so it would be readable in plain text there. No replay protection.
- **Signing: ace's own `X-Ace-*` HMAC headers (the earlier draft).** Sound, but every sender would
  need custom code.
- **Signing: Standard Webhooks (chosen).** The same HMAC-SHA256 over `id.timestamp.body` the draft
  had, with the header names and secret format of the open
  [Standard Webhooks](https://www.standardwebhooks.com/) spec, so senders that already use it,
  and its libraries in most languages, work unchanged. The secret never travels.
- **Secret: the person types or pastes one.** Leaves the strength to the person. ace generates it
  instead. Pasting a sender-made secret is a later addition, if senders need it.
- **Secret in the OS keychain.** The daemon runs headless on servers without one. The secret is
  kept in the daemon's data directory, as its other private state is.

## Decision

1. **A `webhook` automation trigger.** `{ kind: "webhook" }` joins `manual`, `schedule`, `github`
   and `file`, for the person's automations and agents' thread automations alike. The definition
   carries no secret and no URL. Runs it starts record `trigger: "webhook"`.

2. **Each webhook has an opaque hook id, and its URL is
   `<ace cloud origin>/m/<hostId>/hooks/<hookId>`.** The hook id is 128 random bits, made when the
   person creates the webhook's secret, and kept with it. It doesn't change on restart or when the
   secret is rotated. Unknown hook ids get 404, so the URL reveals nothing about which automations
   exist.

3. **Reached only through ace cloud, and only when `remote.relayWebhooks` is on.** The setting is
   off by default and separate from `remote.relayMcp`: letting outside assistants in doesn't open
   webhooks, and the reverse. The daemon's forwarded-HTTP handler sends `/hooks/…` to the webhook
   handler and everything else to outside MCP, each behind its own setting. The local listener
   and the Tailscale listener don't serve `/hooks/`. Both, and the person's own public URL, can be
   added later on the same handler.

4. **Requests are signed as Standard Webhooks specifies.** `webhook-id`, `webhook-timestamp`
   (epoch seconds) and `webhook-signature` (`v1,<base64 HMAC-SHA256 of id.timestamp.rawBody>`,
   space-separated when there are several). The secret is `whsec_` plus 32 random bytes in base64.
   The signature is checked in constant time over the raw bytes, before the body is parsed.

5. **The secret is ace's and the person's only.** The daemon generates it when the person asks,
   from the Automations screen. It's returned once, in the reply to that request, and never
   again. Requests for it are a person-only, admin-scope socket message (`automation.webhook`)
   outside `AutomationRequest`, so agents' `automation.manage` can't reach them. The secret is
   never in a definition, a list, run history, a log or an error. It's stored in its own table in
   `automations.sqlite`, never inside a definition's JSON. Rotating replaces it, and revoking
   deletes it with its hook id. Either way the next request with the old secret fails. Removing
   the automation removes its webhook.

6. **Replay protection uses the timestamp and the delivery id.** A timestamp more than five
   minutes from the daemon's clock is refused. The delivery id (`webhook-id`) becomes the run's
   event key, `webhook:<id>`, and a receipt in its own table, committed with the run, maps it to
   that run for ten minutes: twice the window, so it outlives every timestamp still accepted.
   Run history is pruned to each automation's latest runs, so it can't be the only record. A
   delivery to an automation turned off since is refused like any other. A retried delivery returns the run it started, before
   or after a restart.

7. **The JSON body becomes prompt variables, within limits, and excess is refused.** The body is
   at most 64 KiB and must be a JSON object, nested at most 8 deep, with at most 256 values. Its
   leaves become `{{body.a.b}}` (array items `{{body.items.0}}`), at most 63 of them, each at
   most 8,192 characters. Numbers, booleans and `null` become their JSON text. Keys must be
   letters, digits and `_`. `{{webhook.id}}` holds the delivery id. Values are substituted only
   where the person's prompt names them, and a prompt that names a variable the body lacks
   records a failed run, as other triggers do. Nothing is ever clipped: a body over a limit is
   refused.

8. **Answer on admission, with a distinct status for each refusal.**

   | Case                                                  | Status | `error`                  |
   | ----------------------------------------------------- | ------ | ------------------------ |
   | Run admitted, queued, skipped or already started      | 202    | (body `{ runId }`)       |
   | Not POST                                              | 405    | `method_not_allowed`     |
   | Unknown hook id, or webhook revoked                   | 404    | `not_found`              |
   | Body over 64 KiB                                      | 413    | `too_large`              |
   | Not `application/json`                                | 415    | `unsupported_media_type` |
   | Missing or malformed `webhook-*` headers              | 400    | `bad_headers`            |
   | Timestamp outside five minutes                        | 400    | `stale_timestamp`        |
   | No signature matches                                  | 401    | `bad_signature`          |
   | Body not JSON, or over a depth, count or length limit | 422    | `bad_body`               |
   | Automation turned off                                 | 409    | `disabled`               |
   | Automation service not running                        | 503    | `unavailable`            |

   Checks run in this order, so a caller without the secret learns only whether the hook exists.
   The reply never waits for the agent.

## Consequences

- Senders that speak Standard Webhooks work without custom code. GitHub's own webhooks sign
  differently (`X-Hub-Signature-256`, no timestamp) and aren't accepted. The polled `github`
  trigger still covers them.
- ace cloud sees webhook bodies in plain text, as it does outside MCP traffic (ADR 0122). It
  never sees the secret.
- Anyone with the secret can put text into an agent's prompt, with the access the automation
  runs at. The person chooses which fields the prompt uses. The Automations screen says so when
  it shows the secret.
- Concurrency, connection count, header size and timeouts are bounded by ace cloud's per-host
  limits and the relay host's `maxConcurrent`. Admission is one SQLite transaction, so the
  handler adds no limit of its own.
- Clients older than this change see a `trigger.kind` they don't know. Protocol v1 allows wider
  types (docs/protocol/README.md), and the generated schema is updated with it.

## Tests

- `packages/automations/src/webhook-signature.test.ts`: signatures from the Standard Webhooks
  reference vectors verify, and a changed byte, a stale timestamp or a wrong secret doesn't.
- `packages/automations/src/webhook-body.test.ts`: bodies over each limit are refused, never
  clipped.
- `apps/daemon/src/automation-webhooks.process.test.ts`: over real local HTTP through the relay
  handler, a signed request starts exactly one run, a repeat before and after a daemon restart
  starts none, each refusal gets its status and starts no run, and rotation, revocation and
  turning the automation or `remote.relayWebhooks` off make the next request fail. The secret
  doesn't appear in any reply, list, run or log line.
