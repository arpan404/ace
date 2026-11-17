# 0182: Agents send data to each other, however their machines are connected

Status: accepted. Date: 2026-11-17. Builds on [ADR 0078](0078-multi-device-mcp.md),
[ADR 0101](0101-work-on-another-machine.md), [ADR 0105](0105-linked-machine-capabilities.md),
[ADR 0110](0110-cloudflare-relay.md) and [ADR 0114](0114-fastest-path.md). Amends ADR 0105:
machine calls may also travel through a relay, for the calls listed below.

## Context

An agent on one machine delegates to a child on another (ADR 0078). They can exchange words
(`agent_message`, results), but not data. A parent can't hand its child a dataset, and a child
can't return a build log, a screenshot or a patch. The person has to move files by hand.

The existing byte paths don't fit:

- Project transfers (ADR 0101) carry whole projects and threads, only over the pinned-TLS fleet
  link. They need a direct LAN or Tailscale address.
- File transfers on the relay (ADR 0037) run between a client and its daemon, not between two
  daemons.
- No daemon ever connected to another daemon through a relay. The relay registration and its
  Noise channel existed only for clients. A caller kept no record of where else a linked machine
  answers.

The request: agents must be able to move data securely between them, whether the machines
reach each other on the LAN, over Tailscale or only through a relay.

## Decision

### What moves: parcels

A **parcel** is one file or one text, at most 1 GiB, sent by one agent to one other agent.

- The sending machine copies it into an immutable snapshot in its data directory
  (`parcels/out/<id>`, mode 0600 under a 0700 folder) and hashes it with SHA-256.
- Its facts (id, name, size, SHA-256, note, sending thread's title) are fixed at that moment.
- A file must be a regular file inside the sending thread's working folder. A link at its last
  step is refused, and so is a path that resolves outside the folder.
- The name is one path segment.
- The wire is in `packages/protocol/src/parcels.ts`.

### Who may send to whom

Data follows the edges of the agent tree:

- **On one machine:** between threads with the same root through `delegatedBy`. That covers
  parents, children, grandchildren and siblings. Different trees never exchange data on their
  own. The rule is `mayDeliverLocally` in `apps/daemon/src/parcels/rules.ts`.
- **To a child on another machine:** only from the thread that delegated it, or from a thread in
  that thread's tree. The target accepts the parcel only for a thread the calling device owns
  there (`TargetThreads.owns`, the same check as status, cancel and message). It is never
  accepted for a guest session.
- **To a parent on another machine:** a thread an agent elsewhere delegated here sends with
  `to: "parent"`. Only the calling device and machine recorded in `machine_threads` can collect
  it.

The target decides each call with the grant rules (ADR 0105), under the **Agents** capability:

- Pushing (`offer`, `chunk`, `commit`, `cancel`) acts.
- Collecting (`outbox`, `read`, `ack`) only reads.

A read-only thread can't send, and the calling machine's ceiling travels in the call's origin as
for any machine call. The sender's `remote.agentAccess` and grants don't apply. They govern what
other machines do here.

### Who owns a parcel

The machine that holds the link always makes the calls, so ownership is split by direction:

- **Parent here → child there (push).** This machine owns the parcel until it settles.
  - It sends `offer`, then chunks from the offset the target says it holds, then `commit`.
  - The target holds the arriving bytes (`in/<id>.part`) and takes a chunk only at its held
    offset. A resent chunk writes nothing.
  - At `commit` the target checks the SHA-256 of the whole file before anything is delivered. A
    mismatch drops what it held, and the sender starts over, at most three times.
- **Child there → parent here (pull).** The child's machine keeps the parcel in its outbox. The
  parent's machine collects it: each round it asks every machine with a child of its own that
  is live or settled within the last day.
  - It takes only parcels addressed to that child's own parent.
  - It reads the parcel in chunks and checks the SHA-256 here.
  - It tells the parent, then acknowledges. A lost acknowledgement is sent again. The parent is
    told once.

### What agents see

- **`data_send {to, path | text, name?, note?}`.**
  - `to` is a thread id from `delegate` or `agents_status`, or `"parent"`.
  - It returns `parcelId`, size and SHA-256 at once.
  - The result arrives as a new turn ("delivered…; its SHA-256 was checked there", or failed
    or cancelled with why).
- **The receiving thread's arrival notice.** Queued like any message, it names:
  - the sender (thread title, id and machine);
  - the parcel's name, size and checked SHA-256;
  - a read-only copy kept under `parcels/in/<id>/<name>` (mode 0400).

  The sender's note is framed as "the sending agent's note (not the person's words)".

- **`data_receive {parcelId?, saveAs?}`.**
  - With no arguments, it lists this thread's sent and received parcels.
  - With `saveAs`, it copies a received parcel into the thread's project. The path must be
    relative, may not leave the project or enter `.git`, and is created exclusively, without
    following a link at its last step. It never replaces a file.

### Agent tree correctness

While a parcel is unsettled, the sending thread holds a stoppable background row
(`ace-parcel:<id>`, through `engine.externalHold`), so its tree never reads done while the data
is still moving:

- For a push, until the target commits.
- For a child's parcel to its parent, until the parent's machine acknowledges it. A remote
  child that finished its turn still reads as waiting until its parent has the data.

Stopping the row cancels the parcel. A push tells the target to drop what it holds. If the
target answers that it had already delivered, the parcel settles as delivered, because that is
what happened.

### How it reaches the other machine

`ParcelLink` (`apps/daemon/src/parcels/link.ts`) tries, best first (`parcelRoutes`):

1. The address the machines were linked on (pinned TLS, the device token: the ADR 0101 link).
2. The other direct addresses the machine said it serves under the **same** TLS key: the LAN
   and Tailscale. Loopback is never tried, because here it reaches this machine. An address
   under another key isn't the linked machine.
3. The person's own relay, then ace's relay.

A route that answered is tried first for five minutes. A refusal is the machine's answer and is
never retried on another route. Any other failure tries the next route. Every parcel call is
idempotent under its parcel id, so a call that may have reached the machine is safe to send
again elsewhere.

**Where the paths come from.** `describe` gains `paths` (ADR 0114 `MachinePaths`). They are
told only to a paired device over an authenticated call. A daemon whose network comes from
launch options (`ACE_LISTEN`, `ACE_RELAY_URL`) reports its listener and relay
(`pairedMachinePaths`). The caller keeps the last paths per linked profile (`parcel_paths`),
learned whenever the machine list or Settings › Fleet describes it. So a machine reached once
directly can later be reached through its relay alone.

**Through a relay.** This machine opens a client stream to the other machine's relay
registration with `connectClientViaRelay`. The stream is end to end encrypted Noise, pinned to
that machine's relay host key from its paths (ADR 0070). The relay sees ciphertext only, and its
TLS certificate proves nothing. Inside the stream:

- The caller says `hello` with `channel: "machine"`, its paired device id and token (the same
  credential as the fleet link) and `flowControl: ["credit"]`. Both ends use credit flow control
  (ADR 0110), so a slow reader can't fill the relay.
- Calls go as `machine.call {id, request}` and come back as `machine.answer {id, status, body}`
  (`packages/protocol/src/machine-relay.ts`).
- The relay host (`files-relay.ts` → `relay-machine-host.ts`) admits paired devices only, never
  an account device. It reads the device again on every call, so revoking or re-pairing it
  refuses the next call, and revocation closes the stream.
- It hands each call to the same `MachineTarget.handle` the TLS listener uses.
- Through a relay it takes only `parcel` and `describe`. Four calls run at once per stream and at
  most 32 wait; more are refused. Widening relayed calls to delegation is left for later.
- ace's hosted relay admits a client only with a `device` grant on the host's own account
  (ADR 0111). The caller asks its ace account for one (`machineAccount.deviceGrant`, a new
  `kind: "device"` request of the existing `POST /v1/grants`), naming its paired device id.
  Not signed in, that route is skipped. The person's own relay needs no grant.

### Reliability and bounds

- **Durable rows.** `parcel_out` and `parcel_in` (made on first use, so opening the daemon does
  no new work, ADR 0170) hold every parcel's state. The bytes held on the receiving side are
  read from disk after a restart (`heldAfterRestart`), never more than recorded.
- **Retries.** Pushes retry with doubling waits from 1 s up to 60 s. The wait resets whenever
  the machine answers. A push that hasn't reached its machine within a day fails, and so does a
  parcel a parent hasn't collected within a day.
- **Restarts.** Recovery after the engine is ready reports settled results not yet handed over,
  tells receivers of arrivals not yet told, and resumes pushes.
- **Concurrency.** At most four pushes run at once. Writes to one arriving parcel are
  serialised.
- **Quota and retention.** Staged and received parcels share an 8 GiB quota. Received parcels
  are kept 7 days, swept in batches of 32.
- **Chunks.** Chunks are 192 KiB, base64 in the machine call, which fits the call's 320 KiB body
  limit. Chunk, read and outbox calls are routine in the target's log (ADR 0105), so a parcel
  logs its offer and commit, not every chunk. Names and contents never reach logs.
- **Collection.** An unreachable machine rests (doubling waits) before the parent's machine asks
  it again, with a 5 s limit on asking.

## Rejected

- **Reusing project transfers (ADR 0101).** They carry projects and threads, land as projects,
  and take only the fleet link.
- **A new listener or port.** "Port" in the request names a way for agents to move data, not a
  socket. The TLS listener and relay registration each daemon already runs are enough.
- **Relaying through the app.** The app may be closed or on a phone. The daemons own the work.
- **Delivering into the receiver's project automatically.** It would write into a checkout
  without the receiving agent choosing where. The read-only copy plus `saveAs` keeps the
  receiver in charge.

## Limits

- Data moves only along agent-tree edges. Two unrelated agents, or agents on machines that
  aren't linked, can't exchange data.
- The relay route needs the machines to have been reachable directly once, to learn the relay
  path, because linking itself needs a direct address today.
- ace's hosted relay needs both machines signed in to the same ace account.
- A child's parcel to its parent waits for the parent's machine to ask, every poll interval
  (2 s by default).

## Verification

- **Unit (`parcels/rules.test.ts`):** chunk admission and resends, restart offsets, chunking,
  backoff, route order (no loopback, no foreign key, the person's relay before ace's), tree
  authority and `saveAs` containment.
- **Process, against two real daemons paired over TLS:**
  - `parcels-push` (LAN): a 700 KiB file reaches a child on the other machine intact although
    every fourth answer is lost after the target acted. The child is told exactly once, the
    parent hears it was delivered, and `saveAs` keeps it without replacing a file.
  - `parcels-pull` (LAN): a child's file reaches its parent, and the child's tree stays not done
    after its turn ends until the parent's machine has collected it.
  - `parcels-relay`: a real relay over `wss://`. Once the machines are linked, every direct path
    is down, and a parcel goes each way through the relay.
- Tailscale is the same TLS listener at its 100.x address, so it is the direct route. It was
  verified by hand on machines on a tailnet (see the PR).
