// SPDX-License-Identifier: Apache-2.0
//! The receipt's facade members (E5.4d): `handle` (the prelude and the queue commands, inside
//! the shell's transaction), `admissionReopened` and `prepareCommand`.

use napi_derive::napi;

use super::{NativeEngine, engine_error};

#[napi]
impl NativeEngine {
    /// `internalHandler.handle`: one synchronous receipt. `None` from the prelude means the
    /// command's own receipt is E5.4e's, which fails `NotPorted`.
    #[napi]
    pub fn handle(&self, command: String) -> napi::Result<String> {
        let command = ace_json::parse(&command)
            .map_err(|error| napi::Error::from_reason(error.to_string()))?;
        let core = self.engine.core();
        let result = core
            .with_state(|state| ace_engine::commands::prelude::handle(core, state, &command))
            .map_err(engine_error)?
            .map_err(engine_error)?;
        let Some(result) = result else {
            return Err(engine_error(ace_engine::EngineError::not_ported(
                "thread commands",
                "E5.4e",
            )));
        };
        Ok(ace_json::to_string(&result))
    }

    /// `admissionReopened`: arm the queue deadline timer again.
    #[napi]
    pub fn admission_reopened(&self) -> napi::Result<()> {
        let core = self.engine.core();
        ace_engine::queue::holds::schedule(core).map_err(engine_error)
    }

    /// `prepareCommand`: without a silence or preferences port there is no store work to do.
    #[napi]
    pub fn prepare_command(&self, _command: String) {}
}
