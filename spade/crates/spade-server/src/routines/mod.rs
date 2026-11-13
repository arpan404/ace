//! Routines and the heartbeat (ADR 0129, docs/routines.md): standing work a bot does in its own
//! conversation. This module checks and stores them; `fire` decides and delivers runs, `timer`
//! drives the schedule and ace's events, `tools` lets a bot manage its own.

mod fire;
mod timer;
mod tools;

use std::sync::Mutex;

use jiff::tz::TimeZone;
use spade_core::routine::{self, QuietHours, Trigger};
use spade_store::{HEARTBEAT, ROUTINE, StoreError, StoredRoutine};
use tokio::sync::Notify;

use crate::engine::Engine;

pub use fire::{RunResult, run_now, tick};
pub use timer::{start, watch_ace};
pub use tools::with_tools;

/// The heartbeat's interval when the person turns it on without one.
pub const HEARTBEAT_MINUTES: u32 = 30;
/// Routines one bot may have.
pub const MOST_ROUTINES: usize = 50;

/// Routines' state in the engine: the timer's wake-up, the zone new routines default to, and
/// the lock every firing decision takes, so two firings of one routine never interleave.
pub struct Shared {
    pub(crate) wake: Notify,
    zone: Mutex<String>,
    pub(crate) firing: tokio::sync::Mutex<()>,
    secrets: fn() -> String,
}

impl Default for Shared {
    fn default() -> Self {
        Self {
            wake: Notify::new(),
            zone: Mutex::new("UTC".to_owned()),
            firing: tokio::sync::Mutex::new(()),
            secrets: crate::home::new_token,
        }
    }
}

/// Sets the time zone a routine made without one uses: the machine's, read once at start.
pub fn set_default_zone(engine: &Engine, zone: &str) {
    if TimeZone::get(zone).is_ok() {
        *engine
            .routines_shared()
            .zone
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = zone.to_owned();
    }
}

/// The machine's zone, read once at start (UTC until then).
pub(crate) fn machine_zone(engine: &Engine) -> String {
    default_zone(engine)
}

fn default_zone(engine: &Engine) -> String {
    engine
        .routines_shared()
        .zone
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone()
}

#[derive(Debug, thiserror::Error)]
pub enum RoutineError {
    #[error("no such routine")]
    NotFound,
    #[error("no such agent")]
    NoAgent,
    #[error("{0}")]
    Invalid(String),
    #[error(transparent)]
    Store(#[from] StoreError),
}

/// Who made or changed a routine.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum By {
    Person,
    Agent,
}

/// A routine as the API and tools show it.
#[derive(Debug, Clone)]
pub struct RoutineView {
    pub routine: StoredRoutine,
    pub trigger: Trigger,
    /// The trigger in words: `Weekdays at 9:00`.
    pub words: String,
    pub next_run_ms: Option<i64>,
    pub last_run: Option<RunResult>,
}

/// A new routine, or changes to one; absent fields stay as they are.
#[derive(Debug, Clone, Default)]
pub struct RoutineInput {
    pub name: Option<String>,
    pub instruction: Option<String>,
    pub trigger: Option<Trigger>,
    pub time_zone: Option<String>,
    pub paused: Option<bool>,
    /// Saved by a bot in a turn with untrusted content in view (ADR 0144): the routine is marked
    /// untrusted for good.
    pub untrusted: bool,
}

/// The heartbeat's settings; absent fields stay as they are.
#[derive(Debug, Clone, Default)]
pub struct HeartbeatInput {
    pub enabled: Option<bool>,
    pub every_minutes: Option<u32>,
    pub checklist: Option<String>,
    pub quiet: Option<Option<QuietHours>>,
    pub time_zone: Option<String>,
}

#[derive(Debug, Clone)]
pub struct HeartbeatView {
    pub enabled: bool,
    pub every_minutes: u32,
    pub checklist: String,
    pub quiet: Option<QuietHours>,
    pub time_zone: String,
    pub next_run_ms: Option<i64>,
    pub last_run: Option<RunResult>,
}

fn invalid(why: impl Into<String>) -> RoutineError {
    RoutineError::Invalid(why.into())
}

fn agent_of(engine: &Engine, agent_id: &str) -> Result<spade_store::Agent, RoutineError> {
    engine.store().agent(agent_id)?.ok_or(RoutineError::NoAgent)
}

fn zone(name: &str) -> Result<TimeZone, RoutineError> {
    TimeZone::get(name).map_err(|_| invalid(format!("{name:?} is not a known time zone.")))
}

/// The trigger stored in `r`, read leniently: a row this build can't read is a webhook that never
/// fires on its own, so it is still listed and can be fixed or deleted.
pub(crate) fn trigger_of(r: &StoredRoutine) -> Trigger {
    serde_json::from_str(&r.trigger).unwrap_or(Trigger::Webhook)
}

fn one_line(text: &str, longest: usize, what: &str) -> Result<String, RoutineError> {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.is_empty() {
        return Err(invalid(format!("The {what} is empty.")));
    }
    if text.chars().count() > longest {
        return Err(invalid(format!(
            "The {what} is longer than {longest} characters."
        )));
    }
    Ok(text)
}

fn instruction(text: &str) -> Result<String, RoutineError> {
    let text = text.trim();
    if text.is_empty() {
        return Err(invalid("The instruction is empty."));
    }
    if text.chars().count() > routine::INSTRUCTION_CHARS {
        return Err(invalid(format!(
            "The instruction is longer than {} characters.",
            routine::INSTRUCTION_CHARS
        )));
    }
    Ok(text.to_owned())
}

/// The next slot of `r` from now, when it is scheduled and active.
fn next_slot(engine: &Engine, r: &StoredRoutine) -> Result<Option<i64>, RoutineError> {
    if r.paused {
        return Ok(None);
    }
    let Some(schedule) = trigger_of(r).schedule().map_err(invalid)? else {
        return Ok(None);
    };
    Ok(schedule.next_after(engine.now_ms(), &zone(&r.time_zone)?))
}

/// The bot's routines (not its heartbeat), oldest first.
pub fn list(engine: &Engine, agent_id: &str) -> Result<Vec<RoutineView>, RoutineError> {
    agent_of(engine, agent_id)?;
    engine
        .store()
        .routines_of(agent_id, ROUTINE)?
        .into_iter()
        .map(|r| view(engine, r))
        .collect()
}

pub fn get(engine: &Engine, id: &str) -> Result<RoutineView, RoutineError> {
    let r = engine
        .store()
        .routine(id)?
        .filter(|r| r.kind == ROUTINE)
        .ok_or(RoutineError::NotFound)?;
    view(engine, r)
}

fn view(engine: &Engine, r: StoredRoutine) -> Result<RoutineView, RoutineError> {
    let trigger = trigger_of(&r);
    let last_run = fire::last_result(engine, &r)?;
    Ok(RoutineView {
        words: trigger.words(),
        next_run_ms: if r.paused { None } else { r.next_due_ms },
        trigger,
        last_run,
        routine: r,
    })
}

pub fn create(
    engine: &Engine,
    agent_id: &str,
    input: RoutineInput,
    by: By,
) -> Result<RoutineView, RoutineError> {
    agent_of(engine, agent_id)?;
    if engine.store().routines_of(agent_id, ROUTINE)?.len() >= MOST_ROUTINES {
        return Err(invalid(format!(
            "A bot can have at most {MOST_ROUTINES} routines."
        )));
    }
    let (Some(name), Some(text), Some(trigger)) = (input.name, input.instruction, input.trigger)
    else {
        return Err(invalid(
            "A routine needs a name, an instruction and a trigger.",
        ));
    };
    if trigger.is_heartbeat() {
        return Err(invalid(
            "The heartbeat is set on its own, not as a routine.",
        ));
    }
    trigger.schedule().map_err(invalid)?;
    let time_zone = input.time_zone.unwrap_or_else(|| default_zone(engine));
    zone(&time_zone)?;
    let now = engine.now_ms();
    let mut r = StoredRoutine {
        id: engine.new_id("rt"),
        agent_id: agent_id.to_owned(),
        kind: ROUTINE.to_owned(),
        name: one_line(&name, routine::NAME_CHARS, "name")?,
        instruction: instruction(&text)?,
        secret: matches!(trigger, Trigger::Webhook).then(|| (engine.routines_shared().secrets)()),
        trigger: serde_json::to_string(&trigger).map_err(|e| invalid(e.to_string()))?,
        time_zone,
        paused: input.paused.unwrap_or(false),
        next_due_ms: None,
        created_by: match by {
            By::Person => "person",
            By::Agent => "agent",
        }
        .to_owned(),
        created_ms: now,
        updated_ms: now,
        untrusted: input.untrusted,
    };
    r.next_due_ms = next_slot(engine, &r)?;
    if !engine.store().insert_routine(&r)? {
        return Err(RoutineError::NoAgent);
    }
    engine.routines_shared().wake.notify_one();
    view(engine, r)
}

pub fn update(
    engine: &Engine,
    id: &str,
    change: RoutineInput,
) -> Result<RoutineView, RoutineError> {
    let mut r = engine
        .store()
        .routine(id)?
        .filter(|r| r.kind == ROUTINE)
        .ok_or(RoutineError::NotFound)?;
    let was = (r.trigger.clone(), r.time_zone.clone(), r.paused);
    r.untrusted |= change.untrusted;
    if let Some(name) = change.name {
        r.name = one_line(&name, routine::NAME_CHARS, "name")?;
    }
    if let Some(text) = change.instruction {
        r.instruction = instruction(&text)?;
    }
    if let Some(trigger) = change.trigger {
        if trigger.is_heartbeat() {
            return Err(invalid(
                "The heartbeat is set on its own, not as a routine.",
            ));
        }
        trigger.schedule().map_err(invalid)?;
        let webhook = matches!(trigger, Trigger::Webhook);
        r.trigger = serde_json::to_string(&trigger).map_err(|e| invalid(e.to_string()))?;
        r.secret = match (webhook, r.secret.take()) {
            (true, Some(kept)) => Some(kept),
            (true, None) => Some((engine.routines_shared().secrets)()),
            (false, _) => None,
        };
    }
    if let Some(time_zone) = change.time_zone {
        zone(&time_zone)?;
        r.time_zone = time_zone;
    }
    if let Some(paused) = change.paused {
        r.paused = paused;
    }
    // A new schedule, zone or resuming starts from the next slot after now; nothing paused or
    // replaced catches up.
    if was != (r.trigger.clone(), r.time_zone.clone(), r.paused) {
        r.next_due_ms = next_slot(engine, &r)?;
    }
    r.updated_ms = engine.now_ms();
    if !engine.store().update_routine(&r)? {
        return Err(RoutineError::NotFound);
    }
    engine.routines_shared().wake.notify_one();
    view(engine, r)
}

pub fn delete(engine: &Engine, id: &str) -> Result<(), RoutineError> {
    let found = engine.store().routine(id)?.filter(|r| r.kind == ROUTINE);
    if found.is_none() || !engine.store().delete_routine(id)? {
        return Err(RoutineError::NotFound);
    }
    Ok(())
}

/// The bot's heartbeat, off with the defaults when never set.
pub fn heartbeat(engine: &Engine, agent_id: &str) -> Result<HeartbeatView, RoutineError> {
    agent_of(engine, agent_id)?;
    let Some(r) = stored_heartbeat(engine, agent_id)? else {
        return Ok(HeartbeatView {
            enabled: false,
            every_minutes: HEARTBEAT_MINUTES,
            checklist: String::new(),
            quiet: None,
            time_zone: default_zone(engine),
            next_run_ms: None,
            last_run: None,
        });
    };
    let (every_minutes, quiet) = match trigger_of(&r) {
        Trigger::Heartbeat {
            every_minutes,
            quiet,
        } => (every_minutes, quiet),
        _ => (HEARTBEAT_MINUTES, None),
    };
    Ok(HeartbeatView {
        enabled: !r.paused,
        every_minutes,
        quiet,
        next_run_ms: if r.paused { None } else { r.next_due_ms },
        last_run: fire::last_result(engine, &r)?,
        checklist: r.instruction,
        time_zone: r.time_zone,
    })
}

fn stored_heartbeat(engine: &Engine, agent_id: &str) -> Result<Option<StoredRoutine>, StoreError> {
    Ok(engine
        .store()
        .routines_of(agent_id, HEARTBEAT)?
        .into_iter()
        .next())
}

pub fn set_heartbeat(
    engine: &Engine,
    agent_id: &str,
    change: HeartbeatInput,
) -> Result<HeartbeatView, RoutineError> {
    let current = heartbeat(engine, agent_id)?;
    let enabled = change.enabled.unwrap_or(current.enabled);
    let checklist = change.checklist.unwrap_or(current.checklist);
    let checklist = checklist.trim().to_owned();
    if checklist.chars().count() > routine::INSTRUCTION_CHARS {
        return Err(invalid(format!(
            "The checklist is longer than {} characters.",
            routine::INSTRUCTION_CHARS
        )));
    }
    if enabled && checklist.is_empty() {
        return Err(invalid("A heartbeat needs a checklist to go through."));
    }
    let trigger = Trigger::Heartbeat {
        every_minutes: change.every_minutes.unwrap_or(current.every_minutes),
        quiet: change.quiet.unwrap_or(current.quiet),
    };
    trigger.schedule().map_err(invalid)?;
    let time_zone = change.time_zone.unwrap_or(current.time_zone);
    zone(&time_zone)?;
    let trigger = serde_json::to_string(&trigger).map_err(|e| invalid(e.to_string()))?;
    let now = engine.now_ms();
    match stored_heartbeat(engine, agent_id)? {
        Some(mut r) => {
            let was = (r.trigger.clone(), r.time_zone.clone(), r.paused);
            r.instruction = checklist;
            r.trigger = trigger;
            r.time_zone = time_zone;
            r.paused = !enabled;
            if was != (r.trigger.clone(), r.time_zone.clone(), r.paused) {
                r.next_due_ms = next_slot(engine, &r)?;
            }
            r.updated_ms = now;
            engine.store().update_routine(&r)?;
        }
        None => {
            let mut r = StoredRoutine {
                id: engine.new_id("hb"),
                agent_id: agent_id.to_owned(),
                kind: HEARTBEAT.to_owned(),
                name: "Heartbeat".to_owned(),
                instruction: checklist,
                trigger,
                time_zone,
                paused: !enabled,
                secret: None,
                next_due_ms: None,
                created_by: "person".to_owned(),
                created_ms: now,
                updated_ms: now,
                untrusted: false,
            };
            r.next_due_ms = next_slot(engine, &r)?;
            engine.store().insert_routine(&r)?;
        }
    }
    engine.routines_shared().wake.notify_one();
    heartbeat(engine, agent_id)
}

/// The routine `id` if it belongs to the agent of `conversation`, for a bot's own tools.
pub(crate) fn owned_by(
    engine: &Engine,
    conversation: &str,
    id: &str,
) -> Result<StoredRoutine, RoutineError> {
    let me = engine
        .store()
        .agent_for_conversation(conversation)?
        .ok_or(RoutineError::NoAgent)?;
    engine
        .store()
        .routine(id)?
        .filter(|r| r.agent_id == me.id && r.kind == ROUTINE)
        .ok_or(RoutineError::NotFound)
}
