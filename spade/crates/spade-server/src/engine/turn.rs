//! Runs one turn to its end: model steps, gated tool calls, approvals, steering, Stop and limits.
//! Every decision comes from `next_step` over the stored events.

use std::sync::Arc;
use std::sync::atomic::Ordering;

use futures_util::StreamExt;
use futures_util::stream::FuturesUnordered;
use serde_json::Value;
use spade_core::checkpoint::Checkpoints;
use spade_core::context::{self, SYSTEM};
use spade_core::event::{Call, Known, ReplyEnd, Tokens};
use spade_core::gate::{self, Decision};
use spade_core::tools::{CALL_TOOL, TOOL_SEARCH, describe, unwrap_call_tool};
use spade_core::turn::{
    Next, Pending, Status, next_step, progress, stop_requested, unique_call_ids,
};
use spade_core::{Event, Transcript, spending, title};
use spade_models::{Delta, Role, ToolCall};
use tokio::sync::watch;

use super::{Engine, Frame, Snapshot};
use crate::tools::ToolOutput;

const DECLINED: &str = "The person declined this action.";

/// How a turn ended, other than finishing normally (which `finish_unless_steered` records).
enum Ended {
    Finished,
    Stopped(String),
    Failed(String, String),
}

/// What one model step produced.
enum Step {
    Answered,
    Calls,
    Stopped(String),
    Failed(String, String),
}

pub(super) async fn run(engine: Arc<Engine>, id: String, stop_rx: watch::Receiver<bool>) {
    let live = engine.live(&id);
    // The reply this worker drives, so the hand-off below can tell it from one opened later. It
    // is taken before the first stop check, so a Stop that arrives at once still closes it.
    let mut driven: Option<String> = open_reply(&engine, &id);
    let ended = drive(&engine, &id, stop_rx, &mut driven).await;
    if let Some(reply) = open_reply(&engine, &id).filter(|open| Some(open) == driven.as_ref()) {
        let event = match ended {
            Ended::Finished => None,
            Ended::Stopped(text) => Some(Event::reply_ended(ReplyEnd::Stopped, reply, text)),
            Ended::Failed(text, error) => {
                Some(Event::Known(Known::ReplyFailed { reply, text, error }))
            }
        };
        if let Some(event) = event
            && let Err(error) = engine.record(&id, &event)
        {
            tracing::error!(%error, "could not close a turn");
        }
    }
    *live.stop.lock().unwrap_or_else(|p| p.into_inner()) = None;
    *live.current.lock().unwrap_or_else(|p| p.into_inner()) = None;
    live.turn_running.store(false, Ordering::SeqCst);
    // A message or job result may have opened a new reply after this turn closed but before it
    // let go; that reply's own spawn was skipped, so drive it now.
    if let Some(next) = open_reply(&engine, &id)
        && Some(&next) != driven.as_ref()
    {
        engine.spawn_turn(&id);
    }
    name_if_untitled(&engine, &id).await;
}

fn open_reply(engine: &Engine, id: &str) -> Option<String> {
    let events = engine.load(id).ok()?;
    Transcript::fold(&events).open_reply()?.reply.clone()
}

async fn drive(
    engine: &Arc<Engine>,
    id: &str,
    mut stop: watch::Receiver<bool>,
    driven: &mut Option<String>,
) -> Ended {
    loop {
        if *stop.borrow() {
            return Ended::Stopped(String::new());
        }
        let events = match engine.load(id) {
            Ok(events) => events,
            Err(error) => return Ended::Failed(String::new(), error.to_string()),
        };
        let next = next_step(&events);
        // The stored stop is the truth: it may have landed before this worker had a signal.
        if let Next::CallModel { reply } | Next::Calls { reply, .. } = &next
            && stop_requested(&events, reply)
        {
            *driven = Some(reply.clone());
            return Ended::Stopped(String::new());
        }
        match next {
            Next::Idle => return Ended::Finished,
            Next::CallModel { reply } => {
                *driven = Some(reply.clone());
                let done = progress(&events);
                if done.steps >= engine.limits.max_steps {
                    let limit = engine.limits.max_steps;
                    return Ended::Failed(
                        String::new(),
                        format!("the turn reached its limit of {limit} steps"),
                    );
                }
                if done.cost_micros >= engine.limits.turn_cost_micros {
                    return Ended::Failed(
                        String::new(),
                        "the turn reached its cost limit".to_owned(),
                    );
                }
                if !engine.within_cap().unwrap_or(false) {
                    return Ended::Failed(
                        String::new(),
                        "today's spending cap is used up".to_owned(),
                    );
                }
                let model = turn_model(engine, &events, &reply);
                if super::compact::if_needed(engine, id, &model, &events).await {
                    continue;
                }
                match model_step(engine, id, &reply, &events, &mut stop).await {
                    Step::Answered => match finish_unless_steered(engine, id, &reply) {
                        Ok(true) => return Ended::Finished,
                        Ok(false) => {}
                        Err(error) => return Ended::Failed(String::new(), error),
                    },
                    Step::Calls => {}
                    Step::Stopped(text) => return Ended::Stopped(text),
                    Step::Failed(text, error) => return Ended::Failed(text, error),
                }
            }
            Next::Calls { reply, calls } => {
                *driven = Some(reply.clone());
                match handle_calls(engine, id, &reply, &events, calls, &mut stop).await {
                    Handled::Continue => {}
                    Handled::Stopped => return Ended::Stopped(String::new()),
                    Handled::Failed(error) => return Ended::Failed(String::new(), error),
                }
            }
        }
    }
}

/// The model the turn started with, so a conversation keeps one model and its cache.
fn turn_model(engine: &Engine, events: &[Event], reply: &str) -> String {
    events
        .iter()
        .find_map(|event| match event {
            Event::Known(Known::ReplyStarted { reply: r, model }) if r == reply => {
                Some(model.clone())
            }
            _ => None,
        })
        .unwrap_or_else(|| engine.models.for_role(Role::Main).to_owned())
}

async fn model_step(
    engine: &Arc<Engine>,
    id: &str,
    reply: &str,
    events: &[Event],
    stop: &mut watch::Receiver<bool>,
) -> Step {
    let model = turn_model(engine, events, reply);
    let prompt = context::prompt(SYSTEM, engine.tools.registry().offered(), events);
    let live = engine.live(id);
    let stream = match engine.models.stream(&model, &prompt).await {
        Ok(stream) => stream,
        Err(error) => return Step::Failed(String::new(), error.to_string()),
    };
    let mut stream = Box::pin(stream);
    let mut text = String::new();
    let mut calls: Vec<ToolCall> = Vec::new();
    let mut checkpoints = Checkpoints::new(engine.now_ms());
    loop {
        tokio::select! {
            changed = stop.changed() => {
                if changed.is_err() || *stop.borrow() {
                    return Step::Stopped(text);
                }
            }
            next = stream.next() => match next {
                Some(Ok(Delta::Text(piece))) => {
                    text.push_str(&piece);
                    *live.current.lock().unwrap_or_else(|p| p.into_inner()) =
                        Some(Snapshot { reply: reply.to_owned(), text: text.clone() });
                    let _ = live.frames.send(Frame::Delta { reply: reply.to_owned(), text: piece });
                    if checkpoints.due(engine.now_ms()) {
                        let _ = engine.record(id, &Event::reply_progress(reply, text.clone()));
                    }
                }
                Some(Ok(Delta::Reasoning(_))) => {}
                Some(Ok(Delta::Call(call))) => calls.push(call),
                Some(Ok(Delta::Done { usage, thoughts })) => {
                    let cost = spending::cost_micros(engine.models.price(&model), &usage);
                    let calls = unique_call_ids(
                        events,
                        calls.into_iter().map(|c| Call { id: c.id, name: c.name, arguments: c.arguments }).collect(),
                        || engine.ids.next("call"),
                    );
                    let made_calls = !calls.is_empty();
                    let step = Event::Known(Known::StepFinished {
                        reply: reply.to_owned(),
                        text,
                        calls,
                        thoughts,
                        usage: Tokens {
                            input: usage.input_tokens,
                            output: usage.output_tokens,
                            cache_read: usage.cache_read_tokens,
                            cache_write: usage.cache_write_tokens,
                        },
                        cost_micros: cost,
                        seen: Some(events.len()),
                    });
                    if let Err(error) = engine.record(id, &step) {
                        return Step::Failed(String::new(), error.to_string());
                    }
                    if cost > 0 {
                        let _ = engine.store.record_spend(id, &model, cost, engine.now_ms());
                    }
                    *live.current.lock().unwrap_or_else(|p| p.into_inner()) = None;
                    return if made_calls { Step::Calls } else { Step::Answered };
                }
                Some(Err(error)) => return Step::Failed(text, error.to_string()),
                None => return Step::Failed(text, "the model's reply ended early".to_owned()),
            }
        }
    }
}

/// Closes the turn with its last step's text, unless the person sent a message after that step:
/// then the turn carries on so it is answered. Atomic against `Engine::send`.
fn finish_unless_steered(engine: &Engine, id: &str, reply: &str) -> Result<bool, String> {
    let _order = engine.record_lock.lock().unwrap_or_else(|p| p.into_inner());
    let events = engine.load(id).map_err(|e| e.to_string())?;
    let last_step = events
        .iter()
        .rposition(|e| matches!(e, Event::Known(Known::StepFinished { .. })))
        .unwrap_or(0);
    // Anything that arrived after the step's prompt was built is unanswered.
    let seen = match events.get(last_step) {
        Some(Event::Known(Known::StepFinished {
            seen: Some(seen), ..
        })) => (*seen).min(last_step),
        _ => last_step,
    };
    let steered = events[seen..].iter().any(|e| {
        matches!(
            e,
            Event::Known(Known::UserMessage { .. } | Known::JobFinished { .. })
        )
    });
    if steered {
        return Ok(false);
    }
    let text = match events.get(last_step) {
        Some(Event::Known(Known::StepFinished { text, .. })) => text.clone(),
        _ => String::new(),
    };
    let total = progress(&events);
    let finished = Event::Known(Known::ReplyFinished {
        reply: reply.to_owned(),
        text,
        input_tokens: None,
        output_tokens: None,
        cost_micros: total.cost_micros,
    });
    engine.append(id, &finished).map_err(|e| e.to_string())?;
    Ok(true)
}

/// How handling a step's calls ended.
enum Handled {
    Continue,
    Stopped,
    Failed(String),
}

/// Gates, runs or declines the last step's open calls.
async fn handle_calls(
    engine: &Arc<Engine>,
    id: &str,
    reply: &str,
    events: &[Event],
    calls: Vec<Pending>,
    stop: &mut watch::Receiver<bool>,
) -> Handled {
    let registry = engine.tools.registry();
    let transcript = Transcript::fold(events);
    let untrusted = context::untrusted_turn(events, registry);
    let mut runnable: Vec<(Call, String, Value)> = Vec::new();
    let mut waiting = false;
    for pending in calls {
        let (name, arguments) = resolve(&pending.call);
        match pending.status {
            Status::New if name == TOOL_SEARCH => runnable.push((pending.call, name, arguments)),
            Status::New => match registry.get(&name) {
                None => finish_tool(
                    engine,
                    id,
                    reply,
                    &pending.call,
                    &name,
                    ToolOutput::error(format!(
                        "There is no tool named {name}. Use tool_search to find tools."
                    )),
                ),
                Some(def) => {
                    let always = transcript.always_allowed.iter().any(|t| t == &name);
                    match gate::decide(def.risk, always, untrusted) {
                        Decision::Run => runnable.push((pending.call, name, arguments)),
                        Decision::Ask => {
                            waiting = true;
                            let asked = Event::Known(Known::ApprovalRequested {
                                reply: reply.to_owned(),
                                call_id: pending.call.id.clone(),
                                name,
                                arguments,
                            });
                            // Never asked once the reply is stopped, so no answer can allow it.
                            match engine.record_unless_stopped(id, reply, &asked) {
                                Ok(true) => {}
                                Ok(false) => return Handled::Stopped,
                                Err(error) => return Handled::Failed(error.to_string()),
                            }
                        }
                    }
                }
            },
            Status::Allowed => runnable.push((pending.call, name, arguments)),
            Status::Declined => finish_tool(
                engine,
                id,
                reply,
                &pending.call,
                &name,
                ToolOutput::error(DECLINED),
            ),
            Status::Awaiting => waiting = true,
            Status::Running => {}
        }
    }
    if !runnable.is_empty() {
        return run_tools(engine, id, reply, runnable, stop).await;
    }
    if waiting {
        let live = engine.live(id);
        tokio::select! {
            _ = live.wake.notified() => {}
            changed = stop.changed() => {
                if changed.is_err() || *stop.borrow() {
                    return Handled::Stopped;
                }
            }
        }
    }
    Handled::Continue
}

/// A call's real tool and arguments: `call_tool` names its tool inside.
fn resolve(call: &Call) -> (String, Value) {
    if call.name == CALL_TOOL
        && let Some((name, arguments)) = unwrap_call_tool(&call.arguments)
    {
        return (name, arguments);
    }
    (call.name.clone(), call.arguments.clone())
}

async fn run_tools(
    engine: &Arc<Engine>,
    id: &str,
    reply: &str,
    calls: Vec<(Call, String, Value)>,
    stop: &mut watch::Receiver<bool>,
) -> Handled {
    let limit = engine.limits.max_parallel_tools.max(1);
    let mut queue = calls.into_iter();
    let mut running = FuturesUnordered::new();
    loop {
        while running.len() < limit {
            if *stop.borrow() {
                return Handled::Stopped;
            }
            let Some((call, name, arguments)) = queue.next() else {
                break;
            };
            // A tool runs only once its start is stored, so a restart can never mistake a call
            // that ran for one that did not.
            let started = Event::Known(Known::ToolStarted {
                reply: reply.to_owned(),
                call_id: call.id.clone(),
                name: name.clone(),
            });
            if let Err(error) = engine.record(id, &started) {
                return Handled::Failed(error.to_string());
            }
            if engine
                .tools
                .registry()
                .get(&name)
                .is_some_and(|def| def.background)
            {
                match super::jobs::start(engine, id, reply, &call.id, &name, arguments, stop) {
                    Ok(super::jobs::Started::Running) => {}
                    Ok(super::jobs::Started::Stopped) => {
                        // Known not to have run: Stop came before the job started.
                        let not_run = ToolOutput::error(context::NOT_RUN);
                        finish_tool(engine, id, reply, &call, &name, not_run);
                        return Handled::Stopped;
                    }
                    Err(error) => return Handled::Failed(error.to_string()),
                }
                let started = ToolOutput::ok(context::job_started(&call.id));
                finish_tool(engine, id, reply, &call, &name, started);
                continue;
            }
            let engine = engine.clone();
            running.push(async move {
                let output = run_one(&engine, &call.id, &name, arguments).await;
                (call, name, output)
            });
        }
        if running.is_empty() {
            return Handled::Continue;
        }
        tokio::select! {
            changed = stop.changed() => {
                if changed.is_err() || *stop.borrow() {
                    return Handled::Stopped;
                }
            }
            Some((call, name, output)) = running.next() => {
                finish_tool(engine, id, reply, &call, &name, output);
            }
        }
    }
}

async fn run_one(engine: &Arc<Engine>, call_id: &str, name: &str, arguments: Value) -> ToolOutput {
    if name == TOOL_SEARCH {
        let query = arguments.get("query").and_then(Value::as_str).unwrap_or("");
        let found = engine.tools.registry().search(query, 5);
        return ToolOutput::ok(describe(&found));
    }
    let Some(tool) = engine.tools.get(name) else {
        return ToolOutput::error(format!("There is no tool named {name}."));
    };
    match tokio::time::timeout(engine.limits.tool_timeout, tool.run(call_id, arguments)).await {
        Ok(output) => output,
        Err(_) => ToolOutput::error(format!(
            "{name} did not finish within {} seconds.",
            engine.limits.tool_timeout.as_secs()
        )),
    }
}

fn finish_tool(
    engine: &Engine,
    id: &str,
    reply: &str,
    call: &Call,
    name: &str,
    output: ToolOutput,
) {
    let content = trim(&output.content, engine.limits.result_chars);
    let event = Event::Known(Known::ToolFinished {
        reply: reply.to_owned(),
        call_id: call.id.clone(),
        name: name.to_owned(),
        content,
        is_error: output.is_error,
    });
    if let Err(error) = engine.record(id, &event) {
        tracing::error!(%error, "could not store a tool result");
    }
}

pub(super) fn trim(text: &str, longest: usize) -> String {
    let count = text.chars().count();
    if count <= longest {
        return text.to_owned();
    }
    let kept: String = text.chars().take(longest).collect();
    format!("{kept}\n[… {} more characters]", count - longest)
}

/// Names the conversation after its first reply, with the fast model, else its first message.
async fn name_if_untitled(engine: &Arc<Engine>, id: &str) {
    let Ok(events) = engine.load(id) else { return };
    let transcript = Transcript::fold(&events);
    if transcript.title.is_some() || transcript.open_reply().is_some() {
        return;
    }
    let Some(first) = transcript.first_message().map(str::to_owned) else {
        return;
    };
    let fast = engine.models.for_role(Role::Fast).to_owned();
    let suggested = match engine
        .models
        .generate::<title::Suggestion>(&fast, &title::prompt(&first))
        .await
    {
        Ok(generated) => {
            engine.pay(id, &fast, &generated.usage);
            title::clean(&generated.value.title)
        }
        Err(error) => {
            if let Some(usage) = error.usage() {
                engine.pay(id, &fast, &usage);
            }
            None
        }
    };
    let name = suggested.unwrap_or_else(|| title::fallback(&first));
    if let Err(error) = engine.record(id, &Event::renamed(name)) {
        tracing::error!(%error, "could not store a title");
    }
}
