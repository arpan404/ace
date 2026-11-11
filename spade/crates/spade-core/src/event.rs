//! A conversation's events, as stored. See docs/chat-core.md.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Known {
    UserMessage {
        text: String,
    },
    ReplyStarted {
        reply: String,
        model: String,
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
        Self::Known(Known::UserMessage { text: text.into() })
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
