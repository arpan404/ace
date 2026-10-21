//! `ace-screen-helper-linux --computer`: the agent computer-use engine (ADR 0087, ADR 0091).
//! Same JSON-lines wire as the macOS helper: `hello`, `apps`, `resolve`, `state`, `act`,
//! `cancel`. Semantics come from AT-SPI; X11 adds screenshots and foreground-only raw input.
pub mod cancel;
pub mod catalog;
pub mod conditions;
pub mod desktop;
pub mod error;
pub mod identity;
pub mod ids;
pub mod image;
pub mod keys;
pub mod outline;
pub mod text_match;
pub mod wire;

#[cfg(target_os = "linux")]
mod act;
#[cfg(target_os = "linux")]
mod act_input;
#[cfg(target_os = "linux")]
mod act_text;
#[cfg(target_os = "linux")]
mod act_window;
#[cfg(target_os = "linux")]
mod apps;
#[cfg(target_os = "linux")]
mod bus;
#[cfg(target_os = "linux")]
mod capture;
#[cfg(target_os = "linux")]
mod clipboard;
#[cfg(target_os = "linux")]
mod element;
#[cfg(target_os = "linux")]
mod events;
#[cfg(target_os = "linux")]
mod observe;
#[cfg(target_os = "linux")]
mod run;
#[cfg(target_os = "linux")]
mod service;
#[cfg(target_os = "linux")]
mod session;
#[cfg(target_os = "linux")]
mod walk;
#[cfg(target_os = "linux")]
mod xdisplay;

#[cfg(target_os = "linux")]
pub use run::run;
