// SPDX-License-Identifier: Apache-2.0
//! The intent reads behind the facade (E5.4a): `commandFailure` and `commandExecution`
//! (`engine/index.ts:1081`, `:1084`), and `prioritizeSubagentResult` (`:596`).

use ace_store::{Value, stmt_cache};
use napi_derive::napi;

use super::{NativeEngine, engine_error};

const PRIORITIZE: &str = "UPDATE intents SET position=0 WHERE thread_id=? AND command_id=?";

#[napi]
impl NativeEngine {
    /// `commandFailure`: why an admitted command failed after admission, if it did.
    #[napi]
    pub fn command_failure(&self, command_id: String) -> napi::Result<Option<String>> {
        let core = self.engine.core();
        ace_engine::intents::store::failure(core.store.conn(), &command_id).map_err(engine_error)
    }

    /// `commandExecution`: the command's intent status.
    #[napi]
    pub fn command_execution(&self, command_id: String) -> napi::Result<Option<String>> {
        let core = self.engine.core();
        ace_engine::intents::store::command_status(core.store.conn(), &command_id)
            .map_err(engine_error)
    }

    /// `prioritizeSubagentResult`: position 0, no revision bump.
    #[napi]
    pub fn prioritize_subagent_result(&self, id: String, command_id: String) -> napi::Result<()> {
        let core = self.engine.core();
        core.store
            .atomic(|tx| {
                stmt_cache::run(
                    tx.conn(),
                    PRIORITIZE,
                    vec![Value::Text(id.clone()), Value::Text(command_id.clone())],
                )?;
                Ok(())
            })
            .map_err(engine_error)
    }
}
