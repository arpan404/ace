//! `notify {title, body}` (ADR 0200 §4.2): a bot's own notice to the person. It goes through the
//! same reach as every notice (ADR 0195, `reach`): do not disturb, quiet hours, the interruption
//! budget and the bot's own switch decide it, the bot's rate holds the rest for the brief, and
//! what waits goes into the next brief and digest. The decision is stored in the bot's
//! conversation as `notice_sent`, so the chat shows it and a call run again after a restart
//! reads the same answer without sending twice.

use std::sync::Arc;

use serde_json::json;
use spade_core::event::{Event, Known};
use spade_core::reach::notice::{self, Notice};
use spade_core::reach::{Category, Decision};

use super::Engine;
use super::reach::Outgoing;
use crate::tools::ToolOutput;

impl Engine {
    /// Runs `notify` for call `call_id` in `conversation`.
    pub(crate) fn notify_call(
        self: &Arc<Self>,
        conversation: &str,
        call_id: &str,
        arguments: &serde_json::Value,
    ) -> ToolOutput {
        if self.is_helper(conversation) {
            return ToolOutput::error(
                "A helper can't notify the person. Hand back what you found; the bot that started \
                 you decides what to tell them.",
            );
        }
        let events = match self.load(conversation) {
            Ok(events) => events,
            Err(error) => return ToolOutput::error(error.to_string()),
        };
        // Run again after a restart: what was decided is the answer, and nothing is sent twice.
        if let Some(said) = decided_in(&events, call_id) {
            return ToolOutput::ok(said);
        }
        let notice = match notice::parse(arguments) {
            Ok(notice) => notice,
            Err(why) => return ToolOutput::error(why),
        };
        let agent = match self.store.agent_for_conversation(conversation) {
            Ok(Some(agent)) => agent,
            Ok(None) => return ToolOutput::error("Only a bot can notify the person."),
            Err(error) => return ToolOutput::error(error.to_string()),
        };
        let id = format!("notice:{conversation}:{call_id}");
        let now = self.now_ms();
        let text = notice.text();
        let outgoing = Outgoing {
            notice: json!({
                "kind": "notice", "agent": agent.id, "name": agent.name,
                "conversation": conversation, "at": now, "text": text,
                "title": notice.title, "body": notice.body,
            }),
            id: id.clone(),
            agent: agent.id.clone(),
            name: agent.name.clone(),
            category: Category::Notice,
            level: None,
            engaged: false,
            text,
        };
        let decided = match self.reach_out_for_bot(outgoing) {
            Ok(Some(decided)) => decided,
            Ok(None) => return ToolOutput::error(notice::refused_for_the_day()),
            Err(error) => return ToolOutput::error(error.to_string()),
        };
        let event = sent(call_id, id, notice, decided);
        {
            let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
            if let Err(error) = self.append(conversation, &event) {
                return ToolOutput::error(error.to_string());
            }
        }
        self.announce(conversation);
        ToolOutput::ok(notice::result(decided))
    }
}

fn sent(call_id: &str, id: String, notice: Notice, decided: Decision) -> Event {
    Event::Known(Known::NoticeSent {
        call_id: call_id.to_owned(),
        id,
        title: notice.title,
        body: notice.body,
        reach: decided.reach,
        why: decided.why,
    })
}

/// What call `call_id` already decided, as the bot read it.
fn decided_in(events: &[Event], call_id: &str) -> Option<String> {
    events.iter().rev().find_map(|event| match event {
        Event::Known(Known::NoticeSent {
            call_id: c,
            reach,
            why,
            ..
        }) if c == call_id => Some(notice::result(Decision {
            reach: *reach,
            why: *why,
            counts: false,
        })),
        _ => None,
    })
}
