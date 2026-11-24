# 0228: Share Spade bots through local template drafts

Status: Accepted. Date: 2026-11-24. Extends [ADR 0168](0168-ace-marketplace.md) and [ADR 0174](0174-market-publishers-discovery-and-scanning.md).

## Context

The recipe export copies a bot's task and schedules. A shareable template needs a place to review generalized instructions and inspect the exact package before it leaves the machine.

## Decision

1. **Draft locally.** `template_draft` is a `write_local` tool. The bot reviews its knowledge and goal episodes and distils them into separately removable playbooks and lessons. The v3 package carries rewritten memory and task, personality, face and accent, model capability classes, skill references or bundled files, and connector and plugin needs. Plugin commands are names in the review. Portable surfaces and contracts can be kept or generalized. Routines and heartbeat are suggestions and start only with the recipient's consent. The draft lives in Spade and its card replays with the conversation. The card summarizes its contents.
2. **Check privacy twice.** Spade reuses its package secret checks and compares proposed text with current private notes and knowledge, including overlapping phrases. Drafting and publishing each require a successful daemon privacy check with the signed-in person's name and email. The final check covers edited text and retained files, including bundled skills. The review sheet requires a tick for each item of bot-written text and each bundled file, shows the complete contents, and clears the relevant tick when an item changes. The package carries no history, private memory records, grants, custom connector identities or configured model ID. Both passes cover every page, declaration and file. Local skills whose files cannot be safely inspected stay behind as a unit. Recognizing personal context still requires the person's review.
3. **The person publishes the reviewed bytes.** The daemon checks person standing and stamps the draft revision, edits and destination for Spade. After the final scan, Spade records a durable attempt bound to the source, revision, publisher, content hash and destination. The app's signed-in session mints a single-use person grant (ADR 0190) naming that exact Store draft, publisher, template, version, hash and visibility. The Store requires it on the draft publish route and rejects direct uploads in the reserved template namespace. Other packages keep their existing publish flows. The Store scans, reviews and signs the package as usual.
4. **Share links as unlisted Store entries.** Both destinations send explicit visibility. The Store enforces it when writing the version and on retries. A publisher can hide a listed template from discovery. Listing a template requires a new review card. The daemon checks the returned hash and visibility and reads the publisher's stored listing before recording a receipt. Retries after a restart reconcile against that listing before uploading again. Deleting the source bot cancels the local attempt and rejects later receipts. A request already sent to the Store can still complete there. A direct entry read can resolve a signed version absent from the index without adding it to search. The recipient installs through the same package review as any Store bot.

An export file or separate sharing service would require its own trust and install workflow. Using the Store keeps signing and install review in one place. A link grants access to the package, so recipients can pass it on.

## Tests

The focused tests cover privacy refusals in lessons, installation of distilled knowledge, paused heartbeat, stamp verification and replay, restart recovery, Store grant enforcement, both publish destinations, and the per-item review in chat. Set `SPADE_TEST_DAEMON_STAMPS=1` in the Rust integration test to send stamps through the daemon’s production HTTP client.
