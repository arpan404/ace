//! Binds a reply's thoughts to everything that came before it in the request that produced it.
//! This follows Anthropic's extended-thinking contract: a thinking block's signature is bound to
//! everything sent before it, so once compaction, aging or a route fallback rewrites that prefix
//! the block is refused and the whole request with it. Each thought carries a digest of its
//! prefix, and only thoughts whose digest still matches what is sent now go back.

use std::borrow::Cow;
use std::fmt::Write as _;

use sha2::{Digest, Sha256};

use crate::format::Format;
use crate::prompt::{Message, Thought, ToolSpec};

/// A tag byte per message variant and per thought variant, so two shapes never encode alike.
const PERSON: u8 = 1;
const SPADE: u8 = 2;
const TOOL_RESULT: u8 = 3;
const SIGNED: u8 = 1;
const REASONING: u8 = 2;
const BLOCK: u8 = 3;

/// What a reply is made from: the endpoint, the model, the instructions and the tools offered. A
/// thought made on one model, or with another system prompt or other tools, never matches a call
/// on another.
#[derive(Debug, Clone)]
pub(crate) struct Prefix(Sha256);

impl Prefix {
    pub(crate) fn new(
        format: Format,
        base_url: &str,
        model_id: &str,
        system: Option<&str>,
        tools: &[ToolSpec],
    ) -> Self {
        let mut prefix = Self(Sha256::new());
        prefix.text("spade-thinking-bound/1");
        prefix.text(format.name());
        prefix.text(base_url);
        prefix.text(model_id);
        prefix.tag(u8::from(system.is_some()));
        if let Some(system) = system {
            prefix.text(system);
        }
        prefix.count(tools.len());
        for tool in tools {
            prefix.text(&tool.name);
            prefix.text(&tool.description);
            prefix.text(&json(&tool.schema));
        }
        prefix
    }

    /// Feeds one message as it will be sent. Every string carries its length, so no two
    /// conversations encode alike by accident.
    pub(crate) fn add(&mut self, message: &Message) {
        match message {
            Message::Person { text, images } => {
                self.tag(PERSON);
                self.text(text);
                self.count(images.len());
                for image in images {
                    self.text(&image.media_type);
                    self.text(&image.data);
                }
            }
            Message::Spade {
                text,
                calls,
                thoughts,
            } => {
                self.tag(SPADE);
                self.text(text);
                self.count(calls.len());
                for call in calls {
                    self.text(&call.id);
                    self.text(&call.name);
                    self.text(&json(&call.arguments));
                }
                self.count(thoughts.len());
                for thought in thoughts {
                    self.thought(thought);
                }
            }
            Message::ToolResult {
                call_id,
                name,
                content,
                is_error,
            } => {
                self.tag(TOOL_RESULT);
                self.text(call_id);
                self.text(name);
                self.text(content);
                self.tag(u8::from(*is_error));
            }
        }
    }

    /// One thought as sent, without its `bound`: that is what it is bound to, not what came
    /// before it.
    fn thought(&mut self, thought: &Thought) {
        match thought {
            Thought::Signed {
                signature,
                reasoning,
                ..
            } => {
                self.tag(SIGNED);
                self.text(signature);
                self.tag(u8::from(reasoning.is_some()));
                if let Some(reasoning) = reasoning {
                    self.text(reasoning);
                }
            }
            Thought::Reasoning { text, .. } => {
                self.tag(REASONING);
                self.text(text);
            }
            Thought::Block { data, .. } => {
                self.tag(BLOCK);
                self.text(&json(data));
            }
        }
    }

    /// Lowercase hex of everything fed so far.
    pub(crate) fn digest(&self) -> String {
        let mut hex = String::with_capacity(64);
        for byte in self.0.clone().finalize() {
            let _ = write!(hex, "{byte:02x}");
        }
        hex
    }

    fn tag(&mut self, tag: u8) {
        self.0.update([tag]);
    }

    fn count(&mut self, count: usize) {
        self.0.update((count as u64).to_le_bytes());
    }

    fn text(&mut self, text: &str) {
        self.count(text.len());
        self.0.update(text.as_bytes());
    }
}

/// The messages to send, and the digest a reply's thoughts are bound to: a thought goes back only
/// when the prefix it was made from is exactly the prefix sent now. Every message is borrowed
/// as it is; only a `Message::Spade` whose thoughts were trimmed is owned.
pub(crate) fn sendable<'a>(
    messages: &'a [Message],
    mut prefix: Prefix,
) -> (Vec<Cow<'a, Message>>, String) {
    let mut out = Vec::with_capacity(messages.len());
    for message in messages {
        let sent = match message {
            Message::Spade { thoughts, .. } => {
                let bound = prefix.digest();
                if thoughts
                    .iter()
                    .all(|thought| bound_of(thought) == Some(bound.as_str()))
                {
                    Cow::Borrowed(message)
                } else {
                    let mut owned = message.clone();
                    if let Message::Spade { thoughts, .. } = &mut owned {
                        thoughts.retain(|thought| bound_of(thought) == Some(bound.as_str()));
                    }
                    Cow::Owned(owned)
                }
            }
            _ => Cow::Borrowed(message),
        };
        prefix.add(sent.as_ref());
        out.push(sent);
    }
    (out, prefix.digest())
}

/// Every message as it is, and the digest a reply's thoughts are bound to.
pub(crate) fn digest(messages: &[Message], mut prefix: Prefix) -> String {
    for message in messages {
        prefix.add(message);
    }
    prefix.digest()
}

/// What `thought` is bound to: `None` for one stored by a build that bound nothing.
fn bound_of(thought: &Thought) -> Option<&str> {
    match thought {
        Thought::Signed { bound, .. }
        | Thought::Reasoning { bound, .. }
        | Thought::Block { bound, .. } => bound.as_deref(),
    }
}

/// A JSON value as one string; `Value` always serializes.
fn json(value: &serde_json::Value) -> String {
    serde_json::to_string(value).unwrap_or_default()
}
