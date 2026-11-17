# Agent data transfer: progress notes

Branch `ace/agent-data-transfer`, worktree `~/Documents/ace-agent-transfer`. ADR 0182.
Coordinated with project-identity builder (ADRs 0178/0179; owns transfers/_, projects_, machine-transfers.ts).

## Findings (2026-11-17)

- Machine calls and project transfers (ADR 0101) go only over pinned TLS (`machines/transport.ts`), LAN or Tailscale.
- No daemon->daemon relay path exists. Daemon hostId is a UUID; the relay host id is the Noise key fingerprint.
- Self-hosted relay admits anonymous clients; ace's hosted relay needs a same-account `device` grant
  (cloud `POST /v1/grants` issues any kind to a session; daemon only asks `machine` today).
- Relay host dispatches by `hello.channel` in `files-relay.ts`; relay messages must be canonical wire members.
- Callers keep no peer paths; `describe` carries none.

## Plan

1. protocol: parcels.ts (ParcelCall), MachineCall op `parcel`, MachineDescription.paths, hello channel `machine`,
   wire `machine.call`/`machine.answer`, agent-control ops data_send / data_receive.
2. daemon/parcels: pure rules, store, sender (resume/backoff/restart), target handler, outbox pull, tools.
3. relay machine channel (target) + relay transport (caller), path order direct > other direct > relay > account.
4. tests: pure rules; process tests over LAN listener and a real local relay.

## Status (2026-11-17)

- [x] protocol - [x] core - [x] relay link + host - [x] tools - [ ] ADR 0182 - [ ] PR
- tests: rules unit (16) pass; parcels-push (LAN, lost answers) pass; parcels-pull (child->parent,
  tree not done until pulled) pass; parcels-relay: push via relay pass, pull fixed by client-side
  `channel.flowControl()` (host window never refilled), rerun pending.
- Learned: queued arrival waits behind a running turn (tests finish the turn first); puller must
  include recently settled children (they reopen).

## Evidence (2026-11-17, Omarchy)

- parcels-push (LAN 127.0.0.1 listener, 1 in 4 answers lost): pass, 23 s.
- parcels-pull (child->parent, tree not done until pulled): pass, 22 s.
- parcels-relay (real self-hosted relay over wss, all direct paths down, both directions): pass, 16 s.
  Fixes found on the way: client-side `channel.flowControl()`; connect deadline no longer kills open streams.
- One-off run (not committed) with the saved link pointed at 10.0.0.59 (LAN) and 100.83.149.99
  (this machine's Tailscale address): both delivered 500 KiB intact. Same host, so not across the tailnet tunnel.

## Review fixes (independent reviewer, 10 findings), applied uncommitted on top of d1a599970

1 grant only to this machine's hosted relay origin (server.ts isHostedRelay); 2 push reopens remote child;
3 local copies recovered at start, kick takes only due pushes; 4 retry wait releases the slot (wake timer);
5 result reports give up after 20 tries, hold end separate; 6 O_NONBLOCK source open (FIFO);
7 receiving space counted by held bytes, abandoned arrivals expire after 24h, per-chunk room check;
8 saveAs makes folders one at a time with realpath checks, .git case-insensitive; 9 sweep and pull on separate
loops, pull restart cap 3, no-room pulls refused; 10 relay host slot handoff, cancel blocks re-kick, cancel checks hostId.
Pending: typecheck/lint, rerun unit + 3 process tests, full check, PR.
Known main-side failure: check:builtins stale lock for skills/ace-computer-use (main commit 9eecd03d1), not this branch.
