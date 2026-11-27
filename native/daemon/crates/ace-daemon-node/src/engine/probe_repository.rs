// SPDX-License-Identifier: Apache-2.0
//! The E5.3 probe hooks, compiled only with the `engine-probe` cargo feature. They expose the
//! repository's own rows and transaction behaviour, plus the one scaffold the fold seam tests
//! need: pass-through collaborators (accepted by the owner, 2026-11-24; the last owner to land
//! deletes it). No thread behaviour lives here.

use ace_engine::EngineError;
use napi_derive::napi;

use super::{NativeEngine, engine_error};

#[napi]
impl NativeEngine {
    /// The one scaffold: unported collaborator calls return the fact unchanged or no rows, so a
    /// plain fold of item and turn facts runs before E5.4 to E5.9 land.
    #[napi]
    pub fn probe_pass_through_collaborators(&self) -> napi::Result<()> {
        self.engine
            .core()
            .with_state(|state| {
                state.repo.probe_passthrough = true;
            })
            .map_err(engine_error)
    }

    /// Folds one batch through `apply`, exactly as a provider frame would.
    #[napi]
    pub fn probe_apply(
        &self,
        id: String,
        facts_json: String,
        now: f64,
        generation: Option<f64>,
    ) -> napi::Result<()> {
        let core = self.engine.core();
        core.apply(&id, &facts_json, now, generation)
            .map_err(engine_error)
    }

    /// Streams one live batch: E5.2's buffer takes it and its flush settles this snapshot.
    #[napi]
    pub fn probe_stream(&self, id: String, facts_json: String, now: f64) -> napi::Result<bool> {
        self.engine
            .core()
            .stream(&id, &facts_json, now)
            .map_err(engine_error)
    }

    /// Folds one batch inside a transaction that then rolls back: the save's rows and its
    /// snapshot must not survive it.
    #[napi]
    pub fn probe_apply_rolled_back(
        &self,
        id: String,
        facts_json: String,
        now: f64,
    ) -> napi::Result<()> {
        let core = self.engine.core();
        let result = core.store.atomic(|_tx| {
            core.apply(&id, &facts_json, now, None)?;
            Err(EngineError::not_ported("a rolled-back probe fold", "E5.3"))
        });
        result.map_err(engine_error)
    }

    /// The record budget's figures: entries, weighted bytes and evictions.
    #[napi]
    pub fn probe_budget(&self) -> napi::Result<String> {
        let core = self.engine.core();
        let (entries, bytes, evictions) = core
            .with_state(|state| {
                let budget = state.repo.budget().borrow();
                (budget.size(), budget.byte_length(), budget.evictions())
            })
            .map_err(engine_error)?;
        Ok(format!(
            "{{\"entries\":{entries},\"bytes\":{bytes},\"evictions\":{evictions}}}"
        ))
    }

    /// How many snapshots the repository holds resident.
    #[napi]
    pub fn probe_resident(&self) -> napi::Result<u32> {
        let core = self.engine.core();
        core.with_state(|state| state.repo.resident() as u32)
            .map_err(engine_error)
    }

    /// Whether a thread's snapshot is resident.
    #[napi]
    pub fn probe_holds(&self, id: String) -> napi::Result<bool> {
        let core = self.engine.core();
        core.with_state(|state| state.repo.holds(&id))
            .map_err(engine_error)
    }

    /// The store's rollback generation, as the engine reads it.
    #[napi]
    pub fn probe_rollback_generation(&self) -> napi::Result<f64> {
        let core = self.engine.core();
        core.store.rollback_generation().map_err(engine_error)
    }

    /// The quarantine path (step 8): pin removed, snapshot evicted, nothing left resident.
    #[napi]
    pub fn probe_quarantine(&self, id: String) -> napi::Result<()> {
        let core = self.engine.core();
        core.with_state(|state| state.repo.quarantined(&core.store, &id))
            .map_err(engine_error)?
            .map_err(engine_error)
    }

    /// The candidate scan's pages over the current home, for the scan's own assertions.
    #[napi]
    pub fn probe_candidate_pages(&self) -> napi::Result<String> {
        let core = self.engine.core();
        let pages =
            ace_engine::repository::candidates::pages(core.store.conn()).map_err(engine_error)?;
        Ok(ace_json::to_string(&ace_json::Value::Array(
            pages
                .into_iter()
                .map(|page| {
                    ace_json::Value::Array(
                        page.into_iter()
                            .map(ace_json::Value::from)
                            .collect::<Vec<_>>()
                            .into(),
                    )
                })
                .collect::<Vec<_>>()
                .into(),
        )))
    }
}
