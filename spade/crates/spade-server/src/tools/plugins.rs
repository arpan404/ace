//! Plugins' local MCP servers as tools (ADR 0151, point 11): deferred like connectors', named
//! `<plugin>__<tool>`, risk from their annotations (unlabelled means write), output untrusted,
//! and only for the bots the person allowed the plugin. A conversation's bot is looked up on
//! each listing, so a change applies from its next step.

use std::sync::Arc;

use serde_json::Value;
use spade_core::context::MAYBE_RAN;
use spade_core::tools::{Risk, ToolDef};
use spade_mcp::{McpTool, Risk as McpRisk, ToolsError};
use spade_models::ToolSpec;
use spade_store::Store;

use super::{Tool, ToolFuture, ToolOutput, ToolSource};
use crate::plugins::Plugins;
use crate::plugins::servers::{Server, tool_name};

pub struct PluginTools {
    plugins: Arc<Plugins>,
    /// Its own connection to Spade's database, to find a conversation's bot.
    store: Store,
}

impl PluginTools {
    pub fn new(plugins: Arc<Plugins>, store: Store) -> Self {
        Self { plugins, store }
    }
}

impl ToolSource for PluginTools {
    /// None without a conversation: a plugin's tools are only ever a bot's it was allowed.
    fn tools(&self) -> Vec<Arc<dyn Tool>> {
        Vec::new()
    }

    fn tools_for(&self, conversation: &str) -> Vec<Arc<dyn Tool>> {
        let agent = match self.store.agent_for_conversation(conversation) {
            Ok(Some(agent)) => agent,
            Ok(None) => return Vec::new(),
            Err(error) => {
                tracing::warn!(%error, "could not look up a conversation's bot; no plugin tools");
                return Vec::new();
            }
        };
        // A subscription's CLI runs the plugin's servers itself (ADR 0133).
        if spade_core::brain::CliModel::is(&agent.model) {
            return Vec::new();
        }
        let usable: Vec<String> = self
            .plugins
            .for_agent(&agent.id)
            .iter()
            .map(|plugin| plugin.install.name.clone())
            .collect();
        self.plugins
            .listed(&agent.id)
            .into_iter()
            .filter(|server| usable.contains(&server.plugin))
            .flat_map(|server| {
                server.tools().into_iter().map(move |tool| {
                    Arc::new(PluginCall {
                        def: def(&server.plugin, &tool),
                        tool,
                        server: server.clone(),
                    }) as Arc<dyn Tool>
                })
            })
            .collect()
    }
}

fn def(plugin: &str, tool: &McpTool) -> ToolDef {
    let about = if tool.description.is_empty() {
        tool.name.clone()
    } else {
        tool.description.clone()
    };
    ToolDef {
        spec: ToolSpec {
            name: tool_name(plugin, &tool.name),
            description: format!("{plugin}: {about}"),
            schema: tool.input_schema.clone(),
        },
        risk: match tool.risk {
            McpRisk::Read => Risk::Read,
            McpRisk::Write => Risk::Write,
            McpRisk::Destructive => Risk::Destructive,
        },
        untrusted_output: true,
        deferred: true,
        background: false,
    }
}

struct PluginCall {
    def: ToolDef,
    tool: McpTool,
    server: Arc<Server>,
}

impl Tool for PluginCall {
    fn def(&self) -> ToolDef {
        self.def.clone()
    }

    /// A server the sandbox holds is the OS's to decide (ADR 0171).
    fn classed(&self, _key: &str, _arguments: &Value) -> spade_core::autonomy::Classed {
        if self.server.contained() {
            spade_core::autonomy::Classed::sandboxed()
        } else {
            spade_core::autonomy::Classed::default()
        }
    }

    /// Its annotations, unless its entry declares what it does.
    fn effect(&self, _arguments: &Value) -> Option<spade_core::effect::Effect> {
        spade_core::effect::mcp(spade_core::effect::Mcp {
            read_only: self.def.risk == Risk::Read,
            annotated: self.tool.annotated,
            declared: self.server.declared(&self.tool.name),
            writes: None,
        })
    }

    fn run(&self, _key: &str, arguments: Value) -> ToolFuture {
        let server = self.server.clone();
        let name = self.tool.name.clone();
        Box::pin(async move {
            match server.call(&name, arguments).await {
                Ok(result) => super::ace::output(Ok(result)),
                Err(error) => output(error),
            }
        })
    }
}

/// What a call that returned no result tells the model.
fn output(error: ToolsError) -> ToolOutput {
    match error {
        ToolsError::NotRun(why) | ToolsError::Unavailable(why) => {
            ToolOutput::error(format!("Not run: {why}."))
        }
        ToolsError::OutcomeUnknown(why) => ToolOutput::maybe_ran(format!("{MAYBE_RAN} ({why})")),
        ToolsError::Timeout => ToolOutput::maybe_ran(format!("{MAYBE_RAN} (it timed out)")),
        other => ToolOutput::error(other.to_string()),
    }
}
