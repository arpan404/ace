//! Spade's security boundaries (ADR 0167): the OS sandbox each bot's commands run in, the
//! credential deny-list every sandbox holds, and the local egress proxy that carries every
//! connection a sandboxed run makes. Platform branches for the sandbox live here and nowhere
//! else in Spade.

pub mod credentials;
pub mod egress;
pub mod linux;
pub mod policy;
pub mod runner;
pub mod seatbelt;
pub mod windows;

pub use policy::{Facts, Policy};
pub use runner::{Coverage, Launch, Mechanism, Runner, Status, Unavailable};
