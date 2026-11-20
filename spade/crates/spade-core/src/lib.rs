//! Spade's pure logic: no I/O, no clocks, no randomness. Everything here is decided from its
//! inputs, so it is tested directly.

pub mod activity;
pub mod autonomy;
pub mod brain;
pub mod checkpoint;
pub mod compaction;
pub mod context;
pub mod decision;
pub mod digest;
pub mod effect;
pub mod escalation;
pub mod event;
pub mod face;
pub mod gate;
pub mod goal;
pub mod grant;
pub mod group;
pub mod helper;
pub mod hooks;
pub mod knowledge;
pub mod maintenance;
pub mod memory;
pub mod outward;
pub mod oversight;
pub mod personality;
pub mod provenance;
pub mod question;
pub mod redact;
pub mod research;
pub mod review;
pub mod routine;
pub mod routing;
pub mod service;
pub mod skills;
pub mod spending;
pub mod task;
pub mod title;
pub mod tools;
pub mod transcript;
pub mod tree;
pub mod turn;
pub mod wake;

pub use event::{Event, FailureKind, ReplyEnd};
pub use transcript::{Message, Outcome, Speaker, Transcript, TurnState};
