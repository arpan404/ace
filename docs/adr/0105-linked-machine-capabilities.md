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

| Capability             | Machine-call ops                                     | Default              |
| ---------------------- | ---------------------------------------------------- | -------------------- |
| Agents                 | `delegate`, `status`, `cancel`, `message`, `respond` | `remote.agentAccess` |
| Browser                | `browser.session`, `browser`                         | `remote.agentAccess` |
| Simulators & emulators | `devices`                                            | Read and act         |
| Computer use           | `screen`                                             | Off                  |
| Commands               | `commands`                                           | Off                  |

Each grant is Off, Read only or Read and act (`off`, `read`, `operate`).

- **Storage.** `machine_grants(device_id, capability, level, updated_at)` in the target's
  daemon database. Rows are sparse: a missing row is the default above. A row exists only once
  the person chooses a level for that machine and capability. Revoking a pairing deletes its
  rows, so a device paired later never inherits them.
- **Migration.** Nothing is rewritten. Agents and Browser default to the current
  `remote.agentAccess`, so every existing pairing behaves as it did.
- **The machine-wide switch is a ceiling.** `remote.agentAccess` caps every capability for every
  linked machine. `off` lets no agent from any other machine in, whatever the grants say (the
  machine is not listed, as today). `read` makes every capability Read only at most, including
  simulators, computer use and commands: nothing from another machine acts here. `operate`
  lets each grant apply as set. It is also the starting level of Agents and Browser for a
  machine the person hasn't set apart.
- **Authority.** Each call is decided by one pure function
  (`apps/daemon/src/machines/grant-rules.ts`): the capability the op needs, the op's risk
  (read or act), the machine-wide switch, the grant, the calling device's pairing scope and
  the calling thread's ceiling. The effective level is the lowest of switch, grant, pairing
  scope and ceiling. A read-only pairing never acts. A read-only thread on the calling machine never acts.
  The calling machine sends its thread's ceiling in the call's origin, and it refuses writes
  from read-only threads before sending (ADR 0078). The target applies the ceiling as well, so
  it doesn't depend on the caller checking.
- **Settings.** `fleet.request` gains `grants` (each paired device's levels, optionally for
  given device ids) and `grant` (one device, one capability, one level). Both need administrator
  access on that machine, like its links and devices.
- **Revocation.** Grants are read on every call, so a change applies to the next call. Turning a
  capability down also stops in-flight work for that machine and capability (below). Lowering
  Agents refuses new delegations and messages; children already delegated keep running, and
  the person stops them from their threads here.
- **Risk per op.** Each capability names its read-only tools. Browser takes the registry's risk
  class, as it does today. Stage 2 gives `devices` and `screen` theirs (`sim_list`, `sim_ui`,
  `sim_logs`, `sim_screenshot`, `screen_apps` read; the rest act). `screen_state` reads
  only when the effective grant is Read only: it freshly resolves the app and refuses a stopped
  app with a next step for the person, so a look cannot open it. Read and act keeps the normal
  launch-on-look behavior, which the local tool catalog marks external-effect. Commands
  always act. A tool with no known risk is treated as acting.

### Discovery

`describe` returns the effective level of every capability as `grants`, and `access` as it meant
before grants: `operate` only when Agents is Read and act, so older callers aren't told they can
delegate when they can't. It lists in `tools`
only the groups this device may use: `agents`, `browser`, `devices`, `screen`, `commands`. A
group appears only when its effective level is at least read and this machine can serve it.
`machines` on the caller passes both through, so an agent sees, for example, that the Mac lets
it drive simulators but not its screen. A machine where every capability is off for this device
answers `machine_opted_out` and is not listed.

Callers from before this ADR read `tools` strictly and send no ceiling. A target lists only
`agents` and `browser` to a caller that sends no ceiling, so those callers don't drop the
machine. Newer callers skip groups they don't know.

### Who a remote agent is on the target

A remote agent is identified on the target by the calling device, calling host, calling thread
and calling agent:

- The **guest session** (below) is keyed by device, host and thread, so two threads on the
  Linux box get two sessions, and the same thread calling from two machines does too.
- Within a session, each calling agent has its own **owner**: `agentOwner(sessionThread,
"remote:" + callingAgentId)`, the same shape as a local agent's device owner. Device leases
  (`packages/devices`) are held by that owner. Two remote agents never share a device lease,
  and one remote agent keeps its lease across calls. Computer use has no per-app agent lease:
  each calling agent gets a separate tool registry and outline baseline, and its own agent id
  is passed to Locked Use. Browser tools currently use the guest session's root agent. Agents
  on different machines, or in different threads, drive different simulators in parallel.
- A device id from one paired device can't name another device's sessions: every op on a
  session checks that the session belongs to the calling device.

### Guest sessions: remote work without a provider

Remote tool use (browser now; devices, screen and commands in stage 2) runs in a **guest
session** on the target. One exists per (calling device, calling host, calling thread).

- It is an ordinary engine thread in its own hidden chat project (ADR 0099), created directly by
  the engine without a provider adapter. It never runs a provider, so a machine with no CLI
  installed or signed in serves remote tools. Its recorded provider is a placeholder (the first
  installed one, else `claude`); nothing launches it. `ThreadDetails.guest` marks it, with the
  calling machine's name and host id. The engine refuses every command that would start or
  carry on a turn there (a send from the person or a local agent, a resume, a queue resume):
  "This thread holds work from <machine>; it has no agent here."
- **Visible and attributable.** It is titled "<calling machine> · <calling thread title>", for
  example "Linux box · Fix the login flow", and shows in the target's task list like any thread.
  It is recorded in `machine_threads` with kind `guest` and the calling device, host and thread.
- **Never done while work runs.** Each call in flight holds a stoppable background row in the
  session (`ace-guest:<id>`, titled with the tool, such as "browser_open from Linux box"). While
  any is running the thread reads as waiting on background work, never done. A daemon restart
  ends rows left running, since their work ended with the process.
- **Cancellable.** Stopping the row, or the thread, or deleting the thread, aborts that call. The
  calling agent gets an error saying the person stopped it. A Stop or a lowered grant that lands
  while a call is still starting (admitted, not yet running) wins: the call reads a ticket before
  its grant is checked and is refused if either came after it. Stopping a row with no call
  behind it ends the row. A call that finishes after its session was deleted still returns its
  own result to the caller.
- **Approvals.** Requests that wait for the person, such as `browser_request_help`, open in
  the guest session, so they show on the target. The calling machine polls the session's
  `status` and mirrors them into the originating thread's composer strip, as browser does
  today (ADR 0078). Answering on either machine resolves both. Agents never answer them. An
  answer from the calling machine needs the capability whose tool raised the request (the
  browser's for a browser request, and so on); a request no capability raised can't be answered
  from there. `browser_request_help` is registered on the target and routes through the real
  BrowserHelp service. Browser help and generic `ask` requests record their raising tool;
  `ask` belongs to no guest capability and cannot be answered through a capability grant.
  Mirrored requests preserve their original attribution; child-lost requests belong to delegated
  provider threads, not guest sessions. Browser navigation and evaluation follow the provider's
  permissions and do not open host approvals of their own.

### Human takeover beats remote agents

A person driving a simulator, screen or browser tab on the target always wins. The devices
service already lets a `human` lease override any agent's. Remote agents hold ordinary agent
leases, so a takeover suspends them exactly as it does local agents. Their next call gets the
lease's "the person is using it" refusal, never a silent retry. Computer use keeps its
blocked-app rules, local enabled switch and Locked Use gate. The background computer engine does not acquire a device lease or open
a per-app approval. Legacy screen capture uses its existing screen-session consent rules.
Secure-input failures are tool refusals, not engine interactions. Remote guest sessions have
no provider turn, so they cannot borrow the root agent's approved turn for Locked Use.

### Kill switch

Turning a capability down for a machine (or lowering `remote.agentAccess`, or revoking the
device). Going to read stops only acting calls; going to off stops all of them:

1. refuses the next call;
2. aborts every in-flight call of that machine and capability at its next step: the call's
   signal fires, the background row ends as stopped, and the calling agent hears why;
3. ends background command jobs that need more than the new level, with every process they
   started, and releases the device leases and screen sessions that machine's remote agents
   hold, even when none of their calls is running. Lowering `remote.agentAccess` to read
   covers every linked machine: read means nothing from another machine acts here, so every
   job ends and every remote lease is released.

Deleting a guest session (or the person's Stop on it) does the same for that session alone:
its calls stop, its jobs end with their whole process tree and its leases are released.

### Bounded results

- Results are MCP content, text and images (`MachineToolResult`), at most 16 parts. A reply is
  at most 8 MB on the wire; screenshots go as images, never as files to fetch.
- Every op has a time bound: describe 4 s, the session 15 s, browser and devices at most their
  tool's own timeout less 5 s of slack (sim_start about 250 s for a cold boot, sim_act's
  installs about 10 minutes, the rest 120 s). Commands carry their own timeout: a foreground
  run at most 10 minutes (default 2), returning the last 64 KB of each stream; a background job
  at most 24 hours, keeping the last 1 MB of each stream to page through. Calls that only start,
  read or stop a job take at most 25 s.
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

Agents call `command_run`, `command_status`, `command_output` and `command_stop`. They always
take `machine`: a local agent uses its provider's own shell. The calling machine refuses them
from a read-only thread before sending.

- **Where.** `project` names a project here (by id or name; default its only one). `cwd` is
  relative to its root, or an absolute path inside it or one of the worktrees ace made for it.
  `..` escapes and links resolving outside are refused.
- **How.** The command line runs with the account's login shell as the terminal picks it
  (`$SHELL -l -c`; PowerShell, else `cmd.exe`, on Windows), in its own process tree, with no
  input. Its environment is the daemon's, which a local agent's shell also inherits, minus every
  `ACE_*` variable, plus up to 32 `env` additions (never `ACE_*`).
- **Bounds.** A foreground run waits `timeoutSeconds` (default 120, at most 600) and returns its
  exit code with the last 64 KB of stdout and stderr, noting what was dropped. At the timeout
  the whole tree is stopped. `background: true` returns a job id at once. A job keeps the last
  1 MB of each stream for `command_output` pages and runs until it ends, its timeout (default and
  at most 24 hours) or `command_stop`. A calling thread runs at most 8 jobs at once.
- **Ownership.** A job belongs to the calling thread's guest session. It holds a background row
  there, so the session never reads done while it runs. Stopping the row or the session,
  turning Commands down, closing the machine or revoking the device ends its whole tree.
- **Record.** Each command is a shell call in the session's transcript (command line, folder,
  exit code) and a log line with the device, calling machine and thread, folder, command, exit
  code and duration.

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
- Releasing device leases and computer outline baselines on session end and revocation,
  including idle sessions, Stop and deletion.
- Audit view in Settings › Fleet.
- Built for `devices`: the target runs its own sim_* tools as the guest owner; leases are
  released on the session's end hook and on every revocation, even with no call running; a
  busy device names the machine holding it; device rows name a remote holder by its guest
  session's title. The calling machine offers sim_* tools while a linked machine lends its
  devices, even with its own devices off.

## Verification

Two real daemons paired over TLS, as in ADR 0078's tests:

- grants refuse and allow per capability per calling device;
- lowering a grant applies to the next call;
- a target with no provider installed serves a browser call through a guest session;
- `machines` lists only granted capabilities.

### Computer-use risk table

| Tool                           | Read only                                                | Read and act                        |
| ------------------------------ | -------------------------------------------------------- | ----------------------------------- |
| `screen_apps`                  | Lists apps                                               | Lists apps                          |
| `screen_state`                 | Freshly resolves; refuses stopped apps without launching | May launch the app                  |
| `screen_act` and unknown tools | Refused                                                  | Subject to local computer-use rules |

The calling daemon offers routed screen tools when a linked machine serves screen even if
its own computer engine is absent or disabled. A routed call never enables local computer use.
