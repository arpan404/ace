//! `spade-conform`: runs the Spade Agent Format's conformance suite (`spade/spec/conformance/`,
//! ADR 0201 §5) against an implementation, level by level, through its doors:
//!
//! - **Reader** ([`reader`]): a command answering `<cmd> read <folder>` and `<cmd> fit <file>`
//!   with JSON. Every manifest and schema case is fed to it; an accept case must be accepted and a
//!   refuse case refused with a problem naming the case's rule, never matched by words.
//! - **Runtime** ([`runtime`]): the runtime's HTTP API, in the shape Spade's `POST /v1/agents`
//!   speaks (install, switches, update and rollback, contracts), and its scenario door, a command
//!   answering `<cmd> <folder>` in the shape `spade --bot-test` speaks (the ceiling, on calls).
//! - **Surfaces** ([`surfaces`]): panels over the same HTTP API, cards through the scenario door.
//!
//! The runner knows nothing of any implementation's insides: it holds the suite's data and checks
//! what each door answers. The suite is compiled in ([`suite`]), so a build of the runner is a
//! build of the suite.

pub mod http;
pub mod reader;
pub mod report;
pub mod runtime;
pub mod suite;
pub mod surfaces;

mod folder;

pub use report::{Level, Outcome, Report};
