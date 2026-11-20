//! Agent packages (ADR 0200 §3): the bot recipe at version 3, a manifest that describes a bot
//! completely, read the one way Spade reads it. A version 2 recipe reads as version 3 with its
//! routines as schedule triggers. Pure: the server brings the build's version and limits.
//!
//! - [`manifest`] reads `bot.json` and refuses what a package may never carry.
//! - [`link`] is what a bot installed from a version 3 package keeps of it, and its ceiling.
//! - [`update`] plans an update or a rollback: what the package replaces, what stays because
//!   the person or the bot changed it, and what the new version asks for that starts off.

pub mod link;
pub mod manifest;
pub mod update;

pub use manifest::{Declared, Limits, Manifest, PackageTrigger, read};

#[cfg(test)]
mod tests;
#[cfg(test)]
mod update_tests;
