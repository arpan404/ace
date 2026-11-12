//! The I/O shell: turns Spade prompts into calls on the endpoint a model reference names.

use std::sync::{Arc, RwLock};

use futures_util::{Stream, StreamExt};
use genai::chat::{
    ChatMessage, ChatOptions, ChatRequest, ChatStreamEvent, ContentPart, MessageContent, Tool,
    ToolCall as SdkCall, ToolResponse,
};
use genai::resolver::{AuthData, Endpoint as ServiceEndpoint};
use genai::{Client, Headers, ModelIden, ServiceTarget};
use schemars::JsonSchema;
use serde::de::DeserializeOwned;

use crate::catalog::{Catalog, Endpoint, Model, Price, Role};
use crate::error::{self, ModelError};
use crate::listing::{self, ListBounds, Listed};
use crate::prompt::{Delta, Generated, Message, Prompt, Reply, ToolCall, Usage};
use crate::{failure, thoughts, typed};
use spade_keys::{KeyRequest, Keys};

/// Calls models on the person's endpoints. Starts with the presets' endpoints; the server sets the
/// person's own list with [`Models::set_endpoints`] and again whenever it changes.
#[derive(Debug, Clone)]
pub struct Models {
    client: Client,
    catalog: Arc<Catalog>,
    endpoints: Arc<RwLock<Arc<Vec<Endpoint>>>>,
    keys: Keys,
    /// `spade/<version>`, sent as every request's User-Agent.
    user_agent: String,
    http: reqwest::Client,
    listing: ListBounds,
}

/// Sent to an endpoint that needs no key (a local server), which ignores it.
pub const KEYLESS: &str = "no-key";

/// A model resolved for one call.
struct Call {
    reference: String,
    target: ServiceTarget,
    options: ChatOptions,
}

impl Models {
    /// `version` is Spade's own, sent as `User-Agent: spade/<version>` on every request.
    pub fn new(catalog: Catalog, keys: Keys, version: &str) -> Result<Self, ModelError> {
        let user_agent = format!("spade/{version}");
        // Every call carries a key or the person's headers, so no redirect is ever followed: one
        // to another host would hand them over. A redirect answers as an error instead.
        let http = genai::WebConfig::default()
            .apply_to_builder(reqwest::Client::builder())
            .user_agent(user_agent.as_str())
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|error| ModelError::Setup(error.to_string()))?;
        let client = Client::builder()
            .with_reqwest(http.clone())
            .build()
            .map_err(|error| ModelError::Setup(error.to_string()))?;
        let endpoints = Arc::new(RwLock::new(Arc::new(catalog.endpoints().to_vec())));
        Ok(Self {
            client,
            catalog: Arc::new(catalog),
            endpoints,
            keys,
            user_agent,
            http,
            listing: ListBounds::default(),
        })
    }

    /// How much of an endpoint's model list is read, and for how long.
    pub fn with_listing_bounds(mut self, bounds: ListBounds) -> Self {
        self.listing = bounds;
        self
    }

    /// The shipped presets: endpoint templates and known model facts.
    pub fn catalog(&self) -> &Catalog {
        &self.catalog
    }

    /// The `endpoint/model` the presets set for `role`, if they set one.
    pub fn for_role(&self, role: Role) -> Option<&str> {
        self.catalog.role(role)
    }

    /// Replaces the endpoints calls go to: the person's own (ADR 0126).
    pub fn set_endpoints(&self, endpoints: Vec<Endpoint>) {
        *self.endpoints.write().unwrap_or_else(|p| p.into_inner()) = Arc::new(endpoints);
    }

    /// The endpoints calls go to now.
    pub fn endpoints(&self) -> Arc<Vec<Endpoint>> {
        self.endpoints
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    pub fn endpoint(&self, id: &str) -> Option<Endpoint> {
        self.endpoints().iter().find(|e| e.id == id).cloned()
    }

    /// What is known about model `id` on `endpoint`: its own models (saved, or from the preset it
    /// was made from), else any preset's facts for that id without its price (another
    /// endpoint's price would be wrong here), else defaults. A model nobody saved still works.
    pub fn facts(&self, endpoint: &Endpoint, id: &str) -> Model {
        if let Some(model) = endpoint.models.iter().find(|m| m.id == id) {
            return model.clone();
        }
        match self.catalog.facts(id) {
            Some(known) => Model {
                id: id.to_owned(),
                price: None,
                ..known.clone()
            },
            None => Model::unknown(id),
        }
    }

    /// Finds `endpoint/model` (split at the first `/`) on the person's endpoints.
    pub fn resolve(&self, reference: &str) -> Option<(Endpoint, Model)> {
        let (endpoint_id, model_id) = reference.split_once('/')?;
        if model_id.is_empty() {
            return None;
        }
        let endpoint = self.endpoint(endpoint_id)?;
        let model = self.facts(&endpoint, model_id);
        Some((endpoint, model))
    }

    /// What `reference` costs; `None` when unpriced, flat-rate or local.
    pub fn price(&self, reference: &str) -> Option<Price> {
        self.resolve(reference).and_then(|(_, model)| model.price)
    }

    /// Whether a call to `endpoint` would have a key (or needs none).
    pub fn has_key(&self, endpoint: &Endpoint) -> bool {
        !endpoint.needs_key || self.key(endpoint).is_some()
    }

    /// Whether a key for `endpoint` is set (keychain or environment), whatever it needs.
    pub fn key_found(&self, endpoint: &Endpoint) -> bool {
        self.key(endpoint).is_some()
    }

    /// The key for a call, read off the async workers (see [`Keys::find`]).
    async fn key_for_call(&self, endpoint: &Endpoint) -> Option<String> {
        self.keys
            .find(&endpoint.id, endpoint.key_env.as_deref())
            .await
    }

    /// The key for a media call, read off the async workers.
    pub(crate) async fn key_for(&self, endpoint: &Endpoint) -> Option<String> {
        self.key_for_call(endpoint).await
    }

    /// The HTTP client every call goes through (no redirects followed).
    pub(crate) fn http(&self) -> &reqwest::Client {
        &self.http
    }

    fn key(&self, endpoint: &Endpoint) -> Option<String> {
        self.keys.get(KeyRequest {
            endpoint: &endpoint.id,
            env: endpoint.key_env.as_deref(),
        })
    }

    /// The models `endpoint_id` lists itself, live.
    pub async fn list(&self, endpoint_id: &str) -> Result<Vec<Listed>, ModelError> {
        let endpoint = self
            .endpoint(endpoint_id)
            .ok_or_else(|| ModelError::UnknownModel(format!("{endpoint_id}/")))?;
        let key = if endpoint.needs_key {
            Some(
                self.key_for_call(&endpoint)
                    .await
                    .ok_or_else(|| ModelError::MissingKey {
                        endpoint: endpoint.id.clone(),
                        var: endpoint.key_env.clone(),
                    })?,
            )
        } else {
            None
        };
        listing::fetch(&self.http, &endpoint, key.as_deref(), self.listing)
            .await
            .map_err(|message| ModelError::Listing {
                endpoint: endpoint.id.clone(),
                message,
            })
    }

    pub async fn chat(&self, reference: &str, prompt: &Prompt) -> Result<Reply, ModelError> {
        let call = self.call(reference, prompt).await?;
        let response = self
            .client
            .exec_chat(call.target, request(prompt), Some(&call.options))
            .await
            .map_err(|error| failure::read(&call.reference, &error, false))?;
        let usage = usage(&response.usage);
        let calls: Vec<ToolCall> = response
            .content
            .tool_calls()
            .into_iter()
            .map(from_sdk)
            .collect();
        let thoughts = thoughts::read(
            Some(&response.content),
            response.reasoning_content.as_deref(),
        );
        let text = response.content.joined_texts().unwrap_or_default();
        if text.is_empty() && calls.is_empty() {
            return Err(ModelError::Empty {
                model: call.reference,
                usage,
            });
        }
        Ok(Reply {
            model: call.reference,
            text,
            calls,
            thoughts,
            usage,
        })
    }

    /// Asks for a reply shaped as `T` and parses it.
    pub async fn generate<T>(
        &self,
        reference: &str,
        prompt: &Prompt,
    ) -> Result<Generated<T>, ModelError>
    where
        T: JsonSchema + DeserializeOwned,
    {
        let call = self.call(reference, prompt).await?;
        let options = call.options.with_response_format(typed::spec::<T>()?);
        let response = self
            .client
            .exec_chat(call.target, request(prompt), Some(&options))
            .await
            .map_err(|error| failure::read(&call.reference, &error, false))?;
        let cost = usage(&response.usage);
        let text = response.first_text().ok_or_else(|| ModelError::Empty {
            model: call.reference.clone(),
            usage: cost,
        })?;
        Ok(Generated {
            value: typed::parse(&call.reference, text).map_err(|e| error::charged(e, cost))?,
            usage: cost,
        })
    }

    /// Streams the reply. The last item is [`Delta::Done`] unless the stream fails first.
    pub async fn stream(
        &self,
        reference: &str,
        prompt: &Prompt,
    ) -> Result<impl Stream<Item = Result<Delta, ModelError>> + Send + use<>, ModelError> {
        let call = self.call(reference, prompt).await?;
        let options = call
            .options
            .with_capture_usage(true)
            .with_capture_tool_calls(true)
            .with_capture_content(true)
            .with_capture_reasoning_content(true);
        let response = self
            .client
            .exec_chat_stream(call.target, request(prompt), Some(&options))
            .await
            .map_err(|error| failure::read(&call.reference, &error, false))?;
        let reference = call.reference;
        // Whether the endpoint began a successful answer: a failure before that never reached a
        // model and may be sent again; one after it is the model's.
        let mut answered = false;
        Ok(response
            .stream
            .filter_map(move |event| {
                // The SDK starts every stream with `Start` before the request is even sent, so
                // only what came after it shows the endpoint answered.
                if matches!(&event, Ok(e) if !matches!(e, ChatStreamEvent::Start)) {
                    answered = true;
                }
                let delta = match event {
                    Ok(ChatStreamEvent::Chunk(chunk)) => Some(vec![Ok(Delta::Text(chunk.content))]),
                    Ok(ChatStreamEvent::ReasoningChunk(chunk)) => {
                        Some(vec![Ok(Delta::Reasoning(chunk.content))])
                    }
                    Ok(ChatStreamEvent::End(end)) => {
                        // Complete tool calls are only known at the end, once arguments are whole.
                        let mut out: Vec<Result<Delta, ModelError>> = end
                            .captured_tool_calls()
                            .unwrap_or_default()
                            .into_iter()
                            .map(|call| Ok(Delta::Call(from_sdk(call))))
                            .collect();
                        out.push(Ok(Delta::Done {
                            usage: end.captured_usage.as_ref().map(usage).unwrap_or_default(),
                            thoughts: thoughts::read(
                                end.captured_content.as_ref(),
                                end.captured_reasoning_content.as_deref(),
                            ),
                        }));
                        Some(out)
                    }
                    // Start, heartbeats and partial tool-call chunks carry nothing the caller needs.
                    Ok(_) => None,
                    Err(error) => Some(vec![Err(failure::read(&reference, &error, answered))]),
                };
                std::future::ready(delta)
            })
            .flat_map(futures_util::stream::iter))
    }

    async fn call(&self, reference: &str, prompt: &Prompt) -> Result<Call, ModelError> {
        let (endpoint, model) = self
            .resolve(reference)
            .ok_or_else(|| ModelError::UnknownModel(reference.to_owned()))?;
        let auth = if endpoint.needs_key {
            let key = self
                .key_for_call(&endpoint)
                .await
                .ok_or_else(|| ModelError::MissingKey {
                    endpoint: endpoint.id.clone(),
                    var: endpoint.key_env.clone(),
                })?;
            AuthData::from_single(key)
        } else {
            // The SDK's OpenAI path needs some key; local servers ignore this one.
            AuthData::from_single(KEYLESS)
        };
        let mut options = ChatOptions::default();
        if let Some(value) = prompt.max_tokens {
            options = options.with_max_tokens(value);
        }
        let mut headers = endpoint.headers.clone();
        headers.push(("user-agent".to_owned(), self.user_agent.clone()));
        if let (Some(name), Some(session)) = (&endpoint.session_header, &prompt.session) {
            headers.push((name.clone(), session.clone()));
        }
        options = options.with_extra_headers(Headers::from(headers));
        Ok(Call {
            reference: reference.to_owned(),
            target: ServiceTarget {
                endpoint: ServiceEndpoint::from_owned(endpoint.base_url.clone()),
                auth,
                model: ModelIden::new(endpoint.format.adapter(), model.id.as_str()),
            },
            options,
        })
    }
}

fn request(prompt: &Prompt) -> ChatRequest {
    let mut request = ChatRequest::new(prompt.messages.iter().map(message).collect());
    if let Some(system) = &prompt.system {
        request = request.with_system(system.as_str());
    }
    if !prompt.tools.is_empty() {
        request = request.with_tools(prompt.tools.iter().map(|tool| {
            Tool::new(tool.name.clone())
                .with_description(tool.description.clone())
                .with_schema(tool.schema.clone())
        }));
    }
    request
}

fn message(message: &Message) -> ChatMessage {
    match message {
        Message::Person { text, images } if images.is_empty() => ChatMessage::user(text.as_str()),
        Message::Person { text, images } => {
            let mut parts = vec![ContentPart::Text(text.clone())];
            parts.extend(images.iter().map(|image| {
                ContentPart::from_binary_base64(image.media_type.clone(), image.data.clone(), None)
            }));
            ChatMessage::user(MessageContent::from_parts(parts))
        }
        Message::Spade {
            text,
            calls,
            thoughts,
        } if calls.is_empty() && thoughts.is_empty() => ChatMessage::assistant(text.as_str()),
        Message::Spade {
            text,
            calls,
            thoughts,
        } => {
            // Thoughts first, then text, then the calls: the order providers expect back.
            let mut parts: Vec<ContentPart> = thoughts::parts(thoughts);
            if !text.is_empty() {
                parts.push(ContentPart::Text(text.clone()));
            }
            parts.extend(calls.iter().map(|call| {
                ContentPart::ToolCall(SdkCall {
                    call_id: call.id.clone(),
                    fn_name: call.name.clone(),
                    fn_arguments: call.arguments.clone(),
                    thought_signatures: None,
                })
            }));
            ChatMessage::assistant(MessageContent::from_parts(parts))
        }
        Message::ToolResult {
            call_id,
            name,
            content,
            is_error,
        } => {
            let content = if *is_error {
                format!("Error: {content}")
            } else {
                content.clone()
            };
            ChatMessage::from(
                ToolResponse::new(call_id.as_str(), content).with_fn_name(name.as_str()),
            )
        }
    }
}

fn from_sdk(call: &SdkCall) -> ToolCall {
    ToolCall {
        id: call.call_id.clone(),
        name: call.fn_name.clone(),
        arguments: call.fn_arguments.clone(),
    }
}

fn usage(usage: &genai::chat::Usage) -> Usage {
    let count = |value: Option<i32>| value.and_then(|v| u32::try_from(v).ok());
    let details = usage.prompt_tokens_details.as_ref();
    Usage {
        input_tokens: count(usage.prompt_tokens),
        output_tokens: count(usage.completion_tokens),
        cache_read_tokens: count(details.and_then(|d| d.cached_tokens)),
        cache_write_tokens: count(details.and_then(|d| d.cache_creation_tokens)),
    }
}
