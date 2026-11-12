//! Bots on one machine talk (ADR 0127): `bot_message` delivers text into another agent's
//! conversation as a message from the caller, which wakes it, and waits for that agent's reply.
//! It runs as a background job, so the caller is never blocked and a restart reports it lost
//! like any job.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use spade_core::Event;
use spade_core::event::{FromAgent, Known};
use spade_store::Agent;
use tokio::sync::broadcast::error::RecvError;

use super::roster::{self, State};
use super::{Engine, Frame};
use crate::tools::ToolOutput;

/// The deepest chain of bot-to-bot messages allowed: the person asks Spade, Spade asks A, A asks
/// B, B asks C; C cannot ask further.
pub const MOST_HOPS: u32 = 3;

impl Engine {
    /// The other agents a bot can message: every agent but `caller` (Spade too, unless it is
    /// switched off on this machine).
    pub(crate) fn bots_for(&self, caller: &str) -> Result<Vec<Agent>, String> {
        let enabled = self.main_enabled().map_err(|e| e.to_string())?;
        Ok(self
            .store
            .agents()
            .map_err(|e| e.to_string())?
            .into_iter()
            .filter(|a| a.conversation != caller)
            .filter(|a| enabled || a.kind != super::agents::MAIN)
            .collect())
    }

    /// `bots_list` for the agent of `caller`.
    pub(crate) fn bots_list(&self, caller: &str) -> ToolOutput {
        let bots = match self.bots_for(caller) {
            Ok(bots) => bots,
            Err(error) => return ToolOutput::error(format!("Could not list the bots: {error}")),
        };
        let listed: Vec<Value> = bots
            .iter()
            .map(|bot| {
                let state = self
                    .activity(&bot.conversation)
                    .map_or(State::Idle, |a| a.state);
                json!({
                    "id": bot.id,
                    "name": bot.name,
                    "task": roster::plain(&bot.task, roster::PREVIEW),
                    "state": state.name(),
                })
            })
            .collect();
        if listed.is_empty() {
            return ToolOutput::ok("There are no other bots on this machine.");
        }
        ToolOutput::ok(Value::Array(listed).to_string())
    }

    /// The name of the bot `reference` (an id or exact name) points at, for status lines.
    pub(crate) fn bot_name(&self, caller: &str, reference: &str) -> Option<String> {
        self.find_bot(caller, reference).ok().map(|bot| bot.name)
    }

    fn find_bot(&self, caller: &str, reference: &str) -> Result<Agent, String> {
        let reference = reference.trim();
        if let Ok(Some(me)) = self.store.agent_for_conversation(caller)
            && (me.id == reference || me.name == reference)
        {
            return Err("A bot cannot message itself.".to_owned());
        }
        let bots = self.bots_for(caller)?;
        if let Some(bot) = bots.iter().find(|b| b.id == reference) {
            return Ok(bot.clone());
        }
        let named: Vec<&Agent> = bots.iter().filter(|b| b.name == reference).collect();
        match named.as_slice() {
            [one] => Ok((*one).clone()),
            [] => Err(format!(
                "There is no bot {reference:?} on this machine; bots_list shows them."
            )),
            _ => Err(format!(
                "More than one bot is named {reference:?}; use its id from bots_list."
            )),
        }
    }

    /// `bot_message` from the agent of conversation `caller`: delivers `text` to the bot and
    /// waits for its reply.
    pub(crate) async fn bot_message(
        self: &Arc<Self>,
        caller: &str,
        arguments: Value,
    ) -> ToolOutput {
        let bot = arguments.get("bot").and_then(Value::as_str).unwrap_or("");
        let text = arguments
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_owned();
        if text.is_empty() {
            return ToolOutput::error("The message is empty.");
        }
        if text.chars().count() > self.limits.longest_message {
            return ToolOutput::error("The message is too long.");
        }
        let me = match self.store.agent_for_conversation(caller) {
            Ok(Some(me)) => me,
            _ => return ToolOutput::error("Only an agent can message a bot."),
        };
        let target = match self.find_bot(caller, bot) {
            Ok(target) => target,
            Err(why) => return ToolOutput::error(why),
        };
        let depth = self.hops(caller) + 1;
        if depth > MOST_HOPS {
            return ToolOutput::error(format!(
                "Refused: this would be a chain of more than {MOST_HOPS} bot-to-bot messages. \
                 Answer with what you have."
            ));
        }
        let message = Event::Known(Known::UserMessage {
            text,
            context: None,
            images: Vec::new(),
            from_agent: Some(FromAgent {
                id: me.id.clone(),
                name: me.name.clone(),
                depth,
            }),
            from_routine: None,
        });
        // Subscribed first, so the reply cannot slip by between delivering and listening.
        let mut frames = self.live(&target.conversation).frames.subscribe();
        if let Err(error) = self.deliver(&target.conversation, &message) {
            return ToolOutput::error(format!("The message was not delivered: {error}"));
        }
        let Some(sent) = self.sent_at(&target.conversation, &message) else {
            return ToolOutput::error("The message was not delivered.");
        };
        loop {
            if let Some(answer) = self.answer_after(&target, sent) {
                return answer;
            }
            match tokio::time::timeout(Duration::from_secs(1), frames.recv()).await {
                Ok(Ok(Frame::Stored(_))) | Ok(Err(RecvError::Lagged(_))) | Err(_) => {}
                Ok(Ok(_)) => {}
                Ok(Err(RecvError::Closed)) => {
                    frames = self.live(&target.conversation).frames.subscribe();
                }
            }
        }
    }

    /// How many bot-to-bot hops led to the caller's current work: the depth of the latest
    /// message it was sent, 0 when that came from the person.
    fn hops(&self, caller: &str) -> u32 {
        let events = self.load(caller).unwrap_or_default();
        events
            .iter()
            .rev()
            .find_map(|event| match event {
                Event::Known(Known::UserMessage { from_agent, .. }) => {
                    Some(from_agent.as_ref().map_or(0, |f| f.depth))
                }
                _ => None,
            })
            .unwrap_or(0)
    }

    /// The seq of the latest copy of `message` in `conversation`.
    fn sent_at(&self, conversation: &str, message: &Event) -> Option<i64> {
        self.store
            .events(conversation, 0)
            .ok()?
            .iter()
            .rev()
            .find(|stored| &stored.event == message)
            .map(|stored| stored.seq)
    }

    /// The bot's answer: the first reply to end after the message, which saw it.
    fn answer_after(&self, target: &Agent, sent: i64) -> Option<ToolOutput> {
        let events = match self.store.events(&target.conversation, sent) {
            Ok(events) => events,
            Err(_) => return None,
        };
        if self.store.agent(&target.id).ok().flatten().is_none() {
            return Some(ToolOutput::error(format!(
                "{} was deleted before it answered.",
                target.name
            )));
        }
        let name = &target.name;
        events.iter().find_map(|stored| match &stored.event {
            Event::Known(Known::ReplyFinished { text, .. }) => {
                Some(ToolOutput::ok(format!("{name} answered:\n{text}")))
            }
            Event::Known(Known::ReplyStopped { text, .. }) => Some(ToolOutput::error(format!(
                "{name} was stopped before it finished. What it had said: {text}"
            ))),
            Event::Known(Known::ReplyFailed { error, .. }) => Some(ToolOutput::error(format!(
                "{name} could not answer: {error}"
            ))),
            Event::Known(Known::ReplyInterrupted { .. }) => Some(ToolOutput::error(format!(
                "{name} was cut off by a restart before it answered; ask again if it matters."
            ))),
            _ => None,
        })
    }
}
