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
    /// Background jobs still running, by job id. They outlive the turn that started them.
    pub jobs: Vec<String>,
    /// The person pressed Stop while the open reply ran; it ends as stopped.
    pub stopping: bool,
    /// The open reply was paused for a planned restart and nothing of it has run since. It is
    /// still open (the conversation is still working) and resumes when Spade starts.
    pub paused: bool,
    /// Questions the open reply asked the person (`ask_user`), by call id, and whether their
    /// answer has arrived. One stays until its call has a result.
    pub questions: Vec<Question>,
    /// Tools the person allowed "always" in this conversation.
    pub always_allowed: Vec<String>,
    /// Which tool each approval asked about, by call id.
    asked: Vec<(String, String)>,
    /// Indexes into `messages` of the replies still answering, oldest first. The last is the
    /// open reply. Kept as events fold so finding the open reply never scans the history.
    answering: Vec<usize>,
}

/// A question the open reply asked the person.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Question {
    pub call_id: String,
    /// The person's next message has arrived; the call's result is still to be stored.
    pub answered: bool,
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
            Known::UserMessage {
                text, from_agent, ..
            } => {
                // The person's next message answers what the bot asked; another bot's does not.
                if from_agent.is_none() {
                    for question in &mut self.questions {
                        question.answered = true;
                    }
                }
                self.messages.push(Message {
                    speaker: Speaker::Person,
                    text: text.clone(),
                    reply: None,
                    outcome: Outcome::Finished,
                })
            }
            Known::QuestionAsked { call_id, .. } => {
                self.paused = false;
                if !self.stopping {
                    self.questions.push(Question {
                        call_id: call_id.clone(),
                        answered: false,
                    });
                }
            }
            Known::ReplyStarted { reply, .. } => {
                self.stopping = false;
                self.paused = false;
                self.answering.push(self.messages.len());
                self.messages.push(Message {
                    speaker: Speaker::Spade,
                    text: String::new(),
                    reply: Some(reply.clone()),
                    outcome: Outcome::Answering,
                });
            }
            Known::ReplyProgress { reply, text } => {
                self.paused = false;
                self.update(reply, text, None);
            }
            Known::ReplyFinished { reply, text, .. } => {
                self.update(reply, text, Some(Outcome::Finished));
            }
            Known::ReplyStopped { reply, text } => {
                self.update(reply, text, Some(Outcome::Stopped));
            }
            Known::ReplyFailed {
                reply, text, error, ..
            } => {
                self.update(reply, text, Some(Outcome::Failed(error.clone())));
            }
            Known::ReplyInterrupted { reply, text } => {
                self.update(reply, text, Some(Outcome::Interrupted));
            }
            Known::Renamed { title } => self.title = Some(title.clone()),
            Known::StepFinished { reply, text, .. } => {
                self.paused = false;
                if !text.is_empty() {
                    self.update(reply, text, None);
                }
            }
            Known::ToolStarted { call_id, .. } => {
                self.paused = false;
                self.running.push(call_id.clone());
            }
            Known::ToolFinished { call_id, .. } => {
                self.paused = false;
                self.running.retain(|id| id != call_id);
                self.questions.retain(|q| &q.call_id != call_id);
            }
            Known::TurnPaused { reply } => {
                let open = self.open_reply().and_then(|m| m.reply.as_deref());
                if open == Some(reply.as_str()) {
                    self.paused = true;
                }
            }
            Known::ApprovalRequested { call_id, name, .. } => {
                self.paused = false;
                if !self.stopping {
                    self.awaiting.push(call_id.clone());
                }
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
                    .rev()
                    .find(|(id, _)| id == call_id)
                    .map(|(_, name)| name.clone());
                if let (true, true, Some(tool)) = (*allowed, *always, tool)
                    && !self.always_allowed.contains(&tool)
                {
                    self.always_allowed.push(tool);
                }
            }
            Known::JobStarted { job, .. } => {
                self.paused = false;
                self.jobs.push(job.clone());
            }
            Known::JobFinished { job, .. } => self.jobs.retain(|id| id != job),
            Known::StopRequested { reply, .. } => {
                let open = self.open_reply().and_then(|m| m.reply.clone());
                if open.is_some() && open == *reply {
                    // Nothing waiting can be answered once Stop is pressed.
                    self.stopping = true;
                    self.awaiting.clear();
                    self.questions.clear();
                }
            }
            Known::SkillsIndexed { .. }
            | Known::Shared { .. }
            | Known::MemoryIndexed { .. }
            | Known::ContextCompacted { .. }
            | Known::AgentConfigured { .. }
            | Known::CapReached { .. }
            | Known::CallReviewed { .. }
            | Known::GroupMessage { .. }
            | Known::GroupAsked { .. }
            | Known::GroupAnswered { .. }
            | Known::GroupQueued { .. }
            | Known::GroupStopped { .. }
            | Known::ComputerHandedBack { .. } => {}
        }
        if self.open_reply().is_none() {
            self.running.clear();
            self.awaiting.clear();
            self.questions.clear();
            self.paused = false;
        }
    }

    fn update(&mut self, reply: &str, text: &str, outcome: Option<Outcome>) {
        let messages = &self.messages;
        let Some(slot) = self
            .answering
            .iter()
            .rposition(|&at| messages[at].reply.as_deref() == Some(reply))
        else {
            return;
        };
        let message = &mut self.messages[self.answering[slot]];
        message.text = text.to_owned();
        if let Some(outcome) = outcome {
            message.outcome = outcome;
            self.answering.remove(slot);
        }
    }

    /// The reply still arriving, if any.
    pub fn open_reply(&self) -> Option<&Message> {
        self.answering.last().map(|&at| &self.messages[at])
    }

    /// What the open reply is doing, if there is one.
    pub fn turn_state(&self) -> Option<TurnState> {
        self.open_reply()?;
        Some(if !self.running.is_empty() {
            TurnState::RunningTools
        } else if !self.awaiting.is_empty() || self.asking() {
            TurnState::WaitingOnYou
        } else {
            TurnState::Answering
        })
    }

    /// The event that closes the open reply after a restart, keeping its last checkpoint. A reply
    /// only waiting for the person's approval stays open: the approval survives the restart. So
    /// does a paused one: nothing of it was running, so it resumes from its events.
    pub fn close_after_restart(&self) -> Option<Event> {
        let open = self.open_reply()?;
        let reply = open.reply.clone()?;
        if self.stopping {
            // Stop was pressed before the restart: the reply ends stopped, approvals and all.
            return Some(Event::reply_ended(
                ReplyEnd::Stopped,
                reply,
                open.text.clone(),
            ));
        }
        // A question (answered or not) whose result is not stored yet is still owed to the turn,
        // even beside tools cut off mid-run: those resume as unknown outcomes, the question stays.
        if self.paused
            || self.turn_state() == Some(TurnState::WaitingOnYou)
            || !self.questions.is_empty()
        {
            return None;
        }
        Some(Event::reply_ended(
            ReplyEnd::Interrupted,
            reply,
            open.text.clone(),
        ))
    }

    /// Whether the open reply waits for the person to answer a question it asked.
    pub fn asking(&self) -> bool {
        self.questions.iter().any(|q| !q.answered)
    }

    /// Whether anything is still working: an open reply or a background job.
    pub fn busy(&self) -> bool {
        self.open_reply().is_some() || !self.jobs.is_empty()
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
    use crate::event::FailureKind;

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
            thoughts: Vec::new(),
            usage: crate::event::Tokens::default(),
            cost_micros: 0,
            seen: None,
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
    fn a_reply_stopped_while_waiting_for_approval_ends_stopped_after_a_restart() {
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
            Event::Known(Known::StopRequested {
                reply: Some("r1".into()),
                jobs: Vec::new(),
            }),
        ];
        let transcript = Transcript::fold(&events);
        assert!(
            transcript.awaiting.is_empty(),
            "the approval can no longer be answered"
        );
        assert_eq!(
            transcript.close_after_restart(),
            Some(Event::reply_ended(ReplyEnd::Stopped, "r1", ""))
        );
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
                risk: None,
                background: false,
            }),
        ];
        let transcript = Transcript::fold(&events);
        assert_eq!(transcript.turn_state(), Some(TurnState::RunningTools));
        assert!(matches!(
            transcript.close_after_restart(),
            Some(Event::Known(Known::ReplyInterrupted { .. }))
        ));
    }

    fn paused(reply: &str) -> Event {
        Event::Known(Known::TurnPaused {
            reply: reply.into(),
        })
    }

    #[test]
    fn a_paused_reply_is_still_working_and_resumes_after_a_restart() {
        let events = [
            Event::user_message("Plan a trip"),
            Event::reply_started("r1", "m"),
            Event::reply_progress("r1", "Looking"),
            paused("r1"),
            // A message stored while Spade was paused does not end the pause.
            Event::user_message("Also check trains"),
        ];
        let transcript = Transcript::fold(&events);
        assert!(transcript.paused);
        assert!(
            transcript.busy(),
            "a paused reply keeps the conversation working"
        );
        assert_eq!(transcript.turn_state(), Some(TurnState::Answering));
        assert_eq!(transcript.close_after_restart(), None);
    }

    #[test]
    fn a_paused_reply_that_ran_again_is_interrupted_by_a_crash() {
        let events = [
            Event::user_message("Search"),
            Event::reply_started("r1", "m"),
            paused("r1"),
            step_with("r1", vec![call("c1")]),
            Event::Known(Known::ToolStarted {
                reply: "r1".into(),
                call_id: "c1".into(),
                name: "web_search".into(),
                risk: None,
                background: false,
            }),
        ];
        let transcript = Transcript::fold(&events);
        assert!(!transcript.paused);
        assert!(matches!(
            transcript.close_after_restart(),
            Some(Event::Known(Known::ReplyInterrupted { .. }))
        ));
    }

    #[test]
    fn a_pause_of_another_reply_or_a_stop_wins_over_resuming() {
        let stale = [
            Event::user_message("Hi"),
            Event::reply_started("r1", "m"),
            finished("r1", "Hello"),
            Event::user_message("Again"),
            Event::reply_started("r2", "m"),
            paused("r1"),
        ];
        assert!(!Transcript::fold(&stale).paused);
        let stopped = [
            Event::user_message("Hi"),
            Event::reply_started("r1", "m"),
            paused("r1"),
            Event::Known(Known::StopRequested {
                reply: Some("r1".into()),
                jobs: Vec::new(),
            }),
        ];
        assert_eq!(
            Transcript::fold(&stopped).close_after_restart(),
            Some(Event::reply_ended(ReplyEnd::Stopped, "r1", ""))
        );
    }

    #[test]
    fn a_background_job_keeps_the_conversation_busy_after_its_turn_ends() {
        let mut events = vec![
            Event::user_message("Research flights"),
            Event::reply_started("r1", "m"),
            step_with("r1", vec![call("c1")]),
            Event::Known(Known::JobStarted {
                reply: "r1".into(),
                job: "c1".into(),
                name: "research".into(),
            }),
            finished("r1", "Started the research."),
        ];
        let transcript = Transcript::fold(&events);
        assert!(transcript.open_reply().is_none());
        assert_eq!(transcript.jobs, vec!["c1".to_owned()]);
        assert!(transcript.busy());

        events.push(Event::Known(Known::JobFinished {
            job: "c1".into(),
            name: "research".into(),
            content: "Three options".into(),
            is_error: false,
            uncertain: false,
            files: Vec::new(),
        }));
        assert!(!Transcript::fold(&events).busy());
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
                kind: FailureKind::RateLimited,
                endpoint: None,
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
    fn folding_a_long_history_takes_time_proportional_to_its_length() {
        let turns = 40_000;
        let mut events = Vec::with_capacity(turns * 4);
        for turn in 0..turns {
            let reply = format!("r{turn}");
            events.push(Event::user_message("Hi"));
            events.push(Event::reply_started(&reply, "m"));
            events.push(Event::reply_progress(&reply, "Hel"));
            events.push(finished(&reply, "Hello"));
        }
        let started = std::time::Instant::now();
        let transcript = Transcript::fold(&events);
        let took = started.elapsed();
        assert_eq!(transcript.messages.len(), turns * 2);
        assert!(transcript.open_reply().is_none());
        // Linear folding takes milliseconds; rescanning the history per event takes minutes.
        assert!(took < std::time::Duration::from_secs(2), "took {took:?}");
    }

    #[test]
    fn an_older_open_reply_is_open_again_once_a_newer_one_ends() {
        let events = [
            Event::user_message("Hi"),
            Event::reply_started("r1", "m"),
            Event::reply_progress("r1", "One"),
            Event::reply_started("r2", "m"),
            finished("r2", "Two"),
        ];
        let transcript = Transcript::fold(&events);
        assert_eq!(
            transcript.open_reply().map(|m| m.text.as_str()),
            Some("One")
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

    #[test]
    fn a_question_asked_beside_a_tool_cut_off_by_a_crash_still_waits_after_the_restart() {
        let step = Event::Known(Known::StepFinished {
            reply: "r1".into(),
            text: String::new(),
            calls: vec![
                crate::event::Call {
                    id: "q1".into(),
                    name: "ask_user".into(),
                    arguments: serde_json::json!({ "question": "Window or aisle?" }),
                },
                call("c2"),
            ],
            thoughts: Vec::new(),
            usage: Default::default(),
            cost_micros: 0,
            seen: None,
        });
        let events = [
            Event::user_message("Book a seat"),
            Event::reply_started("r1", "m"),
            step,
            Event::Known(Known::QuestionAsked {
                reply: "r1".into(),
                call_id: "q1".into(),
                question: "Window or aisle?".into(),
            }),
            Event::Known(Known::ToolStarted {
                reply: "r1".into(),
                call_id: "c2".into(),
                name: "send_email".into(),
                risk: None,
                background: false,
            }),
        ];
        let transcript = Transcript::fold(&events);
        assert_eq!(
            transcript.close_after_restart(),
            None,
            "the reply stays open"
        );
        assert!(transcript.asking());
    }
}
