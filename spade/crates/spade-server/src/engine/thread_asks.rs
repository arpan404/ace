//! Asks from the person's ace threads (ADR 0198): the person mentioned a bot or a club in a
//! thread, and ace's daemon delivers their words here once, by its key, with the thread's context
//! pack, then reads the answers back by that key. The words are the person's; the pack is agents'
//! words and tool output, so a turn it comes with is untrusted. The bot works under its own gate.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use spade_core::event::{FromThread, GroupBot, Known};
use spade_core::{Event, group};
use spade_store::{Delivered, Delivery, InboxEntry};

use super::Engine;
use super::groups::GroupError;
use super::inbox::InboxAnswer;
use super::roster::State;
use crate::teams::Outcome;

/// The sender every thread ask is stored under; no paired machine's device id looks like it.
pub const FROM_ACE: &str = "ace:thread";
/// The longest a read of an answer waits.
const LONGEST_WAIT_MS: u64 = 25_000;
/// The longest context pack, in characters.
const LONGEST_PACK: usize = 16_000;
/// How long a stored key is kept: a retry never comes later than this.
const KEEP_KEYS_MS: i64 = 30 * 24 * 60 * 60_000;
/// How many asks a day ace may deliver; a guard against a runaway client, not a quota.
const MOST_PER_DAY: usize = 2_000;

fn refuse(status: u16, error: &str) -> InboxAnswer {
    (status, json!({ "error": error }))
}

fn valid_key(key: &str) -> bool {
    (1..=160).contains(&key.len())
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | ':' | '-'))
}

fn one_line(value: &Value, most: usize) -> String {
    let text = value.as_str().unwrap_or("");
    let line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    line.chars().take(most).collect()
}

fn bot_json(id: &str, name: &str, avatar: Option<&str>) -> Value {
    json!({
        "id": id,
        "name": name,
        "avatar": spade_core::face::shown_avatar(id, avatar.unwrap_or("")),
    })
}

impl Engine {
    /// `POST /v1/thread-asks`: delivers the person's words to a bot or a club, once by key.
    pub fn thread_ask(self: &Arc<Self>, body: &Value) -> InboxAnswer {
        let key = body["key"].as_str().unwrap_or("");
        if !valid_key(key) {
            return refuse(400, "a key is 1 to 160 of A-Za-z0-9_.:-");
        }
        if self.store.inbox(FROM_ACE, key).ok().flatten().is_some() {
            return (200, json!({ "status": "duplicate" }));
        }
        let text = body["text"].as_str().unwrap_or("").trim();
        if text.is_empty() || text.chars().count() > self.limits.longest_message {
            return refuse(400, "the message is empty or too long");
        }
        let thread_id = one_line(&body["thread"]["id"], 128);
        if thread_id.is_empty() {
            return refuse(400, "an ask names the ace thread it comes from");
        }
        let pack = body["context"]
            .as_str()
            .map(|pack| pack.chars().take(LONGEST_PACK).collect::<String>())
            .filter(|pack| !pack.trim().is_empty());
        let from = FromThread {
            id: thread_id,
            title: one_line(&body["thread"]["title"], 200),
            untrusted: pack.is_some(),
        };
        let now = self.now_ms();
        let _ = self.store.prune_inbox(now - KEEP_KEYS_MS);
        let id = body["to"]["id"].as_str().unwrap_or("");
        match body["to"]["kind"].as_str() {
            Some("bot") => self.thread_ask_bot(key, id, text, pack, from, now),
            Some("club") => self.thread_ask_club(key, id, text, pack, from, now),
            _ => refuse(400, "an ask goes to a bot or a club"),
        }
    }

    fn thread_ask_bot(
        self: &Arc<Self>,
        key: &str,
        id: &str,
        text: &str,
        pack: Option<String>,
        from: FromThread,
        now: i64,
    ) -> InboxAnswer {
        let agent = match self.bots_for("") {
            Ok(bots) => bots.into_iter().find(|b| b.id == id),
            Err(error) => return refuse(500, &error),
        };
        let Some(agent) = agent else {
            return refuse(404, "That bot isn't on this machine's Spade.");
        };
        let message = Event::Known(Known::UserMessage {
            text: text.to_owned(),
            context: pack,
            images: Vec::new(),
            documents: Vec::new(),
            voice: None,
            from_agent: None,
            from_routine: None,
            from_group: None,
            from_thread: Some(Box::new(from)),
        });
        let entry = InboxEntry {
            from_host: FROM_ACE.to_owned(),
            key: key.to_owned(),
            from_name: "ace".to_owned(),
            agent_id: agent.id.clone(),
            conversation: agent.conversation.clone(),
            seq: 0,
        };
        let delivery = Delivery {
            ask: &entry,
            since_ms: now - 24 * 60 * 60_000,
            most: MOST_PER_DAY,
        };
        match self.deliver_as(&agent.conversation, &message, Some(delivery)) {
            Ok(Delivered::Stored(_)) => (200, json!({ "status": "accepted" })),
            Ok(Delivered::Duplicate) => (200, json!({ "status": "duplicate" })),
            Ok(Delivered::OverLimit) => refuse(429, "too many asks from ace today"),
            Err(error) => refuse(409, &format!("not delivered: {error}")),
        }
    }

    fn thread_ask_club(
        self: &Arc<Self>,
        key: &str,
        id: &str,
        text: &str,
        pack: Option<String>,
        from: FromThread,
        now: i64,
    ) -> InboxAnswer {
        let Ok(Some(group)) = self.store.group(id) else {
            return refuse(404, "That club isn't on this machine's Spade.");
        };
        let entry = InboxEntry {
            from_host: FROM_ACE.to_owned(),
            key: key.to_owned(),
            from_name: "ace".to_owned(),
            agent_id: group.id.clone(),
            conversation: group.conversation.clone(),
            seq: 0,
        };
        let delivery = Delivery {
            ask: &entry,
            since_ms: now - 24 * 60 * 60_000,
            most: MOST_PER_DAY,
        };
        match self.post_group_as(id, text, Some((from, pack)), Some(delivery)) {
            Ok(Some(_)) => (200, json!({ "status": "accepted" })),
            Ok(None) => (200, json!({ "status": "duplicate" })),
            Err(GroupError::NotFound) => refuse(404, "That club isn't on this machine's Spade."),
            Err(GroupError::Invalid(why) | GroupError::Conflict(why)) => refuse(409, &why),
            Err(error) => refuse(500, &error.to_string()),
        }
    }

    /// `GET /v1/thread-asks/{key}`: where the ask stands, its replies so far, the reply being
    /// written and who is working or waiting for the person. Waits up to `wait_ms` for a change.
    pub async fn thread_answer(&self, key: &str, wait_ms: u64) -> InboxAnswer {
        let Ok(Some(entry)) = self.store.inbox(FROM_ACE, key) else {
            return (200, json!({ "status": "unknown" }));
        };
        let before = self.thread_view(&entry);
        let wait = wait_ms.min(LONGEST_WAIT_MS);
        if wait == 0 || before["status"] != "pending" {
            return (200, before);
        }
        let mut frames = self.live(&entry.conversation).frames.subscribe();
        let deadline = tokio::time::Instant::now() + Duration::from_millis(wait);
        loop {
            // Each frame may change it (a reply, a status, a member's turn); a quiet second is
            // read again too, so a member's own conversation is never missed.
            let _ = tokio::time::timeout_at(
                deadline.min(tokio::time::Instant::now() + Duration::from_secs(1)),
                frames.recv(),
            )
            .await;
            let now = self.thread_view(&entry);
            if now != before || tokio::time::Instant::now() >= deadline {
                return (200, now);
            }
        }
    }

    fn thread_view(&self, entry: &InboxEntry) -> Value {
        match self.store.agent(&entry.agent_id) {
            Ok(Some(agent)) => self.bot_view(&agent, entry.seq),
            _ => self.club_view(entry),
        }
    }

    fn bot_view(&self, agent: &spade_store::Agent, seq: i64) -> Value {
        let me = bot_json(&agent.id, &agent.name, Some(&agent.avatar));
        let named = json!({ "id": agent.id, "name": agent.name });
        match self.reply_after(agent, seq) {
            Some(Outcome::Answered(text)) => {
                json!({ "status": "answered", "replies": [{ "bot": me, "text": text }] })
            }
            Some(Outcome::Stopped(text)) => {
                json!({ "status": "stopped", "replies": [], "text": text })
            }
            Some(other) => json!({ "status": "failed", "replies": [], "text": other.text() }),
            None => {
                let activity = self.activity(&agent.conversation).ok();
                let waiting = activity.as_ref().is_some_and(|a| a.state == State::Waiting);
                let writing = self
                    .live(&agent.conversation)
                    .current
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .as_ref()
                    .map(|snapshot| snapshot.text.clone())
                    .filter(|text| !text.trim().is_empty());
                json!({
                    "status": "pending",
                    "replies": [],
                    "writing": writing.map_or_else(Vec::new, |text| vec![json!({ "bot": me, "text": text })]),
                    "answering": if waiting { vec![] } else { vec![json!({
                        "id": agent.id,
                        "name": agent.name,
                        "status": activity.as_ref().and_then(|a| self.status_for(&agent.conversation, a)),
                    })] },
                    "waiting": if waiting { vec![named] } else { vec![] },
                })
            }
        }
    }

    fn club_view(&self, entry: &InboxEntry) -> Value {
        let Ok(Some(club)) = self.store.group(&entry.agent_id) else {
            return json!({ "status": "failed", "replies": [], "text": "The club was deleted." });
        };
        let events = self.load(&club.conversation).unwrap_or_default();
        let run = self
            .store
            .events(&club.conversation, entry.seq - 1)
            .ok()
            .and_then(|stored| {
                stored.into_iter().find_map(|stored| match stored.event {
                    Event::Known(Known::GroupMessage {
                        run, from: None, ..
                    }) => Some(run),
                    _ => None,
                })
            });
        let Some(run) = run else {
            return json!({ "status": "unknown" });
        };
        let view = group::run_view(&events, &run);
        let face = |bot: &GroupBot| {
            let avatar = club
                .members
                .iter()
                .find(|m| m.agent_id == bot.id)
                .and_then(|m| m.avatar.clone());
            bot_json(&bot.id, &bot.name, avatar.as_deref())
        };
        let replies: Vec<Value> = view
            .replies
            .iter()
            .map(|(bot, text)| json!({ "bot": face(bot), "text": text }))
            .collect();
        let answering: Vec<Value> = view
            .open
            .iter()
            .map(|open| json!({ "id": open.to.id, "name": open.to.name }))
            .collect();
        let status = if view.stopped {
            "stopped"
        } else if !view.open.is_empty() || !view.asked {
            "pending"
        } else if replies.is_empty() && !view.failures.is_empty() {
            "failed"
        } else {
            "answered"
        };
        let waiting = self
            .activity(&club.conversation)
            .ok()
            .is_some_and(|a| a.state == State::Waiting);
        json!({
            "status": status,
            "replies": replies,
            "answering": if waiting { vec![] } else { answering.clone() },
            "waiting": if waiting { answering } else { vec![] },
            "text": view.failures.first(),
        })
    }

    /// `POST /v1/thread-asks/{key}/stop`.
    pub fn thread_stop(self: &Arc<Self>, key: &str) -> InboxAnswer {
        let Ok(Some(entry)) = self.store.inbox(FROM_ACE, key) else {
            return (200, json!({ "status": "unknown" }));
        };
        if let Ok(Some(agent)) = self.store.agent(&entry.agent_id) {
            if self.reply_after(&agent, entry.seq).is_some() {
                return (200, json!({ "status": "not_running" }));
            }
            return match self.stop(&agent.conversation) {
                Ok(true) => (200, json!({ "status": "stopped" })),
                Ok(false) => (200, json!({ "status": "not_running" })),
                Err(error) => refuse(500, &error.to_string()),
            };
        }
        match self.stop_group(&entry.agent_id) {
            Ok(()) => (200, json!({ "status": "stopped" })),
            Err(_) => (200, json!({ "status": "not_running" })),
        }
    }
}
