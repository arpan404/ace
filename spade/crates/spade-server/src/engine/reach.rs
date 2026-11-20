//! Reaching the person (ADR 0195). Every notice on `GET /v1/notices/live` passes through here:
//! `spade_core::reach` decides whether it interrupts now or waits (do not disturb, quiet hours,
//! the interruption budget), this records what was sent and what waits, and the timer sends one
//! summary when quiet ends. What waited goes into the bot's next digest and the morning brief.

use std::sync::Mutex;

use jiff::Timestamp;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use spade_core::reach::{
    self, AgentReach, Category, Decision, Moment, Notice, Reach, Settings, Why, settings,
};
use spade_store::StoreError;

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

#[derive(Default)]
pub(super) struct Shared {
    /// Held and sent are read, changed and written under it.
    lock: Mutex<()>,
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
        let decided = self.decide_and_record(&out).unwrap_or_else(|error| {
            tracing::error!(%error, "could not record a notice; sending it as it is");
            Decision {
                reach: Reach::Now,
                why: None,
                counts: false,
            }
        });
        let mut notice = out.notice;
        notice["id"] = json!(out.id);
        notice["category"] = json!(out.category);
        notice["reach"] = json!(decided.reach);
        if let Some(why) = decided.why {
            notice["why"] = json!(why);
        }
        let _ = self.digests.notices.send(notice);
    }

    fn decide_and_record(&self, out: &Outgoing) -> Result<Decision, StoreError> {
        let settings = self.reach_settings()?;
        let _held = self.reach.lock.lock().unwrap_or_else(|p| p.into_inner());
        let now = self.now_ms();
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
        Ok(decided)
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
