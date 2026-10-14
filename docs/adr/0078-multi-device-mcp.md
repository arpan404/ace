# 0078: Agents across the person's machines

Status: accepted for the first slice. Date: 2026-10-13.

## Context

A person runs ace on several machines: a MacBook, a desktop with a GPU and a real browser
session, a build server. An agent on one machine sometimes needs another: to run a task in a
project that only lives there, to use that machine's browser, or to check on work there.
ADR 0071 brokers remote tasks through a connected client and the files relay. That suits
context and file transfer, but an agent should not depend on a window staying open to use a
machine the person already paired.

## Decision

### Trust and transport

The calling daemon acts as a paired device of the target, using the profile `ace remote add`
or `ace pair` already stored in its home (`cli-profiles.sqlite`). It calls
`POST /v1/machine-calls` on the target's paired-device TLS listener with the pinned public key
and its own device token: the same channel and credential as `/v1/tickets`. There is no new
trust channel, no new secret and no token in any agent-facing value. Every request
authenticates again, so revoking the device or turning access off stops the next call.

The relay does not carry these calls in this slice, because it does not carry conversations
either (ADR 0070). Machines reachable over LAN or Tailscale work.

### Discovery

`ace_machines` lists the paired machines that let this device's agents in: the profile name
agents pass as `machine`, the machine's display name, online or offline, the granted access
(`read` or `operate`), its projects, its tool groups (`agents`, `browser`) and installed
providers. A machine that has not opted in, or refuses this device, is not listed. An offline
machine is listed only after this daemon has seen it opted in, with a next step.

### Calling: explicit parameters, not a proxy

Tools that make sense elsewhere take a `machine` parameter:

- `delegate_task` takes `machine` and `project`. The child is an ordinary thread on the target,
  in that project, started with the target's own access mode for the provider.
- `ace_wait` and `ace_agents_status` include those children, marked with the machine.
  `agent.status` and `agent.cancel` work on them too.
- Every `ace_browser_*` tool takes `machine`.

A generic `ace_remote_call(machine, tool, args)` was rejected. It would hide the target's tool
schemas, so agents would guess arguments. It would make every tool callable remotely by
default, including ones that make no sense on another machine. It would also blur which
consent applies. Explicit parameters keep each tool's schema, risk class and MCP annotations
as they are. A tool is reachable elsewhere only when it was deliberately given `machine`.

### Security and consent

- **Opt-in:** each machine has `remote.agentAccess`: `off` (the default), `read` or `operate`.
  It is shown in Settings › Remote devices as "Agents on other devices can use this machine"
  with a Scope of Read only or Read and act. It is an administrator setting like the other
  `remote.*` keys.
- **Authority:** the target grants the lower of that setting and the calling device's pairing
  scope. Describe, status and read-only browser tools need `read`. Delegating, cancelling,
  answering and every other browser tool need `operate`. A read-only pairing can't start work.
- **Caller's ceiling:** the calling side refuses writes from a thread whose access is
  read-only. So remote calls are capped by both the pairing and the caller's permission ceiling.
- **Target policies:** the target applies its own policies. Delegated children use its access
  mode. Browser calls run through the target's own browser tool registry, in a target thread
  named for the calling thread, with its origin consent, evaluate approvals and takeover. The
  read-only/destructive rule holds unchanged: reads never prompt, new sites and scripts do.
- **Answering from either device:** a request that waits for the person on the target appears
  in the originating thread's composer strip, titled with the machine ("Studio: open
  example.com…"). It is also open on the target itself. Answering here forwards the person's
  resolution, attributed to this device. Answering there closes the copy here on the next
  poll. Agents still can't answer approvals.
- **Attribution and logs:** the target logs every call with the device, the calling machine,
  its thread and the outcome. The caller logs the machine, operation, thread and outcome.
  Threads the target starts are ordinary threads there, with a title and first message naming
  the calling machine and thread. Machine calls start, or are refused, only through this path.

### Reliability

- An unreachable target gives `machine_offline` with a next step. A target that stops letting
  agents in gives `machine_unavailable`.
- A connection lost after sending gives `machine_disconnected`, saying the action may have
  run. Delegation is keyed by `requestId` on the target, so it retries once by itself.
- Every call has a bound: describe 4 s, status 10 s, delegate 30 s, browser at most its tool's
  timeout.
- Delegated children live in a durable ledger on the caller, polled each second while any is
  unsettled. An unreachable machine keeps its children working with a note and never reads as
  done. The parent holds a background task for each one, so it never reads done early.
- A settled result goes to an active `ace_wait`, or is delivered to the parent as a new turn
  exactly once. Stopping the parent, or the background task, cancels the child there.

### UI

- A child on another machine shows "on Studio" on its subagent row, and its Summary background
  entry reads "role · Studio". The row opens the Summary, not a local thread.
- Tool rows name the machine: "On studio, went to `example.com`".
- Settings › Remote devices holds the opt-in switch and its scope.

## Follow-ups

- Screen and computer use, and in-app devices, over machine calls. They need per-app approval
  and live frames, so they are left for a follow-up.
- Thread reads and starts in another machine's project beyond delegation (`thread.read`,
  `thread.start` with `machine`).
- Routing machine calls over the self-hosted relay, and converging ADR 0071's client-brokered
  `ace_device_*` tools and file transfer onto this path so there is one way to work elsewhere.
- Persisting the offline directory across restarts, and pushing status from the target
  instead of polling.

## Verification

Two real daemons in temp homes are paired over TLS, the way `ace remote add` stores a machine,
with scripted providers and a fake headless browser. Tests cover:

- the opt-in: listing only an opted-in machine, and turning it off stopping the next call;
- delegation running on the target, with `ace_wait` on the caller returning its result and
  the parent's row naming the machine;
- a read-only pairing refusing to start work;
- a browser request on the target answered from the calling thread;
- an offline target's error and listing;
- no device token in any tool output.

UI tests cover the settings switch and scope, the subagent row and tool row wording.
