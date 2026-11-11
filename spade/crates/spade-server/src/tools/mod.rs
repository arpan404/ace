//! The tools Spade can run. Each is a [`Tool`]: a definition for the registry and an async run.
//! `tool_search` and `call_tool` are not here; the engine answers them from the registry.

mod todo;
mod web_search;

use std::collections::BTreeMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde_json::Value;
use spade_core::tools::{Registry, ToolDef};

pub use todo::Todo;
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
    /// Runs one call. `call_id` is stable for this call across retries and restarts: tools that
    /// change things pass it on as an idempotency key, so a repeated call cannot act twice.
    fn run(&self, call_id: &str, arguments: Value) -> ToolFuture;
}

/// Every tool by name, and the registry built from their definitions.
#[derive(Clone)]
pub struct Toolbox {
    tools: BTreeMap<String, Arc<dyn Tool>>,
    registry: Registry,
}

impl Toolbox {
    pub fn new(tools: Vec<Arc<dyn Tool>>) -> Self {
        let defs: Vec<ToolDef> = tools.iter().map(|tool| tool.def()).collect();
        Self {
            tools: tools
                .into_iter()
                .zip(defs.iter())
                .map(|(tool, def)| (def.spec.name.clone(), tool))
                .collect(),
            registry: Registry::new(defs),
        }
    }

    pub fn registry(&self) -> &Registry {
        &self.registry
    }

    pub fn get(&self, name: &str) -> Option<Arc<dyn Tool>> {
        self.tools.get(name).cloned()
    }
}

/// Reads a typed argument object, or explains to the model what was wrong.
pub(crate) fn parse<T: serde::de::DeserializeOwned>(arguments: Value) -> Result<T, ToolOutput> {
    serde_json::from_value(arguments)
        .map_err(|error| ToolOutput::error(format!("The arguments do not fit this tool: {error}")))
}
