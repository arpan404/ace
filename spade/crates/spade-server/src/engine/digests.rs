//! Digests and notices in the engine (ADR 0165). The rules are `spade_core::digest` and
//! `spade_core::escalation`; this reads a bot's events and spend, builds its digest (with its
//! workers' for a tree), optionally polishes the text, stores it, and sends notices: one per
//! digest and one per stored event that has an escalation level. A timer makes them on each
//! bot's schedule.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use spade_core::digest::schedule::{self, Settings};
use spade_core::digest::{self, Digest, polish, render};
use spade_core::escalation;
use spade_core::event::Known;
use spade_core::{Event, routing::Role};
use spade_store::{NewDigest, StoreError, StoredDigest, StoredEvent};
use tokio::sync::{Notify, broadcast};

use super::Engine;

/// The longest the timer sleeps before it looks again.
const LONGEST_SLEEP: Duration = Duration::from_secs(60);
/// The longest a polish may take before the plain text is kept.
const POLISH_TIMEOUT: Duration = Duration::from_secs(30);
/// The most digests one listing answers.
pub const MOST_LISTED: usize = 200;
/// The deepest tree a digest follows (the tree itself stops far sooner).
const DEEPEST: usize = 16;

pub(super) struct Shared {
    /// Notices for whoever listens (ace's daemon, a client): not stored.
    notices: broadcast::Sender<Value>,
    kick: Arc<Notify>,
    /// Where each bot's schedule last found nothing new, so a quiet window isn't built again
    /// every minute. Lost on restart, which only builds it once more.
    checked: Mutex<HashMap<String, i64>>,
    running: AtomicBool,
}

impl Default for Shared {
    fn default() -> Self {
        Self {
            notices: broadcast::channel(256).0,
            kick: Arc::new(Notify::new()),
            checked: Mutex::default(),
            running: AtomicBool::new(false),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum DigestError {
    #[error("no such agent")]
    NotFound,
    #[error("{0}")]
    Invalid(String),
    #[error(transparent)]
    Store(#[from] StoreError),
}

impl Engine {
    /// Notices from now on: digests as they are stored, and events with an escalation level.
    pub fn subscribe_notices(&self) -> broadcast::Receiver<Value> {
        self.digests.notices.subscribe()
    }

    /// Sends a notice for each of `events` that has a level, when anyone listens. Called after
    /// every write, so it does nothing more than a check when no one does.
    pub(super) fn notice_stored(&self, id: &str, events: &[StoredEvent]) {
        if self.digests.notices.receiver_count() == 0 {
            return;
        }
        let mut agent = None;
        for stored in events {
            let Event::Known(known) = &stored.event else {
                continue;
            };
            let (Some(level), Some(text)) = (escalation::level(known), escalation::sentence(known))
            else {
                continue;
            };
            if agent.is_none() {
                agent = self.store.agent_for_conversation(id).ok().flatten();
            }
            // A helper's hidden conversation has no agent: its asks are its bot's.
            let Some(agent) = &agent else { return };
            let _ = self.digests.notices.send(json!({
                "kind": "event", "agent": agent.id, "name": agent.name, "conversation": id,
                "seq": stored.seq, "at": stored.at_ms, "level": level,
                "type": stored.event.to_json()["type"], "text": text,
            }));
        }
    }

    /// The service-wide digest settings as stored.
    pub fn digest_settings(&self) -> Result<Settings, StoreError> {
        self.read_digest_settings(spade_store::DIGESTS)
    }

    fn read_digest_settings(&self, key: &str) -> Result<Settings, StoreError> {
        Ok(self
            .store
            .setting(key)?
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default())
    }

    /// The global settings and what they come to for a top-level bot.
    pub fn digest_settings_json(&self) -> Result<Value, StoreError> {
        let global = self.digest_settings()?;
        let applied = schedule::resolve(&global, &Settings::default(), false);
        Ok(json!({ "settings": global, "every_ms": applied.every_ms, "polish": applied.polish }))
    }

    /// Replaces the global settings; the timer looks again at once.
    pub fn set_digest_settings(&self, settings: Settings) -> Result<Value, DigestError> {
        schedule::check(&settings).map_err(DigestError::Invalid)?;
        self.write_digest_settings(spade_store::DIGESTS, &settings)?;
        self.digests.kick.notify_one();
        Ok(self.digest_settings_json()?)
    }

    fn write_digest_settings(&self, key: &str, settings: &Settings) -> Result<(), StoreError> {
        let raw = serde_json::to_string(settings).unwrap_or_else(|_| "{}".to_owned());
        self.store.set_setting(key, Some(&raw))
    }

    /// One bot's own settings and what applies to it.
    pub fn agent_digest_json(&self, agent: &str) -> Result<Value, DigestError> {
        let found = self.store.agent(agent)?.ok_or(DigestError::NotFound)?;
        let own = self.read_digest_settings(&spade_store::digests_key(agent))?;
        let worker = self.worker_link(&found.conversation).is_some();
        let applied = schedule::resolve(&self.digest_settings()?, &own, worker);
        let since = self.schedule_since(&found)?;
        Ok(json!({
            "settings": own, "every_ms": applied.every_ms, "polish": applied.polish,
            "next_ms": schedule::due_at(applied, since),
        }))
    }

    pub fn set_agent_digest(&self, agent: &str, settings: Settings) -> Result<Value, DigestError> {
        self.store.agent(agent)?.ok_or(DigestError::NotFound)?;
        schedule::check(&settings).map_err(DigestError::Invalid)?;
        self.write_digest_settings(&spade_store::digests_key(agent), &settings)?;
        self.digests.kick.notify_one();
        self.agent_digest_json(agent)
    }

    /// Stored digests, newest first.
    pub fn digests_json(
        &self,
        agent: Option<&str>,
        after: Option<i64>,
        limit: usize,
    ) -> Result<Value, StoreError> {
        let rows = self
            .store
            .digests(agent, after, limit.clamp(1, MOST_LISTED))?;
        Ok(json!({ "digests": rows.iter().map(digest_json).collect::<Vec<_>>() }))
    }

    pub fn digest_by_id(&self, id: i64) -> Result<Option<Value>, StoreError> {
        Ok(self.store.digest(id)?.as_ref().map(digest_json))
    }

    /// Makes a digest of `agent` now, over the time since its last one, and stores it even when
    /// quiet. It doesn't move the schedule.
    pub async fn digest_now(self: &Arc<Self>, agent: &str) -> Result<Value, DigestError> {
        let found = self.store.agent(agent)?.ok_or(DigestError::NotFound)?;
        let from = match self.store.last_digest(agent)? {
            Some(last) => last,
            None => found.created_ms,
        };
        let made = self.make_digest(&found, from, self.now_ms(), false).await?;
        Ok(made.unwrap_or(Value::Null))
    }

    /// Builds, polishes, stores and announces one digest over `[from, to)`. A scheduled one
    /// whose window was quiet is not stored: `None`.
    async fn make_digest(
        self: &Arc<Self>,
        agent: &spade_store::Agent,
        from: i64,
        to: i64,
        scheduled: bool,
    ) -> Result<Option<Value>, DigestError> {
        let built = self.build_digest(&agent.conversation, &agent.id, &agent.name, from, to, 0)?;
        if scheduled && built.quiet {
            return Ok(None);
        }
        let time = |ms: i64| self.short_time(ms);
        let plain = render::text(&built, &time);
        let own = self.read_digest_settings(&spade_store::digests_key(&agent.id))?;
        let worker = self.worker_link(&agent.conversation).is_some();
        let applied = schedule::resolve(&self.digest_settings()?, &own, worker);
        let polished = if applied.polish && !built.quiet {
            self.polish(&agent.conversation, &plain).await
        } else {
            None
        };
        let body = serde_json::to_string(&built).unwrap_or_else(|_| "{}".to_owned());
        let kind = if built.workers.is_empty() {
            "task"
        } else {
            "tree"
        };
        let id = self.store.add_digest(&NewDigest {
            agent: &agent.id,
            kind,
            scheduled,
            from_ms: from,
            to_ms: to,
            made_ms: to,
            body: &body,
            text: &plain,
            polished: polished.as_deref(),
        })?;
        let _ = self.digests.notices.send(json!({
            "kind": "digest", "agent": agent.id, "name": agent.name, "digest": id,
            "level": escalation::Level::Inform,
            "text": render::headline(&built, &time),
        }));
        Ok(self.digest_by_id(id)?)
    }

    /// One bot's digest, with a digest per bot worker under it.
    fn build_digest(
        &self,
        conversation: &str,
        agent: &str,
        name: &str,
        from: i64,
        to: i64,
        depth: usize,
    ) -> Result<Digest, StoreError> {
        let stored = self.store.events(conversation, 0)?;
        let at_ms: Vec<i64> = stored.iter().map(|e| e.at_ms).collect();
        let events: Vec<Event> = stored.into_iter().map(|e| e.event).collect();
        let spend = self.store.spent_by_role(conversation, from)?;
        let own = digest::task(&digest::Input {
            agent,
            name,
            events: &events,
            at_ms: &at_ms,
            from_ms: from,
            to_ms: to,
            spend,
        });
        if depth >= DEEPEST {
            return Ok(own);
        }
        let mut workers = Vec::new();
        for child in self.worker_children(conversation) {
            let Some(found) = self.store.agent_for_conversation(&child)? else {
                continue;
            };
            workers.push(self.build_digest(&child, &found.id, &found.name, from, to, depth + 1)?);
        }
        Ok(digest::tree(own, workers))
    }

    /// The text rewritten by the `title` role's model, or `None` to keep the plain one.
    async fn polish(self: &Arc<Self>, conversation: &str, plain: &str) -> Option<String> {
        let model = self.role_model(conversation, Role::Title);
        let prompt = polish::prompt(plain).session(conversation);
        let admitted = self.admit(conversation, &model).for_role(Role::Title);
        let asked = tokio::time::timeout(
            POLISH_TIMEOUT,
            self.models.generate::<polish::Polished>(&model, &prompt),
        )
        .await;
        match asked {
            Ok(Ok(generated)) => {
                admitted.settle(&generated.usage);
                polish::accept(plain, &generated.value.text)
            }
            Ok(Err(error)) => {
                admitted.settle_if(error.usage());
                None
            }
            Err(_) => None,
        }
    }

    /// Where a bot's schedule counts from: its last scheduled digest, else when it was made.
    fn schedule_since(&self, agent: &spade_store::Agent) -> Result<i64, StoreError> {
        let last = self.store.last_scheduled_digest(&agent.id)?;
        let checked = self
            .digests
            .checked
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(&agent.id)
            .copied();
        Ok(last
            .into_iter()
            .chain(checked)
            .max()
            .unwrap_or(agent.created_ms))
    }

    /// Makes every digest that is due and answers when the next one is. The clock is read once:
    /// that reading is each window's end and, for a quiet window, where the schedule counts from
    /// next, so an event stored at or after it is in the next window.
    async fn digest_tick(self: &Arc<Self>) -> Option<i64> {
        let now = self.now_ms();
        let global = self.digest_settings().unwrap_or_default();
        let agents = self.store.agents().unwrap_or_default();
        let mut soonest: Option<i64> = None;
        for agent in agents {
            let own = self
                .read_digest_settings(&spade_store::digests_key(&agent.id))
                .unwrap_or_default();
            let worker = self.worker_link(&agent.conversation).is_some();
            let applied = schedule::resolve(&global, &own, worker);
            let Ok(since) = self.schedule_since(&agent) else {
                continue;
            };
            let Some(due) = schedule::due_at(applied, since) else {
                continue;
            };
            if due > now {
                soonest = Some(soonest.map_or(due, |s| s.min(due)));
                continue;
            }
            match self.make_digest(&agent, since, now, true).await {
                Ok(Some(_)) => {}
                Ok(None) => {
                    // The quiet window's own end, never a later reading: the builder left out
                    // what was stored at or after it.
                    let mut checked = self
                        .digests
                        .checked
                        .lock()
                        .unwrap_or_else(|p| p.into_inner());
                    checked.insert(agent.id.clone(), now);
                }
                Err(error) => tracing::error!(%error, agent = %agent.id, "could not make a digest"),
            }
            if let Some(every) = applied.every_ms {
                let next = now + every;
                soonest = Some(soonest.map_or(next, |s| s.min(next)));
            }
        }
        soonest
    }

    /// Starts the digest timer, once.
    pub(super) fn start_digests(self: &Arc<Self>) {
        if self.digests.running.swap(true, Ordering::SeqCst) {
            return;
        }
        let weak = Arc::downgrade(self);
        let kick = self.digests.kick.clone();
        tokio::spawn(async move {
            loop {
                let Some(engine) = weak.upgrade() else { return };
                let next = engine.digest_tick().await;
                let wait = next.map_or(LONGEST_SLEEP, |at| {
                    let ms = u64::try_from(at.saturating_sub(engine.now_ms())).unwrap_or(0);
                    Duration::from_millis(ms).min(LONGEST_SLEEP)
                });
                drop(engine);
                tokio::select! {
                    () = tokio::time::sleep(wait) => {}
                    () = kick.notified() => {}
                }
            }
        });
    }

    /// Answers a `decision_log` call: stores the decision with its result, or gives the refusal
    /// as the result. `None` when the person stopped the reply.
    pub(super) fn decision_call(
        &self,
        id: &str,
        reply: &str,
        call_id: &str,
        arguments: &Value,
    ) -> Result<Option<crate::tools::ToolOutput>, StoreError> {
        use crate::tools::ToolOutput;
        let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
        let events = self.load(id)?;
        if spade_core::turn::stop_requested(&events, reply) {
            return Ok(None);
        }
        Ok(Some(
            match spade_core::decision::record(&events, call_id, arguments) {
                Ok(decision) => {
                    let result = spade_core::decision::recorded(&decision);
                    let stored = spade_core::decision::log(events.iter())
                        .iter()
                        .any(|d| d.call_id == call_id);
                    if !stored {
                        self.append_events(id, &[Event::Known(Known::DecisionMade(decision))])?;
                    }
                    ToolOutput::ok(result)
                }
                Err(why) => ToolOutput::error(why),
            },
        ))
    }
}

fn digest_json(row: &StoredDigest) -> Value {
    json!({
        "id": row.id, "agent": row.agent, "kind": row.kind, "scheduled": row.scheduled,
        "from_ms": row.from_ms, "to_ms": row.to_ms, "made_ms": row.made_ms,
        "text": row.text, "polished": row.polished,
        "digest": serde_json::from_str::<Value>(&row.body).unwrap_or(Value::Null),
    })
}
