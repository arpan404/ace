# Cursor SDK recording observations

The owner approved an initial SDK 1.0.35/composer-2.5 batch on 2026-10-03,
then explicitly approved the twelve previously skipped behavioural scenarios
under full-access policy. Each admitted scenario ran once, sequentially, with a
three-minute cap. There were no retries.

Every new header declares `recordingPolicy: "full-access"`, `sandbox: false` and
`autoReview: false`. The twelve captures are behavioural evidence under full
access, not restricted-mode or Auto-review evidence. The original `full-access`
capture was neither reopened nor modified. Its legacy header already declares
sandbox and Auto-review off. The SDK root model is composer-2.5; recorded Task
arguments select composer-2.5-fast for child work.

## Outcomes and time

The continuation completed eleven scenarios and left `checkpoint-resume`
incomplete. Including the original capture, there are twelve complete, one
incomplete and two skipped scenarios. "Complete" means the admitted workflow
settled and its sink closed. It does not establish every capability suggested
by the scenario name. The observed limitations below remain part of the evidence.

Times include catalog capture, host startup, execution and cleanup. The twelve
new attempts took 227.231 seconds in total. Skips sent no prompt and took no
execution time.

| Scenario | Outcome | Seconds | Evidence or reason |
| --- | --- | ---: | --- |
| text-thinking-read | complete | 8.786 | Read with assistant/thinking fragments; no edit |
| edit-shell-results | complete | 10.357 | Read, edit, echo exit 0 and shell exit 3 |
| restricted-mcp | skipped | 0.000 | Restricted/Auto-review unverified; no owner MCP lease |
| full-access | complete | 10.995 | Original capture, not attempted again |
| plan-question | complete | 20.186 | Native todos/plan; no typed question interaction |
| foreground-child | complete | 12.999 | One-level live child and returned conversation steps |
| background-child | complete | 25.924 | Two foreground task calls, second resumes the same native child |
| nested-task | complete | 43.282 | One child; that child reports nested Task unavailable |
| background-shell | complete | 42.335 | Native auto-background terminal, polled by file reads |
| interrupt-work | complete | 6.901 | Cancellation at first glob boundary, before long shell/child |
| steering-restart | complete | 9.672 | Two native segments, one logical ace run |
| checkpoint-resume | incomplete | 17.510 | Bounded history recovery failed; only first completed turn |
| portable-fork | complete | 20.891 | Two independent identities/threads, bounded ace handoff |
| mcp-image | skipped | 0.000 | Restricted/Auto-review unverified; no owner MCP lease |
| usage | complete | 8.388 | One cumulative counter from matching delta/message/result usage |

The original report's outcomes are preserved in `initialScenarios`.
`full-access-approval.json` reserves the separate owner decision exclusively;
the same `recording-report.json` is updated before and after each attempt.
A second invocation is refused. `restricted-mcp` and `mcp-image` remain skipped
because restricted/Auto-review availability cannot be verified and no actual
thread/instance-scoped MCP-owner lease is provisioned.

## What the captures established

- **Text and usage.** Assistant/thinking messages arrive as fragments alongside
  matching deltas. Delta ownership prevents double rendering. The usage scenario
  contributes one cumulative count of 15,912 input, 172 output and 6,848 cached
  input tokens. Billing mode remains unknown. These are turn usage, not account
  quota-window data. New captures retain numeric `totalTokens` and token-delta
  `tokens`; the original capture retains its old `<SECRET>` markers.
- **Edit and shell failure.** The exit-3 command has a successful SDK wrapper
  but a failed canonical tool. Its companion echo exited 0 and returned
  `hello from echo`; the edit succeeded. Parallel tool start/completion order
  differs, so replay assertions identify shell outcomes by their recorded exit
  code. The original full-access read also raced file creation and failed before
  the model performed a later read within that single native run.
- **Plan and question.** Native `updateTodos` returns five entries, including
  `inProgress`, normalized to `in_progress`. `createPlan` returns markdown.
  The question is expressed in plan/text, not a typed pending interaction.
  This does not establish daemon plan-mode controls or interactive questions.
- **Child content and fidelity.** Task arguments can already contain `agentId`
  when the call starts. One-level `tool-call-delta` updates carry child thinking,
  read tools and assistant output. Results contain `conversationSteps`.
  The previous translator kept these children at placeholder fidelity when
  identity was known early. It now promotes observed live/returned content to
  summary fidelity, without claiming a full or independently resumable subtree.
  Real replay tests retain the child's README text and keep the thread working
  while its root is blocked on the working child.
- **Requested background child.** Both Task results report `isBackground: false`.
  The follow-up resumes the same native child ID in a second task call. Canonical
  task-call lineage currently exposes two settled child records for that native
  identity. It must not invent a background lifecycle from the prompt. Native
  identity reuse across task calls needs separate review; no background-child
  completion/control capability is established here.
- **Nested task.** A single child attempted to discover a nested Task tool and
  reported it unavailable. Its live tool/read/text output is retained at summary
  fidelity. This is evidence of the limitation, not a successful deeper tree.
- **Background shell.** `sleep 3 && echo finished` returned quickly with an empty
  success result and exit 0; the SDK auto-backgrounded it into a terminal file
  under the isolated fixture store. The model read that file twice, eventually
  observing `finished` and exit 0. The shell boundary lacks a typed background
  task identity. It does not verify independent background settlement or stop
  controls. More explicit native terminal provenance needs investigation.
- **Interrupt.** Cancellation happened at the first observed glob tool boundary.
  Native status was cancelled and the root settled interrupted. No long shell or
  child had started, so cascading cancellation of that work remains unverified.
- **Steering.** A cancelled native segment and its replacement share one ace
  logical turn. The cancelled result leaves the thread working; the replacement
  reads README and settles. This capture contains two native run IDs, not an
  extra recorder attempt.
- **Checkpoint resume.** The source completed and closed its SQLite checkpoint
  store. Bounded SDK history recovery failed before a resumed open or second
  prompt. The safe error does not distinguish store/API/schema failure from a
  resource-budget failure. `resumed: false` and outcome `incomplete` remain in
  the capture. Its expectations cover only the completed first turn. No retry
  or automatic resend occurred; investigation requires separate approval for
  any new quota-spending attempt.
- **Portable fork.** The source is retained and a new SDK agent/thread receives
  an explicit bounded ace context handoff. Both threads settle, with different
  native identities. No opaque SDK store or source task ID is copied. The replay
  reader groups frames by thread so source and fork do not become one history.

New recording `seq` and `t` are monotonic across session reopen and fork;
`sourceSeq`, `sourceTimeMs`, `threadId` and SDK boundary offsets retain native
coordinates. Native callback offsets are not substituted for recording order.
The original capture remains unchanged. The fixture reader retains catalog and
analysis supplements separately from frames. All thirteen recordings round-trip
through the bounded sink and replay against their state expectations; the fork
has separate source and fork expectation files.

The recorded analysis rows describe the translator at recording time and remain
unchanged. In particular, recorded child placeholder fidelity is historical;
replay tests cover the corrected summary fidelity. Observations require owner
review rather than automatic conformance promotion.

## Proposed follow-up

- Investigate SQLite SDK checkpoint snapshot recovery before claiming live resume
  support from these fixtures. Portable handoff is the observed alternative.
- Review reuse of one native child identity across multiple task calls and typed
  auto-background shell/terminal provenance. Keep background capabilities limited
  until independent settlement evidence exists.
- Classify known token-delta/tool-list metadata without flooding raw notices.
- Handle paths spanning streamed fragments. Per-frame redaction can still allow
  replay to reassemble a disposable temporary workspace path; it contains no
  absolute home path or owner username. Captures were not hand-edited.

## Isolation and sign-in history

The continuation used the already signed-in `cursor-fixture` SDK store at
`$HOME/.ace-fixtures/cursor-sdk`, with daemon data at
`$HOME/.ace-fixtures/ace-home`. The supporting daemon injected a fixture-pinned
SDK registry and disabled ambient provider discovery from the start. No general
CLI doctor/auth/status probe was used. The daemon was stopped after recording.
All project workspaces were synthetic disposable temporary git repositories and
were removed after their attempts. The recorder never reads credential files.

The nested SDK child did run the installed `cursor-agent --help` command while
looking for nested Task support. That command ran inside the fixture SDK shell
with isolated HOME and did not request status, authentication or the normal
store. This help-only invocation is retained in the evidence rather than hidden.

The initial batch's early diagnosis included ambient provider discovery and a
normal Cursor CLI status probe, outside the requested isolation. That earlier
incident was documented in the first PR update. Subsequent SDK operations used
only the fixture instance. The initial CLI failure was a missing live
`cursorAuth` server-options getter; its separate fix exposes the initialized
service and preserves safe daemon errors. A temporary stdin daemon invocation
also passed `--input-type=module` into SQLite workers. Launching from a module
file fixed that invocation; account add and catalog selection then succeeded.

## Privacy and integrity

Before committing, `node tools/recorder/src/scan-cursor-sdk-fixtures.ts` scanned
all captured artifacts for credential patterns, unredacted sensitive fields,
emails, absolute home paths and the owner's username. It also scanned replayed
items after streamed text had been reassembled. No findings remained. A scanner
false positive for an npm configuration identifier was corrected to match the
existing npm token pattern; no credential value was printed. Browser challenges
and auth envelopes are excluded from the captures.

The original full-access SHA-256 remains
`1f56b50f5c1649f93f176055dbb4cdbb0193f4eaf60dc864e2fedf4e524538d2`.
All newly captured JSONL files remain exactly as written by the sink.
