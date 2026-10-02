# @ace/core

Core folds adapter facts into the canonical agent tree and protocol events. It
does no I/O and owns no clock, timer, process or id generator. Call `apply` with
an injected millisecond timestamp and an id source that returns unique ids for
each entity kind. The daemon adds the event envelope and schedules `tick` facts.

```ts
import { ThreadId } from "@ace/protocol";
import { apply, createThreadState } from "@ace/core";

const state = createThreadState({
  threadId: ThreadId.parse("thread_1"),
  config: { silenceMs: 90_000 },
});
let sequence = 0;
const events = apply(
  state,
  {
    type: "turn.started",
    agent: "native-root",
    trigger: "user",
  },
  { now: 1_000, ids: { next: (kind) => `${kind}_${++sequence}` } },
);
```

`ThreadState` contains ordinary JSON data: native-key dictionaries of agents,
items, interactions and tasks, ace-keyed runs, pending spawn links, process
state, queued-input count and the last derived statuses. Snapshot it with JSON
and resume with the same id source position. An optional `rootAgent` initializer
uses the `agent.seen` fields except `type`, `origin`, `parent` and `spawnedBy`.
Its first event is emitted on the first `apply`, which supplies time and ids.

Events own their data. Later facts and mutations of returned payloads do not
change earlier events or the stored state. Facts and raw payloads must contain
JSON data. Native keys are unique within an entity kind in a thread, even after
a provider reconnects. Prototype property names such as `__proto__` are valid.

## Adapter contract

- Bracket every agent's work with `turn.started` and `turn.ended`. Synthesize
  child turns for Claude and Cursor. Do not interpret a child's initial native
  idle notification as completion before its first turn.
- Declare the real root with `agent.seen`. Unknown agents and parents become
  placeholders immediately; later facts fill metadata and re-parent them.
- Set a child's `background` flag through `agent.seen` or `agent.linked`.
  A background task can track a child that is still foreground, as Codex does,
  so `background.started` does not change this flag.
- Preserve native item keys across late completions. Core keeps the first
  item's run attribution even when another turn has since started.
- Emit `background.started` before ending a turn if its tool survives. Unknown
  tools referenced by tasks or interactions get synthetic items first. Enrich
  the same key when the native item arrives.
- Set `wake.expected` before releasing the last live task when a self-started
  turn is expected. Claude's adapter can inject its five-second grace deadline.
  OpenCode should keep the task running until result delivery, then declare the
  expected parent wake before ending the task. Codex needs no wake expectation.
- Clear retries explicitly. A backoff deadline passing does not prove the
  provider recovered. Agent-free `signal` facts are transport heartbeats and
  refresh liveness for the whole tree. OpenCode should set
  `config.liveness: "transport"` and its transport watchdog threshold, such as
  25 seconds. This checks transport silence before retry or tool activity, so
  a lost heartbeat can mark quiet busy agents unresponsive. The default
  `"agent"` mode checks each agent's subtree instead.
- Emit `process.exited` only when the process died. A transport disconnect that
  may recover should stop its heartbeat and let externally scheduled ticks
  check silence. Core has no process restart fact; a new process gets a new
  state, or the daemon restores a snapshot from before exit and resynchronizes.

First item upserts must form a valid protocol item after defaults. Updates are
partial patches; nested calls and same-kind details merge, while arrays replace.
Tool details use native `childAgent` and `targetAgent` keys. Core assigns their
canonical ids, call ids, owners, creation times and background-task links. A
provider timestamp can still be supplied as `call.startedAt`.

`item.delta` appends text to message parts, reasoning or notices, and output to
shell tool details. The protocol has no generic output field for other tool
kinds; those results belong in a typed detail or raw data via upsert. A delta
without an item creates a minimal streaming item. Known deltas update only the
item and its owner's liveness. Tree and status derivation run only for creation,
a change in current-run activity, or recovery from `unresponsive`.

## Status decisions from fixtures

The ordered rules in the milestone brief apply with these fixture refinements:

- Pending and awaiting-approval tools count as live, as well as running tools.
- An agent doing its own tool work stays working while a foreground child runs.
  Without its own tool work, its spawn call blocks on the child.
- An active responding parent with a live background child waits for background
  work, matching Cursor's held prompt.
- Silence uses the latest signal anywhere in the agent's subtree. Live tools,
  descendants, non-ambient tasks, interactions and retries suppress silence
  failure in the default mode. Transport mode instead uses the latest provider
  fact or heartbeat in the thread and can mark any unsettled agent unresponsive.
  Long commands and provider backoffs are healthy while heartbeats continue.
- Any failed agent makes the thread failed after all other work settles, matching
  OpenCode and Cursor. This differs from the brief's root-only failure rule.

The explicit thread precedence counts every starting or working child, including
background children. Thus a finished root can wait on a background task while
the thread remains `working`. Some fixture prose calls that thread `waiting`;
both keep it live, and the milestone's explicit precedence is used here.
`unknown` tasks permit completion, as the current protocol and milestone require,
despite older Cursor fixture prose that counted them as running. Cursor adapters
must use a side channel or qualify completion when background shells are hidden.
Provider-native timing, error-text classification and capability probing belong
to adapters; core accepts normalized error kinds and injected deadlines.
Transport loss does not expire requests automatically; adapters can close them
as `expired` when the connection is lost and resynchronize after reconnection.
Thread aggregation keeps the brief's ordered precedence even during a transport
outage, so pending interactions and live background tasks can outrank silence.

## Verification

Run `bun run check` from the repository root. Tests parse every emitted payload
and check that schema parsing preserves all fields. Direct status tests cover
precedence; synthetic fixture scenarios cover false completion, interrupts,
retries, approval races, reordered frames and snapshots. The 10,000-delta test
includes parsing and a generous five-second budget for loaded machines, with
settled agents and historical items present to exercise thread size.
