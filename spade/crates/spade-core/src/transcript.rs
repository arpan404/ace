//! Folds a conversation's events into what a person reads: messages, the open reply and the
//! title.

use crate::event::{Event, Known, ReplyEnd};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Speaker {
    Person,
    Spade,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// Still arriving.
    Answering,
    Finished,
    Stopped,
    Failed(String),
    Interrupted,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Message {
    pub speaker: Speaker,
    pub text: String,
    /// Set for Spade's replies.
    pub reply: Option<String>,
    pub outcome: Outcome,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Transcript {
    pub messages: Vec<Message>,
    pub title: Option<String>,
    /// Tool calls of the open reply that are running now.
    pub running: Vec<String>,
    /// Tool calls of the open reply waiting for the person's approval.
    pub awaiting: Vec<String>,
    /// Tools the person allowed "always" in this conversation.
    pub always_allowed: Vec<String>,
    /// Which tool each approval asked about, by call id.
    asked: Vec<(String, String)>,
}

/// What the open reply is doing, for status and restart recovery.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnState {
    /// Streaming from the model or about to call it.
    Answering,
    /// Running one or more tools.
    RunningTools,
    /// Stopped until the person answers an approval.
    WaitingOnYou,
}

impl Transcript {
    pub fn fold<'a>(events: impl IntoIterator<Item = &'a Event>) -> Self {
        let mut transcript = Self::default();
        for event in events {
            transcript.apply(event);
        }
        transcript
    }

    pub fn apply(&mut self, event: &Event) {
        let Event::Known(event) = event else { return };
        match event {
            Known::UserMessage { text, .. } => self.messages.push(Message {
                speaker: Speaker::Person,
                text: text.clone(),
                reply: None,
                outcome: Outcome::Finished,
            }),
            Known::ReplyStarted { reply, .. } => self.messages.push(Message {
                speaker: Speaker::Spade,
                text: String::new(),
                reply: Some(reply.clone()),
                outcome: Outcome::Answering,
            }),
            Known::ReplyProgress { reply, text } => self.update(reply, text, None),
            Known::ReplyFinished { reply, text, .. } => {
                self.update(reply, text, Some(Outcome::Finished));
            }
            Known::ReplyStopped { reply, text } => {
                self.update(reply, text, Some(Outcome::Stopped));
            }
            Known::ReplyFailed { reply, text, error } => {
                self.update(reply, text, Some(Outcome::Failed(error.clone())));
            }
            Known::ReplyInterrupted { reply, text } => {
                self.update(reply, text, Some(Outcome::Interrupted));
            }
            Known::Renamed { title } => self.title = Some(title.clone()),
            Known::StepFinished { reply, text, .. } if !text.is_empty() => {
                self.update(reply, text, None);
            }
            Known::ToolStarted { call_id, .. } => self.running.push(call_id.clone()),
            Known::ToolFinished { call_id, .. } => self.running.retain(|id| id != call_id),
            Known::ApprovalRequested { call_id, name, .. } => {
                self.awaiting.push(call_id.clone());
                self.asked.push((call_id.clone(), name.clone()));
            }
            Known::ApprovalAnswered {
                call_id,
                allowed,
                always,
                ..
            } => {
                self.awaiting.retain(|id| id != call_id);
                let tool = self
                    .asked
                    .iter()
                    .find(|(id, _)| id == call_id)
                    .map(|(_, name)| name.clone());
                if let (true, true, Some(tool)) = (*allowed, *always, tool)
                    && !self.always_allowed.contains(&tool)
                {
                    self.always_allowed.push(tool);
                }
            }
            Known::StepFinished { .. }
            | Known::SkillsIndexed { .. }
            | Known::ContextCompacted { .. } => {}
        }
        if self.open_reply().is_none() {
            self.running.clear();
            self.awaiting.clear();
        }
    }

    fn update(&mut self, reply: &str, text: &str, outcome: Option<Outcome>) {
        let found = self
            .messages
            .iter_mut()
            .rev()
            .find(|m| m.reply.as_deref() == Some(reply) && m.outcome == Outcome::Answering);
        if let Some(message) = found {
            message.text = text.to_owned();
            if let Some(outcome) = outcome {
                message.outcome = outcome;
            }
        }
    }

    /// The reply still arriving, if any.
    pub fn open_reply(&self) -> Option<&Message> {
        self.messages
            .iter()
            .rev()
            .find(|m| m.outcome == Outcome::Answering)
    }

    /// What the open reply is doing, if there is one.
    pub fn turn_state(&self) -> Option<TurnState> {
        self.open_reply()?;
        Some(if !self.running.is_empty() {
            TurnState::RunningTools
        } else if !self.awaiting.is_empty() {
            TurnState::WaitingOnYou
        } else {
            TurnState::Answering
        })
    }

    /// The event that closes the open reply after a restart, keeping its last checkpoint. A reply
    /// only waiting for the person's approval stays open: the approval survives the restart.
    pub fn close_after_restart(&self) -> Option<Event> {
        if self.turn_state() == Some(TurnState::WaitingOnYou) {
            return None;
        }
        let open = self.open_reply()?;
        let reply = open.reply.clone()?;
        Some(Event::reply_ended(
            ReplyEnd::Interrupted,
            reply,
            open.text.clone(),
        ))
    }

    /// The first thing the person wrote.
    pub fn first_message(&self) -> Option<&str> {
        self.messages
            .iter()
            .find(|m| m.speaker == Speaker::Person)
            .map(|m| m.text.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn finished(reply: &str, text: &str) -> Event {
        Event::Known(Known::ReplyFinished {
            reply: reply.into(),
            text: text.into(),
            input_tokens: None,
            output_tokens: None,
            cost_micros: 0,
        })
    }

    #[test]
    fn a_finished_exchange_reads_as_two_messages() {
        let events = [
            Event::user_message("Hi"),
            Event::reply_started("r1", "kimi-k3.1-pro"),
            Event::reply_progress("r1", "Hel"),
            finished("r1", "Hello!"),
        ];
        let transcript = Transcript::fold(&events);
        let read: Vec<_> = transcript
            .messages
            .iter()
            .map(|m| (m.speaker, m.text.as_str(), m.outcome.clone()))
            .collect();
        assert_eq!(
            read,
            vec![
                (Speaker::Person, "Hi", Outcome::Finished),
                (Speaker::Spade, "Hello!", Outcome::Finished),
            ]
        );
        assert!(transcript.open_reply().is_none());
    }

    #[test]
    fn a_reply_with_only_progress_is_still_answering() {
        let events = [
            Event::user_message("Hi"),
            Event::reply_started("r1", "glm-5.3"),
            Event::reply_progress("r1", "Partial"),
        ];
        let transcript = Transcript::fold(&events);
        let open = transcript.open_reply();
        assert_eq!(open.map(|m| m.text.as_str()), Some("Partial"));
    }

    #[test]
    fn after_a_restart_the_open_reply_closes_with_its_last_checkpoint() {
        let events = [
            Event::user_message("Hi"),
            Event::reply_started("r1", "glm-5.3"),
            Event::reply_progress("r1", "Partial"),
        ];
        let mut transcript = Transcript::fold(&events);
        let close = transcript.close_after_restart();
        assert_eq!(
            close,
            Some(Event::reply_ended(ReplyEnd::Interrupted, "r1", "Partial"))
        );
        if let Some(event) = &close {
            transcript.apply(event);
        }
        assert!(transcript.open_reply().is_none());
        assert_eq!(transcript.close_after_restart(), None);
    }

    fn call(id: &str) -> crate::event::Call {
        crate::event::Call {
            id: id.into(),
            name: "send_email".into(),
            arguments: serde_json::json!({}),
        }
    }

    fn step_with(reply: &str, calls: Vec<crate::event::Call>) -> Event {
        Event::Known(Known::StepFinished {
            reply: reply.into(),
            text: String::new(),
            calls,
            signatures: Vec::new(),
            usage: crate::event::Tokens::default(),
            cost_micros: 0,
        })
    }

    #[test]
    fn a_reply_waiting_for_approval_survives_a_restart() {
        let events = [
            Event::user_message("Email Sam"),
            Event::reply_started("r1", "m"),
            step_with("r1", vec![call("c1")]),
            Event::Known(Known::ApprovalRequested {
                reply: "r1".into(),
                call_id: "c1".into(),
                name: "send_email".into(),
                arguments: serde_json::json!({}),
            }),
        ];
        let transcript = Transcript::fold(&events);
        assert_eq!(transcript.turn_state(), Some(TurnState::WaitingOnYou));
        assert_eq!(transcript.close_after_restart(), None);
    }

    #[test]
    fn always_allowing_remembers_the_tool_for_the_conversation() {
        let events = [
            Event::user_message("Email Sam"),
            Event::reply_started("r1", "m"),
            step_with("r1", vec![call("c1")]),
            Event::Known(Known::ApprovalRequested {
                reply: "r1".into(),
                call_id: "c1".into(),
                name: "send_email".into(),
                arguments: serde_json::json!({}),
            }),
            Event::Known(Known::ApprovalAnswered {
                reply: "r1".into(),
                call_id: "c1".into(),
                allowed: true,
                always: true,
            }),
        ];
        let transcript = Transcript::fold(&events);
        assert_eq!(transcript.always_allowed, vec!["send_email".to_owned()]);
        assert_eq!(transcript.turn_state(), Some(TurnState::Answering));
    }

    #[test]
    fn a_reply_cut_off_while_a_tool_ran_is_interrupted_after_a_restart() {
        let events = [
            Event::user_message("Search"),
            Event::reply_started("r1", "m"),
            step_with("r1", vec![call("c1")]),
            Event::Known(Known::ToolStarted {
                reply: "r1".into(),
                call_id: "c1".into(),
                name: "web_search".into(),
            }),
        ];
        let transcript = Transcript::fold(&events);
        assert_eq!(transcript.turn_state(), Some(TurnState::RunningTools));
        assert!(matches!(
            transcript.close_after_restart(),
            Some(Event::Known(Known::ReplyInterrupted { .. }))
        ));
    }

    #[test]
    fn a_failed_reply_keeps_what_arrived_and_the_error() {
        let events = [
            Event::user_message("Hi"),
            Event::reply_started("r1", "glm-5.3"),
            Event::Known(Known::ReplyFailed {
                reply: "r1".into(),
                text: "Half".into(),
                error: "rate limited".into(),
            }),
        ];
        let transcript = Transcript::fold(&events);
        let last = transcript.messages.last();
        assert_eq!(
            last.map(|m| (m.text.as_str(), m.outcome.clone())),
            Some(("Half", Outcome::Failed("rate limited".into())))
        );
    }

    #[test]
    fn the_latest_rename_is_the_title_and_unknown_events_change_nothing() {
        let events = [
            Event::user_message("Hi"),
            Event::renamed("Greeting"),
            Event::Unknown(serde_json::json!({ "type": "future_thing" })),
            Event::renamed("A greeting"),
        ];
        let transcript = Transcript::fold(&events);
        assert_eq!(transcript.title.as_deref(), Some("A greeting"));
        assert_eq!(transcript.messages.len(), 1);
    }
}
