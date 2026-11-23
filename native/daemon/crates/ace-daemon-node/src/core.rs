// SPDX-License-Identifier: Apache-2.0
//! The core binding: values in, JSON out, never logic. Behaviour lives in
//! `ace-core`; this module translates handles and errors only. Every export
//! catches panics and turns them into JS errors.

use std::collections::{HashMap, HashSet};
use std::panic::{AssertUnwindSafe, catch_unwind};

use napi::bindgen_prelude::Function;
use napi_derive::napi;

/// One native core thread behind a handle the TypeScript shell holds.
#[napi]
pub struct CoreThreadNative {
    state: ace_core::ThreadState,
    /// The fact batches open on this thread, keyed by the id the facade was handed: a second
    /// batch must not replace the first one's deferred status.
    batches: HashMap<u32, ace_core::reduce::FactBatch>,
    next_batch: u32,
    /// Preallocated output buffer reused for every JSON response.
    buffer: String,
}

#[derive(Debug, thiserror::Error)]
pub enum CoreBindError {
    #[error("invalid thread: {0}")]
    InvalidThread(String),
    #[error("invalid fact: {0}")]
    InvalidFact(String),
    #[error("invalid context: {0}")]
    InvalidContext(String),
    #[error("core contract: {0}")]
    Contract(String),
}

impl From<CoreBindError> for napi::Error {
    fn from(error: CoreBindError) -> Self {
        napi::Error::from_reason(error.to_string())
    }
}

pub struct NextId<'a> {
    next: &'a Function<'a, String, String>,
    failure: Option<String>,
}

impl ace_core::state::IdSource for NextId<'_> {
    fn next(&mut self, kind: &str) -> Option<String> {
        if self.failure.is_some() {
            return None;
        }
        match self.next.call(kind.to_owned()) {
            Ok(id) => Some(id),
            Err(error) => {
                self.failure = Some(error.to_string());
                None
            }
        }
    }
}

/// One fold's answer, written straight into the reused buffer: its events, and the state's own
/// field order so the facade's view has exactly the fields the state has. The state's bytes are
/// not sent: the facade re-reads them through `snapshot()` when TypeScript looks at a field.
pub fn write_response(
    buffer: &mut String,
    state: &ace_core::ThreadState,
    events: &[ace_core::emit::Event],
) {
    buffer.clear();
    buffer.push_str("{\"events\":");
    ace_core::event_json::write_events(events, buffer);
    buffer.push_str(",\"fields\":[");
    for (index, field) in ace_core::state_json::field_order(state).iter().enumerate() {
        if index > 0 {
            buffer.push(',');
        }
        ace_json::write_str(buffer, field);
    }
    buffer.push_str("]}");
}

/// Finish one fold: the ids callback's failure wins, then the fold's own outcome.
pub fn finish_fold(ids: NextId<'_>, outcome: Option<()>) -> Result<(), CoreBindError> {
    if let Some(failure) = ids.failure {
        return Err(CoreBindError::Contract(failure));
    }
    outcome.ok_or_else(|| CoreBindError::Contract("fold failed".to_owned()))?;
    Ok(())
}

pub fn to_millis(now: f64) -> Result<i64, CoreBindError> {
    if !now.is_finite() || now.fract() != 0.0 {
        return Err(CoreBindError::InvalidContext(
            "now must be a nonnegative integer".to_owned(),
        ));
    }
    if !(0.0..=9_007_199_254_740_991.0).contains(&now) {
        return Err(CoreBindError::InvalidContext(
            "now must be a nonnegative integer".to_owned(),
        ));
    }
    Ok(now as i64)
}

pub fn parse_state(text: &str) -> Result<ace_core::ThreadState, CoreBindError> {
    // One decoder for both loaders: ace-json's numbers and key order, never serde_json's.
    ace_core::json_io::parse_typed(text)
        .map_err(|error| CoreBindError::InvalidThread(error.to_string()))
}

pub fn parse_fact(text: &str) -> Result<ace_json::Value, CoreBindError> {
    ace_core::json_io::parse_untrusted(text)
        .map_err(|error| CoreBindError::InvalidFact(error.to_string()))
}

/// The engine's answer RPCs in flight, as the fold's context carries them.
fn parse_resolving(json: Option<&str>) -> Result<Option<HashSet<String>>, CoreBindError> {
    match json {
        None => Ok(None),
        Some(text) => {
            let ids: Vec<String> = ace_core::json_io::parse_typed(text)
                .map_err(|error| CoreBindError::InvalidContext(error.to_string()))?;
            Ok(Some(ids.into_iter().collect()))
        }
    }
}

#[napi]
impl CoreThreadNative {
    /// Create a thread state; mirrors `createThreadState`.
    #[napi(constructor, catch_unwind)]
    pub fn new(
        thread_id: String,
        config_json: String,
        root_json: Option<String>,
    ) -> napi::Result<Self> {
        let result = catch_unwind(AssertUnwindSafe(|| {
            create_inner(&thread_id, &config_json, root_json.as_deref())
        }));
        match result {
            Ok(Ok(state)) => Ok(Self::with_state(state)),
            Ok(Err(error)) => Err(error.into()),
            Err(_) => Err(napi::Error::from_reason("core thread failed to start")),
        }
    }

    /// Import a snapshot (a restored or cloned state) behind a fresh handle.
    #[napi(factory, catch_unwind)]
    pub fn from_state(state_json: String) -> napi::Result<Self> {
        let result = catch_unwind(AssertUnwindSafe(|| parse_state(&state_json)));
        match result {
            Ok(Ok(state)) => Ok(Self::with_state(state)),
            Ok(Err(error)) => Err(error.into()),
            Err(_) => Err(napi::Error::from_reason("core thread failed to import")),
        }
    }

    /// Write one top-level state field, the way `state[key] = value` does in TypeScript: the
    /// handle keeps it, so the next fold is computed from it.
    #[napi(catch_unwind)]
    pub fn set_field(&mut self, field: String, json: String) -> napi::Result<()> {
        let result = catch_unwind(AssertUnwindSafe(|| {
            set_field(&mut self.state, &field, &json)
        }));
        match result {
            Ok(Ok(())) => Ok(()),
            Ok(Err(error)) => Err(error.into()),
            Err(_) => Err(napi::Error::from_reason("core field write panicked")),
        }
    }

    /// Adopt a seeded state: the engine built it as plain data before folding on it.
    #[napi(catch_unwind)]
    pub fn adopt(&mut self, state_json: String) -> napi::Result<()> {
        let result = catch_unwind(AssertUnwindSafe(|| parse_state(&state_json)));
        match result {
            Ok(Ok(state)) => {
                self.state = state;
                Ok(())
            }
            Ok(Err(error)) => Err(error.into()),
            Err(_) => Err(napi::Error::from_reason("core state failed to load")),
        }
    }

    /// Fold one fact, returning its events and the state's field order as JSON.
    #[napi(catch_unwind)]
    pub fn apply(
        &mut self,
        fact_json: String,
        now: f64,
        next_id: Function<String, String>,
        resolving_json: Option<String>,
    ) -> napi::Result<String> {
        let result = catch_unwind(AssertUnwindSafe(|| {
            let now = to_millis(now)?;
            let fact = parse_fact(&fact_json)?;
            let resolving = parse_resolving(resolving_json.as_deref())?;
            let mut ids = NextId {
                next: &next_id,
                failure: None,
            };
            let mut ctx = ace_core::state::ApplyContext {
                now,
                ids: &mut ids,
                resolving_interactions: resolving,
            };
            let mut events = Vec::new();
            let outcome = ace_core::reduce::apply(&mut self.state, &fact, &mut ctx, &mut events);
            finish_fold(ids, outcome)?;
            Ok::<Vec<ace_core::emit::Event>, CoreBindError>(events)
        }));
        let events = match result {
            Ok(Ok(events)) => events,
            Ok(Err(error)) => return Err(error.into()),
            Err(_) => return Err(napi::Error::from_reason("core apply panicked")),
        };
        write_response(&mut self.buffer, &self.state, &events);
        Ok(std::mem::take(&mut self.buffer))
    }

    /// Reject a fact JSON cannot carry, described by the facade exactly as the TypeScript does.
    #[napi(catch_unwind)]
    pub fn reject(
        &mut self,
        data_json: String,
        reason: String,
        now: f64,
        next_id: Function<String, String>,
    ) -> napi::Result<String> {
        let result = catch_unwind(AssertUnwindSafe(|| {
            let now = to_millis(now)?;
            let data = parse_fact(&data_json)?;
            let mut ids = NextId {
                next: &next_id,
                failure: None,
            };
            let mut ctx = ace_core::state::ApplyContext {
                now,
                ids: &mut ids,
                resolving_interactions: None,
            };
            let mut events = Vec::new();
            let outcome = ace_core::diagnostics::reject_data(
                &mut self.state,
                &data,
                &reason,
                &mut ctx,
                &mut events,
            );
            finish_fold(ids, outcome)?;
            Ok::<Vec<ace_core::emit::Event>, CoreBindError>(events)
        }));
        let events = match result {
            Ok(Ok(events)) => events,
            Ok(Err(error)) => return Err(error.into()),
            Err(_) => return Err(napi::Error::from_reason("core reject panicked")),
        };
        write_response(&mut self.buffer, &self.state, &events);
        Ok(std::mem::take(&mut self.buffer))
    }

    /// Start one fact batch over this thread; the id names it for the facade.
    #[napi(catch_unwind)]
    pub fn batch_begin(&mut self, deadline_json: Option<String>) -> napi::Result<u32> {
        let result = catch_unwind(AssertUnwindSafe(|| {
            let deadline = match deadline_json {
                None => None,
                Some(text) => {
                    let deadline: Option<i64> = ace_core::json_io::parse_typed(&text)
                        .map_err(|error| CoreBindError::InvalidContext(error.to_string()))?;
                    Some(deadline)
                }
            };
            Ok::<ace_core::reduce::FactBatch, CoreBindError>(ace_core::reduce::FactBatch::new(
                deadline,
            ))
        }));
        match result {
            Ok(Ok(batch)) => {
                let id = self.next_batch;
                self.next_batch = self.next_batch.wrapping_add(1);
                self.batches.insert(id, batch);
                Ok(id)
            }
            Ok(Err(error)) => Err(error.into()),
            Err(_) => Err(napi::Error::from_reason("core batch failed to start")),
        }
    }

    /// Fold one fact of one of this thread's batches.
    #[napi(catch_unwind)]
    pub fn batch_apply(
        &mut self,
        batch_id: u32,
        fact_json: String,
        now: f64,
        next_id: Function<String, String>,
        resolving_json: Option<String>,
    ) -> napi::Result<String> {
        let result = catch_unwind(AssertUnwindSafe(|| {
            let now = to_millis(now)?;
            let fact = parse_fact(&fact_json)?;
            let resolving = parse_resolving(resolving_json.as_deref())?;
            let mut ids = NextId {
                next: &next_id,
                failure: None,
            };
            let mut ctx = ace_core::state::ApplyContext {
                now,
                ids: &mut ids,
                resolving_interactions: resolving,
            };
            let mut events = Vec::new();
            let batch = self
                .batches
                .get_mut(&batch_id)
                .ok_or_else(|| CoreBindError::Contract("no batch began with this id".to_owned()))?;
            let outcome = batch.apply(&mut self.state, &fact, &mut ctx, &mut events);
            finish_fold(ids, outcome)?;
            Ok::<Vec<ace_core::emit::Event>, CoreBindError>(events)
        }));
        let events = match result {
            Ok(Ok(events)) => events,
            Ok(Err(error)) => return Err(error.into()),
            Err(_) => return Err(napi::Error::from_reason("core batch apply panicked")),
        };
        write_response(&mut self.buffer, &self.state, &events);
        Ok(std::mem::take(&mut self.buffer))
    }

    /// Derive one batch's deferred status.
    #[napi(catch_unwind)]
    pub fn batch_flush(&mut self, batch_id: u32) -> napi::Result<String> {
        let result = catch_unwind(AssertUnwindSafe(|| {
            let batch = self
                .batches
                .get_mut(&batch_id)
                .ok_or_else(|| CoreBindError::Contract("no batch began with this id".to_owned()))?;
            Ok::<Vec<ace_core::emit::Event>, CoreBindError>(batch.flush(&mut self.state))
        }));
        let events = match result {
            Ok(Ok(events)) => events,
            Ok(Err(error)) => return Err(error.into()),
            Err(_) => return Err(napi::Error::from_reason("core batch flush panicked")),
        };
        write_response(&mut self.buffer, &self.state, &events);
        Ok(std::mem::take(&mut self.buffer))
    }

    /// Reject a fact JSON cannot carry, as part of one open batch: the batch's own deferred
    /// status flushes first, as it does for a fact it accepts.
    #[napi(catch_unwind)]
    pub fn batch_reject(
        &mut self,
        batch_id: u32,
        data_json: String,
        reason: String,
        now: f64,
        next_id: Function<String, String>,
    ) -> napi::Result<String> {
        let result = catch_unwind(AssertUnwindSafe(|| {
            let now = to_millis(now)?;
            let data = parse_fact(&data_json)?;
            let mut ids = NextId {
                next: &next_id,
                failure: None,
            };
            let mut ctx = ace_core::state::ApplyContext {
                now,
                ids: &mut ids,
                resolving_interactions: None,
            };
            let mut events = Vec::new();
            let batch = self
                .batches
                .get_mut(&batch_id)
                .ok_or_else(|| CoreBindError::Contract("no batch began with this id".to_owned()))?;
            let outcome = batch.reject(&mut self.state, &data, &reason, &mut ctx, &mut events);
            finish_fold(ids, outcome)?;
            Ok::<Vec<ace_core::emit::Event>, CoreBindError>(events)
        }));
        let events = match result {
            Ok(Ok(events)) => events,
            Ok(Err(error)) => return Err(error.into()),
            Err(_) => return Err(napi::Error::from_reason("core batch reject panicked")),
        };
        write_response(&mut self.buffer, &self.state, &events);
        Ok(std::mem::take(&mut self.buffer))
    }

    /// The state's own key order, for a fold that failed before answering with one.
    #[napi(catch_unwind)]
    pub fn fields(&self) -> Vec<String> {
        ace_core::state_json::field_order(&self.state)
            .into_iter()
            .map(str::to_owned)
            .collect()
    }

    /// Read the whole thread state back as JSON, for the facade's refresh.
    #[napi(catch_unwind)]
    pub fn snapshot(&self) -> napi::Result<String> {
        let result = catch_unwind(AssertUnwindSafe(|| {
            ace_json::ser::to_string(&self.state).map_err(|error| error.to_string())
        }));
        match result {
            Ok(Ok(json)) => Ok(json),
            Ok(Err(error)) => Err(napi::Error::from_reason(error)),
            Err(_) => Err(napi::Error::from_reason("core snapshot panicked")),
        }
    }
}

impl CoreThreadNative {
    fn with_state(state: ace_core::ThreadState) -> Self {
        Self {
            state,
            batches: HashMap::new(),
            next_batch: 0,
            buffer: String::with_capacity(65536),
        }
    }
}

/// Assign one field of the state from JSON, keeping the state's own insertion order for a field
/// the fold had not set yet (a written field is appended, as `state[key] = value` appends it).
fn set_field(
    state: &mut ace_core::ThreadState,
    field: &str,
    json: &str,
) -> Result<(), CoreBindError> {
    let value = ace_core::json_io::parse_untrusted(json)
        .map_err(|error| CoreBindError::InvalidContext(error.to_string()))?;
    fn decode<T: serde::de::DeserializeOwned>(
        value: &ace_core::json_io::Json,
        name: &str,
    ) -> Result<T, CoreBindError> {
        ace_core::json_io::decode(value)
            .map_err(|error| CoreBindError::InvalidContext(format!("{name}: {error}")))
    }
    match field {
        "threadId" => state.thread_id = decode(&value, field)?,
        "config" => {
            let config: ace_core::state::CoreConfig = decode(&value, field)?;
            ace_core::state::validate_config(&config)
                .map_err(|error| CoreBindError::InvalidContext(error.to_string()))?;
            state.config = config;
        }
        "rootKey" => {
            state.root_key = decode(&value, field)?;
            state.appended("rootKey");
        }
        "initialRoot" => state.initial_root = decode(&value, field)?,
        "processExit" => {
            state.process_exit = decode(&value, field)?;
            state.appended("processExit");
        }
        "lastTransportSignalAt" => {
            state.last_transport_signal_at = decode(&value, field)?;
            state.appended("lastTransportSignalAt");
        }
        "statusObservedAt" => {
            state.status_observed_at = decode(&value, field)?;
            state.appended("statusObservedAt");
        }
        "agents" => state.agents = decode(&value, field)?,
        "runs" => state.runs = decode(&value, field)?,
        "items" => state.items = decode(&value, field)?,
        "interactions" => state.interactions = decode(&value, field)?,
        "tasks" => state.tasks = decode(&value, field)?,
        "uncertainTasks" => state.uncertain_tasks = decode(&value, field)?,
        "personTasks" => {
            state.person_tasks = decode(&value, field)?;
            state.appended("personTasks");
        }
        "interactionHistory" => state.interaction_history = decode(&value, field)?,
        "taskHistory" => state.task_history = decode(&value, field)?,
        "indexes" => state.indexes = decode(&value, field)?,
        "outcomeOrder" => state.outcome_order = decode(&value, field)?,
        "runSeq" => {
            state.run_seq = decode(&value, field)?;
            state.appended("runSeq");
        }
        "pendingNotices" => state.pending_notices = decode(&value, field)?,
        "rejectionNotices" => {
            state.rejection_notices = decode(&value, field)?;
            state.appended("rejectionNotices");
        }
        "itemLinks" => state.item_links = decode(&value, field)?,
        "queueCount" => state.queue_count = decode(&value, field)?,
        "queueSources" => state.queue_sources = decode(&value, field)?,
        "queueHeld" => {
            state.queue_held = decode(&value, field)?;
            state.appended("queueHeld");
        }
        "queueStopped" => {
            state.queue_stopped = decode(&value, field)?;
            state.appended("queueStopped");
        }
        "hasRun" => state.has_run = decode(&value, field)?,
        "movedTo" => {
            state.moved_to = decode(&value, field)?;
            state.appended("movedTo");
        }
        "status" => state.status = decode(&value, field)?,
        other => {
            return Err(CoreBindError::InvalidContext(format!(
                "unknown state field: {other}"
            )));
        }
    }
    Ok(())
}

fn create_inner(
    thread_id: &str,
    config_json: &str,
    root_json: Option<&str>,
) -> Result<ace_core::ThreadState, CoreBindError> {
    let config: ace_core::state::CoreConfig = ace_core::json_io::parse_typed(config_json)
        .map_err(|error| CoreBindError::InvalidThread(error.to_string()))?;
    let root = match root_json {
        None => None,
        Some(text) => Some(
            ace_core::json_io::parse_typed(text)
                .map_err(|error| CoreBindError::InvalidThread(error.to_string()))?,
        ),
    };
    ace_core::state::create_thread_state(thread_id.to_owned(), root, config)
        .map_err(|error| CoreBindError::InvalidThread(error.to_string()))
}
