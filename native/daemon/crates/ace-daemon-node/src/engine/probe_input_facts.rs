// SPDX-License-Identifier: Apache-2.0
//! The fold-hook probe hook (E5.4a): one E5.3 `InputFacts` method natively, inside a transaction
//! of its own. Split out of `probe.rs` so neither file passes its size budget.

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
                        match method.as_str() {
                            "retireEndedTurnInputs" => {
                                let generation = args
                                    .get("generation")
                                    .and_then(ace_json::Value::as_f64)
                                    .unwrap_or(0.0);
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
