//! The I/O shell: turns Spade prompts into SDK calls on the configured gateway.

use futures_util::{Stream, StreamExt};
use genai::adapter::AdapterKind;
use genai::chat::{ChatMessage, ChatOptions, ChatRequest, ChatStreamEvent};
use genai::resolver::{AuthData, Endpoint};
use genai::{Client, ModelIden, ServiceTarget};
use schemars::JsonSchema;
use serde::de::DeserializeOwned;

use std::sync::Arc;

use crate::catalog::{Catalog, Role};
use crate::config::ModelsConfig;
use crate::error::ModelError;
use crate::gateway::{self, Gateway, Protocol};
use crate::prompt::{Delta, Prompt, Reply, Speaker, Usage};
use crate::typed;

/// Calls Spade's models through one gateway.
#[derive(Debug, Clone)]
pub struct Models {
    client: Client,
    config: ModelsConfig,
    catalog: Arc<Catalog>,
}

/// A model resolved for one call.
struct Call {
    id: String,
    target: ServiceTarget,
}

impl Models {
    /// Fails if `catalog` sets no defaults for the configured gateway, so a role always has a
    /// model.
    pub fn new(config: ModelsConfig, catalog: Catalog) -> Result<Self, ModelError> {
        if catalog.default_for(config.gateway, Role::Main).is_none() {
            return Err(ModelError::NoDefaults(config.gateway));
        }
        let client = Client::new().map_err(|error| ModelError::Setup(error.to_string()))?;
        Ok(Self {
            client,
            config,
            catalog: Arc::new(catalog),
        })
    }

    pub fn catalog(&self) -> &Catalog {
        &self.catalog
    }

    pub fn gateway(&self) -> Gateway {
        self.config.gateway
    }

    /// The model this gateway uses for `role`.
    pub fn for_role(&self, role: Role) -> &str {
        // `new` checked that this gateway has defaults.
        self.catalog
            .default_for(self.config.gateway, role)
            .unwrap_or_default()
    }

    pub async fn chat(&self, model: &str, prompt: &Prompt) -> Result<Reply, ModelError> {
        let call = self.call(model)?;
        let options = options(prompt);
        let response = self
            .client
            .exec_chat(call.target, request(prompt), Some(&options))
            .await
            .map_err(|error| provider_error(&call.id, &error))?;
        let usage = usage(&response.usage);
        let text = response
            .into_first_text()
            .ok_or_else(|| ModelError::Empty {
                model: call.id.to_owned(),
            })?;
        Ok(Reply {
            model: call.id,
            text,
            usage,
        })
    }

    /// Asks for a reply shaped as `T` and parses it.
    pub async fn generate<T>(&self, model: &str, prompt: &Prompt) -> Result<T, ModelError>
    where
        T: JsonSchema + DeserializeOwned,
    {
        let call = self.call(model)?;
        let options = options(prompt).with_response_format(typed::spec::<T>()?);
        let response = self
            .client
            .exec_chat(call.target, request(prompt), Some(&options))
            .await
            .map_err(|error| provider_error(&call.id, &error))?;
        let text = response.first_text().ok_or_else(|| ModelError::Empty {
            model: call.id.to_owned(),
        })?;
        typed::parse(&call.id, text)
    }

    /// Streams the reply. The last item is [`Delta::Done`] unless the stream fails first.
    pub async fn stream(
        &self,
        model: &str,
        prompt: &Prompt,
    ) -> Result<impl Stream<Item = Result<Delta, ModelError>> + Send + use<>, ModelError> {
        let call = self.call(model)?;
        let options = options(prompt).with_capture_usage(true);
        let response = self
            .client
            .exec_chat_stream(call.target, request(prompt), Some(&options))
            .await
            .map_err(|error| provider_error(&call.id, &error))?;
        let id = call.id;
        Ok(response.stream.filter_map(move |event| {
            let delta = match event {
                Ok(ChatStreamEvent::Chunk(chunk)) => Some(Ok(Delta::Text(chunk.content))),
                Ok(ChatStreamEvent::ReasoningChunk(chunk)) => {
                    Some(Ok(Delta::Reasoning(chunk.content)))
                }
                Ok(ChatStreamEvent::End(end)) => Some(Ok(Delta::Done {
                    usage: end.captured_usage.as_ref().map(usage).unwrap_or_default(),
                })),
                // Start and heartbeats carry nothing. Tool calls and thought signatures arrive
                // only when tools are sent, which comes with the agent loop.
                Ok(_) => None,
                Err(error) => Some(Err(provider_error(&id, &error))),
            };
            std::future::ready(delta)
        }))
    }

    fn call(&self, model: &str) -> Result<Call, ModelError> {
        let target = gateway::resolve(
            &self.catalog,
            model,
            self.config.gateway,
            self.config.root.as_deref(),
        )?;
        Ok(Call {
            id: target.id,
            target: ServiceTarget {
                endpoint: Endpoint::from_owned(target.base_url),
                auth: AuthData::from_single(self.config.key.expose()),
                model: ModelIden::new(adapter(target.protocol), target.model),
            },
        })
    }
}

fn adapter(protocol: Protocol) -> AdapterKind {
    match protocol {
        Protocol::OpenAi => AdapterKind::OpenAI,
        Protocol::Anthropic => AdapterKind::Anthropic,
        Protocol::Gemini => AdapterKind::Gemini,
        Protocol::OpenRouter => AdapterKind::OpenRouter,
    }
}

fn request(prompt: &Prompt) -> ChatRequest {
    let messages = prompt
        .messages
        .iter()
        .map(|message| match message.speaker {
            Speaker::Person => ChatMessage::user(message.text.as_str()),
            Speaker::Spade => ChatMessage::assistant(message.text.as_str()),
        })
        .collect();
    let request = ChatRequest::new(messages);
    match &prompt.system {
        Some(system) => request.with_system(system.as_str()),
        None => request,
    }
}

fn options(prompt: &Prompt) -> ChatOptions {
    let options = ChatOptions::default();
    match prompt.max_tokens {
        Some(value) => options.with_max_tokens(value),
        None => options,
    }
}

fn usage(usage: &genai::chat::Usage) -> Usage {
    let count = |value: Option<i32>| value.and_then(|v| u32::try_from(v).ok());
    Usage {
        input_tokens: count(usage.prompt_tokens),
        output_tokens: count(usage.completion_tokens),
    }
}

fn provider_error(model: &str, error: &genai::Error) -> ModelError {
    ModelError::Provider {
        model: model.to_owned(),
        message: error.to_string(),
    }
}
