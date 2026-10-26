//! `ace-screen-helper-windows --computer`: the agent computer-use engine (ADR 0087). It speaks
//! the same JSON-lines wire as the macOS and Linux engines (`hello`, `apps`, `resolve`, `state`,
//! `act`, `cancel`), so the daemon's `ComputerClient` drives it unchanged. Semantics come from
//! UI Automation, which works on windows in the background; synthesized input is the fallback
//! and only ever reaches a window that is already in front.
pub mod borrow_file;
pub mod cancel;
pub mod catalog;
pub mod conditions;
pub mod error;
pub mod geometry;
pub mod ids;
pub mod image;
pub mod keys;
pub mod known;
pub mod launchable;
pub mod markdown;
pub mod outline;
pub mod text_match;
pub mod timing;
pub mod wire;

#[cfg(windows)]
mod act;
#[cfg(windows)]
mod act_text;
#[cfg(windows)]
mod act_value;
#[cfg(windows)]
mod act_window;
#[cfg(windows)]
mod apps;
#[cfg(windows)]
mod capture;
#[cfg(windows)]
mod clipboard;
#[cfg(windows)]
mod desktop;
#[cfg(windows)]
mod input;
#[cfg(windows)]
mod menus;
#[cfg(windows)]
mod messages;
#[cfg(windows)]
mod observe;
#[cfg(windows)]
mod run;
#[cfg(windows)]
mod service;
#[cfg(windows)]
mod session;
#[cfg(windows)]
mod settle;
#[cfg(windows)]
mod shell;
#[cfg(windows)]
mod uia;
#[cfg(windows)]
mod walk;

#[cfg(windows)]
pub use run::run;
