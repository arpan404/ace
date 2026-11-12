//! The person's endpoints and models (ADR 0126): stored in Spade's database, handed to
//! `spade_models::Models` whenever they change. Shipped presets are templates and model facts;
//! on first start, presets that already have a key become the person's endpoints.

use std::collections::HashSet;

use spade_models::base_url::{self, same_origin};
use spade_models::{Capability, Endpoint, Format, Listed, Model, ModelError, Role};
use spade_store::{StoreError, StoredEndpoint, StoredModel};

use super::Engine;

const FAST_MODEL: &str = "fast_model";
const NAME_CHARS: usize = 60;
const MOST_HEADERS: usize = 32;
const MOST_MODELS: usize = 2_000;

#[derive(Debug, thiserror::Error)]
pub enum EndpointError {
    #[error("no such endpoint")]
    NotFound,
    #[error("{0}")]
    Invalid(String),
    /// Agents still use it; names them.
    #[error("{} still use this endpoint; give them another model first", .0.join(", "))]
    InUse(Vec<String>),
    #[error("{0}")]
    MissingKey(String),
    /// The change would hand credentials to another host.
    #[error("{0}")]
    Conflict(String),
    /// The keychain could not be read or changed, so the change was not made.
    #[error("the keychain did not answer ({0}); nothing was changed, try again")]
    Keychain(String),
    /// The endpoint's own model list could not be read.
    #[error("{0}")]
    Listing(String),
    #[error(transparent)]
    Store(#[from] StoreError),
}

/// What adding or changing an endpoint takes. On change, `None` keeps the value.
#[derive(Debug, Clone, Default)]
pub struct EndpointInput {
    pub name: Option<String>,
    pub format: Option<String>,
    pub base_url: Option<String>,
    pub headers: Option<Vec<(String, String)>>,
    /// `Some(None)` clears it.
    pub session_header: Option<Option<String>>,
    pub needs_key: Option<bool>,
    pub preset: Option<String>,
}

/// A model to save, with any facts the person gave.
#[derive(Debug, Clone, Default)]
pub struct ModelInput {
    pub id: String,
    pub name: Option<String>,
    pub context: Option<u64>,
    pub capabilities: Option<Vec<String>>,
}

/// An endpoint with its models resolved (saved facts, else presets, else defaults).
#[derive(Debug, Clone)]
pub struct EndpointView {
    pub stored: StoredEndpoint,
    pub models: Vec<(Model, String)>,
}

fn invalid(text: impl Into<String>) -> EndpointError {
    EndpointError::Invalid(text.into())
}

fn header_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 100
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Headers that carry credentials. They are never stored with an endpoint: keys go to the
/// keychain (ADR 0119).
const CREDENTIAL_HEADERS: [&str; 7] = [
    "authorization",
    "proxy-authorization",
    "x-api-key",
    "api-key",
    "x-goog-api-key",
    "cookie",
    "set-cookie",
];

pub(super) fn is_credential_header(name: &str) -> bool {
    CREDENTIAL_HEADERS.contains(&name.trim().to_ascii_lowercase().as_str())
}

/// A preset's key binding and headers are for the preset's host: an endpoint made from it that
/// points elsewhere keeps neither, so they never go to another host.
pub(super) fn bind_to_origin(stored: &mut StoredEndpoint, preset: &Endpoint) {
    if same_origin(&stored.base_url, &preset.base_url) {
        return;
    }
    if stored.key_env == preset.key_env {
        stored.key_env = None;
    }
    if stored.headers == preset.headers {
        stored.headers.clear();
    }
}

/// A slug from `name`: lowercase letters, digits and dashes.
fn slug(name: &str) -> String {
    let mut out = String::new();
    for c in name.trim().to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let out: String = out.trim_matches('-').chars().take(40).collect();
    let out = out.trim_end_matches('-').to_owned();
    if out.is_empty() {
        "endpoint".to_owned()
    } else {
        out
    }
}

impl Engine {
    /// Hands the stored endpoints to the model client.
    pub(super) fn sync_endpoints(&self) -> Result<(), StoreError> {
        let endpoints = self
            .store
            .endpoints()?
            .into_iter()
            .filter_map(|stored| self.endpoint_of(&stored))
            .collect();
        self.models.set_endpoints(endpoints);
        Ok(())
    }

    /// The shipped preset `stored` was made from, if this build still ships it.
    pub(super) fn preset_of(&self, stored: &StoredEndpoint) -> Option<&Endpoint> {
        let id = stored.preset.as_deref()?;
        self.models
            .catalog()
            .endpoints()
            .iter()
            .find(|p| p.id == id)
    }

    /// The endpoint's models: what the person saved, then its preset's models they did not
    /// save, each with its facts resolved and where it came from.
    fn models_of(&self, stored: &StoredEndpoint) -> Vec<(Model, String)> {
        let preset = self.preset_of(stored);
        let mut models: Vec<(Model, String)> = stored
            .models
            .iter()
            .map(|m| (self.model_of(preset, m), m.source.clone()))
            .collect();
        for shipped in preset.map(|p| p.models.as_slice()).unwrap_or_default() {
            if !stored.models.iter().any(|m| m.id == shipped.id) {
                models.push((shipped.clone(), "preset".to_owned()));
            }
        }
        models
    }

    fn endpoint_of(&self, stored: &StoredEndpoint) -> Option<Endpoint> {
        let format = Format::parse(&stored.format)?;
        Some(Endpoint {
            id: stored.id.clone(),
            name: stored.name.clone(),
            format,
            base_url: stored.base_url.clone(),
            needs_key: stored.needs_key,
            key_env: stored.key_env.clone(),
            headers: stored.headers.clone(),
            session_header: stored.session_header.clone(),
            models: self.models_of(stored).into_iter().map(|(m, _)| m).collect(),
        })
    }

    /// A saved model with its gaps filled from the endpoint's own preset, else from any preset
    /// knowing that id (never its price: another endpoint's price would be wrong here), else
    /// defaults. Facts come from the binary at read time, so shipped corrections reach it.
    fn model_of(&self, own: Option<&Endpoint>, saved: &StoredModel) -> Model {
        let mine = own.and_then(|p| p.models.iter().find(|m| m.id == saved.id));
        let price = mine.and_then(|m| m.price);
        let preset = mine.or_else(|| self.models.catalog().facts(&saved.id));
        let fallback = Model::unknown(&saved.id);
        Model {
            id: saved.id.clone(),
            name: saved
                .name
                .clone()
                .or_else(|| preset.map(|p| p.name.clone()))
                .unwrap_or(fallback.name),
            context: saved
                .context
                .or_else(|| preset.and_then(|p| p.context))
                .or(fallback.context),
            capabilities: match &saved.capabilities {
                Some(names) => names.iter().filter_map(|n| Capability::parse(n)).collect(),
                None => preset.map_or(fallback.capabilities, |p| p.capabilities.clone()),
            },
            price,
        }
    }

    /// The model a new agent gets when none is chosen: the person's first usable model, else the
    /// presets' main role.
    /// A default chosen without reading any key: the first saved model, else the presets'
    /// main role.
    pub(super) fn keyless_default_model(&self) -> String {
        self.models
            .endpoints()
            .iter()
            .find_map(|e| e.models.first().map(|m| format!("{}/{}", e.id, m.id)))
            .or_else(|| self.models.for_role(Role::Main).map(str::to_owned))
            .unwrap_or_default()
    }

    pub fn default_model(&self) -> String {
        let endpoints = self.models.endpoints();
        endpoints
            .iter()
            .filter(|e| self.models.has_key(e))
            .find_map(|e| e.models.first().map(|m| format!("{}/{}", e.id, m.id)))
            .or_else(|| self.models.for_role(Role::Main).map(str::to_owned))
            .unwrap_or_default()
    }

    pub fn endpoint_views(&self) -> Result<Vec<EndpointView>, StoreError> {
        Ok(self
            .store
            .endpoints()?
            .into_iter()
            .map(|stored| EndpointView {
                models: self.models_of(&stored),
                stored,
            })
            .collect())
    }

    fn endpoint_view(&self, id: &str) -> Result<EndpointView, EndpointError> {
        self.endpoint_views()?
            .into_iter()
            .find(|e| e.stored.id == id)
            .ok_or(EndpointError::NotFound)
    }

    /// Whether the keychain holds a key for `id`. Keychain I/O can block (a prompt), so it is
    /// never done while `endpoint_lock` is held.
    fn key_in_keychain(&self, id: &str) -> Result<bool, EndpointError> {
        match &self.keychain {
            Some(keychain) => keychain
                .has(id)
                .map_err(|e| EndpointError::Keychain(e.to_string())),
            None => Ok(false),
        }
    }

    /// Adds an endpoint, from a preset or from scratch. Its id is a slug of its name.
    pub fn create_endpoint(&self, input: EndpointInput) -> Result<EndpointView, EndpointError> {
        let preset = match &input.preset {
            Some(id) => Some(
                self.models
                    .catalog()
                    .endpoints()
                    .iter()
                    .find(|p| &p.id == id)
                    .cloned()
                    .ok_or_else(|| invalid(format!("there is no preset {id}")))?,
            ),
            None => None,
        };
        let name = input
            .name
            .clone()
            .or_else(|| preset.as_ref().map(|p| p.name.clone()))
            .unwrap_or_default();
        let base = slug(&name);
        // The id is picked without the lock (an id that still has a key in the keychain is taken
        // too, so a new endpoint never inherits a key left from another, and reading the keychain
        // can block), then written under it if still free; else the next one is tried.
        let mut skip: HashSet<String> = HashSet::new();
        for _ in 0..5 {
            let taken: HashSet<String> =
                self.store.endpoints()?.into_iter().map(|e| e.id).collect();
            let mut id = None;
            for n in 1..=1_000 {
                let candidate = if n == 1 {
                    base.clone()
                } else {
                    format!("{base}-{n}")
                };
                if taken.contains(&candidate)
                    || skip.contains(&candidate)
                    || self.retiring(&candidate)
                {
                    continue;
                }
                if !self.key_in_keychain(&candidate)? {
                    id = Some(candidate);
                    break;
                }
            }
            let id = id.ok_or_else(|| invalid("too many endpoints share this name"))?;
            let mut stored = match &preset {
                Some(preset) => self.stored_preset(preset, id.clone(), name.clone()),
                None => StoredEndpoint {
                    id: id.clone(),
                    name: name.clone(),
                    format: String::new(),
                    base_url: String::new(),
                    headers: Vec::new(),
                    session_header: None,
                    needs_key: true,
                    key_env: None,
                    preset: None,
                    created_ms: self.now_ms(),
                    models: Vec::new(),
                },
            };
            apply(&mut stored, input.clone())?;
            if let Some(preset) = &preset {
                bind_to_origin(&mut stored, preset);
            }
            let _endpoints = self.endpoint_lock.lock().unwrap_or_else(|p| p.into_inner());
            if self.retiring(&id) {
                skip.insert(id);
                continue;
            }
            match self.store.insert_endpoint(&stored) {
                Ok(()) => {
                    self.sync_endpoints()?;
                    return self.endpoint_view(&stored.id);
                }
                // Taken while the keychain was read: try the next id.
                Err(StoreError::Exists(_)) => {
                    skip.insert(id);
                }
                Err(error) => return Err(error.into()),
            }
        }
        Err(EndpointError::Conflict(
            "endpoints with this name kept appearing; try again".to_owned(),
        ))
    }

    pub fn update_endpoint(
        &self,
        id: &str,
        input: EndpointInput,
    ) -> Result<EndpointView, EndpointError> {
        // Decided on a read without the lock (the host check reads the keychain, which can
        // block), then written under it only if the endpoint is still as read; else decided again.
        for _ in 0..5 {
            let before = self.endpoint_view(id)?.stored;
            let mut stored = before.clone();
            apply(&mut stored, input.clone())?;
            self.check_host_change(id, &before, &stored)?;
            let _endpoints = self.endpoint_lock.lock().unwrap_or_else(|p| p.into_inner());
            self.not_retiring(id)?;
            if self.endpoint_view(id)?.stored != before {
                continue;
            }
            self.store.update_endpoint(&stored)?;
            self.sync_endpoints()?;
            return self.endpoint_view(id);
        }
        Err(EndpointError::Conflict(
            "the endpoint kept changing; try again".to_owned(),
        ))
    }

    /// A key or headers belong to the host they were set for: never hand them to another.
    /// Checked whatever `needs_key` says now, since it can be turned back on later. Reads the
    /// keychain; never call it with `endpoint_lock` held.
    fn check_host_change(
        &self,
        id: &str,
        before: &StoredEndpoint,
        after: &StoredEndpoint,
    ) -> Result<(), EndpointError> {
        if same_origin(&after.base_url, &before.base_url) {
            return Ok(());
        }
        let was = base_url::origin(&before.base_url).unwrap_or_default();
        // The keychain itself, so a failed read refuses the change instead of passing as "no
        // key" (the old key would then go to the new host once the keychain is back).
        let key = self.key_in_keychain(id)?
            || self
                .endpoint_of(before)
                .is_some_and(|e| self.models.key_found(&e));
        if key {
            return Err(EndpointError::Conflict(format!(
                "this endpoint has a key for {was}; remove it first (DELETE /v1/keys/{id}{}) and \
                 add the new host's key after",
                before
                    .key_env
                    .as_ref()
                    .map(|v| format!(", and unset {v}"))
                    .unwrap_or_default()
            )));
        }
        if let Some(var) = &before.key_env {
            return Err(EndpointError::Conflict(format!(
                "this endpoint takes its key from {var}, which is for {was}; add a new endpoint for \
                 the other host instead"
            )));
        }
        if !after.headers.is_empty() {
            return Err(EndpointError::Conflict(format!(
                "this endpoint sends extra headers to {was}; send \"headers\": {{}} with the new \
                 base URL to drop them, then add the new host's"
            )));
        }
        Ok(())
    }

    /// Who keeps `id` in use: agents whose model is on it, and agents with a reply still open
    /// (or paused) on one of its models.
    fn endpoint_users(&self, id: &str) -> Result<Vec<String>, StoreError> {
        let mut users = self.store.agents_using_endpoint(id)?;
        for name in self.replies_on_endpoint(id)? {
            if !users.contains(&name) {
                users.push(name);
            }
        }
        Ok(users)
    }

    /// Deletes an endpoint no agent uses, its keychain key first. The fast model is cleared if it
    /// was on it.
    pub fn delete_endpoint(&self, id: &str) -> Result<(), EndpointError> {
        let row = {
            let _endpoints = self.endpoint_lock.lock().unwrap_or_else(|p| p.into_inner());
            if self.retiring(id) {
                return Err(EndpointError::Conflict(
                    "this endpoint is already being removed".to_owned(),
                ));
            }
            let Some(row) = self.store.endpoints()?.into_iter().find(|e| e.id == id) else {
                return Err(EndpointError::NotFound);
            };
            let users = self.endpoint_users(id)?;
            if !users.is_empty() {
                return Err(EndpointError::InUse(users));
            }
            // This delete owns the endpoint until it ends: no other delete, change, model save or
            // new endpoint with this id, and no agent can be moved onto it, while the key goes.
            self.retiring
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .insert(id.to_owned());
            row
        };
        // Released however the delete ends, a panic included, so the endpoint never stays
        // blocked until a restart.
        let _owned = Retiring {
            set: &self.retiring,
            id,
        };
        self.retire_endpoint(&row)
    }

    fn retire_endpoint(&self, row: &StoredEndpoint) -> Result<(), EndpointError> {
        let id = row.id.as_str();
        // The key goes first, outside the lock (it can block): if it cannot, the endpoint and its
        // id stay, so nothing can later pick up a key left behind.
        if let Some(keychain) = &self.keychain {
            keychain
                .delete(id)
                .map_err(|e| EndpointError::Keychain(e.to_string()))?;
        }
        let _endpoints = self.endpoint_lock.lock().unwrap_or_else(|p| p.into_inner());
        // Only the very row this delete started with, never a replacement under the same id.
        match self.store.endpoints()?.into_iter().find(|e| e.id == id) {
            None => return Ok(()),
            Some(now) if now != *row => {
                return Err(EndpointError::Conflict(
                    "the endpoint changed while it was being removed, so it was kept".to_owned(),
                ));
            }
            Some(_) => {}
        }
        if self
            .fast_model()?
            .is_some_and(|m| m.split_once('/').is_some_and(|(e, _)| e == id))
        {
            self.store.set_setting(FAST_MODEL, None)?;
        }
        self.store.delete_endpoint(id)?;
        self.listed
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(id);
        self.sync_endpoints()?;
        Ok(())
    }

    /// Refuses a change to an endpoint that is being deleted.
    fn not_retiring(&self, id: &str) -> Result<(), EndpointError> {
        if self.retiring(id) {
            return Err(EndpointError::Conflict(
                "this endpoint is being removed".to_owned(),
            ));
        }
        Ok(())
    }

    /// Whether `id` is being deleted.
    pub(super) fn retiring(&self, id: &str) -> bool {
        self.retiring
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .contains(id)
    }

    /// Names of agents with a reply open (or paused) on a model of `endpoint`.
    fn replies_on_endpoint(&self, endpoint: &str) -> Result<Vec<String>, StoreError> {
        let prefix = format!("{endpoint}/");
        let mut names = Vec::new();
        for agent in self.store.agents()? {
            if !self.activity(&agent.conversation)?.answering {
                continue;
            }
            let events = self.load(&agent.conversation)?;
            let open = spade_core::Transcript::fold(&events)
                .open_reply()
                .and_then(|m| m.reply.clone());
            let pinned = events.iter().any(|event| {
                matches!(
                    event,
                    spade_core::Event::Known(spade_core::event::Known::ReplyStarted { reply, model })
                        if Some(reply) == open.as_ref() && model.starts_with(&prefix)
                )
            });
            if pinned {
                names.push(agent.name);
            }
        }
        Ok(names)
    }

    /// The endpoint's own model list, live. Remembered, so a model saved from it counts as
    /// listed and takes the facts the endpoint gave.
    pub async fn list_endpoint_models(&self, id: &str) -> Result<Vec<Listed>, EndpointError> {
        if self.models.endpoint(id).is_none() {
            return Err(EndpointError::NotFound);
        }
        let listed = self.models.list(id).await.map_err(|error| match error {
            ModelError::MissingKey { .. } => EndpointError::MissingKey(error.to_string()),
            other => EndpointError::Listing(other.to_string()),
        })?;
        self.listed
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(id.to_owned(), listed.clone());
        Ok(listed)
    }

    /// Saves (or edits) a model on an endpoint: listed by it, or typed by the person.
    pub fn save_model(
        &self,
        endpoint: &str,
        input: ModelInput,
    ) -> Result<EndpointView, EndpointError> {
        let _endpoints = self.endpoint_lock.lock().unwrap_or_else(|p| p.into_inner());
        self.not_retiring(endpoint)?;
        let id = input.id.trim().to_owned();
        if id.is_empty() || id.len() > 300 || id.chars().any(char::is_control) {
            return Err(invalid(
                "the model id must be 1 to 300 characters on one line",
            ));
        }
        let name = input
            .name
            .map(|n| n.trim().to_owned())
            .filter(|n| !n.is_empty());
        if name.as_ref().is_some_and(|n| n.chars().count() > 200) {
            return Err(invalid("the model name must be at most 200 characters"));
        }
        if input.context.is_some_and(|c| c == 0 || c > 100_000_000) {
            return Err(invalid(
                "the context must be between 1 and 100,000,000 tokens",
            ));
        }
        if let Some(names) = &input.capabilities
            && let Some(unknown) = names.iter().find(|n| Capability::parse(n).is_none())
        {
            return Err(invalid(format!(
                "{unknown} is not a capability; use tools, images, reasoning or native-tool-search"
            )));
        }
        let view = self.endpoint_view(endpoint)?;
        if view.stored.models.len() >= MOST_MODELS && !view.stored.models.iter().any(|m| m.id == id)
        {
            return Err(invalid(format!(
                "an endpoint keeps at most {MOST_MODELS} models"
            )));
        }
        let listed: Option<Listed> = self
            .listed
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(endpoint)
            .and_then(|list| list.iter().find(|m| m.id == id).cloned());
        let previous = view.stored.models.iter().find(|m| m.id == id);
        let shipped = self
            .preset_of(&view.stored)
            .is_some_and(|p| p.models.iter().any(|m| m.id == id));
        let source = match (&listed, previous) {
            (Some(_), _) => "listed",
            (None, Some(previous)) => previous.source.as_str(),
            (None, None) if shipped => "preset",
            (None, None) => "typed",
        };
        let model = StoredModel {
            name: name
                .or_else(|| listed.as_ref().and_then(|l| l.name.clone()))
                .or_else(|| previous.and_then(|p| p.name.clone())),
            context: input
                .context
                .or_else(|| listed.as_ref().and_then(|l| l.context))
                .or_else(|| previous.and_then(|p| p.context)),
            capabilities: input
                .capabilities
                .or_else(|| {
                    listed.as_ref().and_then(|l| {
                        l.capabilities
                            .as_ref()
                            .map(|c| c.iter().map(|c| c.name().to_owned()).collect())
                    })
                })
                .or_else(|| previous.and_then(|p| p.capabilities.clone())),
            source: source.to_owned(),
            id,
        };
        if !self.store.put_model(endpoint, &model)? {
            return Err(EndpointError::NotFound);
        }
        self.sync_endpoints()?;
        self.endpoint_view(endpoint)
    }

    /// Forgets a saved model. Agents on it keep working, with defaults.
    pub fn delete_model(&self, endpoint: &str, id: &str) -> Result<bool, EndpointError> {
        let _endpoints = self.endpoint_lock.lock().unwrap_or_else(|p| p.into_inner());
        self.not_retiring(endpoint)?;
        let deleted = self.store.delete_model(endpoint, id)?;
        self.sync_endpoints()?;
        Ok(deleted)
    }

    /// The model for side jobs such as titles, when the person set one.
    pub fn fast_model(&self) -> Result<Option<String>, StoreError> {
        self.store.setting(FAST_MODEL)
    }

    pub fn set_fast_model(&self, model: Option<&str>) -> Result<(), EndpointError> {
        let model = model
            .map(|m| self.check_model(m))
            .transpose()
            .map_err(|e| invalid(e.to_string()))?;
        Ok(self.store.set_setting(FAST_MODEL, model.as_deref())?)
    }
}

/// Applies `input` to `stored`, checking every field.
fn apply(stored: &mut StoredEndpoint, input: EndpointInput) -> Result<(), EndpointError> {
    if let Some(name) = input.name {
        stored.name = name.trim().to_owned();
    }
    let count = stored.name.chars().count();
    if count == 0 || count > NAME_CHARS || stored.name.chars().any(char::is_control) {
        return Err(invalid(format!(
            "the name must be 1 to {NAME_CHARS} characters on one line"
        )));
    }
    if let Some(format) = input.format {
        if Format::parse(format.trim()).is_none() {
            return Err(invalid(
                "the format must be openai-chat, openai-responses or anthropic",
            ));
        }
        stored.format = format.trim().to_owned();
    }
    if Format::parse(&stored.format).is_none() {
        return Err(invalid(
            "the format must be openai-chat, openai-responses or anthropic",
        ));
    }
    if let Some(url) = input.base_url {
        stored.base_url = url;
    }
    stored.base_url = base_url::check(&stored.base_url).map_err(invalid)?;
    if let Some(headers) = input.headers {
        if headers.len() > MOST_HEADERS {
            return Err(invalid(format!("at most {MOST_HEADERS} extra headers")));
        }
        for (name, value) in &headers {
            if !header_name(name) {
                return Err(invalid(format!("{name:?} is not a header name")));
            }
            if is_credential_header(name) {
                return Err(invalid(format!(
                    "{name} carries a credential; set the key with PUT /v1/keys/{{endpoint}}, \
                     which keeps it in the keychain"
                )));
            }
            if value.len() > 4_096 || value.chars().any(char::is_control) {
                return Err(invalid(format!(
                    "the {name} header's value is too long or has line breaks"
                )));
            }
        }
        stored.headers = headers
            .into_iter()
            .map(|(k, v)| (k.to_ascii_lowercase(), v))
            .collect();
    }
    if let Some(session) = input.session_header {
        let session = session
            .map(|s| s.trim().to_ascii_lowercase())
            .filter(|s| !s.is_empty());
        if session.as_deref().is_some_and(|s| !header_name(s)) {
            return Err(invalid("the session header is not a header name"));
        }
        if session.as_deref().is_some_and(is_credential_header) {
            return Err(invalid(
                "the session header cannot be a header that carries a credential",
            ));
        }
        stored.session_header = session;
    }
    if let Some(needs_key) = input.needs_key {
        stored.needs_key = needs_key;
    }
    Ok(())
}

/// A delete's hold on its endpoint id, released when dropped.
struct Retiring<'a> {
    set: &'a std::sync::Mutex<std::collections::HashSet<String>>,
    id: &'a str,
}

impl Drop for Retiring<'_> {
    fn drop(&mut self) {
        self.set
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(self.id);
    }
}

#[cfg(test)]
mod tests {
    use super::{is_credential_header, slug};

    #[test]
    fn credential_headers_are_known_whatever_their_case() {
        for name in [
            "Authorization",
            "X-API-Key",
            "api-key",
            "Cookie",
            "Proxy-Authorization",
        ] {
            assert!(is_credential_header(name), "{name}");
        }
        assert!(!is_credential_header("x-team"));
    }

    #[test]
    fn an_endpoint_id_is_a_slug_of_its_name() {
        assert_eq!(slug("OpenCode Go (Anthropic)"), "opencode-go-anthropic");
        assert_eq!(slug("  My  Local LLM! "), "my-local-llm");
        assert_eq!(slug("…"), "endpoint");
    }
}
