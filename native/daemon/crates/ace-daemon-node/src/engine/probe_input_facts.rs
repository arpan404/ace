// SPDX-License-Identifier: Apache-2.0
//! The fold-hook probe hook (E5.4a and E5.4b): one E5.3 `InputFacts` method natively, inside a
//! transaction of its own. Split out of `probe.rs` so neither file passes its size budget.
//!
//! `inputs.sending` is not an `InputFacts` member: it writes the journal row a delivery writes
//! (E5.5), so the seam can prove the Rust signature of a Claude command matches its echo.

use ace_engine::EngineError;
use napi_derive::napi;

use super::NativeEngine;

#[napi]
impl NativeEngine {
    /// One E5.3 `InputFacts` method natively, inside a transaction of its own; JSON in, JSON out
    /// (the brief's `EngineProbe.inputFacts`). 4a reaches `retireEndedTurnInputs` through it;
    /// the methods 4b and E5.5 own answer their `NotPorted` item.
    ///
    /// A failure inside the hook fails the transaction, so a clear the hook already wrote rolls
    /// back with the rest.
    #[napi]
    pub fn probe_input_facts(&self, method: String, args_json: String) -> napi::Result<String> {
        use ace_engine::repository::collaborators::InputFacts;
        let args = ace_json::parse(&args_json)
            .map_err(|error| napi::Error::from_reason(error.to_string()))?;
        let thread = args
            .get("thread")
            .and_then(ace_json::Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let core = self.engine.core();
        let value = core
            .store
            .atomic(|_tx| {
                let value =
                    core.with_state(|state| -> Result<ace_json::Value, EngineError> {
                        let generation = args.get("generation").and_then(ace_json::Value::as_f64);
                        match method.as_str() {
                            "inputs.correlate" => {
                                let fact =
                                    args.get("fact").cloned().unwrap_or(ace_json::Value::Null);
                                let root = args.get("root").and_then(ace_json::Value::as_str);
                                let correlated = state.correlate_with(
                                    thread.as_str(),
                                    fact,
                                    root,
                                    generation,
                                )?;
                                Ok(correlated.unwrap_or(ace_json::Value::Null))
                            }
                            "inputs.keyFor" => {
                                let native_id = args
                                    .get("nativeId")
                                    .and_then(ace_json::Value::as_str)
                                    .unwrap_or_default();
                                let key = state.input_key_for_with(thread.as_str(), native_id)?;
                                Ok(key
                                    .map(|key| ace_json::Value::from(key.as_str()))
                                    .unwrap_or(ace_json::Value::Null))
                            }
                            "inputs.sending" => {
                                let key = args
                                    .get("key")
                                    .and_then(ace_json::Value::as_str)
                                    .unwrap_or_default();
                                let parts = args
                                    .get("parts")
                                    .and_then(ace_json::Value::as_array)
                                    .map(|parts| parts.to_vec())
                                    .unwrap_or_default();
                                let provider =
                                    args.get("provider").and_then(ace_json::Value::as_str);
                                state.input_sending(
                                    thread.as_str(),
                                    key,
                                    &parts,
                                    provider,
                                    generation,
                                )?;
                                Ok(ace_json::Value::Null)
                            }
                            "aceInputs.attribute" => {
                                let fact =
                                    args.get("fact").cloned().unwrap_or(ace_json::Value::Null);
                                state.attribute_input_with(thread.as_str(), fact)
                            }
                            "aceWaitFact" => {
                                let fact =
                                    args.get("fact").cloned().unwrap_or(ace_json::Value::Null);
                                let waiting = state.ace_wait_fact_with(thread.as_str(), &fact)?;
                                Ok(waiting.unwrap_or(ace_json::Value::Null))
                            }
                            "bindStartedRun" => {
                                let run = args
                                    .get("run")
                                    .and_then(ace_json::Value::as_str)
                                    .unwrap_or_default();
                                let events = state.bind_started_run_with(
                                    thread.as_str(),
                                    run,
                                    generation,
                                )?;
                                Ok(ace_json::Value::Array(events.into()))
                            }
                            "bindConsumedInput" => {
                                let key = args
                                    .get("key")
                                    .and_then(ace_json::Value::as_str)
                                    .unwrap_or_default();
                                let at = args
                                    .get("at")
                                    .and_then(ace_json::Value::as_f64)
                                    .unwrap_or(0.0);
                                let events = state.bind_consumed_input_with(
                                    thread.as_str(),
                                    key,
                                    generation,
                                    at,
                                )?;
                                Ok(ace_json::Value::Array(events.into()))
                            }
                            "retireEndedTurnInputs" => {
                                let generation = generation.unwrap_or(0.0);
                                let at = args
                                    .get("at")
                                    .and_then(ace_json::Value::as_f64)
                                    .unwrap_or(0.0);
                                state.retire_ended_turn_inputs(&thread, generation, at)?;
                                Ok(ace_json::Value::Null)
                            }
                            other => Err(EngineError::not_ported(
                                "this input fact",
                                if other.starts_with("inputs.") {
                                    "E5.4b"
                                } else if other == "rootRunStart" {
                                    "E5.5"
                                } else {
                                    "E5.4a"
                                },
                            )),
                        }
                    })??;
                core.flush_deferred()?;
                Ok(value)
            })
            .map_err(|error| napi::Error::from_reason(error.to_string()))?;
        Ok(ace_json::to_string(&value))
    }
}
