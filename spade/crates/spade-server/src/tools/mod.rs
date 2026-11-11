//! The tools Spade can run. Each is a [`Tool`]: a definition for the registry and an async run.
//! `tool_search` and `call_tool` are not here; the engine answers them from the registry.

mod ace;
mod skills;
mod todo;
mod web_fetch;
mod web_search;

use std::collections::BTreeMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde_json::Value;
use spade_core::tools::{Registry, ToolDef};

pub use ace::AceSource;
pub use skills::{AceLibrary, LibraryFuture, SkillLibrary, SkillLoad, SkillSearch};
pub use todo::Todo;
pub use web_fetch::WebFetch;
pub use web_search::WebSearch;

pub type ToolFuture = Pin<Box<dyn Future<Output = ToolOutput> + Send>>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolOutput {
    pub content: String,
    pub is_error: bool,
}

impl ToolOutput {
    pub fn ok(content: impl Into<String>) -> Self {
        Self {
            content: content.into(),
            is_error: false,
        }
    }

    pub fn error(content: impl Into<String>) -> Self {
        Self {
            content: content.into(),
            is_error: true,
        }
    }
}

pub trait Tool: Send + Sync {
    fn def(&self) -> ToolDef;
    /// Runs one call. `key` is unique across conversations and the same for this call across
    /// retries and restarts: tools that change things pass it on as an idempotency key, so a
    /// repeated call cannot act twice.
    fn run(&self, key: &str, arguments: Value) -> ToolFuture;
}

/// Tools whose list changes while Spade runs, such as ace's. Every one is offered deferred, so
/// the tool list sent to the model stays the same as they come and go.
pub trait ToolSource: Send + Sync {
    /// The source's tools now.
    fn tools(&self) -> Vec<Arc<dyn Tool>>;
}

/// Spade's own tools by name, plus tools from live sources; a source's tool never replaces one
/// of Spade's own.
#[derive(Clone)]
pub struct Toolbox {
    core: BTreeMap<String, Arc<dyn Tool>>,
    sources: Vec<Arc<dyn ToolSource>>,
}

impl Toolbox {
    pub fn new(tools: Vec<Arc<dyn Tool>>) -> Self {
        Self {
            core: tools
                .into_iter()
                .map(|tool| (tool.def().spec.name, tool))
                .collect(),
            sources: Vec::new(),
        }
    }

    pub fn with_source(mut self, source: Arc<dyn ToolSource>) -> Self {
        self.sources.push(source);
        self
    }

    /// Every tool's definition now.
    pub fn registry(&self) -> Registry {
        let mut defs: BTreeMap<String, ToolDef> = BTreeMap::new();
        for tool in self.sources.iter().flat_map(|source| source.tools()) {
            let mut def = tool.def();
            def.deferred = true;
            defs.insert(def.spec.name.clone(), def);
        }
        for tool in self.core.values() {
            let def = tool.def();
            defs.insert(def.spec.name.clone(), def);
        }
        if self.sources.is_empty() {
            Registry::new(defs.into_values())
        } else {
            Registry::with_search(defs.into_values())
        }
    }

    pub fn get(&self, name: &str) -> Option<Arc<dyn Tool>> {
        self.core.get(name).cloned().or_else(|| {
            self.sources
                .iter()
                .flat_map(|source| source.tools())
                .find(|tool| tool.def().spec.name == name)
        })
    }
}

/// Reads a typed argument object, or explains to the model what was wrong.
pub(crate) fn parse<T: serde::de::DeserializeOwned>(arguments: Value) -> Result<T, ToolOutput> {
    serde_json::from_value(arguments)
        .map_err(|error| ToolOutput::error(format!("The arguments do not fit this tool: {error}")))
}
