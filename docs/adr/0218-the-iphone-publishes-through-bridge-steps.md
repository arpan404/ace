# 0213: The iPhone publishes through bridge steps, confirming what it was shown by hash

Status: accepted. Date: 2026-11-22. Decided by: the agent building #2548 and #2554, inside
those issues' scope; open to the owner's review on the PR. Extends
[ADR 0168](0168-ace-marketplace.md) §"Publishing from the app" and
[ADR 0174](0174-market-publishers-discovery-and-scanning.md) §2 to the phone; nothing there
changes.

## Context

The web publishes by sending the daemon's `publish` actions one at a time: it checks what a
picked thing would upload, sends the person's confirmation back with the draft, reads the draft
until ace's scan is done, publishes it, then writes its listing. Each step's words are written
in React.

The phone's other market screens send one `market.native` request per screen, and the bridge
(`apps/ios/bridge`) writes every word with the shared rules in `@ace/ui-core/market`, so Swift
only draws. Publishing doesn't fit one protocol operation per screen: Next on the review makes a
draft and waits for its scan, and Submit sends three to six actions. Done from Swift, that logic
would be untested (the phone's Swift tests can't run beside the bridge's) and the confirmation,
which says which flagged text the person saw, would be built from values Swift echoes back.

## Decision

1. **One `market.publish` request per screen, as steps.** The bridge takes `me`, `pick`,
   `check`, `draft`, `submit`, `listing`, `withdraw`, `createProfile`, `profile`, `handle` and
   `avatar`, and turns each into the daemon's `publish` actions (`market-publishing.ts`). It is
   the phone's own contract, not the protocol's: `packages/protocol` is unchanged, and a daemon
   that speaks `publish` serves it. A `draft` step reads the draft until the scan is done (at
   most 40 reads, 1.5 s apart); a `submit` step publishes, then writes the listing over what the
   entry already has, then its pictures. A version published whose listing is refused stays
   published, and the answer says so.
2. **The person confirms a check by its hash, and the bridge builds the confirmation.** The
   bridge keeps the last 16 checks it showed, by hash. A `draft` step names the hash, the
   binaries the person ticked and a bot's routines kept; the bridge makes `checked` from the held
   check: every non-blocking finding's text and every non-secret span in a bot's words, never a
   text the person wasn't shown. A hash it doesn't hold (the bridge restarted) asks to look again.
3. **The phone publishes only what the picker offers.** A pick's id is its source as JSON. The
   bridge parses it again and takes only a Spade bot, a Spade skill, an ace skill or a plugin:
   never a folder path, an archive or a Suit, which stay on the computer.
4. **Refusals use the install's ways out.** Refused for standing, a step offers Confirm it's you
   (one retry), Pair again, or the computer when the market wants the person's own grant
   (withdrawals and handle changes may), through `market-person.ts`. A change whose reply is lost
   says it couldn't be confirmed; it is never called failed.
5. **Nothing here is kept for offline.** The publisher's own pages are read fresh; offline they
   say the machine is offline, and nothing is queued.

## Consequences

- The flow is tested on the fake daemon through the bridge's public answer
  (`market-publishing.test.ts`), refusals and standing included.
- The fake daemon gains `refusePublish`, as it has `refuseInstall`.
- A later phone feature that needs another `publish` action adds a step here, not a raw
  protocol operation in Swift.
