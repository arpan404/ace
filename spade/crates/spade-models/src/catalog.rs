//! The shipped presets (ADR 0126), loaded from a JSON file (`config/models.json` by default) when
//! Spade starts: endpoint templates the person can add with one choice, and known facts about
//! models (context, capabilities, prices) looked up by model id. What Spade may call is the
//! person's own list of endpoints, kept in Spade's database; [`crate::Models`] starts with these
//! presets as its endpoints until the server sets that list.
//!
//! A model is named `endpoint/model`, for example `anthropic/claude-sonnet-5-5`. The model part
//! may itself contain `/` (`openrouter/anthropic/claude-sonnet-5.5`); the endpoint part cannot.
//!
//! Loading checks the whole file and reports every problem at once, so a bad edit stops Spade at
//! startup instead of failing a call later.

use std::collections::{BTreeMap, HashSet};
use std::fmt;
use std::path::Path;

use serde::Deserialize;

use crate::format::Format;

/// What a call is for. Callers ask for a role; the catalogue's `roles` pick the model.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    /// Everyday chat and tool use.
    Main,
    /// Cheap, quick work: routing group chat, extracting memories, short summaries.
    Fast,
    /// Hard reasoning and long plans.
    Deep,
}

/// What a model can do, as declared in the catalogue.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize, serde::Serialize)]
pub enum Capability {
    #[serde(rename = "tools")]
    Tools,
    #[serde(rename = "images")]
    Images,
    #[serde(rename = "reasoning")]
    Reasoning,
    /// The endpoint withholds deferred tools and reveals them itself (Anthropic `defer_loading`).
    #[serde(rename = "native-tool-search")]
    NativeToolSearch,
    /// Reads a PDF sent as a file (ADR 0134).
    #[serde(rename = "pdf-input")]
    PdfInput,
    /// Serves the OpenAI-format `POST /images/generations` route.
    #[serde(rename = "image-generation")]
    ImageGeneration,
    /// A chat model that answers with images when asked for them.
    #[serde(rename = "image-output")]
    ImageOutput,
    /// Serves the OpenAI-format `POST /audio/transcriptions` route.
    #[serde(rename = "transcription")]
    Transcription,
}

/// US dollars per million tokens. Cache prices default to the input price when absent.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Price {
    pub input: f64,
    pub output: f64,
    #[serde(default)]
    pub cache_read: Option<f64>,
    #[serde(default)]
    pub cache_write: Option<f64>,
    /// US dollars per call, for calls billed per image or per recording (ADR 0134), on top of any
    /// tokens the endpoint reports.
    #[serde(default)]
    pub per_call: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Model {
    /// The model id the endpoint expects.
    pub id: String,
    pub name: String,
    /// Context window in tokens, when known.
    pub context: Option<u64>,
    pub capabilities: Vec<Capability>,
    /// `None` for a flat-rate plan or a local server.
    pub price: Option<Price>,
}

impl Capability {
    pub const ALL: [Self; 8] = [
        Self::Tools,
        Self::Images,
        Self::Reasoning,
        Self::NativeToolSearch,
        Self::PdfInput,
        Self::ImageGeneration,
        Self::ImageOutput,
        Self::Transcription,
    ];

    /// The name used in files and the API.
    pub const fn name(self) -> &'static str {
        match self {
            Self::Tools => "tools",
            Self::Images => "images",
            Self::Reasoning => "reasoning",
            Self::NativeToolSearch => "native-tool-search",
            Self::PdfInput => "pdf-input",
            Self::ImageGeneration => "image-generation",
            Self::ImageOutput => "image-output",
            Self::Transcription => "transcription",
        }
    }

    pub fn parse(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|c| c.name() == name)
    }
}

/// Context window assumed for a model nobody describes.
pub const DEFAULT_CONTEXT: u64 = 128_000;

impl Model {
    /// A model known only by its id: conservative defaults the person can edit.
    pub fn unknown(id: &str) -> Self {
        Self {
            id: id.to_owned(),
            name: id.to_owned(),
            context: Some(DEFAULT_CONTEXT),
            capabilities: vec![Capability::Tools],
            price: None,
        }
    }

    pub fn can(&self, capability: Capability) -> bool {
        self.capabilities.contains(&capability)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Endpoint {
    pub id: String,
    pub name: String,
    pub format: Format,
    /// Always ends with `/`.
    pub base_url: String,
    /// Whether calls need a key. Keys come from the OS keychain, then `key_env` (ADR 0119).
    pub needs_key: bool,
    /// The environment variable that may hold the key.
    pub key_env: Option<String>,
    pub headers: Vec<(String, String)>,
    /// The header that carries the conversation's session id, for endpoints that route by it
    /// (OpenCode Go's `x-opencode-session`). Calls without a session send none.
    pub session_header: Option<String>,
    pub models: Vec<Model>,
}

/// A model reference resolved against the catalogue.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Resolved<'a> {
    pub endpoint: &'a Endpoint,
    pub model: &'a Model,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Catalog {
    endpoints: Vec<Endpoint>,
    roles: Option<FileRoles>,
}

/// Everything wrong with a catalogue file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CatalogError {
    /// The file, or `"catalogue"` when parsed from a string.
    pub source: String,
    pub problems: Vec<String>,
}

impl fmt::Display for CatalogError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} is not a valid model catalogue:", self.source)?;
        for problem in &self.problems {
            write!(f, "\n  - {problem}")?;
        }
        Ok(())
    }
}

impl std::error::Error for CatalogError {}

// The file's shape. Unknown fields are refused so a typo cannot be silently ignored.

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct File {
    /// When the ids and prices were last checked; for people, not used by Spade.
    #[serde(default, rename = "checked")]
    _checked: Option<String>,
    /// Optional: what a fresh Spade picks before the person chooses.
    #[serde(default)]
    roles: Option<FileRoles>,
    endpoints: Vec<FileEndpoint>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
struct FileRoles {
    main: String,
    fast: String,
    deep: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FileEndpoint {
    id: String,
    name: String,
    format: Format,
    base_url: String,
    #[serde(default)]
    key: Option<FileKey>,
    #[serde(default)]
    headers: BTreeMap<String, String>,
    #[serde(default)]
    session_header: Option<String>,
    models: Vec<FileModel>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FileKey {
    /// Optional: without it the key comes only from the keychain.
    #[serde(default)]
    env: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FileModel {
    id: String,
    name: String,
    #[serde(default)]
    context: Option<u64>,
    #[serde(default)]
    capabilities: Vec<Capability>,
    #[serde(default)]
    price: Option<Price>,
}

impl Catalog {
    /// Reads and checks the catalogue file at `path`.
    pub fn load(path: &Path) -> Result<Self, CatalogError> {
        let source = path.display().to_string();
        let text = std::fs::read_to_string(path).map_err(|error| CatalogError {
            source: source.clone(),
            problems: vec![format!("cannot be read: {error}")],
        })?;
        Self::parse(&text).map_err(|problems| CatalogError { source, problems })
    }

    /// Parses and checks a catalogue held in memory.
    pub fn from_json(text: &str) -> Result<Self, CatalogError> {
        Self::parse(text).map_err(|problems| CatalogError {
            source: "catalogue".to_owned(),
            problems,
        })
    }

    pub fn endpoints(&self) -> &[Endpoint] {
        &self.endpoints
    }

    /// The model reference the file sets for `role`, when it sets roles.
    pub fn role(&self, role: Role) -> Option<&str> {
        let roles = self.roles.as_ref()?;
        Some(match role {
            Role::Main => &roles.main,
            Role::Fast => &roles.fast,
            Role::Deep => &roles.deep,
        })
    }

    /// What the presets know about model `id`, from the first endpoint that lists it.
    pub fn facts(&self, id: &str) -> Option<&Model> {
        self.endpoints
            .iter()
            .flat_map(|e| e.models.iter())
            .find(|m| m.id == id)
    }

    /// Finds `endpoint/model`.
    pub fn resolve(&self, reference: &str) -> Option<Resolved<'_>> {
        let (endpoint_id, model_id) = reference.split_once('/')?;
        let endpoint = self.endpoints.iter().find(|e| e.id == endpoint_id)?;
        let model = endpoint.models.iter().find(|m| m.id == model_id)?;
        Some(Resolved { endpoint, model })
    }

    fn parse(text: &str) -> Result<Self, Vec<String>> {
        let file: File = serde_json::from_str(text).map_err(|error| vec![error.to_string()])?;
        let mut problems = Vec::new();
        let mut seen = HashSet::new();
        let endpoints: Vec<Endpoint> = file
            .endpoints
            .into_iter()
            .map(|endpoint| check_endpoint(endpoint, &mut problems))
            .collect();
        for endpoint in &endpoints {
            if !seen.insert(endpoint.id.as_str()) {
                problems.push(format!("endpoint {} is listed more than once", endpoint.id));
            }
        }
        let catalog = Self {
            endpoints,
            roles: file.roles,
        };
        let roles = catalog.roles.iter().flat_map(|roles| {
            [
                ("main", &roles.main),
                ("fast", &roles.fast),
                ("deep", &roles.deep),
            ]
        });
        for (role, reference) in roles {
            if catalog.resolve(reference).is_none() {
                problems.push(format!(
                    "the {role} role names {reference}, which is not an endpoint/model in this file"
                ));
            }
        }
        if problems.is_empty() {
            Ok(catalog)
        } else {
            Err(problems)
        }
    }
}

fn check_endpoint(endpoint: FileEndpoint, problems: &mut Vec<String>) -> Endpoint {
    let id = endpoint.id.trim().to_owned();
    let valid_id = !id.is_empty()
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '_' | '.'));
    if !valid_id {
        problems.push(format!(
            "endpoint id {:?} must be lowercase letters, digits, '-', '_' or '.'",
            endpoint.id
        ));
    }
    let label = if id.is_empty() {
        "(no id)".to_owned()
    } else {
        id.clone()
    };
    if endpoint.name.trim().is_empty() {
        problems.push(format!("endpoint {label} has an empty name"));
    }
    let base = endpoint.base_url.trim();
    if !(base.starts_with("https://") || base.starts_with("http://")) {
        problems.push(format!(
            "endpoint {label}: base_url must start with https:// or http://"
        ));
    }
    let base_url = if base.ends_with('/') {
        base.to_owned()
    } else {
        format!("{base}/")
    };
    let needs_key = endpoint.key.is_some();
    let key_env = endpoint
        .key
        .and_then(|key| key.env)
        .map(|var| var.trim().to_owned());
    if let Some(var) = &key_env {
        let valid = !var.is_empty()
            && var
                .chars()
                .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_');
        if !valid {
            problems.push(format!(
                "endpoint {label}: key env {var:?} must be an environment variable name like OPENAI_API_KEY"
            ));
        }
    }
    let session_header = endpoint
        .session_header
        .map(|name| name.trim().to_ascii_lowercase());
    if let Some(name) = &session_header {
        let valid = !name.is_empty()
            && name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
        if !valid {
            problems.push(format!(
                "endpoint {label}: session_header {name:?} must be a header name like x-session-id"
            ));
        }
    }
    let mut seen = HashSet::new();
    let models = endpoint
        .models
        .into_iter()
        .map(|model| {
            let model_id = model.id.trim().to_owned();
            if model_id.is_empty() {
                problems.push(format!("endpoint {label} has a model with an empty id"));
            } else if !seen.insert(model_id.clone()) {
                problems.push(format!(
                    "endpoint {label}: model {model_id} is listed more than once"
                ));
            }
            if model.name.trim().is_empty() {
                problems.push(format!("{label}/{model_id} has an empty name"));
            }
            if let Some(price) = model.price {
                let valid = |v: f64| v.is_finite() && v >= 0.0;
                let all = [
                    Some(price.input),
                    Some(price.output),
                    price.cache_read,
                    price.cache_write,
                ];
                if !all.into_iter().flatten().all(valid) {
                    problems.push(format!(
                        "{label}/{model_id}: prices must be zero or more dollars per million tokens"
                    ));
                }
            }
            Model {
                id: model_id,
                name: model.name,
                context: model.context,
                capabilities: model.capabilities,
                price: model.price,
            }
        })
        .collect();
    Endpoint {
        id,
        name: endpoint.name,
        format: endpoint.format,
        base_url,
        needs_key,
        key_env,
        headers: endpoint.headers.into_iter().collect(),
        session_header,
        models,
    }
}

#[cfg(test)]
mod tests;
