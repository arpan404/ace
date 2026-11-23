//! Starting a lane (ADR 0217 §2, §2a, §3): `task_start` from main's model, and Spade moving main's
//! long work to a lane by itself. Either way the lane's row, its first events and main's record of
//! it are stored in one write, under the record lock Stop and steering use, so a restart finds
//! the move whole or not at all, and a call run again finds the lane it made.

use std::sync::Arc;

use serde_json::{Value, json};
use spade_core::context;
use spade_core::event::{FromAgent, Known};
use spade_core::lane::{self, Link, Moved, Started};
use spade_core::{Event, Transcript};
use spade_store::StoredHelper;

use super::super::Engine;
use crate::tools::ToolOutput;

/// `task_start`'s arguments.
#[derive(serde::Deserialize)]
struct Arguments {
    title: String,
    #[serde(default)]
    brief: String,
    /// The person's asks (ids from the asks block) the task takes over.
    #[serde(default)]
    asks: Vec<String>,
}

impl Engine {
    /// `task_start`, run with `key` (`<main>.<call>`): opens a lane for the asks it names, or
    /// finds the one this call made before a restart.
    pub(crate) fn task_start(self: &Arc<Self>, key: &str, arguments: Value) -> ToolOutput {
        let Some((main, _)) = key.split_once('.') else {
            return ToolOutput::error("Spade could not tell which bot asked.");
        };
        if self.hidden_of(main).is_some() {
            return ToolOutput::error(
                "Only the main conversation starts tasks; carry this one on yourself.",
            );
        }
        let arguments: Arguments = match crate::tools::parse(arguments) {
            Ok(arguments) => arguments,
            Err(refused) => return refused,
        };
        if let Ok(Some(found)) = self.store.helper_for_job(main, key) {
            return self.started_answer(&found);
        }
        let title = lane::title_of(&arguments.title);
        if arguments.title.trim().is_empty() {
            return ToolOutput::error("Give the task a short title in the person's words.");
        }
        if arguments.brief.chars().count() > lane::BRIEF_CHARS {
            return ToolOutput::error(format!(
                "The brief is longer than {} characters; give the task less.",
                lane::BRIEF_CHARS
            ));
        }
        let events = match self.load(main) {
            Ok(events) => events,
            Err(error) => return ToolOutput::error(format!("Spade could not start it: {error}")),
        };
        let ledger = self.asks_of(main, &events);
        let mut asks: Vec<String> = arguments
            .asks
            .iter()
            .map(|a| a.trim().to_owned())
            .filter(|a| ledger.ask(a).is_some())
            .collect();
        // Named none the ledger holds: the newest open ask is the one it was asked for.
        if asks.is_empty()
            && let Some(newest) = ledger.open_asks().last()
        {
            asks.push(newest.id.clone());
        }
        let words: Vec<String> = asks
            .iter()
            .filter_map(|id| {
                persons_words(&events, id).or_else(|| Some(ledger.ask(id)?.words.clone()))
            })
            .collect();
        let registry = self.registry_for(main);
        let untrusted = !context::untrusted_in_view(&events, &registry).is_empty();
        let brief = arguments.brief.trim();
        let link = Link {
            parent_conversation: main.to_owned(),
            call: key.to_owned(),
            title: title.clone(),
            asks: asks.clone(),
            untrusted,
            moved_from: None,
        };
        let mut first = vec![Event::Known(Known::LaneOf(link))];
        // The person's own words first, as theirs, so the lane's reviewer reads the person's
        // request and not a bot's (ADR 0217 §3).
        let text = match words.is_empty() {
            true => brief.to_owned(),
            false => words.join("\n\n"),
        };
        let mut told = lane::told(&title);
        if !brief.is_empty() && !untrusted && !words.is_empty() {
            told.push_str(&format!(
                "\n<task_brief from=\"bot\">\n{brief}\n</task_brief>"
            ));
        }
        first.push(message_with(&text, told));
        // A brief written with untrusted content in view reaches the lane as the bot's message,
        // which taints the lane's turn (ADR 0161's rule).
        if untrusted && !brief.is_empty() {
            first.push(self.bots_message(
                main,
                &format!("<task_brief from=\"bot\">\n{brief}\n</task_brief>"),
            ));
        }
        let opened = Opened {
            title,
            asks,
            moved_from: None,
        };
        match self.open_lane(main, key, self.ids.next("l"), |_| {
            Some((opened, first, Vec::new()))
        }) {
            Ok(Some(row)) => self.started_answer(&row),
            Ok(None) => ToolOutput::error("Spade could not start it."),
            Err(refused) => refused,
        }
    }

    /// A message from the person with Spade's note on the task in its context.
    fn bots_message(&self, main: &str, text: &str) -> Event {
        let mut message = Event::user_message(text);
        if let Event::Known(Known::UserMessage { from_agent, .. }) = &mut message
            && let Ok(Some(agent)) = self.store.agent_for_conversation(main)
        {
            *from_agent = Some(FromAgent {
                id: agent.id,
                name: agent.name,
                depth: 0,
                machine: None,
                contract: None,
            });
        }
        message
    }

    /// Stores a lane and main's record of it in one write, under the record lock, then starts it
    /// if a slot is free. `build` reads main's events under that lock and gives the lane's first
    /// events and what follows `lane_started` in main (a move's `reply_moved` and close), or
    /// `None` when there is nothing to do any more.
    fn open_lane(
        self: &Arc<Self>,
        main: &str,
        call: &str,
        lane_id: String,
        build: impl FnOnce(&[Event]) -> Option<(Opened, Vec<Event>, Vec<Event>)>,
    ) -> Result<Option<StoredHelper>, ToolOutput> {
        let created = {
            let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
            if self.deleting(main) {
                return Err(ToolOutput::error(context::NOT_RUN));
            }
            let events = self
                .load(main)
                .map_err(|error| ToolOutput::error(format!("Spade could not start it: {error}")))?;
            let Some((opened, first, then_main)) = build(&events) else {
                return Ok(None);
            };
            let reply = Transcript::fold(events.iter())
                .open_reply()
                .and_then(|m| m.reply.clone())
                .unwrap_or_default();
            let row = StoredHelper {
                conversation: lane_id,
                parent: main.to_owned(),
                job: call.to_owned(),
                reply,
                profile: lane::PROFILE.to_owned(),
                system: String::new(),
                reads_only: false,
                tools: None,
                model: self.lane_model(main),
                created_ms: self.now_ms(),
            };
            let running = self
                .lanes_of(main)
                .iter()
                .filter(|l| {
                    let state = self.lane_state(&l.conversation);
                    state.live() && state != lane::State::Queued
                })
                .count();
            let started = Event::Known(Known::LaneStarted(Started {
                lane: row.conversation.clone(),
                conversation: row.conversation.clone(),
                title: opened.title,
                call: call.to_owned(),
                asks: opened.asks,
                moved_from: opened.moved_from,
                queued: running >= self.limits.tasks_at_once.max(1),
            }));
            let mut parent = vec![started];
            parent.extend(then_main);
            let stored = self.store.create_lane(&row, &first, &parent, self.now_ms());
            // Dropped whether or not the write succeeded: a failed write may still have landed.
            self.forget_activity(main);
            self.forget_activity(&row.conversation);
            match stored {
                Ok(Some((own, parent))) => {
                    self.publish_stored(&row.conversation, &own);
                    self.publish_stored(main, &parent);
                    Ok(Some(row))
                }
                Ok(None) => Ok(None),
                Err(error) => Err(error),
            }
        };
        match created {
            Ok(Some(row)) => {
                self.fill_lanes(main);
                self.announce(main);
                Ok(Some(row))
            }
            // Made meanwhile by another run of this call: that one is the lane.
            Ok(None) => match self.store.helper_for_job(main, call) {
                Ok(found) => Ok(found),
                Err(_) => Err(ToolOutput::error("Spade could not start it.")),
            },
            Err(error) => Err(ToolOutput::error(format!(
                "Spade could not start it: {error}"
            ))),
        }
    }

    /// What `task_start` answers: the task, its title and whether it runs or waits for a slot.
    fn started_answer(&self, row: &StoredHelper) -> ToolOutput {
        let state = self.lane_state(&row.conversation);
        let title = self.lane_title(&row.conversation);
        let mut answer = json!({ "task": row.conversation, "title": title, "state": state.name() });
        if state == lane::State::Queued {
            answer["note"] = json!(format!(
                "Queued behind {} running tasks; it starts when one ends. Tell the person.",
                self.limits.tasks_at_once
            ));
        }
        ToolOutput::ok(answer.to_string())
    }

    /// Moves main's open `reply` to a lane when it is due (ADR 0217 §2a): `true` once moved, and
    /// the turn ends. Decided and stored under the record lock, so a message or a Stop that comes
    /// at the same moment lands before the move (and is carried into the lane) or after it.
    pub(in super::super) fn move_if_due(
        self: &Arc<Self>,
        main: &str,
        reply: &str,
        elapsed_ms: i64,
    ) -> bool {
        if self.hidden_of(main).is_some() || !self.limits.move_long_work {
            return false;
        }
        // A cheap look first, without the lock: most steps are nowhere near a move.
        match self.load(main) {
            Ok(events) if lane::move_due(&events, reply, elapsed_ms) => {}
            _ => return false,
        }
        let registry = self.registry_for(main);
        let lane_id = self.ids.next("l");
        let call = format!("moved.{reply}");
        let build = |events: &[Event]| {
            if !lane::move_due(events, reply, elapsed_ms)
                || spade_core::turn::stop_requested(events, reply)
            {
                return None;
            }
            let (mut moved, asks) = lane::moved(events, reply)?;
            let title = match moved.first() {
                Some(Event::Known(Known::UserMessage { text, .. })) => lane::title_of(text),
                _ => lane::title_of(""),
            };
            if let Some(Event::Known(Known::UserMessage { context, .. })) = moved.first_mut() {
                let told = lane::told(&title);
                *context = Some(match context.take() {
                    Some(recent) => format!("{told}\n{recent}"),
                    None => told,
                });
            }
            let link = Link {
                parent_conversation: main.to_owned(),
                call: call.clone(),
                title: title.clone(),
                asks: asks.clone(),
                untrusted: !context::untrusted_in_view(events, &registry).is_empty(),
                moved_from: Some(reply.to_owned()),
            };
            let mut first = vec![Event::Known(Known::LaneOf(link))];
            first.append(&mut moved);
            let then_main = vec![
                Event::Known(Known::ReplyMoved(Moved {
                    reply: reply.to_owned(),
                    lane: lane_id.clone(),
                    title: title.clone(),
                    asks: asks.clone(),
                })),
                Event::Known(Known::ReplyFinished {
                    reply: reply.to_owned(),
                    text: String::new(),
                    input_tokens: None,
                    output_tokens: None,
                    cost_micros: 0,
                }),
            ];
            let opened = Opened {
                title,
                asks,
                moved_from: Some(reply.to_owned()),
            };
            Some((opened, first, then_main))
        };
        matches!(self.open_lane(main, &call, lane_id.clone(), build), Ok(Some(row)) if row.conversation == lane_id)
    }
}

/// What `lane_started` says of a lane being opened.
struct Opened {
    title: String,
    asks: Vec<String>,
    moved_from: Option<String>,
}

/// The verbatim words of the person's message `id` (`m<seq>`) in `events`.
fn persons_words(events: &[Event], id: &str) -> Option<String> {
    if id.contains('.') {
        return None;
    }
    let seq = usize::try_from(spade_core::chat_markup::seq_of(id)?).ok()?;
    match events.get(seq.checked_sub(1)?)? {
        Event::Known(Known::UserMessage { text, .. }) => Some(text.trim().to_owned()),
        _ => None,
    }
}

/// A message from the person with Spade's per-turn `context`.
fn message_with(text: &str, context: String) -> Event {
    let mut message = Event::user_message(text);
    if let Event::Known(Known::UserMessage { context: c, .. }) = &mut message {
        *c = Some(context);
    }
    message
}
