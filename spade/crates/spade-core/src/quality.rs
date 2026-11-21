//! Agent quality on the person's own work (ADR 0204). Pure.
//!
//! - [`case`]: one finished run kept as a test: what it was given, the steps it took and the
//!   outside answers it got as recorded, and what came of it.
//! - [`redact`]: what a case hides before it is written: secrets, the person's own addresses
//!   and names, and any value the person marks.

pub mod case;
pub mod redact;
