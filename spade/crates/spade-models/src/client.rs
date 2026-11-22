//! The I/O shell: turns Spade prompts into calls on the endpoint a model reference names.

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, RwLock};

use futures_util::{Stream, StreamExt};
use genai::chat::{
    ChatMessage, ChatOptions, ChatRequest, ChatStreamEvent, ContentPart, MessageContent,
    ReasoningEffort, Tool, ToolCall as SdkCall, ToolResponse,
};
use genai::resolver::{AuthData, Endpoint as ServiceEndpoint};
use genai::{Client, Headers, ModelIden, ServiceTarget};
use schemars::JsonSchema;
use serde::de::DeserializeOwned;

use crate::catalog::{Catalog, Endpoint, Model, Price, Role};
use crate::chatgpt::{self, SignIn};
use crate::effort::{self, Refusals, Sent};
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
    refusals: Refusals,
    /// Access tokens for accounts that sign in (ADR 0214), set by the server.
    bearers: Arc<RwLock<Option<Bearers>>>,
}

/// What [`Bearers`] answers: a token, or one plain line saying why there is none.
pub type BearerFuture = Pin<Box<dyn Future<Output = Result<String, String>> + Send>>;

/// Finds a signed-in account's access token by account (endpoint) id, refreshing it when it is
/// about to end, and a new one when the backend refused one. A token only ever goes to
/// `backend`'s origin, whatever address the account says. Tokens are never printed.
#[derive(Clone)]
pub struct Bearers {
    backend: String,
    find: Arc<dyn Fn(String) -> BearerFuture + Send + Sync>,
    rejected: Arc<dyn Fn(String, String) -> BearerFuture + Send + Sync>,
}

impl Bearers {
    /// `find(account)` and `rejected(account, refused token)`, for calls to `backend` only.
    pub fn new(
        backend: impl Into<String>,
        find: impl Fn(String) -> BearerFuture + Send + Sync + 'static,
        rejected: impl Fn(String, String) -> BearerFuture + Send + Sync + 'static,
    ) -> Self {
        Self {
            backend: backend.into(),
            find: Arc::new(find),
            rejected: Arc::new(rejected),
        }
    }
}

impl std::fmt::Debug for Bearers {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Bearers(…)")
    }
}

/// A streamed reply, its first item already read.
type Deltas = Pin<Box<dyn Stream<Item = Result<Delta, ModelError>> + Send>>;

/// Sent to an endpoint that needs no key (a local server), which ignores it.
pub const KEYLESS: &str = "no-key";

/// A model resolved for one call.
struct Call {
    reference: String,
    target: ServiceTarget,
    options: ChatOptions,
    /// The endpoint answers only streamed requests (a ChatGPT account).
    streamed_only: bool,
    /// For a signed-in account: it, and the token this call carries.
    signed: Option<(Endpoint, String)>,
}

/// A model resolved once for every try of one call (ADR 0213): a try that drops the effort goes
/// to the same endpoint, with the same key and model, even if the person edits the endpoint
/// meanwhile.
struct Resolved {
    reference: String,
    target: ServiceTarget,
    /// The headers, without a limit or an effort.
    options: ChatOptions,
    /// The answer's limit, as the prompt set it.
    answer: Option<u32>,
    /// The SDK's effort; `None` sends none at all.
    effort: Option<ReasoningEffort>,
    room: u32,
    key: String,
    /// The endpoint answers only streamed requests (a ChatGPT account).
    streamed_only: bool,
    /// For a signed-in account: it, and the token this call carries.
    signed: Option<(Endpoint, String)>,
}

impl Resolved {
    fn call(&self, send: Sent) -> Call {
        let mut options = self.options.clone();
        let effort = self.effort.clone().filter(|_| send != Sent::Nothing);
        let room = if effort.is_some() && send == Sent::Full {
            self.room
        } else {
            0
        };
        // The ChatGPT backend refuses an output limit.
        if let Some(answer) = self.answer.filter(|_| !self.streamed_only) {
            options = options.with_max_tokens(answer.saturating_add(room));
        }
        if let Some(effort) = effort {
            options = options.with_reasoning_effort(effort);
        }
        Call {
            reference: self.reference.clone(),
            target: self.target.clone(),
            options,
            streamed_only: self.streamed_only,
            signed: self.signed.clone(),
        }
    }
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
            refusals: Refusals::default(),
            bearers: Arc::default(),
        })
    }

    /// How much of an endpoint's model list is read, and for how long.
    pub fn with_listing_bounds(mut self, bounds: ListBounds) -> Self {
        self.listing = bounds;
        self
    }

    /// Where signed-in accounts' tokens come from (ADR 0214).
    pub fn set_bearers(&self, bearers: Bearers) {
        *self.bearers.write().unwrap_or_else(|p| p.into_inner()) = Some(bearers);
    }

    /// Where a signed-in account's token may go, checked against its address: never anywhere
    /// but the backend it was issued for.
    fn bearers_for(&self, endpoint: &Endpoint) -> Result<Bearers, ModelError> {
        let refuse = |message: &str| ModelError::SignIn {
            endpoint: endpoint.id.clone(),
            message: message.to_owned(),
        };
        let bearers = self
            .bearers
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
            .ok_or_else(|| refuse("this Spade cannot use sign-in accounts"))?;
        if !crate::base_url::same_origin(&endpoint.base_url, &bearers.backend) {
            return Err(refuse(
                "this account's address is not the ChatGPT backend, so its sign-in is not sent there",
            ));
        }
        Ok(bearers)
    }

    /// The access token for a signed-in account, or why there is none.
    async fn bearer(&self, endpoint: &Endpoint) -> Result<String, ModelError> {
        let bearers = self.bearers_for(endpoint)?;
        (bearers.find)(endpoint.id.clone())
            .await
            .map_err(|message| ModelError::SignIn {
                endpoint: endpoint.id.clone(),
                message,
            })
    }

    /// After the backend refused `token`: a new token for the account (refreshed once, however
    /// many calls report the same refusal).
    async fn bearer_after_rejection(
        &self,
        endpoint: &Endpoint,
        token: &str,
    ) -> Result<String, ModelError> {
        let bearers = self.bearers_for(endpoint)?;
        (bearers.rejected)(endpoint.id.clone(), token.to_owned())
            .await
            .map_err(|message| ModelError::SignIn {
                endpoint: endpoint.id.clone(),
                message,
            })
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
        if let Some(SignIn::ChatGpt { account_id }) = &endpoint.sign_in {
            let token = self
                .bearer(&endpoint)
                .await
                .map_err(|e| ModelError::Listing {
                    endpoint: endpoint.id.clone(),
                    message: e.to_string(),
                })?;
            let mut signed = endpoint.clone();
            signed.headers.extend(chatgpt::headers(account_id, None));
            return listing::fetch(
                &self.http,
                &signed,
                Some(&token),
                &[("client_version", chatgpt::CLIENT_VERSION)],
                self.listing,
            )
            .await
            .map_err(|message| ModelError::Listing {
                endpoint: endpoint.id.clone(),
                message,
            });
        }
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
        listing::fetch(&self.http, &endpoint, key.as_deref(), &[], self.listing)
            .await
            .map_err(|message| ModelError::Listing {
                endpoint: endpoint.id.clone(),
                message,
            })
    }

    /// Runs `once` on the call for `reference`, with the prompt's effort. An endpoint that
    /// refuses the request (`400`, `422`) is asked again without the thinking's room, then
    /// without the effort; what answers is what that model, endpoint and effort are sent from
    /// then on (ADR 0213), so a turn never fails over a setting. When no try answers, the first
    /// refusal is the error.
    async fn thinking<T, F, Fut>(
        &self,
        reference: &str,
        prompt: &Prompt,
        once: F,
    ) -> Result<T, ModelError>
    where
        F: Fn(Call) -> Fut,
        Fut: Future<Output = Result<T, ModelError>>,
    {
        let resolved = self.resolve_call(reference, prompt).await?;
        let signed = resolved.signed.clone();
        match self.tries(resolved, &once).await {
            // A signed-in account's token refused before anything streamed: a new token once
            // (refreshed once, however many calls report it), and the call once more on the
            // same account.
            Err(error) if error.status() == Some(401) => {
                let Some((endpoint, token)) = signed else {
                    return Err(error);
                };
                self.bearer_after_rejection(&endpoint, &token).await?;
                let again = self.resolve_call(reference, prompt).await?;
                self.tries(again, &once).await
            }
            other => other,
        }
    }

    /// [`Models::thinking`]'s tries on one resolved call.
    async fn tries<T, F, Fut>(&self, resolved: Resolved, once: &F) -> Result<T, ModelError>
    where
        F: Fn(Call) -> Fut,
        Fut: Future<Output = Result<T, ModelError>>,
    {
        let mut send = if resolved.effort.is_some() {
            self.refusals.start(&resolved.key)
        } else {
            Sent::Nothing
        };
        let refusal = match once(resolved.call(send)).await {
            Err(error) if effort::refused(&error) => error,
            other => return other,
        };
        while let Some(next) = send.after_refusal(resolved.room > 0 && resolved.answer.is_some()) {
            send = next;
            match once(resolved.call(send)).await {
                Ok(answered) => {
                    self.refusals.remember(&resolved.key, send);
                    return Ok(answered);
                }
                Err(error) if effort::refused(&error) => {}
                // Anything else (a rate limit, an outage) says nothing about the setting.
                Err(_) => break,
            }
        }
        Err(refusal)
    }

    pub async fn chat(&self, reference: &str, prompt: &Prompt) -> Result<Reply, ModelError> {
        self.thinking(reference, prompt, |call| self.chat_once(call, prompt))
            .await
    }

    async fn chat_once(&self, call: Call, prompt: &Prompt) -> Result<Reply, ModelError> {
        if call.streamed_only {
            let reference = call.reference.clone();
            return fold(reference, self.stream_once(call, prompt, None).await?).await;
        }
        let response = self
            .client
            .exec_chat(call.target, request(prompt, false), Some(&call.options))
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
        self.thinking(reference, prompt, |call| self.generate_once(call, prompt))
            .await
    }

    async fn generate_once<T>(
        &self,
        call: Call,
        prompt: &Prompt,
    ) -> Result<Generated<T>, ModelError>
    where
        T: JsonSchema + DeserializeOwned,
    {
        if call.streamed_only {
            let reference = call.reference.clone();
            let stream = self
                .stream_once(call, prompt, Some(typed::spec::<T>()?.into()))
                .await?;
            let reply = fold(reference.clone(), stream).await?;
            return Ok(Generated {
                value: typed::parse(&reference, &reply.text)
                    .map_err(|e| error::charged(e, reply.usage))?,
                usage: reply.usage,
            });
        }
        let options = call.options.with_response_format(typed::spec::<T>()?);
        let response = self
            .client
            .exec_chat(call.target, request(prompt, false), Some(&options))
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

    /// Streams the reply. The last item is [`Delta::Done`] unless the stream fails first. The
    /// first item is read before this returns, so an endpoint that refuses the request before
    /// answering fails here.
    pub async fn stream(
        &self,
        reference: &str,
        prompt: &Prompt,
    ) -> Result<impl Stream<Item = Result<Delta, ModelError>> + Send + use<>, ModelError> {
        self.thinking(reference, prompt, |call| {
            self.stream_once(call, prompt, None)
        })
        .await
    }

    async fn stream_once(
        &self,
        call: Call,
        prompt: &Prompt,
        format: Option<genai::chat::ChatResponseFormat>,
    ) -> Result<Deltas, ModelError> {
        let mut stream = Box::pin(self.open_stream(call, prompt, format).await?);
        match stream.next().await {
            Some(Err(error)) => Err(error),
            first => Ok(Box::pin(futures_util::stream::iter(first).chain(stream))),
        }
    }

    async fn open_stream(
        &self,
        call: Call,
        prompt: &Prompt,
        format: Option<genai::chat::ChatResponseFormat>,
    ) -> Result<impl Stream<Item = Result<Delta, ModelError>> + Send + use<>, ModelError> {
        let signed = call.signed.is_some();
        let mut options = call.options;
        if let Some(format) = format {
            options = options.with_response_format(format);
        }
        let options = options
            .with_capture_usage(true)
            .with_capture_tool_calls(true)
            .with_capture_content(true)
            .with_capture_reasoning_content(true);
        let response = self
            .client
            .exec_chat_stream(
                call.target,
                request(prompt, call.streamed_only),
                Some(&options),
            )
            .await
            .map_err(|error| failure::read_as(&call.reference, &error, false, signed))?;
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
                    Err(error) => Some(vec![Err(failure::read_as(
                        &reference, &error, answered, signed,
                    ))]),
                };
                std::future::ready(delta)
            })
            .flat_map(futures_util::stream::iter))
    }

    /// `reference` resolved for a call of `prompt`.
    async fn resolve_call(&self, reference: &str, prompt: &Prompt) -> Result<Resolved, ModelError> {
        let (endpoint, model) = self
            .resolve(reference)
            .ok_or_else(|| ModelError::UnknownModel(reference.to_owned()))?;
        let signed = match &endpoint.sign_in {
            Some(SignIn::ChatGpt { account_id }) => Some((
                self.bearer(&endpoint).await?,
                chatgpt::headers(account_id, prompt.session.as_deref()),
            )),
            None => None,
        };
        let auth = if let Some((token, _)) = &signed {
            AuthData::from_single(token.clone())
        } else if endpoint.needs_key {
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
        // A model id that names its own effort (`o3-high`) keeps it: the SDK reads the suffix
        // only when no effort is set, so a role's would change the model sent.
        let named = ReasoningEffort::from_model_name(&model.id).0.is_some();
        let effort = if named {
            None
        } else {
            prompt.effort.sdk(endpoint.format)
        };
        let mut headers = endpoint.headers.clone();
        headers.push(("user-agent".to_owned(), self.user_agent.clone()));
        if let (Some(name), Some(session)) = (&endpoint.session_header, &prompt.session) {
            headers.push((name.clone(), session.clone()));
        }
        let streamed_only = signed.is_some();
        let token = signed
            .as_ref()
            .map(|(token, _)| (endpoint.clone(), token.clone()));
        if let Some((_, extra)) = signed {
            headers.extend(extra);
        }
        options = options.with_extra_headers(Headers::from(headers));
        Ok(Resolved {
            reference: reference.to_owned(),
            target: ServiceTarget {
                endpoint: ServiceEndpoint::from_owned(endpoint.base_url.clone()),
                auth,
                model: ModelIden::new(endpoint.format.adapter(), model.id.as_str()),
            },
            options,
            answer: prompt.max_tokens,
            room: prompt.effort.room(),
            key: effort::refusal_key(
                endpoint.format,
                &endpoint.base_url,
                &model.id,
                prompt.effort,
            ),
            effort,
            streamed_only,
            signed: token,
        })
    }
}

/// A whole reply read off a stream, for an account whose backend only streams.
async fn fold(
    reference: String,
    stream: impl Stream<Item = Result<Delta, ModelError>> + Send,
) -> Result<Reply, ModelError> {
    let mut stream = std::pin::pin!(stream);
    let mut reply = Reply {
        model: reference,
        text: String::new(),
        calls: Vec::new(),
        thoughts: Vec::new(),
        usage: Usage::default(),
    };
    while let Some(delta) = stream.next().await {
        match delta? {
            Delta::Text(text) => reply.text.push_str(&text),
            Delta::Call(call) => reply.calls.push(call),
            Delta::Done { usage, thoughts } => {
                reply.usage = usage;
                reply.thoughts = thoughts;
            }
            Delta::Reasoning(_) => {}
        }
    }
    if reply.text.is_empty() && reply.calls.is_empty() {
        return Err(ModelError::Empty {
            model: reply.model,
            usage: reply.usage,
        });
    }
    Ok(reply)
}

/// The request for `prompt`. `instructed`: the endpoint needs instructions even when the prompt
/// has none (the ChatGPT backend refuses a request without them).
fn request(prompt: &Prompt, instructed: bool) -> ChatRequest {
    let mut request = ChatRequest::new(prompt.messages.iter().map(message).collect());
    match &prompt.system {
        Some(system) => request = request.with_system(system.as_str()),
        None if instructed => request = request.with_system(""),
        None => {}
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
