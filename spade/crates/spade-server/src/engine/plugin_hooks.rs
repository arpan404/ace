//! Where the person's plugins meet a turn (ADR 0151): rules and `SessionStart` at a
//! conversation's first turn, `UserPromptSubmit` and `PostToolUse` before each model step,
//! `PreToolUse` before the gate, `Stop` as a reply is about to finish, `PreCompact` before
//! compacting. Each answer is stored as an event before the turn moves on, so a rebuilt prompt
//! is the same and a restart never runs a hook again for what it already answered.
//!
//! Bots on a subscription (ADR 0133) get only rules: their CLI runs its own hooks.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use spade_core::event::{Event, Known};
use spade_core::hooks::{self, HookOutcome};
use spade_core::turn::{Pending, Status};

use super::Engine;
use crate::plugins::Plugins;

/// How long the first turn waits for ace's plugins before going without them.
const WAIT: Duration = Duration::from_secs(5);

impl Engine {
    /// The person's plugins, once the server has set them.
    pub fn set_plugins(&self, plugins: Arc<Plugins>) {
        let _ = self.plugins.set(plugins);
    }

    pub fn plugins(&self) -> Option<&Arc<Plugins>> {
        self.plugins.get()
    }
}

/// The plugins and the conversation's bot, when it has any plugin.
fn plugins_of(engine: &Engine, id: &str) -> Option<(Arc<Plugins>, String)> {
    let plugins = engine.plugins()?.clone();
    let agent = engine.store.agent_for_conversation(id).ok().flatten()?;
    Some((plugins, agent.id))
}

fn store(engine: &Engine, id: &str, event: Event) -> bool {
    match engine.record(id, &event) {
        Ok(_) => true,
        Err(error) => {
            tracing::error!(%error, "could not store what a plugin's hook answered");
            false
        }
    }
}

fn ran_event(hook: &str, target: &str, outcomes: Vec<HookOutcome>) -> Event {
    Event::Known(Known::HookRan {
        hook: hook.to_owned(),
        target: target.to_owned(),
        outcomes,
    })
}

/// Stores the bot's plugin rules and `SessionStart` text if this conversation has not called a
/// model yet. Returns whether it stored anything.
pub(super) async fn start_if_needed(
    engine: &Arc<Engine>,
    id: &str,
    events: &[Event],
    cli: bool,
) -> bool {
    let begun = events.iter().any(|event| {
        matches!(
            event,
            Event::Known(Known::StepFinished { .. } | Known::PluginsStarted { .. })
        )
    });
    if begun {
        return false;
    }
    let Some((plugins, agent)) = plugins_of(engine, id) else {
        return false;
    };
    if tokio::time::timeout(WAIT, plugins.refresh()).await.is_err() {
        tracing::warn!("ace's plugins did not answer in time; this conversation goes without");
    }
    if plugins.for_agent(&agent).is_empty() {
        return false;
    }
    let rules = plugins.rules(&agent, cli);
    let outcomes = if cli {
        Vec::new()
    } else {
        let input = json!({ "session_id": id, "source": "startup" });
        plugins
            .run_hooks(&agent, hooks::SESSION_START, None, input)
            .await
    };
    let added = hooks::session_text(&outcomes);
    let stored = store(
        engine,
        id,
        Event::Known(Known::PluginsStarted { rules, added }),
    );
    // For the activity log; it adds nothing to the prompt.
    if stored && !outcomes.is_empty() {
        store(
            engine,
            id,
            ran_event(hooks::SESSION_START, "start", outcomes),
        );
    }
    stored
}

/// Runs `UserPromptSubmit` for the person's messages and `PostToolUse` for tool results that
/// have not had theirs. Returns whether it stored anything.
pub(super) async fn before_step(engine: &Arc<Engine>, id: &str, events: &[Event]) -> bool {
    let Some((plugins, agent)) = plugins_of(engine, id) else {
        return false;
    };
    let mut stored = false;
    if plugins.has_hooks(&agent, hooks::USER_PROMPT_SUBMIT).await {
        for target in hooks::messages_due(events) {
            let text = target
                .parse::<usize>()
                .ok()
                .and_then(|at| match events.get(at) {
                    Some(Event::Known(Known::UserMessage { text, .. })) => Some(text.clone()),
                    _ => None,
                })
                .unwrap_or_default();
            let input = json!({ "session_id": id, "prompt": text });
            let outcomes = plugins
                .run_hooks(&agent, hooks::USER_PROMPT_SUBMIT, None, input)
                .await;
            stored |= store(
                engine,
                id,
                ran_event(hooks::USER_PROMPT_SUBMIT, &target, outcomes),
            );
        }
    }
    if plugins.has_hooks(&agent, hooks::POST_TOOL_USE).await {
        for (call_id, tool) in hooks::results_due(events) {
            let input = json!({
                "session_id": id,
                "tool_name": tool,
                "tool_input": arguments_of(events, &call_id),
                "tool_response": result_of(events, &call_id),
            });
            let outcomes = plugins
                .run_hooks(&agent, hooks::POST_TOOL_USE, Some(&tool), input)
                .await;
            stored |= store(
                engine,
                id,
                ran_event(hooks::POST_TOOL_USE, &call_id, outcomes),
            );
        }
    }
    stored
}

/// Before the gate sees a step's calls: starts the bot's local servers when it searches for or
/// calls a deferred tool, and runs `PreToolUse` for each new call. A refused call is answered
/// with the refusal, so the gate never sees it; a refusal stored before a restart still stands,
/// whatever the bot's hooks are now. Returns whether it stored anything.
pub(super) async fn before_calls(
    engine: &Arc<Engine>,
    id: &str,
    reply: &str,
    events: &[Event],
    calls: &[Pending],
) -> bool {
    let fresh: Vec<&Pending> = calls.iter().filter(|p| p.status == Status::New).collect();
    // Answered before a restart: the refusal is stored with the hook's answer from now on, but
    // a store that failed half way (or an older Spade) can leave the answer alone.
    let owed: Vec<Event> = fresh
        .iter()
        .filter_map(|pending| {
            let outcomes = hooks::answered(events, hooks::PRE_TOOL_USE, &pending.call.id)?;
            hooks::refusal(outcomes).map(|content| refused(reply, &pending.call, content))
        })
        .collect();
    if !owed.is_empty() {
        return store_all(engine, id, &owed);
    }
    let Some((plugins, agent)) = plugins_of(engine, id) else {
        return false;
    };
    let searching = fresh.iter().any(|pending| {
        [spade_core::tools::TOOL_SEARCH, spade_core::tools::CALL_TOOL]
            .contains(&pending.call.name.as_str())
    });
    if searching && plugins.has_servers(&agent) {
        plugins.start_servers(&agent).await;
    }
    if !plugins.has_hooks(&agent, hooks::PRE_TOOL_USE).await {
        return false;
    }
    let mut stored = false;
    for pending in fresh {
        let call = &pending.call;
        if hooks::ran(events, hooks::PRE_TOOL_USE, &call.id) {
            continue;
        }
        let tool = hooks::tool_of(&call.name, &call.arguments);
        let input = json!({
            "session_id": id,
            "tool_name": tool,
            "tool_input": inner_arguments(&call.name, &call.arguments),
        });
        let outcomes = plugins
            .run_hooks(&agent, hooks::PRE_TOOL_USE, Some(&tool), input)
            .await;
        let refusal = hooks::refusal(&outcomes);
        let mut answer = vec![ran_event(hooks::PRE_TOOL_USE, &call.id, outcomes)];
        // The answer and the refused call's result in one write: a crash keeps both or neither.
        answer.extend(refusal.map(|content| refused(reply, call, content)));
        stored |= store_all(engine, id, &answer);
    }
    stored
}

/// A refused call's result: the refusal, as an error.
fn refused(reply: &str, call: &spade_core::event::Call, content: String) -> Event {
    Event::Known(Known::ToolFinished {
        reply: reply.to_owned(),
        call_id: call.id.clone(),
        name: call.name.clone(),
        content,
        is_error: true,
        uncertain: false,
        images: Vec::new(),
        untrusted: false,
    })
}

/// Stores `events` together, in order.
fn store_all(engine: &Engine, id: &str, events: &[Event]) -> bool {
    let _order = engine
        .record_lock
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    match engine.append_events(id, events) {
        Ok(_) => true,
        Err(error) => {
            tracing::error!(%error, "could not store what a plugin's hook answered");
            false
        }
    }
}

/// As a reply is about to finish: runs `Stop`, at most [`hooks::MOST_STOP_EXTENSIONS`] times a
/// reply. Returns whether a hook asked for one more step (its reason is stored for the model).
pub(super) async fn at_stop(engine: &Arc<Engine>, id: &str) -> bool {
    let Some((plugins, agent)) = plugins_of(engine, id) else {
        return false;
    };
    if !plugins.has_hooks(&agent, hooks::STOP).await {
        return false;
    }
    let Ok(events) = engine.load(id) else {
        return false;
    };
    let Some(target) = hooks::last_step(&events) else {
        return false;
    };
    let extended = hooks::stop_extensions(&events);
    if hooks::ran(&events, hooks::STOP, &target) || extended >= hooks::MOST_STOP_EXTENSIONS {
        return false;
    }
    let input = json!({ "session_id": id, "stop_hook_active": extended > 0 });
    let outcomes = plugins.run_hooks(&agent, hooks::STOP, None, input).await;
    let more = hooks::extends(&outcomes);
    store(engine, id, ran_event(hooks::STOP, &target, outcomes)) && more
}

/// Before compacting at `keep_from`: runs `PreCompact` once, for its own effects.
pub(super) async fn before_compact(
    engine: &Arc<Engine>,
    id: &str,
    events: &[Event],
    keep_from: usize,
) {
    let Some((plugins, agent)) = plugins_of(engine, id) else {
        return;
    };
    let target = keep_from.to_string();
    if !plugins.has_hooks(&agent, hooks::PRE_COMPACT).await
        || hooks::ran(events, hooks::PRE_COMPACT, &target)
    {
        return;
    }
    let input = json!({ "session_id": id, "trigger": "auto" });
    let outcomes = plugins
        .run_hooks(&agent, hooks::PRE_COMPACT, None, input)
        .await;
    store(engine, id, ran_event(hooks::PRE_COMPACT, &target, outcomes));
}

/// The arguments of the call with `call_id`, the inner tool's for a `call_tool`.
fn arguments_of(events: &[Event], call_id: &str) -> Value {
    events
        .iter()
        .rev()
        .find_map(|event| match event {
            Event::Known(Known::StepFinished { calls, .. }) => calls
                .iter()
                .find(|call| call.id == call_id)
                .map(|call| inner_arguments(&call.name, &call.arguments)),
            _ => None,
        })
        .unwrap_or(Value::Null)
}

fn inner_arguments(name: &str, arguments: &Value) -> Value {
    if name == spade_core::tools::CALL_TOOL {
        spade_core::tools::unwrap_call_tool(arguments).map_or(Value::Null, |(_, inner)| inner)
    } else {
        arguments.clone()
    }
}

fn result_of(events: &[Event], call_id: &str) -> Value {
    events
        .iter()
        .rev()
        .find_map(|event| match event {
            Event::Known(Known::ToolFinished {
                call_id: c,
                content,
                is_error,
                ..
            }) if c == call_id => Some(json!({ "content": content, "is_error": is_error })),
            _ => None,
        })
        .unwrap_or(Value::Null)
}
