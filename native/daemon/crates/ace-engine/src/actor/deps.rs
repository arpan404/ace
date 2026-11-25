// SPDX-License-Identifier: Apache-2.0
//! The actor's dependencies are two traits, not engine modules (E5.2 decision 1). The actor calls
//! the repository (E5.3), the queue (E5.4), delivery (E5.5), sessions (E5.6) and recovery (E5.8)
//! at fixed points. Each method is mapped to its TypeScript line and owner, so each later owner
//! replaces only its methods' bodies.

use crate::actor::FrameRef;
use crate::frames::live::LiveStore;
use crate::futures::channel::oneshot;
use crate::{Core, EngineError, ThreadId};
use ace_json::Value;
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

/// Where a thread's frames go: its provider and backend (`index.ts:371`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Route {
    pub provider: String,
    pub backend: Option<String>,
}

/// What `schedule` reads from the stored state (`index.ts:537`–`:545`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScheduleView {
    pub done: bool,
    pub left_running: bool,
}

/// What the repository reads and writes for one actor.
#[allow(clippy::too_many_arguments)]
pub trait ActorRepo {
    /// `repo.requireState(id).status` (`actor.ts:375`, `:400`).
    fn status(&self, core: &Core, thread: &ThreadId) -> Result<Value, EngineError>;
    /// `requireState(id).config.provider`, `repo.backend(id)` (`actor.ts:371`).
    fn route(&self, core: &Core, thread: &ThreadId) -> Result<Route, EngineError>;
    /// `repo.quiescent(requireState(id))` (`actor.ts:461`).
    fn quiescent(&self, core: &Core, thread: &ThreadId) -> Result<bool, EngineError>;
    /// `hasRunningForegroundCommand` (`core/src/steering.ts:26`).
    fn running_foreground_command(
        &self,
        core: &Core,
        thread: &ThreadId,
    ) -> Result<bool, EngineError>;
    /// `repo.stream` (`repository.ts:363`).
    fn stream(
        &self,
        core: &Core,
        thread: &ThreadId,
        facts: &[Value],
        now: f64,
    ) -> Result<bool, EngineError>;
    /// `repo.apply` (`repository.ts:413`).
    fn apply(
        &self,
        core: &Core,
        thread: &ThreadId,
        facts: &[Value],
        now: f64,
        generation: u64,
    ) -> Result<(), EngineError>;
    /// `repo.deadline` (`actor.ts:552`).
    fn deadline(
        &self,
        core: &Core,
        thread: &ThreadId,
        translator: Option<i64>,
    ) -> Result<Option<f64>, EngineError>;
    /// `repo.state(id)`, narrowed to what `schedule` reads (`:537`).
    fn schedule_view(
        &self,
        core: &Core,
        thread: &ThreadId,
    ) -> Result<Option<ScheduleView>, EngineError>;
    /// `repo.evict` (`actor.ts:279`, `:524`).
    fn evict(&self, core: &Core, thread: &ThreadId);
    /// `repo.clearIncompleteBlobs` (`actor.ts:524`).
    fn clear_incomplete_blobs(&self, core: &Core, thread: &ThreadId);
    /// `index.ts:856`–`:859`.
    fn root_agent_id(&self, core: &Core, thread: &ThreadId) -> Result<Option<String>, EngineError>;
    /// `repo.engineQueueFact` (`actor.ts:518`).
    fn engine_queue_fact(
        &self,
        core: &Core,
        thread: &ThreadId,
    ) -> Result<Option<Value>, EngineError>;
    /// `repo.queue.get(id).paused` (`actor.ts:470`).
    fn queue_paused(&self, core: &Core, thread: &ThreadId) -> Result<bool, EngineError>;
    /// `repo.queuedCount` (`index.ts:799`).
    fn queued_count(&self, core: &Core, thread: &ThreadId) -> Result<u64, EngineError>;
    /// `max(pending.latestGeneration, interactions.latestGeneration)` (`index.ts:556`).
    fn latest_generation(&self, core: &Core, thread: &ThreadId) -> Result<u64, EngineError>;
    /// `markYieldedEnd` (`actor.ts:466`–`:472`).
    fn mark_yielded_end(
        &self,
        core: &Core,
        thread: &ThreadId,
        facts: Vec<Value>,
    ) -> Result<Vec<Value>, EngineError>;
    /// `repo.session(id).instanceId` (`actor.ts:498`).
    fn session_instance(
        &self,
        core: &Core,
        thread: &ThreadId,
    ) -> Result<Option<String>, EngineError>;
    /// A reserved `engine_slots` row (`index.ts:533`).
    fn reserved_slot(&self, core: &Core, thread: &ThreadId) -> Result<bool, EngineError>;
    /// How many threads hold a reserved slot (`index.ts:533`–`:536`).
    fn retiring_count(&self, core: &Core) -> Result<usize, EngineError>;
    /// `releasedThread(getThread(id))` (`index.ts:555`).
    fn released_thread(&self, core: &Core, thread: &ThreadId) -> Result<bool, EngineError>;
    /// `repo.attachments.get(id, hash)` (`actor.ts:513`): E5.3's `Correlations::get`.
    fn attachment(
        &self,
        core: &Core,
        thread: &ThreadId,
        hash: &str,
    ) -> Result<Option<Value>, EngineError>;
    /// `writeCursorRecord` (`actor.ts:475`–`:491`), only with a non-empty journal.
    fn cursor_record(
        &self,
        core: &Core,
        thread: &ThreadId,
        entries: &[Value],
    ) -> Result<(), EngineError>;
}

/// What the actor causes elsewhere.
pub trait ActorLinks {
    /// `() => this.wake(id)` (`index.ts:547`, `:1256`).
    fn wake(&self, core: &Core, thread: &ThreadId);
    /// `lifetime.abort()`; with `true` also `session = translator = undefined` (`:206`).
    fn abort_session(&self, core: &Core, thread: &ThreadId, drop_session: bool);
    /// `onRetire` → `delivery.expire` (`index.ts:553`).
    fn expire(&self, core: &Core, thread: &ThreadId, generation: u64);
    /// `onProviderDiagnostic` (`:495`).
    fn diagnostic(&self, core: &Core, thread: &ThreadId, raw: &[Value]);
    /// Each lease's `release()` (`:159`–`:163`).
    fn release_leases(&self, core: &Core, tokens: &[u64]);
}

/// One frame's translation, as the batch helper returned it.
#[derive(Debug, Default, Clone)]
pub struct TranslatedFrame {
    pub facts: Vec<Value>,
    pub diagnostics: Vec<Value>,
    /// The whole frame, for the Cursor SDK journal (`actor.ts:475`–`:491`) only.
    pub frame: Option<Value>,
    /// The frame's own account, when it has one: `{id, billingMode}`.
    pub usage_account: Option<Value>,
}

/// A JavaScript translator, called once per batch (`engine/js_translator.rs`).
pub trait JsBatchTranslator {
    fn translate_batch(
        &mut self,
        frames: &[&FrameRef],
        now: f64,
    ) -> Result<Vec<TranslatedFrame>, EngineError>;
    fn tick(&mut self, now: f64) -> Result<Vec<Value>, EngineError>;
    fn next_deadline(&mut self) -> Option<i64>;
}

/// Each actor's translator, set when a session attaches and cleared with it.
pub enum ActorTranslator {
    Js(Box<dyn JsBatchTranslator>),
    Native(Box<dyn ace_adapter_api::Translator>),
}

/// The shell's promises for frame acknowledgements: one per batch.
pub trait FrameAcks {
    /// One promise for a batch this frame starts; `None` before the shell registers any.
    fn alloc(&self) -> Option<u64>;
    fn settle(&self, call: u64, reject: Option<String>);
}

/// Before the shell registers its promises, a settlement is reported, never silent.
pub struct UnportedAcks;

impl FrameAcks for UnportedAcks {
    fn alloc(&self) -> Option<u64> {
        None
    }

    fn settle(&self, _call: u64, reject: Option<String>) {
        if let Some(message) = reject {
            eprintln!("engine frame acknowledgement settled with no shell promise: {message}");
        }
    }
}

/// The actor's dependencies: what it reads, what it causes, and the store's live buffer.
pub struct ActorDeps {
    pub repo: Rc<dyn ActorRepo>,
    pub links: Rc<dyn ActorLinks>,
    pub live: Rc<dyn LiveStore>,
    pub acks: Rc<dyn FrameAcks>,
    pub translators: RefCell<HashMap<ThreadId, (u64, ActorTranslator)>>,
    /// `EngineOptions.idleMs`, the release delay a done thread keeps.
    pub idle_ms: f64,
}

impl ActorDeps {
    pub fn new(
        repo: Rc<dyn ActorRepo>,
        links: Rc<dyn ActorLinks>,
        live: Rc<dyn LiveStore>,
        acks: Rc<dyn FrameAcks>,
        idle_ms: f64,
    ) -> Self {
        ActorDeps {
            repo,
            links,
            live,
            acks,
            translators: RefCell::new(HashMap::new()),
            idle_ms,
        }
    }

    /// The production dependencies: unported owners, each failing at its own call.
    pub fn production(live: Rc<dyn LiveStore>, idle_ms: f64) -> ActorDeps {
        ActorDeps::new(
            Rc::new(Unported),
            Rc::new(Unported),
            live,
            Rc::new(UnportedAcks),
            idle_ms,
        )
    }

    /// Takes the thread's translator out for one call, so no borrow is held across it.
    pub fn take_translator(&self, thread: &str) -> Option<(u64, ActorTranslator)> {
        self.translators.borrow_mut().remove(thread)
    }

    /// Puts it back only if the session is still the one that was taken out.
    pub fn return_translator(
        &self,
        thread: &str,
        generation: u64,
        translator: Option<(u64, ActorTranslator)>,
    ) {
        let Some((stored, translator)) = translator else {
            return;
        };
        let mut map = self.translators.borrow_mut();
        if map.contains_key(thread) || stored != generation {
            // The session was replaced or retired during the call; the taken translator goes.
            return;
        }
        map.insert(thread.to_string(), (stored, translator));
    }
}

/// One batch's acknowledgement: the facade promise, and one sender per native session.
#[derive(Default)]
pub struct BatchAck {
    pub js: Option<u64>,
    pub native: Vec<oneshot::Sender<Result<(), String>>>,
}

impl BatchAck {
    pub fn resolve(&mut self) {
        for sender in self.native.drain(..) {
            let _ = sender.send(Ok(()));
        }
    }

    pub fn reject(&mut self, message: &str) {
        for sender in self.native.drain(..) {
            let _ = sender.send(Err(message.to_string()));
        }
    }
}

/// Every unported method reports itself once per call, naming its owner.
pub struct Unported;

impl ActorRepo for Unported {
    fn status(&self, _core: &Core, _thread: &ThreadId) -> Result<Value, EngineError> {
        Err(EngineError::not_ported("the actor's thread status", "E5.3"))
    }
    fn route(&self, _core: &Core, _thread: &ThreadId) -> Result<Route, EngineError> {
        Err(EngineError::not_ported("the actor's thread route", "E5.3"))
    }
    fn quiescent(&self, _core: &Core, _thread: &ThreadId) -> Result<bool, EngineError> {
        Err(EngineError::not_ported(
            "the actor's quiescence check",
            "E5.3",
        ))
    }
    fn running_foreground_command(
        &self,
        _core: &Core,
        _thread: &ThreadId,
    ) -> Result<bool, EngineError> {
        Err(EngineError::not_ported(
            "the foreground-command check",
            "E5.3",
        ))
    }
    fn stream(
        &self,
        _core: &Core,
        _thread: &ThreadId,
        _facts: &[Value],
        _now: f64,
    ) -> Result<bool, EngineError> {
        Err(EngineError::not_ported("the live stream fold", "E5.3"))
    }
    fn apply(
        &self,
        _core: &Core,
        _thread: &ThreadId,
        _facts: &[Value],
        _now: f64,
        _generation: u64,
    ) -> Result<(), EngineError> {
        Err(EngineError::not_ported("the actor's fact fold", "E5.3"))
    }
    fn deadline(
        &self,
        _core: &Core,
        _thread: &ThreadId,
        _translator: Option<i64>,
    ) -> Result<Option<f64>, EngineError> {
        Err(EngineError::not_ported("the actor's deadline", "E5.3"))
    }
    fn schedule_view(
        &self,
        _core: &Core,
        _thread: &ThreadId,
    ) -> Result<Option<ScheduleView>, EngineError> {
        Err(EngineError::not_ported("the actor's schedule view", "E5.3"))
    }
    fn evict(&self, _core: &Core, _thread: &ThreadId) {}
    fn clear_incomplete_blobs(&self, _core: &Core, _thread: &ThreadId) {}
    fn root_agent_id(
        &self,
        _core: &Core,
        _thread: &ThreadId,
    ) -> Result<Option<String>, EngineError> {
        Err(EngineError::not_ported("the root agent read", "E5.3"))
    }
    fn engine_queue_fact(
        &self,
        _core: &Core,
        _thread: &ThreadId,
    ) -> Result<Option<Value>, EngineError> {
        Err(EngineError::not_ported("the engine queue fact", "E5.4"))
    }
    fn queue_paused(&self, _core: &Core, _thread: &ThreadId) -> Result<bool, EngineError> {
        Err(EngineError::not_ported("the queue pause read", "E5.4"))
    }
    fn queued_count(&self, _core: &Core, _thread: &ThreadId) -> Result<u64, EngineError> {
        Err(EngineError::not_ported("the queued count", "E5.4"))
    }
    fn latest_generation(&self, _core: &Core, _thread: &ThreadId) -> Result<u64, EngineError> {
        Err(EngineError::not_ported("the latest generation", "E5.4"))
    }
    fn mark_yielded_end(
        &self,
        _core: &Core,
        _thread: &ThreadId,
        facts: Vec<Value>,
    ) -> Result<Vec<Value>, EngineError> {
        // With no yield recorded it returns the facts unchanged, which is correct before E5.5
        // sets one.
        Ok(facts)
    }
    fn session_instance(
        &self,
        _core: &Core,
        _thread: &ThreadId,
    ) -> Result<Option<String>, EngineError> {
        Err(EngineError::not_ported("the session instance read", "E5.6"))
    }
    fn reserved_slot(&self, _core: &Core, _thread: &ThreadId) -> Result<bool, EngineError> {
        Err(EngineError::not_ported("the reserved-slot read", "E5.6"))
    }
    fn retiring_count(&self, _core: &Core) -> Result<usize, EngineError> {
        Err(EngineError::not_ported("the retiring count", "E5.6"))
    }
    fn released_thread(&self, _core: &Core, _thread: &ThreadId) -> Result<bool, EngineError> {
        Err(EngineError::not_ported("the released-thread read", "E5.3"))
    }
    fn attachment(
        &self,
        _core: &Core,
        _thread: &ThreadId,
        _hash: &str,
    ) -> Result<Option<Value>, EngineError> {
        Err(EngineError::not_ported(
            "the attachment correlation",
            "E5.3",
        ))
    }
    fn cursor_record(
        &self,
        _core: &Core,
        _thread: &ThreadId,
        _entries: &[Value],
    ) -> Result<(), EngineError> {
        Err(EngineError::not_ported("the Cursor frame record", "E5.8"))
    }
}

impl ActorLinks for Unported {
    fn wake(&self, core: &Core, _thread: &ThreadId) {
        core.ports
            .report(EngineError::not_ported("the actor wake", "E5.4").to_string());
    }
    fn abort_session(&self, core: &Core, _thread: &ThreadId, drop_session: bool) {
        let what = if drop_session {
            "the session abort with its session dropped"
        } else {
            "the session abort"
        };
        core.ports
            .report(EngineError::not_ported(what, "E5.6").to_string());
    }
    fn expire(&self, core: &Core, _thread: &ThreadId, _generation: u64) {
        core.ports
            .report(EngineError::not_ported("the delivery expiry", "E5.5").to_string());
    }
    fn diagnostic(&self, core: &Core, _thread: &ThreadId, _raw: &[Value]) {
        core.ports
            .report(EngineError::not_ported("the provider diagnostic", "E5.6").to_string());
    }
    fn release_leases(&self, core: &Core, _tokens: &[u64]) {
        core.ports
            .report(EngineError::not_ported("the input lease release", "E5.5").to_string());
    }
}
