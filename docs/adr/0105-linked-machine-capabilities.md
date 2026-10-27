# 0105: What agents from a linked machine may do here

Status: accepted. Stage 1 (grants, guest sessions, op stubs, settings) is built; stage 2 fills in
devices, screen and commands. Date: 2026-10-27.

## Context

ADR 0078 lets an agent on one machine delegate to another machine and use its browser. Its
follow-ups left out simulators and emulators, computer use and commands. The case that needs
them:

- A MacBook runs the desktop app and the iOS simulators. No provider CLI is signed in on it.
- An agent runs on a Linux box. It must list, boot, drive and screenshot the Mac's simulators,
  use the Mac's computer use and run commands there.
- The person watches and talks to that agent from a Windows laptop.
- Several agents on several machines use different devices at once.

One global switch (`remote.agentAccess`: off, read, operate) can't express "the Linux box may
drive simulators but not my screen, and the build server may do neither". Remote browser work
also ran in a provider thread on the target, so a machine with no provider installed refused it
with "Add a project and an agent on this machine first."

## Decision

### Capabilities, granted per linked machine

The target holds a grant for each **capability**, for each paired device that calls it. A
linked machine calls as a paired device (ADR 0078), so in practice this is one grant per linked
machine.

| Capability | Machine-call ops | Default |
| --- | --- | --- |
| Agents | `delegate`, `status`, `cancel`, `message`, `respond` | `remote.agentAccess` |
| Browser | `browser.session`, `browser` | `remote.agentAccess` |
| Simulators & emulators | `devices` | Read and act |
| Computer use | `screen` | Off |
| Commands | `commands` | Off |

Each grant is Off, Read only or Read and act (`off`, `read`, `operate`).

- **Storage.** `machine_grants(device_id, capability, level, updated_at)` in the target's
  daemon database. Rows are sparse: a missing row is the default above. A row exists only once
  the person chooses a level for that machine and capability.
- **Migration.** Nothing is rewritten. Agents and Browser default to the current
  `remote.agentAccess`, so every existing pairing behaves as it did. `remote.agentAccess` stays
  as the machine-wide switch: `off` lets no agent from any other machine in, whatever the grants
  say (the machine is not listed, as today). `read` or `operate` is the starting level of
  Agents and Browser for a machine the person hasn't set apart.
- **Authority.** Each call is decided by one pure function
  (`apps/daemon/src/machines/grant-rules.ts`): the capability the op needs, the op's risk
  (read or act), the machine-wide switch, the grant, the calling device's pairing scope and
  the calling thread's ceiling. The effective level is the lowest of grant, pairing scope and
  ceiling. A read-only pairing never acts. A read-only thread on the calling machine never acts.
  The calling machine sends its thread's ceiling in the call's origin, and it refuses writes
  from read-only threads before sending (ADR 0078). The target applies the ceiling as well, so
  it doesn't depend on the caller checking.
- **Revocation.** Grants are read on every call, so a change applies to the next call. Turning a
  capability down also stops in-flight work for that machine and capability (below).
- **Risk per op.** Each capability names its read-only tools. Browser takes the registry's risk
  class, as it does today. Stage 2 gives `devices` and `screen` theirs (`sim_list`, `sim_ui`,
  `sim_logs`, `sim_screenshot`, `screen_apps`, `screen_state` read; the rest act). Commands
  always act. A tool with no known risk is treated as acting.

### Discovery

`describe` returns the effective level of every capability as `grants` and lists in `tools`
only the groups this device may use: `agents`, `browser`, `devices`, `screen`, `commands`. A
group appears only when its effective level is at least read and this machine can serve it.
`machines` on the caller passes both through, so an agent sees, for example, that the Mac lets
it drive simulators but not its screen. A machine where every capability is off for this device
answers `machine_opted_out` and is not listed.

### Who a remote agent is on the target

A remote agent is identified on the target by the calling device, calling host, calling thread
and calling agent:

- The **guest session** (below) is keyed by device, host and thread, so two threads on the
  Linux box get two sessions, and the same thread calling from two machines does too.
- Within a session, each calling agent has its own **owner**: `agentOwner(sessionThread,
  "remote:" + callingAgentId)`, the same shape as a local agent's device owner. Device leases
  (`packages/devices`), computer-use leases and browser tabs are held by that owner. Two remote
  agents never share a lease, and one remote agent keeps its lease across calls. Agents on
  different machines, or in different threads, drive different simulators in parallel.
- A device id from one paired device can't name another device's sessions: every op on a
  session checks that the session belongs to the calling device.

### Guest sessions: remote work without a provider

Remote tool use (browser now; devices, screen and commands in stage 2) runs in a **guest
session** on the target. One exists per (calling device, calling host, calling thread).

- It is an ordinary engine thread in its own hidden chat project (ADR 0099), created directly by
  the engine without a provider adapter. It never runs a provider, so a machine with no CLI
  installed or signed in serves remote tools. Its recorded provider is a placeholder (the first
  installed one, else `claude`); nothing launches it. `ThreadDetails.guest` marks it, with the
  calling machine's name and host id.
- **Visible and attributable.** It is titled "<calling machine> · <calling thread title>", for
  example "Linux box · Fix the login flow", and shows in the target's task list like any thread.
  It is recorded in `machine_threads` with kind `guest` and the calling device, host and thread.
- **Never done while work runs.** Each call in flight holds a stoppable background row in the
  session (`ace-guest:<id>`, titled with the tool, such as "browser_open from Linux box"). While
  any is running the thread reads as waiting on background work, never done. A daemon restart
  ends rows left running, since their work ended with the process.
- **Cancellable.** Stopping the row, or the thread, aborts that call. The calling agent gets an
  error saying the person stopped it.
- **Approvals.** Requests that wait for the person (a new site, an evaluate, a takeover) open in
  the guest session, so they show on the target. The calling machine polls the session's
  `status` and mirrors them into the originating thread's composer strip, as browser does
  today (ADR 0078). Answering on either machine resolves both. Agents never answer them.

### Human takeover beats remote agents

A person driving a simulator, screen or browser tab on the target always wins. The devices
service already lets a `human` lease override any agent's. Remote agents hold ordinary agent
leases, so a takeover suspends them exactly as it does local agents. Their next call gets the
lease's "the person is using it" refusal, never a silent retry. Computer use keeps its per-app
approval and screen-session rules (ADR 0078 follow-up, packages/screen). A remote agent is
another agent asking, never a way around the person's per-app consent.

### Kill switch

Turning a capability down for a machine (or `remote.agentAccess` off, or revoking the device):

1. refuses the next call;
2. aborts every in-flight call of that machine and capability at its next step: the call's
   signal fires, the background row ends as stopped, and the calling agent hears why;
3. releases the device leases and screen sessions that machine's remote agents hold (stage 2,
   through the guest session's end hook).

### Bounded results

- Results are MCP content, text and images (`MachineToolResult`), at most 16 parts. A reply is
  at most 8 MB on the wire; screenshots go as images, never as files to fetch.
- Every op has a time bound: describe 4 s, the session 15 s, browser at most its tool's
  timeout, devices and screen at most 120 s per call. Commands carry their own timeout, at most
  10 minutes, with output capped at 1 MB and the rest summarized.
- A call cancelled on the calling side aborts on the target.

### Audit

The target logs every machine call, allowed or refused, with the device id and name, calling
host and thread, op or tool, capability and outcome. Refusals log their code. This is the same
structured log ADR 0078 started; stage 2 adds the capability field to every line and a
per-machine view in Settings › Fleet. The guest session's background rows are the visible
record in the app. Commands also record each command line and exit code in the session's
transcript.

### Commands: allowed when on

When Commands is Read and act for a machine, its agents run commands here without a prompt
per command. They are still confined to this machine's registered projects (the working
directory must resolve inside one), run with this machine's user, are logged as above and are
stoppable from the guest session. Read only allows no commands; there is no read-only shell.
Off is the default.

### Watching from a third machine

The Windows laptop is paired with the Mac like any client. Its devices panel already reaches
paired endpoints and subscribes to the Mac's device frames directly. When the Linux agent boots
and drives a simulator through the Mac, the Windows window sees the Mac's guest session
"Linux box · <thread>" and opens that simulator live from the Mac. Frames never pass through the
Linux box. The person can take over from Windows, which suspends the remote agent's lease as
above. Approvals show on the Linux box's thread (where the person talks to the agent, mirrored)
and on the Mac's guest session.

### Relay

Machine calls stay on LAN or Tailscale. This ADR does not add relay routing. The relay carries no
conversations or machine calls today (ADR 0070, 0078). Routing these through it needs the relay
to carry pinned-TLS request streams with device auth end to end, which is its own design. The
grants here are independent of transport, so adding relay routing later changes nothing above.

## Rejected

- **A generic `remote_call(machine, tool, args)`.** It hides each tool's schema and risk, and it
  makes every tool remotely callable by default (ADR 0078). Each capability gets its own op and
  its tools take `machine` deliberately.
- **One global level per capability.** The person needs to treat the build server and the
  Linux box differently. Grants are per calling device.
- **Running remote tools in a provider thread on the target.** It needs a provider installed,
  and a provider thread invites the person to chat with something that isn't an agent.
- **Asking per command.** The owner chose "allowed when on": prompts on an unattended machine
  stall the remote agent. Confinement to projects, logging and the kill switch bound it instead.
- **A new project kind for guest sessions.** Hidden chat projects already give an empty folder,
  are left out of every picker and clean up when their thread is deleted.

## Consequences

- Each guest session adds a thread and a hidden chat project on the target.
- A machine with `remote.agentAccess` off is closed to every capability. The person turns it on
  once and then sets each linked machine apart.
- Simulators and emulators default to Read and act for linked machines. Linking is an
  administrator action, and simulators hold nothing of the person's.

## Stage 2

- `devices`, `screen` and `commands` ops served through the guest session (`GuestSessions.run`),
  with their risk maps, `machine` on `sim_*` and `screen_*` tools and a new `command_run` tool.
- Releasing leases and screen sessions on the session's end hook.
- Audit view in Settings › Fleet.

## Verification

Two real daemons paired over TLS, as in ADR 0078's tests:

- grants refuse and allow per capability per calling device;
- lowering a grant applies to the next call;
- a target with no provider installed serves a browser call through a guest session;
- `machines` lists only granted capabilities.
