# 0228: Share Spade bots through local template drafts

Status: Accepted. Date: 2026-11-24. Extends [ADR 0168](0168-ace-marketplace.md) and [ADR 0174](0174-market-publishers-discovery-and-scanning.md).

## Context

The recipe export copies a bot's task and schedules. A shareable template needs a place to review generalized instructions and inspect the exact package before it leaves the machine.

## Decision

1. **Draft locally.** `template_draft` is a `write_local` tool. The bot reviews its knowledge and goal episodes and distils them into separately removable playbooks and lessons. The v3 package carries rewritten memory and task, personality, face and accent, model capability classes, skill references or bundled files, and connector and plugin needs. Plugin commands are names in the review. Portable surfaces and contracts can be kept or generalized. Routines and heartbeat are suggestions and start only with the recipient's consent. The draft lives in Spade and its card replays with the conversation. The card summarizes its contents.
2. **Check privacy twice.** Spade reuses its package secret checks and checks for personal text and verbatim memory before storage. When connected, it also asks the daemon's Store privacy picker, which uses the signed-in person's identity. The daemon repeats that pass over the confirmed version before upload. The package carries no history, private memory records, grants, custom connector identities or configured model ID. Both passes cover every page, declaration and file. Local skills whose files cannot be safely inspected stay behind as a unit. Recognizing personal context still requires the person's review.
3. **The person publishes the reviewed bytes.** The daemon checks person standing and stamps the draft revision, edits and destination for Spade. It uploads only the approved package and pins its content hash through the Store's draft, scanner, review and signing flow. The card records the result and shows when the signed version becomes installable.
4. **Share links as unlisted Store entries.** Set existing unlisted visibility when the listing is created. A direct entry read can resolve a signed version absent from the index without adding it to search. The recipient installs through the same package review as any Store bot.

An export file or separate sharing service would require its own trust and install workflow. Using the Store keeps signing and install review in one place. A link grants access to the package, so recipients can pass it on.

## Tests

The focused tests cover privacy refusals in lessons, installation of distilled knowledge, paused heartbeat, stamp verification and replay, both publish destinations, and removable playbooks and lessons in chat.
