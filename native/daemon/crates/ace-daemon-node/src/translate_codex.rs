// SPDX-License-Identifier: Apache-2.0
//! The Codex translator binding: handles and plain JSON, no behaviour.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::Mutex;

use ace_json::Value;
use napi_derive::napi;

use crate::json_bind::write_values;

fn quote_string(value: &str) -> String {
    let mut quoted = String::with_capacity(value.len() + 2);
    ace_json::write_str(&mut quoted, value);
    quoted
}

/// Each fact as `{"type":…,…body}`: the type first, the body's canonical text spliced.
fn facts_json(facts: &[ace_core::RawFact]) -> String {
    let mut out = String::with_capacity(facts.len().saturating_mul(256).max(2));
    out.push('[');
    for (index, fact) in facts.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        let body = fact.data.get();
        let quoted = quote_string(&fact.fact_type);
        if body.len() <= 2 {
            out.push_str("{\"type\":");
            out.push_str(&quoted);
            out.push('}');
        } else {
            let inner = &body[1..body.len() - 1];
            out.push_str("{\"type\":");
            out.push_str(&quoted);
            out.push(',');
            out.push_str(inner);
            out.push('}');
        }
    }
    out.push(']');
    out
}

#[napi]
pub struct NativeCodexTranslator {
    inner: Mutex<ace_adapter_codex::translate::CodexTranslator>,
}

#[napi]
impl NativeCodexTranslator {
    #[napi(constructor, catch_unwind)]
    pub fn new(thread_id: String, root_key: String) -> napi::Result<Self> {
        let result = catch_unwind(AssertUnwindSafe(|| {
            ace_adapter_codex::translate::CodexTranslator::new(thread_id, root_key)
        }));
        match result {
            Ok(inner) => Ok(Self {
                inner: Mutex::new(inner),
            }),
            Err(_) => Err(napi::Error::from_reason("codex translator failed to start")),
        }
    }

    #[napi(catch_unwind)]
    pub fn translate(&self, frame_json: String, now: f64) -> napi::Result<String> {
        let result = catch_unwind(AssertUnwindSafe(|| {
            // Undecodable frame text reads as an empty frame, as before.
            let mut root = match ace_json::parse(&frame_json) {
                Ok(Value::Object(root)) => root,
                _ => ace_json::Map::new(),
            };
            let text = |key: &str, fallback: &str| {
                root.get(key)
                    .and_then(Value::as_str)
                    .unwrap_or(fallback)
                    .to_owned()
            };
            let dir = text("dir", "recv");
            let channel = text("channel", "stdio");
            let seq = root.get("seq").and_then(|v| v.as_u64()).unwrap_or(0);
            let t = root.get("t").and_then(|v| v.as_i64()).unwrap_or(0);
            // The data moves out of the frame: no copy of the provider value.
            let data = root.remove("data").unwrap_or(Value::Null);
            let frame = ace_adapter_codex::translate::ParsedFrame {
                dir,
                channel,
                data,
                seq,
                t,
            };
            let now_ms = now as i64;
            let mut guard = match self.inner.lock() {
                Ok(guard) => guard,
                Err(poison) => poison.into_inner(),
            };
            let facts = guard.translate_value(frame, now_ms);
            facts_json(&facts)
        }));
        match result {
            Ok(json) => Ok(json),
            Err(_) => Err(napi::Error::from_reason(
                "codex translator panicked on provider data",
            )),
        }
    }

    #[napi(catch_unwind)]
    pub fn tick(&self, now: f64) -> napi::Result<String> {
        let result = catch_unwind(AssertUnwindSafe(|| {
            let now_ms = now as i64;
            let mut guard = match self.inner.lock() {
                Ok(guard) => guard,
                Err(poison) => poison.into_inner(),
            };
            let facts = guard.tick_value(now_ms);
            facts_json(&facts)
        }));
        match result {
            Ok(json) => Ok(json),
            Err(_) => Err(napi::Error::from_reason("codex translator tick panicked")),
        }
    }

    #[napi(catch_unwind)]
    pub fn take_diagnostics(&self) -> napi::Result<String> {
        let result = catch_unwind(AssertUnwindSafe(|| {
            let mut guard = match self.inner.lock() {
                Ok(guard) => guard,
                Err(poison) => poison.into_inner(),
            };
            let diagnostics = guard.take_diagnostics_value();
            let mut json = String::new();
            write_values(&mut json, &diagnostics);
            json
        }));
        match result {
            Ok(json) => Ok(json),
            Err(_) => Err(napi::Error::from_reason(
                "codex translator diagnostics panicked",
            )),
        }
    }

    #[napi(catch_unwind)]
    pub fn next_deadline(&self) -> napi::Result<Option<f64>> {
        let result = catch_unwind(AssertUnwindSafe(|| {
            let guard = match self.inner.lock() {
                Ok(guard) => guard,
                Err(poison) => poison.into_inner(),
            };
            let _ = &guard;
            None::<f64>
        }));
        match result {
            Ok(value) => Ok(value),
            Err(_) => Err(napi::Error::from_reason(
                "codex translator deadline panicked",
            )),
        }
    }
}
