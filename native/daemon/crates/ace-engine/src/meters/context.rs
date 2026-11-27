// SPDX-License-Identifier: Apache-2.0
//! Context occupancy per agent (`context-meter.ts`, `context-sample.ts`): one replaceable row per
//! agent, never a sum of billing counters. A sample is invalidated (not decremented) whenever the
//! conversation it counted is replaced: a compaction, another native session, another model.

use ace_core::ThreadState;
use ace_json::Value;
use ace_store::{Value as Cell, stmt_cache};

use crate::repository::residency::{cell_int, cell_text};
use crate::{EngineError, EngineStore, State};

/// Where an occupancy figure came from (`ContextMeter.source`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContextSource {
    Provider,
    Catalog,
    Unknown,
}

impl ContextSource {
    fn text(self) -> &'static str {
        match self {
            ContextSource::Provider => "provider",
            ContextSource::Catalog => "catalog",
            ContextSource::Unknown => "unknown",
        }
    }

    fn parse(text: Option<&str>) -> ContextSource {
        match text {
            Some("provider") => ContextSource::Provider,
            Some("catalog") => ContextSource::Catalog,
            _ => ContextSource::Unknown,
        }
    }
}

/// One agent's occupancy (`ContextMeter`).
#[derive(Debug, Clone, PartialEq)]
pub struct ContextMeter {
    pub agent_id: String,
    pub epoch: u64,
    pub used_tokens: Option<u64>,
    pub window_tokens: Option<u64>,
    pub model: Option<String>,
    pub source: ContextSource,
}

impl ContextMeter {
    pub fn to_json(&self) -> Value {
        let mut value = ace_json::Map::new();
        value.insert("agentId", Value::from(self.agent_id.as_str()));
        value.insert("epoch", Value::from(self.epoch as f64));
        value.insert(
            "usedTokens",
            self.used_tokens
                .map_or(Value::Null, |used| Value::from(used as f64)),
        );
        value.insert(
            "windowTokens",
            self.window_tokens
                .map_or(Value::Null, |window| Value::from(window as f64)),
        );
        if let Some(model) = &self.model {
            value.insert("model", Value::from(model.as_str()));
        }
        value.insert("source", Value::from(self.source.text()));
        Value::Object(value)
    }
}

/// One agent's stored sample.
#[derive(Debug, Clone, PartialEq)]
pub struct ContextSample {
    pub meter: ContextMeter,
    pub session: Option<String>,
    pub compaction: Option<String>,
}

impl ContextSample {
    /// A fresh, empty sample for `agent`.
    pub fn empty(agent_id: &str) -> ContextSample {
        ContextSample {
            meter: ContextMeter {
                agent_id: agent_id.to_owned(),
                epoch: 0,
                used_tokens: None,
                window_tokens: None,
                model: None,
                source: ContextSource::Unknown,
            },
            session: None,
            compaction: None,
        }
    }

    /// A stored row's JSON, read leniently: a malformed sample is skipped, never fatal.
    pub fn from_json(value: &Value) -> Option<ContextSample> {
        let meter = value.get("meter")?;
        let agent_id = text(meter.get("agentId")?)?;
        Some(ContextSample {
            meter: ContextMeter {
                agent_id: agent_id.to_owned(),
                epoch: meter.get("epoch").and_then(count).unwrap_or(0),
                used_tokens: meter.get("usedTokens").and_then(count),
                window_tokens: meter.get("windowTokens").and_then(count),
                model: meter.get("model").and_then(text).map(str::to_owned),
                source: ContextSource::parse(meter.get("source").and_then(text)),
            },
            session: value.get("session").and_then(text).map(str::to_owned),
            compaction: value.get("compaction").and_then(text).map(str::to_owned),
        })
    }

    /// The row's JSON, in `ContextSample`'s key order.
    pub fn to_json(&self) -> Value {
        let mut value = ace_json::Map::new();
        value.insert("meter", self.meter.to_json());
        value.insert(
            "session",
            self.session.as_deref().map_or(Value::Null, Value::from),
        );
        value.insert(
            "compaction",
            self.compaction.as_deref().map_or(Value::Null, Value::from),
        );
        Value::Object(value)
    }
}

/// What happened to the conversation the sample counted.
#[derive(Debug, Clone, PartialEq)]
pub enum ContextChange {
    /// The occupied figure is unknown until the provider samples again.
    Invalidate,
    /// One compaction step, named so a repeat of the same step changes nothing.
    Compaction(String),
    Sample {
        used: Option<u64>,
        window: Option<u64>,
        model: Option<String>,
        session: Option<String>,
        /// The catalog window for the model, when the provider gave none.
        catalog: Option<u64>,
    },
}

/// `foldContext` (`context-sample.ts:22`): constant-size occupancy transitions.
pub fn fold_context(prior: &ContextSample, change: ContextChange) -> Option<ContextSample> {
    let mut sample = prior.clone();
    match change {
        ContextChange::Invalidate => {
            sample.meter.epoch += 1;
            sample.meter.used_tokens = None;
            sample.session = None;
        }
        ContextChange::Compaction(id) => {
            if sample.compaction.as_deref() == Some(id.as_str()) {
                return None;
            }
            sample.compaction = Some(id);
            sample.meter.epoch += 1;
            sample.meter.used_tokens = None;
        }
        ContextChange::Sample {
            used,
            window,
            model,
            session,
            catalog,
        } => {
            if model
                .as_ref()
                .is_some_and(|next| sample.meter.model.as_ref() != Some(next))
                || session
                    .as_ref()
                    .is_some_and(|next| sample.session.as_ref() != Some(next))
            {
                sample.meter.epoch += 1;
                sample.meter.used_tokens = None;
                sample.meter.window_tokens = None;
                sample.meter.source = ContextSource::Unknown;
            }
            if let Some(model) = model {
                sample.meter.model = Some(model);
            }
            if let Some(session) = session {
                sample.session = Some(session);
            }
            if let Some(used) = used {
                sample.meter.used_tokens = Some(used);
            }
            // The TS's `change.window !== undefined`: a provider window was given, not inferred,
            // and that decision outlives the fallback to the catalog's window.
            let provider_window = window.is_some();
            let window = window.or_else(|| {
                if sample.meter.source == ContextSource::Provider {
                    sample.meter.window_tokens.or(catalog)
                } else {
                    catalog
                }
            });
            if let Some(window) = window {
                sample.meter.window_tokens = Some(window);
                sample.meter.source =
                    if provider_window || sample.meter.source == ContextSource::Provider {
                        ContextSource::Provider
                    } else {
                        ContextSource::Catalog
                    };
            }
        }
    }
    Some(sample)
}

/// `options.recovery?.contextWindow(provider, instance, model)` (`recovery.ts:38`).
pub type ContextWindowLookup = std::rc::Rc<dyn Fn(&str, Option<&str>, &str) -> Option<u64>>;

/// The engine's context meters (`context-meter.ts:16`). A table is created once, on first use;
/// every write joins the caller's transaction as the store's own event writer.
#[derive(Default)]
pub struct Meters {
    lookup: std::cell::RefCell<Option<ContextWindowLookup>>,
    created: std::cell::Cell<bool>,
}

impl Meters {
    pub fn new(lookup: Option<ContextWindowLookup>) -> Meters {
        Meters {
            lookup: std::cell::RefCell::new(lookup),
            created: std::cell::Cell::new(false),
        }
    }

    pub fn set_lookup(&self, lookup: Option<ContextWindowLookup>) {
        *self.lookup.borrow_mut() = lookup;
    }

    fn ensure(&self, store: &EngineStore) -> Result<(), EngineError> {
        if self.created.get() {
            return Ok(());
        }
        store.atomic(|tx| {
            tx.conn()
                .exec(
                    "CREATE TABLE IF NOT EXISTS engine_context (
                        thread_id TEXT NOT NULL REFERENCES threads(id), agent_id TEXT NOT NULL,
                        sample JSON NOT NULL, PRIMARY KEY(thread_id,agent_id)
                    )",
                )
                .map_err(|error| EngineError::Records(error.to_string()))?;
            Ok(())
        })?;
        self.created.set(true);
        Ok(())
    }

    fn save(
        &self,
        store: &EngineStore,
        id: &str,
        value: &ContextSample,
        at: f64,
    ) -> Result<(), EngineError> {
        stmt_cache::run(
            store.conn(),
            WRITE,
            vec![
                Cell::Text(id.to_owned()),
                Cell::Text(value.meter.agent_id.clone()),
                Cell::Text(ace_json::to_string(&value.to_json())),
            ],
        )?;
        let event = ace_json::json!([{
            "type": "context_meter.updated",
            "meter": value.meter.to_json(),
        }]);
        store.write_events(id, &ace_json::to_string(&event), at)
    }

    /// `invalidate(id)` (`context-meter.ts:51`): every sample of the thread loses its occupancy.
    pub fn invalidate(&self, store: &EngineStore, id: &str, at: f64) -> Result<(), EngineError> {
        self.ensure(store)?;
        for row in stmt_cache::all_rows(store.conn(), LIST, vec![Cell::Text(id.to_owned())])? {
            let Some(stored) = row.get("sample").and_then(cell_text) else {
                continue;
            };
            let Ok(parsed) = ace_json::parse(stored) else {
                continue;
            };
            let Some(sample) = ContextSample::from_json(&parsed) else {
                continue;
            };
            if let Some(next) = fold_context(&sample, ContextChange::Invalidate) {
                self.save(store, id, &next, at)?;
            }
        }
        Ok(())
    }

    /// `observe(state, events, at, instance)` (`context-meter.ts:59`): fold one batch's events.
    #[allow(clippy::too_many_arguments)]
    pub fn observe(
        &self,
        store: &EngineStore,
        state: &ThreadState,
        events: &[Value],
        at: f64,
        instance: Option<&str>,
    ) -> Result<(), EngineError> {
        self.ensure(store)?;
        for event in events {
            let kind = event.get("type").and_then(text);
            if kind == Some("usage.updated")
                && matches!(
                    event.get("usageScope").and_then(text),
                    Some("model_session") | Some("provider_session")
                )
            {
                continue;
            }
            let compaction = match kind {
                Some("item.created") | Some("item.updated") => event
                    .get("item")
                    .filter(|item| item.get("type").and_then(text) == Some("compaction")),
                _ => None,
            };
            let compacting = kind == Some("agent.status")
                && event.get("status").is_some_and(|status| {
                    status.get("state").and_then(text) == Some("working")
                        && status.get("activity").and_then(text) == Some("compacting")
                });
            let model_changed =
                kind == Some("agent.updated") && event.get("model").is_some_and(not_null);
            if kind != Some("usage.updated")
                && kind != Some("context.sampled")
                && compaction.is_none()
                && !compacting
                && !model_changed
            {
                continue;
            }
            let agent_id = event
                .get("agentId")
                .and_then(text)
                .or_else(|| {
                    compaction
                        .and_then(|item| item.get("agentId"))
                        .and_then(text)
                })
                .map(str::to_owned);
            let Some(agent_id) = agent_id else {
                continue;
            };
            let prior = self.read(store, state.thread_id.as_str(), &agent_id)?;
            if prior.is_none() {
                let count = stmt_cache::get_row(
                    store.conn(),
                    COUNT,
                    vec![Cell::Text(state.thread_id.clone())],
                )?
                .and_then(|row| row.get("n").and_then(cell_int))
                .map(|count| count.max(0) as u64)
                .unwrap_or(0);
                if count >= 4096 {
                    continue;
                }
            }
            let sample = prior.unwrap_or_else(|| ContextSample::empty(&agent_id));
            let change = if let Some(item) = compaction {
                let item_id = item.get("id").and_then(text).unwrap_or_default();
                let complete = item
                    .get("complete")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                ContextChange::Compaction(format!("{item_id}:{complete}"))
            } else if compacting {
                ContextChange::Invalidate
            } else if matches!(
                kind,
                Some("usage.updated") | Some("context.sampled") | Some("agent.updated")
            ) {
                let agent_model = state
                    .indexes
                    .agent_keys_by_id
                    .get(&agent_id)
                    .and_then(|key| state.agents.get(key))
                    .and_then(|record| record.agent.model.clone());
                let model = event
                    .get("model")
                    .and_then(text)
                    .map(str::to_owned)
                    .or_else(|| sample.meter.model.clone())
                    .or(agent_model);
                let catalog = model.as_deref().and_then(|model| {
                    let lookup = self.lookup.borrow().clone()?;
                    lookup(state.config.provider.as_str(), instance, model)
                });
                ContextChange::Sample {
                    model: event
                        .get("model")
                        .and_then(text)
                        .map(str::to_owned)
                        .or_else(|| sample.meter.model.clone()),
                    used: match kind {
                        Some("usage.updated") => event.get("contextTokens").and_then(count),
                        _ => event.get("usedTokens").and_then(count),
                    },
                    window: match kind {
                        Some("usage.updated") => event.get("contextWindow").and_then(count),
                        _ => event.get("windowTokens").and_then(count),
                    },
                    session: match kind {
                        Some("usage.updated") => event
                            .get("contextSessionId")
                            .and_then(text)
                            .map(str::to_owned),
                        _ => event.get("sessionId").and_then(text).map(str::to_owned),
                    },
                    catalog,
                }
            } else {
                continue;
            };
            if let Some(next) = fold_context(&sample, change) {
                self.save(store, &state.thread_id, &next, at)?;
            }
        }
        Ok(())
    }

    fn read(
        &self,
        store: &EngineStore,
        id: &str,
        agent_id: &str,
    ) -> Result<Option<ContextSample>, EngineError> {
        let row = stmt_cache::get_row(
            store.conn(),
            READ,
            vec![Cell::Text(id.to_owned()), Cell::Text(agent_id.to_owned())],
        )?;
        let Some(stored) = row
            .as_ref()
            .and_then(|row| row.get("sample"))
            .and_then(cell_text)
        else {
            return Ok(None);
        };
        let parsed =
            ace_json::parse(stored).map_err(|error| EngineError::Records(error.to_string()))?;
        Ok(ContextSample::from_json(&parsed))
    }

    /// `context(id)`: the thread's samples, for `thread.get`'s view (E5.3 fills the read).
    pub fn samples(&self, store: &EngineStore, id: &str) -> Result<Vec<ContextMeter>, EngineError> {
        self.ensure(store)?;
        let mut meters = Vec::new();
        let rows = stmt_cache::all_rows(store.conn(), LIST, vec![Cell::Text(id.to_owned())])?;
        eprintln!("invalidate rows: {}", rows.len());
        for row in rows {
            let Some(stored) = row.get("sample").and_then(cell_text) else {
                eprintln!("no sample cell");
                continue;
            };
            eprintln!("stored: {stored}");
            let Ok(parsed) = ace_json::parse(stored) else {
                continue;
            };
            if let Some(sample) = ContextSample::from_json(&parsed) {
                meters.push(sample.meter);
            }
        }
        Ok(meters)
    }
}

impl State {
    /// `repo.observe`'s meters half (`index.ts:380`-`:396`): a replaced conversation cannot show
    /// the occupancy it had, and the batch's events fold into the meters.
    #[allow(clippy::too_many_arguments)]
    pub fn observe_context_batch(
        &mut self,
        store: &EngineStore,
        id: &str,
        process_started: bool,
        events: &[Value],
        at: f64,
        instance: Option<&str>,
    ) -> Result<(), EngineError> {
        if process_started {
            self.meters.invalidate(store, id, at)?;
        }
        if events.is_empty() {
            return Ok(());
        }
        let Some(snapshot) = self.repo.state(store, id)? else {
            return Ok(());
        };
        let meters = std::mem::take(&mut self.meters);
        let outcome = {
            let borrowed = snapshot.borrow();
            meters.observe(store, &borrowed.state, events, at, instance)
        };
        self.meters = meters;
        outcome
    }
}

const READ: &str = "SELECT sample FROM engine_context WHERE thread_id=? AND agent_id=?";
const WRITE: &str = "INSERT INTO engine_context VALUES (?,?,?) ON CONFLICT(thread_id,agent_id) DO UPDATE SET sample=excluded.sample";
const LIST: &str = "SELECT agent_id,sample FROM engine_context WHERE thread_id=? LIMIT 4096";
const COUNT: &str = "SELECT COUNT(*) AS n FROM engine_context WHERE thread_id=?";

fn text(value: &Value) -> Option<&str> {
    match value {
        Value::String(text) => Some(text.as_str()),
        _ => None,
    }
}

/// A non-negative integer or a safe whole number; a negative or fractional value is malformed.
fn count(value: &Value) -> Option<u64> {
    match value {
        Value::Number(number) => number.as_u64(),
        _ => None,
    }
}

fn not_null(value: &Value) -> bool {
    !matches!(value, Value::Null)
}
