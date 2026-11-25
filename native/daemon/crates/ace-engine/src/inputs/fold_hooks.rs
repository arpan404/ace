// SPDX-License-Identifier: Apache-2.0
//! E5.3's `InputFacts`, implemented for 4b's methods: the input journal's correlation, ace-input
//! attribution, an ace wait's fact, and the run binding of consumed and started runs. The trait
//! is declared in E5.3's `collaborators.rs`; this block states 4b's methods, and the ones 4a and
//! E5.5 own keep the trait's `NotPorted` defaults until they land.
//!
//! The fold calls these on the `State` it is folding, so the resident snapshot is reached through
//! `State.repo` without a second borrow of the engine: the TypeScript hands `ThreadState` in.

use ace_json::Value;
use std::cell::RefCell;
use std::rc::Rc;

use crate::repository::collaborators::InputFacts;
use crate::snapshot::Snapshot;
use crate::{Core, EngineError, State};

impl State {
    /// The engine this state belongs to. `Ok(None)` is E5.3's probe on a bare `State`; a plain
    /// `State` with no probe fails at the call.
    fn engine(&self) -> Result<Option<Rc<Core>>, EngineError> {
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
    fn snapshot(
        &mut self,
        core: &Core,
        thread: &str,
    ) -> Result<Option<Rc<RefCell<Snapshot>>>, EngineError> {
        if let Some(snapshot) = self.repo.snapshots.get(thread) {
            return Ok(Some(Rc::clone(snapshot)));
        }
        self.repo.state(&core.store, thread)
    }

    /// The root the fold compares a fact's agent with, and the session generation its echo may
    /// match: `ports.opening ? undefined : generation` (`provider-facts.ts:97`-`:101`).
    fn fold_view(
        &mut self,
        core: &Core,
        thread: &str,
    ) -> Result<(String, Option<f64>), EngineError> {
        let root = match self.snapshot(core, thread)? {
            Some(snapshot) => snapshot
                .borrow()
                .state
                .root_key
                .clone()
                .unwrap_or_else(|| "root".to_owned()),
            None => "root".to_owned(),
        };
        let generation = if self.repo.opening.contains(thread) {
            None
        } else {
            self.actors
                .by_thread
                .get(thread)
                .map(|actor| actor.generation as f64)
        };
        Ok((root, generation))
    }

    /// `correlate` with the parts the fold derives, for the probe to pass explicitly.
    pub fn correlate_with(
        &mut self,
        thread: &str,
        fact: Value,
        root: &str,
        generation: Option<f64>,
    ) -> Result<Option<Value>, EngineError> {
        let Some(core) = self.engine()? else {
            return Ok(Some(fact));
        };
        crate::inputs::journal::correlate(core.store.conn(), thread, fact, root, generation)
    }

    /// `bindStartedRun` with an explicit generation.
    pub fn bind_started_run_with(
        &mut self,
        thread: &str,
        run: &str,
        generation: Option<f64>,
    ) -> Result<Vec<Value>, EngineError> {
        let Some(core) = self.engine()? else {
            return Ok(Vec::new());
        };
        let Some(snapshot) = self.snapshot(&core, thread)? else {
            return Ok(Vec::new());
        };
        let mut borrowed = snapshot.borrow_mut();
        crate::inputs::runs::bind_started_run(
            &mut borrowed.state,
            core.store.conn(),
            run,
            generation,
        )
    }

    /// `bindConsumedInput` with an explicit generation.
    pub fn bind_consumed_input_with(
        &mut self,
        thread: &str,
        key: &str,
        generation: Option<f64>,
        at: f64,
    ) -> Result<Vec<Value>, EngineError> {
        let Some(core) = self.engine()? else {
            return Ok(Vec::new());
        };
        let Some(snapshot) = self.snapshot(&core, thread)? else {
            return Ok(Vec::new());
        };
        let mut borrowed = snapshot.borrow_mut();
        crate::inputs::runs::bind_consumed_input(
            &mut borrowed.state,
            core.store.conn(),
            key,
            generation,
            at as i64,
        )
    }
}

impl InputFacts for State {
    /// `inputs.correlate` (`input-journal.ts:224`). `None` drops the fact.
    fn correlate(&mut self, thread: &str, fact: Value) -> Result<Option<Value>, EngineError> {
        let Some(core) = self.engine()? else {
            return Ok(Some(fact));
        };
        let (root, generation) = self.fold_view(&core, thread)?;
        crate::inputs::journal::correlate(core.store.conn(), thread, fact, &root, generation)
    }

    /// `inputs.keyFor` (`:157`).
    fn input_key_for(
        &mut self,
        thread: &str,
        native_input_id: &str,
    ) -> Result<Option<String>, EngineError> {
        let Some(core) = self.engine()? else {
            return Ok(None);
        };
        crate::inputs::journal::key_for(core.store.conn(), thread, native_input_id)
    }

    /// `aceInputs.attribute` (`ace-inputs.ts:31`).
    fn attribute_input(&mut self, thread: &str, fact: Value) -> Result<Value, EngineError> {
        let Some(core) = self.engine()? else {
            return Ok(fact);
        };
        crate::inputs::ace::attribute(core.store.conn(), thread, fact)
    }

    /// `aceWaitFact` (`ace-waits.ts:10`).
    fn ace_wait_fact(&mut self, thread: &str, fact: &Value) -> Result<Option<Value>, EngineError> {
        let Some(core) = self.engine()? else {
            return Ok(None);
        };
        let Some(snapshot) = self.snapshot(&core, thread)? else {
            return Ok(None);
        };
        let state = snapshot.borrow();
        Ok(crate::inputs::ace_waits::ace_wait_fact(&state.state, fact))
    }

    /// `bindConsumedInput` (`transcript-inputs.ts:176`): the generation is the session's own.
    fn bind_consumed_input(
        &mut self,
        thread: &str,
        key: &str,
        generation: Option<f64>,
        now: f64,
    ) -> Result<Vec<Value>, EngineError> {
        self.bind_consumed_input_with(thread, key, generation, now)
    }

    /// `bindStartedRun` (`transcript-inputs.ts:157`).
    fn bind_started_run(
        &mut self,
        thread: &str,
        run: &str,
        generation: Option<f64>,
    ) -> Result<Vec<Value>, EngineError> {
        self.bind_started_run_with(thread, run, generation)
    }
}
