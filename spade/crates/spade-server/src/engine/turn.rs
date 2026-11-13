//! Runs one turn to its end: model steps, gated tool calls, approvals, steering, Stop and limits.
//! Every decision comes from `next_step` over the stored events.

use std::sync::Arc;
use std::sync::atomic::Ordering;

use std::panic::AssertUnwindSafe;

use futures_util::{FutureExt, StreamExt};
use spade_core::checkpoint::Checkpoints;
use spade_core::context::{self, SYSTEM};
use spade_core::event::{Call, FailureKind, Known, ReplyEnd, Tokens};
use spade_core::maintenance::{Pause, Point, halts};
use spade_core::turn::{Next, next_step, progress, stop_requested, unique_call_ids};
use spade_core::{Event, Transcript, spending, title};
use spade_models::{Delta, ToolCall};
use tokio::sync::watch;

use super::calls::{Handled, handle_calls};
use super::{Engine, Frame, Snapshot};

/// The reason a reply failed when its turn panicked.
const PANICKED: &str = "Spade ran into an internal error";

/// How a turn ended, other than finishing normally (which `finish_unless_steered` records).
enum Ended {
    Finished,
    /// Spade is closing for an update or a stop; the reply stays open and resumes later.
    Paused,
    Stopped(String),
    Failed(String, String),
    /// Failed with a known kind: what streamed, the error, and its kind.
    FailedAs(String, String, Failure),
}

/// Why a step failed, for the plain sentence a client shows (`reply_failed`'s `kind`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Failure {
    pub kind: FailureKind,
    /// The endpoint the call went to, when the failure was the endpoint's.
    pub endpoint: Option<String>,
}

impl Failure {
    /// A failed call on `model`, named by its endpoint when the endpoint is to blame.
    fn of(error: &spade_models::ModelError, model: &str) -> Self {
        let kind = FailureKind::of(error);
        let endpoint = kind
            .names_endpoint()
            .then(|| {
                model
                    .split_once('/')
                    .map(|(endpoint, _)| endpoint.to_owned())
            })
            .flatten();
        Self { kind, endpoint }
    }

    /// A spending cap: the day's, or the turn's own cost limit.
    fn cap() -> Self {
        Self {
            kind: FailureKind::Cap,
            endpoint: None,
        }
    }
}

/// What one model step produced.
pub(super) enum Step {
    /// The bot's own cap held at admission.
    Capped(spade_core::oversight::Hit),
    Answered,
    Calls,
    Paused,
    Stopped(String),
    Failed(String, String),
    FailedAs(String, String, Failure),
}

pub(super) async fn run(
    engine: Arc<Engine>,
    id: String,
    reply: String,
    stop_rx: watch::Receiver<bool>,
    mut pause_rx: watch::Receiver<Pause>,
) {
    let live = engine.live(&id);
    // The reply this worker drives, so the hand-off below can tell it from one opened later. It
    // is taken before the first stop check, so a Stop that arrives at once still closes it.
    // It is the one `spawn_turn` read, so closing it never depends on another read succeeding.
    let mut driven: Option<String> = Some(reply);
    // A panic anywhere in the turn (a tool, a parser) must not leave the reply open and the
    // conversation marked running forever: it closes the reply as failed like any error.
    let ended = AssertUnwindSafe(drive(&engine, &id, stop_rx, &mut pause_rx, &mut driven))
        .catch_unwind()
        .await
        .unwrap_or_else(|_| {
            tracing::error!(conversation = %id, "a turn panicked; closing its reply as failed");
            Ended::Failed(String::new(), PANICKED.to_owned())
        });
    let paused = matches!(ended, Ended::Paused);
    // Decided from the reply this worker drove, not from a fresh read: a read that fails now must
    // not release the reply still open. Whether it is still open is checked as it is closed.
    if let Some(reply) = driven.clone() {
        let event = match ended {
            Ended::Finished => None,
            Ended::Paused => {
                // Unless it is known to be closed already; `record_paused` copes with a failed read.
                if !matches!(still_open(&engine, &id, &reply), Ok(false)) {
                    super::maintenance::record_paused(&engine, &id, &reply);
                }
                None
            }
            Ended::Stopped(text) => {
                Some(Event::reply_ended(ReplyEnd::Stopped, reply.clone(), text))
            }
            Ended::Failed(text, error) => Some(Event::Known(Known::ReplyFailed {
                reply: reply.clone(),
                text,
                error,
                kind: FailureKind::Other,
                endpoint: None,
            })),
            Ended::FailedAs(text, error, failure) => Some(Event::Known(Known::ReplyFailed {
                reply: reply.clone(),
                text,
                error,
                kind: failure.kind,
                endpoint: failure.endpoint,
            })),
        };
        if let Some(event) = event {
            close_durably(&engine, &id, &reply, &event).await;
        }
    }
    // A task still working carries on by itself (ADR 0144). The step is registered while this
    // worker still owns the conversation, so a Stop pressed once it lets go calls it off.
    let planned = (!paused).then(|| engine.plan_carry_on(&id)).flatten();
    *live.stop.lock().unwrap_or_else(|p| p.into_inner()) = None;
    *live.current.lock().unwrap_or_else(|p| p.into_inner()) = None;
    live.waiting_on_you.store(false, Ordering::SeqCst);
    live.turn_running.store(false, Ordering::SeqCst);
    engine.set_status(&id, None);
    if paused {
        // Admission may have reopened while this worker was pausing, after reopening looked for
        // turns without a worker; then this reply carries on now.
        if engine.may_run(&id) {
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
    // A turn (or its title) that took the bot to its cap says so, once.
    engine.note_if_capped(&id);
    if let Some(planned) = planned {
        engine.carry_on_as(&id, planned);
    }
}

/// Closes `reply`, retrying until it is closed. The worker still owns the reply meanwhile, so no
/// other worker starts for it, and nothing sent to the conversation is left without a reply once
/// it lets go. A close that landed despite an error is not stored twice.
async fn close_durably(engine: &Engine, id: &str, reply: &str, close: &Event) {
    super::jobs::keep_trying(|| {
        if !still_open(engine, id, reply)? {
            return Ok(());
        }
        engine.close_reply(id, reply, close)
    })
    .await;
}

/// Whether `reply` is still the open reply, from a fresh read.
fn still_open(engine: &Engine, id: &str, reply: &str) -> Result<bool, spade_store::StoreError> {
    let events = engine.load(id)?;
    let open = Transcript::fold(&events)
        .open_reply()
        .and_then(|m| m.reply.clone());
    Ok(open.as_deref() == Some(reply))
}

/// Resolves once Stop is pressed (or the turn's signal goes away).
pub(super) async fn stopped(stop: &mut watch::Receiver<bool>) {
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
                let model = turn_model(engine, &events, &reply);
                // A subscription (ADR 0133) runs its own loop and keeps its own context: Spade's
                // step, cost and cap limits and compaction are for endpoint models.
                let cli = spade_core::brain::CliModel::is(&model);
                let done = progress(&events);
                if !cli && done.steps >= engine.limits.max_steps {
                    let limit = engine.limits.max_steps;
                    return Ended::Failed(
                        String::new(),
                        format!("the turn reached its limit of {limit} steps"),
                    );
                }
                if !cli && done.cost_micros >= engine.limits.turn_cost_micros {
                    return Ended::FailedAs(
                        String::new(),
                        "the turn reached its cost limit".to_owned(),
                        Failure::cap(),
                    );
                }
                if !cli && !engine.within_cap().unwrap_or(false) {
                    return Ended::FailedAs(
                        String::new(),
                        "today's spending cap is used up".to_owned(),
                        Failure::cap(),
                    );
                }
                // The bot's own cap (ADR 0135): no model call starts; it says so once.
                if let Some((_, hit)) = engine.bot_cap(id) {
                    return match engine.close_capped(id, &reply, &hit) {
                        Ok(()) => Ended::Finished,
                        Err(error) => Ended::Failed(String::new(), error.to_string()),
                    };
                }
                if super::index::if_needed(engine, id, &events).await {
                    continue;
                }
                if super::memory::index_if_due(engine, id, &events) {
                    continue;
                }
                if cli {
                    let step =
                        super::brain::step(engine, id, &reply, &events, &model, &mut stop, pause)
                            .await;
                    match step {
                        Step::Answered => {
                            match super::brain::finish_unless_steered(engine, id, &reply) {
                                Ok(true) => return Ended::Finished,
                                Ok(false) => {}
                                Err(error) => return Ended::Failed(String::new(), error),
                            }
                        }
                        Step::Calls => {}
                        Step::Capped(hit) => {
                            return match engine.close_capped(id, &reply, &hit) {
                                Ok(()) => Ended::Finished,
                                Err(error) => Ended::Failed(String::new(), error.to_string()),
                            };
                        }
                        Step::Paused => return Ended::Paused,
                        Step::Stopped(text) => return Ended::Stopped(text),
                        Step::Failed(text, error) => return Ended::Failed(text, error),
                        Step::FailedAs(text, error, failure) => {
                            return Ended::FailedAs(text, error, failure);
                        }
                    }
                    continue;
                }
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
                    Step::Capped(hit) => {
                        return match engine.close_capped(id, &reply, &hit) {
                            Ok(()) => Ended::Finished,
                            Err(error) => Ended::Failed(String::new(), error.to_string()),
                        };
                    }
                    Step::Paused => return Ended::Paused,
                    Step::Stopped(text) => return Ended::Stopped(text),
                    Step::Failed(text, error) => return Ended::Failed(text, error),
                    Step::FailedAs(text, error, failure) => {
                        return Ended::FailedAs(text, error, failure);
                    }
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
        .unwrap_or_else(|| engine.keyless_default_model())
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
    let prompt = context::prompt_with(SYSTEM, engine.tools.registry().offered(), events, &images)
        .session(id);
    let live = engine.live(id);
    engine.set_status(id, Some(super::roster::THINKING.to_owned()));
    // Each step's snapshot starts from its own text.
    *live.current.lock().unwrap_or_else(|p| p.into_inner()) = None;
    // Admitted against the caps counting calls in flight (ADR 0135); paid for when it ends.
    // Waits while only the estimates of calls still running stand in the way.
    let hint = super::ledger::turn_hint(events);
    let admission = tokio::select! {
        admission = engine.admit_waiting(id, &model, &prompt, hint) => admission,
        _ = stopped(stop) => return Step::Stopped(String::new()),
        _ = pausing(pause, Point::Streaming) => return Step::Paused,
    };
    let admitted = match admission {
        Ok(admitted) => admitted,
        Err(super::ledger::Refusal::Bot { hit, .. }) => return Step::Capped(hit),
        Err(super::ledger::Refusal::Service | super::ledger::Refusal::InFlight) => {
            return Step::FailedAs(
                String::new(),
                "today's spending cap is used up".to_owned(),
                Failure::cap(),
            );
        }
    };
    // A step cut off before its usage came is still paid for: its prompt, and what streamed.
    let input = super::ledger::prompt_tokens(&prompt);
    let partly = |text: &str| {
        let streamed = u32::try_from(text.len() / 4).unwrap_or(u32::MAX);
        super::ledger::likely_usage(input, hint, streamed)
    };
    // Sent again while it fails before anything streams; only a call the endpoint answered is
    // paid for, and one cut off while waiting for its answer may have been.
    let mut stream = match super::retry::open(engine, id, &model, &prompt, stop, pause).await {
        super::retry::Opened::Answering(stream) => stream,
        super::retry::Opened::Stopped => {
            admitted.settle(&partly(""));
            return Step::Stopped(String::new());
        }
        super::retry::Opened::Paused => {
            admitted.settle(&partly(""));
            return Step::Paused;
        }
        super::retry::Opened::Failed(error) => {
            // Unanswered, it was never billed; answered and then cut, it may have been.
            match error.usage() {
                Some(usage) => admitted.settle(&usage),
                None if error.may_have_billed() => admitted.settle(&partly("")),
                None => 0,
            };
            return Step::FailedAs(
                String::new(),
                error.to_string(),
                Failure::of(&error, &model),
            );
        }
    };
    let mut text = String::new();
    let mut calls: Vec<ToolCall> = Vec::new();
    let mut checkpoints = Checkpoints::new(engine.now_ms());
    loop {
        tokio::select! {
            changed = stop.changed() => {
                if changed.is_err() || *stop.borrow() {
                    admitted.settle(&partly(&text));
                    return Step::Stopped(text);
                }
            }
            // Cut mid-stream: what streamed so far is dropped and asked for again on resume (its
            // checkpoints stay, so the person still sees them meanwhile).
            _ = pausing(pause, Point::Streaming) => {
                admitted.settle(&partly(&text));
                return Step::Paused;
            }
            next = stream.next() => match next {
                Some(Ok(Delta::Text(piece))) => {
                    text.push_str(&piece);
                    {
                        // Updated and sent under one lock, which `subscribe` also takes, so a
                        // joining subscriber gets each piece in the snapshot or as a delta, never
                        // both.
                        let mut current = live.current.lock().unwrap_or_else(|p| p.into_inner());
                        add_piece(&mut current, reply, &text, &piece);
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
                    // The ledger gets the same cost the step records.
                    let _ = cost;
                    admitted.settle(&usage);
                    *live.current.lock().unwrap_or_else(|p| p.into_inner()) = None;
                    return if made_calls { Step::Calls } else { Step::Answered };
                }
                Some(Err(error)) => {
                    admitted.settle(&error.usage().unwrap_or_else(|| partly(&text)));
                    let failure = Failure::of(&error, &model);
                    return Step::FailedAs(text, error.to_string(), failure);
                }
                None => {
                    admitted.settle(&partly(&text));
                    return Step::Failed(text, "the model's reply ended early".to_owned());
                }
            }
        }
    }
}

/// Adds a streamed piece to the open reply's snapshot in place, so each piece costs its own
/// length; the text is copied whole only when the step's snapshot starts (`text` is everything
/// streamed so far, `piece` included) and when a subscriber joins.
pub(super) fn add_piece(current: &mut Option<Snapshot>, reply: &str, text: &str, piece: &str) {
    match current {
        Some(snapshot) if snapshot.reply == reply => snapshot.text.push_str(piece),
        _ => {
            *current = Some(Snapshot {
                reply: reply.to_owned(),
                text: text.to_owned(),
            })
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

/// Names the conversation after its first reply, with the person's fast model (else the agent's
/// own), else after its first message.
async fn name_if_untitled(engine: &Arc<Engine>, id: &str) {
    // Never for an agent being deleted: nothing is spent on a conversation about to go.
    if engine.deleting(id) || engine.may_spend(id).is_err() {
        return;
    }
    let Ok(events) = engine.load(id) else { return };
    let transcript = Transcript::fold(&events);
    if transcript.title.is_some() || transcript.open_reply().is_some() {
        return;
    }
    let Some(first) = transcript.first_message().map(str::to_owned) else {
        return;
    };
    let fast = match engine.fast_model() {
        Ok(Some(model)) => model,
        _ => engine.reply_model(id),
    };
    let prompt = title::prompt(&first).session(id);
    let admitted = engine
        .admit_waiting(id, &fast, &prompt, super::ledger::Hint::default())
        .await;
    let suggested = match admitted {
        // At a cap the title comes from the first message, at no cost.
        Err(_) => None,
        Ok(admitted) => match engine
            .models
            .generate::<title::Suggestion>(&fast, &prompt)
            .await
        {
            Ok(generated) => {
                admitted.settle(&generated.usage);
                title::clean(&generated.value.title)
            }
            Err(error) => {
                admitted.settle_if(error.usage());
                None
            }
        },
    };
    let name = suggested.unwrap_or_else(|| title::fallback(&first));
    if let Err(error) = engine.record(id, &Event::renamed(name)) {
        tracing::error!(%error, "could not store a title");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_long_streamed_reply_builds_its_snapshot_in_time_proportional_to_its_length() {
        let piece = "0123456789";
        let pieces = 300_000;
        let mut text = String::new();
        let mut current = None;
        let started = std::time::Instant::now();
        for _ in 0..pieces {
            text.push_str(piece);
            add_piece(&mut current, "r1", &text, piece);
        }
        let took = started.elapsed();
        assert_eq!(
            current.map(|s| (s.reply, s.text.len())),
            Some(("r1".to_owned(), 3_000_000))
        );
        // Copying the whole text per piece moves about 450 GB here; appending moves 3 MB.
        assert!(took < std::time::Duration::from_secs(1), "took {took:?}");
    }

    #[test]
    fn a_new_steps_snapshot_starts_from_its_own_text() {
        let mut current = Some(Snapshot {
            reply: "r1".into(),
            text: "old".into(),
        });
        add_piece(&mut current, "r2", "Hel", "Hel");
        add_piece(&mut current, "r2", "Hello", "lo");
        assert_eq!(
            current,
            Some(Snapshot {
                reply: "r2".into(),
                text: "Hello".into()
            })
        );
    }

    type Result = std::result::Result<(), Box<dyn std::error::Error>>;

    fn engine(
        dir: &std::path::Path,
    ) -> std::result::Result<Arc<Engine>, Box<dyn std::error::Error>> {
        let catalog = serde_json::json!({
            "roles": { "main": "fake/m", "fast": "fake/m", "deep": "fake/m" },
            "endpoints": [{ "id": "fake", "name": "Fake", "format": "openai-chat",
                            "base_url": "http://127.0.0.1:9/", "key": { "env": "FAKE_KEY" },
                            "models": [{ "id": "m", "name": "M", "capabilities": ["tools"] }] }]
        });
        let models = spade_models::Models::new(
            spade_models::Catalog::from_json(&catalog.to_string())?,
            spade_keys::Keys::new(|_| Some("fake-key".to_owned())),
            crate::home::VERSION,
        )?;
        Ok(Engine::open(super::super::Setup {
            store: spade_store::Store::open(&dir.join("spade.sqlite"))?,
            models,
            tools: crate::tools::Toolbox::new(Vec::new()),
            clock: Arc::new(crate::clock::SystemClock),
            ids: Arc::new(crate::clock::CountingIds::default()),
            daily_cap_micros: 1_000_000,
            utc_offset_seconds: 0,
            limits: super::super::Limits::default(),
            skills: None,
            images: crate::images::ImageStore::open(&dir.join("images"))?,
            adopt: None,
            keychain: None,
        })?)
    }

    #[tokio::test]
    async fn a_worker_whose_first_read_fails_still_closes_the_reply_it_was_given() -> Result {
        let dir = tempfile::tempdir()?;
        let engine = engine(dir.path())?;
        engine.store.create_conversation("c1", 0)?;
        engine.record("c1", &Event::user_message("Hi"))?;
        engine.record("c1", &Event::reply_started("r1", "fake/m"))?;
        // Storage fails from the moment the worker is scheduled.
        let hide = rusqlite::Connection::open(dir.path().join("spade.sqlite"))?;
        hide.execute_batch("ALTER TABLE events RENAME TO events_away;")?;
        let (_stop, stop_rx) = watch::channel(false);
        let pause_rx = engine.pause.subscribe();
        let worker = tokio::spawn(run(
            engine.clone(),
            "c1".into(),
            "r1".into(),
            stop_rx,
            pause_rx,
        ));
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        hide.execute_batch("ALTER TABLE events_away RENAME TO events;")?;
        tokio::time::timeout(std::time::Duration::from_secs(5), worker).await??;

        let events = engine.load("c1")?;
        let transcript = Transcript::fold(&events);
        assert!(transcript.open_reply().is_none(), "r1 was left open");
        assert!(events.iter().any(|e| matches!(
            e,
            Event::Known(Known::ReplyFailed { reply, .. }) if reply == "r1"
        )));
        Ok(())
    }
}
