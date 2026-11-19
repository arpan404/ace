# 0192: Transfers reach the other machine by every route parcels use

Status: accepted. Date: 2026-11-18. Amends [ADR 0101](0101-work-on-another-machine.md) and
[ADR 0182](0182-agents-send-data-to-each-other.md). Groundwork for continuing work on a server
when the Mac's lid closes ([ADR 0191](0191-continue-a-working-thread-on-another-machine.md)).

## Context

"Open on" and "Continue on" (ADR 0101) send a project or a thread only to the pinned TLS address
the machines were linked on. A machine linked through a relay only was refused. Parcels (ADR 0182)
already reach a machine by its linked address, its other LAN and Tailscale addresses under the
same pinned key, the person's own relay, then ace's hosted relay. A Mac that moves its work to a
server must reach it from any network, often through a relay only.

## Decision

**One route module.** The route list, the order and the five-minute preference for the route that
answered live in `apps/daemon/src/machines/link-routes.ts` (pure) and `machines/machine-link.ts`
(`MachineLink`). `RelayLink` moves to `machines/relay-link.ts`. Parcels and transfers share one
`MachineLink`, so a route either one found is tried first by the other. Machine calls read the
same preference (`withRelayFallback` asks whether a relay answered lately), so a transfer that
reached the machine through a relay also sends the next machine call there first. That is
intended. The preference only says which way answered; it never decides what a call may send,
and each caller still moves on from a route that fails.

**Which routes are trusted.** A machine's description (`describe`, ADR 0182) only adds addresses
for a key this side already holds:

- A direct address must be under the TLS key the link pinned.
- A relay must be under the relay host key the link pinned.
- A link that pinned no key of a kind takes addresses of that kind only under the one key the
  machine announced over the pinned link: a relay-only link for direct addresses, a link made on
  the address only for relays. An honest machine has one TLS key and one relay host key
  (`machinePaths`). A description that names two keys of a kind adds no address of that kind.
- A Tailscale name (`*.ts.net`) the machine announces is never tried. A publicly trusted
  certificate for such a name passes the pin check without the key (ADR 0097), so it proves
  nothing here. The linked address may still be one, as ADR 0097 allows. Announced Tailscale
  addresses are IPs, so this costs nothing in practice.
- Whether a relay is ace's hosted relay comes from this machine's settings (`hostedRelayUrl`),
  never from the label the other machine gave the path. Relay streams are kept apart by that
  classification, so a stream opened with an account grant is never reused as the person's own.

This was the same code for parcels, so they get the same rules.

Adopting the key a machine announces over its pinned link is kept on purpose. It is what lets a
machine linked on the LAN be reached through its relay later (ADR 0182,
`parcels-relay.process.test.ts`), and it is the premise of continuing on a server once the
Mac's lid closes. Only the paired machine itself can send that description, over a channel
authenticated by the key the link pinned. A machine that lies in it could just as well misuse
what it is sent directly.

**Transfers keep their own protocol.** They are never machine calls and never parcels. Their
receipts, cut-off, 20 GiB cap and authority (`operate` and `projects` on the target, read again on
every call) are unchanged. `TransferClient` and its call sites are unchanged too: only the
transport under it, `routedTransfers` (`transfers/routes.ts`), changed.

**Route order for transfers.** These are the same as for parcels:

1. the linked address,
2. the machine's other LAN, then Tailscale, addresses under the same key,
3. the relay the machines were linked through,
4. the person's own relay that the machine announced,
5. ace's hosted relay.

The route that answered in the last five minutes goes first. Only the linked address shares the
kept-open connections.

**Resending on another route.** A failure that isn't a refusal goes on to the next route. A
refusal, or a call held back because its pairing is gone, goes nowhere else. This is safe because
every transfer call is idempotent under its transfer id:

- `begin` returns the existing record for a known id. Two that race insert once, and the loser
  returns the winner's record.
- `chunk` writes only at the offset the target holds and answers that offset otherwise, so a
  chunk sent twice writes nothing twice.
- `commit` returns the record unless it is still receiving. After its awaits (reading the files,
  the identity's registration) it reads the state again and claims it only while it is still
  receiving. Nothing is awaited between that read and the claim, so a cancel that came meanwhile
  stays cancelled, and only one copy of a commit ever starts the import.
- `status` only reads.
- `cancel` returns a settled record as it is. A copy of a cancel that comes while the first is
  still undoing the transfer waits for that clean-up and answers with its result.

The sender's own retry loop already resent all of these after a lost answer. No call needed to
stay on one route.

Every route checks that the pairing is still saved before it sends. A relay send checks again
once its stream is open, along with whether the caller has given up, because opening a stream
takes time.

**On the relay.** A relay `machine` stream carries a new frame, `machine.transfer`, which takes
either one control call or one chunk piece and is answered by `machine.answer`. It shares the
stream's credit flow control, its four running slots and its 32 waiting slots with machine calls.
The receiver answers it with `answerTransfer`, the same function `/v1/transfers` uses. A chunk
travels as base64 inside the JSON frame, as parcel chunks do. The relay's binary messages are
capped at 64 KiB and its JSON messages at 16 MiB, so the 4 MiB chunk the sender paces is split
into pieces of `transferRelayPieceBytes` (1 MiB), each acknowledged by offset. A piece's base64 is
about 1.4 MB, cheap to deflate and acknowledged well inside its timeout on a slow link. The
pieces of one chunk share what is left of that chunk's timeout. The welcome on a `machine` stream
now says `machineTransfers: true`. An older daemon ends the stream on a frame it doesn't know, so
an older machine is sent no transfer frames. That relay counts as a route that can't take
transfers: the next route is tried. Only when no other route is left is the transfer refused,
with a request to update ace there.

**What each relay carries.** Over the person's own relay, everything goes. Over ace's hosted
relay, which ace pays to run for everyone, these go:

- the control calls (probe, begin, status, commit, cancel),
- a live move's final payload (`part=final`, ADR 0191), with its session files,
- the project's code, and separately the files Git ignores, each up to
  `HOSTED_RELAY_TRANSFER_BYTES` (8 MiB, in `transfers/route-policy.ts`).

8 MiB holds a small project or a bundle of a few commits. On a 400 kbit/s 3G link it takes about
three minutes. A larger upload belongs on a direct address or the person's own relay, where the
bytes cost ace nothing and move faster. A chunk past the bound is refused at once, with what to do
instead: send again when the machines reach each other directly, or link them through your own
relay. There is one exception. If a direct address answered in the last five minutes, the refusal
waits: that direct link was more likely lost briefly, and the transfer waits for it as for any
lost link.

The receiving machine enforces the same bound. Each relay registration knows its own URL, so a
`machine` stream that came through ace's hosted relay (by the receiver's own settings) refuses a
bulk chunk past the bound, whatever the sender decided. The relay itself sees only ciphertext and
can't check it.

**Relay-only links take transfers** whenever a route allows the payload.

## Rejected

- _Transfers as a machine-call op._ That would put them under the Agents capability and the
  machine-call grants. They need their own authority.
- _Bulk through ace's relay without a bound._ It costs ace for every person's moves and is slower
  than the person's own routes.
- _Sending the total size ahead so the bound applies before any byte moves._ That would change
  `outgoing.ts`, which ADR 0191 reworks. Most uploads past the bound are refused at their first
  chunk anyway, and at most 8 MiB is ever sent before a refusal.

## Follow-ups

- Once ADR 0191 merges, `TransferRelayRequest.part` takes `final`. Until then a final piece over a
  relay is refused as "not through a relay yet". The hosted-relay policy already lets it through.
- An end-to-end test through a fake hosted relay (an account grant). The bound is tested as pure
  logic and through the routed transport.

## Verification

- `machines/link-routes.test.ts`: route order and preference, keys the link didn't pin, two
  announced keys, announced `ts.net` names, and ace's relay classified by this machine's settings.
- `machines/relay-link.test.ts`: no transfer frame for an older machine, a caller that gave up, or
  a pairing removed while the stream opened; separate streams for ace's relay and the person's
  own.
- `relay-machine-host.test.ts`: a stream through ace's relay refuses bulk past the bound.
- `transfers/incoming-races.test.ts`: a cancel during a commit stays cancelled, a second cancel
  waits for the first's clean-up, and two copies of a begin both get the one transfer.
- `transfers/route-policy.test.ts`: the hosted-relay bound and splitting into pieces.
- `transfers/routes.test.ts`: falling through to a relay, refusals that stay put, a 4 MiB chunk in
  pieces, a resent chunk, a lost answer carried again on the relay with the exact bytes landing,
  moving past an older machine's relay, nothing sent once unpaired, and the hosted refusal and its
  exception for a lost direct link.
- `transfers/transfer-relay-only.process.test.ts`: two real daemons and a local relay. The link
  names no address, and a 6 MiB bundle lands intact.
