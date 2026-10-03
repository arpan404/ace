# Cursor SDK recording observations

Owner approval was given on 2026-10-03 for all fifteen scenarios, once each,
with SDK 1.0.35 and composer-2.5. The batch used the fresh isolated
`cursor-fixture` instance at `$HOME/.ace-fixtures/cursor-sdk`. SDK browser
sign-in used the SDK's own credential store. `signed-in` was published to the
orchestrator status file after a safe SDK status check.

## Outcomes and time

Times include model-catalog capture, host startup, execution and cleanup.
Skipped scenarios spent no execution time and sent no prompt.

| Scenario | Outcome | Seconds | Reason |
| --- | --- | ---: | --- |
| text-thinking-read | skipped | 0 | Auto-review availability unverified |
| edit-shell-results | skipped | 0 | Auto-review availability unverified |
| restricted-mcp | skipped | 0 | Auto-review unverified; no fixture MCP lease provisioned after that prerequisite failed |
| full-access | complete | 10.995 | One native agent and run; canonical root settled; capture closed |
| plan-question | skipped | 0 | Auto-review availability unverified |
| foreground-child | skipped | 0 | Auto-review availability unverified |
| background-child | skipped | 0 | Auto-review availability unverified |
| nested-task | skipped | 0 | Auto-review availability unverified |
| background-shell | skipped | 0 | Auto-review availability unverified |
| interrupt-work | skipped | 0 | Auto-review availability unverified |
| steering-restart | skipped | 0 | Auto-review availability unverified |
| checkpoint-resume | skipped | 0 | Auto-review availability unverified |
| portable-fork | skipped | 0 | Auto-review availability unverified |
| mcp-image | skipped | 0 | Auto-review unverified; no fixture MCP lease provisioned after that prerequisite failed |
| usage | skipped | 0 | Auto-review availability unverified |

There were no incomplete scenario attempts and no second attempts. The provider
issued a later shell read after its first read raced file creation, within the
single approved native run. This was not another recorder attempt or a hidden
agent retry. Native agent retries are disabled by the adapter's policy.

Restricted recording requires independent confirmation that the account/backend
has the Auto-review classifier feature enabled. The installed SDK documents this
condition for `autoReview`, but its public API does not offer that capability
query. The driver did not force development gates or equate the option with
availability. MCP scenarios require the existing storage/tools owner's actual
thread/instance-scoped lease, with registered synthetic thread/history. No fake
lease, static credential or SDK custom tool was used.

## What the capture established

- The SDK started a local SQLite checkpoint store, sent one native run and
  recorded 239 boundary/lifecycle frames. Its last durable boundary offset was
  238; the host-exit note has its own capture ordering. Native run duration was
  7.772 seconds. This does not establish checkpoint resume or portable fork.
- Creating a new file arrived as an `edit` tool call. The SDK dispatched a shell
  read before the edit completed. That shell's wrapper was `status: success`,
  but its value had `exitCode: 1` and a missing-file error. A later shell read
  exited 0. Canonical statuses correctly remain succeeded, failed, succeeded.
  A finished root must not turn the earlier failed shell into a success.
- SDK assistant/thinking messages are fragments, alongside matching delta
  events. Delta ownership produces three assistant passages without duplicating
  the message stream or final result. Equivalent handwritten transcript, shell
  and accounting samples were replaced with real-capture replay tests.
- Turn-ended, usage-message and terminal-result accounting contribute one
  cumulative counter: 24,592 input, 468 output and 10,272 cached input tokens.
  Billing mode remains unknown; token usage is not an account quota-window feed.
- The capture contains numeric `totalTokens` and token-delta `tokens` fields
  already replaced with `<SECRET>` by the old redactor. The shared redactor now
  preserves those nonnegative integer counters while still removing string or
  credential-shaped values. Lost numbers were not reconstructed or edited into
  this capture. A second recording to verify those numbers needs new approval.
- The generic fixture reader assumed every row after the header was a frame.
  It now retains SDK model-catalog/analysis rows separately, allowing the real
  capture to replay through the existing testkit and round-trip through the
  recorder's bounded sink.

## Evidence limits and proposed follow-up

These are observations and review candidates, not an owner-reviewed conformance
verdict. There is no evidence here for restricted denials, Auto-review, MCP,
questions/plans, task-child fidelity, background settlement, interruption,
steering, resume or fork. Those scenarios were skipped, rather than simulated.

Known token-delta/tool-list metadata currently remains as raw informational
notices. The replay yields 84 notices, including 76 token-delta records. A future
translator change should classify that metadata without flooding the notice
stream, while retaining its raw evidence and keeping usage accounting separate.

Per-frame redaction cannot recognize a temporary workspace path split across
many text fragments. Replay can reassemble that disposable temporary path even
though complete path fields use `<WORKSPACE>`. It contains no absolute home path
or owner username, and the disposable repository was deleted. Stream-aware path
redaction across fragment boundaries is proposed; this capture was not hand-edited.

## Sign-in and isolation notes

The original CLI failure was the daemon omitting `cursorAuth` from its live
server-options getters. Auth initialization succeeded after listener creation,
but socket requests kept seeing an unavailable service. The separate CLI fix
publishes that service and preserves safe daemon error codes through status and
login polling. Its behavior test uses a real daemon WebSocket.

Browser jobs expire after five minutes. Authentication challenges were renewed
within the requested 45-minute sign-in window without sending agent prompts.
One temporary daemon invocation used `--input-type=module`; its SQLite worker
inherited that flag and failed with `ERR_INPUT_TYPE_NOT_ALLOWED`. This caused a
post-login catalog operation to report login failure after the SDK store had
successfully signed in. A final safe status check established the stored login.
Relaunching from a module file fixed the invocation: account add exited 0 and
the real daemon's auth selection/catalog update succeeded.

Early diagnosis included ambient provider discovery and a general doctor probe
that checked the normal Cursor CLI's status. That was outside the requested
fixture isolation. Subsequent daemon startup pinned the SDK binding to the
fixture instance and disabled ambient provider discovery. Every SDK auth and
recording operation used the fixture home. No provider credentials were read,
copied or logged by ace tooling.

## Privacy and capture integrity

Before commit, every captured JSON/JSONL file was scanned for credential patterns,
unredacted sensitive-key values, emails, absolute home paths and the owner's
username. No findings remained. The scan reported only filenames, categories and
line numbers, never matched credential text. Auth channels and browser challenges
are absent from the capture.

The original capture remains unchanged, including its existing redaction markers.
Its SHA-256 is
`1f56b50f5c1649f93f176055dbb4cdbb0193f4eaf60dc864e2fedf4e524538d2`.
