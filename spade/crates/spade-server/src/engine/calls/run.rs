//! Running a step's allowed calls: in parallel up to the limit, each for the foreground window
//! then on as a background job, and storing each result in order.

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;

use futures_util::StreamExt;
use futures_util::stream::FuturesUnordered;
use serde_json::Value;
use spade_core::Event;
use spade_core::autonomy;
use spade_core::context;
use spade_core::effect;
use spade_core::event::{Call, Known};
use spade_core::maintenance::{Pause, Point, halts};
use spade_core::tools::{Risk, TOOL_SEARCH, describe};
use tokio::sync::watch;

use super::super::{Engine, jobs, roster, trim, turn};
use super::again::{self, Again, Held, ask_again};
use super::{Handled, ceiling, classify};
use crate::tools::{ToolOutput, TurnFacts};

/// What starting a step's calls carries from deciding them: the verdict each one outside the
/// sandbox was let run on, and what Spade's classifier read in each it raised to the person.
pub(super) struct Holding<'a> {
    pub(super) bound: &'a HashMap<String, Held>,
    pub(super) raised: &'a HashMap<String, effect::Effect>,
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn run_tools(
    engine: &Arc<Engine>,
    id: &str,
    reply: &str,
    calls: Vec<(Call, String, Value)>,
    holding: Holding<'_>,
    facts: &TurnFacts,
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
            // What it runs is read again: if it can't be, or a file changed since its verdict,
            // it doesn't start, and the person decides on it as it is now (ADR 0163, amendment 3).
            if let Some(held) = holding.bound.get(&call.id).filter(|held| held.recheck) {
                let key = format!("{id}.{}", call.id);
                let Some(now) = classify(engine, id, &name, &key, &arguments, stop).await else {
                    return Handled::Stopped;
                };
                if let Some((stop, read)) = again::stop_at_launch(now, held) {
                    let again = Again {
                        call: &call,
                        name: &name,
                        arguments: &arguments,
                        held,
                        read,
                    };
                    match ask_again(engine, id, reply, again, stop) {
                        Ok(true) => continue,
                        Ok(false) => return Handled::Stopped,
                        Err(error) => return Handled::Failed(error.to_string()),
                    }
                }
            }
            // A driving step whose page or app changed since it was decided on doesn't run: the
            // bot looks again and the gate decides on where it acts then (ADR 0171, amendment 3).
            let key = format!("{id}.{}", call.id);
            let arguments = match engine.bind_place(id, &key, &name, arguments).await {
                Ok(arguments) => arguments,
                Err(why) => {
                    finished.push_back((call, name, ToolOutput::ok(why.to_owned())));
                    continue;
                }
            };
            // A tool runs only once its start is stored, so a restart can never mistake a call
            // that ran for one that did not.
            // What the tool is now is stored with its start, so compaction reads a write as one
            // even once the tool is gone or reclassified.
            let def = engine.registry_for(id).get(&name).cloned();
            // The grant is checked again where the call runs: a call the person approved before a
            // tool was taken from this bot, or from a bot above it in its tree (ADR 0161), never
            // runs on the grant it had when it was asked.
            if def.is_none() && name != TOOL_SEARCH {
                let gone = ToolOutput::error(format!(
                    "Not run: {name} is no longer granted to this bot (the person took it from \
                     it or from a bot above it). Carry on without it."
                ));
                finished.push_back((call, name, gone));
                continue;
            }
            // The ceiling as it is when the call starts: the person may have turned a switch off
            // since it was decided, asked about or queued, or while its command was read just now
            // (ADR 0200 §3.4). Read first, then checked and started with every packaged bot over
            // it held, so no switch changes in between.
            let Some(reading) = ceiling::read(engine, id, &call.id, &name, &arguments, stop).await
            else {
                return Handled::Stopped;
            };
            let raised = holding.raised.get(&call.id).copied();
            let _ceiling_held = match &reading {
                Some(_) => ceiling::hold(engine, id).await,
                None => Vec::new(),
            };
            if let Some(why) = reading
                .as_ref()
                .and_then(|reading| ceiling::refusal(engine, id, reading, raised))
            {
                let refused = ToolOutput::ok(autonomy::refused(&why));
                finished.push_back((call, name, refused));
                continue;
            }
            let background = def.as_ref().is_some_and(|def| def.background);
            let risk = match &def {
                Some(def) => Some(def.risk),
                None if name == TOOL_SEARCH => Some(Risk::Read),
                None => None,
            };
            // What it does, as declared to the gate, so the app can say a send or a payment
            // stays when its files are undone.
            let effect = engine
                .tools
                .get_for(id, &name)
                .and_then(|tool| tool.effect(&arguments));
            let started = Event::Known(Known::ToolStarted {
                reply: reply.to_owned(),
                call_id: call.id.clone(),
                name: name.clone(),
                risk,
                background,
                effect,
            });
            // A shared bot's outward step is on the host's audit log with who allowed it,
            // written with its start, so no step runs without its entry (ADR 0206 §4.2).
            let entry = engine.effect_entry(id, &call.id, &name, &arguments, effect);
            if let Err(error) = engine.record_audited(id, &started, entry) {
                return Handled::Failed(error.to_string());
            }
            engine.computer_tool_started(id, &name);
            let bot = (name == "bot_message")
                .then(|| arguments.get("bot").and_then(Value::as_str))
                .flatten()
                .and_then(|reference| engine.bot_name(id, reference));
            engine.set_status(id, Some(roster::tool_status(&name, bot.as_deref())));
            if background {
                match jobs::start(engine, id, reply, &call.id, &name, arguments, stop) {
                    Ok(jobs::Started::Running) => {}
                    Ok(jobs::Started::Stopped) => {
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
            let (engine, id, facts) = (engine.clone(), id.to_owned(), facts.clone());
            let gate = reading.map(|reading| (reading, raised));
            running.push(async move {
                let output = run_one(&engine, &id, &call.id, &name, arguments, &facts, gate).await;
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
                Some((call, name, ran)) = running.next() => {
                    match settle(engine, id, reply, &call, &name, ran, stop) {
                        Ok(Some(output)) => {
                            finished.push_back((call, name, output));
                            None
                        }
                        // Stop came as it moved to the background.
                        Ok(None) => Some(Handled::Stopped),
                        Err(error) => Some(Handled::Failed(error)),
                    }
                }
                () = stored(&mut storing) => {
                    storing = None;
                    None
                }
                _ = turn::pausing(pause, Point::RunningTools) => Some(Handled::Paused),
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

/// How a call came back from the foreground.
enum Ran {
    Done(ToolOutput),
    /// Still running when the foreground window closed: the run itself, to carry on as a job.
    Outlived(crate::tools::ToolFuture),
}

/// Runs a call for as long as the turn's foreground window (ADR 0158). No call is ever timed out
/// here: one still running then comes back as [`Ran::Outlived`] and runs on in the background.
async fn run_one(
    engine: &Arc<Engine>,
    id: &str,
    call_id: &str,
    name: &str,
    arguments: Value,
    facts: &TurnFacts,
    gate: Option<(ceiling::Reading, Option<effect::Effect>)>,
) -> Ran {
    // Started with the packaged bots over it held, the ceiling checked once more: a call queued
    // behind others is first polled only now.
    let held = match &gate {
        Some(_) => ceiling::hold(engine, id).await,
        None => Vec::new(),
    };
    if let Some(why) = gate
        .as_ref()
        .and_then(|(reading, raised)| ceiling::refusal(engine, id, reading, *raised))
    {
        return Ran::Done(ToolOutput::ok(autonomy::refused(&why)));
    }
    if name == TOOL_SEARCH {
        let query = arguments.get("query").and_then(Value::as_str).unwrap_or("");
        let registry = engine.registry_for(id);
        let found = registry.search(query, 5);
        return Ran::Done(ToolOutput::ok(describe(&found)));
    }
    let Some(tool) = engine.tools.get_for(id, name) else {
        return Ran::Done(ToolOutput::error(format!("There is no tool named {name}.")));
    };
    // Unique across conversations, and the same on every retry of this call.
    let key = format!("{id}.{call_id}");
    let mut work = crate::tools::marked(tool.as_ref(), tool.run_in(&key, arguments, facts));
    // Its start, the first poll, still under the hold.
    let first = std::future::poll_fn(|cx| std::task::Poll::Ready(work.as_mut().poll(cx))).await;
    drop(held);
    if let std::task::Poll::Ready(output) = first {
        return Ran::Done(output);
    }
    match tokio::time::timeout(engine.limits.foreground, &mut work).await {
        Ok(output) => Ran::Done(output),
        Err(_) => Ran::Outlived(work),
    }
}

/// Answers a call with what came back from the foreground. A call that outlived it becomes job
/// `call.id`, unless the turn was stopped first: then `None`, and the run is dropped (cut off,
/// like every call still in flight when Stop comes).
fn settle(
    engine: &Arc<Engine>,
    id: &str,
    reply: &str,
    call: &Call,
    name: &str,
    ran: Ran,
    stop: &watch::Receiver<bool>,
) -> Result<Option<ToolOutput>, String> {
    let work = match ran {
        Ran::Done(output) => return Ok(Some(output)),
        Ran::Outlived(work) => work,
    };
    match jobs::adopt(engine, id, reply, &call.id, name, work, stop) {
        Ok(jobs::Started::Running) => Ok(Some(ToolOutput::ok(context::moved_to_background(
            &call.id,
            engine.limits.foreground.as_secs(),
        )))),
        Ok(jobs::Started::Stopped) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

/// Stores a call's result, retrying until it is stored: the turn never moves past a call whose
/// result is not durable, and a result is never dropped.
pub(super) async fn finish_tool(
    engine: &Engine,
    id: &str,
    reply: &str,
    call: &Call,
    name: &str,
    output: ToolOutput,
) {
    // Its sign-in expired: the call waits on a Reconnect card instead of failing, and runs again
    // once the person reconnects. A helper can't ask, so it reads the failure.
    if let Some(connector) = &output.reconnect
        && engine.helper_of(id).is_none()
        && let Some(card) = engine.reconnect_card(reply, call, connector)
    {
        jobs::keep_trying(|| {
            let _order = engine.record_lock.lock().unwrap_or_else(|p| p.into_inner());
            engine
                .append_events(id, std::slice::from_ref(&card))
                .map(|_| ())
        })
        .await;
        engine.announce(id);
        return;
    }
    let mut content = trim::trim(&output.content, engine.limits.result_chars);
    let mut images = Vec::new();
    for bytes in output.images.iter().take(crate::images::MOST_IMAGES) {
        match engine.put_image(bytes) {
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
        untrusted: output.untrusted,
    });
    // What it showed the person is stored with its result (ADR 0134), never apart from it.
    let mut events = vec![event];
    if !output.shared.is_empty() {
        events.push(Event::Known(Known::Shared {
            reply: reply.to_owned(),
            call_id: call.id.clone(),
            images: output.shared.images,
            documents: output.shared.documents,
        }));
    }
    // Where a command ran and what the sandbox did with it, for the reply's steps.
    if let Some(command) = output.command {
        events.push(command.event(reply, &call.id));
    }
    jobs::keep_trying(|| {
        let _order = engine.record_lock.lock().unwrap_or_else(|p| p.into_inner());
        engine.append_events(id, &events).map(|_| ())
    })
    .await;
}
