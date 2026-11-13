//! Access levels and the auto-review (ADR 0144, spade/docs/autonomy.md): changing a bot's level,
//! and the reviewer that approves, refuses or escalates a call on the person's behalf. What each
//! level does is `spade_core::autonomy`; this is the I/O around it.

use std::sync::Arc;

use serde_json::Value;
use spade_core::Event;
use spade_core::autonomy::{self, Access, Case, Judgment, Outcome};
use spade_core::context;
use spade_core::event::{Call, Known, Verdict};
use spade_core::review;
use spade_core::task::{self, State as TaskState};
use spade_core::tools::{Registry, ToolDef};
use spade_store::StoredEvent;
use tokio::sync::watch;

use super::{AgentError, AgentView, Engine};

/// What the status line says while the reviewer reads a call.
const REVIEWING: &str = "Checking a step";

/// The level folded from stored events; `unset` when none is stored.
pub(super) fn access_of(stored: &[StoredEvent], unset: Access) -> Access {
    stored
        .iter()
        .rev()
        .find_map(|e| match &e.event {
            Event::Known(Known::AccessChanged { level }) => Some(*level),
            _ => None,
        })
        .unwrap_or(unset)
}

/// The task state folded from stored events: the latest valid `task_status`, the same history the
/// continuation reads, so a later call with arguments that don't parse never hides it.
pub(super) fn task_of(stored: &[StoredEvent]) -> Option<TaskState> {
    let events: Vec<Event> = stored
        .iter()
        .filter(|e| task_call(&e.event))
        .map(|e| e.event.clone())
        .collect();
    task::state(&events)
}

fn task_call(event: &Event) -> bool {
    match event {
        Event::Known(Known::StepFinished { calls, .. }) => calls.iter().any(|c| {
            c.name == task::TASK_STATUS
                || c.arguments.get("name").and_then(Value::as_str) == Some(task::TASK_STATUS)
        }),
        _ => false,
    }
}

/// Whether the latest reply was one Spade started for the bot's task.
pub(super) fn continued(stored: &[StoredEvent]) -> bool {
    let Some(start) = stored
        .iter()
        .rposition(|e| matches!(e.event, Event::Known(Known::ReplyStarted { .. })))
    else {
        return false;
    };
    start > 0
        && matches!(
            stored[start - 1].event,
            Event::Known(Known::TaskContinued { .. })
        )
}

/// The setting that says every conversation from before access levels had `ask` stored.
const LEVELS_PINNED: &str = "access_levels_pinned";

impl Engine {
    /// Sets an agent's access level. Stored as an event in its conversation, so a restart
    /// rebuilds the same level and the activity log shows the change; it holds from the bot's
    /// next tool call, never one already being decided.
    pub fn set_access(&self, agent: &str, level: Access) -> Result<AgentView, AgentError> {
        let found = self.store.agent(agent)?.ok_or(AgentError::NotFound)?;
        {
            let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
            let events = self.load(&found.conversation)?;
            if self.access(&events) != level || !autonomy::has_level(&events) {
                self.append(
                    &found.conversation,
                    &Event::Known(Known::AccessChanged { level }),
                )?;
            }
            self.levels
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .insert(found.conversation.clone(), level);
        }
        self.agent_view(agent)?.ok_or(AgentError::NotFound)
    }

    /// The level of the conversation whose events these are.
    pub(super) fn access(&self, events: &[Event]) -> Access {
        autonomy::access(events, self.limits.new_bot_access)
    }

    /// The conversation's level now, read for each call: kept in memory once folded and changed
    /// as the person changes it, so a change made while a step's calls are decided holds from
    /// the next one.
    pub(super) fn level(&self, id: &str, events: &[Event]) -> Access {
        let mut levels = self.levels.lock().unwrap_or_else(|p| p.into_inner());
        *levels
            .entry(id.to_owned())
            .or_insert_with(|| self.access(events))
    }

    /// Once, the first time a build with access levels opens a database: every conversation it
    /// already has is pinned to `ask`, so no existing bot changes behaviour. Bots made from then
    /// on have nothing stored and are on the new-bot level.
    pub(super) fn pin_levels(&self) -> Result<(), spade_store::StoreError> {
        if self.store.setting(LEVELS_PINNED)?.is_some() {
            return Ok(());
        }
        for conversation in self.store.conversations()? {
            let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
            let events = self.load(&conversation.id)?;
            if !autonomy::has_level(&events) {
                self.append(
                    &conversation.id,
                    &Event::Known(Known::AccessChanged { level: Access::Ask }),
                )?;
            }
        }
        self.store.set_setting(LEVELS_PINNED, Some("1"))
    }
}

/// What the auto-review came to.
pub(super) enum Reviewed {
    Run,
    Refuse(String),
    Escalate(String),
    Stopped,
}

/// Stores a verdict the rules reached without a model (a call that always asks, or one that
/// reaches credentials), so the activity log shows it and a restart reaches it again.
pub(super) fn record_rule(
    engine: &Engine,
    id: &str,
    reply: &str,
    call: &Call,
    name: &str,
    verdict: Verdict,
    reason: &str,
) -> Result<bool, spade_store::StoreError> {
    let event = Event::Known(Known::CallReviewed {
        reply: reply.to_owned(),
        call_id: call.id.clone(),
        name: name.to_owned(),
        verdict,
        reason: reason.to_owned(),
        model: String::new(),
        cost_micros: 0,
    });
    engine.record_unless_stopped(id, reply, &event)
}

/// What one call under review is.
pub(super) struct Under<'a> {
    pub call: &'a Call,
    pub name: &'a str,
    pub arguments: &'a Value,
    pub def: &'a ToolDef,
    pub shell: bool,
}

/// Has the reviewer judge one call, storing its verdict first. A verdict already stored for the
/// call is used again, so a restart never reviews (or pays for) a call twice. Anything but a clear
/// answer (a failure, a timeout, an answer that doesn't parse, the bot at its cap) escalates.
pub(super) async fn review(
    engine: &Arc<Engine>,
    id: &str,
    reply: &str,
    events: &[Event],
    registry: &Registry,
    under: Under<'_>,
    stop: &mut watch::Receiver<bool>,
) -> Reviewed {
    if let Some((verdict, reason)) = review::stored(events, &under.call.id) {
        return of(verdict, reason);
    }
    let model = engine.review_model(id);
    engine.set_status(id, Some(REVIEWING.to_owned()));
    let agent = engine.store.agent_for_conversation(id).ok().flatten();
    let (bot, task, agent_id) = agent.as_ref().map_or(("the bot", "", ""), |a| {
        (a.name.as_str(), a.task.as_str(), a.id.as_str())
    });
    let folder =
        format!("its own workspace folder (workspace/{agent_id}), where shell commands run");
    // Everything untrusted the prompt still shows, from any turn since compaction: the same view
    // the memory gate answers to, so a page read before the person's latest message still counts.
    let untrusted = context::untrusted_in_view(events, registry);
    let case = Case {
        bot,
        task,
        person: review::person_words(events),
        untrusted: untrusted.clone(),
        folder: &folder,
        tool: under.name,
        description: &under.def.spec.description,
        arguments: under.arguments,
    };
    let prompt = autonomy::prompt(&case).session(id);
    let admission = tokio::select! {
        admission = engine.admit_waiting(id, &model, &prompt, super::ledger::Hint::default()) => admission,
        _ = stop.wait_for(|stopped| *stopped) => return Reviewed::Stopped,
    };
    let (outcome, cost) = match admission {
        Err(refused) => (
            Outcome::Escalate(format!(
                "The review couldn't run: the bot reached {}.",
                refused.reached()
            )),
            0,
        ),
        Ok(admitted) => {
            let asked = tokio::select! {
                answer = tokio::time::timeout(
                    engine.limits.review_timeout,
                    engine.models.generate::<Judgment>(&model, &prompt),
                ) => Some(answer),
                _ = stop.wait_for(|stopped| *stopped) => None,
            };
            // A call cut off before its usage came is still paid for: at least its prompt.
            let estimate = || {
                super::ledger::likely_usage(
                    super::ledger::prompt_tokens(&prompt),
                    Default::default(),
                    0,
                )
            };
            let Some(asked) = asked else {
                admitted.settle(&estimate());
                return Reviewed::Stopped;
            };
            match asked {
                Ok(Ok(generated)) => {
                    let cost = admitted.settle(&generated.usage);
                    let tainted = !untrusted.is_empty();
                    (
                        autonomy::judged(&generated.value, under.shell, tainted),
                        cost,
                    )
                }
                Ok(Err(error)) => {
                    let cost = match error.usage() {
                        Some(usage) => admitted.settle(&usage),
                        None if error.may_have_billed() => admitted.settle(&estimate()),
                        None => admitted.settle_if(None),
                    };
                    (
                        Outcome::Escalate(format!("The review couldn't run: {error}")),
                        cost,
                    )
                }
                Err(_) => (
                    Outcome::Escalate("The review took too long, so you decide.".to_owned()),
                    admitted.settle(&estimate()),
                ),
            }
        }
    };
    let (verdict, reason) = match &outcome {
        Outcome::Run => (Verdict::Allow, String::new()),
        Outcome::Refuse(reason) => (Verdict::Refuse, reason.clone()),
        Outcome::Escalate(reason) => (Verdict::Escalate, reason.clone()),
    };
    let reviewed = Event::Known(Known::CallReviewed {
        reply: reply.to_owned(),
        call_id: under.call.id.clone(),
        name: under.name.to_owned(),
        verdict,
        reason: reason.clone(),
        model,
        cost_micros: cost,
    });
    match engine.record_unless_stopped(id, reply, &reviewed) {
        Ok(true) => of(verdict, reason),
        Ok(false) => Reviewed::Stopped,
        // Not stored: the person decides rather than the call running unrecorded.
        Err(_) => Reviewed::Escalate("Spade couldn't store the review, so you decide.".to_owned()),
    }
}

fn of(verdict: Verdict, reason: String) -> Reviewed {
    match verdict {
        Verdict::Allow => Reviewed::Run,
        Verdict::Refuse => Reviewed::Refuse(reason),
        Verdict::Escalate => Reviewed::Escalate(reason),
    }
}
