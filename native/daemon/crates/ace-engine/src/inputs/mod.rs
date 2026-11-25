// SPDX-License-Identifier: Apache-2.0
//! The input journal, its signatures and the transcript's input bindings (E5.4b): what an
//! accepted command's text and origin are, how a provider echo is matched to the input ace sent,
//! which run an input joins, and what a live ace wait marks. What becomes of an accepted input
//! (4a) lives beside them in `fate`.
//!
//! The modules are pure or statement-only; the fold's calls into them go through E5.3's
//! `InputFacts` trait, in `queue::fold_hooks`.

pub mod ace;
pub mod ace_waits;
pub mod binding;
pub mod fate;
pub mod journal;
pub mod origin;
pub mod posts;
pub mod provisional_title;
pub mod removal;
pub mod runs;
pub mod signature;
pub mod title;
pub mod transcript;
