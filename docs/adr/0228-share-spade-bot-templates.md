# 0228: Share Spade bots through local template drafts

Status: Accepted. Date: 2026-11-24. Extends [ADR 0168](0168-ace-marketplace.md) and [ADR 0174](0174-market-publishers-discovery-and-scanning.md).

## Context

The recipe export copies a bot's task and schedules. A shareable template needs a place to review generalized instructions and inspect the exact package before it leaves the machine.

## Decision

1. **Draft locally.** `template_draft` is a `write_local` tool. The bot reviews its knowledge and goal episodes and distils them into separately removable playbooks and lessons. The v3 package carries rewritten memory and task, personality, face and accent, model capability classes, skill references or bundled files, and connector and plugin needs. Plugin commands are names in the review. Portable surfaces and contracts can be kept or generalized. Routines and heartbeat are suggestions and start only with the recipient's consent. The draft lives in Spade and its card replays with the conversation. The card summarizes its contents.
2. **Check privacy twice.** Spade reuses its package secret checks and compares proposed text with current private notes and knowledge, including titles, overlapping phrases, and short distinctive identifiers. Drafting and publishing each require a successful daemon privacy check with the signed-in person's name and email. The final check covers edited text and retained files, including bundled skills. Spade prepares the final checklist after edits. The sheet shows every retained field and full file. A tick acknowledges the exact item digest, and editing clears the checklist. Spade recomputes the complete set and refuses missing, stale or extra acknowledgements. The package carries no history, private memory records, grants, custom connector identities or configured model ID. Both passes cover every page, declaration and file. Local skills whose files cannot be safely inspected stay behind as a unit. Recognizing personal context still requires the person's review.
3. **The person publishes the reviewed bytes.** The daemon checks person standing and stamps the draft revision, edits and destination for Spade. After the final scan, Spade records a durable attempt bound to the source, revision, publisher, content hash and destination. The app's signed-in session mints a single-use person grant (ADR 0190) naming that exact Store draft, publisher, template, version, hash, visibility and review proof. Spade signs the package hash and the digest of the acknowledged items for that same draft and publisher. The Store checks both the proof and the grant on the draft publish route and rejects direct uploads in the reserved template namespace. Other packages keep their existing publish flows. The Store scans, reviews and signs the package as usual.
4. **Share links as unlisted Store entries.** Both destinations send explicit visibility. The Store enforces it when writing the version and on retries. A publisher can hide a listed template from discovery. Visibility changes require a fresh person grant bound to the entry and requested visibility. The daemon checks the returned hash and visibility and reads the publisher's stored listing before recording a receipt. Retries after a restart reconcile against that listing before uploading again. Deleting the source bot cancels the local attempt and rejects later receipts. A request already sent to the Store can still complete there. An unlisted bot or skill resolves by its server-generated UUIDv7, including reads of its signed version and archive. UUIDv7 has 74 random bits, which make the link unguessable. Anyone holding the link can install through the normal package review. Name, slug, search and public publisher pages do not resolve these entries. Anonymous reports for an unlisted entry take its UUIDv7 alone. Its public withdrawal record carries an ID derived from the archive digest and exact version identity, with a generic reason. Installed clients can derive that ID from their pinned package. A Library skill row can share a skill unlisted after the person reviews each complete file. The same signed-in privacy pass checks the reviewed bytes again before upload and before the person-granted publish.

An export file or separate sharing service would require its own trust and install workflow. Using the Store keeps signing and install review in one place. A link grants access to the package, so recipients can pass it on.

## Rollout

1. Apply catalogue migrations 0004 and 0005 to each catalogue.
2. Approve Spade review keys out of band. Provision a distinct, platform-protected Ed25519 seed in Spade’s OS keychain service `dev.acehq.spade`, account `ace:store-review` and pin the corresponding lowercase hexadecimal public key under the Store publisher ID in the Worker’s `SPADE_REVIEW_PUBLIC_KEYS` JSON map. The map’s values are arrays to allow rotation. Publish refuses missing or untrusted keys. The Store takes no public key from the caller.
3. Deploy the Worker while it still serves the current signed withdrawal list. If the Store has no list yet, publish a signed empty list before rolling out the updated daemon.
4. Ship the matching app, daemon, Spade and signer. Update devices to recognize opaque withdrawals before replacing the legacy list. Store install confirmation, including rollback, requires a fresh, valid withdrawal response. A failed refresh leaves the review open for retry.
5. Run the updated signer to replace legacy named withdrawals for entries now unlisted. The signer signs the replacement first, then swaps it for the legacy list in one conditional write. The endpoint continues serving the legacy list until that write succeeds.
6. Share skill updates through the Library review at a strictly higher version. CLI drafts can stage the archive, but uploading directly to a link-only listing cannot publish it.

## Tests

The focused tests cover privacy refusals in lessons, installation of distilled knowledge, paused heartbeat, stamp verification and replay, restart recovery, Store grant enforcement, both publish destinations, and the per-item review in chat. The Rust integration test uses Bun to send stamps through the daemon’s production HTTP client.

## Required presence for publishing

The desktop signer and account device registry are pending. Until they ship, the provisioned
Spade key described above provides review integrity but gives the Store no proof of OS-backed
presence.

The desktop signer accepts only the canonical review challenge Spade produces after validating
the final package and checklist. The challenge binds the package kind, publisher, name, version,
archive hash, visibility, draft ID and the hash of the sorted checklist digests. Spade verifies
the returned signature against an active account device key before authorizing the attempt. The
Store resolves that key independently when publishing. A missing key or unavailable registry
fails the request. An ace account person grant remains a separate gate.

Extend ADR 0190's device enrollment rather than reusing the key that signs socket statements.
A device's presence-protected review key belongs to the same account device record and has a
distinct signing purpose. The cloud enrollment extends the fresh sign-in and proof of possession
exchange. A publisher's Store credential determines which account can vouch for the device.
Removing the device revokes the review key for subsequent publishes. The Store must retire
legacy pinned seeds when it starts requiring registered device keys.

- **macOS.** Prompt from the signed desktop app in the GUI session. Use a data-protection
  keychain item with `.userPresence` and a fresh authentication context for every signature.
  Use the package name in the system reason, such as “Publish ‘Markit’ to the ace Store.”
  Keep Security framework calls in `spade-keychain-macos`. The signing host needs
  `keychain-access-groups` and an embedded provisioning profile authorizing the app's access
  group for `dev.ace.app`. The Developer ID identity's team is `5J88TLUP2J`. The checked-in
  signing configuration does not include that entitlement or profile. Verify the shipped bundle
  and the identity of the host executable that actually calls Security. A compromised entitled
  host can misuse a seed once the OS has released it.
- **Windows.** Use a Windows Hello credential to sign the challenge in the interactive desktop
  session. Register the credential's public key and algorithm. A consent result used alongside
  an ordinary exportable key would leave the key outside the Windows Hello boundary.
  Credential protection depends on the device and its Windows Hello configuration.
- **Linux.** Keep the signing key in a root-owned helper. The helper validates and holds the
  canonical challenge before asking polkit for `auth_self` with no cached authorization. It
  signs only that challenge after the desktop authentication agent returns success. The deb
  needs install and removal hooks for the helper and policy. The AppImage needs an explicit
  administrative install and removal command because its mount is temporary. The project
  currently ships no rpm. Password re-entry provides weaker assurance than hardware-backed
  presence. Root can sign, and a compromised graphical session can capture passwords or
  mislead the person about the prompt.

The gate targets unattended same-user processes, including processes with the daemon stamp
secret. It cannot establish that the person understood the review, protect an already compromised
trusted signer or OS, or stop someone who knows the device credential.

### Manual acceptance checks

Use a test account and isolated Store. On each system, sign in from the packaged desktop app
and enroll the device. In Library, open a skill's share review, acknowledge each file, and select
Publish. Cancel the first OS prompt and verify that ace refuses publishing and the draft remains
unpublished. Repeat and approve, then start a different draft and confirm that the OS asks again.
Remove the device in the account and verify that it cannot publish.

- **Mac.** Use a provisioned Developer ID build on a Touch ID Mac. Verify the package name in
  the dialog, then repeat with password fallback.
- **Windows VM.** Set up Windows Hello PIN in Settings and use the signed desktop installer.
  Verify the Windows Hello dialog. Disable Hello and confirm that publishing fails.
- **Linux or Omarchy.** Install the helper and policy as administrator, using the deb or the
  AppImage's explicit installer. Use an active session with a running polkit agent. Verify the
  password challenge on consecutive publish attempts. Remove the helper and policy and confirm
  that publishing fails.
