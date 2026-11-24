//! Reaching the person (ADR 0195). Every notice on `GET /v1/notices/live` passes through here:
//! `spade_core::reach` decides whether it interrupts now or waits (do not disturb, quiet hours,
//! the interruption budget), this records what was sent and what waits, and the timer sends one
//! summary when quiet ends. What waited goes into the bot's next digest and the morning brief.

use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use jiff::Timestamp;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use spade_core::reach::batch::{self, PendingAsk, TreeRoot};
use spade_core::reach::notice::{self as bot_notice, Rate};
use spade_core::reach::{
    self, AgentReach, Category, Decision, Moment, Notice, Reach, Settings, Why, settings,
};
use spade_store::StoreError;
use tokio::sync::Notify;
use tokio::time::Instant;

use super::Engine;

/// The service-wide settings' key.
pub(super) const SETTINGS: &str = "reach";
/// What waits for the person, oldest first.
const HELD: &str = "reach:held";
/// When each counted interruption went out, for the budget.
const SENT: &str = "reach:sent";
/// The most held notices kept; the oldest already told go first.
const MOST_HELD: usize = 500;

fn agent_key(agent: &str) -> String {
    format!("reach:{agent}")
}

/// When each of a bot's own notices (`notify`) was sent or held, for its rate.
fn notify_key(agent: &str) -> String {
    format!("reach:notify:{agent}")
}

struct PendingTree {
    root: TreeRoot,
    items: Vec<PendingAsk>,
    deadline: Instant,
}

#[derive(Default)]
pub(super) struct Shared {
    /// Held and sent are read, changed and written under it.
    lock: Mutex<()>,
    /// Pending `needs_you` asks per tree root waiting briefly to coalesce into one notice.
    pending: Mutex<HashMap<String, PendingTree>>,
    batch_kick: Arc<Notify>,
}

/// A notice that waited.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct Held {
    pub id: String,
    pub agent: String,
    pub name: String,
    pub at_ms: i64,
    pub category: Category,
    pub text: String,
    pub why: Why,
    /// Told in the summary when quiet ended.
    #[serde(default)]
    pub summarized: bool,
    /// Put in a digest or a brief.
    #[serde(default)]
    pub digested: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum ReachError {
    #[error("no such agent")]
    NotFound,
    #[error("{0}")]
    Invalid(String),
    #[error(transparent)]
    Store(#[from] StoreError),
}

/// What [`Engine::reach_out`] sends: the notice's own fields and what decides it.
pub(super) struct Outgoing {
    pub notice: Value,
    pub id: String,
    pub agent: String,
    pub name: String,
    pub category: Category,
    pub level: Option<spade_core::escalation::Level>,
    pub engaged: bool,
    pub text: String,
}

impl Engine {
    pub fn reach_settings(&self) -> Result<Settings, StoreError> {
        self.read_json(SETTINGS)
    }

    fn read_json<T: for<'de> Deserialize<'de> + Default>(
        &self,
        key: &str,
    ) -> Result<T, StoreError> {
        Ok(self
            .store
            .setting(key)?
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default())
    }

    fn write_json(&self, key: &str, value: &impl Serialize) -> Result<(), StoreError> {
        let raw = serde_json::to_string(value).unwrap_or_else(|_| "null".to_owned());
        self.store.set_setting(key, Some(&raw))
    }

    /// The settings, whether proactive notices wait right now and why, and how many wait.
    pub fn reach_json(&self) -> Result<Value, StoreError> {
        let settings = self.reach_settings()?;
        let held: Vec<Held> = self.read_json(HELD)?;
        let waiting = held.iter().filter(|h| !h.digested).count();
        Ok(json!({
            "settings": settings,
            "quiet": reach::quiet(&settings, self.minute_now()),
            "held": waiting,
        }))
    }

    /// Applies the fields of `change` over the stored settings, checks and stores them.
    pub fn set_reach(&self, change: &Value) -> Result<Value, ReachError> {
        let Some(change) = change.as_object() else {
            return Err(ReachError::Invalid(
                "The settings are an object.".to_owned(),
            ));
        };
        let mut merged = serde_json::to_value(self.reach_settings()?).unwrap_or_default();
        for (key, value) in change {
            if let (Some(into), Some(from)) = (merged.get_mut(key), value.as_object())
                && let Some(into) = into.as_object_mut()
            {
                into.extend(from.clone());
            } else {
                merged[key] = value.clone();
            }
        }
        let settings: Settings = serde_json::from_value(merged)
            .map_err(|e| ReachError::Invalid(format!("Those settings don't read: {e}")))?;
        settings::check(&settings).map_err(ReachError::Invalid)?;
        self.write_json(SETTINGS, &settings)?;
        // A change applies at once: spend rates are looked at again on the next pass.
        *self
            .digests
            .spend_checked
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = None;
        self.digests.kick.notify_one();
        Ok(self.reach_json()?)
    }

    pub fn agent_reach_json(&self, agent: &str) -> Result<Value, ReachError> {
        self.store.agent(agent)?.ok_or(ReachError::NotFound)?;
        let own: AgentReach = self.read_json(&agent_key(agent))?;
        Ok(json!({ "notify": own.notify, "approvals": own.approvals }))
    }

    /// One bot's own choices: the fields `change` names replace the stored ones, `null` makes a
    /// field follow the global setting again.
    pub fn set_agent_reach(&self, agent: &str, change: &Value) -> Result<Value, ReachError> {
        self.store.agent(agent)?.ok_or(ReachError::NotFound)?;
        let Some(change) = change.as_object() else {
            return Err(ReachError::Invalid(
                "A bot's choices are an object.".to_owned(),
            ));
        };
        let mut merged = serde_json::to_value(self.read_json::<AgentReach>(&agent_key(agent))?)
            .unwrap_or_default();
        for (key, value) in change {
            merged[key] = value.clone();
        }
        let own: AgentReach = serde_json::from_value(merged)
            .map_err(|e| ReachError::Invalid(format!("Those choices don't read: {e}")))?;
        self.write_json(&agent_key(agent), &own)?;
        self.agent_reach_json(agent)
    }

    fn bot_reach(&self, agent: &str) -> AgentReach {
        if agent.is_empty() {
            return AgentReach::default();
        }
        self.read_json::<AgentReach>(&agent_key(agent))
            .unwrap_or_default()
    }

    /// Minutes after midnight now, in the person's zone.
    pub(super) fn minute_now(&self) -> u16 {
        let zoned = Timestamp::from_millisecond(self.now_ms())
            .unwrap_or(Timestamp::UNIX_EPOCH)
            .to_zoned(self.zone());
        u16::try_from(i32::from(zoned.hour()) * 60 + i32::from(zoned.minute())).unwrap_or(0)
    }

    /// Decides how `out` reaches the person, records it (sent for the budget, or held), and sends
    /// it on the notice stream with its `id`, `category`, `reach` and `why`.
    pub(super) fn reach_out(&self, out: Outgoing) {
        let decided = self.decide_and_record(&out, false).unwrap_or_else(|error| {
            tracing::error!(%error, "could not record a notice; sending it as it is");
            Decision {
                reach: Reach::Now,
                why: None,
                counts: false,
            }
        });
        self.send_notice(out, decided);
    }

    /// A bot's own notice (`notify`): decided as any proactive notice, with the bot's own rate on
    /// top. `None` when its day is full: nothing is recorded or sent.
    pub(super) fn reach_out_for_bot(&self, out: Outgoing) -> Result<Option<Decision>, StoreError> {
        let Some(decided) = self.decide_rated(&out, true)? else {
            return Ok(None);
        };
        self.send_notice(out, decided);
        Ok(Some(decided))
    }

    fn send_notice(&self, out: Outgoing, decided: Decision) {
        let mut notice = out.notice;
        notice["id"] = json!(out.id);
        notice["category"] = json!(out.category);
        notice["reach"] = json!(decided.reach);
        if let Some(why) = decided.why {
            notice["why"] = json!(why);
        }
        let _ = self.digests.notices.send(notice);
    }

    fn decide_and_record(&self, out: &Outgoing, rated: bool) -> Result<Decision, StoreError> {
        Ok(self.decide_rated(out, rated)?.unwrap_or(Decision {
            reach: Reach::None,
            why: Some(Why::Rate),
            counts: false,
        }))
    }

    /// Decides `out` and records it. `rated`: a bot's own notice, held to its rate first;
    /// `Ok(None)` when its day is full, and nothing is recorded.
    fn decide_rated(&self, out: &Outgoing, rated: bool) -> Result<Option<Decision>, StoreError> {
        let settings = self.reach_settings()?;
        let _held = self.reach.lock.lock().unwrap_or_else(|p| p.into_inner());
        let now = self.now_ms();
        let rate = if rated {
            let mut mine: Vec<i64> = self.read_json(&notify_key(&out.agent))?;
            bot_notice::keep(&mut mine, now);
            let rate = bot_notice::rate(&mine, now);
            if rate == Rate::Day {
                return Ok(None);
            }
            mine.push(now);
            self.write_json(&notify_key(&out.agent), &mine)?;
            rate
        } else {
            Rate::Room
        };
        let mut sent: Vec<i64> = self.read_json(SENT)?;
        reach::keep_sent(&mut sent, now);
        let own = self.bot_reach(&out.agent);
        let decided = reach::decide(
            &settings,
            Notice {
                category: out.category,
                level: out.level,
                engaged: out.engaged,
                bot_on: own.notify.unwrap_or(true),
                approvals: own.approvals.unwrap_or(settings.approvals),
            },
            Moment {
                now_ms: now,
                minute: self.minute_now(),
                sent: &sent,
            },
        );
        let decided = bot_notice::limit(decided, rate);
        if decided.counts {
            sent.push(now);
            self.write_json(SENT, &sent)?;
        }
        if let (Reach::Held, Some(why)) = (decided.reach, decided.why) {
            let mut held: Vec<Held> = self.read_json(HELD)?;
            held.push(Held {
                id: out.id.clone(),
                agent: out.agent.clone(),
                name: out.name.clone(),
                at_ms: now,
                category: out.category,
                text: out.text.clone(),
                why,
                summarized: false,
                digested: false,
            });
            trim_held(&mut held);
            self.write_json(HELD, &held)?;
        }
        Ok(Some(decided))
    }

    /// The held notices of `agents` (every bot's for `None`) not yet in a digest or brief, now
    /// marked as in one.
    pub(super) fn take_away(&self, agents: Option<&[String]>) -> Result<Vec<Held>, StoreError> {
        let _held = self.reach.lock.lock().unwrap_or_else(|p| p.into_inner());
        let mut held: Vec<Held> = self.read_json(HELD)?;
        let mut taken = Vec::new();
        for h in held.iter_mut().filter(|h| !h.digested) {
            if agents.is_none_or(|ids| ids.contains(&h.agent)) {
                h.digested = true;
                taken.push(h.clone());
            }
        }
        if !taken.is_empty() {
            self.write_json(HELD, &held)?;
        }
        Ok(taken)
    }

    /// Once quiet has ended: one summary of what waited through it that no digest or brief has
    /// told yet.
    pub(super) fn summarize_quiet(&self) -> Result<(), StoreError> {
        let settings = self.reach_settings()?;
        if reach::quiet(&settings, self.minute_now()).is_some() {
            return Ok(());
        }
        let told: Vec<Held> = {
            let _held = self.reach.lock.lock().unwrap_or_else(|p| p.into_inner());
            let mut held: Vec<Held> = self.read_json(HELD)?;
            let mut told = Vec::new();
            for h in held
                .iter_mut()
                .filter(|h| !h.summarized && !h.digested && matches!(h.why, Why::Dnd | Why::Quiet))
            {
                h.summarized = true;
                told.push(h.clone());
            }
            if told.is_empty() {
                return Ok(());
            }
            self.write_json(HELD, &held)?;
            told
        };
        let names: Vec<&str> = told.iter().map(|h| h.name.as_str()).collect();
        let Some(text) = reach::summary_text(&names) else {
            return Ok(());
        };
        let now = self.now_ms();
        let first = told.first().map(|h| h.agent.clone()).unwrap_or_default();
        self.reach_out(Outgoing {
            notice: json!({
                "kind": "summary", "agent": first, "at": now, "text": text,
                "count": told.len(),
                "items": told.iter().map(|h| json!({
                    "agent": h.agent, "name": h.name, "text": h.text, "at": h.at_ms,
                })).collect::<Vec<_>>(),
            }),
            id: format!("summary:{now}"),
            agent: String::new(),
            name: String::new(),
            category: Category::Summary,
            level: None,
            engaged: false,
            text,
        });
        Ok(())
    }

    /// Starts the background coalescer that batches rapid `needs_you` notices per bot tree.
    pub(super) fn start_reach_batcher(self: &Arc<Self>) {
        let weak = Arc::downgrade(self);
        let kick = self.reach.batch_kick.clone();
        tokio::spawn(async move {
            loop {
                let Some(engine) = weak.upgrade() else { return };
                let (ready, next) = engine.take_ready_batches();
                for batch in ready {
                    engine.flush_needs_you_tree(batch.root, batch.items);
                }
                drop(engine);
                match next {
                    Some(deadline) => {
                        tokio::select! {
                            () = tokio::time::sleep_until(deadline) => {}
                            () = kick.notified() => {}
                        }
                    }
                    None => kick.notified().await,
                }
            }
        });
    }

    /// Queues one pending approval or question under its tree root so several arriving together
    /// coalesce into one grouped notice; flushes immediately when the background timer isn't
    /// running.
    pub(super) fn queue_needs_you(&self, root: TreeRoot, item: PendingAsk) {
        if !self.digests.running.load(Ordering::SeqCst) {
            self.flush_needs_you_tree(root, vec![item]);
            return;
        }
        let deadline = Instant::now() + Duration::from_millis(batch::WINDOW_MS);
        {
            let mut pending = self.reach.pending.lock().unwrap_or_else(|p| p.into_inner());
            let entry = pending
                .entry(root.agent.clone())
                .or_insert_with(|| PendingTree {
                    root,
                    items: Vec::new(),
                    deadline,
                });
            if !entry.items.iter().any(|existing| existing.id == item.id) {
                entry.items.push(item);
            }
        }
        self.reach.batch_kick.notify_one();
    }

    fn take_ready_batches(&self) -> (Vec<PendingTree>, Option<Instant>) {
        let now = Instant::now();
        let mut pending = self.reach.pending.lock().unwrap_or_else(|p| p.into_inner());
        let due_keys: Vec<String> = pending
            .iter()
            .filter(|(_, batch)| batch.deadline <= now)
            .map(|(key, _)| key.clone())
            .collect();
        let mut ready = Vec::with_capacity(due_keys.len());
        for key in due_keys {
            if let Some(batch) = pending.remove(&key) {
                ready.push(batch);
            }
        }
        let next = pending.values().map(|batch| batch.deadline).min();
        (ready, next)
    }

    fn flush_needs_you_tree(&self, root: TreeRoot, mut items: Vec<PendingAsk>) {
        if items.is_empty() {
            return;
        }
        let planned = match self.plan_and_record_batch(&root, &mut items) {
            Ok(planned) => planned,
            Err(error) => {
                tracing::error!(%error, "could not record a batched notice; sending as it is");
                let fallback = batch::plan(
                    &Settings::default(),
                    &root,
                    &items,
                    Moment {
                        now_ms: self.now_ms(),
                        minute: self.minute_now(),
                        sent: &[],
                    },
                );
                for one in fallback {
                    self.send_planned(one);
                }
                return;
            }
        };
        for one in planned {
            self.send_planned(one);
        }
    }

    fn plan_and_record_batch(
        &self,
        root: &TreeRoot,
        items: &mut [PendingAsk],
    ) -> Result<Vec<batch::Planned>, StoreError> {
        let settings = self.reach_settings()?;
        for item in items.iter_mut() {
            let own = self.bot_reach(&item.agent);
            item.bot_on = own.notify.unwrap_or(true);
            item.approvals = own.approvals.unwrap_or(settings.approvals);
        }
        let _held = self.reach.lock.lock().unwrap_or_else(|p| p.into_inner());
        let now = self.now_ms();
        let mut sent: Vec<i64> = self.read_json(SENT)?;
        reach::keep_sent(&mut sent, now);
        let planned = batch::plan(
            &settings,
            root,
            items,
            Moment {
                now_ms: now,
                minute: self.minute_now(),
                sent: &sent,
            },
        );
        let mut sent_changed = false;
        let mut held_new: Vec<Held> = Vec::new();
        for one in &planned {
            if one.decision.counts {
                sent.push(now);
                sent_changed = true;
            }
            if let (Reach::Held, Some(why)) = (one.decision.reach, one.decision.why) {
                held_new.push(Held {
                    id: one.id.clone(),
                    agent: one.agent.clone(),
                    name: one.name.clone(),
                    at_ms: now,
                    category: Category::NeedsYou,
                    text: one.text.clone(),
                    why,
                    summarized: false,
                    digested: false,
                });
            }
        }
        if sent_changed {
            self.write_json(SENT, &sent)?;
        }
        if !held_new.is_empty() {
            let mut held: Vec<Held> = self.read_json(HELD)?;
            held.extend(held_new);
            trim_held(&mut held);
            self.write_json(HELD, &held)?;
        }
        Ok(planned)
    }

    fn send_planned(&self, planned: batch::Planned) {
        self.send_notice(
            Outgoing {
                notice: planned.notice,
                id: planned.id,
                agent: planned.agent,
                name: planned.name,
                category: Category::NeedsYou,
                level: Some(planned.level),
                engaged: false,
                text: planned.text,
            },
            planned.decision,
        );
    }
}

/// Keeps the held list bounded: the oldest that were already told go first, then the oldest.
fn trim_held(held: &mut Vec<Held>) {
    while held.len() > MOST_HELD {
        let at = held
            .iter()
            .position(|h| h.digested || h.summarized)
            .unwrap_or(0);
        held.remove(at);
    }
}
