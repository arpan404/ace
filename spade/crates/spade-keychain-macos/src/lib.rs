//! The macOS Security calls behind Spade owning its keychain entries (ADR 0119 amendment 1). Each
//! call is wrapped in a safe function; `spade-keys`, which forbids `unsafe`, decides when to make
//! them. Empty on other systems.
//!
//! An item Spade creates carries an access list that trusts the running Spade by its code-signing
//! designated requirement. For the release build that requirement names Spade's identifier and
//! its Developer ID team, not one binary's hash, so every properly signed Spade, updates included,
//! reads the item without a prompt.

#[cfg(target_os = "macos")]
mod macos;

#[cfg(target_os = "macos")]
pub use macos::{Error, Item, comment, replace_owned, running_code_satisfies};
