//! A step's tool calls: the gate, approvals, running allowed calls in parallel (or as background
//! jobs), and storing each result.

use std::collections::VecDeque;
use std::sync::Arc;

use futures_util::StreamExt;
use futures_util::stream::FuturesUnordered;
use serde_json::Value;
use spade_core::context;
use spade_core::event::{Call, Known};
use spade_core::gate::{self, Decision};
use spade_core::maintenance::{Pause, Point, halts};
use spade_core::tools::{CALL_TOOL, Risk, TOOL_SEARCH, describe, unwrap_call_tool};
use spade_core::turn::{Pending, Status};
use spade_core::{Event, Transcript};
use tokio::sync::watch;

use super::Engine;
use crate::tools::ToolOutput;

const DECLINED: &str = "The person declined this action.";

/// How handling a step's calls ended.
pub(super) enum Handled {
    Continue,
    Stopped,
    /// Spade is closing; tools still running were cut (the caller records each as maybe run).
    Paused,
    Failed(String),
}

/// Gates, runs or declines the last step's open calls.
pub(super) async fn handle_calls(
    engine: &Arc<Engine>,
    id: &str,
    reply: &str,
    events: &[Event],
    calls: Vec<Pending>,
    stop: &mut watch::Receiver<bool>,
    pause: &mut watch::Receiver<Pause>,
) -> Handled {
    let registry = engine.tools.registry_for(id);
    let transcript = Transcript::fold(events);
    let untrusted = context::untrusted_turn(events, &registry);
    let mut runnable: Vec<(Call, String, Value)> = Vec::new();
    let mut waiting = false;
    // Started with no stored result. This worker runs every call it starts to its stored end, so
    // such a call ran in an earlier worker that was cut off: its outcome is unknown.
    let mut orphaned: Vec<(Call, String)> = Vec::new();
    for pending in calls {
        let (name, arguments) = resolve(&pending.call);
        match pending.status {
            Status::New if name == TOOL_SEARCH => runnable.push((pending.call, name, arguments)),
            Status::New => match registry.get(&name) {
                None => {
                    let missing = ToolOutput::error(format!(
                        "There is no tool named {name}. Use tool_search to find tools."
                    ));
                    finish_tool(engine, id, reply, &pending.call, &name, missing).await;
                }
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
            Status::Declined => {
                let declined = ToolOutput::error(DECLINED);
                finish_tool(engine, id, reply, &pending.call, &name, declined).await;
            }
            Status::Awaiting => waiting = true,
            Status::Running => orphaned.push((pending.call, name)),
        }
    }
    for (call, name) in orphaned {
        let unknown = ToolOutput::maybe_ran(context::MAYBE_RAN);
        finish_tool(engine, id, reply, &call, &name, unknown).await;
    }
    if !runnable.is_empty() {
        return run_tools(engine, id, reply, runnable, stop, pause).await;
    }
    if waiting {
        let live = engine.live(id);
        live.waiting_on_you
            .store(true, std::sync::atomic::Ordering::SeqCst);
        engine.announce(id);
        let handled = tokio::select! {
            _ = live.wake.notified() => Handled::Continue,
            changed = stop.changed() => {
                if changed.is_err() || *stop.borrow() {
                    Handled::Stopped
                } else {
                    Handled::Continue
                }
            }
            _ = super::turn::pausing(pause, Point::WaitingOnYou) => Handled::Paused,
        };
        live.waiting_on_you
            .store(false, std::sync::atomic::Ordering::SeqCst);
        engine.announce(id);
        return handled;
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
    pause: &mut watch::Receiver<Pause>,
) -> Handled {
    let limit = engine.limits.max_parallel_tools.max(1);
    let mut queue = calls.into_iter();
    let mut running = FuturesUnordered::new();
    // Results that came back and wait to be stored, oldest first, and the one being stored now.
    // Storing runs alongside the tools, so a write that keeps failing never stops Stop or a
    // pause from cancelling the calls still in flight.
    let mut finished: VecDeque<(Call, String, ToolOutput)> = VecDeque::new();
    let mut storing: Option<Storing<'_>> = None;
    loop {
        // Set when the turn ends while starting a call.
        let mut ended: Option<Handled> = None;
        // No new call starts while a result is not stored yet.
        while storing.is_none() && finished.is_empty() && running.len() < limit {
            if *stop.borrow() {
                return Handled::Stopped;
            }
            if halts(*pause.borrow(), Point::Between) {
                return Handled::Paused;
            }
            let Some((call, name, arguments)) = queue.next() else {
                break;
            };
            // A tool runs only once its start is stored, so a restart can never mistake a call
            // that ran for one that did not.
            // What the tool is now is stored with its start, so compaction reads a write as one
            // even once the tool is gone or reclassified.
            let def = engine.tools.registry_for(id).get(&name).cloned();
            let background = def.as_ref().is_some_and(|def| def.background);
            let risk = match &def {
                Some(def) => Some(def.risk),
                None if name == TOOL_SEARCH => Some(Risk::Read),
                None => None,
            };
            let started = Event::Known(Known::ToolStarted {
                reply: reply.to_owned(),
                call_id: call.id.clone(),
                name: name.clone(),
                risk,
                background,
            });
            if let Err(error) = engine.record(id, &started) {
                return Handled::Failed(error.to_string());
            }
            let bot = (name == "bot_message")
                .then(|| arguments.get("bot").and_then(Value::as_str))
                .flatten()
                .and_then(|reference| engine.bot_name(id, reference));
            engine.set_status(id, Some(super::roster::tool_status(&name, bot.as_deref())));
            if background {
                match super::jobs::start(engine, id, reply, &call.id, &name, arguments, stop) {
                    Ok(super::jobs::Started::Running) => {}
                    Ok(super::jobs::Started::Stopped) => {
                        // Known not to have run: Stop came before the job started.
                        finished.push_back((call, name, ToolOutput::error(context::NOT_RUN)));
                        ended = Some(Handled::Stopped);
                        break;
                    }
                    Err(error) => return Handled::Failed(error.to_string()),
                }
                // Stored like any result, alongside the calls still running.
                let started = ToolOutput::ok(context::job_started(&call.id));
                finished.push_back((call, name, started));
                continue;
            }
            let (engine, id) = (engine.clone(), id.to_owned());
            running.push(async move {
                let output = run_one(&engine, &id, &call.id, &name, arguments).await;
                (call, name, output)
            });
        }
        if storing.is_none()
            && let Some((call, name, output)) = finished.pop_front()
        {
            storing = Some(Box::pin(async move {
                finish_tool(engine, id, reply, &call, &name, output).await;
            }));
        }
        if ended.is_none() && running.is_empty() && storing.is_none() {
            return Handled::Continue;
        }
        let ended = match ended {
            Some(ended) => Some(ended),
            None => tokio::select! {
                changed = stop.changed() => {
                    (changed.is_err() || *stop.borrow()).then_some(Handled::Stopped)
                }
                Some(done) = running.next() => {
                    finished.push_back(done);
                    None
                }
                () = stored(&mut storing) => {
                    storing = None;
                    None
                }
                _ = super::turn::pausing(pause, Point::RunningTools) => Some(Handled::Paused),
            },
        };
        if let Some(ended) = ended {
            // The calls still in flight are cancelled now; results already back are kept.
            drop(running);
            if let Some(store) = storing {
                store.await;
            }
            for (call, name, output) in finished {
                finish_tool(engine, id, reply, &call, &name, output).await;
            }
            return ended;
        }
    }
}

/// A result being stored (see `finish_tool`).
type Storing<'a> = std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + 'a>>;

/// Resolves once the result being stored is stored; never while none is.
async fn stored(storing: &mut Option<Storing<'_>>) {
    match storing {
        Some(store) => store.await,
        None => std::future::pending().await,
    }
}

async fn run_one(
    engine: &Arc<Engine>,
    id: &str,
    call_id: &str,
    name: &str,
    arguments: Value,
) -> ToolOutput {
    if name == TOOL_SEARCH {
        let query = arguments.get("query").and_then(Value::as_str).unwrap_or("");
        let registry = engine.tools.registry_for(id);
        let found = registry.search(query, 5);
        return ToolOutput::ok(describe(&found));
    }
    let Some(tool) = engine.tools.get_for(id, name) else {
        return ToolOutput::error(format!("There is no tool named {name}."));
    };
    // Unique across conversations, and the same on every retry of this call.
    let key = format!("{id}.{call_id}");
    let reads_only = tool.def().risk == Risk::Read;
    match tokio::time::timeout(engine.limits.tool_timeout, tool.run(&key, arguments)).await {
        Ok(output) => output,
        Err(_) => {
            let seconds = engine.limits.tool_timeout.as_secs();
            if reads_only {
                ToolOutput::error(format!("{name} did not finish within {seconds} seconds."))
            } else {
                // A write cut off may still have acted; never let it read as "did not run".
                ToolOutput::maybe_ran(format!(
                    "{} ({name} did not answer within {seconds} seconds.)",
                    context::MAYBE_RAN
                ))
            }
        }
    }
}

/// Stores a call's result, retrying until it is stored: the turn never moves past a call whose
/// result is not durable, and a result is never dropped.
async fn finish_tool(
    engine: &Engine,
    id: &str,
    reply: &str,
    call: &Call,
    name: &str,
    output: ToolOutput,
) {
    let mut content = trim(&output.content, engine.limits.result_chars);
    let mut images = Vec::new();
    for bytes in output.images.iter().take(crate::images::MOST_IMAGES) {
        match engine.images.put(bytes) {
            Ok(image) => images.push(image),
            Err(error) => {
                content.push_str(&format!("\n[An image it returned was not kept: {error}]"))
            }
        }
    }
    let event = Event::Known(Known::ToolFinished {
        reply: reply.to_owned(),
        call_id: call.id.clone(),
        name: name.to_owned(),
        content,
        is_error: output.is_error,
        images,
        uncertain: output.uncertain,
    });
    super::jobs::keep_trying(|| engine.record(id, &event).map(|_| ())).await;
}

pub(super) fn trim(text: &str, longest: usize) -> String {
    let count = text.chars().count();
    if count <= longest {
        return text.to_owned();
    }
    let kept: String = text.chars().take(longest).collect();
    format!("{kept}\n[… {} more characters]", count - longest)
}
