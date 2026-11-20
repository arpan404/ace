//! The tools Spade can run. Each is a [`Tool`]: a definition for the registry and an async run.
//! `tool_search` and `call_tool` are not here; the engine answers them from the registry.

mod ace;
mod ace_link;
mod ace_wait;
mod bots;
mod cloud_account;
mod connectors;
mod decision;
mod goal;
mod helper;
mod knowledge;
mod memory;
pub mod outward;
mod plugins;
mod self_edit;
mod services;
mod skill_tools;
mod skills;
mod task;
mod todo;
mod wake;
mod web_fetch;
mod web_search;
mod workers;

use std::collections::BTreeMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde_json::Value;
use spade_core::event::{DocumentRef, ImageRef};
use spade_core::tools::{Registry, ToolDef};

pub(crate) use ace::reattaches;
pub use ace_link::{AceLink, AceTarget, GrantError, Retry, grant_slot};
pub use bots::{BotMessage, BotsList, EngineHandle};
pub use cloud_account::CloudAccount;
pub use connectors::ConnectorSource;
pub use decision::DecisionLog;
pub use goal::{TaskGoal, TaskPlan};
pub use helper::HelperTool;
pub use knowledge::KnowledgeTool;
pub use memory::{AskUser, MemoryTool};
pub use plugins::PluginTools;
pub use self_edit::{ProfileUpdate, TaskUpdate};
pub use services::service_tools;
pub use skill_tools::{SkillLoad, SkillSearch};
pub use skills::{
    AceLibrary, LibraryFuture, SkillFileData, SkillLibrary, SkillSource, WriteError, WriteFuture,
    body_of,
};
pub use task::TaskStatus;
pub use todo::Todo;
pub use wake::with_wake_tools;
pub use web_fetch::WebFetch;
pub use web_search::{NOT_SET_UP, WebSearch};
pub use workers::with_worker_tools;

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
    /// Boxed: few results carry any, and it keeps every result small.
    pub shared: Box<Shared>,
    /// The call failed for a while (the network, a rate limit, a `5xx`), so trying it again later
    /// may work: a background job that ends so is parked and run again (ADR 0160).
    pub transient: bool,
    /// Where a command ran and how it went, stored as `command_ran` beside the result for the
    /// reply's steps; the model is not shown it. Set only by the tools that run commands.
    pub command: Option<Box<CommandRun>>,
}

/// Where a command ran and how it went (`command_ran`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CommandRun {
    /// The sandbox held it.
    pub contained: bool,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub reached: Vec<String>,
    pub refused: Vec<spade_core::event::RefusedHost>,
}

impl CommandRun {
    /// The stored event for call `call_id` of reply `reply`.
    pub fn event(self, reply: &str, call_id: &str) -> spade_core::Event {
        spade_core::Event::Known(spade_core::event::Known::CommandRan {
            reply: reply.to_owned(),
            call_id: call_id.to_owned(),
            contained: self.contained,
            exit_code: self.exit_code,
            timed_out: self.timed_out,
            reached: self.reached,
            refused: self.refused,
        })
    }
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
            shared: Box::default(),
            transient: false,
            command: None,
        }
    }

    /// The same result, marked as a failure that may pass (ADR 0160).
    #[must_use]
    pub fn transient(mut self) -> Self {
        self.transient = true;
        self
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
            shared: Box::default(),
            transient: false,
            command: None,
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
    /// Where the call with `key` runs (ADR 0171) and, for a command with no sandbox, what the
    /// shell classifier reads in it and the files the reviewer must be shown. Most tools run on
    /// the host and are decided by their effect alone.
    fn classed(&self, _key: &str, _arguments: &Value) -> spade_core::autonomy::Classed {
        spade_core::autonomy::Classed::default()
    }
    /// What a call of this tool does, declared once (ADR 0171): Spade's own tools from the table
    /// in `spade_core::effect`; ace's, connectors' and plugins' tools say it about themselves.
    /// `None`: it declares nothing, and its first call asks the person.
    fn effect(&self, _arguments: &Value) -> Option<spade_core::effect::Effect> {
        let def = self.def();
        spade_core::effect::builtin(&def.spec.name, def.risk)
    }
    /// For a connector's or plugin's MCP tool, what its server says about it (its annotations
    /// and any trusted declaration), which Spade's classifier reads (ADR 0172). `None` for
    /// Spade's and ace's own tools, which the classifier isn't asked about.
    fn hints(&self) -> Option<spade_core::effect::Mcp> {
        None
    }
    /// For a connector's or plugin's tool: its server runs in the sandbox with no network and no
    /// credentials of its own, so nothing it does reaches anyone as the person. A sandbox that
    /// holds files alone doesn't make it so (ADR 0163, amendment 2).
    fn sealed(&self) -> bool {
        false
    }
    /// What the tool is, beyond the name it is offered under: for a tool from a server, the
    /// server and its version, the tool's own name and its schema, so an answer kept for it never
    /// carries over to another tool offered under the same name (ADR 0171, amendment 1).
    fn identity(&self) -> String {
        let def = self.def();
        format!("{}#{}", def.spec.name, schema_hash(&def.spec.schema))
    }
}

/// A short hash of a tool's input schema, as the server sent it.
pub fn schema_hash(schema: &Value) -> String {
    crate::workspace::trust::hash(schema.to_string().as_bytes())
        .chars()
        .take(16)
        .collect()
}

/// The tools offered under one name only: a name two tools share (two servers, or names cut down
/// to a provider's limit) is offered for neither, so a call can't reach the other one.
fn unambiguous(tools: Vec<Arc<dyn Tool>>) -> Vec<Arc<dyn Tool>> {
    let names: Vec<String> = tools.iter().map(|tool| tool.def().spec.name).collect();
    tools
        .into_iter()
        .zip(&names)
        .filter(|(_, name)| names.iter().filter(|n| n == name).count() == 1)
        .map(|(tool, _)| tool)
        .collect()
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
        self.registry_from(self.sourced())
    }

    /// Every source's tools now, those sharing a name left out.
    fn sourced(&self) -> Vec<Arc<dyn Tool>> {
        unambiguous(self.sources.iter().flat_map(|s| s.tools()).collect())
    }

    /// The sources' tools `conversation` may use now, those sharing a name left out.
    fn sourced_for(&self, conversation: &str) -> Vec<Arc<dyn Tool>> {
        unambiguous(
            self.sources
                .iter()
                .flat_map(|s| s.tools_for(conversation))
                .collect(),
        )
    }

    /// Every tool's definition that `conversation` may use now. The offered list (core tools
    /// plus `tool_search` and `call_tool`) is the same for every conversation.
    pub fn registry_for(&self, conversation: &str) -> Registry {
        self.registry_from(self.sourced_for(conversation))
    }

    fn registry_from(&self, sourced: Vec<Arc<dyn Tool>>) -> Registry {
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
            self.sourced()
                .into_iter()
                .find(|tool| tool.def().spec.name == name)
        })
    }

    /// The tool named `name`, if `conversation` may use it.
    pub fn get_for(&self, conversation: &str, name: &str) -> Option<Arc<dyn Tool>> {
        self.core.get(name).cloned().or_else(|| {
            self.sourced_for(conversation)
                .into_iter()
                .find(|tool| tool.def().spec.name == name)
        })
    }
}

/// Reads a typed argument object, or explains to the model what was wrong.
pub(crate) fn parse<T: serde::de::DeserializeOwned>(arguments: Value) -> Result<T, ToolOutput> {
    serde_json::from_value(arguments)
        .map_err(|error| ToolOutput::error(format!("The arguments do not fit this tool: {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use spade_core::tools::Risk;
    use spade_models::ToolSpec;

    struct Named(&'static str);

    impl Tool for Named {
        fn def(&self) -> ToolDef {
            ToolDef {
                spec: ToolSpec {
                    name: self.0.to_owned(),
                    description: String::new(),
                    schema: serde_json::json!({ "type": "object" }),
                },
                risk: Risk::Write,
                untrusted_output: false,
                deferred: true,
                background: false,
            }
        }

        fn run(&self, _key: &str, _arguments: Value) -> ToolFuture {
            Box::pin(async { ToolOutput::ok("ran") })
        }
    }

    struct Offers(Vec<&'static str>);

    impl ToolSource for Offers {
        fn tools(&self) -> Vec<Arc<dyn Tool>> {
            self.0
                .iter()
                .map(|name| Arc::new(Named(name)) as Arc<dyn Tool>)
                .collect()
        }
    }

    #[test]
    fn a_name_two_tools_are_offered_under_is_offered_for_neither() {
        // Two servers whose names collide once made safe for a provider, and one that doesn't.
        let toolbox = Toolbox::new(Vec::new())
            .with_source(Arc::new(Offers(vec!["files__delete", "files__list"])))
            .with_source(Arc::new(Offers(vec!["files__delete"])));
        let registry = toolbox.registry_for("c1");
        assert!(registry.get("files__delete").is_none());
        assert!(toolbox.get_for("c1", "files__delete").is_none());
        assert!(toolbox.get("files__delete").is_none());
        assert!(registry.get("files__list").is_some());
        assert!(toolbox.get_for("c1", "files__list").is_some());
    }
}
