// SPDX-License-Identifier: Apache-2.0
//! What a fold teaches recovery (`recovery.ts:404`-`:575`): a completed turn ends the restart
//! streak and settles a capture the provider outlived; a limit holds the queue and its account,
//! with the deadline the person chose; and the limit policy loads beside the receipt, bounded and
//! with a notice when it cannot be read.

use ace_json::Value;
use std::rc::Rc;

use crate::executor::Lane;
use crate::queue::{holds, store as queue_store, write as queue_write};
use crate::{Core, EngineError, State};

/// The thread's state as recovery reads it in one fold, copied out before any write so no borrow
/// is held across a transaction.
struct View {
    provider: String,
    root_key: Option<String>,
    /// The root's quota evidence: `Some(until)` while `limited` is set, `None` without it.
    root_limited: Option<Option<i64>>,
    root_native_provider: Option<String>,
}

/// `recovery.observe()` (`recovery.ts:404`): the fold's facts, after the state committed.
pub fn observe(core: &Core, thread: &str, facts: &[Value], at: f64) -> Result<(), EngineError> {
    if super::capture::spade_owned(core, thread)? {
        return Ok(());
    }
    let view = view(core, thread)?;
    // A root turn that completes ends any run of restarts the loop guard was counting.
    let root_completed = facts
        .iter()
        .any(|fact| completed_turn(fact) && fact_agent(fact) == view.root_key.as_deref());
    if root_completed {
        crate::restart::clear_streak(core.store.conn(), thread)?;
        super::capture::drop_stale_capture(core, thread, at)?;
        super::capture::release_completed_restart(core, thread, at)?;
    }
    if !facts.iter().any(limit_signal) {
        return Ok(());
    }
    let queue = queue_store::get(&core.store, thread)?;
    let limited = view.root_limited.is_some()
        && view.root_native_provider.as_deref() == Some(view.provider.as_str());
    if !limited {
        if !queue.limited {
            return Ok(());
        }
        // The provider completed a turn: the account could work, so the limit hold goes. Other
        // clears keep the hold their owner manages.
        let completed = facts.iter().any(completed_turn);
        if completed
            && queue.paused
            && queue.reason.as_deref() == Some("limit")
            && !crate::intents::store::recovering(core.store.conn(), thread)?
        {
            core.with_state(|state| holds::lift_in(core, state, thread, at))??;
            holds::schedule(core)?;
            holds::wake(core, thread);
        } else {
            queue_write::set(&core.store, thread, r#"{"limited":false}"#, at)?;
        }
        return Ok(());
    }
    let reset = account_reset(core, thread, view.root_limited.flatten())?;
    if queue.limited && queue.reset_at == reset {
        return Ok(());
    }
    let policy = limit_policy(core, thread)?;
    // A limit with a known reset lets go at that reset. ace never starts a turn by itself: only
    // "resume at reset" sends then; otherwise the limit clears and queued messages wait for the
    // person's Resume or next message. Without a reset nothing is timed.
    let timed = policy != "migrate_now";
    let action = match policy.as_str() {
        "resume_at_reset" => "resume",
        "snooze_until_reset" => "snooze",
        _ => "clear",
    };
    let continuation = queue
        .continuation
        .clone()
        .unwrap_or_else(|| ace_core::person_input::CONTINUE_MESSAGE.to_owned());
    let trigger = queue
        .trigger
        .clone()
        .unwrap_or_else(|| "limit_resume".to_owned());
    let mut patch = ace_json::Map::new();
    patch.insert("limited", Value::Bool(true));
    patch.insert("paused", Value::Bool(true));
    patch.insert("holdToken", Value::from(queue.hold_token + 1));
    patch.insert("reason", Value::from("limit"));
    patch.insert(
        "resetAt",
        reset.map_or(Value::Null, |at| Value::from(at as f64)),
    );
    patch.insert("continuation", Value::from(continuation));
    patch.insert("trigger", Value::from(trigger));
    let timed_reset = timed && reset.is_some_and(|reset| reset > at as i64);
    patch.insert(
        "resumeAt",
        if timed_reset {
            Value::from(reset.unwrap_or_default() as f64)
        } else {
            Value::Null
        },
    );
    patch.insert(
        "timerAction",
        if timed_reset {
            Value::from(action)
        } else {
            Value::Null
        },
    );
    queue_write::set(
        &core.store,
        thread,
        &ace_json::to_string(&Value::Object(patch)),
        at,
    )?;
    if policy == "migrate_now" && core.ports.has_move_target() {
        super::deadline::automatic(core, thread, Some("migrate_now"))?;
    }
    holds::schedule(core)?;
    if core.inputs().has_preferences {
        let token = queue_store::get(&core.store, thread)?.hold_token;
        refresh_policy(core, thread, token)?;
    }
    Ok(())
}

/// The roots's quota reset: the port's reading, else the latest `until` on the root.
fn account_reset(
    core: &Core,
    thread: &str,
    until: Option<i64>,
) -> Result<Option<i64>, EngineError> {
    let stored = until;
    if !core.ports.has_reset_at() {
        return Ok(stored);
    }
    Ok(match core.ports.reset_at(thread)? {
        Some(crate::ports::ResetAt::At(at)) => Some(at),
        Some(crate::ports::ResetAt::Null) => None,
        Some(crate::ports::ResetAt::Undefined) | None => stored,
    })
}

/// `this.ports.preferences ? "manual" : this.preferences(id).limitPolicy` (`recovery.ts:465`):
/// with the port, the policy is still loading, so ace treats it as the manual default.
fn limit_policy(core: &Core, thread: &str) -> Result<String, EngineError> {
    if core.inputs().has_preferences {
        return Ok("manual".to_owned());
    }
    core.with_state(|state| {
        let preferences = crate::queue::admission::thread_preferences(core, state, thread)?;
        Ok::<String, EngineError>(
            preferences
                .get("limitPolicy")
                .and_then(Value::as_str)
                .unwrap_or("manual")
                .to_owned(),
        )
    })?
}

/// The thread's state, copied out.
fn view(core: &Core, thread: &str) -> Result<View, EngineError> {
    core.with_state(|state| {
        let Some(snapshot) = state.repo.state(&core.store, thread)? else {
            return Ok::<Option<View>, EngineError>(None);
        };
        let borrowed = snapshot.try_borrow().map_err(|_| EngineError::Reentrant)?;
        let root_key = borrowed.state.root_key.clone();
        let root = root_key
            .as_ref()
            .and_then(|root| borrowed.state.agents.get(root));
        Ok(Some(View {
            provider: borrowed.state.config.provider.clone(),
            root_key,
            root_limited: root.and_then(|record| record.limited.as_ref().map(|info| info.until)),
            root_native_provider: root.map(|record| record.agent.native.provider.clone()),
        }))
    })??
    .ok_or(EngineError::MissingState)
}

/// `turn.ended` with `outcome: "completed"`, committed in this fold.
fn completed_turn(fact: &Value) -> bool {
    fact.get("type").and_then(Value::as_str) == Some("turn.ended")
        && fact.get("outcome").and_then(Value::as_str) == Some("completed")
        && fact.get("historical").and_then(Value::as_bool) != Some(true)
}

fn fact_agent(fact: &Value) -> Option<&str> {
    fact.get("agent").and_then(Value::as_str)
}

/// The facts that say a limit may have started or cleared (`recovery.ts:421`-`:427`).
fn limit_signal(fact: &Value) -> bool {
    let kind = fact.get("type").and_then(Value::as_str).unwrap_or_default();
    if kind == "limit.cleared" {
        return true;
    }
    if kind == "retry" && fact.get("on").and_then(Value::as_str) == Some("rate_limit") {
        return true;
    }
    kind == "turn.ended"
        && (fact
            .get("error")
            .and_then(|error| error.get("kind"))
            .and_then(Value::as_str)
            == Some("quota")
            || fact.get("outcome").and_then(Value::as_str) == Some("completed"))
}

/// `recovery.clearLimit()` (`recovery.ts:751`): the limit is gone; queued messages and the
/// continuation wait for the person's Resume or next message.
pub fn clear_limit(core: &Core, thread: &str) -> Result<(), EngineError> {
    let at = core.ports.now();
    core.with_state(|state| clear_limit_in(core, state, thread, at))??;
    holds::schedule(core)
}

fn clear_limit_in(
    core: &Core,
    state: &mut State,
    thread: &str,
    at: f64,
) -> Result<(), EngineError> {
    let queue = queue_store::get(&core.store, thread)?;
    let timed = matches!(
        queue.timer_action.as_deref(),
        Some("resume") | Some("snooze")
    );
    let patch = if timed {
        r#"{"limited":false,"resetAt":null}"#.to_owned()
    } else {
        // A manual hold that remembers when its limit cleared: the person's next message
        // releases it, unlike a pause they chose or a switch's held continuation.
        format!(
            r#"{{"limited":false,"resetAt":{},"reason":"manual","resumeAt":null,"timerAction":null}}"#,
            at as i64
        )
    };
    queue_write::set(&core.store, thread, &patch, at)?;
    let cleared = cleared_limits(core, state, thread)?;
    if !cleared.is_empty() {
        state.apply(
            &core.store,
            thread,
            &ace_json::to_string(&Value::Array(cleared.into())),
            at,
            None,
        )?;
    }
    holds::sync(core, state, thread, at)
}

/// The `limit.cleared` facts the root's limited record deserves.
fn cleared_limits(core: &Core, state: &mut State, thread: &str) -> Result<Vec<Value>, EngineError> {
    let Some(snapshot) = state.repo.state(&core.store, thread)? else {
        return Ok(Vec::new());
    };
    let borrowed = snapshot.try_borrow().map_err(|_| EngineError::Reentrant)?;
    let root = borrowed.state.root_key.clone();
    Ok(borrowed
        .state
        .agents
        .iter()
        .filter(|(key, record)| Some((*key).clone()) == root && record.limited.is_some())
        .map(|(key, _)| {
            let mut fact = ace_json::Map::new();
            fact.insert("type", Value::from("limit.cleared"));
            fact.insert("agent", Value::from(key.as_str()));
            Value::Object(fact)
        })
        .collect())
}

/// `recovery.accountRecovered()` (`recovery.ts:740`): a fresh reading below the limit lifts it.
pub fn account_recovered(core: &Core, thread: &str) -> Result<(), EngineError> {
    let queue = queue_store::get(&core.store, thread)?;
    if !queue.limited || !queue.paused || queue.reason.as_deref() != Some("limit") {
        return Ok(());
    }
    if crate::intents::store::recovering(core.store.conn(), thread)? {
        return Ok(());
    }
    clear_limit(core, thread)
}

/// `recovery.refreshPolicy()` (`recovery.ts:497`): load the thread's settings beside the receipt,
/// at most 64 at a time, and apply what they say once they are read.
pub fn refresh_policy(core: &Core, thread: &str, token: i64) -> Result<(), EngineError> {
    let (closed, pending) = core.with_state(|state| {
        (
            state.recovery.closed,
            state.recovery.pending_policy.contains_key(thread),
        )
    })?;
    if pending || closed {
        return Ok(());
    }
    let over = core.with_state(|state| state.recovery.pending_policy.len() >= 64)?;
    if over {
        // Past the bound it waits its turn, still loading: until it loads, nothing settles the
        // thread on a policy it hasn't read.
        core.with_state(|state| {
            state
                .recovery
                .waiting_policy
                .insert(thread.to_owned(), token);
        })?;
        return Ok(());
    }
    start_policy(core, thread, token)
}

fn start_policy(core: &Core, thread: &str, token: i64) -> Result<(), EngineError> {
    core.with_state(|state| {
        state.recovery.waiting_policy.shift_remove(thread);
        state.recovery.pending_policy.insert(thread.to_owned(), ());
    })?;
    let Some(ask) = core.self_rc() else {
        finish_policy(core, thread);
        return Ok(());
    };
    let thread = thread.to_owned();
    let task = core.executor.spawn(Lane::Work, async move {
        if let Err(error) = refresh_once(&ask, &thread, token).await {
            settings_notice(&ask, &thread, &error).await;
        }
        finish_policy(&ask, &thread);
        notify_policy_listeners(&ask, &thread);
    });
    task.detach();
    Ok(())
}

/// The load itself: the preferences, then the policy's own hold or move.
async fn refresh_once(core: &Rc<Core>, thread: &str, token: i64) -> Result<(), EngineError> {
    super::prepare_thread(core, thread).await?;
    let now = core.ports.now();
    let can_move = core.ports.has_move_target();
    let hold = core.with_state(|state| {
        let queue = queue_store::get(&core.store, thread)?;
        if state.recovery.closed || !queue.limited || !holds::owns(core, thread, token)? {
            return Ok::<Option<Hold>, EngineError>(None);
        }
        let preferences = crate::queue::admission::thread_preferences(core, state, thread)?;
        let policy = preferences
            .get("limitPolicy")
            .and_then(Value::as_str)
            .unwrap_or("manual");
        if policy == "migrate_now" && can_move {
            return Ok(Some(Hold::Move));
        }
        if (policy == "resume_at_reset" || policy == "snooze_until_reset")
            && queue.reset_at.is_some_and(|reset| reset as f64 > now)
        {
            let resume = policy == "resume_at_reset";
            return Ok(Some(Hold::At {
                reset: queue.reset_at.unwrap_or_default(),
                resume,
            }));
        }
        Ok(None)
    })??;
    match hold {
        Some(Hold::Move) => {
            super::deadline::automatic(core, thread, Some("migrate_now"))?;
        }
        Some(Hold::At { reset, resume }) => {
            let mut patch = ace_json::Map::new();
            patch.insert("resumeAt", Value::from(reset as f64));
            patch.insert(
                "timerAction",
                Value::from(if resume { "resume" } else { "snooze" }),
            );
            patch.insert(
                "reason",
                Value::from(if resume { "limit" } else { "snooze" }),
            );
            queue_write::set(
                &core.store,
                thread,
                &ace_json::to_string(&Value::Object(patch)),
                now,
            )?;
        }
        None => {}
    }
    holds::schedule(core)
}

/// What the loaded policy asks of a still-limited thread.
enum Hold {
    Move,
    At { reset: i64, resume: bool },
}

/// The notice a policy that could not be read leaves (`recovery.ts:528`-`:548`).
async fn settings_notice(core: &Rc<Core>, thread: &str, error: &EngineError) {
    let live = Rc::clone(&core.actor_deps.borrow().live);
    live.writable().await;
    let closed = core
        .with_state(|state| state.recovery.closed)
        .unwrap_or(true);
    if closed {
        return;
    }
    let text = format!("Could not load recovery settings: {error}");
    let facts = format!(
        r#"[{{"type":"item.upsert","agent":"root","item":"recovery:settings","draft":{{"type":"notice","level":"error","complete":true,"text":{}}}}}]"#,
        Value::from(text)
    );
    let _ =
        core.with_state(|state| state.apply(&core.store, thread, &facts, core.ports.now(), None));
}

/// One load finished: the next waiter starts, and the listeners hear about this thread.
fn finish_policy(core: &Core, thread: &str) {
    let next = core
        .with_state(|state| {
            state.recovery.pending_policy.shift_remove(thread);
            state
                .recovery
                .waiting_policy
                .first()
                .map(|(id, token)| (id.clone(), *token))
        })
        .ok()
        .flatten();
    if let Some((thread, token)) = next
        && let Err(error) = start_policy(core, &thread, token)
    {
        core.ports.report(error.to_string());
    }
}

/// Tells every listener, reporting one that throws without stopping the rest (`recovery.ts:558`).
fn notify_policy_listeners(core: &Core, thread: &str) {
    let Ok(listeners) = core.with_state(|state| state.recovery.policy_listeners.clone()) else {
        return;
    };
    for listener in listeners {
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| listener(thread)));
        if outcome.is_err() {
            core.ports
                .report("recovery policy listener threw".to_owned());
        }
    }
}

#[cfg(test)]
mod tests;
