// SPDX-License-Identifier: Apache-2.0
//! The input reads behind the facade (E5.4c): `inputFate` (`engine/index.ts:1135`), one
//! transaction over the input's replacement, item, run and intent.

use napi_derive::napi;

use super::{NativeEngine, engine_error};

#[napi]
impl NativeEngine {
    /// `inputFate(id, commandId)`: what became of an accepted input, and its run.
    #[napi]
    pub fn input_fate(&self, id: String, command_id: String) -> napi::Result<String> {
        let core = self.engine.core();
        let value =
            ace_engine::inputs::fate::read(&core.store, &id, &command_id).map_err(engine_error)?;
        Ok(ace_json::to_string(&value))
    }
}
