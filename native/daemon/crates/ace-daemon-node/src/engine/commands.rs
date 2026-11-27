// SPDX-License-Identifier: Apache-2.0
//! The receipt's facade members (E5.4d): `handle` (the prelude and the queue commands, inside
//! the shell's transaction), `admissionReopened` and `prepareCommand`.

use napi_derive::napi;

use super::{NativeEngine, engine_error};

#[napi]
impl NativeEngine {
    /// `internalHandler.handle`: one synchronous receipt. `None` from the prelude means the
    /// command's own receipt is E5.4e's, which fails `NotPorted`.
    ///
    /// The receipt holds the `State` borrow for its whole run, and its event writes run the
    /// store's `onWrite` hook, which can read the engine back (`rootAgent`, the queue's facts).
    /// Those writes are held back and replayed, in call order, once the borrow is released, all
    /// inside the shell's transaction; a receipt that fails drops them with its rollback.
    #[napi]
    pub fn handle(&self, command: String) -> napi::Result<String> {
        let command = ace_json::parse(&command)
            .map_err(|error| napi::Error::from_reason(error.to_string()))?;
        let core = self.engine.core();
        self.ports.defer_events(true);
        let outcome =
            core.with_state(|state| ace_engine::commands::prelude::handle(core, state, &command));
        let deferred = self.ports.take_deferred_events();
        let result = match outcome.map_err(engine_error)? {
            Ok(Some(result)) => result,
            Ok(None) => {
                return Err(engine_error(ace_engine::EngineError::not_ported(
                    "thread commands",
                    "E5.4e",
                )));
            }
            Err(error) => return Err(engine_error(error)),
        };
        for (thread, payloads, at) in deferred {
            core.store
                .write_events(&thread, &payloads, at)
                .map_err(engine_error)?;
        }
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
