//! Spade's own request and reply types. Nothing outside this crate sees the SDK's types.

/// Who said a message in the conversation sent to a model.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Speaker {
    Person,
    Spade,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Message {
    pub speaker: Speaker,
    pub text: String,
}

/// What to send: optional instructions, then the conversation, oldest first.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Prompt {
    pub system: Option<String>,
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

    pub fn person(mut self, text: impl Into<String>) -> Self {
        self.messages.push(Message {
            speaker: Speaker::Person,
            text: text.into(),
        });
        self
    }

    pub fn spade(mut self, text: impl Into<String>) -> Self {
        self.messages.push(Message {
            speaker: Speaker::Spade,
            text: text.into(),
        });
        self
    }

    pub fn max_tokens(mut self, value: u32) -> Self {
        self.max_tokens = Some(value);
        self
    }
}

/// Token counts as the provider reported them. A provider may omit either.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Usage {
    pub input_tokens: Option<u32>,
    pub output_tokens: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reply {
    /// Spade's id for the model that answered.
    pub model: String,
    pub text: String,
    pub usage: Usage,
}

/// One piece of a streamed reply.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Delta {
    Text(String),
    /// The model's visible reasoning, when the provider streams it.
    Reasoning(String),
    /// The reply is complete.
    Done {
        usage: Usage,
    },
}
