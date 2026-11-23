// SPDX-License-Identifier: Apache-2.0
//! The Cursor translator binding (E1): values and errors only. The fold lives
//! in `ace-adapter-cursor`; this parses the shell's frame JSON, runs one
//! frame, and returns the facts' JSON. Every export catches panics and turns
//! them into JS errors.

use ace_adapter_cursor::{
    CursorTranslator, next_deadline_json, take_diagnostics_json, tick_json, translate_json,
};
use napi_derive::napi;

/// The native Cursor translator behind `native-translator.ts`.
#[napi]
pub struct NativeCursorTranslator {
    translator: CursorTranslator,
}

#[napi]
impl NativeCursorTranslator {
    /// Mirrors the TypeScript constructor budgets (`maxIdentities`,
    /// `maxRetainedBytes`); an invalid budget throws, as it does there.
    #[napi(constructor, catch_unwind)]
    pub fn new(
        root_key: String,
        max_identities: Option<u32>,
        max_retained_bytes: Option<u32>,
    ) -> napi::Result<Self> {
        let translator = CursorTranslator::new(
            root_key,
            max_identities.unwrap_or(2048) as usize,
            max_retained_bytes.unwrap_or(2_097_152) as usize,
        )
        .map_err(napi::Error::from_reason)?;
        Ok(NativeCursorTranslator { translator })
    }

    /// Fold one frame's JSON into its facts' JSON array.
    #[napi(catch_unwind)]
    pub fn translate(&mut self, frame_json: String, now_ms: f64) -> napi::Result<String> {
        Ok(translate_json(
            &mut self.translator,
            &frame_json,
            now_ms as i64,
        ))
    }

    /// Facts implied by time passing, as JSON. The translator sets none.
    #[napi(catch_unwind)]
    pub fn tick(&mut self, now_ms: f64) -> napi::Result<String> {
        Ok(tick_json(&mut self.translator, now_ms as i64))
    }

    /// Native debug evidence kept outside the transcript, as JSON.
    #[napi(catch_unwind)]
    pub fn take_diagnostics(&mut self) -> napi::Result<String> {
        Ok(take_diagnostics_json(&mut self.translator))
    }

    /// The translator sets no deadline of its own.
    #[napi(catch_unwind)]
    pub fn next_deadline(&self) -> napi::Result<String> {
        Ok(next_deadline_json())
    }
}
