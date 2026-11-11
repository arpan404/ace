//! Runs one turn to its end: model steps, gated tool calls, approvals, steering, Stop and limits.
//! Every decision comes from `next_step` over the stored events.

use std::sync::Arc;
use std::sync::atomic::Ordering;

use futures_util::StreamExt;
use spade_core::checkpoint::Checkpoints;
use spade_core::context::{self, SYSTEM};
use spade_core::event::{Call, Known, ReplyEnd, Tokens};
use spade_core::maintenance::{Pause, Point, halts};
use spade_core::turn::{Next, next_step, progress, stop_requested, unique_call_ids};
use spade_core::{Event, Transcript, spending, title};
use spade_models::{Delta, Role, ToolCall};
use tokio::sync::watch;

use super::calls::{Handled, handle_calls};
use super::{Engine, Frame, Snapshot};

/// How a turn ended, other than finishing normally (which `finish_unless_steered` records).
enum Ended {
    Finished,
    /// Spade is closing for an update or a stop; the reply stays open and resumes later.
    Paused,
    Stopped(String),
    Failed(String, String),
}

/// What one model step produced.
enum Step {
    Answered,
    Calls,
    Paused,
    Stopped(String),
    Failed(String, String),
}

pub(super) async fn run(
    engine: Arc<Engine>,
    id: String,
    stop_rx: watch::Receiver<bool>,
    mut pause_rx: watch::Receiver<Pause>,
) {
    let live = engine.live(&id);
    // The reply this worker drives, so the hand-off below can tell it from one opened later. It
    // is taken before the first stop check, so a Stop that arrives at once still closes it.
    let mut driven: Option<String> = open_reply(&engine, &id);
    let ended = drive(&engine, &id, stop_rx, &mut pause_rx, &mut driven).await;
    let paused = matches!(ended, Ended::Paused);
    if let Some(reply) = open_reply(&engine, &id).filter(|open| Some(open) == driven.as_ref()) {
        let event = match ended {
            Ended::Finished => None,
            Ended::Paused => {
                super::maintenance::record_paused(&engine, &id, &reply);
                None
            }
            Ended::Stopped(text) => {
                Some(Event::reply_ended(ReplyEnd::Stopped, reply.clone(), text))
            }
            Ended::Failed(text, error) => Some(Event::Known(Known::ReplyFailed {
                reply: reply.clone(),
                text,
                error,
            })),
        };
        if let Some(event) = event
            && let Err(error) = engine.close_reply(&id, &reply, &event)
        {
            tracing::error!(%error, "could not close a turn");
        }
    }
    *live.stop.lock().unwrap_or_else(|p| p.into_inner()) = None;
    *live.current.lock().unwrap_or_else(|p| p.into_inner()) = None;
    live.waiting_on_you.store(false, Ordering::SeqCst);
    live.turn_running.store(false, Ordering::SeqCst);
    if paused {
        // Admission may have reopened while this worker was pausing, after reopening looked for
        // turns without a worker; then this reply carries on now.
        if *engine.pause.borrow() == Pause::Off {
            engine.spawn_turn(&id);
        }
        return;
    }
    // A message or job result may have opened a new reply after this turn closed but before it
    // let go; that reply's own spawn was skipped, so drive it now.
    if let Some(next) = open_reply(&engine, &id)
        && Some(&next) != driven.as_ref()
    {
        engine.spawn_turn(&id);
    }
    name_if_untitled(&engine, &id).await;
}

/// Resolves once Stop is pressed (or the turn's signal goes away).
async fn stopped(stop: &mut watch::Receiver<bool>) {
    let _ = stop.wait_for(|stopped| *stopped).await;
}

/// Resolves once the worker must pause at `point`. Never resolves if the signal goes away.
pub(super) async fn pausing(pause: &mut watch::Receiver<Pause>, point: Point) {
    if pause.wait_for(|p| halts(*p, point)).await.is_err() {
        std::future::pending::<()>().await;
    }
}

fn open_reply(engine: &Engine, id: &str) -> Option<String> {
    let events = engine.load(id).ok()?;
    Transcript::fold(&events).open_reply()?.reply.clone()
}

async fn drive(
    engine: &Arc<Engine>,
    id: &str,
    mut stop: watch::Receiver<bool>,
    pause: &mut watch::Receiver<Pause>,
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
        // Spade is closing: nothing of the turn runs now, so it pauses here (after the stop
        // check, so a stopped reply still closes as stopped).
        if let Next::CallModel { reply } | Next::Calls { reply, .. } = &next
            && halts(*pause.borrow(), Point::Between)
        {
            *driven = Some(reply.clone());
            return Ended::Paused;
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
                if super::index::if_needed(engine, id, &events).await {
                    continue;
                }
                let model = turn_model(engine, &events, &reply);
                // Stop interrupts a compaction too; nothing is stored for one cut short. A pause
                // lets it finish like a model step, unless the pause is immediate.
                let compacted = tokio::select! {
                    done = super::compact::if_needed(engine, id, &model, &events) => done,
                    _ = stopped(&mut stop) => return Ended::Stopped(String::new()),
                    _ = pausing(pause, Point::Streaming) => return Ended::Paused,
                };
                if compacted {
                    continue;
                }
                match model_step(engine, id, &reply, &events, &mut stop, pause).await {
                    Step::Answered => match finish_unless_steered(engine, id, &reply) {
                        Ok(true) => return Ended::Finished,
                        Ok(false) => {}
                        Err(error) => return Ended::Failed(String::new(), error),
                    },
                    Step::Calls => {}
                    Step::Paused => return Ended::Paused,
                    Step::Stopped(text) => return Ended::Stopped(text),
                    Step::Failed(text, error) => return Ended::Failed(text, error),
                }
            }
            Next::Calls { reply, calls } => {
                *driven = Some(reply.clone());
                match handle_calls(engine, id, &reply, &events, calls, &mut stop, pause).await {
                    Handled::Continue => {}
                    Handled::Paused => return Ended::Paused,
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
    pause: &mut watch::Receiver<Pause>,
) -> Step {
    let model = turn_model(engine, events, reply);
    let images = engine.images_for(&model);
    let prompt = context::prompt_with(SYSTEM, engine.tools.registry().offered(), events, &images);
    let live = engine.live(id);
    let opened = tokio::select! {
        opened = engine.models.stream(&model, &prompt) => opened,
        _ = stopped(stop) => return Step::Stopped(String::new()),
        _ = pausing(pause, Point::Streaming) => return Step::Paused,
    };
    let stream = match opened {
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
            // Cut mid-stream: what streamed so far is dropped and asked for again on resume (its
            // checkpoints stay, so the person still sees them meanwhile).
            _ = pausing(pause, Point::Streaming) => return Step::Paused,
            next = stream.next() => match next {
                Some(Ok(Delta::Text(piece))) => {
                    text.push_str(&piece);
                    {
                        // Updated and sent under one lock, which `subscribe` also takes, so a
                        // joining subscriber gets each piece in the snapshot or as a delta, never
                        // both.
                        let mut current = live.current.lock().unwrap_or_else(|p| p.into_inner());
                        *current = Some(Snapshot { reply: reply.to_owned(), text: text.clone() });
                        let _ = live.frames.send(Frame::Delta { reply: reply.to_owned(), text: piece });
                    }
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
