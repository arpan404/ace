//! `ace-screen-helper-windows --computer`: the agent computer-use engine (ADR 0087). It speaks
//! the same JSON-lines wire as the macOS and Linux engines (`hello`, `apps`, `resolve`, `state`,
//! `act`, `cancel`), so the daemon's `ComputerClient` drives it unchanged. Semantics come from
//! UI Automation, which works on windows in the background; synthesized input is the fallback
//! and only ever reaches a window that is already in front.
pub mod cancel;
pub mod catalog;
pub mod conditions;
pub mod error;
pub mod ids;
pub mod image;
pub mod keys;
pub mod markdown;
pub mod outline;
pub mod text_match;
pub mod wire;
