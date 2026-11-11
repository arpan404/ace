//! Spade's pure logic: no I/O, no clocks, no randomness. Everything here is decided from its
//! inputs, so it is tested directly.

pub mod checkpoint;
pub mod event;
pub mod prompt;
pub mod spending;
pub mod title;
pub mod transcript;

pub use event::{Event, ReplyEnd};
pub use transcript::{Message, Outcome, Speaker, Transcript};
