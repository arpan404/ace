// SPDX-License-Identifier: Apache-2.0
//! The forge behind `@ace/forge`'s interfaces (ADR 0224, docs/forge/behaviour.md).
//! The person's own `gh`, `glab`, `tea`, `bkt` and `origin` stay the only way
//! ace reaches a host, one process per request through `ace-supervisor`; ace
//! reads no CLI configuration, keychain or token and opens no connection.
//! F0 declares every module the work items own as a stub that defers to
//! TypeScript, so parallel builders never edit the same file; each item owns
//! its modules (docs/forge/porting-guide.md, "Files per work item") and
//! replaces the stub with the port, keeping the TypeScript's arguments,
//! order, environment, parsers and numbers.

pub mod bitbucket;
pub mod error;
pub mod github;
pub mod gitlab;
pub mod origin;
pub mod pure;
pub mod schema;
pub mod store;
pub mod tea;
pub mod transport;

#[cfg(test)]
mod tests;
