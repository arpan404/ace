# 0119: Spade keeps endpoint API keys in the OS keychain

Status: accepted. Date: 2026-11-10. Owner decision of 2026-11-10. Narrowly amends
[ADR 0002](0002-local-cli-providers.md), which says ace never collects or stores provider
credentials. Extended by [ADR 0214](0214-spade-provider-accounts-and-openai-sign-in.md) to the
OAuth tokens of ChatGPT accounts Spade signs in to itself, kept the same way. Amended
2026-11-22 (amendment 1, owner decision): Spade reads each secret once per process and owns its
macOS keychain entries.

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
- **Spade owns its entries (macOS).** Every entry Spade writes is created with an explicit access
  list (`SecAccessCreate` with a `SecTrustedApplication` for the running code) trusting Spade by
  its designated requirement. For the release binary that is `identifier "spade"` plus ace's
  Developer ID team (5J88TLUP2J), not one binary's hash, so every properly signed Spade, updates
  included, reads it silently; the item's partition list is the creator's team, which updates
  share. Entries carry a fixed comment as Spade's mark. An entry without it (written before
  this, or by a local build) is filed again with the new access list once, after this process
  first reads it: off the startup path, in the background, at most once per entry per process,
  only under this Spade's own service, and never over a secret Spade changed meanwhile. The
  thin Security-framework shell is the `spade-keychain-macos` crate; the decisions sit behind
  `spade_keys::Owner`, so tests use a fake. If writing with the access list fails, Spade falls
  back to a plain write, so the key is never lost.
- **Why not the data-protection keychain.** `kSecUseDataProtectionKeychain` items are scoped by
  keychain access group, which needs the `keychain-access-groups` (or
  `com.apple.application-identifier`) entitlement. Both are restricted: a Developer ID binary
  can carry them only with an embedded provisioning profile, which a command-line binary can
  hold only once it is wrapped in an app-like bundle, and AMFI refuses to launch a binary whose restricted
  entitlements aren't backed by one. Moving Spade into a bundle with a profile is a larger
  release change for no gain over an access list that already trusts the team, so Spade stays on
  the login keychain.
- **Dev and live never share entries.** Only the release-signed Spade (it satisfies the release
  requirement above; off macOS, any build) running on the live home (`<user home>/.ace/spade`)
  files under `dev.acehq.spade`. Any other build or home files under `dev.acehq.spade.dev.<home slot>` (the first 16 hex of the SHA-256 of its data folder's resolved path), so a
  dev Spade never reads, prompts for, or overwrites the live one's items, and no two homes share
  an entry (issue #2651). A home other than the live one therefore starts without keys; add them
  again in its settings.
- **Windows and Linux** change only by the in-memory reads and the per-home service split: their
  stores tie an entry to the signed-in user, not to a binary, and don't prompt per binary.
- **Testing.** Tests never touch a real keychain; the macOS shell has one ignored test run by
  hand (`cargo test -p spade-keys --test keys -- --ignored`).
