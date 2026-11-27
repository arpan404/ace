// SPDX-License-Identifier: Apache-2.0
//! The JavaScript translator (E5.2 step 13): a reference to the session's translator and to the
//! shell's batch helper. One JavaScript call per batch, so the TypeScript's per-frame
#![allow(dead_code)]
//! `clock.now()` and the order of `translate` and `takeDiagnostics` are kept.

use ace_engine::EngineError;
use ace_engine::actor::deps::{JsBatchTranslator, TranslatedFrame};
use ace_engine::actor::state::FrameRef;
use ace_engine::ports::PortError;
use ace_json::Value;
use napi::bindgen_prelude::FnArgs;
use napi::bindgen_prelude::FunctionRef;
use std::rc::Rc;

use super::ports::JsPorts;

/// `(threadId, requestJson) -> [[facts, diagnostics, data], …]` as JSON.
pub type Helper = FunctionRef<FnArgs<(String, String)>, String>;

/// One thread's JavaScript translator.
pub struct JsTranslator {
    pub thread: String,
    pub helper: Rc<Helper>,
    pub ports: Rc<JsPorts>,
}

impl JsTranslator {
    fn call(&self, request: Value) -> Result<Value, EngineError> {
        let text = self
            .ports
            .call_port(
                &self.helper,
                FnArgs {
                    data: (self.thread.clone(), ace_json::to_string(&request)),
                },
            )
            .map_err(EngineError::Port)?;
        ace_json::parse(&text)
            .map_err(|error| EngineError::Port(PortError::Threw(error.to_string())))
    }
}

impl JsBatchTranslator for JsTranslator {
    fn translate_batch(
        &mut self,
        frames: &[&FrameRef],
        now: f64,
    ) -> Result<Vec<TranslatedFrame>, EngineError> {
        let handles: Vec<Value> = frames
            .iter()
            .map(|frame| match frame {
                FrameRef::Js { handle, .. } => Value::Number((u64::from(*handle)).into()),
                FrameRef::Native(frame) => Value::Number((frame.seq).into()),
            })
            .collect();
        let answer = self.call(ace_json::json!({
            "now": now,
            "frames": Value::Array(handles.into()),
        }))?;
        let Value::Array(entries) = answer else {
            return Err(EngineError::Port(PortError::Threw(
                "the translator helper answered with something else".to_string(),
            )));
        };
        Ok(entries.iter().map(read_entry).collect())
    }

    fn tick(&mut self, now: f64) -> Result<Vec<Value>, EngineError> {
        let answer = self.call(ace_json::json!({"tick": now}))?;
        Ok(match answer {
            Value::Array(items) => items.to_vec(),
            _ => Vec::new(),
        })
    }

    fn next_deadline(&mut self) -> Option<i64> {
        // The helper answers a deadline call with one number; a session without one says null.
        let answer = self.call(ace_json::json!({"nextDeadline": true})).ok()?;
        match answer {
            Value::Number(number) => number.as_f64().map(|value| value as i64),
            _ => None,
        }
    }
}

fn read_entry(entry: &Value) -> TranslatedFrame {
    let Value::Object(map) = entry else {
        return TranslatedFrame::default();
    };
    let facts = match map.get("facts") {
        Some(Value::Array(items)) => items.to_vec(),
        _ => Vec::new(),
    };
    let diagnostics = match map.get("diagnostics") {
        Some(Value::Array(items)) => items.to_vec(),
        _ => Vec::new(),
    };
    TranslatedFrame {
        facts,
        diagnostics,
        frame: map.get("frame").cloned(),
        usage_account: map.get("usageAccount").cloned(),
    }
}
