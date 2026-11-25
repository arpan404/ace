// SPDX-License-Identifier: Apache-2.0
//! The probe's `InputFacts` hook (E5.4b), compiled only with the `engine-probe` cargo feature: it
//! calls one E5.3 collaborator method natively, inside a transaction of its own, JSON in and JSON
//! out. It is scaffolding for the seam tests and is deleted with E5.3's pass-through collaborators.

use napi_derive::napi;

use super::NativeEngine;

#[napi]
impl NativeEngine {
    /// One E5.3 `InputFacts` method natively, inside a transaction of its own; JSON in, JSON out
    /// (the brief's `EngineProbe.inputFacts`). E5.4b reaches the journal's correlation and the run
    /// binding through it; the methods other rounds own answer their `NotPorted` item.
    #[napi]
    pub fn probe_input_facts(&self, method: String, args_json: String) -> napi::Result<String> {
        use ace_engine::repository::collaborators::InputFacts;
        let args = ace_json::parse(&args_json)
            .map_err(|error| napi::Error::from_reason(error.to_string()))?;
        let thread = text_field(&args, "thread");
        let generation = args.get("generation").and_then(ace_json::Value::as_f64);
        let core = self.engine.core();
        let value = core
            .store
            .atomic(|_tx| {
                core.with_state(|state| match method.as_str() {
                    "inputs.correlate" => {
                        let fact = args.get("fact").cloned().unwrap_or(ace_json::Value::Null);
                        let root = args.get("root").and_then(ace_json::Value::as_str);
                        let correlated = state.correlate_with(thread, fact, root, generation)?;
                        Ok(correlated.unwrap_or(ace_json::Value::Null))
                    }
                    "inputs.keyFor" => {
                        let native_id = text_field(&args, "nativeId");
                        let key = state.input_key_for(thread, native_id)?;
                        Ok(key
                            .map(|key| ace_json::Value::from(key.as_str()))
                            .unwrap_or(ace_json::Value::Null))
                    }
                    "aceInputs.attribute" => {
                        let fact = args.get("fact").cloned().unwrap_or(ace_json::Value::Null);
                        state.attribute_input(thread, fact)
                    }
                    "aceWaitFact" => {
                        let fact = args.get("fact").cloned().unwrap_or(ace_json::Value::Null);
                        let waiting = state.ace_wait_fact(thread, &fact)?;
                        Ok(waiting.unwrap_or(ace_json::Value::Null))
                    }
                    "bindStartedRun" => {
                        let run = text_field(&args, "run");
                        let events = state.bind_started_run_with(thread, run, generation)?;
                        Ok(ace_json::Value::Array(events.into()))
                    }
                    "bindConsumedInput" => {
                        let key = text_field(&args, "key");
                        let at = args
                            .get("at")
                            .and_then(ace_json::Value::as_f64)
                            .unwrap_or(0.0);
                        let events = state.bind_consumed_input_with(thread, key, generation, at)?;
                        Ok(ace_json::Value::Array(events.into()))
                    }
                    other => Err(ace_engine::EngineError::not_ported(
                        "this input fact",
                        if other == "rootRunStart" {
                            "E5.5"
                        } else {
                            "E5.4a"
                        },
                    )),
                })
            })
            .map_err(|error| napi::Error::from_reason(error.to_string()))?
            .map_err(|error| napi::Error::from_reason(error.to_string()))?;
        Ok(ace_json::to_string(&value))
    }
}

/// A text argument, or an empty string when it is absent.
fn text_field<'a>(args: &'a ace_json::Value, key: &str) -> &'a str {
    args.get(key)
        .and_then(ace_json::Value::as_str)
        .unwrap_or_default()
}
