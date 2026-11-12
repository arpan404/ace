//! A conversation's events, as stored. See docs/chat-core.md and docs/harness.md.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use spade_models::Thought;

use crate::tools::Risk;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Known {
    UserMessage {
        text: String,
        /// Per-turn context fixed when the message was stored (the time, matching memories), so
        /// rebuilding the prompt later gives the same bytes.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        context: Option<String>,
        /// Images the person attached. The bytes live in Spade's image store, by hash.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        images: Vec<ImageRef>,
        /// Another agent on this machine sent it (`bot_message`), not the person.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        from_agent: Option<FromAgent>,
    },
    /// The agent's task or model changed (ADR 0126). Used from the next turn on: a turn's prompt
    /// takes the task in effect when its reply started, and `reply_started` names its model.
    AgentConfigured {
        task: String,
        model: String,
    },
    /// The skill index for this conversation, fixed at its first turn so the prompt's top stays
    /// cached; later skills are found with `skill_search`.
    SkillsIndexed {
        text: String,
    },
    /// One model call in a turn finished: its text, tool calls and the model's thoughts, kept
    /// whole so they go back exactly as they came.
    StepFinished {
        reply: String,
        text: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        calls: Vec<Call>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        thoughts: Vec<Thought>,
        #[serde(default)]
        usage: Tokens,
        #[serde(default)]
        cost_micros: u64,
        /// How many of the conversation's events the step's prompt was built from. A message stored
        /// at or after this index arrived while the model was answering and is still unanswered.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        seen: Option<usize>,
    },
    /// The gate stopped a tool call to ask the person.
    ApprovalRequested {
        reply: String,
        call_id: String,
        name: String,
        arguments: Value,
    },
    ApprovalAnswered {
        reply: String,
        call_id: String,
        allowed: bool,
        /// Allow this tool without asking again in this conversation.
        #[serde(default)]
        always: bool,
    },
    ToolStarted {
        reply: String,
        call_id: String,
        name: String,
        /// The tool's risk when it was called, so compaction knows a write for what it was even
        /// after the tool is gone or reclassified. Missing on events from before it was recorded.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        risk: Option<Risk>,
        /// Whether it ran as a background job. Only meaningful when `risk` is recorded.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        background: bool,
    },
    ToolFinished {
        reply: String,
        call_id: String,
        name: String,
        content: String,
        #[serde(default)]
        is_error: bool,
        /// The call may or may not have taken effect (it timed out, or Spade stopped while it
        /// ran). Older events say so only in `content`; see [`crate::context::outcome_unknown`].
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        uncertain: bool,
        /// Images the tool returned (a screenshot), kept in the image store.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        images: Vec<ImageRef>,
        /// This one result carries untrusted content although its tool usually doesn't (a
        /// workspace file written after reading the web), so the turn is untrusted from here.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        untrusted: bool,
    },
    /// An allowed call was handed to a background job. Its `tool_finished` says so at once; the
    /// job's own result comes later as `job_finished`.
    JobStarted {
        reply: String,
        job: String,
        name: String,
    },
    /// A background job ended. The model reads it like a message, so it steers an open turn or
    /// starts a new one.
    JobFinished {
        job: String,
        name: String,
        content: String,
        #[serde(default)]
        is_error: bool,
        /// The job may or may not have taken effect (lost, stopped or cut off).
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        uncertain: bool,
    },
    /// The person pressed Stop, naming what was running then: the open reply and the background
    /// jobs. Those stop; a result of one of those jobs, or of a job its reply started, is kept
    /// without opening a reply. Later work is not affected.
    StopRequested {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reply: Option<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        jobs: Vec<String>,
    },
    ReplyStarted {
        reply: String,
        model: String,
    },
    /// Spade paused the open reply for a planned restart (an update or a stop): nothing of it was
    /// running when this was stored. It stays open and resumes from its events when Spade starts.
    TurnPaused {
        reply: String,
    },
    ReplyProgress {
        reply: String,
        text: String,
    },
    ReplyFinished {
        reply: String,
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        input_tokens: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        output_tokens: Option<u32>,
        #[serde(default)]
        cost_micros: u64,
    },
    ReplyStopped {
        reply: String,
        text: String,
    },
    ReplyFailed {
        reply: String,
        text: String,
        error: String,
    },
    ReplyInterrupted {
        reply: String,
        text: String,
    },
    Renamed {
        title: String,
    },
    /// Everything before `keep_from` (an index into the conversation's events) is replaced in the
    /// model's view by `summary`; the events themselves stay stored (docs/design.md, Compaction).
    ContextCompacted {
        summary: String,
        keep_from: usize,
        #[serde(default)]
        tokens_before: u32,
        /// How many images from `keep_from` on, oldest first, the prompt describes instead of
        /// showing until the next compaction. Fixed here so prompts between compactions only grow
        /// at the end. Missing on events from before it was stored.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        images_left_out: Option<usize>,
    },
}

/// The agent that sent a message, and how many bot-to-bot hops led to it (1 when the sender was
/// answering the person).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FromAgent {
    pub id: String,
    pub name: String,
    pub depth: u32,
}

/// An attached image, as stored in an event: its SHA-256 (hex), media type and size.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImageRef {
    pub sha256: String,
    pub media_type: String,
    pub bytes: u64,
}

/// A tool call as stored.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Call {
    pub id: String,
    pub name: String,
    pub arguments: Value,
}

/// Token counts for a model call, as the endpoint reported them.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Tokens {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_write: Option<u32>,
}

/// A stored event. One Spade does not know (written by a newer version) is kept as raw JSON.
#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    Known(Known),
    Unknown(Value),
}

/// How a reply ended, other than finishing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReplyEnd {
    Stopped,
    Interrupted,
}

impl Event {
    pub fn from_json(value: Value) -> Self {
        match serde_json::from_value::<Known>(value.clone()) {
            Ok(known) => Self::Known(known),
            Err(_) => Self::Unknown(value),
        }
    }

    pub fn to_json(&self) -> Value {
        match self {
            Self::Known(known) => serde_json::to_value(known).unwrap_or(Value::Null),
            Self::Unknown(value) => value.clone(),
        }
    }

    pub fn user_message(text: impl Into<String>) -> Self {
        Self::Known(Known::UserMessage {
            text: text.into(),
            context: None,
            images: Vec::new(),
            from_agent: None,
        })
    }

    pub fn reply_started(reply: impl Into<String>, model: impl Into<String>) -> Self {
        Self::Known(Known::ReplyStarted {
            reply: reply.into(),
            model: model.into(),
        })
    }

    pub fn reply_progress(reply: impl Into<String>, text: impl Into<String>) -> Self {
        Self::Known(Known::ReplyProgress {
            reply: reply.into(),
            text: text.into(),
        })
    }

    pub fn reply_ended(end: ReplyEnd, reply: impl Into<String>, text: impl Into<String>) -> Self {
        let (reply, text) = (reply.into(), text.into());
        Self::Known(match end {
            ReplyEnd::Stopped => Known::ReplyStopped { reply, text },
            ReplyEnd::Interrupted => Known::ReplyInterrupted { reply, text },
        })
    }

    pub fn renamed(title: impl Into<String>) -> Self {
        Self::Known(Known::Renamed {
            title: title.into(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn known_events_round_trip_through_json() {
        let event = Event::Known(Known::ReplyFinished {
            reply: "r1".into(),
            text: "Hi".into(),
            input_tokens: Some(11),
            output_tokens: None,
            cost_micros: 42,
        });
        assert_eq!(Event::from_json(event.to_json()), event);
        assert_eq!(event.to_json()["type"], "reply_finished");
    }

    #[test]
    fn an_event_from_a_newer_spade_is_kept_not_dropped() {
        let raw = json!({ "type": "tool_called", "tool": "web_search" });
        assert_eq!(Event::from_json(raw.clone()), Event::Unknown(raw.clone()));
        assert_eq!(Event::from_json(raw.clone()).to_json(), raw);
    }
}
