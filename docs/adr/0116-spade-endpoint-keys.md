# 0116: Spade keeps endpoint API keys in the OS keychain

Status: accepted. Date: 2026-11-10. Owner decision of 2026-11-10. Narrowly amends
[ADR 0002](0002-local-cli-providers.md), which says ace never collects or stores provider
credentials.

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
  when a call needs it and dropped after. No API returns a key: clients see only whether one is
  set.
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
- On macOS, a binary signed with a different identity than the one that stored a key gets a
  keychain prompt. Release builds are signed with the same Developer ID, so updates keep access;
  local development builds may prompt.
- A Linux desktop needs a running Secret Service, as Chromium and the ace desktop app already
  expect; headless machines use environment variables.
- ADR 0002's rule for CLI logins is unchanged.
