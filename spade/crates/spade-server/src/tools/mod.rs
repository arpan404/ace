//! The tools Spade can run. Each is a [`Tool`]: a definition for the registry and an async run.
//! `tool_search` and `call_tool` are not here; the engine answers them from the registry.

mod ace;
mod ace_link;
mod bots;
mod cloud_account;
mod connectors;
mod memory;
mod skills;
mod task;
mod todo;
mod web_fetch;
mod web_search;

use std::collections::BTreeMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde_json::Value;
use spade_core::event::{DocumentRef, ImageRef};
use spade_core::tools::{Registry, ToolDef};

pub use ace_link::{AceLink, AceTarget, GrantError, Retry, grant_slot};
pub use bots::{BotMessage, BotsList, EngineHandle};
pub use cloud_account::CloudAccount;
pub use connectors::ConnectorSource;
pub use memory::{AskUser, MemoryTool};
pub use skills::{
    AceLibrary, LibraryFuture, SkillLibrary, SkillLoad, SkillSearch, SkillSource, WriteError,
    WriteFuture, body_of,
};
pub use task::TaskStatus;
pub use todo::Todo;
pub use web_fetch::WebFetch;
pub use web_search::{NOT_SET_UP, WebSearch};

pub type ToolFuture = Pin<Box<dyn Future<Output = ToolOutput> + Send>>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolOutput {
    pub content: String,
    pub is_error: bool,
    /// The call may have taken effect even though no result came back (it was cut off).
    pub uncertain: bool,
    /// Images the tool returned, as bytes; Spade stores them and shows them to the model.
    pub images: Vec<Vec<u8>>,
    /// This result carries untrusted content (a file written after reading the web), so the
    /// rest of the turn is untrusted, whatever the tool's definition says.
    pub untrusted: bool,
    /// Workspace files the tool kept for the person to open (a research report), relative to
    /// the bot's workspace. Shown as file chips; only background jobs carry them for now.
    pub files: Box<[String]>,
    /// What the tool showed the person, already stored (ADR 0134). Recorded as a `shared` event
    /// beside the result; the model is not shown it.
    pub shared: Shared,
}

/// Images and documents a tool showed the person, by reference.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Shared {
    pub images: Vec<ImageRef>,
    pub documents: Vec<DocumentRef>,
}

impl Shared {
    pub fn is_empty(&self) -> bool {
        self.images.is_empty() && self.documents.is_empty()
    }
}

impl ToolOutput {
    pub fn ok(content: impl Into<String>) -> Self {
        Self {
            content: content.into(),
            is_error: false,
            uncertain: false,
            images: Vec::new(),
            untrusted: false,
            files: Box::default(),
            shared: Shared::default(),
        }
    }

    /// The same result, marked as carrying untrusted content.
    #[must_use]
    pub fn untrusted(mut self) -> Self {
        self.untrusted = true;
        self
    }

    pub fn error(content: impl Into<String>) -> Self {
        Self {
            content: content.into(),
            is_error: true,
            uncertain: false,
            images: Vec::new(),
            untrusted: false,
            files: Box::default(),
            shared: Shared::default(),
        }
    }

    /// An error whose call may still have taken effect, so it must never read as "did not run".
    pub fn maybe_ran(content: impl Into<String>) -> Self {
        Self {
            uncertain: true,
            ..Self::error(content)
        }
    }
}

pub trait Tool: Send + Sync {
    fn def(&self) -> ToolDef;
    /// Runs one call. `key` is unique across conversations and the same for this call across
    /// retries and restarts: tools that change things pass it on as an idempotency key, so a
    /// repeated call cannot act twice.
    fn run(&self, key: &str, arguments: Value) -> ToolFuture;
    /// Runs one call knowing what the turn has read. Tools that keep what they write (the
    /// workspace, skill notes) override this to mark it untrusted when the turn is.
    fn run_in(&self, key: &str, arguments: Value, _turn: &TurnFacts) -> ToolFuture {
        self.run(key, arguments)
    }
    /// What "always" covers for this call: `None` means the whole tool (the default), `Some`
    /// means only calls with the same scope (a shell command allows only that exact command).
    fn always_scope(&self, _arguments: &Value) -> Option<String> {
        None
    }
    /// [`Tool::always_scope`] for the call with `key`, for tools whose scope depends on more
    /// than the arguments (where the bot's terminal is, ADR 0142). The scope is stored when the
    /// call asks, so an earlier "always" is matched against it as it was then.
    fn always_scope_in(&self, _key: &str, arguments: &Value) -> Option<String> {
        self.always_scope(arguments)
    }
    /// [`Tool::class`] for the call with `key`, with the files it runs that the reviewer must read
    /// (the shell's scripts). Most tools need only their arguments.
    fn classed(&self, _key: &str, arguments: &Value) -> spade_core::autonomy::Classed {
        self.class(arguments).into()
    }
    /// What a call of this tool can reach, for the auto-review (ADR 0144). Spade's own tools are
    /// classed by name; ace's and the person's apps' tools say more about themselves.
    fn class(&self, arguments: &Value) -> spade_core::autonomy::Class {
        let def = self.def();
        spade_core::autonomy::classify(
            &def.spec.name,
            def.risk,
            spade_core::autonomy::Source::Spade,
            arguments,
        )
    }
}

/// What the engine knows about the turn a call runs in.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TurnFacts {
    /// The prompt the call was made from shows untrusted content (this turn's, an earlier
    /// turn's since the last compaction, or a tainted summary): what, in a few words
    /// ("https://example.com"). `None` when it shows none.
    pub untrusted: Option<String>,
    /// The only untrusted thing in view is a summary drawn from untrusted text: a note saved or
    /// rewritten now is kept as a suggestion the person keeps or dismisses (memory.md).
    pub memory_suggests: bool,
}

/// Tools whose list changes while Spade runs, such as ace's. Every one is offered deferred, so
/// the tool list sent to the model stays the same as they come and go.
pub trait ToolSource: Send + Sync {
    /// The source's tools now.
    fn tools(&self) -> Vec<Arc<dyn Tool>>;

    /// The source's tools that `conversation` may use now. All of them unless the source limits
    /// them per bot, as connectors do (ADR 0131).
    fn tools_for(&self, conversation: &str) -> Vec<Arc<dyn Tool>> {
        let _ = conversation;
        self.tools()
    }
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

    /// Adds one of Spade's own tools.
    pub fn with_tool(mut self, tool: Arc<dyn Tool>) -> Self {
        self.core.insert(tool.def().spec.name, tool);
        self
    }

    pub fn with_source(mut self, source: Arc<dyn ToolSource>) -> Self {
        self.sources.push(source);
        self
    }

    /// Every tool's definition now.
    pub fn registry(&self) -> Registry {
        self.registry_from(self.sources.iter().flat_map(|source| source.tools()))
    }

    /// Every tool's definition that `conversation` may use now. The offered list (core tools
    /// plus `tool_search` and `call_tool`) is the same for every conversation.
    pub fn registry_for(&self, conversation: &str) -> Registry {
        self.registry_from(
            self.sources
                .iter()
                .flat_map(|source| source.tools_for(conversation)),
        )
    }

    fn registry_from(&self, sourced: impl Iterator<Item = Arc<dyn Tool>>) -> Registry {
        let mut defs: BTreeMap<String, ToolDef> = BTreeMap::new();
        for tool in sourced {
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

    /// The tool named `name`, if `conversation` may use it.
    pub fn get_for(&self, conversation: &str, name: &str) -> Option<Arc<dyn Tool>> {
        self.core.get(name).cloned().or_else(|| {
            self.sources
                .iter()
                .flat_map(|source| source.tools_for(conversation))
                .find(|tool| tool.def().spec.name == name)
        })
    }
}

/// Reads a typed argument object, or explains to the model what was wrong.
pub(crate) fn parse<T: serde::de::DeserializeOwned>(arguments: Value) -> Result<T, ToolOutput> {
    serde_json::from_value(arguments)
        .map_err(|error| ToolOutput::error(format!("The arguments do not fit this tool: {error}")))
}
