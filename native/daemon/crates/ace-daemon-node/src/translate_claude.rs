// SPDX-License-Identifier: Apache-2.0
//! The claude translator binding (E1). It only translates: frame JSON in,
//! facts JSON out, per call. Behaviour lives in `ace-adapter-claude`.

use ace_adapter_claude::translate::ClaudeTranslator as CoreTranslator;
use ace_adapter_claude::translate::frame::FrameView;
use napi_derive::napi;
use serde_json::Value;

/// The native claude translator behind the adapter's exported translator
/// name. One preallocated output buffer is reused across calls; each call
/// clears it (keeping capacity) and serializes into it.
#[napi]
pub struct ClaudeTranslator {
    inner: CoreTranslator,
    out: Vec<u8>,
}

#[napi]
impl ClaudeTranslator {
    #[napi(constructor, catch_unwind)]
    pub fn new(root_key: String) -> napi::Result<Self> {
        Ok(ClaudeTranslator {
            inner: CoreTranslator::new(&root_key),
            out: Vec::with_capacity(65536),
        })
    }

    /// Translate one frame: the shell sends the frame as JSON and parses the
    /// returned facts. Provider data decodes leniently inside the crate;
    /// only a frame that is not JSON at all fails here, which is a shell
    /// contract violation rather than provider data.
    #[napi(catch_unwind)]
    pub fn translate(&mut self, frame_json: String, now: f64) -> napi::Result<String> {
        // Deeply nested provider data recurses in the parser, the fold and
        // the serializer alike; grow the stack so a hostile frame fails as
        // a diagnostic downstream, never aborts the daemon.
        stacker::maybe_grow(32 * 1024, 8 * 1024 * 1024, || {
            self.translate_inner(&frame_json, now)
        })
    }

    fn translate_inner(&mut self, frame_json: &str, now: f64) -> napi::Result<String> {
        // Provider frames may nest far deeper than serde_json's default
        // recursion limit (the engine bounds them later via capFact); parse
        // without the limit so deep native fields survive like TypeScript.
        let mut de = serde_json::Deserializer::from_str(frame_json);
        de.disable_recursion_limit();
        let frame: Value = serde::de::Deserialize::deserialize(&mut de)
            .map_err(|error| napi::Error::from_reason(error.to_string()))?;
        let obj = match &frame {
            Value::Object(map) => map,
            _ => {
                return Err(napi::Error::from_reason(
                    "translator frame must be an object",
                ));
            }
        };
        let seq = obj.get("seq").and_then(|v| v.as_i64()).unwrap_or(0);
        let dir = obj.get("dir").and_then(|v| v.as_str()).unwrap_or("recv");
        let channel = obj.get("channel").and_then(|v| v.as_str()).unwrap_or("sdk");
        let data = obj.get("data").unwrap_or(&Value::Null);
        let payload_bytes = obj
            .get("payloadBytes")
            .and_then(|v| v.as_u64())
            .map(|v| v as usize);
        let view = FrameView {
            seq,
            dir,
            channel,
            data,
            payload_bytes,
        };
        let now_ms = now.trunc() as i64;
        let facts = self.inner.translate(&view, now_ms);
        self.out.clear();
        serde_json::to_writer(&mut self.out, &facts)
            .map_err(|error| napi::Error::from_reason(error.to_string()))?;
        String::from_utf8(self.out.clone())
            .map_err(|error| napi::Error::from_reason(error.to_string()))
    }

    /// Facts implied by time passing. Same JSON contract as `translate`.
    #[napi(catch_unwind)]
    pub fn tick(&mut self, now: f64) -> napi::Result<String> {
        let now_ms = now.trunc() as i64;
        let facts = self.inner.tick(now_ms);
        self.out.clear();
        serde_json::to_writer(&mut self.out, &facts)
            .map_err(|error| napi::Error::from_reason(error.to_string()))?;
        String::from_utf8(self.out.clone())
            .map_err(|error| napi::Error::from_reason(error.to_string()))
    }

    /// Combine with the core's next deadline.
    #[napi(catch_unwind)]
    pub fn next_deadline(&self) -> napi::Result<Option<i64>> {
        Ok(self.inner.next_deadline())
    }

    /// Native debug evidence kept outside the transcript.
    #[napi(catch_unwind)]
    pub fn take_diagnostics(&mut self) -> napi::Result<String> {
        let diagnostics = self.inner.take_diagnostics();
        self.out.clear();
        serde_json::to_writer(&mut self.out, &diagnostics)
            .map_err(|error| napi::Error::from_reason(error.to_string()))?;
        String::from_utf8(self.out.clone())
            .map_err(|error| napi::Error::from_reason(error.to_string()))
    }
}
