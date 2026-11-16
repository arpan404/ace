//! Oversight (ADR 0135, spade/docs/oversight.md): the person's time zone, each bot's review
//! switch, what each bot spent (information only: ADR 0166 removed every spending limit), and the
//! activity log. Settings are JSON in the `settings` table; the decisions are `spade_core::oversight`.

use jiff::tz::TimeZone;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use spade_core::Event;
use spade_core::activity::{self, Entry, Kind, Stored};
use spade_core::event::Known;
use spade_core::oversight::{self, Periods, Spent};
use spade_store::{Agent, OVERSIGHT, StoreError, agent_key};

use super::Engine;

/// The service-wide settings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Global {
    #[serde(default)]
    pub time_zone: Option<String>,
    #[serde(default)]
    pub review_default: bool,
    #[serde(default)]
    pub review_model: Option<String>,
    /// Spade's own classifier sits between the gate and the reviewer (ADR 0172); off sends
    /// everything the gate holds to the reviewer. On unless the person turned it off.
    #[serde(default = "on")]
    pub classifier: bool,
}

fn on() -> bool {
    true
}

impl Default for Global {
    fn default() -> Self {
        Self {
            time_zone: None,
            review_default: false,
            review_model: None,
            classifier: true,
        }
    }
}

/// One bot's settings. Caps an earlier build stored beside them are ignored (ADR 0166) and
/// removed by the store's migration.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentOversight {
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
    pub classifier: Option<bool>,
}

/// A change to one bot's settings; `Some(None)` clears a value.
#[derive(Debug, Default)]
pub struct OversightChange {
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
        if let Some(on) = change.classifier {
            global.classifier = on;
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

    /// What the agent spent this day and this month.
    pub(crate) fn spent(&self, agent: &Agent) -> Result<Spent, StoreError> {
        let periods = self.periods();
        Ok(Spent {
            today_micros: self
                .store
                .spent_by(&agent.conversation, periods.day_start)?,
            month_micros: self
                .store
                .spent_by(&agent.conversation, periods.month_start)?,
        })
    }

    /// `{"spending", "review"}` as the API shows them for `agent`.
    pub fn oversight_json(&self, agent: &Agent) -> Result<Value, StoreError> {
        let spent = self.spent(agent)?;
        let settings = self.agent_oversight(&agent.id)?;
        Ok(json!({
            "spending": {
                "today_micros": spent.today_micros,
                "month_micros": spent.month_micros,
            },
            "review": settings.review,
        }))
    }

    /// The service-wide view: settings and every bot's spend together.
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
            "today_micros": today,
            "month_micros": month,
            "review_default": global.review_default,
            "review_model": global.review_model,
            "classifier": global.classifier,
        }))
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

    /// The model that reviews for the conversation: its `review` role (ADR 0162): the bot's
    /// choice, else the person's review model, else the fast model, else the bot's own.
    pub(crate) fn review_model(&self, conversation: &str) -> String {
        self.role_model(conversation, spade_core::routing::Role::Review)
    }

    /// The agent's activity, newest first, filtered. The history is read a window at a time
    /// from the newest, at most [`MOST_EVENTS`] events per request, so a long history never
    /// holds the database for long; [`ActivityPage::next_before`] says where to go on.
    pub fn activity_log(
        &self,
        agent: &str,
        query: &ActivityQuery,
    ) -> Result<ActivityPage, OversightError> {
        let agent = self.store.agent(agent)?.ok_or(OversightError::NotFound)?;
        let range = match &query.day {
            Some(day) => Some(self.day_range(day).ok_or_else(|| {
                OversightError::Invalid(format!("{day} is not a day like 2026-11-12"))
            })?),
            None => None,
        };
        let limit = query.limit.clamp(1, 500);
        let types = types_for(&query.kinds);
        let top = match query.before {
            Some(before) => before,
            None => self.store.last_seq(&agent.conversation)? + 1,
        };
        let mut rows: Vec<spade_store::StoredEvent> = Vec::new();
        let mut low = top;
        loop {
            let from = (low - WINDOW).max(1);
            let exhausted = from >= low;
            if !exhausted {
                let mut window = self.store.activity_window(
                    &agent.conversation,
                    from,
                    low,
                    &types,
                    range.map(|(_, end)| end),
                )?;
                window.append(&mut rows);
                rows = window;
                low = from;
            }
            let older_left = low > 1;
            // Entries from the first turn start in view on have all their context (the step
            // that made each call); older ones wait for the next window.
            let trusted_from = if older_left {
                rows.iter()
                    .find(|e| matches!(e.event, Event::Known(Known::ReplyStarted { .. })))
                    // None in view (a turn longer than the windows read): what was read is
                    // all there is to go on, and the next request starts below it.
                    .map_or(low, |e| e.seq)
            } else {
                0
            };
            // The day is behind us once what this page leaves unreturned (below `trusted_from`)
            // is older than its start; otherwise the next page starts at `trusted_from`.
            let past_day = range.is_some_and(|(start, _)| {
                !older_left
                    || match rows.iter().rev().find(|e| e.seq < trusted_from) {
                        Some(below) => below.at_ms < start,
                        None => rows.first().is_some_and(|e| e.at_ms < start),
                    }
            });
            let found =
                self.matching(&agent.conversation, &rows, query, range, trusted_from, top)?;
            let scanned_enough = top - low >= MOST_EVENTS;
            if found.len() > limit || !older_left || past_day || scanned_enough {
                return Ok(page(found, limit, older_left && !past_day, trusted_from));
            }
        }
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

/// Events read per window, and at most per request.
const WINDOW: i64 = 2_000;
pub const MOST_EVENTS: i64 = 20_000;

/// One request's entries, and where to go on: `next_before` is set when older entries may
/// match (more of the history to read, or more entries than were asked for).
#[derive(Debug, Clone)]
pub struct ActivityPage {
    pub entries: Vec<Entry>,
    pub next_before: Option<i64>,
}

/// The event types the kinds asked for come from (every type when none is asked for). Turn
/// starts are always read: they mark where a window's entries have their context.
fn types_for(kinds: &[Kind]) -> Vec<&'static str> {
    let calls = [
        Kind::Tool,
        Kind::Connector,
        Kind::File,
        Kind::Bot,
        Kind::Approval,
        Kind::Spend,
    ];
    if kinds.is_empty() || kinds.iter().any(|k| calls.contains(k)) {
        return spade_store::ACTIVITY_TYPES.to_vec();
    }
    let mut types = vec!["reply_started"];
    for kind in kinds {
        types.push(match kind {
            Kind::Routine => "user_message",
            Kind::Review => "call_reviewed",
            Kind::Access => "access_changed",
            Kind::Task => "task_continued",
            Kind::Hook => "hook_ran",
            _ => continue,
        });
        if *kind == Kind::Task {
            types.push("task_paused");
            types.push("decision_made");
        }
    }
    types
}

impl Engine {
    /// The window's entries that match, newest first, from `trusted_from` up to `top`. Calls and
    /// jobs started in the window and finished above `top` get their outcome from those ends.
    fn matching(
        &self,
        conversation: &str,
        rows: &[spade_store::StoredEvent],
        query: &ActivityQuery,
        range: Option<(i64, i64)>,
        trusted_from: i64,
        top: i64,
    ) -> Result<Vec<Entry>, StoreError> {
        let open = open_calls(rows);
        let ends =
            self.store
                .finishes(conversation, &open, top, top.saturating_add(MOST_EVENTS))?;
        Ok(activity::fold(rows.iter().chain(&ends).map(|e| Stored {
            seq: e.seq,
            at: e.at_ms,
            event: &e.event,
        }))
        .into_iter()
        .rev()
        .filter(|e| e.seq >= trusted_from && e.seq < top)
        .filter(|e| activity::matches(e, &query.kinds, range, &query.words))
        .collect())
    }
}

/// Calls started and jobs begun in `rows` whose end is not among them.
fn open_calls(rows: &[spade_store::StoredEvent]) -> Vec<String> {
    let mut open: Vec<String> = Vec::new();
    for row in rows {
        match &row.event {
            Event::Known(
                Known::ToolStarted { call_id, .. } | Known::JobStarted { job: call_id, .. },
            ) if !open.contains(call_id) => open.push(call_id.clone()),
            Event::Known(
                Known::ToolFinished { call_id, .. } | Known::JobFinished { job: call_id, .. },
            ) => {
                // A background call's own result only says its job began; its job's end closes it.
                let job = rows.iter().any(|r| {
                    matches!(&r.event, Event::Known(Known::JobStarted { job, .. }) if job == call_id)
                });
                if !job || matches!(row.event, Event::Known(Known::JobFinished { .. })) {
                    open.retain(|id| id != call_id);
                }
            }
            _ => {}
        }
    }
    open
}

/// At most `limit` entries (more only to finish the last one's event, so `before` never skips
/// a sibling), and the cursor for the rest.
fn page(mut found: Vec<Entry>, limit: usize, older_left: bool, trusted_from: i64) -> ActivityPage {
    if found.len() > limit {
        let cut = found[limit - 1].seq;
        let keep = found.iter().take_while(|e| e.seq >= cut).count();
        found.truncate(keep);
        let next_before = Some(cut);
        return ActivityPage {
            entries: found,
            next_before,
        };
    }
    let next_before = older_left.then_some(trusted_from.max(1));
    ActivityPage {
        entries: found,
        next_before,
    }
}
