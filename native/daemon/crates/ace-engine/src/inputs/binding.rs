// SPDX-License-Identifier: Apache-2.0
//! 4b's half of E5.3's `InputFacts` (`collaborators.rs`), as helpers the trait block in
//! `queue::fold_hooks` calls: the input journal's correlation, ace-input attribution, an ace
//! wait's fact, and the run binding of consumed and started runs.
//!
//! The fold calls these on the `State` it is folding, so the resident snapshot is reached through
//! `State.repo` without a second borrow of the engine: the TypeScript hands `ThreadState` in.
//! The trait methods live in 4a's block, one implementation of the trait for the crate.

use ace_json::Value;
use std::cell::RefCell;
use std::rc::Rc;

use crate::snapshot::Snapshot;
use crate::{Core, EngineError, State};

impl State {
    /// The engine this state belongs to. `Ok(None)` is E5.3's probe on a bare `State`; a plain
    /// `State` with no probe fails at the call.
    fn input_engine(&self) -> Result<Option<Rc<Core>>, EngineError> {
        if let Some(core) = self.engine.upgrade() {
            return Ok(Some(core));
        }
        if self.repo.probe_passthrough {
            return Ok(None);
        }
        Err(EngineError::not_ported("the engine's store", "E5.4b"))
    }

    /// The thread's resident snapshot, or a fresh load when none is held. A fold already holds
    /// one, so this never syncs a snapshot out from under the fold.
    fn input_snapshot(
        &mut self,
        core: &Core,
        thread: &str,
    ) -> Result<Option<Rc<RefCell<Snapshot>>>, EngineError> {
        if let Some(snapshot) = self.repo.snapshots.get(thread) {
            return Ok(Some(Rc::clone(snapshot)));
        }
        self.repo.state(&core.store, thread)
    }

    /// The root the fold compares a fact's agent with (`state.rootKey ?? "root"`).
    fn input_root(&mut self, core: &Core, thread: &str) -> Result<String, EngineError> {
        Ok(match self.input_snapshot(core, thread)? {
            Some(snapshot) => snapshot
                .borrow()
                .state
                .root_key
                .clone()
                .unwrap_or_else(|| "root".to_owned()),
            None => "root".to_owned(),
        })
    }

    /// `correlate` with the root and generation the caller decides: the fold passes both it
    /// knows, and the probe passes a generation of its own.
    pub fn correlate_with(
        &mut self,
        thread: &str,
        fact: Value,
        root: Option<&str>,
        generation: Option<f64>,
    ) -> Result<Option<Value>, EngineError> {
        let Some(core) = self.input_engine()? else {
            return Ok(Some(fact));
        };
        let root = match root {
            Some(root) => root.to_owned(),
            None => self.input_root(&core, thread)?,
        };
        crate::inputs::journal::correlate(core.store.conn(), thread, fact, &root, generation)
    }

    /// `bindStartedRun` with an explicit generation.
    pub fn bind_started_run_with(
        &mut self,
        thread: &str,
        run: &str,
        generation: Option<f64>,
    ) -> Result<Vec<Value>, EngineError> {
        let Some(core) = self.input_engine()? else {
            return Ok(Vec::new());
        };
        let Some(snapshot) = self.input_snapshot(&core, thread)? else {
            return Err(EngineError::MissingState);
        };
        let mut borrowed = snapshot
            .try_borrow_mut()
            .map_err(|_| EngineError::Reentrant)?;
        crate::inputs::runs::bind_started_run(&mut borrowed, core.store.conn(), run, generation)
    }

    /// `bindConsumedInput` with an explicit generation.
    pub fn bind_consumed_input_with(
        &mut self,
        thread: &str,
        key: &str,
        generation: Option<f64>,
        at: f64,
    ) -> Result<Vec<Value>, EngineError> {
        let Some(core) = self.input_engine()? else {
            return Ok(Vec::new());
        };
        let Some(snapshot) = self.input_snapshot(&core, thread)? else {
            return Err(EngineError::MissingState);
        };
        let mut borrowed = snapshot
            .try_borrow_mut()
            .map_err(|_| EngineError::Reentrant)?;
        crate::inputs::runs::bind_consumed_input(
            &mut borrowed,
            core.store.conn(),
            key,
            generation,
            at as i64,
        )
    }

    /// `inputs.keyFor`: the transcript key of the input whose send carried `native_input_id`.
    pub fn input_key_for_with(
        &mut self,
        thread: &str,
        native_input_id: &str,
    ) -> Result<Option<String>, EngineError> {
        let Some(core) = self.input_engine()? else {
            return Ok(None);
        };
        crate::inputs::journal::key_for(core.store.conn(), thread, native_input_id)
    }

    /// `aceInputs.attribute`: an echo of a settled delegation becomes its item, on the same agent.
    pub fn attribute_input_with(
        &mut self,
        thread: &str,
        fact: Value,
    ) -> Result<Value, EngineError> {
        let Some(core) = self.input_engine()? else {
            return Ok(fact);
        };
        crate::inputs::ace::attribute(core.store.conn(), thread, fact)
    }

    /// `aceWaitFact`: the `subagents.waiting` fact for a live ace wait, once per item.
    pub fn ace_wait_fact_with(
        &mut self,
        thread: &str,
        fact: &Value,
    ) -> Result<Option<Value>, EngineError> {
        let Some(core) = self.input_engine()? else {
            return Ok(None);
        };
        let Some(snapshot) = self.input_snapshot(&core, thread)? else {
            return Err(EngineError::MissingState);
        };
        let mut borrowed = snapshot
            .try_borrow_mut()
            .map_err(|_| EngineError::Reentrant)?;
        let mut touched = crate::snapshot::touched::Touched::default();
        if let Some(item) = fact.get("item").and_then(Value::as_str) {
            touched.items.insert(item.to_owned());
        }
        if let Some(agent) = fact.get("agent").and_then(Value::as_str) {
            touched.agents.insert(agent.to_owned());
        }
        borrowed.hydrate(&touched)?;
        Ok(crate::inputs::ace_waits::ace_wait_fact(
            &borrowed.state,
            fact,
        ))
    }

    /// `InputJournal.sending`: re-sign an accepted input with the provider's own rendering, as
    /// the delivery does (E5.5). The seam's probe writes this row directly.
    pub fn input_sending(
        &mut self,
        thread: &str,
        key: &str,
        parts: &[Value],
        provider: Option<&str>,
        generation: Option<f64>,
    ) -> Result<(), EngineError> {
        let Some(core) = self.input_engine()? else {
            return Ok(());
        };
        crate::inputs::journal::sending(core.store.conn(), thread, key, parts, provider, generation)
    }
}
