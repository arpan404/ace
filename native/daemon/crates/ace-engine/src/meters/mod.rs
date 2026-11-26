// SPDX-License-Identifier: Apache-2.0
//! E5.6's meters: the context occupancy sample each agent keeps (`context-meter.ts`,
//! `context-sample.ts`) and the unresponsive threshold every thread runs under (`silence.ts`).
//!
//! Moved cases: `context-meter.process.test.ts`, `provider-context-meter.process.test.ts` and
//! `silence.test.ts`; each Rust case names its TypeScript case in `tests.rs`.

pub mod context;
pub mod silence;

#[cfg(test)]
mod tests;

pub use context::{
    ContextChange, ContextMeter, ContextSample, ContextSource, Meters, fold_context,
};
pub use silence::{
    DEFAULT_SILENCE_MS, SilenceResolver, SilenceScope, SilenceThresholds, parse_silence_ms,
    unresponsive_after_ms, valid_silence_ms,
};
