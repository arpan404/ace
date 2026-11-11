//! Spade's own request and reply types. Nothing outside this crate sees the SDK's types.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A tool the model may call: its name, what it does, and a JSON Schema for its input.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    pub schema: Value,
}

/// A tool call the model made. `arguments` is the parsed JSON input.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: Value,
}

/// Reasoning a model did before answering, kept so it goes back exactly as it came: Anthropic
/// rejects a tool continuation whose signed thinking is missing or altered, and some
/// OpenAI-compatible endpoints need their `reasoning_content` back with tool calls.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Thought {
    /// Signed thinking: the signature and, when the provider sent it, the reasoning it signs.
    Signed {
        signature: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reasoning: Option<String>,
    },
    /// Reasoning text with no signature.
    Reasoning { text: String },
    /// A provider block kept whole, such as Anthropic's redacted thinking.
    Block { data: Value },
}

/// An image sent to the model: its media type (`image/png`) and its bytes in base64.
#[derive(Debug, Clone, PartialEq)]
pub struct Image {
    pub media_type: String,
    pub data: Arc<str>,
}

/// One entry in the conversation sent to a model.
#[derive(Debug, Clone, PartialEq)]
pub enum Message {
    Person {
        text: String,
        /// Images the person attached, sent after the text.
        images: Vec<Image>,
    },
    /// Spade's earlier turn: its text, the tool calls it made, and the model's thoughts, which
    /// must be sent back unchanged for multi-step tool use to keep working.
    Spade {
        text: String,
        calls: Vec<ToolCall>,
        thoughts: Vec<Thought>,
    },
    /// The result of one tool call, answered by `call_id`.
    ToolResult {
        call_id: String,
        name: String,
        content: String,
        is_error: bool,
    },
}

/// What to send: optional instructions, the tools on offer, then the conversation, oldest first.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Prompt {
    pub system: Option<String>,
    pub tools: Vec<ToolSpec>,
    pub messages: Vec<Message>,
    /// Upper bound on the reply's length. The SDK picks a per-model default when unset.
    pub max_tokens: Option<u32>,
}

impl Prompt {
    /// A prompt holding one message from the person.
    pub fn ask(text: impl Into<String>) -> Self {
        Self::default().person(text)
    }

    pub fn system(mut self, text: impl Into<String>) -> Self {
        self.system = Some(text.into());
        self
    }

    pub fn tools(mut self, tools: Vec<ToolSpec>) -> Self {
        self.tools = tools;
        self
    }

    pub fn person(mut self, text: impl Into<String>) -> Self {
        self.messages.push(Message::Person {
            text: text.into(),
            images: Vec::new(),
        });
        self
    }

    /// A message from the person with images attached.
    pub fn person_with_images(mut self, text: impl Into<String>, images: Vec<Image>) -> Self {
        self.messages.push(Message::Person {
            text: text.into(),
            images,
        });
        self
    }

    pub fn spade(mut self, text: impl Into<String>) -> Self {
        self.messages.push(Message::Spade {
            text: text.into(),
            calls: Vec::new(),
            thoughts: Vec::new(),
        });
        self
    }

    /// Spade's turn that made tool calls, with the model's thoughts from that turn.
    pub fn spade_calls(
        mut self,
        text: impl Into<String>,
        calls: Vec<ToolCall>,
        thoughts: Vec<Thought>,
    ) -> Self {
        self.messages.push(Message::Spade {
            text: text.into(),
            calls,
            thoughts,
        });
        self
    }

    pub fn tool_result(
        mut self,
        call: &ToolCall,
        content: impl Into<String>,
        is_error: bool,
    ) -> Self {
        self.messages.push(Message::ToolResult {
            call_id: call.id.clone(),
            name: call.name.clone(),
            content: content.into(),
            is_error,
        });
        self
    }

    pub fn max_tokens(mut self, value: u32) -> Self {
        self.max_tokens = Some(value);
        self
    }
}

/// Token counts as the endpoint reported them. A count the endpoint did not give is `None`.
/// `input_tokens` is all input, including the cached part: `cache_read_tokens` were served from
/// the cache and `cache_write_tokens` were written to it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Usage {
    pub input_tokens: Option<u32>,
    pub output_tokens: Option<u32>,
    pub cache_read_tokens: Option<u32>,
    pub cache_write_tokens: Option<u32>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Reply {
    /// The `endpoint/model` that answered.
    pub model: String,
    pub text: String,
    /// Tool calls the model made; empty when it simply answered.
    pub calls: Vec<ToolCall>,
    /// Thoughts to send back with this turn (see [`Message::Spade`]).
    pub thoughts: Vec<Thought>,
    pub usage: Usage,
}

/// A typed reply and what it cost in tokens.
#[derive(Debug, Clone, PartialEq)]
pub struct Generated<T> {
    pub value: T,
    pub usage: Usage,
}

/// One piece of a streamed reply.
#[derive(Debug, Clone, PartialEq)]
pub enum Delta {
    Text(String),
    /// The model's visible reasoning, when the provider streams it.
    Reasoning(String),
    /// A complete tool call, sent once its arguments have fully arrived.
    Call(ToolCall),
    /// The reply is complete. `thoughts` go back with this turn (see [`Message::Spade`]).
    Done {
        usage: Usage,
        thoughts: Vec<Thought>,
    },
}
