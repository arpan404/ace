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
        /// Documents the person attached (ADR 0134). Their bytes and text live in Spade's
        /// document store, by hash; each carries the view the prompt shows.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        documents: Vec<DocumentRef>,
        /// The recording, when the message was spoken; `text` is its transcript. Boxed to keep
        /// every event small.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        voice: Option<Box<VoiceRef>>,
        /// Another agent on this machine sent it (`bot_message`), not the person.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        from_agent: Option<FromAgent>,
        /// One of the agent's routines sent it (ADR 0129), not the person.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        from_routine: Option<Box<FromRoutine>>,
        /// It came through a group (ADR 0132): the bot's reply is posted there.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        from_group: Option<Box<FromGroup>>,
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
    /// The bot's notes for the cached top of the prompt (ADR 0128), stored before the first model
    /// call and once after each compaction, so the top changes only when the conversation
    /// compacts.
    MemoryIndexed {
        text: String,
    },
    /// `ask_user`: the bot asked the person and the turn waits for their next message.
    QuestionAsked {
        reply: String,
        call_id: String,
        question: String,
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
        /// What answering "always" covers, as the tool said when it asked (a terminal command's
        /// covers the command in the folder and with the variables it would run with, ADR
        /// 0142). Absent for older events and tools whose always covers the whole tool.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scope: Option<String>,
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
    /// What a tool showed the person (ADR 0134): images a bot made and files from its
    /// workspace, stored by hash. Stored with the tool's `tool_finished`; the model never reads
    /// it, the app shows it in the reply's bubble.
    Shared {
        reply: String,
        call_id: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        images: Vec<ImageRef>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        documents: Vec<DocumentRef>,
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
        /// Workspace files the job kept for the person to open (a research report, ADR 0135).
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        files: Vec<String>,
    },
    /// The bot reached one of its spending caps (ADR 0135). Stored once per day or month.
    CapReached {
        scope: CapScope,
        cap_micros: u64,
        /// The start of the day or month the cap is for, so it is said once per period.
        period_start: i64,
        resets_at: i64,
    },
    /// The model review judged a call the gate would have run (ADR 0135).
    CallReviewed {
        reply: String,
        call_id: String,
        name: String,
        verdict: Verdict,
        reason: String,
        model: String,
        #[serde(default)]
        cost_micros: u64,
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
    /// The person handed the bot's computer back after driving it (ADR 0142). `text` is Spade's
    /// summary of what they did (commands they ran, files they changed, surfaces they used),
    /// never their keystrokes. The model reads it as a note from Spade, like a job's result: it
    /// steers a turn that resumes, and opens no reply by itself.
    ComputerHandedBack {
        text: String,
        /// File names and addresses from the person's turn, kept apart from Spade's words:
        /// whoever made a file or a page chose its name, so these are untrusted data.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        data: Vec<String>,
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
        /// What went wrong, as the endpoint or Spade said it: for the activity log.
        error: String,
        /// The kind of failure, for the one plain sentence a client shows. `other` on events
        /// from before it was stored, and for any kind this build doesn't know.
        #[serde(default)]
        kind: FailureKind,
        /// The endpoint the failed call went to (its id), when the failure was the endpoint's.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        endpoint: Option<String>,
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
        /// What it summarised (with any earlier summary it folded in) held untrusted content, so
        /// facts drawn from it are only suggested to the person (ADR 0128).
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        untrusted: bool,
    },
    /// A message in a group's transcript (ADR 0132): the person's (`from` is `None`) or a bot's
    /// answer to an ask.
    GroupMessage {
        run: String,
        text: String,
        #[serde(default)]
        from: Option<GroupBot>,
    },
    /// A group message was handed to a bot: by the person's post (`by` is `None`) or by a bot's
    /// `group_ask`.
    GroupAsked {
        run: String,
        ask: String,
        #[serde(default)]
        by: Option<GroupBot>,
        to: GroupBot,
        depth: u32,
    },
    /// An ask ended: `answered`, `stopped`, `failed`, `refused` or `gave_up`.
    GroupAnswered {
        run: String,
        ask: String,
        to: GroupBot,
        outcome: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
    },
    /// An ask to a bot of another machine waits for that machine to come online.
    GroupQueued {
        run: String,
        ask: String,
        to: GroupBot,
        machine_name: String,
    },
    /// The person pressed Stop in the group: the run ended.
    GroupStopped {
        run: String,
    },
}

/// Which of a bot's caps (ADR 0135).
/// Why a reply failed, in the few kinds a person can act on (`reply_failed`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureKind {
    /// The endpoint couldn't be reached: the request never got an answer.
    Unreachable,
    /// The endpoint refused the key (`401`, `403`), or there is none.
    Key,
    /// The endpoint is rate limiting (`429`).
    RateLimited,
    /// The model or the endpoint failed while answering, or refused the request.
    Model,
    /// A spending cap stopped it: the day's, or the turn's own cost limit.
    Cap,
    /// Anything else, and any kind a later build adds.
    #[default]
    #[serde(other)]
    Other,
}

impl FailureKind {
    /// The kind of a failed model call.
    pub fn of(error: &spade_models::ModelError) -> Self {
        use spade_models::ModelError;
        match error {
            ModelError::MissingKey { .. } => Self::Key,
            ModelError::Unanswered { status: None, .. } => Self::Unreachable,
            ModelError::Unanswered {
                status: Some(401 | 403),
                ..
            } => Self::Key,
            ModelError::Unanswered {
                status: Some(429), ..
            } => Self::RateLimited,
            ModelError::Unanswered { .. }
            | ModelError::Provider { .. }
            | ModelError::Empty { .. }
            | ModelError::Shape { .. }
            | ModelError::UnknownModel(_) => Self::Model,
            ModelError::Listing { .. } | ModelError::Setup(_) => Self::Other,
        }
    }

    /// Whether the failure was the endpoint's, so it is worth naming.
    pub fn names_endpoint(self) -> bool {
        matches!(
            self,
            Self::Unreachable | Self::Key | Self::RateLimited | Self::Model
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CapScope {
    Daily,
    Monthly,
}

/// What the model review decided about a call.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Verdict {
    Allow,
    Escalate,
}

/// The agent that sent a message, and how many bot-to-bot hops led to it (1 when the sender was
/// answering the person).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FromAgent {
    pub id: String,
    pub name: String,
    pub depth: u32,
    /// The machine it runs on, by name, when that is another machine (ADR 0132).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub machine: Option<String>,
}

/// The group a message came through (ADR 0132), and whether the group's earlier messages that
/// came with it carry other bots' words.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FromGroup {
    pub id: String,
    pub name: String,
    pub run: String,
    pub ask: String,
    /// The group lives on another machine, by name; `group_ask` works only on the group's own.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub machine: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub untrusted: bool,
}

/// A bot as a group names it: its id, name and machine (host id; `None` for this machine).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GroupBot {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub machine: Option<String>,
}

/// The routine whose firing a message is (ADR 0129): its id and name, the run, and a short label
/// fixed when it fired (`9:00`, `caught up from 9:00`, `thread finished: Fix login`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FromRoutine {
    pub id: String,
    pub name: String,
    pub run: String,
    pub label: String,
    /// A heartbeat: shown as nothing, and its quiet answer too.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub heartbeat: bool,
    /// What an event carried (a thread's title), which came from outside: a turn it starts or
    /// steers counts as untrusted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event: Option<String>,
}

/// An attached image, as stored in an event: its SHA-256 (hex), media type and size.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImageRef {
    pub sha256: String,
    pub media_type: String,
    pub bytes: u64,
}

/// An attached document, as stored in an event (ADR 0134): its SHA-256 (hex), name, media type
/// and size, what it holds, and the view of its text the prompt shows, fixed when it was stored so
/// a rebuilt prompt is the same bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DocumentRef {
    pub sha256: String,
    pub name: String,
    pub media_type: String,
    pub bytes: u64,
    /// A PDF's page count.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pages: Option<u32>,
    /// A spreadsheet's sheet count.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sheets: Option<u32>,
    /// Characters of extracted text.
    pub chars: u64,
    /// The text stopped at Spade's limit; the document holds more.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub cut: bool,
    /// The start of the text, as the prompt shows it.
    #[serde(default)]
    pub view: String,
    /// Which reader made the text, and its version (`pdf-v1`): the same bytes read as another
    /// kind, or by a later reader, are another text. Empty on references made before it was kept.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub reader: String,
}

impl DocumentRef {
    /// The id the model reads the document by: the hash's first 12 characters, then the reader.
    pub fn handle(&self) -> String {
        let short: String = self.sha256.chars().take(12).collect();
        if self.reader.is_empty() {
            short
        } else {
            format!("{short}-{}", self.reader)
        }
    }
}

/// A spoken message's recording: its SHA-256 (hex), media type and size.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VoiceRef {
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
            documents: Vec::new(),
            voice: None,
            from_agent: None,
            from_routine: None,
            from_group: None,
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

    fn failed_kind(raw: Value) -> Option<FailureKind> {
        match Event::from_json(raw) {
            Event::Known(Known::ReplyFailed { kind, .. }) => Some(kind),
            _ => None,
        }
    }

    #[test]
    fn a_failed_reply_stored_before_kinds_existed_or_with_a_newer_kind_reads_as_other() {
        let old = json!({ "type": "reply_failed", "reply": "r1", "text": "", "error": "boom" });
        assert_eq!(failed_kind(old), Some(FailureKind::Other));
        let newer = json!({ "type": "reply_failed", "reply": "r1", "text": "", "error": "boom",
                            "kind": "solar_flare" });
        assert_eq!(failed_kind(newer), Some(FailureKind::Other));
        let known = json!({ "type": "reply_failed", "reply": "r1", "text": "", "error": "boom",
                            "kind": "rate_limited", "endpoint": "fake" });
        assert_eq!(failed_kind(known), Some(FailureKind::RateLimited));
    }

    #[test]
    fn a_call_that_never_got_an_answer_is_unreachable_and_a_refused_key_is_the_keys() {
        use spade_models::ModelError;
        let refused = |status: Option<u16>| ModelError::Unanswered {
            model: "fake/m".into(),
            message: String::new(),
            transient: false,
            retry_after: None,
            status,
        };
        assert_eq!(FailureKind::of(&refused(None)), FailureKind::Unreachable);
        assert_eq!(FailureKind::of(&refused(Some(401))), FailureKind::Key);
        assert_eq!(
            FailureKind::of(&refused(Some(429))),
            FailureKind::RateLimited
        );
        assert_eq!(FailureKind::of(&refused(Some(500))), FailureKind::Model);
        let missing = ModelError::MissingKey {
            endpoint: "fake".into(),
            var: None,
        };
        assert_eq!(FailureKind::of(&missing), FailureKind::Key);
    }
}
