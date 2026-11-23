// SPDX-License-Identifier: Apache-2.0
//! The cursor adapter (ADR 0223 section 2). E0 declares the modules; E1 ports the
//! translator closure into translate, E3 the session into session.

pub mod session;
mod translate;

pub use translate::CursorTranslator;
pub use translate::json::{next_deadline_json, take_diagnostics_json, tick_json, translate_json};
