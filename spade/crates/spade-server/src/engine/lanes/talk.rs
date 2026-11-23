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
        // The person's own words for each ask go as theirs; main's words follow as the bot's.
        let mut words: Vec<String> = asks
            .iter()
            .filter_map(|id| ledger.ask(id).map(|a| a.words.clone()))
            .collect();
        words.push(format!(
            "<task_message from=\"bot\">\n{text}\n</task_message>"
        ));
        let message = Event::user_message(words.join("\n\n"));
        if let Err(error) = self.message_lane(&row, &message) {
            return ToolOutput::error(format!("Spade could not send it: {error}"));
        }
        if !asks.is_empty() {
            // The asks are the lane's now: main's ledger hands them over (ADR 0217 §2).
            let title = self.lane_title(&row.conversation);
            for ask in &asks {
                let routed = Event::Known(Known::AskRouted(Routed {
                    lane: row.conversation.clone(),
                    title: title.clone(),
                    message: ask.clone(),
                }));
                if let Err(error) = self.record(main, &routed) {
                    tracing::error!(%error, "could not record an ask sent to a task lane");
                }
            }
        }
        ToolOutput::ok(
            json!({ "task": row.conversation, "state": self.lane_state(&row.conversation).name() })
                .to_string(),
        )
    }

    /// Delivers `message` to the lane: it steers a running reply, opens a new one in an ended
    /// lane, and waits with the brief in a queued one.
    pub(in super::super) fn message_lane(
        self: &Arc<Self>,
        row: &StoredHelper,
        message: &Event,
    ) -> Result<(), StoreError> {
        let id = row.conversation.as_str();
        {
            let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
            if helper::stage(&self.load(id)?) == Stage::Queued {
                self.append(id, message)?;
                return Ok(());
            }
        }
        self.deliver(id, message)
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
        let stored = {
            let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
            let at = match self.load(main) {
                Ok(events) => events.len(),
                Err(error) => return Some(Err(error)),
            };
            let routed = Event::Known(Known::AskRouted(Routed {
                lane: lane_id.clone(),
                title,
                message: spade_core::chat_markup::id(at as u64 + 1, 0),
            }));
            // Together, so main never holds the message without saying where it went: it opens
            // no reply in main.
            self.append_events(main, &[message.clone(), routed])
        };
        if let Err(error) = stored {
            return Some(Err(error));
        }
        // The lane hears the person's own words, trusted (ADR 0217 §2), without the quote of
        // main's message that only made sense there.
        let mut own = message.clone();
        if let Event::Known(Known::UserMessage { reply_to, .. }) = &mut own {
            *reply_to = None;
        }
        Some(self.message_lane(&row, &own))
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
        if let Err(refused) = lane::stop_allowed(&events, &arguments.because) {
            return ToolOutput::error(refused);
        }
        self.stop_lane(&row.conversation);
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
            None => self.lanes_of(main),
        };
        let shown: Vec<Value> = rows
            .iter()
            .filter_map(|row| self.lane_view(row, true).ok())
            .collect();
        ToolOutput::ok(json!({ "tasks": shown }).to_string())
    }
}
