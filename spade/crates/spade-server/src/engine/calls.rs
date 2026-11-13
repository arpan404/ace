//! A step's tool calls: the gate, approvals, running allowed calls in parallel (or as background
//! jobs), and storing each result.

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;

use futures_util::StreamExt;
use futures_util::stream::FuturesUnordered;
use serde_json::Value;
use spade_core::autonomy::{self, Access, Class, Route, Sensitive};
use spade_core::context;
use spade_core::event::Verdict;
use spade_core::event::{Call, Known};
use spade_core::gate::{self, Decision};
use spade_core::maintenance::{Pause, Point, halts};
use spade_core::review;
use spade_core::tools::{CALL_TOOL, Risk, TOOL_SEARCH, describe, unwrap_call_tool};
use spade_core::turn::{Pending, Status};
use spade_core::{Event, Transcript};
use tokio::sync::watch;

use super::Engine;
use super::autonomy::Reviewed;
use crate::tools::{ToolOutput, TurnFacts};

const DECLINED: &str = "The person declined this action.";

/// Memory tools whose writes become suggestions while only a tainted summary is in view.
fn suggestible(name: &str) -> bool {
    matches!(name, "memory_save" | "memory_update")
}

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
    // What a tool keeps (a trusted file, a note, a proposal's source) answers to everything the
    // prompt shows, not just this turn: untrusted text from an earlier turn is still in view.
    let in_view = context::untrusted_in_view(events, &registry);
    // A note outlives the turn, so it answers to everything the prompt shows (ADR 0130): an
    // untrusted event from any turn since the last compaction makes a note ask. A tainted
    // summary alone does not block: a note saved or rewritten then is only suggested to the
    // person (memory.md), so one page read long ago never stops a routine's notes for good.
    let events_in_view = !context::untrusted_events_in_view(events, &registry).is_empty();
    let untrusted_memory = untrusted || events_in_view;
    let summary_only = !untrusted_memory && context::untrusted_summary(events);
    let facts = TurnFacts {
        untrusted: (!in_view.is_empty()).then(|| in_view.join(", ")),
        memory_suggests: summary_only,
    };
    let mut runnable: Vec<(Call, String, Value)> = Vec::new();
    // Calls approved by the reviewer with the files they run, by call id: the hash of those
    // files as it read them (ADR 0144).
    let mut bound: HashMap<String, Option<String>> = HashMap::new();
    let mut waiting = false;
    // Started with no stored result. This worker runs every call it starts to its stored end, so
    // such a call ran in an earlier worker that was cut off: its outcome is unknown.
    let mut orphaned: Vec<(Call, String)> = Vec::new();
    for pending in calls {
        let (name, arguments) = resolve(&pending.call);
        match pending.status {
            Status::New if name == TOOL_SEARCH => runnable.push((pending.call, name, arguments)),
            // `ask_user` (ADR 0128) waits like an approval; the person's next message answers it.
            Status::New if name == context::ASK_USER => match super::memory::question(&arguments) {
                Err(refused) => finish_tool(engine, id, reply, &pending.call, &name, refused).await,
                Ok(question) => {
                    waiting = true;
                    let asked = Event::Known(Known::QuestionAsked {
                        reply: reply.to_owned(),
                        call_id: pending.call.id.clone(),
                        question,
                    });
                    match engine.record_unless_stopped(id, reply, &asked) {
                        Ok(true) => {}
                        Ok(false) => return Handled::Stopped,
                        Err(error) => return Handled::Failed(error.to_string()),
                    }
                }
            },
            Status::Asked => waiting = true,
            Status::Answered => {
                let answered = ToolOutput::ok(context::ANSWERED);
                finish_tool(engine, id, reply, &pending.call, &name, answered).await;
            }
            Status::New => match registry.get(&name) {
                None => {
                    let missing = ToolOutput::error(format!(
                        "There is no tool named {name}. Use tool_search to find tools."
                    ));
                    finish_tool(engine, id, reply, &pending.call, &name, missing).await;
                }
                Some(def) => {
                    let key = format!("{id}.{}", pending.call.id);
                    let scope = engine
                        .tools
                        .get_for(id, &name)
                        .and_then(|tool| tool.always_scope_in(&key, &arguments));
                    let always = match &scope {
                        Some(scope) => allowed_always_for(engine, id, events, &name, scope),
                        None => transcript.always_allowed.iter().any(|t| t == &name),
                    };
                    let tainted = match def.risk {
                        // Only saving and rewriting can wait as a suggestion; any other change to
                        // notes (forgetting one) asks while the summary is tainted.
                        Risk::Memory => untrusted_memory || (summary_only && !suggestible(&name)),
                        _ => untrusted,
                    };
                    let rule = gate::decide(def.risk, always, tainted);
                    // The bot's access level (ADR 0144) decides what happens to a call the
                    // rule gate would ask about: the person, the reviewer, or neither.
                    // Read now, for this call: a change the person made while earlier calls
                    // of the step were decided holds from here (ADR 0144).
                    let access = engine.level(id, events);
                    // What the call reaches, and the files it runs that the reviewer must read.
                    let Some(classed) = classify(engine, id, &name, &key, &arguments, stop).await
                    else {
                        return Handled::Stopped;
                    };
                    let route = autonomy::route(autonomy::Call {
                        access,
                        rule,
                        risk: def.risk,
                        class: classed.class,
                        // Anything untrusted the prompt shows, from any turn since compaction.
                        tainted: !in_view.is_empty(),
                        // Its arguments reach a credential place, or the tool itself says it
                        // hands back secrets: refused on every level.
                        credentials: classed.credentials
                            || autonomy::reaches_credentials(&arguments)
                            || autonomy::reads_credentials(
                                &def.spec.name,
                                &def.spec.description,
                                def.risk,
                            ),
                        standing: autonomy::STANDING.contains(&name.as_str()),
                        fits: autonomy::fits_review(&arguments, &classed.shown),
                    });
                    let mut reviewer_reason = None;
                    let rule_ran = route == Route::Run;
                    let mut decision = match route {
                        Route::Run => Decision::Run,
                        Route::Ask(reason) => {
                            if let Some(reason) = &reason {
                                let escalated = Verdict::Escalate;
                                match rule_verdict(
                                    engine,
                                    id,
                                    reply,
                                    events,
                                    &pending.call,
                                    &name,
                                    escalated,
                                    reason,
                                ) {
                                    Ok(true) => {}
                                    Ok(false) => return Handled::Stopped,
                                    Err(error) => return Handled::Failed(error.to_string()),
                                }
                            }
                            reviewer_reason = reason;
                            Decision::Ask
                        }
                        Route::Refuse(reason) => {
                            match rule_verdict(
                                engine,
                                id,
                                reply,
                                events,
                                &pending.call,
                                &name,
                                Verdict::Refuse,
                                &reason,
                            ) {
                                Ok(true) => {}
                                Ok(false) => return Handled::Stopped,
                                Err(error) => return Handled::Failed(error.to_string()),
                            }
                            let refused = ToolOutput::ok(autonomy::refused(&reason));
                            finish_tool(engine, id, reply, &pending.call, &name, refused).await;
                            continue;
                        }
                        Route::Review => {
                            let def = def.clone();
                            let under = super::autonomy::Under {
                                call: &pending.call,
                                name: &name,
                                arguments: &arguments,
                                def: &def,
                                shell: name == "shell",
                                shown: &classed.shown,
                            };
                            // An approval is bound to the files as the reviewer read them: the
                            // stored one's, or these when this review is the first.
                            let expected = match review::stored(events, &pending.call.id) {
                                Some(_) => review::bound(events, &pending.call.id),
                                None => super::autonomy::binding(&classed.shown),
                            };
                            if expected.is_some() || !classed.shown.is_empty() {
                                bound.insert(pending.call.id.clone(), expected);
                            }
                            match super::autonomy::review(
                                engine, id, reply, events, &registry, under, stop,
                            )
                            .await
                            {
                                Reviewed::Run => Decision::Run,
                                Reviewed::Escalate(reason) => {
                                    reviewer_reason = Some(reason);
                                    Decision::Ask
                                }
                                Reviewed::Refuse(reason) => {
                                    let refused = ToolOutput::ok(autonomy::refused(&reason));
                                    finish_tool(engine, id, reply, &pending.call, &name, refused)
                                        .await;
                                    continue;
                                }
                                Reviewed::Stopped => return Handled::Stopped,
                            }
                        }
                    };
                    // The model review (ADR 0135) may turn a run into a question, never the
                    // other way round. Full access has nothing ask; a call the auto-review
                    // approved was reviewed already.
                    if rule_ran
                        && access != Access::FullAccess
                        && review::reviewed(def.risk, decision)
                        && engine.review_on(id)
                    {
                        let def = def.clone();
                        match super::review::call(
                            engine,
                            id,
                            reply,
                            events,
                            &registry,
                            &pending.call,
                            &name,
                            &arguments,
                            &def,
                            stop,
                        )
                        .await
                        {
                            super::review::Reviewed::Allow => {}
                            super::review::Reviewed::Escalate => decision = Decision::Ask,
                            super::review::Reviewed::Stopped => return Handled::Stopped,
                        }
                    }
                    match decision {
                        Decision::Run => {
                            // What "always" allowed, checked again where it runs (ADR 0142).
                            if let Some(scope) = &scope {
                                engine.allow_scope(&key, scope);
                            }
                            runnable.push((pending.call, name, arguments));
                        }
                        Decision::Ask => {
                            waiting = true;
                            let asked = Event::Known(Known::ApprovalRequested {
                                reply: reply.to_owned(),
                                call_id: pending.call.id.clone(),
                                name,
                                arguments,
                                scope,
                                reviewer_reason,
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
            Status::Allowed => {
                // What the person allowed, as it was asked: checked again where it runs, so a
                // terminal that changed since (or was reset by a restart) is never run in.
                if let Some(scope) = asked_scope(events, &pending.call.id) {
                    engine.allow_scope(&format!("{id}.{}", pending.call.id), &scope);
                }
                runnable.push((pending.call, name, arguments));
            }
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
        return run_tools(engine, id, reply, runnable, &bound, &facts, stop, pause).await;
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

/// Stores a verdict the rules reached (ADR 0144) unless one is stored for the call already, as
/// after a restart. `Ok(false)` when the reply was stopped.
#[allow(clippy::too_many_arguments)]
fn rule_verdict(
    engine: &Engine,
    id: &str,
    reply: &str,
    events: &[Event],
    call: &Call,
    name: &str,
    verdict: Verdict,
    reason: &str,
) -> Result<bool, spade_store::StoreError> {
    if review::stored(events, &call.id).is_some() {
        return Ok(true);
    }
    super::autonomy::record_rule(engine, id, reply, call, name, verdict, reason)
}

/// Whether the person answered "always" to an earlier call of `name` with the same scope (for
/// the shell, the exact same command). Read from the conversation's own events, so it holds for
/// the bot across restarts and compaction.
fn allowed_always_for(
    engine: &Engine,
    id: &str,
    events: &[Event],
    name: &str,
    scope: &str,
) -> bool {
    let Some(tool) = engine.tools.get_for(id, name) else {
        return false;
    };
    events.iter().any(|event| match event {
        Event::Known(Known::ApprovalAnswered {
            call_id,
            allowed: true,
            always: true,
            ..
        }) => events.iter().any(|asked| {
            matches!(asked, Event::Known(Known::ApprovalRequested { call_id: c, name: n, arguments, scope: asked_scope, .. })
                if c == call_id && n == name
                    && asked_scope.clone().or_else(|| tool.always_scope(arguments)).as_deref() == Some(scope))
        }),
        _ => false,
    })
}

/// The scope the call `call_id` was asked with, when its tool gave one.
fn asked_scope(events: &[Event], call_id: &str) -> Option<String> {
    events.iter().rev().find_map(|event| match event {
        Event::Known(Known::ApprovalRequested {
            call_id: c, scope, ..
        }) if c == call_id => scope.clone(),
        _ => None,
    })
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

#[allow(clippy::too_many_arguments)]
async fn run_tools(
    engine: &Arc<Engine>,
    id: &str,
    reply: &str,
    calls: Vec<(Call, String, Value)>,
    bound: &HashMap<String, Option<String>>,
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
            // A file the reviewer read changed since: not run, and the bot asks again.
            if let Some(expected) = bound.get(&call.id) {
                let key = format!("{id}.{}", call.id);
                let Some(now) = classify(engine, id, &name, &key, &arguments, stop).await else {
                    return Handled::Stopped;
                };
                if &super::autonomy::binding(&now.shown) != expected {
                    let changed = ToolOutput::ok(autonomy::refused(SCRIPT_CHANGED));
                    finished.push_back((call, name, changed));
                    continue;
                }
            }
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
            engine.computer_tool_started(id, &name);
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
            let (engine, id, facts) = (engine.clone(), id.to_owned(), facts.clone());
            running.push(async move {
                let output = run_one(&engine, &id, &call.id, &name, arguments, &facts).await;
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

/// The longest a call's classification may take (reading the scripts and makefiles it runs)
/// before it goes to the person as unclear.
const CLASSIFY_TIME: std::time::Duration = std::time::Duration::from_secs(10);

/// What a call reaches (ADR 0144), worked out off the turn's thread: reading a command's files is
/// blocking work, bounded by the classifier's budget and here by [`CLASSIFY_TIME`]. Stop is
/// heard meanwhile: `None` when it was pressed.
async fn classify(
    engine: &Engine,
    id: &str,
    name: &str,
    key: &str,
    arguments: &Value,
    stop: &mut watch::Receiver<bool>,
) -> Option<autonomy::Classed> {
    let Some(tool) = engine.tools.get_for(id, name) else {
        return Some(Class::Sensitive(Sensitive::Unknown).into());
    };
    let (key, arguments) = (key.to_owned(), arguments.clone());
    let work = tokio::task::spawn_blocking(move || tool.classed(&key, &arguments));
    tokio::select! {
        done = tokio::time::timeout(CLASSIFY_TIME, work) => Some(match done {
            Ok(Ok(classed)) => classed,
            // Took too long, or panicked: the person decides.
            _ => Class::Sensitive(Sensitive::Unclear).into(),
        }),
        _ = stop.wait_for(|stopped| *stopped) => None,
    }
}

/// Why a reviewed call whose files changed before it started didn't run.
const SCRIPT_CHANGED: &str = "A file it runs changed after it was reviewed.";

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
    facts: &TurnFacts,
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
    match tokio::time::timeout(
        engine.limits.tool_timeout,
        tool.run_in(&key, arguments, facts),
    )
    .await
    {
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
    super::jobs::keep_trying(|| {
        let _order = engine.record_lock.lock().unwrap_or_else(|p| p.into_inner());
        engine.append_events(id, &events).map(|_| ())
    })
    .await;
}

pub(super) fn trim(text: &str, longest: usize) -> String {
    let count = text.chars().count();
    if count <= longest {
        return text.to_owned();
    }
    let kept: String = text.chars().take(longest).collect();
    format!("{kept}\n[… {} more characters]", count - longest)
}
