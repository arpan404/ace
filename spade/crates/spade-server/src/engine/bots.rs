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
use crate::teams::Outcome;
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

    /// `bots_list` for the agent of `caller`: this machine's bots, then each linked machine's
    /// whose Spade answers (ADR 0132).
    pub(crate) async fn bots_list(&self, caller: &str) -> ToolOutput {
        let bots = match self.bots_for(caller) {
            Ok(bots) => bots,
            Err(error) => return ToolOutput::error(format!("Could not list the bots: {error}")),
        };
        let mut listed: Vec<Value> = bots
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
                    "machine": Value::Null,
                })
            })
            .collect();
        for machine in self.machines().await.unwrap_or_default() {
            if !machine.online {
                continue;
            }
            for bot in self.remote_bots(&machine.host_id).await.unwrap_or_default() {
                listed.push(json!({
                    "id": bot["id"],
                    "name": bot["name"],
                    "task": bot["task"],
                    "state": bot["state"],
                    "machine": machine.name,
                }));
            }
        }
        if listed.is_empty() {
            return ToolOutput::ok(
                "There are no other bots on this machine or your other machines.",
            );
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
        key: &str,
        arguments: Value,
    ) -> ToolOutput {
        if let Some(machine) = arguments
            .get("machine")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|m| !m.is_empty())
        {
            return self
                .bot_message_elsewhere(caller, key, machine, &arguments)
                .await;
        }
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
            documents: Vec::new(),
            voice: None,
            from_agent: Some(FromAgent {
                id: me.id.clone(),
                name: me.name.clone(),
                depth,
                machine: None,
            }),
            from_routine: None,
            from_group: None,
        });
        // Subscribed first, so the reply cannot slip by between delivering and listening.
        let frames = self.live(&target.conversation).frames.subscribe();
        if let Err(error) = self.deliver(&target.conversation, &message) {
            return ToolOutput::error(format!("The message was not delivered: {error}"));
        }
        let Some(sent) = self.sent_at(&target.conversation, &message) else {
            return ToolOutput::error("The message was not delivered.");
        };
        let name = &target.name;
        match self.wait_reply(&target, sent, frames).await {
            Outcome::Answered(text) => ToolOutput::ok(format!("{name} answered:\n{text}")),
            other => ToolOutput::error(other.text().to_owned()),
        }
    }

    /// Waits for `target`'s first reply to end after `sent` (the seq of the message it answers).
    /// `frames` was subscribed before the message was stored, so nothing slips by.
    pub(crate) async fn wait_reply(
        &self,
        target: &Agent,
        sent: i64,
        mut frames: tokio::sync::broadcast::Receiver<Frame>,
    ) -> Outcome {
        loop {
            if let Some(answer) = self.reply_after(target, sent) {
                return answer;
            }
            match tokio::time::timeout(Duration::from_secs(1), frames.recv()).await {
                Ok(Ok(_)) | Ok(Err(RecvError::Lagged(_))) | Err(_) => {}
                Ok(Err(RecvError::Closed)) => {
                    frames = self.live(&target.conversation).frames.subscribe();
                }
            }
        }
    }

    /// `bot_message` to a bot of another machine: sent through the outbox, so it is delivered
    /// once (the call's key is the ask's key) and waits while that machine is away.
    async fn bot_message_elsewhere(
        self: &Arc<Self>,
        caller: &str,
        key: &str,
        machine: &str,
        arguments: &Value,
    ) -> ToolOutput {
        let bot = arguments
            .get("bot")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        let text = arguments
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        if text.is_empty() {
            return ToolOutput::error("The message is empty.");
        }
        let Ok(Some(me)) = self.store.agent_for_conversation(caller) else {
            return ToolOutput::error("Only an agent can message a bot.");
        };
        let depth = self.hops(caller) + 1;
        if depth > MOST_HOPS {
            return ToolOutput::error(format!(
                "Refused: this would be a chain of more than {MOST_HOPS} bot-to-bot messages. \
                 Answer with what you have."
            ));
        }
        let machines = match self.machines().await {
            Ok(machines) => machines,
            Err(error) => return ToolOutput::error(format!("Could not reach ace: {error}")),
        };
        let Some(target) = machines
            .iter()
            .find(|m| m.host_id == machine || m.name.eq_ignore_ascii_case(machine))
        else {
            return ToolOutput::error(format!(
                "There is no linked machine {machine:?}; bots_list shows the machines."
            ));
        };
        // A bot's name is read from its machine while it answers; an id works offline too.
        let to = match self.remote_bots(&target.host_id).await {
            Ok(bots) => {
                let named: Vec<&Value> = bots
                    .iter()
                    .filter(|b| b["id"] == bot || b["name"] == bot)
                    .collect();
                match named.as_slice() {
                    [one] => one["id"].as_str().unwrap_or(bot).to_owned(),
                    [] => {
                        return ToolOutput::error(format!(
                            "There is no bot {bot:?} on {}; bots_list shows them.",
                            target.name
                        ));
                    }
                    _ => {
                        return ToolOutput::error(format!(
                            "More than one bot is named {bot:?} there; use its id."
                        ));
                    }
                }
            }
            Err(_) => bot.to_owned(),
        };
        let ask = format!(
            "bm.{}",
            key.replace(
                |c: char| !c.is_ascii_alphanumeric() && c != '.' && c != '_' && c != '-',
                "_"
            )
        );
        let request = json!({
            "op": "ask",
            "key": ask,
            "to": to,
            "text": text,
            "from": { "id": me.id, "name": me.name },
            "depth": depth,
        });
        if let Err(error) = self.send_remote(&ask, &target.host_id, &target.name, request) {
            return ToolOutput::error(format!("The message was not stored: {error}"));
        }
        match self.wait_remote(&ask, |_| {}).await {
            Outcome::Answered(text) => {
                ToolOutput::ok(format!("{bot} on {} answered:\n{text}", target.name))
            }
            other => ToolOutput::error(other.text().to_owned()),
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
    pub(crate) fn reply_after(&self, target: &Agent, sent: i64) -> Option<Outcome> {
        let events = match self.store.events(&target.conversation, sent) {
            Ok(events) => events,
            Err(_) => return None,
        };
        if self.store.agent(&target.id).ok().flatten().is_none() {
            return Some(Outcome::Failed(format!(
                "{} was deleted before it answered.",
                target.name
            )));
        }
        let name = &target.name;
        events.iter().find_map(|stored| match &stored.event {
            Event::Known(Known::ReplyFinished { text, .. }) => {
                Some(Outcome::Answered(text.clone()))
            }
            Event::Known(Known::ReplyStopped { text, .. }) => Some(Outcome::Stopped(format!(
                "{name} was stopped before it finished. What it had said: {text}"
            ))),
            Event::Known(Known::ReplyFailed { error, .. }) => {
                Some(Outcome::Failed(format!("{name} could not answer: {error}")))
            }
            Event::Known(Known::ReplyInterrupted { .. }) => Some(Outcome::Failed(format!(
                "{name} was cut off by a restart before it answered; ask again if it matters."
            ))),
            _ => None,
        })
    }
}
