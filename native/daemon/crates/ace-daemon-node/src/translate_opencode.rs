// SPDX-License-Identifier: Apache-2.0
//! The opencode translator binding (E1). Behaviour lives in
//! `ace-adapter-opencode`; this only translates values and errors.

use std::sync::Mutex;

use ace_adapter_opencode::translate::Translator;
use napi_derive::napi;

/// A native OpenCode translator handle. Frames go in as JSON and facts come
/// out as JSON; callers batch where the shell can.
#[napi]
pub struct OpencodeTranslator {
    inner: Mutex<NativeTranslator>,
}

struct NativeTranslator {
    translator: Translator,
    buffer: String,
}

#[napi]
impl OpencodeTranslator {
    #[napi(constructor, catch_unwind)]
    pub fn new(root_key: String) -> napi::Result<Self> {
        Ok(Self {
            inner: Mutex::new(NativeTranslator {
                translator: Translator::new(root_key),
                buffer: String::with_capacity(65536),
            }),
        })
    }

    /// Translate one frame, returning the facts as a JSON array.
    #[napi(catch_unwind)]
    pub fn translate_frame(
        &self,
        frame_json: String,
        data_json: String,
        now_ms: f64,
    ) -> napi::Result<String> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| napi::Error::from_reason("opencode translator is unusable"))?;
        let mut buffer = std::mem::take(&mut guard.buffer);
        buffer.clear();
        guard
            .translator
            .translate_json(&frame_json, &data_json, now_ms, &mut buffer);
        let out = buffer.clone();
        guard.buffer = buffer;
        Ok(out)
    }

    /// Facts implied by time passing, as a JSON array.
    #[napi(catch_unwind)]
    pub fn tick(&self, now_ms: f64) -> napi::Result<String> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| napi::Error::from_reason("opencode translator is unusable"))?;
        let mut buffer = std::mem::take(&mut guard.buffer);
        buffer.clear();
        guard.translator.tick_json(now_ms, &mut buffer);
        let out = buffer.clone();
        guard.buffer = buffer;
        Ok(out)
    }

    /// Drain the diagnostics since the last translation, as a JSON array.
    #[napi(catch_unwind)]
    pub fn take_diagnostics(&self) -> napi::Result<String> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| napi::Error::from_reason("opencode translator is unusable"))?;
        let mut buffer = std::mem::take(&mut guard.buffer);
        buffer.clear();
        guard.translator.take_diagnostics_json(&mut buffer);
        let out = buffer.clone();
        guard.buffer = buffer;
        Ok(out)
    }

    /// Whether the translator holds no live work.
    #[napi(catch_unwind)]
    pub fn is_settled(&self) -> napi::Result<bool> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| napi::Error::from_reason("opencode translator is unusable"))?;
        Ok(guard.translator.is_settled())
    }

    /// The messages with live work for a session, as a JSON array.
    #[napi(catch_unwind)]
    pub fn live_messages(&self, session: String) -> napi::Result<String> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| napi::Error::from_reason("opencode translator is unusable"))?;
        let mut buffer = std::mem::take(&mut guard.buffer);
        buffer.clear();
        guard.translator.live_messages_json(&session, &mut buffer);
        let out = buffer.clone();
        guard.buffer = buffer;
        Ok(out)
    }

    /// Which session owns a background task, if any is held.
    #[napi(catch_unwind)]
    pub fn task_owner(&self, task: String) -> napi::Result<Option<String>> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| napi::Error::from_reason("opencode translator is unusable"))?;
        Ok(guard.translator.task_owner(&task))
    }

    /// Whether a native shell still holds its background task open.
    #[napi(catch_unwind)]
    pub fn live_shell(&self, id: String) -> napi::Result<bool> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| napi::Error::from_reason("opencode translator is unusable"))?;
        Ok(guard.translator.live_shell(&id))
    }
}
