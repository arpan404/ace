# @ace/core

Core folds adapter facts into the canonical agent tree and protocol events. It
does no I/O and owns no clock, timer, process or id generator. Call `apply` with
an injected millisecond timestamp and an id source that returns unique ids for
each entity kind. The daemon adds the event envelope and schedules `tick` facts.

```ts
import { ThreadId } from "@ace/protocol";
import { apply, createThreadState, nextDeadline } from "@ace/core";

const state = createThreadState({
  threadId: ThreadId.parse("thread_1"),
  config: { provider: "codex", silenceMs: 90_000 },
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
const deadline = nextDeadline(state);
// Schedule a tick at deadline, if defined. Core never schedules timers itself.
```

`ThreadState` contains ordinary JSON data: native-key dictionaries of agents,
items, current interactions and tasks, archived terminal interactions and tasks,
ace-keyed runs, process state, queued-input count and the last derived statuses.
Serializable indexes track live tools, pending interactions, running tasks,
children and unresolved links. Status derivation visits live work and the agent
tree without scanning historical transcript items. Snapshot the state with JSON
and resume with the same id source position. An optional `rootAgent` initializer
uses the `agent.seen` fields except `type`, `origin`, `parent` and `spawnedBy`.
Its first event is emitted on the first `apply`, which supplies time and ids.

Events own their data. Later facts and mutations of returned payloads do not
change earlier events or the stored state. Facts and raw payloads must contain
JSON data. Namespace native keys and native turn ids by provider process, since
providers restart counters. Reopening a terminal interaction or task key creates
a new ace id and preserves the old row; duplicate live opens are ignored.
Prototype property names such as `__proto__` are valid.

`apply` validates provider facts before changing liveness, allocating their ids
or creating placeholders. Invalid, contradictory or unknown facts produce a
warning notice containing the raw fact and leave existing work untouched. If no
root exists, warnings wait in the JSON snapshot until a valid fact establishes
the root. They then appear under that root with their original timestamps and
raw data. Rejection never creates an agent or refreshes liveness. Non-JSON
values get descriptive markers in the diagnostic.
Bad caller configuration and context remain programmer errors.

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
  check silence. On restart, emit `process.started` to clear the exit marker in
  the same state. Settled agents remain settled; subsequent turns can resume.

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
- A parent streaming its own response stays working while background children
  run. Cursor's held prompt needs synthesized run boundaries in its adapter.
- Silence uses the latest signal anywhere in the agent's subtree. Live tools,
  descendants, non-ambient tasks, interactions and retries suppress silence
  failure in the default mode. Transport mode instead uses the latest provider
  fact or heartbeat in the thread and can mark any unsettled agent unresponsive.
  Long commands and provider backoffs are healthy while heartbeats continue.
- A thread fails when its root's latest outcome failed, or a failure occurred
  after the root's latest success. Earlier child failures remain visible on
  those agents and do not defeat a later successful recovery.
- Never-started children and placeholders become unresponsive after subtree
  silence or when their spawning tool finishes. A configured root before the
  first run leaves the thread new, unless higher-priority waiting work exists.
  A never-started unresponsive child stays visible but does not block completion
  or make the thread unresponsive by itself. Its live tasks, pending interactions,
  retries and descendants still hold completion. A child with an active or past
  run remains relevant when unresponsive: silence does not prove that work ended.

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

Run `bun run check` from the repository root. After every test application, the
shared helper parses emitted payloads, folds a client view keyed by ace id and
compares all published entities and thread status against the engine state.
Tests assert on that view or events. Scenarios cover false completion,
interrupts, retries, approval races, reordered frames, restarts and snapshots.
The 10,000-delta test leaves a child silent past its threshold and requires only
delta events, so an unnecessary status derivation fails deterministically.

Run `bun run packages/core/bench/activity.ts` or
`node packages/core/bench/activity.ts` for a non-gating activity benchmark across
growing transcript histories. It reports timings without a machine-load budget.
