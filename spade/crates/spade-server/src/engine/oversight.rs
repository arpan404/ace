//! Oversight (ADR 0135, spade/docs/oversight.md): the person's time zone, each bot's caps and
//! review switch, what each bot spent, the cap check before every model call, and the activity
//! log. Settings are JSON in the `settings` table; the decisions are `spade_core::oversight`.

use jiff::tz::TimeZone;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use spade_core::activity::{self, Entry, Kind, Stored};
use spade_core::event::Known;
use spade_core::oversight::{self, Caps, Hit, Periods, Spent};
use spade_core::{Event, turn::progress};
use spade_store::{Agent, OVERSIGHT, StoreError, agent_key};

use super::Engine;

/// The service-wide settings.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Global {
    #[serde(default)]
    pub time_zone: Option<String>,
    #[serde(default)]
    pub review_default: bool,
    #[serde(default)]
    pub review_model: Option<String>,
}

/// One bot's settings.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentOversight {
    #[serde(default)]
    pub daily_cap_micros: Option<u64>,
    #[serde(default)]
    pub monthly_cap_micros: Option<u64>,
    /// `None` follows the service's default.
    #[serde(default)]
    pub review: Option<bool>,
}

/// A change to the service-wide settings; `None` keeps a value.
#[derive(Debug, Default)]
pub struct GlobalChange {
    pub time_zone: Option<String>,
    pub review_default: Option<bool>,
    /// `Some(None)` clears it.
    pub review_model: Option<Option<String>>,
}

/// A change to one bot's settings; `Some(None)` clears a value.
#[derive(Debug, Default)]
pub struct OversightChange {
    pub daily_cap_micros: Option<Option<u64>>,
    pub monthly_cap_micros: Option<Option<u64>>,
    pub review: Option<Option<bool>>,
}

#[derive(Debug, thiserror::Error)]
pub enum OversightError {
    #[error("no such agent")]
    NotFound,
    #[error("{0}")]
    Invalid(String),
    #[error(transparent)]
    Store(#[from] StoreError),
}

/// What an activity request asks for.
#[derive(Debug, Default)]
pub struct ActivityQuery {
    pub kinds: Vec<Kind>,
    /// `YYYY-MM-DD` in the person's zone.
    pub day: Option<String>,
    pub words: String,
    pub before: Option<i64>,
    pub limit: usize,
}

impl Engine {
    pub fn oversight(&self) -> Result<Global, StoreError> {
        Ok(self
            .store
            .setting(OVERSIGHT)?
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default())
    }

    pub fn set_oversight(&self, change: GlobalChange) -> Result<Global, OversightError> {
        let _held = self.agent_lock.lock().unwrap_or_else(|p| p.into_inner());
        let mut global = self.oversight()?;
        if let Some(zone) = change.time_zone {
            if TimeZone::get(&zone).is_err() {
                return Err(OversightError::Invalid(format!(
                    "{zone} is not a time zone"
                )));
            }
            global.time_zone = Some(zone);
        }
        if let Some(on) = change.review_default {
            global.review_default = on;
        }
        if let Some(model) = change.review_model {
            global.review_model = match model {
                Some(model) => Some(
                    self.check_model(&model)
                        .map_err(|e| OversightError::Invalid(e.to_string()))?,
                ),
                None => None,
            };
        }
        let raw = serde_json::to_string(&global).unwrap_or_default();
        self.store.set_setting(OVERSIGHT, Some(&raw))?;
        Ok(global)
    }

    /// The person's zone: the one the app sent, else the machine's.
    pub(crate) fn zone(&self) -> TimeZone {
        let named = self
            .oversight()
            .ok()
            .and_then(|g| g.time_zone)
            .unwrap_or_else(|| crate::routines::machine_zone(self));
        TimeZone::get(&named).unwrap_or(TimeZone::UTC)
    }

    pub(crate) fn periods(&self) -> Periods {
        oversight::periods(self.now_ms(), &self.zone())
    }

    pub fn agent_oversight(&self, agent: &str) -> Result<AgentOversight, StoreError> {
        Ok(self
            .store
            .setting(&agent_key(agent))?
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default())
    }

    pub fn set_agent_oversight(
        &self,
        agent: &str,
        change: OversightChange,
    ) -> Result<AgentOversight, OversightError> {
        let _held = self.agent_lock.lock().unwrap_or_else(|p| p.into_inner());
        if self.store.agent(agent)?.is_none() {
            return Err(OversightError::NotFound);
        }
        let mut settings = self.agent_oversight(agent)?;
        if let Some(cap) = change.daily_cap_micros {
            settings.daily_cap_micros = cap;
        }
        if let Some(cap) = change.monthly_cap_micros {
            settings.monthly_cap_micros = cap;
        }
        if let Some(review) = change.review {
            settings.review = review;
        }
        let raw = serde_json::to_string(&settings).unwrap_or_default();
        self.store.set_setting(&agent_key(agent), Some(&raw))?;
        Ok(settings)
    }

    /// The stored agent, by id.
    pub fn store_agent(&self, id: &str) -> Result<Option<Agent>, StoreError> {
        self.store.agent(id)
    }

    /// The agent's spend this day and month, its caps, and the cap it is at.
    pub(crate) fn spending(
        &self,
        agent: &Agent,
    ) -> Result<(Spent, AgentOversight, Option<Hit>), StoreError> {
        let settings = self.agent_oversight(&agent.id)?;
        let periods = self.periods();
        let spent = Spent {
            today_micros: self
                .store
                .spent_by(&agent.conversation, periods.day_start)?,
            month_micros: self
                .store
                .spent_by(&agent.conversation, periods.month_start)?,
        };
        let caps = Caps {
            daily_micros: settings.daily_cap_micros,
            monthly_micros: settings.monthly_cap_micros,
        };
        Ok((spent, settings, oversight::hit(caps, spent, periods)))
    }

    /// `{"spending", "review"}` as the API shows them for `agent`.
    pub fn oversight_json(&self, agent: &Agent) -> Result<Value, StoreError> {
        let (spent, settings, hit) = self.spending(agent)?;
        Ok(json!({
            "spending": {
                "today_micros": spent.today_micros,
                "month_micros": spent.month_micros,
                "daily_cap_micros": settings.daily_cap_micros,
                "monthly_cap_micros": settings.monthly_cap_micros,
                "capped": hit.map(|h| scope_word(h.scope)),
                "resets_at": hit.map(|h| h.resets_at),
            },
            "review": settings.review,
        }))
    }

    /// The service-wide view: settings, the service cap and every bot's spend together.
    pub fn oversight_view(&self) -> Result<Value, StoreError> {
        let global = self.oversight()?;
        let periods = self.periods();
        let today = self.store.spent_since(periods.day_start)?;
        let month = self.store.spent_since(periods.month_start)?;
        let zone = self
            .zone()
            .iana_name()
            .map_or_else(|| "UTC".to_owned(), str::to_owned);
        Ok(json!({
            "time_zone": zone,
            "daily_cap_micros": self.daily_cap_micros,
            "today_micros": today,
            "month_micros": month,
            "review_default": global.review_default,
            "review_model": global.review_model,
        }))
    }

    /// The cap the conversation's bot is at, with its name. `None` when it is at none (or the
    /// conversation has no bot).
    pub(crate) fn bot_cap(&self, conversation: &str) -> Option<(String, Hit)> {
        let agent = self.store.agent_for_conversation(conversation).ok()??;
        let (_, _, hit) = self.spending(&agent).ok()?;
        hit.map(|hit| (agent.name, hit))
    }

    /// Why nothing may start for the conversation's bot now, in words; `None` when it may.
    pub(crate) fn cap_refusal(&self, conversation: &str) -> Option<String> {
        self.bot_cap(conversation)
            .map(|(name, hit)| oversight::refusal(&name, &hit))
    }

    /// Whether another model call may start for the conversation: under the service's cap and
    /// the bot's own.
    pub(crate) fn may_spend(&self, conversation: &str) -> Result<(), String> {
        if !self.within_cap().unwrap_or(false) {
            return Err("the service's daily cap".to_owned());
        }
        match self.bot_cap(conversation) {
            Some((_, hit)) => Err(format!("the bot's {} cap", scope_word(hit.scope))),
            None => Ok(()),
        }
    }

    /// Records a model call's cost for the conversation (research, reviews).
    pub(crate) fn charge(
        &self,
        conversation: &str,
        model: &str,
        usage: &spade_models::Usage,
    ) -> u64 {
        self.pay(conversation, model, usage)
    }

    /// Ends the open turn of a bot at its cap before its next model call: says so once per
    /// period, then closes the reply without words. Nothing new opens: the cap holds.
    pub(super) fn close_capped(&self, id: &str, reply: &str, hit: &Hit) -> Result<(), StoreError> {
        let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
        let events = self.load(id)?;
        let mut closing = Vec::new();
        if !oversight::said(&events, hit) {
            closing.push(oversight::reached(hit));
        }
        closing.push(Event::Known(Known::ReplyFinished {
            reply: reply.to_owned(),
            text: String::new(),
            input_tokens: None,
            output_tokens: None,
            cost_micros: progress(&events).cost_micros,
        }));
        self.append_events(id, &closing)?;
        Ok(())
    }

    /// After a turn ends: when it took the bot to a cap, the bot says so now, once.
    pub(super) fn note_if_capped(&self, id: &str) {
        let Some((_, hit)) = self.bot_cap(id) else {
            return;
        };
        let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
        let Ok(events) = self.load(id) else { return };
        if !oversight::said(&events, &hit)
            && let Err(error) = self.append(id, &oversight::reached(&hit))
        {
            tracing::error!(%error, "could not store that a bot reached its cap");
        }
    }

    /// The model a conversation's background work (research) uses: its bot's own.
    pub(crate) fn bot_model(&self, conversation: &str) -> String {
        self.reply_model(conversation)
    }

    /// Shows what a background job of the conversation is doing (`Researching · 3 sources
    /// read`), or, with `None`, clears it unless something else has said more since.
    pub(crate) fn job_status(&self, conversation: &str, prefix: &str, status: Option<String>) {
        if status.is_none() {
            let live = self.live(conversation);
            let mine = live
                .status
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .as_deref()
                .is_some_and(|now| now.starts_with(prefix));
            if !mine {
                return;
            }
        }
        self.set_status(conversation, status);
    }

    /// Whether the model review is on for the conversation's bot.
    pub(crate) fn review_on(&self, conversation: &str) -> bool {
        let Ok(Some(agent)) = self.store.agent_for_conversation(conversation) else {
            return false;
        };
        let own = self.agent_oversight(&agent.id).ok().and_then(|s| s.review);
        own.unwrap_or_else(|| self.oversight().is_ok_and(|g| g.review_default))
    }

    /// The model that reviews for the conversation: the person's review model, else the fast
    /// model, else the bot's own.
    pub(crate) fn review_model(&self, conversation: &str) -> String {
        if let Ok(Global {
            review_model: Some(model),
            ..
        }) = self.oversight()
        {
            return model;
        }
        match self.fast_model() {
            Ok(Some(model)) => model,
            _ => self.reply_model(conversation),
        }
    }

    /// The agent's activity, newest first, filtered; and whether older entries match.
    pub fn activity_log(
        &self,
        agent: &str,
        query: &ActivityQuery,
    ) -> Result<(Vec<Entry>, bool), OversightError> {
        let agent = self.store.agent(agent)?.ok_or(OversightError::NotFound)?;
        let range = match &query.day {
            Some(day) => Some(self.day_range(day).ok_or_else(|| {
                OversightError::Invalid(format!("{day} is not a day like 2026-11-12"))
            })?),
            None => None,
        };
        let stored = self.store.events(&agent.conversation, 0)?;
        let entries = activity::fold(stored.iter().map(|e| Stored {
            seq: e.seq,
            at: e.at_ms,
            event: &e.event,
        }));
        let limit = query.limit.clamp(1, 500);
        let mut found: Vec<Entry> = entries
            .into_iter()
            .rev()
            .filter(|e| query.before.is_none_or(|before| e.seq < before))
            .filter(|e| activity::matches(e, &query.kinds, range, &query.words))
            .take(limit + 1)
            .collect();
        let more = found.len() > limit;
        found.truncate(limit);
        Ok((found, more))
    }

    /// The day `YYYY-MM-DD` in the person's zone, as `[start, end)`.
    fn day_range(&self, day: &str) -> Option<(i64, i64)> {
        let date: jiff::civil::Date = day.parse().ok()?;
        let zone = self.zone();
        let start = date.to_zoned(zone.clone()).ok()?;
        let end = date.tomorrow().ok()?.to_zoned(zone).ok()?;
        Some((
            start.timestamp().as_millisecond(),
            end.timestamp().as_millisecond(),
        ))
    }
}

fn scope_word(scope: spade_core::event::CapScope) -> &'static str {
    match scope {
        spade_core::event::CapScope::Daily => "daily",
        spade_core::event::CapScope::Monthly => "monthly",
    }
}
