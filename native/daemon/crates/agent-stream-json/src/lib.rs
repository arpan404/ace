// SPDX-License-Identifier: Apache-2.0
//! Drives an agent CLI that speaks the stream-json control protocol, run as a subprocess the way
//! the provider's documentation describes. It never handles credentials: the CLI signs itself in.
//! A product built on this crate for other people should have those people authenticate the CLI
//! with their own API key, as the provider's terms ask.
//!
//! The crate is sans-IO and names the protocol, not the vendor. Its caller owns the process and
//! the pipes: [`launch`] builds the argv, [`control`] builds the requests this side sends and
//! correlates their answers, [`message`] classifies each received line once, [`host`] answers the
//! requests the CLI sends, and [`user`] builds a user message line.
//!
//! A line arrives parsed exactly once ([`ace_json::parse`]); classification moves that tree and
//! never clones it, and nothing here decodes a line into a struct. Unknown messages stay whole and
//! are never an error. Nothing returns `Result` on data the CLI sent. No clock, no process, no
//! tokio. Only `ace-json` and `thiserror` are depended on.
//!
//! `publish = false` until publishing is decided (claude-session.md Q9).

pub mod control;
pub mod error;
pub mod host;
pub mod launch;
pub mod message;
pub mod user;

pub use control::{Controls, Initialize, Request};
pub use error::ControlError;
pub use launch::{Launch, SessionStart, args};
pub use message::{HostRequest, Line, MessageKind, Outcome, classify};
pub use user::user_message;

#[cfg(test)]
mod tests;
