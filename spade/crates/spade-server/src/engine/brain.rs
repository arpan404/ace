//! A turn on one of the person's subscriptions (ADR 0133, docs/cli-brains.md). The daemon runs
//! the bot's CLI session; this streams its text into the reply like a model step, and answers the
//! CLI's calls to the bot's own tools (`spade_call`, forwarded by ace to `/v1/agents/{id}/mcp`)
//! by storing each as a step of the reply and running it through the same gate as an endpoint
//! model's call.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use futures_util::StreamExt;
use serde_json::Value;
use spade_ace::brains::{AceBrains, BrainError, Frame, Subscription, TurnRequest};
use spade_core::brain::{self, CliModel};
use spade_core::context::ASK_USER;
use spade_core::event::{Call, Known, Tokens};
use spade_core::maintenance::{Pause, Point};
use spade_core::tools::ToolDef;
use spade_core::turn::{Next, next_step};
use spade_core::{Event, Transcript};
use spade_models::ToolSpec;
use tokio::sync::{mpsc, oneshot, watch};

use super::calls::{Handled, handle_calls};
use super::turn::{Step, add_piece, pausing};
use super::{Engine, Frame as LiveFrame};
use crate::tools::ToolOutput;

/// How Spade reaches the daemon's brain service now (from its grant and ace's files).
pub type BrainSource = Arc<dyn Fn() -> Result<AceBrains, String> + Send + Sync>;

/// One call from the CLI to the bot's own tools, waiting for its result.
pub(crate) struct BrainCall {
    name: String,
    arguments: Value,
    answer: oneshot::Sender<ToolOutput>,
}

/// The brain service, and the calls each running CLI turn takes, by conversation.
#[derive(Default)]
pub(crate) struct Brains {
    source: Mutex<Option<BrainSource>>,
    calls: Mutex<HashMap<String, mpsc::Sender<BrainCall>>>,
}

/// What a person sees when ace isn't there to run the subscription.
const ACE_AWAY: &str = "ace isn't reachable, so this bot's subscription can't run. Open ace, then \
send again.";

impl Engine {
    /// Where the daemon's brain service is; set once ace's link is up.
    pub fn set_brains(&self, source: BrainSource) {
        *self.brains.source.lock().unwrap_or_else(|p| p.into_inner()) = Some(source);
    }

    fn brain_client(&self) -> Result<AceBrains, String> {
        let source = self
            .brains
            .source
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        source.ok_or_else(|| ACE_AWAY.to_owned())?()
    }

    /// The person's subscriptions a bot can think with, from the daemon.
    pub async fn subscriptions(&self) -> Result<Vec<Subscription>, String> {
        let client = self.brain_client()?;
        client.subscriptions().await.map_err(|e| e.to_string())
    }

    /// The bot's own tools as its CLI sees them: Spade's offered tools (with `tool_search` and
    /// `call_tool` for the rest), or the matches for `query`. `None` for an unknown agent.
    pub fn brain_tools(&self, agent: &str, query: Option<&str>) -> Option<Vec<ToolSpec>> {
        let conversation = self.store.agent(agent).ok()??.conversation;
        let registry = self.tools.registry_for(&conversation);
        Some(match query.map(str::trim).filter(|q| !q.is_empty()) {
            Some(query) => registry
                .search(query, 10)
                .into_iter()
                .map(|def: &ToolDef| def.spec.clone())
                .collect(),
            None => registry.offered(),
        })
    }

    /// Runs one call the CLI made to the bot's tools, in the bot's running turn, and waits for its
    /// result (an approval waits for the person). `None` for an unknown agent.
    pub async fn brain_call(
        &self,
        agent: &str,
        name: String,
        arguments: Value,
    ) -> Option<ToolOutput> {
        let conversation = self.store.agent(agent).ok()??.conversation;
        let sender = self
            .brains
            .calls
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(&conversation)
            .cloned();
        let Some(sender) = sender else {
            return Some(ToolOutput::error(
                "Not run: this bot has no turn running on its subscription.",
            ));
        };
        let (answer, answered) = oneshot::channel();
        if sender
            .send(BrainCall {
                name,
                arguments,
                answer,
            })
            .await
            .is_err()
        {
            return Some(ToolOutput::error("Not run: the bot's turn has ended."));
        }
        Some(answered.await.unwrap_or_else(|_| {
            ToolOutput::maybe_ran("The bot's turn ended before this call reported back.")
        }))
    }
}

/// Takes the conversation's calls while a CLI turn runs; dropped when it ends.
struct Taking<'a> {
    engine: &'a Engine,
    id: String,
}

impl Drop for Taking<'_> {
    fn drop(&mut self) {
        self.engine
            .brains
            .calls
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&self.id);
    }
}

/// One turn of the bot's CLI session: what arrived since its last turn goes to the daemon, and
/// the reply streams back. The CLI's calls to the bot's tools are answered as they come, one at a
/// time.
pub(super) async fn step(
    engine: &Arc<Engine>,
    id: &str,
    reply: &str,
    events: &[Event],
    model: &str,
    stop: &mut watch::Receiver<bool>,
    pause: &mut watch::Receiver<Pause>,
) -> Step {
    let Some(cli) = CliModel::parse(model) else {
        return Step::Failed(
            String::new(),
            format!("{model} is not a subscription Spade knows"),
        );
    };
    let Some(turn) = brain::next_turn(events) else {
        // Nothing new for the CLI (a reply opened by a stop or a lost job): the reply ends here.
        return record_end(
            engine,
            id,
            reply,
            String::new(),
            Tokens::default(),
            events.len(),
        );
    };
    let Some(agent) = engine.store.agent_for_conversation(id).ok().flatten() else {
        return Step::Failed(String::new(), "this bot is gone".to_owned());
    };
    let client = match engine.brain_client() {
        Ok(client) => client,
        Err(error) => return Step::Failed(String::new(), error),
    };
    let request = TurnRequest {
        bot: agent.id,
        provider: cli.provider.clone(),
        account: cli.account.clone(),
        model: cli.model.clone(),
        instructions: turn.instructions.clone(),
        instructions_changed: turn.changed,
        message: turn.message.clone(),
    };
    let (sender, mut calls) = mpsc::channel::<BrainCall>(16);
    engine
        .brains
        .calls
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(id.to_owned(), sender);
    let _taking = Taking {
        engine,
        id: id.to_owned(),
    };
    let live = engine.live(id);
    engine.set_status(id, Some(super::roster::THINKING.to_owned()));
    *live.current.lock().unwrap_or_else(|p| p.into_inner()) = None;
    let opened = tokio::select! {
        opened = client.turn(&request) => opened,
        changed = stop.changed() => if changed.is_err() || *stop.borrow() {
            return Step::Stopped(String::new());
        } else {
            client.turn(&request).await
        },
        _ = pausing(pause, Point::Streaming) => return Step::Paused,
    };
    let mut stream = match opened {
        Ok(stream) => Box::pin(stream),
        Err(_) => return Step::Failed(String::new(), ACE_AWAY.to_owned()),
    };
    let mut text = String::new();
    loop {
        tokio::select! {
            changed = stop.changed() => {
                if changed.is_err() || *stop.borrow() {
                    return Step::Stopped(text);
                }
            }
            // Dropping the stream closes the request, which interrupts the CLI's turn; it is
            // sent again when the turn resumes.
            _ = pausing(pause, Point::Streaming) => return Step::Paused,
            call = calls.recv() => {
                let Some(call) = call else { continue };
                let shown = std::mem::take(&mut text);
                match answer_call(engine, id, reply, call, shown, turn.seen, stop, pause).await {
                    Handled::Continue => {
                        engine.set_status(id, Some(super::roster::THINKING.to_owned()));
                    }
                    Handled::Stopped => return Step::Stopped(String::new()),
                    Handled::Paused => return Step::Paused,
                    Handled::Failed(error) => return Step::Failed(String::new(), error),
                }
            }
            next = stream.next() => match next {
                Some(Ok(Frame::Text { text: piece })) => {
                    text.push_str(&piece);
                    let mut current = live.current.lock().unwrap_or_else(|p| p.into_inner());
                    add_piece(&mut current, reply, &text, &piece);
                    let _ = live.frames.send(LiveFrame::Delta { reply: reply.to_owned(), text: piece });
                }
                Some(Ok(Frame::Status { status })) => engine.set_status(
                    id,
                    Some(status.unwrap_or_else(|| super::roster::THINKING.to_owned())),
                ),
                Some(Ok(Frame::Read { source })) => {
                    // The CLI read outside text with its own tools: the rest of the turn is
                    // untrusted, as if one of Spade's tools had returned it.
                    let read = Event::Known(Known::ToolFinished {
                        reply: reply.to_owned(),
                        call_id: engine.ids.next("cli-read"),
                        name: format!("{} read {source}", cli.provider),
                        content: format!("The CLI read {source}."),
                        is_error: false,
                        uncertain: false,
                        images: Vec::new(),
                        untrusted: true,
                    });
                    if let Err(error) = engine.record(id, &read) {
                        return Step::Failed(text, error.to_string());
                    }
                }
                Some(Ok(Frame::Finished { usage })) => {
                    let tokens = Tokens {
                        input: u32::try_from(usage.input).ok(),
                        output: u32::try_from(usage.output).ok(),
                        ..Tokens::default()
                    };
                    return record_end(engine, id, reply, text, tokens, turn.seen);
                }
                Some(Ok(Frame::Failed { message, .. })) => return Step::Failed(text, message),
                Some(Ok(Frame::Session { .. } | Frame::Unknown)) => {}
                Some(Err(BrainError::Cut)) | None => {
                    return Step::Failed(text, "ace stopped answering before the turn ended.".to_owned());
                }
                Some(Err(error)) => return Step::Failed(text, error.to_string()),
            }
        }
    }
}

/// Stores the CLI's last text as a step with no calls and no cost: usage counts toward the
/// person's subscription in ace, never Spade's cap.
fn record_end(
    engine: &Engine,
    id: &str,
    reply: &str,
    text: String,
    usage: Tokens,
    seen: usize,
) -> Step {
    let step = Event::Known(Known::StepFinished {
        reply: reply.to_owned(),
        text,
        calls: Vec::new(),
        thoughts: Vec::new(),
        usage,
        cost_micros: 0,
        seen: Some(seen),
    });
    match engine.record(id, &step) {
        Ok(_) => {
            *engine
                .live(id)
                .current
                .lock()
                .unwrap_or_else(|p| p.into_inner()) = None;
            Step::Answered
        }
        Err(error) => Step::Failed(String::new(), error.to_string()),
    }
}

/// Stores the CLI's call as a step of the reply (with the text it wrote before it), runs it
/// through the gate until it has a result, and answers the CLI with that result.
#[allow(clippy::too_many_arguments)]
async fn answer_call(
    engine: &Arc<Engine>,
    id: &str,
    reply: &str,
    call: BrainCall,
    shown: String,
    seen: usize,
    stop: &mut watch::Receiver<bool>,
    pause: &mut watch::Receiver<Pause>,
) -> Handled {
    let call_id = engine.ids.next("call");
    let step = Event::Known(Known::StepFinished {
        reply: reply.to_owned(),
        text: shown,
        calls: vec![Call {
            id: call_id.clone(),
            name: call.name.clone(),
            arguments: call.arguments.clone(),
        }],
        thoughts: Vec::new(),
        usage: Tokens::default(),
        cost_micros: 0,
        seen: Some(seen),
    });
    if let Err(error) = engine.record(id, &step) {
        let _ = call.answer.send(ToolOutput::error(
            "Not run: Spade could not store the call.",
        ));
        return Handled::Failed(error.to_string());
    }
    *engine
        .live(id)
        .current
        .lock()
        .unwrap_or_else(|p| p.into_inner()) = None;
    loop {
        let events = match engine.load(id) {
            Ok(events) => events,
            Err(error) => return Handled::Failed(error.to_string()),
        };
        match next_step(&events) {
            Next::Calls { calls, .. } => {
                match handle_calls(engine, id, reply, &events, calls, stop, pause).await {
                    Handled::Continue => {}
                    ended => return ended,
                }
            }
            Next::CallModel { .. } | Next::Idle => {
                let _ = call.answer.send(result_of(&events, &call_id, &call.name));
                return Handled::Continue;
            }
        }
    }
}

/// What the CLI is told a call returned: its stored result, and for `ask_user` the person's
/// answer itself (an endpoint model reads it as the next message instead).
fn result_of(events: &[Event], call_id: &str, name: &str) -> ToolOutput {
    let finished = events.iter().find_map(|event| match event {
        Event::Known(Known::ToolFinished {
            call_id: c,
            content,
            is_error,
            uncertain,
            ..
        }) if c == call_id => Some((content.clone(), *is_error, *uncertain)),
        _ => None,
    });
    if name == ASK_USER
        && let Some(at) = events.iter().position(|event| {
            matches!(event, Event::Known(Known::QuestionAsked { call_id: c, .. }) if c == call_id)
        })
        && let Some(answer) = events[at..].iter().find_map(|event| match event {
            Event::Known(Known::UserMessage {
                text,
                from_agent: None,
                ..
            }) => Some(text.clone()),
            _ => None,
        })
    {
        return ToolOutput::ok(format!("The person answered: {answer}"));
    }
    match finished {
        Some((content, _, true)) => ToolOutput::maybe_ran(content),
        Some((content, true, false)) => ToolOutput::error(content),
        Some((content, false, false)) => ToolOutput::ok(content),
        None => ToolOutput::maybe_ran("The call did not report back."),
    }
}

/// Closes a CLI turn with its last step's text unless something arrived for the CLI since that
/// step's turn was built; then the reply carries on with another turn. Atomic against sends.
pub(super) fn finish_unless_steered(
    engine: &Engine,
    id: &str,
    reply: &str,
) -> Result<bool, String> {
    let _order = engine.record_lock.lock().unwrap_or_else(|p| p.into_inner());
    let events = engine.load(id).map_err(|e| e.to_string())?;
    if brain::next_turn(&events).is_some() {
        return Ok(false);
    }
    let text = events
        .iter()
        .rev()
        .find_map(|event| match event {
            Event::Known(Known::StepFinished { text, .. }) => Some(text.clone()),
            _ => None,
        })
        .unwrap_or_default();
    let open = Transcript::fold(&events)
        .open_reply()
        .and_then(|m| m.reply.clone());
    if open.as_deref() != Some(reply) {
        return Ok(true);
    }
    let finished = Event::Known(Known::ReplyFinished {
        reply: reply.to_owned(),
        text,
        input_tokens: None,
        output_tokens: None,
        cost_micros: 0,
    });
    engine.append(id, &finished).map_err(|e| e.to_string())?;
    Ok(true)
}
