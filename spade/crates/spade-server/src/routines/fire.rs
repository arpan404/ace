//! Firing a routine (ADR 0129): decide whether the run goes ahead or is skipped, claim it with
//! its slot in one transaction, then deliver its message into the bot's conversation. A run
//! claimed but not delivered when Spade stopped is delivered on the next tick.

use std::sync::Arc;

use jiff::tz::TimeZone;
use spade_ace::events::{ThreadChange, ThreadState};
use spade_core::Event;
use spade_core::event::{FromRoutine, Known};
use spade_core::routine::{self, AceEvent, Trigger};
use spade_store::{HEARTBEAT, ROUTINE, StoreError, StoredRoutine, StoredRun};

use super::{RoutineError, trigger_of};
use crate::engine::Engine;

/// The latest run of a routine, as the list shows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunResult {
    pub id: String,
    pub at_ms: i64,
    /// `schedule`, `caught_up`, `event`, `webhook` or `manual`.
    pub cause: String,
    /// `running`, `answered`, `quiet` (a heartbeat with nothing to say), `failed`, `stopped`,
    /// `interrupted` or `skipped`.
    pub result: &'static str,
    /// Why it was skipped or failed, or the label it fired with.
    pub detail: Option<String>,
}

/// What a firing is.
struct Firing {
    cause: &'static str,
    slot_ms: Option<i64>,
    /// For a scheduled firing: the slot it claims, and the next slot after it.
    claim: Option<(Option<i64>, Option<i64>)>,
    label: String,
    event: Option<String>,
}

/// Runs everything due at the engine's now: runs a restart left undelivered, then each scheduled
/// routine whose slot came, once however many slots passed. Returns the next slot of any routine.
pub async fn tick(engine: &Arc<Engine>) -> Result<Option<i64>, StoreError> {
    let _one = engine.routines_shared().firing.lock().await;
    recover(engine)?;
    let now = engine.now_ms();
    for r in engine.store().due_routines(now)? {
        if let Err(error) = fire_due(engine, &r, now) {
            tracing::warn!(%error, routine = %r.id, "a routine could not run");
        }
    }
    engine.store().next_routine_due()
}

fn fire_due(engine: &Arc<Engine>, r: &StoredRoutine, now: i64) -> Result<(), RoutineError> {
    let trigger = trigger_of(r);
    let (Ok(Some(schedule)), Ok(zone)) = (trigger.schedule(), TimeZone::get(&r.time_zone)) else {
        // Unreadable now (a zone the system no longer knows): stop it rather than retry forever.
        engine.store().advance_routine(&r.id, r.next_due_ms, None)?;
        return Ok(());
    };
    let Some(next) = r.next_due_ms else {
        return Ok(());
    };
    let Some(due) = routine::due(&schedule, &zone, next, now) else {
        return Ok(());
    };
    if let Trigger::Heartbeat { quiet, .. } = trigger
        && routine::quiet_at(quiet, routine::local_minute(now, &zone))
    {
        engine
            .store()
            .advance_routine(&r.id, Some(next), due.next_ms)?;
        return Ok(());
    }
    let at = routine::clock_label(due.slot_ms, now, &zone);
    fire(
        engine,
        r,
        Firing {
            cause: if due.caught_up {
                "caught_up"
            } else {
                "schedule"
            },
            slot_ms: Some(due.slot_ms),
            claim: Some((Some(next), due.next_ms)),
            label: if due.caught_up {
                format!("caught up from {at}")
            } else {
                at
            },
            event: None,
        },
    )?;
    Ok(())
}

/// Runs routine `id` now, as the person asked (`manual`) or its webhook did (`webhook`).
pub async fn run_now(
    engine: &Arc<Engine>,
    id: &str,
    webhook: bool,
) -> Result<RunResult, RoutineError> {
    let _one = engine.routines_shared().firing.lock().await;
    let r = engine
        .store()
        .routine(id)?
        .filter(|r| r.kind == ROUTINE)
        .ok_or(RoutineError::NotFound)?;
    if webhook && (r.paused || !matches!(trigger_of(&r), Trigger::Webhook)) {
        return Err(RoutineError::Invalid(
            "This routine is paused or has no webhook.".to_owned(),
        ));
    }
    let (cause, label) = if webhook {
        ("webhook", "webhook")
    } else {
        ("manual", "run now")
    };
    let run = fire(
        engine,
        &r,
        Firing {
            cause,
            slot_ms: None,
            claim: None,
            label: label.to_owned(),
            event: None,
        },
    )?
    .ok_or(RoutineError::NotFound)?;
    last_result(engine, &r)?
        .filter(|result| result.id == run)
        .ok_or(RoutineError::NotFound)
}

/// An ace thread changed: every active routine waiting for that event runs.
pub(crate) async fn thread_changed(engine: &Arc<Engine>, change: &ThreadChange) {
    let event = match change.state {
        ThreadState::Done => AceEvent::ThreadDone,
        ThreadState::Failed => AceEvent::ThreadFailed,
        ThreadState::NeedsYou => AceEvent::ThreadNeedsYou,
    };
    let _one = engine.routines_shared().firing.lock().await;
    let routines = match engine.store().active_routines() {
        Ok(routines) => routines,
        Err(error) => {
            tracing::warn!(%error, "could not read routines for an ace event");
            return;
        }
    };
    let title: String = change
        .title
        .chars()
        .filter(|c| !c.is_control() && *c != '"')
        .take(80)
        .collect();
    for r in routines {
        if trigger_of(&r) != (Trigger::Event { event }) {
            continue;
        }
        let firing = Firing {
            cause: "event",
            slot_ms: None,
            claim: None,
            label: format!("{}: {title}", event.label()),
            event: Some(format!("{} ({}): {title}", event.label(), change.thread_id)),
        };
        if let Err(error) = fire(engine, &r, firing) {
            tracing::warn!(%error, routine = %r.id, "a routine could not run");
        }
    }
}

/// Claims and delivers one run, or records why it was skipped. Returns the run's id, or `None`
/// when another firing had already claimed the slot.
fn fire(
    engine: &Arc<Engine>,
    r: &StoredRoutine,
    firing: Firing,
) -> Result<Option<String>, RoutineError> {
    let agent = engine
        .store()
        .agent(&r.agent_id)?
        .ok_or(RoutineError::NoAgent)?;
    let heartbeat = r.kind == HEARTBEAT;
    let capped = engine.cap_refusal(&agent.conversation);
    let skip = if previous_open(engine, r, &agent.conversation)? {
        Some((
            "skipped_running",
            "The last run was still going.".to_owned(),
        ))
    } else if heartbeat && !engine.idle(&agent.conversation)? {
        Some(("skipped_busy", "The bot was busy.".to_owned()))
    } else if !engine.can_run_turn(&agent.conversation)? {
        Some(("skipped_cap", "Today's spending cap is reached.".to_owned()))
    } else {
        capped.map(|why| ("skipped_cap", why))
    };
    let run = StoredRun {
        id: engine.new_id("run"),
        routine_id: r.id.clone(),
        slot_ms: firing.slot_ms,
        at_ms: engine.now_ms(),
        cause: firing.cause.to_owned(),
        outcome: skip
            .as_ref()
            .map_or("pending", |(outcome, _)| outcome)
            .to_owned(),
        seq: None,
        detail: Some(
            skip.as_ref()
                .map_or(firing.label.clone(), |(_, why)| why.clone()),
        ),
    };
    let (slot, next) = match firing.claim {
        Some((slot, next)) => (Some(slot), next),
        None => (None, None),
    };
    if !engine.store().claim_run(&run, slot, next)? {
        return Ok(None);
    }
    if skip.is_none() {
        deliver(
            engine,
            r,
            &agent.conversation,
            &run.id,
            firing.label,
            firing.event,
        )?;
    }
    Ok(Some(run.id))
}

fn deliver(
    engine: &Arc<Engine>,
    r: &StoredRoutine,
    conversation: &str,
    run: &str,
    label: String,
    event: Option<String>,
) -> Result<(), RoutineError> {
    let heartbeat = r.kind == HEARTBEAT;
    let text = if heartbeat {
        routine::heartbeat_text(&r.instruction)
    } else {
        r.instruction.clone()
    };
    let from = FromRoutine {
        id: r.id.clone(),
        name: r.name.clone(),
        run: run.to_owned(),
        label,
        heartbeat,
        event,
    };
    match engine.deliver_routine(conversation, &text, from) {
        Ok(seq) => engine.store().run_delivered(run, seq)?,
        Err(error) => engine
            .store()
            .run_skipped(run, "failed", &error.to_string())?,
    }
    Ok(())
}

/// Delivers runs claimed before a stop, unless their message already made it.
fn recover(engine: &Arc<Engine>) -> Result<(), StoreError> {
    for run in engine.store().pending_runs()? {
        let Some(r) = engine.store().routine(&run.routine_id)? else {
            continue;
        };
        let Some(agent) = engine.store().agent(&r.agent_id)? else {
            continue;
        };
        match engine.routine_message_seq(&agent.conversation, &run.id)? {
            Some(seq) => engine.store().run_delivered(&run.id, seq)?,
            None => {
                let label = run.detail.clone().unwrap_or_default();
                let event = (run.cause == "event").then(|| label.clone());
                if let Err(error) = deliver(engine, &r, &agent.conversation, &run.id, label, event)
                {
                    tracing::warn!(%error, run = %run.id, "a claimed routine run was not delivered");
                }
            }
        }
    }
    Ok(())
}

/// Whether the routine's latest delivered run is still open: no reply has ended since.
fn previous_open(
    engine: &Engine,
    r: &StoredRoutine,
    conversation: &str,
) -> Result<bool, StoreError> {
    let Some(last) = engine.store().last_delivered_run(&r.id)? else {
        return Ok(false);
    };
    if last.outcome == "pending" {
        return Ok(true);
    }
    let after = last.seq.unwrap_or(1) - 1;
    let events = engine.store().events(conversation, after)?;
    Ok(routine::run_open(events.iter().map(|e| &e.event), &last.id))
}

/// The routine's latest run and how it went.
pub(crate) fn last_result(
    engine: &Engine,
    r: &StoredRoutine,
) -> Result<Option<RunResult>, StoreError> {
    let Some(run) = engine.store().runs(&r.id, 1)?.into_iter().next() else {
        return Ok(None);
    };
    let (result, detail) = match run.outcome.as_str() {
        "pending" => ("running", run.detail.clone()),
        "delivered" => answered(engine, r, &run)?,
        "failed" => ("failed", run.detail.clone()),
        _ => ("skipped", run.detail.clone()),
    };
    Ok(Some(RunResult {
        id: run.id,
        at_ms: run.at_ms,
        cause: run.cause,
        result,
        detail,
    }))
}

/// How the reply to a delivered run ended, if it has.
fn answered(
    engine: &Engine,
    r: &StoredRoutine,
    run: &StoredRun,
) -> Result<(&'static str, Option<String>), StoreError> {
    let Some(agent) = engine.store().agent(&r.agent_id)? else {
        return Ok(("running", None));
    };
    let after = run.seq.unwrap_or(1) - 1;
    let events = engine.store().events(&agent.conversation, after)?;
    for stored in &events {
        let Event::Known(known) = &stored.event else {
            continue;
        };
        return Ok(match known {
            Known::ReplyFinished { text, .. } if r.kind == HEARTBEAT && routine::is_quiet(text) => {
                ("quiet", None)
            }
            Known::ReplyFinished { .. } => ("answered", run.detail.clone()),
            Known::ReplyFailed { error, .. } => ("failed", Some(error.clone())),
            Known::ReplyStopped { .. } => ("stopped", None),
            Known::ReplyInterrupted { .. } => ("interrupted", None),
            _ => continue,
        });
    }
    Ok(("running", run.detail.clone()))
}
