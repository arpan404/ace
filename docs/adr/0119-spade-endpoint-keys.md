# 0119: Spade keeps endpoint API keys in the OS keychain

Status: accepted. Date: 2026-11-10. Owner decision of 2026-11-10. Narrowly amends
[ADR 0002](0002-local-cli-providers.md), which says ace never collects or stores provider
credentials. Extended by [ADR 0214](0214-spade-provider-accounts-and-openai-sign-in.md) to the
OAuth tokens of ChatGPT accounts Spade signs in to itself, kept the same way. Amended
2026-11-22 (amendment 1, owner decision): Spade reads each secret once per process and owns its
macOS keychain entries. Amended 2026-11-23 (amendment 2): an authenticated gateway's token is a
second keychain entry, never a stored header.

## Context

Spade, ace's assistant (`spade/`), calls models through endpoints the person adds: any server that
speaks OpenAI Chat Completions, OpenAI Responses or Anthropic Messages, from OpenAI and Anthropic
to OpenCode Go, Moonshot or a local Ollama. Each needs the person's own API key. Spade's settings
in the ace apps are where people add endpoints, so keys cannot stay environment-only, and a key
typed into an app has to be stored somewhere.

ADR 0002 was written about coding providers reached through their CLIs, where the CLI owns the
login. That rule stays: subscription logins (Codex, Claude Code, OpenCode and the others) are
still reached only through the person's own logged-in CLI, and Spade never reads their tokens.

## Decision

- **Where.** A Spade endpoint key is stored in the operating system's credential store: the
  Keychain on macOS, Credential Manager on Windows, and the Secret Service (GNOME Keyring,
  KWallet) on Linux. Service `dev.acehq.spade`, account `endpoint:<endpoint id>`. Spade uses
  `keyring-core` with each platform's store, held as a value and passed in, never a global.
- **Never anywhere else.** A key is never written to SQLite, the event log, logs, traces, crash
  reports, settings files, sync, the relay or the account backend. It is read from the keychain
  the first time a call needs it and then kept in Spade's memory for the life of the process
  (amendment 1). No API returns a key: clients see only whether one is set.
- **How it gets there.** The person types the key into Spade's settings in an ace app. It travels
  once over Spade's local API (loopback, with the token in Spade's data folder) or the
  end-to-end encrypted ace connection, and Spade writes it to the keychain at once. Removing an
  endpoint deletes its key.
- **Environment still works.** An endpoint may name an environment variable (`key.env` in
  `config/models.json`). Spade reads the keychain first, then that variable. This is how a
  headless machine (a VPS or a home server with no keychain session) runs Spade.
- **No plain-text fallback.** When no credential store is available (a Linux box without a Secret
  Service), Spade says so and asks for the environment variable instead. It never writes a key to
  a file.
- **Tests never touch a real keychain.** Tests use `keyring-core`'s in-memory mock store. A real
  keychain check exists only as an ignored test, run by hand.

## Consequences

- People can add any endpoint in the app without editing files or shell profiles.
- On macOS, a binary the entry's access list doesn't trust gets a keychain prompt. Amendment 1
  makes every entry trust Spade by its code signature, so release updates keep access; a local
  build signed with a stable identity keeps access across rebuilds (`spade/docs/dev-signing.md`).
- A Linux desktop needs a running Secret Service, as Chromium and the ace desktop app already
  expect; headless machines use environment variables.
- ADR 0002's rule for CLI logins is unchanged.

## Amendment 1 (2026-11-22): read once, own the entries, keep dev apart

Owner decision: "our spade rust server must own it in keychain so we don't have to ask again and
again for permission". Three causes of repeated macOS prompts are closed.

- **Read once per process.** Each secret (endpoint key, connector secret, ace grant, sign-in
  sealing key, audit key) is read from the credential store once, then kept in the process's
  memory (`spade-keys`, wiped on drop) until Spade's own API replaces or deletes it; a read that
  was out while Spade changed the same entry is dropped. Before this, every model call read the
  keychain, so a binary the entry didn't trust was asked on every call. Missing entries are not
  remembered: looking one up never prompts, and a key another tool added is still found. Memory
  is still never written anywhere else, and never logged. A key changed outside Spade (in
  Keychain Access, say) takes effect when Spade restarts.
- **Spade owns its entries (macOS).** Every entry Spade creates gets an explicit access list
  (`SecAccessCreate` with a `SecTrustedApplication` for the running code) trusting Spade by its
  designated requirement. For the release binary that is `identifier "spade"` plus ace's
  Developer ID team (5J88TLUP2J), not one binary's hash, so every properly signed Spade, updates
  included, reads it silently; the item's partition list is the creator's team, which updates
  share. Entries carry a fixed comment as Spade's mark. The thin Security-framework shell is the
  `spade-keychain-macos` crate; the decisions sit behind `spade_keys::Owner`, so tests use a
  fake.
- **Entries from before are left as they are.** Spade never deletes an entry to file it again,
  and never changes an existing entry's access list. Changing one in place needs its owner's
  consent, and deleting then re-adding can lose the secret (an exit or a failed add between the
  two), so the safe choice is to keep it: setting a new key for such an entry updates its secret
  in place, under its old access list. Entries the release Spade made before this already trust
  the release's designated requirement (the system's default access list names the creating
  program the same way), so they stay silent across updates; one made by an ad-hoc dev build
  asks once, and "Always Allow" adds the release to it for good. If creating an entry with the
  access list fails, Spade falls back to a plain write, so the key is never lost.
- **The identifier is reserved for releases.** Anything signed with ace's Developer ID as `spade`
  satisfies the release requirement and counts as the release, so only the release pipeline signs
  that way. The requirement lives in one file (`spade/crates/spade-keys/release-requirement.txt`);
  `spade/scripts/check-release-identity.sh <new spade> <earlier spade>…` checks that a new
  release satisfies it and every earlier release's designated requirement before it ships.
- **Why not the data-protection keychain.** `kSecUseDataProtectionKeychain` items are scoped by
  keychain access group, which needs the `keychain-access-groups` (or
  `com.apple.application-identifier`) entitlement. Both are restricted: a Developer ID binary
  can carry them only with an embedded provisioning profile, which a command-line binary can
  hold only once it is wrapped in an app-like bundle, and AMFI refuses to launch a binary whose restricted
  entitlements aren't backed by one. Moving Spade into a bundle with a profile is a larger
  release change for no gain over an access list that already trusts the team, so Spade stays on
  the login keychain.
- **Dev and live never share entries.** Only the release-signed Spade (it satisfies the release
  requirement above; off macOS, any build) running on the live home (`<account home>/.ace/spade`)
  files under `dev.acehq.spade`. Any other home files under `dev.acehq.spade.dev.<home slot>`
  (the first 16 hex of the SHA-256 of its data folder's resolved path), so no two homes share an
  entry (issue #2651). A home other than the live one therefore starts without keys; add them
  again in its settings. The account home comes from the account database (`getpwuid`), not
  `HOME`, so a caller can't make another folder look live (Windows reads `USERPROFILE`: any build
  counts as the release there, so nothing rides on it).
- **A dev build never opens the live home.** A build other than the release, pointed at the live
  data folder, is refused before the folder is opened, with an error naming a folder to use
  instead. It would otherwise file under another service, so the live endpoints would look
  keyless, the guard against moving a keyed endpoint to a new host would let one through, and the
  release Spade would later send the live key there.
- **Windows and Linux** change only by the in-memory reads and the per-home service split: their
  stores tie an entry to the signed-in user, not to a binary, and don't prompt per binary.
- **Testing.** Tests never touch a real keychain; the macOS shell has one ignored test run by
  hand (`cargo test -p spade-keys --test keys -- --ignored`).

## Amendment 2 (2026-11-23): a gateway's token is a second entry, never a header

An endpoint behind an authenticated Cloudflare AI Gateway needs two secrets: the provider's key,
which travels as `Authorization`, and the gateway's own token, which travels as
`cf-aig-authorization`. Spade kept one key per endpoint, so a person who typed the gateway token
under extra headers had it stored as ordinary endpoint config. The same rule now covers both.

- **Where.** The token is stored in the same credential store as the key, account
  `gateway:<endpoint id>`, beside `endpoint:<endpoint id>`. The same read-once, own-the-entry rules
  (amendment 1) apply to it.
- **Never a header.** `cf-aig-authorization` is a credential header: setting it as an extra header
  or as the session header is refused with an error naming `PUT /v1/keys/{endpoint}/gateway`. What
  a client sets the token with is `PUT /v1/keys/{endpoint}/gateway` (`{"token": "..."}`); `DELETE`
  on that path forgets it. The endpoint keeps only whether a token is there, so no API answer or
  database row ever holds it.
- **Every call carries it.** Calls, model lists and media calls on that endpoint send
  `cf-aig-authorization: Bearer <token>` beside the endpoint's key, and scrub the token from
  anything an endpoint or error says, as with the key. A stored token blocks a base URL change to
  another origin, and deleting the endpoint deletes the token.
