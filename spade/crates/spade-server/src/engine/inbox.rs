//! Asks from the person's other machines (ADR 0132), as their daemons forward them: list this
//! machine's bots, deliver an ask once by its key, read its answer, stop it. The daemon stamps
//! which machine sent each request; the API refuses one without that stamp.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use spade_core::Event;
use spade_core::event::{FromAgent, FromGroup, Known};
use spade_store::{Delivered, Delivery, InboxEntry};

use super::Engine;
use super::bots::MOST_HOPS;
use super::roster::{self, State};
use crate::teams::Outcome;

/// The longest an `answer` request waits.
const LONGEST_WAIT_MS: u64 = 25_000;
/// The longest context a group ask may carry, in characters.
const LONGEST_CONTEXT: usize = 16_000;
const DAY_MS: i64 = 24 * 60 * 60_000;
/// Delivered keys are kept this long: a retry is never that late (the sender gives up at 7 days).
const KEEP_KEYS_MS: i64 = 30 * DAY_MS;

/// `value` as one short line, at most `most` characters.
fn short(value: Option<&Value>, most: usize, otherwise: &str) -> String {
    let text = value.and_then(Value::as_str).unwrap_or(otherwise);
    let line: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let line: String = line.chars().take(most).collect();
    if line.is_empty() {
        otherwise.to_owned()
    } else {
        line
    }
}

/// The machine a request came from, as its daemon stamped it.
#[derive(Debug, Clone)]
pub struct Sender {
    pub host: String,
    pub name: String,
}

/// An inbox answer: an HTTP status and its JSON body.
pub type InboxAnswer = (u16, Value);

fn refuse(status: u16, error: &str) -> InboxAnswer {
    (status, json!({ "error": error }))
}

fn valid_key(key: &str) -> bool {
    (1..=160).contains(&key.len())
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | ':' | '-'))
}

impl Engine {
    /// One inbox request from `sender`.
    pub async fn inbox(self: &Arc<Self>, sender: &Sender, body: &Value) -> InboxAnswer {
        match body["op"].as_str() {
            Some("bots") => self.inbox_bots(),
            Some("ask") => self.inbox_ask(sender, body),
            Some("answer") => self.inbox_answer(sender, body).await,
            Some("stop") => self.inbox_stop(sender, body),
            _ => refuse(400, "unknown op"),
        }
    }

    fn inbox_bots(&self) -> InboxAnswer {
        let bots = match self.bots_for("") {
            Ok(bots) => bots,
            Err(error) => return refuse(500, &error),
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
                    "avatar": serde_json::from_str::<Value>(&bot.avatar).unwrap_or(Value::Null),
                })
            })
            .collect();
        (200, json!({ "bots": listed }))
    }

    fn inbox_ask(self: &Arc<Self>, sender: &Sender, body: &Value) -> InboxAnswer {
        let key = body["key"].as_str().unwrap_or("");
        if !valid_key(key) {
            return refuse(400, "a key is 1 to 160 of A-Za-z0-9_.:-");
        }
        if self.store.inbox(&sender.host, key).ok().flatten().is_some() {
            return (200, json!({ "status": "duplicate" }));
        }
        let text = body["text"].as_str().unwrap_or("").trim();
        if text.is_empty() || text.chars().count() > self.limits.longest_message {
            return refuse(400, "the message is empty or too long");
        }
        let now = self.now_ms();
        let _ = self.store.prune_inbox(now - KEEP_KEYS_MS);
        // Words from another machine are never the person's own here: an ask names the bot that
        // sent it or the group it came through.
        if !body["from"].is_object() && !body["group"].is_object() {
            return refuse(400, "an ask names the bot or the group it comes from");
        }
        let depth = body["depth"]
            .as_u64()
            .unwrap_or(1)
            .clamp(1, u64::from(MOST_HOPS) + 1) as u32;
        if depth > MOST_HOPS {
            return refuse(
                409,
                &format!("Refused: a chain of more than {MOST_HOPS} bot-to-bot messages."),
            );
        }
        let to = body["to"].as_str().unwrap_or("");
        let agent = match self.bots_for("") {
            Ok(bots) => bots.into_iter().find(|b| b.id == to),
            Err(error) => return refuse(500, &error),
        };
        let Some(agent) = agent else {
            return refuse(404, "no such bot on this machine");
        };
        // A bot at its own cap starts nothing (ADR 0135): the asking machine hears why.
        if let Some(why) = self.cap_refusal(&agent.conversation) {
            return refuse(402, &why);
        }
        let from_agent = body["from"].as_object().map(|from| FromAgent {
            id: short(from.get("id"), 128, "bot"),
            name: short(from.get("name"), crate::engine::NAME_CHARS, "A bot"),
            depth,
            machine: Some(sender.name.clone()),
        });
        let context = body["context"]
            .as_str()
            .map(|c| c.chars().take(LONGEST_CONTEXT).collect::<String>());
        let from_group = body["group"].as_object().map(|group| {
            Box::new(FromGroup {
                id: short(group.get("id"), 128, "group"),
                name: short(
                    group.get("name"),
                    crate::engine::GROUP_NAME_CHARS,
                    "a group",
                ),
                run: short(group.get("run"), 128, "run"),
                ask: key.to_owned(),
                machine: Some(sender.name.clone()),
                // What came from another machine's group is not the person's own words here.
                untrusted: true,
            })
        });
        let message = Event::Known(Known::UserMessage {
            text: text.to_owned(),
            context,
            images: Vec::new(),
            documents: Vec::new(),
            voice: None,
            from_agent,
            from_routine: None,
            from_group,
        });
        let entry = InboxEntry {
            from_host: sender.host.clone(),
            key: key.to_owned(),
            from_name: sender.name.clone(),
            agent_id: agent.id.clone(),
            conversation: agent.conversation.clone(),
            seq: 0,
        };
        // The day's count is checked in the transaction that stores the ask, so concurrent asks
        // can't overshoot it.
        let delivery = Delivery {
            ask: &entry,
            since_ms: now - DAY_MS,
            most: self.limits.remote_asks_per_day,
        };
        match self.deliver_as(&agent.conversation, &message, Some(delivery)) {
            Ok(Delivered::Stored(_)) => (200, json!({ "status": "accepted" })),
            Ok(Delivered::Duplicate) => (200, json!({ "status": "duplicate" })),
            Ok(Delivered::OverLimit) => refuse(
                429,
                "that machine sent too many asks today; try again tomorrow",
            ),
            Err(error) => refuse(409, &format!("not delivered: {error}")),
        }
    }

    async fn inbox_answer(&self, sender: &Sender, body: &Value) -> InboxAnswer {
        let key = body["key"].as_str().unwrap_or("");
        let Ok(Some(entry)) = self.store.inbox(&sender.host, key) else {
            return (200, json!({ "status": "unknown" }));
        };
        let wait = body["wait_ms"].as_u64().unwrap_or(0).min(LONGEST_WAIT_MS);
        let Ok(Some(agent)) = self.store.agent(&entry.agent_id) else {
            return (
                200,
                json!({ "status": "failed", "text": "The bot was deleted." }),
            );
        };
        let frames = self.live(&agent.conversation).frames.subscribe();
        let reply = self.wait_reply(&agent, entry.seq, frames);
        let outcome = if wait == 0 {
            self.reply_after(&agent, entry.seq)
        } else {
            tokio::time::timeout(Duration::from_millis(wait), reply)
                .await
                .ok()
        };
        match outcome {
            None => (200, json!({ "status": "pending" })),
            Some(Outcome::Answered(text)) => (200, json!({ "status": "answered", "text": text })),
            Some(Outcome::Stopped(text)) => (200, json!({ "status": "stopped", "text": text })),
            Some(other) => (200, json!({ "status": "failed", "text": other.text() })),
        }
    }

    fn inbox_stop(self: &Arc<Self>, sender: &Sender, body: &Value) -> InboxAnswer {
        let key = body["key"].as_str().unwrap_or("");
        let Ok(Some(entry)) = self.store.inbox(&sender.host, key) else {
            return (200, json!({ "status": "unknown" }));
        };
        let Ok(Some(agent)) = self.store.agent(&entry.agent_id) else {
            return (200, json!({ "status": "not_running" }));
        };
        if self.reply_after(&agent, entry.seq).is_some() {
            return (200, json!({ "status": "not_running" }));
        }
        match self.stop(&agent.conversation) {
            Ok(true) => (200, json!({ "status": "stopped" })),
            Ok(false) => (200, json!({ "status": "not_running" })),
            Err(error) => refuse(500, &error.to_string()),
        }
    }
}
