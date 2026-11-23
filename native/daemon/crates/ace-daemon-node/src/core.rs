// SPDX-License-Identifier: Apache-2.0
//! The core binding: values in, JSON out, never logic. Behaviour lives in
//! `ace-core`; this module translates handles and errors only. Every export
//! catches panics and turns them into JS errors.

use std::panic::{AssertUnwindSafe, catch_unwind};

use napi::bindgen_prelude::Function;
use napi_derive::napi;

/// One native core thread behind a handle the TypeScript shell holds.
#[napi]
pub struct CoreThreadNative {
    state: ace_core::ThreadState,
    batch: Option<ace_core::reduce::FactBatch>,
    /// Preallocated output buffer reused for every JSON response.
    buffer: Vec<u8>,
}

#[derive(Debug, thiserror::Error)]
enum CoreBindError {
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

struct NextId<'a> {
    next: &'a Function<'a, String, String>,
    failure: Option<String>,
}

#[derive(serde::Serialize)]
struct CoreResponse<'a> {
    events: &'a [ace_core::emit::Event],
    state: &'a ace_core::ThreadState,
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

fn to_millis(now: f64) -> Result<i64, CoreBindError> {
    if !now.is_finite() || now.fract() != 0.0 {
        return Err(CoreBindError::InvalidContext(
            "now must be a nonnegative integer".to_owned(),
        ));
    }
    if now < 0.0 || now > 9_007_199_254_740_991.0 {
        return Err(CoreBindError::InvalidContext(
            "now must be a nonnegative integer".to_owned(),
        ));
    }
    Ok(now as i64)
}

fn parse_state(text: &str) -> Result<ace_core::ThreadState, CoreBindError> {
    serde_json::from_str(text).map_err(|error| CoreBindError::InvalidThread(error.to_string()))
}

fn parse_fact(text: &str) -> Result<ace_json::Value, CoreBindError> {
    ace_core::json_io::parse_untrusted(text)
        .map_err(|error| CoreBindError::InvalidFact(error.to_string()))
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
            Ok(Ok(state)) => Ok(Self {
                state,
                batch: None,
                buffer: Vec::with_capacity(65536),
            }),
            Ok(Err(error)) => Err(error.into()),
            Err(_) => Err(napi::Error::from_reason("core thread failed to start")),
        }
    }

    /// Import a snapshot (a restored or cloned state) behind a fresh handle.
    #[napi(factory, catch_unwind)]
    pub fn from_state(state_json: String) -> napi::Result<Self> {
        let result = catch_unwind(AssertUnwindSafe(|| parse_state(&state_json)));
        match result {
            Ok(Ok(state)) => Ok(Self {
                state,
                batch: None,
                buffer: Vec::with_capacity(65536),
            }),
            Ok(Err(error)) => Err(error.into()),
            Err(_) => Err(napi::Error::from_reason("core thread failed to import")),
        }
    }

    /// Fold one fact, returning events and the refreshed state as JSON.
    #[napi(catch_unwind)]
    pub fn apply(
        &mut self,
        fact_json: String,
        now: f64,
        next_id: Function<String, String>,
    ) -> napi::Result<String> {
        let result = catch_unwind(AssertUnwindSafe(|| {
            let now = to_millis(now)?;
            let fact = parse_fact(&fact_json)?;
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
            let outcome = ace_core::reduce::apply(&mut self.state, &fact, &mut ctx, &mut events);
            if let Some(failure) = ids.failure {
                return Err(CoreBindError::Contract(failure));
            }
            outcome.ok_or_else(|| CoreBindError::Contract("fold failed".to_owned()))?;
            Ok::<Vec<ace_core::emit::Event>, CoreBindError>(events)
        }));
        let events = match result {
            Ok(Ok(events)) => events,
            Ok(Err(error)) => return Err(error.into()),
            Err(_) => return Err(napi::Error::from_reason("core apply panicked")),
        };
        self.buffer.clear();
        let response = CoreResponse {
            events: &events,
            state: &self.state,
        };
        ace_core::json_io::write_json(&mut self.buffer, &response)
            .map_err(|error| CoreBindError::Contract(error.to_string()))?;
        String::from_utf8(std::mem::take(&mut self.buffer))
            .map_err(|error| napi::Error::from_reason(error.to_string()))
    }

    /// Start one fact batch over this thread.
    #[napi(catch_unwind)]
    pub fn batch_begin(&mut self, deadline_json: Option<String>) -> napi::Result<()> {
        let result = catch_unwind(AssertUnwindSafe(|| {
            let deadline = match deadline_json {
                None => None,
                Some(text) => {
                    let deadline: Option<i64> = serde_json::from_str(&text)
                        .map_err(|error| CoreBindError::InvalidContext(error.to_string()))?;
                    Some(deadline)
                }
            };
            self.batch = Some(ace_core::reduce::FactBatch::new(deadline));
            Ok::<(), CoreBindError>(())
        }));
        match result {
            Ok(Ok(())) => Ok(()),
            Ok(Err(error)) => Err(error.into()),
            Err(_) => Err(napi::Error::from_reason("core batch failed to start")),
        }
    }

    /// Fold one fact of this thread's batch.
    #[napi(catch_unwind)]
    pub fn batch_apply(
        &mut self,
        fact_json: String,
        now: f64,
        next_id: Function<String, String>,
    ) -> napi::Result<String> {
        let result = catch_unwind(AssertUnwindSafe(|| {
            let now = to_millis(now)?;
            let fact = parse_fact(&fact_json)?;
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
            let batch = self.batch.as_mut().ok_or_else(|| {
                CoreBindError::Contract("no batch began on this thread".to_owned())
            })?;
            let outcome = batch.apply(&mut self.state, &fact, &mut ctx, &mut events);
            if let Some(failure) = ids.failure {
                return Err(CoreBindError::Contract(failure));
            }
            outcome.ok_or_else(|| CoreBindError::Contract("fold failed".to_owned()))?;
            Ok::<Vec<ace_core::emit::Event>, CoreBindError>(events)
        }));
        let events = match result {
            Ok(Ok(events)) => events,
            Ok(Err(error)) => return Err(error.into()),
            Err(_) => return Err(napi::Error::from_reason("core batch apply panicked")),
        };
        self.buffer.clear();
        let response = CoreResponse {
            events: &events,
            state: &self.state,
        };
        ace_core::json_io::write_json(&mut self.buffer, &response)
            .map_err(|error| CoreBindError::Contract(error.to_string()))?;
        String::from_utf8(std::mem::take(&mut self.buffer))
            .map_err(|error| napi::Error::from_reason(error.to_string()))
    }

    /// Derive this thread's deferred batch status.
    #[napi(catch_unwind)]
    pub fn batch_flush(&mut self) -> napi::Result<String> {
        let result = catch_unwind(AssertUnwindSafe(|| {
            let batch = self.batch.as_mut().ok_or_else(|| {
                CoreBindError::Contract("no batch began on this thread".to_owned())
            })?;
            Ok::<Vec<ace_core::emit::Event>, CoreBindError>(batch.flush(&mut self.state))
        }));
        let events = match result {
            Ok(Ok(events)) => events,
            Ok(Err(error)) => return Err(error.into()),
            Err(_) => return Err(napi::Error::from_reason("core batch flush panicked")),
        };
        self.buffer.clear();
        let response = CoreResponse {
            events: &events,
            state: &self.state,
        };
        ace_core::json_io::write_json(&mut self.buffer, &response)
            .map_err(|error| CoreBindError::Contract(error.to_string()))?;
        String::from_utf8(std::mem::take(&mut self.buffer))
            .map_err(|error| napi::Error::from_reason(error.to_string()))
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

fn create_inner(
    thread_id: &str,
    config_json: &str,
    root_json: Option<&str>,
) -> Result<ace_core::ThreadState, CoreBindError> {
    let config: ace_core::state::CoreConfig = serde_json::from_str(config_json)
        .map_err(|error| CoreBindError::InvalidThread(error.to_string()))?;
    let root = match root_json {
        None => None,
        Some(text) => Some(
            serde_json::from_str(text)
                .map_err(|error| CoreBindError::InvalidThread(error.to_string()))?,
        ),
    };
    ace_core::state::create_thread_state(thread_id.to_owned(), root, config)
        .map_err(|error| CoreBindError::InvalidThread(error.to_string()))
}

/// Derive one agent's status from a state snapshot.
#[napi(catch_unwind)]
pub fn core_derive_agent_status(state_json: String, key: String, now: f64) -> napi::Result<String> {
    let result = catch_unwind(AssertUnwindSafe(|| {
        let now = to_millis(now)?;
        let state = parse_state(&state_json)?;
        let status = ace_core::status::derive_agent_status(&state, &key, now);
        ace_json::ser::to_string(&status)
            .map_err(|error| CoreBindError::Contract(error.to_string()))
    }));
    match result {
        Ok(Ok(json)) => Ok(json),
        Ok(Err(error)) => Err(error.into()),
        Err(_) => Err(napi::Error::from_reason("core derive panicked")),
    }
}

/// Derive one thread's status from a state snapshot.
#[napi(catch_unwind)]
pub fn core_derive_thread_status(state_json: String) -> napi::Result<String> {
    let result = catch_unwind(AssertUnwindSafe(|| {
        let state = parse_state(&state_json)?;
        let status = ace_core::status::derive_thread_status(&state);
        ace_json::ser::to_string(&status)
            .map_err(|error| CoreBindError::Contract(error.to_string()))
    }));
    match result {
        Ok(Ok(json)) => Ok(json),
        Ok(Err(error)) => Err(error.into()),
        Err(_) => Err(napi::Error::from_reason("core derive panicked")),
    }
}

/// The next deadline from a state snapshot.
#[napi(catch_unwind)]
pub fn core_next_deadline(
    state_json: String,
    provider_deadline: Option<f64>,
) -> napi::Result<Option<f64>> {
    let result = catch_unwind(AssertUnwindSafe(|| {
        let state = parse_state(&state_json)?;
        let provider = match provider_deadline {
            None => None,
            Some(deadline) => {
                if !deadline.is_finite() || deadline.fract() != 0.0 || deadline < 0.0 {
                    return Err(CoreBindError::InvalidContext(
                        "provider deadline must be a nonnegative integer".to_owned(),
                    ));
                }
                Some(deadline as i64)
            }
        };
        Ok::<Option<i64>, CoreBindError>(ace_core::deadlines::next_deadline(&state, provider))
    }));
    match result {
        Ok(Ok(deadline)) => Ok(deadline.map(|deadline| deadline as f64)),
        Ok(Err(error)) => Err(error.into()),
        Err(_) => Err(napi::Error::from_reason("core deadline panicked")),
    }
}

/// One deadline index behind a handle the TypeScript shell holds.
#[napi]
pub struct DeadlineIndexNative {
    inner: ace_core::deadlines::DeadlineIndex,
}

#[napi]
impl DeadlineIndexNative {
    /// Build the index over one state snapshot.
    #[napi(constructor, catch_unwind)]
    pub fn new(state_json: String) -> napi::Result<Self> {
        let result = catch_unwind(AssertUnwindSafe(|| {
            parse_state(&state_json).map(|state| Self {
                inner: ace_core::deadlines::DeadlineIndex::new(&state),
            })
        }));
        match result {
            Ok(Ok(index)) => Ok(index),
            Ok(Err(error)) => Err(error.into()),
            Err(_) => Err(napi::Error::from_reason("deadline index failed to start")),
        }
    }

    /// Rebuild the index over one state snapshot.
    #[napi(catch_unwind)]
    pub fn rebuild(&mut self, state_json: String) -> napi::Result<()> {
        let result = catch_unwind(AssertUnwindSafe(|| parse_state(&state_json)));
        match result {
            Ok(Ok(state)) => {
                self.inner.rebuild(&state);
                Ok(())
            }
            Ok(Err(error)) => Err(error.into()),
            Err(_) => Err(napi::Error::from_reason("deadline index failed to rebuild")),
        }
    }

    /// Move eligibility after a signal.
    #[napi(catch_unwind)]
    pub fn signal(&mut self, agent: Option<String>, at: f64, silence_ms: f64) -> napi::Result<()> {
        if !at.is_finite() || !silence_ms.is_finite() || silence_ms < 0.0 {
            return Err(napi::Error::from_reason(
                "deadline signal needs finite times",
            ));
        }
        let result = catch_unwind(AssertUnwindSafe(|| {
            self.inner.signal(agent.as_deref(), at as i64, silence_ms);
        }));
        match result {
            Ok(()) => Ok(()),
            Err(_) => Err(napi::Error::from_reason("deadline signal panicked")),
        }
    }

    /// The earliest deadline, if any.
    #[napi(catch_unwind)]
    pub fn next(&mut self, provider_deadline: Option<f64>) -> napi::Result<Option<f64>> {
        let result = catch_unwind(AssertUnwindSafe(|| {
            let provider = match provider_deadline {
                None => None,
                Some(deadline) => {
                    if !deadline.is_finite() || deadline.fract() != 0.0 || deadline < 0.0 {
                        return Err(CoreBindError::InvalidContext(
                            "provider deadline must be a nonnegative integer".to_owned(),
                        ));
                    }
                    Some(deadline as i64)
                }
            };
            Ok::<Option<i64>, CoreBindError>(self.inner.next(provider))
        }));
        match result {
            Ok(Ok(deadline)) => Ok(deadline.map(|deadline| deadline as f64)),
            Ok(Err(error)) => Err(error.into()),
            Err(_) => Err(napi::Error::from_reason("deadline next panicked")),
        }
    }
}

/// Whether an agent still counts for completion, from a state snapshot.
#[napi(catch_unwind)]
pub fn core_completion_relevant(state_json: String, key: String) -> napi::Result<bool> {
    let result = catch_unwind(AssertUnwindSafe(|| {
        let state = parse_state(&state_json)?;
        Ok::<bool, CoreBindError>(ace_core::status::completion_relevance_reader(&state)(&key))
    }));
    match result {
        Ok(Ok(relevant)) => Ok(relevant),
        Ok(Err(error)) => Err(error.into()),
        Err(_) => Err(napi::Error::from_reason("core relevance panicked")),
    }
}

/// The human-attention rule, from interaction and owner snapshots.
#[napi(catch_unwind)]
pub fn core_is_actionable_interaction(
    interaction_json: String,
    owner_json: Option<String>,
) -> napi::Result<bool> {
    let result = catch_unwind(AssertUnwindSafe(|| {
        let interaction: serde_json::Value = serde_json::from_str(&interaction_json)
            .map_err(|error| CoreBindError::InvalidContext(error.to_string()))?;
        let state = interaction
            .get("state")
            .and_then(|state| state.as_str())
            .unwrap_or("");
        let blocking = interaction
            .get("blocking")
            .and_then(|blocking| blocking.as_bool())
            .unwrap_or(false);
        let owner_state = match owner_json.as_deref() {
            None => None,
            Some(text) => {
                let owner: serde_json::Value = serde_json::from_str(text)
                    .map_err(|error| CoreBindError::InvalidContext(error.to_string()))?;
                owner
                    .get("state")
                    .and_then(|state| state.as_str())
                    .map(str::to_owned)
            }
        };
        Ok::<bool, CoreBindError>(ace_core::human::is_actionable_interaction(
            state,
            blocking,
            owner_state.as_deref(),
        ))
    }));
    match result {
        Ok(Ok(actionable)) => Ok(actionable),
        Ok(Err(error)) => Err(error.into()),
        Err(_) => Err(napi::Error::from_reason("core interaction rule panicked")),
    }
}
