// SPDX-License-Identifier: Apache-2.0
//! Translators: pure, synchronous frame-to-fact folds. A translator never
//! fails on provider data: a failed decode is a `malformed` diagnostic plus a
//! `signal` fact, as the TypeScript does.

use ace_core::RawFact;

use crate::frame::Frame;

/// A provider's translator: frames in, facts out, never an error.
pub trait Translator {
    /// Native debug evidence kept outside the transcript. Drain after each translation.
    fn take_diagnostics(&mut self) -> Vec<String>;
    /// Combine with the core's next deadline.
    fn next_deadline(&self) -> Option<i64>;
    /// Pure and synchronous. Never fails on provider data.
    fn translate(&mut self, frame: &Frame, now_ms: i64) -> Vec<RawFact>;
    /// Facts implied by time passing, including grace windows and wake expiry.
    fn tick(&mut self, now_ms: i64) -> Vec<RawFact>;
}
