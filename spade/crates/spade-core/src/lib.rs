//! Spade's pure logic: no I/O, no clocks, no randomness. Everything here is decided from its
//! inputs, so it is tested directly.

pub mod brain;
pub mod checkpoint;
pub mod compaction;
pub mod context;
pub mod event;
pub mod gate;
pub mod maintenance;
pub mod memory;
pub mod routine;
pub mod skills;
pub mod spending;
pub mod title;
pub mod tools;
pub mod transcript;
pub mod turn;

pub use event::{Event, ReplyEnd};
pub use transcript::{Message, Outcome, Speaker, Transcript, TurnState};
