// SPDX-License-Identifier: Apache-2.0
//! The Pi translator binding: values in, facts out, never logic.

use ace_adapter_api::Translator;
use ace_adapter_pi::translate::PiTranslator;
use napi_derive::napi;
use std::panic::{AssertUnwindSafe, catch_unwind};

/// One native Pi translator behind a handle the TypeScript shell holds.
#[napi]
pub struct PiTranslatorNative {
    inner: PiTranslator,
    /// Preallocated output buffer reused for every JSON response.
    buffer: String,
}

#[napi]
impl PiTranslatorNative {
    /// Create a translator for `root_key`; `thread_id` is kept for parity.
    #[napi(constructor, catch_unwind)]
    pub fn new(thread_id: String, root_key: String) -> napi::Result<Self> {
        let _ = thread_id;
        let result = catch_unwind(AssertUnwindSafe(|| PiTranslator::new(root_key)));
        match result {
            Ok(inner) => Ok(Self {
                inner,
                buffer: String::with_capacity(8192),
            }),
            Err(_) => Err(napi::Error::from_reason("pi translator failed to start")),
        }
    }

    /// Translate one frame JSON object; returns the facts as a JSON array.
    #[napi(catch_unwind)]
    pub fn translate(&mut self, frame_json: String, now: f64) -> napi::Result<String> {
        let result = catch_unwind(AssertUnwindSafe(|| {
            let frame = parse_frame(&frame_json)?;
            let now_ms = to_millis(now);
            let facts = self.inner.translate(&frame, now_ms);
            Ok::<Vec<ace_core::Fact>, PiBindError>(facts)
        }));
        let facts = match result {
            Ok(Ok(facts)) => facts,
            Ok(Err(error)) => return Err(error.into()),
            Err(_) => return Err(napi::Error::from_reason("pi translate panicked")),
        };
        self.buffer.clear();
        self.buffer.push('[');
        let mut first = true;
        for fact in &facts {
            if !first {
                self.buffer.push(',');
            }
            first = false;
            self.buffer.push_str(fact.data.get());
        }
        self.buffer.push(']');
        Ok(std::mem::take(&mut self.buffer))
    }

    /// Facts implied by time passing.
    #[napi(catch_unwind)]
    pub fn tick(&mut self, now: f64) -> napi::Result<String> {
        let result = catch_unwind(AssertUnwindSafe(|| {
            let now_ms = to_millis(now);
            Ok::<Vec<ace_core::Fact>, PiBindError>(self.inner.tick(now_ms))
        }));
        let facts = match result {
            Ok(Ok(facts)) => facts,
            Ok(Err(error)) => return Err(error.into()),
            Err(_) => return Err(napi::Error::from_reason("pi tick panicked")),
        };
        self.buffer.clear();
        self.buffer.push('[');
        let mut first = true;
        for fact in &facts {
            if !first {
                self.buffer.push(',');
            }
            first = false;
            self.buffer.push_str(fact.data.get());
        }
        self.buffer.push(']');
        Ok(std::mem::take(&mut self.buffer))
    }

    /// Drained diagnostics as a JSON array of raw payloads.
    #[napi(catch_unwind)]
    pub fn take_diagnostics(&mut self) -> napi::Result<String> {
        let result = catch_unwind(AssertUnwindSafe(|| {
            Ok::<Vec<String>, PiBindError>(self.inner.take_diagnostics())
        }));
        let diagnostics = match result {
            Ok(Ok(values)) => values,
            Ok(Err(error)) => return Err(error.into()),
            Err(_) => return Err(napi::Error::from_reason("pi diagnostics panicked")),
        };
        self.buffer.clear();
        self.buffer.push('[');
        let mut first = true;
        for item in &diagnostics {
            if !first {
                self.buffer.push(',');
            }
            first = false;
            self.buffer.push_str(item);
        }
        self.buffer.push(']');
        Ok(std::mem::take(&mut self.buffer))
    }

    /// The earliest dialog deadline, if any.
    #[napi(catch_unwind)]
    pub fn next_deadline(&mut self) -> napi::Result<Option<f64>> {
        let result = catch_unwind(AssertUnwindSafe(|| {
            Ok::<Option<i64>, PiBindError>(self.inner.next_deadline())
        }));
        match result {
            Ok(Ok(deadline)) => Ok(deadline.map(|value| value as f64)),
            Ok(Err(error)) => Err(error.into()),
            Err(_) => Err(napi::Error::from_reason("pi deadline panicked")),
        }
    }
}

#[derive(Debug, thiserror::Error)]
enum PiBindError {
    #[error("invalid frame: {0}")]
    InvalidFrame(String),
}

impl From<PiBindError> for napi::Error {
    fn from(error: PiBindError) -> Self {
        napi::Error::from_reason(error.to_string())
    }
}

fn to_millis(now: f64) -> i64 {
    if !now.is_finite() {
        return 0;
    }
    let clamped = now.clamp(i64::MIN as f64, i64::MAX as f64);
    clamped.trunc() as i64
}

fn parse_frame(json: &str) -> Result<ace_adapter_api::Frame, PiBindError> {
    let root =
        ace_json::parse_raw(json).map_err(|error| PiBindError::InvalidFrame(error.to_string()))?;
    let input = FrameInput::read(root)?;
    let dir = match input.dir.as_str() {
        "send" => ace_adapter_api::FrameDirection::Send,
        "recv" => ace_adapter_api::FrameDirection::Recv,
        "stderr" => ace_adapter_api::FrameDirection::Stderr,
        "note" => ace_adapter_api::FrameDirection::Note,
        other => return Err(PiBindError::InvalidFrame(format!("unknown dir: {other}"))),
    };
    Ok(ace_adapter_api::Frame {
        seq: input.seq,
        t: input.t.unwrap_or(0),
        dir,
        channel: input.channel.unwrap_or_else(|| "stdio".to_owned()),
        data: input.data,
        payload: None,
        usage_account: None,
    })
}

/// The frame's fields, as the shell sends them: `seq`, `dir` and `data` required.
struct FrameInput {
    seq: u64,
    t: Option<i64>,
    dir: String,
    channel: Option<String>,
    data: ace_json::Raw,
}

impl FrameInput {
    fn read(root: ace_json::RawRef<'_>) -> Result<FrameInput, PiBindError> {
        let missing =
            |field: &str| PiBindError::InvalidFrame(format!("missing or invalid {field}"));
        let text = |key: &str| {
            root.get(key)
                .and_then(|v| v.as_str())
                .map(|v| v.into_owned())
        };
        Ok(FrameInput {
            seq: root
                .get("seq")
                .and_then(|v| v.as_u64())
                .ok_or_else(|| missing("seq"))?,
            t: root.get("t").and_then(|v| v.as_i64()),
            dir: text("dir").ok_or_else(|| missing("dir"))?,
            channel: text("channel"),
            data: root
                .get("data")
                .map(|v| v.to_raw())
                .ok_or_else(|| missing("data"))?,
        })
    }
}
