//! A package's WebAssembly components, run (ADR 0203 §3, §4). `spade-wasm` is a worker process
//! started per bot that has code, inside that bot's OS sandbox, with no network and no folder but
//! its own. It talks to Spade over a pipe of framed, length-bounded messages and holds no authority
//! of its own: every `tools`, `http` and `kv` call a component makes is asked of Spade, which
//! decides after its gate.
//!
//! - [`serve`] is the worker: Wasmtime with epoch interruption, fuel and memory limits per call.
//! - [`client`] is Spade's end of the pipe; [`bot`] is one bot's code: respawn, four calls at
//!   once, Stop and Pause.
//! - [`launch`] starts the worker inside the bot's sandbox.
//! - [`protocol`] and [`frame`] are what crosses the pipe.

pub mod bot;
pub mod client;
pub mod engine;
pub mod frame;
pub mod host;
pub mod launch;
pub mod protocol;
pub mod serve;

pub use bot::BotCode;
pub use client::{Event, Outcome, Running, Worker};
pub use protocol::{Answer, Cut, HostRequest, HostValue, Stats, Target};
