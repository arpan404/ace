# Signing local Spade builds

On macOS a keychain entry trusts the program that wrote it by its code-signing designated
requirement (ADR 0119 amendment 1). `cargo build` signs ad hoc, and an ad-hoc requirement is the
binary's hash, so every rebuild is a stranger to the entries the last one wrote and macOS asks
again. Sign each local build with a stable identity and the requirement stays the same.

## Do this after each build

```sh
cd spade
cargo build --release -p spade-server
scripts/sign-dev.sh                       # or: scripts/sign-dev.sh target/debug/spade
```

The script picks, in order: `$SPADE_SIGN_IDENTITY`, the first **Apple Development** identity, a
self-signed **Spade Local Dev** certificate. It signs with identifier `spade` (no hardened runtime, so Wasmtime needs no JIT entitlement) and prints the
designated requirement, which must read the same after every rebuild.

## Which identity

- **Apple Development** (recommended). Free with any Apple ID: Xcode › Settings › Accounts ›
  Manage Certificates › + › Apple Development. Its requirement names the certificate's common
  name and Apple's development intermediate, so it survives rebuilds and certificate renewals,
  and it carries the team ID, which the keychain's partition list checks.
- **Spade Local Dev** (no Apple ID). Keychain Access › Certificate Assistant › Create a
  Certificate…, name `Spade Local Dev`, identity type Self Signed Root, certificate type Code
  Signing. The access list then matches across rebuilds, but a self-signed binary has no team ID,
  so the keychain's partition list may still ask once per rebuild (not verified).
- **Not the Developer ID** unless you mean it. A Developer ID signed build satisfies the release
  requirement, so on the live home (`~/.ace/spade`) it uses the live entries
  (`dev.acehq.spade`). Any other build, or any other home, uses `dev.acehq.spade.dev.<home slot>`, one per data folder, so dev
  Spade never prompts for or overwrites the live one's keys.

## Running it

`ACE_SPADE_BIN=$PWD/target/release/spade ace spade on` registers the signed build
(`spade/docs/ace-integration.md`). Spade logs the keychain service it chose at start
(`keychain entries service=…`).
