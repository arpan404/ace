// SPDX-License-Identifier: Apache-2.0
//! `steer-yield.ts`'s rules and `steer-lane.ts:32`-`:45`, `:106`-`:140` (E5.4f): how a waiting
//! steer reaches the model now, or why it waits. `steerNow`, `yieldTurn`, `markYieldedEnd` and
//! the lane's `run` are E5.5's execution.
//!
//! The lane's session facts (`steerViaCancel`, `backgroundTools`) belong to the session E5.6
//! opens, so the caller passes them in.

use ace_core::state::ThreadState;
use ace_json::Value;

use crate::EngineError;
use crate::intents::header::IntentHeader;

pub use crate::steering::yields::{SteerYield, YieldState};

/// How a waiting steer reaches the model right now, or none while it must wait.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SteerRoute {
    /// The provider takes it mid-turn.
    Native,
    /// The running turn is cancelled first (ACP), or interrupted so the steer goes next.
    Yield,
}

/// The session facts the route reads (`Pick<ProviderSession, "steerViaCancel" |
/// "backgroundTools">`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SessionSteer {
    pub steer_via_cancel: bool,
    pub background_tools: bool,
}

/// The person's own steer: one they sent, or a waiting message (an agent's too) they chose to
/// steer in. Delegated results and other daemon input never interrupt work.
pub fn is_person_steer(intent: &IntentHeader, person_chose: bool) -> bool {
    person_chose
        || intent
            .trigger
            .as_deref()
            .is_none_or(|trigger| trigger == "user")
}

/// The provider's steer cancels the running turn and starts it again with the input (Cursor).
pub fn steer_restarts_turn(capabilities: &Value) -> bool {
    capabilities.get("steeringMode").and_then(Value::as_str) == Some("interrupt-restart")
}

/// The provider's native steer reaches the model only once the running tool returns.
pub fn steer_waits_for_tools(capabilities: &Value) -> bool {
    capabilities.get("steerTiming").and_then(Value::as_str) == Some("after_tool")
}

/// The root's running turn.
pub fn root_run(state: &ThreadState) -> Option<String> {
    state
        .root_key
        .as_deref()
        .and_then(|root| state.agents.get(root))
        .and_then(|record| record.active_run.clone())
}

/// The yield still winding down: its run has not ended yet.
pub fn yield_in_flight(state: &ThreadState, yielded: Option<&SteerYield>) -> bool {
    yielded.is_some_and(|yielded| {
        yielded.state == YieldState::Pending && root_run(state).as_deref() == Some(&yielded.run)
    })
}

/// `steerRoute`: how a steerable message goes in, or none while it waits.
pub fn steer_route(
    person: bool,
    state: &ThreadState,
    capabilities: &Value,
    yielded: Option<&SteerYield>,
    session: SessionSteer,
) -> Option<SteerRoute> {
    if yield_in_flight(state, yielded) {
        return None;
    }
    let run = root_run(state);
    if !person && steer_restarts_turn(capabilities) && run.is_some() {
        return None;
    }
    if session.steer_via_cancel {
        let run = run?;
        // The cancel for this run is already in flight or was refused: wait for the turn end.
        if yielded.is_some_and(|yielded| yielded.run == run) {
            return None;
        }
        return Some(SteerRoute::Yield);
    }
    if !crate::actor::rules::has_running_foreground_command(state) {
        return Some(SteerRoute::Native);
    }
    if !steer_waits_for_tools(capabilities) {
        return person.then_some(SteerRoute::Native);
    }
    if !person || session.background_tools {
        return Some(SteerRoute::Native);
    }
    let Some(run) = run else {
        return Some(SteerRoute::Native);
    };
    // The provider refused the interrupt: its own steer lands once the command returns.
    if yielded.is_some_and(|yielded| yielded.run == run) {
        return Some(SteerRoute::Native);
    }
    Some(SteerRoute::Yield)
}

/// What the route reads besides the thread and the intent.
#[derive(Clone, Copy)]
pub struct SteerQuery<'a> {
    pub capabilities: &'a Value,
    pub session: SessionSteer,
    /// `repo.quiescent(state)`.
    pub quiescent: bool,
    /// `pending.runningBesides(intent.threadId, intent.id)`.
    pub running_besides: bool,
    pub yielded: Option<&'a SteerYield>,
}

/// `steerLane.isSteer`: the intent goes into the provider right now.
pub fn is_steer(
    core: &crate::Core,
    thread: &str,
    intent: &IntentHeader,
    query: SteerQuery<'_>,
) -> Result<bool, EngineError> {
    Ok(route(core, thread, intent, query)? == Some(SteerRoute::Native))
}

/// `route` (`steer-lane.ts:106`): how a waiting steer reaches the model now, or none.
///
/// The yield record is `State.steering`'s (E5.5 writes it); the caller reads it once and passes
/// it in, and a record for a run the root no longer has is forgotten here.
pub fn route(
    core: &crate::Core,
    thread: &str,
    intent: &IntentHeader,
    query: SteerQuery<'_>,
) -> Result<Option<SteerRoute>, EngineError> {
    if intent.kind != "thread.send" || intent.delivery != "steer" {
        return Ok(None);
    }
    if crate::queue::ready::has_selection(core, intent.id)? {
        return Ok(None);
    }
    if core.with_state(|state| state.transition_guarded(&core.store, thread))?? {
        return Ok(None);
    }
    // The steer itself counts once claimed; delivery re-checks it after the claim.
    if crate::intents::store::transition(core.store.conn(), thread)?.is_some()
        && (query.running_besides || query.quiescent)
    {
        return Ok(None);
    }
    let attached = core.with_state(|state| {
        state
            .actors
            .by_thread
            .get(thread)
            .is_some_and(|actor| actor.session_attached)
    })?;
    let queue = crate::queue::store::get(&core.store, thread)?;
    if !attached
        || queue.paused
        || queue.limited
        || crate::intents::store::recovering(core.store.conn(), thread)?
    {
        return Ok(None);
    }
    let provider = crate::commands::prelude::thread_row(core, thread)?.and_then(|row| {
        row.get("provider")
            .and_then(Value::as_str)
            .map(str::to_owned)
    });
    let Some(provider) = provider else {
        return Ok(None);
    };
    if !core.with_state(|state| state.registry.has(&provider))? {
        return Ok(None);
    }
    if query.capabilities.get("steer").and_then(Value::as_bool) != Some(true) {
        return Ok(None);
    }
    let person_chose = crate::steering::notes::person_chose(core.store.conn(), intent.id)?;
    let person = is_person_steer(intent, person_chose);
    let snapshot = core.with_state(|state| state.repo.require_state(&core.store, thread))??;
    let answer = {
        let borrowed = snapshot.borrow();
        let run = root_run(&borrowed.state);
        // The yield for another run is stale: the lane forgets it.
        core.with_state(|state| state.steering.clear_stale(thread, run.as_deref()))?;
        steer_route(
            person,
            &borrowed.state,
            query.capabilities,
            query.yielded,
            query.session,
        )
    };
    Ok(answer)
}

/// `yielded` (`steer-lane.ts:38`): the waiting steer that cancelled the previous turn, ready to
/// go next once that turn ends.
pub fn yielded(
    core: &crate::Core,
    thread: &str,
    record: Option<&SteerYield>,
) -> Result<Option<IntentHeader>, EngineError> {
    let Some(yielded) = record else {
        return Ok(None);
    };
    if yielded.state != YieldState::Pending || yielded.intent_id.is_none() {
        return Ok(None);
    }
    let snapshot = core.with_state(|state| state.repo.require_state(&core.store, thread))??;
    if root_run(&snapshot.borrow().state).is_some() {
        return Ok(None);
    }
    let steer = crate::intents::store::person_steer(core.store.conn(), thread)?;
    match steer {
        Some(steer)
            if Some(steer.id) == yielded.intent_id
                && !crate::queue::ready::has_selection(core, steer.id)? =>
        {
            Ok(Some(steer))
        }
        _ => Ok(None),
    }
}

#[cfg(test)]
mod tests;
