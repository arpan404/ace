// SPDX-License-Identifier: Apache-2.0
//! The claude translator binding (E1). It only translates: frame JSON in,
//! facts JSON out, per call. Behaviour lives in `ace-adapter-claude`.

use ace_adapter_claude::translate::ClaudeTranslator as CoreTranslator;
use ace_adapter_claude::translate::frame::FrameView;
use ace_json::{Kind, Value};
use napi::Env;
use napi_derive::napi;

use crate::json_bind::{frame, text_field, write_values};

/// The native claude translator behind the adapter's exported translator
/// name. One preallocated output buffer is reused across calls; each call
/// clears it (keeping capacity) and serializes into it.
#[napi]
pub struct ClaudeTranslator {
    inner: CoreTranslator,
    out: String,
}

#[napi]
impl ClaudeTranslator {
    #[napi(constructor, catch_unwind)]
    pub fn new(root_key: String) -> napi::Result<Self> {
        Ok(ClaudeTranslator {
            inner: CoreTranslator::new(&root_key),
            out: String::with_capacity(65536),
        })
    }

    /// Translate one frame: the shell sends the frame as JSON and parses the
    /// returned facts. Provider data decodes leniently inside the crate;
    /// only a frame that is not JSON at all fails here (a `SyntaxError`),
    /// which is a shell contract violation rather than provider data.
    #[napi(catch_unwind)]
    pub fn translate(&mut self, env: Env, frame_json: String, now: f64) -> napi::Result<String> {
        let root = frame(&env, &frame_json)?;
        if root.kind() != Kind::Object {
            return Err(napi::Error::from_reason(
                "translator frame must be an object",
            ));
        }
        let seq = root.get("seq").and_then(|v| v.as_i64()).unwrap_or(0);
        let dir = text_field(root, "dir").unwrap_or("recv".into());
        let channel = text_field(root, "channel").unwrap_or("sdk".into());
        let data = root.get("data").map_or(Value::Null, |data| data.to_value());
        let payload_bytes = root
            .get("payloadBytes")
            .and_then(|v| v.as_u64())
            .map(|v| v as usize);
        let view = FrameView {
            seq,
            dir: &dir,
            channel: &channel,
            data: &data,
            payload_bytes,
        };
        let now_ms = now.trunc() as i64;
        let facts = self.inner.translate(&view, now_ms);
        write_values(&mut self.out, &facts);
        Ok(self.out.clone())
    }

    /// Facts implied by time passing. Same JSON contract as `translate`.
    #[napi(catch_unwind)]
    pub fn tick(&mut self, now: f64) -> napi::Result<String> {
        let now_ms = now.trunc() as i64;
        let facts = self.inner.tick(now_ms);
        write_values(&mut self.out, &facts);
        Ok(self.out.clone())
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
        write_values(&mut self.out, &diagnostics);
        Ok(self.out.clone())
    }
}
