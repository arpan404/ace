//! Talking to lanes (ADR 0217 §2, §3, §5): main's `task_message`, `task_stop` and `tasks`, a
//! person's reply to a lane's message routed to that lane with no model call, and the person
//! writing in a lane's own transcript.

use std::sync::Arc;

use serde_json::{Value, json};
use spade_core::Event;
use spade_core::event::Known;
use spade_core::helper::{self, Stage};
use spade_core::lane::{self, Routed};
use spade_store::{StoreError, StoredHelper};

use super::super::Engine;
use crate::tools::ToolOutput;

#[derive(serde::Deserialize)]
struct Message {
    task: String,
    text: String,
    #[serde(default)]
    asks: Vec<String>,
}

#[derive(serde::Deserialize)]
struct Stop {
    task: String,
    #[serde(default)]
    because: String,
}

#[derive(serde::Deserialize, Default)]
struct Look {
    #[serde(default)]
    task: Option<String>,
}

impl Engine {
    /// The lane of `main` that `reference` names: its id, or its title.
    fn find_lane(&self, main: &str, reference: &str) -> Result<StoredHelper, String> {
        let reference = reference.trim();
        let lanes = self.lanes_of(main);
        if let Some(row) = lanes.iter().find(|row| row.conversation == reference) {
            return Ok(row.clone());
        }
        let titled: Vec<&StoredHelper> = lanes
            .iter()
            .filter(|row| {
                self.lane_title(&row.conversation)
                    .eq_ignore_ascii_case(reference)
            })
            .collect();
        match titled.as_slice() {
            [one] => Ok((*one).clone()),
            _ => Err(format!(
                "There is no task {reference}. Your tasks are listed by tasks."
            )),
        }
    }

    /// `task_message`: main sends a lane something that changes it; the asks it names move with
    /// it. It steers the lane's running turn, or opens its next reply in its own context.
    pub(crate) fn task_message(self: &Arc<Self>, key: &str, arguments: Value) -> ToolOutput {
        let Some((main, _)) = key.split_once('.') else {
            return ToolOutput::error("Spade could not tell which bot asked.");
        };
        let arguments: Message = match crate::tools::parse(arguments) {
            Ok(arguments) => arguments,
            Err(refused) => return refused,
        };
        let row = match self.find_lane(main, &arguments.task) {
            Ok(row) => row,
            Err(refused) => return ToolOutput::error(refused),
        };
        let text = arguments.text.trim();
        if text.is_empty() {
            return ToolOutput::error("Say what the task should know.");
        }
        let events = self.load(main).unwrap_or_default();
        let ledger = self.asks_of(main, &events);
        let asks: Vec<String> = arguments
            .asks
            .iter()
            .map(|a| a.trim().to_owned())
            .filter(|a| ledger.ask(a).is_some())
            .collect();
        // The person's own words for each ask go as theirs, verbatim from their message; main's
        // words go as the bot's, never as the person's (ADR 0217 §3), tainted when main had
        // untrusted content in view as it wrote them.
        let words: Vec<String> = asks
            .iter()
            .filter_map(|id| lane::persons_words(&events, id))
            .collect();
        let untrusted =
            !spade_core::context::untrusted_in_view(&events, &self.registry_for(main)).is_empty();
        let mut to_lane = Vec::new();
        if !words.is_empty() {
            to_lane.push(Event::user_message(words.join("\n\n")));
        }
        to_lane.push(Event::Known(Known::LaneMessage(lane::Message {
            text: text.to_owned(),
            untrusted,
        })));
        // The asks are the lane's now: main's ledger hands them over (ADR 0217 §2), in the same
        // write as the lane hears of them.
        let title = self.lane_title(&row.conversation);
        let to_main: Vec<Event> = asks
            .iter()
            .map(|ask| {
                Event::Known(Known::AskRouted(Routed {
                    lane: row.conversation.clone(),
                    title: title.clone(),
                    message: ask.clone(),
                }))
            })
            .collect();
        if let Err(error) = self.send_to_lane(&row, to_lane, |_| Some(to_main)) {
            return ToolOutput::error(format!("Spade could not send it: {error}"));
        }
        ToolOutput::ok(
            json!({ "task": row.conversation, "state": self.lane_state(&row.conversation).name() })
                .to_string(),
        )
    }

    /// Stores `to_lane` in the lane and what `to_main` gives (from main's events, read under the
    /// lock) in main, in one write: it steers the lane's running reply, opens its next one when
    /// none is open, and waits with its brief in a queued lane.
    pub(in super::super) fn send_to_lane(
        self: &Arc<Self>,
        row: &StoredHelper,
        mut to_lane: Vec<Event>,
        to_main: impl FnOnce(&[Event]) -> Option<Vec<Event>>,
    ) -> Result<(), StoreError> {
        let id = row.conversation.as_str();
        let start = {
            let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
            let events = self.load(id)?;
            let main_events = self.load(&row.parent)?;
            let open = spade_core::Transcript::fold(events.iter())
                .open_reply()
                .is_some();
            let admitted = self.admission.load(std::sync::atomic::Ordering::SeqCst)
                && !self.closed(id)
                && !self.deleting(id);
            let start = admitted && !open && helper::stage(&events) != Stage::Queued;
            if start {
                to_lane.push(Event::reply_started(
                    self.ids.next("r"),
                    self.lane_model(&row.parent),
                ));
            }
            let main_side = to_main(&main_events).unwrap_or_default();
            let mut writes: Vec<(&str, &[Event])> = vec![(id, to_lane.as_slice())];
            if !main_side.is_empty() {
                writes.push((row.parent.as_str(), main_side.as_slice()));
            }
            self.append_across(&writes, &[])?;
            start
        };
        if start {
            self.spawn_turn(id);
        } else {
            // A turn waiting on the person reads it now.
            self.live(id).wake.notify_one();
        }
        self.announce(&row.parent);
        Ok(())
    }

    /// The person's message to main that replies to a lane's message goes to that lane (ADR 0217
    /// §2), with no model call: main stores the person's bubble and `ask_routed`, the lane the
    /// person's message. `None` when `reply_to` names no lane's message, so main takes it.
    pub(in super::super) fn route_reply(
        self: &Arc<Self>,
        main: &str,
        message: &Event,
        reply_to: Option<&str>,
    ) -> Option<Result<(), StoreError>> {
        let replied = reply_to?;
        let events = self.load(main).ok()?;
        let lane_id = lane::replied_to(&events, replied)?;
        let row = self.lane_row(&lane_id)?;
        let title = self.lane_title(&lane_id);
        // The lane hears the person's own words, trusted (ADR 0217 §2), without the quote of
        // main's message that only made sense there.
        let mut own = message.clone();
        if let Event::Known(Known::UserMessage { reply_to, .. }) = &mut own {
            *reply_to = None;
        }
        // Main keeps the person's bubble and where it went, the lane the message, in one write:
        // a crash never leaves main saying it went while the lane never got it.
        let sent = self.send_to_lane(&row, vec![own], |main_events| {
            let routed = Event::Known(Known::AskRouted(Routed {
                lane: lane_id.clone(),
                title,
                message: spade_core::chat_markup::id(main_events.len() as u64 + 1, 0),
            }));
            Some(vec![message.clone(), routed])
        });
        Some(sent)
    }

    /// `task_stop`: refused unless `because` names the person's message asking for it.
    pub(crate) fn task_stop(self: &Arc<Self>, key: &str, arguments: Value) -> ToolOutput {
        let Some((main, _)) = key.split_once('.') else {
            return ToolOutput::error("Spade could not tell which bot asked.");
        };
        let arguments: Stop = match crate::tools::parse(arguments) {
            Ok(arguments) => arguments,
            Err(refused) => return refused,
        };
        let row = match self.find_lane(main, &arguments.task) {
            Ok(row) => row,
            Err(refused) => return ToolOutput::error(refused),
        };
        let events = self.load(main).unwrap_or_default();
        if let Err(refused) = lane::stop_allowed(&events, &row.conversation, &arguments.because) {
            return ToolOutput::error(refused);
        }
        if let Err(error) = self.stop_lane(&row.conversation) {
            return ToolOutput::error(format!("Spade could not stop it: {error}"));
        }
        ToolOutput::ok(json!({ "task": row.conversation, "state": "stopped" }).to_string())
    }

    /// `tasks`: each lane's title, state, goal, plan step, last words and cost; one with `task`.
    pub(crate) fn tasks_tool(&self, key: &str, arguments: Value) -> ToolOutput {
        let Some((main, _)) = key.split_once('.') else {
            return ToolOutput::error("Spade could not tell which bot asked.");
        };
        let look: Look = serde_json::from_value(arguments).unwrap_or_default();
        let rows = match look.task.as_deref() {
            Some(task) => match self.find_lane(main, task) {
                Ok(row) => vec![row],
                Err(refused) => return ToolOutput::error(refused),
            },
            None => {
                let mut lanes = self.live_lanes_of(main);
                lanes.extend(
                    self.store
                        .ended_lanes(main, super::view::ENDED_SHOWN)
                        .unwrap_or_default(),
                );
                lanes
            }
        };
        let shown: Vec<Value> = rows
            .iter()
            .filter_map(|row| self.lane_view(row, true).ok())
            .collect();
        ToolOutput::ok(json!({ "tasks": shown }).to_string())
    }
}

impl Engine {
    /// Stores `asked` (an `ask_user` card, and its deferral when it waits on nothing) in `id`,
    /// unless `reply` was stopped; a lane's goes to main too in the same write, naming the lane,
    /// where the person answers it (ADR 0217 §4). Its call id there is `<lane>.<call>`.
    pub(in super::super) fn ask_question(
        self: &Arc<Self>,
        id: &str,
        reply: &str,
        asked: &[Event],
    ) -> Result<bool, StoreError> {
        let mirror = self.question_mirror(id, asked);
        {
            let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
            if spade_core::turn::stop_requested(&self.load(id)?, reply) {
                return Ok(false);
            }
            match &mirror {
                Some((main, mirrored)) => {
                    self.append_across(&[(id, asked), (main.as_str(), mirrored.as_slice())], &[])?;
                }
                None => {
                    self.append_events(id, asked)?;
                }
            }
        }
        if let Some((main, _)) = mirror {
            self.announce(&main);
        }
        Ok(true)
    }

    /// Main and the copy of `asked` it shows, when `id` is a lane.
    fn question_mirror(&self, id: &str, asked: &[Event]) -> Option<(String, Vec<Event>)> {
        let row = self.lane_row(id)?;
        let title = self.lane_title(id);
        let mirrored: Vec<Event> = asked
            .iter()
            .filter_map(|event| match event {
                Event::Known(Known::QuestionAsked {
                    call_id,
                    question,
                    questions,
                    later,
                    ..
                }) => Some(Event::Known(Known::QuestionAsked {
                    reply: row.reply.clone(),
                    call_id: format!("{id}.{call_id}"),
                    question: question.clone(),
                    questions: questions.clone(),
                    later: *later,
                    lane: Some(Box::new(lane::Ask {
                        task: id.to_owned(),
                        conversation: id.to_owned(),
                        call_id: call_id.clone(),
                        title: title.clone(),
                    })),
                })),
                Event::Known(Known::QuestionDeferred { call_id, by_bot }) => {
                    Some(Event::Known(Known::QuestionDeferred {
                        call_id: format!("{id}.{call_id}"),
                        by_bot: *by_bot,
                    }))
                }
                _ => None,
            })
            .collect();
        (!mirrored.is_empty()).then_some((row.parent, mirrored))
    }

    /// The lane and its own call id when `call_id` in `main` is a lane's card asked there.
    pub(in super::super) fn lane_question(
        &self,
        main: &str,
        call_id: &str,
    ) -> Option<(String, String)> {
        let events = self.load(main).ok()?;
        events.iter().rev().find_map(|event| match event {
            Event::Known(Known::QuestionAsked {
                call_id: c,
                lane: Some(lane),
                ..
            }) if c == call_id => Some((lane.conversation.clone(), lane.call_id.clone())),
            _ => None,
        })
    }

    /// Main and its copy of lane `lane_id`'s card `call_id` closed the way `answered` closed the
    /// lane's, when main shows that card.
    pub(in super::super) fn closed_copy(
        &self,
        lane_id: &str,
        call_id: &str,
        answered: &Event,
    ) -> Option<(String, Event)> {
        let row = self.lane_row(lane_id)?;
        let mirrored = format!("{lane_id}.{call_id}");
        let closed = match answered {
            Event::Known(Known::QuestionAnswered {
                answers,
                late,
                typed,
                ..
            }) => Known::QuestionAnswered {
                call_id: mirrored.clone(),
                answers: answers.clone(),
                late: *late,
                typed: *typed,
            },
            Event::Known(Known::QuestionDeferred { by_bot, .. }) => Known::QuestionDeferred {
                call_id: mirrored.clone(),
                by_bot: *by_bot,
            },
            Event::Known(Known::QuestionDismissed { late, .. }) => Known::QuestionDismissed {
                call_id: mirrored.clone(),
                late: *late,
            },
            _ => return None,
        };
        let events = self.load(&row.parent).ok()?;
        spade_core::question::standing(events.iter(), &mirrored)?;
        Some((row.parent, Event::Known(closed)))
    }

    /// The lane's card `call_id` was answered (`answered`, as stored in the lane): main's copy
    /// closes the same way, stored there without opening a reply.
    pub(in super::super) fn close_in_main(&self, lane_id: &str, call_id: &str, answered: &Event) {
        let Some(row) = self.lane_row(lane_id) else {
            return;
        };
        let mirrored = format!("{lane_id}.{call_id}");
        let closed = match answered {
            Event::Known(Known::QuestionAnswered {
                answers,
                late,
                typed,
                ..
            }) => Known::QuestionAnswered {
                call_id: mirrored.clone(),
                answers: answers.clone(),
                late: *late,
                typed: *typed,
            },
            Event::Known(Known::QuestionDeferred { by_bot, .. }) => Known::QuestionDeferred {
                call_id: mirrored.clone(),
                by_bot: *by_bot,
            },
            Event::Known(Known::QuestionDismissed { late, .. }) => Known::QuestionDismissed {
                call_id: mirrored.clone(),
                late: *late,
            },
            _ => return,
        };
        let stored = {
            let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
            let Ok(events) = self.load(&row.parent) else {
                return;
            };
            let open = spade_core::question::standing(events.iter(), &mirrored);
            let still = matches!(
                (open, &closed),
                (Some(spade_core::question::Standing::Waiting), _)
                    | (
                        Some(spade_core::question::Standing::Deferred),
                        Known::QuestionAnswered { .. } | Known::QuestionDismissed { .. }
                    )
            );
            if !still {
                return;
            }
            self.append(&row.parent, &Event::Known(closed))
        };
        match stored {
            Ok(_) => self.announce(&row.parent),
            Err(error) => tracing::error!(%error, "could not close a task lane's question in main"),
        }
    }
}
