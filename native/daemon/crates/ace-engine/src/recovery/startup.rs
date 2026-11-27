// SPDX-License-Identifier: Apache-2.0
//! Startup's cold pass over stored threads (`restart.ts:15`-`:415`, ADR 0223 §5): what a crash or a
//! stop cut short, what was queued and never sent, what a dead provider left running, and whether a
//! turn may continue by itself. Every thread and every slice is its own pump step, so readiness
//! never does history-sized work at once (ADR 0170).

use ace_json::Value;
use ace_store::{Value as Cell, stmt_cache};
use std::collections::HashMap;
use std::rc::Rc;

use crate::intents::header::{IntentHeader, headers};
use crate::queue::{holds, store as queue_store, write as queue_write};
use crate::repository::candidates::Scan;
use crate::restart::{RestartDecision, RestartFacts, restart_decision, restart_notice_text};
use crate::{Core, EngineError, State, ThreadId};

use super::capture;
use super::threads;

/// One thread's share of the first pass, as it will be decided once sends' uncertainty is known.
type Interrupted = HashMap<ThreadId, RestartFacts>;

/// `recoverEngine` (`restart.ts:15`), in bounded steps: prune, each thread's first pass, the open
/// tasks, the outstanding intents, then each thread's decision, and finally the queue's deadline.
pub async fn run(core: &Rc<Core>) -> Result<(), EngineError> {
    core.store.atomic(|_| {
        crate::transitions::state::prune_guards(core.store.conn())?;
        super::blob_cleanup::prepare(core)
    })?;
    core.with_state(|state| state.sessions.startup_task_sweep_pending = true)?;
    let processes_unverified = core.ports.previous_processes_unverified();
    let mut interrupted = Interrupted::new();
    let mut settled = std::collections::HashSet::new();

    let mut scan = Scan::new(String::new());
    loop {
        let step = core.store.atomic(|tx| scan.step(tx.conn()))?;
        let Some(step) = step else {
            crate::actor::yield_once().await;
            continue;
        };
        if step.done {
            break;
        }
        for thread in step.threads {
            let mut root = None;
            isolated(core, &thread, || {
                root = crate::settle::settled_root(core, &thread)?;
                Ok(())
            })?;
            if let Some(root) = root.filter(|root| settled.insert(root.clone())) {
                crate::settle::stop_tree(core, &root).await?;
            }
            isolated(core, &thread, || {
                first_pass(core, &thread, &mut interrupted, processes_unverified)?;
                repair_parent_status(core, &thread)
            })?;
            crate::actor::yield_once().await;
        }
        let after = scan.after().to_owned();
        scan.restart(after);
    }

    // A Cursor host stores its attempt before it calls Cursor: a submitted send without one never
    // reached Cursor, so it goes again, once.
    let mut after = 0;
    loop {
        let page = core.store.atomic(|tx| intent_page(tx.conn(), after))?;
        if page.is_empty() {
            break;
        }
        for row in page {
            let Some(Cell::Integer(id)) = row.get("id") else {
                return Err(EngineError::InvalidRecord);
            };
            after = *id;
            match IntentHeader::from_row(&row) {
                Ok(intent) => isolated(core, &intent.thread_id, || {
                    intent_step(core, &intent, processes_unverified)
                })?,
                Err(error) => {
                    let thread = row
                        .get("thread_id")
                        .and_then(crate::repository::residency::cell_text)
                        .unwrap_or("<unreadable thread>");
                    core.ports.report(format!("{thread}: intent {id}: {error}"));
                }
            }
            crate::actor::yield_once().await;
        }
        crate::actor::yield_once().await;
    }

    let mut scan = Scan::new(String::new());
    loop {
        let step = core.store.atomic(|tx| scan.step(tx.conn()))?;
        let Some(step) = step else {
            crate::actor::yield_once().await;
            continue;
        };
        if step.done {
            break;
        }
        for thread in step.threads {
            isolated(core, &thread, || {
                second_pass(core, &thread, &mut interrupted)?;
                repair_parent_status(core, &thread)
            })?;
            crate::actor::yield_once().await;
        }
        let after = scan.after().to_owned();
        scan.restart(after);
    }
    holds::schedule(core)
}

fn repair_parent_status(core: &Core, thread: &str) -> Result<(), EngineError> {
    core.store.atomic(|_| {
        core.with_state(|state| crate::liveness::reconcile::ancestors(core, state, thread))?
    })
}

/// One thread's isolated step: stored state that cannot be read quarantines only that thread, so
/// every other thread still recovers. Contention fails startup whole, to be retried.
fn isolated(
    core: &Core,
    thread: &str,
    run: impl FnOnce() -> Result<(), EngineError>,
) -> Result<(), EngineError> {
    match run() {
        Ok(()) => Ok(()),
        Err(error) if error.skippable_at_startup() => {
            core.ports.report(format!("{thread}: {error}"));
            Ok(())
        }
        Err(error) => Err(error),
    }
}

/// The first pass over one thread (`restart.ts:40`-`:224`).
fn first_pass(
    core: &Core,
    thread: &str,
    interrupted: &mut Interrupted,
    processes_unverified: bool,
) -> Result<(), EngineError> {
    core.store.atomic(|_| {
        core.with_state(|state| {
            first_pass_in(core, state, thread, interrupted, processes_unverified)
        })?
    })
}

#[allow(clippy::too_many_lines)]
fn first_pass_in(
    core: &Core,
    state: &mut State,
    thread: &str,
    interrupted: &mut Interrupted,
    processes_unverified: bool,
) -> Result<(), EngineError> {
    if state.repo.cleaning(thread) {
        return Ok(());
    }
    let now = core.ports.now();
    // Read before anything below holds the queue.
    let held_before = queue_store::get(&core.store, thread)?.paused;
    let snapshot = state.repo.require_state(&core.store, thread)?;
    snapshot
        .try_borrow_mut()
        .map_err(|_| EngineError::Reentrant)?
        .hydrate_recovery()?;
    let view = {
        let borrowed = snapshot.try_borrow().map_err(|_| EngineError::Reentrant)?;
        ThreadView {
            process_exit: borrowed.state.process_exit.is_some(),
            runs_empty: borrowed.state.runs.is_empty(),
            engine_queued: borrowed.state.queue_sources.engine,
            provider_queued: borrowed.state.queue_sources.provider,
            root_key: borrowed.state.root_key.clone(),
        }
    };
    // Replayed, a rate limit marks the agent limited, and one left retrying after its turn ended
    // stops counting as busy.
    let legacy: Vec<Value> = {
        let borrowed = snapshot.try_borrow().map_err(|_| EngineError::Reentrant)?;
        borrowed
            .state
            .agents
            .iter()
            .filter_map(|(agent, record)| {
                let retry = record
                    .retry
                    .as_ref()
                    .filter(|retry| retry.on == "rate_limit")?;
                (record.limited.is_none() || record.active_run.is_none()).then(|| {
                    let mut fact = ace_json::Map::new();
                    fact.insert("type", Value::from("retry"));
                    fact.insert("agent", Value::from(agent.as_str()));
                    fact.insert("on", Value::from(retry.on.as_str()));
                    if let Some(attempt) = retry.attempt {
                        fact.insert("attempt", Value::from(attempt));
                    }
                    if let Some(until) = retry.until {
                        fact.insert("until", Value::from(until));
                    }
                    if let Some(message) = &retry.message {
                        fact.insert("message", Value::from(message.as_str()));
                    }
                    Value::Object(fact)
                })
            })
            .collect()
    };
    if !legacy.is_empty() {
        apply(core, state, thread, &legacy, now)?;
    }
    let untracked = view.engine_queued > state.queued_count(&core.store, thread)?;
    if untracked || view.provider_queued > 0 {
        let notice = untracked_notice(untracked, view.root_key.as_deref());
        apply(core, state, thread, &[notice], now)?;
    }
    let unsent = crate::intents::store::undelivered(core.store.conn(), thread)?;
    if let Some(unsent) = unsent {
        crate::intents::lifecycle::defer(core.store.conn(), &unsent.header)?;
        // Back in the queue; the bubble its claim created keeps its place.
        queue_store::track_attachments(
            core.store.conn(),
            unsent.header.id,
            thread,
            &unsent.command,
        )?;
        queue_write::set(
            &core.store,
            thread,
            r#"{"paused":true,"reason":"not_sent"}"#,
            now,
        )?;
        // A message recovered now is a request the person has never seen: a settle made before it
        // surfaced doesn't cover it, so the thread comes back.
        if threads::get(&core.store, thread)?.is_some_and(|row| row.settled) {
            core.store.write_events(
                thread,
                r#"[{"type":"thread.client.updated","changes":{"settledAt":null,"settledReason":null,"autoSettleAt":null}}]"#,
                now,
            )?;
        }
    }
    let queue = queue_store::get(&core.store, thread)?;
    if (queue.trigger.as_deref() == Some("restart") || queue.reason.as_deref() == Some("restart"))
        && view.runs_empty
    {
        let count = queue_store::count(core.store.conn(), thread)?;
        let patch = format!(
            r#"{{"continuation":null,"trigger":null,"paused":{},"reason":{}}}"#,
            count > 0,
            if count > 0 { "\"not_sent\"" } else { "null" }
        );
        queue_write::set(&core.store, thread, &patch, now)?;
    }
    for intent in headers(core.store.conn(), Some(thread), None)? {
        if matches!(
            intent.kind.as_str(),
            "thread.resume" | "queue.resume" | "thread.limit"
        ) && intent.submitted_generation.is_some()
            && !intent.acknowledged
            && (intent.status == "running" || intent.awaiting)
        {
            queue_store::set_uncertain(core.store.conn(), intent.id, true)?;
        }
    }
    capture::drop_continuation_behind_stop_in(core, state, thread)?;
    // A settled thread is finished for the person: a restart leaves it nothing to resume, and a
    // hold an earlier restart left goes now.
    if threads::get(&core.store, thread)?.is_some_and(|row| row.settled) {
        capture::close_settled_in(core, state, thread)?;
    } else {
        capture::capture_restart_in(core, state, thread)?;
    }
    // A stopped provider no longer owns an admitted continuation. Native history remains the
    // source for a new restart continuation, never the old input.
    if crate::intents::store::uncertain_continuation(core.store.conn(), thread)?.is_none() {
        crate::intents::store::finish_continuation(core.store.conn(), thread)?;
    }
    let backend = state.backend(&core.store, thread)?;
    let live = {
        let borrowed = snapshot.try_borrow().map_err(|_| EngineError::Reentrant)?;
        !view.process_exit
            && crate::restart::lost_work(&borrowed.state, 0, backend.as_deref(), now as i64)
                .is_some()
    };
    // Left running for its reconcile, which ends it as Cursor's store says it ended.
    let reconciles = live && backend.as_deref() == Some("cursor-sdk") && !processes_unverified;
    // A graceful shutdown captured its continuation before closing the provider, so its state
    // shows a deliberate exit; the captured continuation is the evidence either way.
    let captured = queue_store::get(&core.store, thread)?;
    let row = threads::get(&core.store, thread)?;
    let settled = row.as_ref().is_some_and(|row| row.settled);
    let candidate = backend.as_deref() != Some("cursor-sdk")
        && !held_before
        && captured.trigger.as_deref() == Some("restart")
        && captured.continuation.is_some()
        && !settled;
    if candidate {
        interrupted.insert(
            thread.to_owned(),
            RestartFacts {
                was_running: true,
                held_before,
                settled: false,
                archived: row.as_ref().is_some_and(|row| row.archived),
                waiting_on_person: false,
                uncertain: false,
                can_continue: crate::restart::continues_natively(core, state, thread)?,
                streak: crate::restart::streak(core.store.conn(), thread)?,
            },
        );
    }
    if live && backend.as_deref() == Some("cursor-sdk") && !reconciles {
        let detail = {
            let borrowed = snapshot.try_borrow().map_err(|_| EngineError::Reentrant)?;
            crate::restart::lost_work(&borrowed.state, 0, backend.as_deref(), now as i64)
        };
        apply(
            core,
            state,
            thread,
            &[uncertain_notice(detail, view.root_key.as_deref())],
            now,
        )?;
    }
    if live && processes_unverified {
        apply(
            core,
            state,
            thread,
            &[
                process_exited(
                    "Daemon restarted; previous provider processes could not be verified as stopped",
                ),
                queue_changed(),
                unverified_notice(view.root_key.as_deref()),
            ],
            now,
        )?;
        // Never start the work again beside processes that may still be doing it.
        interrupted.remove(thread);
        return Ok(());
    }
    if reconciles {
        crate::cursor_reconcile::mark(state, thread);
    } else if live {
        let mut facts = vec![
            process_exited("Daemon restarted; previous provider work stopped"),
            queue_changed(),
        ];
        // A candidate's notice says what happens next, once that is decided below.
        if !candidate {
            facts.push(crate::restart::interrupted_notice(
                view.root_key.as_deref(),
                now,
                "restart",
                None,
            ));
        }
        apply(core, state, thread, &facts, now)?;
    }
    Ok(())
}

/// The outstanding intents' step (`restart.ts:240`-`:341`).
fn intent_step(
    core: &Core,
    intent: &IntentHeader,
    processes_unverified: bool,
) -> Result<(), EngineError> {
    let thread = &intent.thread_id;
    core.store.atomic(|_| {
        core.with_state(|state| {
            if state.repo.cleaning(thread) {
                return fail(core, state, intent, "Retired for thread deletion");
            }
            let row = threads::get(&core.store, thread)?;
            // A Spade bot's old session (ADR 0219): inert, so nothing here carries on or replays.
            if row.as_ref().and_then(|row| row.host.as_deref()) == Some("spade-bot") {
                return fail(
                    core,
                    state,
                    intent,
                    "Spade bots no longer run in ace's threads.",
                );
            }
            if row.as_ref().is_some_and(|row| row.continuation()) {
                return fail(
                    core,
                    state,
                    intent,
                    "This Cursor CLI thread is read-only. Continue in a new thread with its saved history.",
                );
            }
            let backend = state.backend(&core.store, thread)?;
            let cursor = backend.as_deref() == Some("cursor-sdk");
            let never_reached_cursor = cursor
                && !super::provider_recovery::attempted(
                    core.store.conn(),
                    thread,
                    &intent.command_id,
                )?;
            // A Cursor send an earlier start left uncertain, after its reconcile may already have
            // read Cursor's answer and died before settling it: reconcile again, which settles it.
            if intent.status == "failed"
                && !intent.acknowledged
                && cursor
                && !processes_unverified
                && crate::intents::store::uncertain_send(
                    core.store.conn(),
                    thread,
                    &intent.command_id,
                )?
                .is_some()
            {
                crate::cursor_reconcile::mark(state, thread);
                return Ok(());
            }
            if intent.kind == "thread.merge"
                && matches!(intent.status.as_str(), "pending" | "queued")
                && let Some(core) = core.self_rc()
            {
                return crate::transitions::dispatch::recover_thread(&core, state, thread);
            }
            if intent.status == "running" || intent.awaiting {
                let delivery = matches!(
                    intent.kind.as_str(),
                    "thread.send"
                        | "thread.create"
                        | "thread.fork"
                        | "thread.resume"
                        | "queue.resume"
                        | "thread.limit"
                );
                if delivery
                    && !intent.acknowledged
                    && (intent.submitted_generation.is_none() || never_reached_cursor)
                {
                    crate::intents::lifecycle::defer(core.store.conn(), intent)?;
                    return Ok(());
                }
                if !intent.acknowledged
                    && intent.submitted_generation.is_some()
                    && (matches!(
                        intent.kind.as_str(),
                        "thread.send"
                            | "thread.create"
                            | "thread.resume"
                            | "queue.resume"
                            | "thread.limit"
                    ) || (intent.kind == "thread.fork" && cursor))
                {
                    queue_store::set_uncertain(core.store.conn(), intent.id, true)?;
                    // Cursor's store can show whether it ever had this send.
                    if cursor && !processes_unverified {
                        crate::cursor_reconcile::mark(state, thread);
                    }
                }
                // The provider had taken it: it was sent, whatever became of its turn, which the
                // thread shows on its own. Failing it would say "not sent" for a message that ran.
                if intent.acknowledged {
                    return crate::intents::lifecycle::mark(&core.store, intent, "done", None);
                }
                return fail(
                    core,
                    state,
                    intent,
                    "Delivery interrupted by daemon restart; execution is uncertain. Review before resending.",
                );
            }
            if intent.status == "pending"
                && !matches!(
                    intent.kind.as_str(),
                    "thread.send"
                        | "thread.create"
                        | "thread.fork"
                        | "thread.switch"
                        | "thread.merge"
                        | "thread.resume"
                        | "queue.resume"
                        | "thread.limit"
                )
            {
                return fail(
                    core,
                    state,
                    intent,
                    "Control interrupted by daemon restart; retry explicitly",
                );
            }
            Ok(())
        })?
    })
}

fn fail(
    core: &Core,
    _state: &mut State,
    intent: &IntentHeader,
    message: &str,
) -> Result<(), EngineError> {
    crate::intents::lifecycle::mark(&core.store, intent, "failed", Some(message))
}

/// The decision pass (`restart.ts:342`-`:413`): each capture informs one decision, taken in the
/// same transaction, so a crash before here leaves it for the next start.
fn second_pass(
    core: &Core,
    thread: &str,
    interrupted: &mut Interrupted,
) -> Result<(), EngineError> {
    core.store
        .atomic(|_| core.with_state(|state| second_pass_in(core, state, thread, interrupted))?)
}

fn second_pass_in(
    core: &Core,
    state: &mut State,
    thread: &str,
    interrupted: &mut Interrupted,
) -> Result<(), EngineError> {
    if state.repo.cleaning(thread) {
        return Ok(());
    }
    let now = core.ports.now();
    if threads::get(&core.store, thread)?
        .and_then(|row| row.host)
        .as_deref()
        == Some("spade-bot")
    {
        crate::restart::take_capture(core.store.conn(), thread)?;
        capture::discard_holding_in(core, state, thread, capture::RELEASED)?;
        return Ok(());
    }
    let capture_taken = crate::restart::take_capture(core.store.conn(), thread)?;
    let queue = queue_store::get(&core.store, thread)?;
    let pending = crate::intents::store::message(core.store.conn(), thread)?.is_some()
        || crate::intents::store::recovery(core.store.conn(), thread)?.is_some();
    holds::sync(core, state, thread, now)?;
    if !pending
        && queue.continuation.is_none()
        && queue_store::count(core.store.conn(), thread)? == 0
    {
        return Ok(());
    }
    let uncertain = queue_store::has_uncertain(core.store.conn(), thread)?;
    let reason = if matches!(
        queue.reason.as_deref(),
        Some("stopped") | Some("model_unavailable") | Some("not_sent")
    ) {
        queue.reason.clone().unwrap_or_default()
    } else if uncertain {
        "uncertain".to_owned()
    } else if queue.limited {
        "limit".to_owned()
    } else if queue.continuation.is_some() {
        "restart".to_owned()
    } else {
        "not_sent".to_owned()
    };
    let patch = format!(r#"{{"paused":true,"reason":"{reason}"}}"#);
    queue_write::set(&core.store, thread, &patch, now)?;
    holds::sync(core, state, thread, now)?;
    // Work this restart cut short carries on by itself when that is safe; otherwise it stays held
    // for the person with a notice saying why. Queued messages follow it in order.
    if let Some(work) = interrupted.remove(thread) {
        let waiting_on_person = capture_taken
            .as_ref()
            .and_then(|capture| capture.waiting_on.clone());
        let decision = restart_decision(&RestartFacts {
            waiting_on_person: waiting_on_person.is_some(),
            uncertain: uncertain || queue.reason.as_deref() == Some("not_sent"),
            ..work
        });
        let root = state.repo.state(&core.store, thread)?.and_then(|snapshot| {
            snapshot
                .try_borrow()
                .ok()
                .and_then(|borrowed| borrowed.state.root_key.clone())
        });
        let text = match decision {
            RestartDecision::None => None,
            _ => Some(restart_notice_text(decision, waiting_on_person.as_deref())),
        };
        apply(
            core,
            state,
            thread,
            &[crate::restart::interrupted_notice(
                root.as_deref(),
                now,
                "restart",
                text.as_deref(),
            )],
            now,
        )?;
        if decision == RestartDecision::Resume {
            let receipt = super::deadline::automatic_in(core, state, thread, None)?;
            if let Some(receipt) = receipt
                && receipt.get("ok").and_then(Value::as_bool) != Some(true)
                && receipt.get("error").and_then(Value::as_str) != Some("engine_capacity_exceeded")
            {
                return Err(EngineError::Records(format!(
                    "Restart resume refused: {}",
                    ace_json::to_string(&receipt)
                )));
            }
            crate::restart::increment_streak(core.store.conn(), thread)?;
            return Ok(());
        }
    }
    // Recovery controls already accepted before a crash are safe only when unclaimed.
    if (crate::intents::store::recovery(core.store.conn(), thread)?.is_some()
        || crate::intents::store::transition(core.store.conn(), thread)?.is_some())
        && state.reserve_slot(&core.store, thread)?
    {
        holds::wake(core, thread);
    }
    Ok(())
}

/// The next page of outstanding intents, 64 at a time (`intents.ts:135`).
fn intent_page(
    conn: &std::sync::Arc<ace_store::Connection>,
    after: i64,
) -> Result<Vec<stmt_cache::Row>, EngineError> {
    const SQL: &str = "SELECT id,command_id,thread_id,kind,status,attempts,awaiting,ack_target,delivery,acknowledged,trigger,submitted_generation,resolution_generation,resolution_id FROM intents WHERE id>? AND (status IN ('pending','queued','running') OR awaiting=1 OR uncertain=1) ORDER BY id LIMIT 64";
    Ok(stmt_cache::all_rows(conn, SQL, vec![Cell::Integer(after)])?)
}

/// What the first pass read of a thread's state once.
struct ThreadView {
    process_exit: bool,
    runs_empty: bool,
    engine_queued: i64,
    provider_queued: i64,
    root_key: Option<String>,
}

fn untracked_notice(untracked: bool, root: Option<&str>) -> Value {
    let mut draft = ace_json::Map::new();
    draft.insert("type", Value::from("notice"));
    draft.insert("level", Value::from("warning"));
    draft.insert(
        "text",
        Value::from(if untracked {
            "Recovered untracked queue state; execution is uncertain"
        } else {
            "Provider queued work was interrupted; execution is uncertain"
        }),
    );
    draft.insert("complete", Value::Bool(true));
    upsert(root.unwrap_or("root"), "recovery:untracked", draft)
}

fn uncertain_notice(detail: Option<String>, root: Option<&str>) -> Value {
    let mut draft = ace_json::Map::new();
    draft.insert("type", Value::from("notice"));
    draft.insert("level", Value::from("warning"));
    draft.insert("code", Value::from("recovery_uncertain"));
    draft.insert("title", Value::from("Recovery needed"));
    draft.insert("text", Value::from("Previous work needs reconciliation"));
    if let Some(detail) = detail {
        draft.insert("detail", Value::from(detail));
    }
    draft.insert("complete", Value::Bool(true));
    upsert(root.unwrap_or("root"), "recovery:uncertain", draft)
}

fn unverified_notice(root: Option<&str>) -> Value {
    let mut draft = ace_json::Map::new();
    draft.insert("type", Value::from("notice"));
    draft.insert("level", Value::from("warning"));
    draft.insert("code", Value::from("recovery_uncertain"));
    draft.insert("title", Value::from("Recovery needed"));
    draft.insert(
        "text",
        Value::from("Some processes from the previous run may still be running"),
    );
    draft.insert("complete", Value::Bool(true));
    upsert(
        root.unwrap_or("root"),
        "recovery:unverified-processes",
        draft,
    )
}

fn upsert(agent: &str, item: &str, draft: ace_json::Map) -> Value {
    let mut fact = ace_json::Map::new();
    fact.insert("type", Value::from("item.upsert"));
    fact.insert("agent", Value::from(agent));
    fact.insert("item", Value::from(item));
    fact.insert("draft", Value::Object(draft));
    Value::Object(fact)
}

fn process_exited(message: &str) -> Value {
    let mut fact = ace_json::Map::new();
    fact.insert("type", Value::from("process.exited"));
    fact.insert("deliberate", Value::Bool(false));
    fact.insert("message", Value::from(message));
    Value::Object(fact)
}

fn queue_changed() -> Value {
    let mut fact = ace_json::Map::new();
    fact.insert("type", Value::from("queue.changed"));
    fact.insert("source", Value::from("provider"));
    fact.insert("count", Value::from(0));
    Value::Object(fact)
}

fn apply(
    core: &Core,
    state: &mut State,
    thread: &str,
    facts: &[Value],
    at: f64,
) -> Result<(), EngineError> {
    state.apply(
        &core.store,
        thread,
        &ace_json::to_string(&Value::Array(facts.to_vec().into())),
        at,
        None,
    )
}

#[cfg(test)]
mod tests;
