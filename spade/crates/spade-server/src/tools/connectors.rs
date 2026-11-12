//! Connector tools (ADR 0131): each connected app's tools, offered deferred like ace's, to the
//! bots the person allowed. A conversation's bot is looked up from the database on each listing,
//! so an allow list change applies from the next step.

use std::sync::Arc;

use serde_json::Value;
use spade_connect::{CallError, ConnectorTool, Connectors};
use spade_core::context::MAYBE_RAN;
use spade_core::tools::{Risk, ToolDef};
use spade_mcp::Risk as McpRisk;
use spade_models::ToolSpec;
use spade_store::Store;

use super::{Tool, ToolFuture, ToolOutput, ToolSource};

/// Connector tools, limited per conversation to what its bot may use.
pub struct ConnectorSource {
    hub: Arc<Connectors>,
    /// Its own connection to Spade's database, to find a conversation's bot.
    store: Store,
}

impl ConnectorSource {
    pub fn new(hub: Arc<Connectors>, store: Store) -> Self {
        Self { hub, store }
    }
}

impl ToolSource for ConnectorSource {
    /// None without a conversation: a connector is only ever used by a bot allowed it.
    fn tools(&self) -> Vec<Arc<dyn Tool>> {
        Vec::new()
    }

    fn tools_for(&self, conversation: &str) -> Vec<Arc<dyn Tool>> {
        let agent = match self.store.agent_for_conversation(conversation) {
            Ok(Some(agent)) => agent,
            Ok(None) => return Vec::new(),
            Err(error) => {
                tracing::warn!(%error, "could not look up a conversation's bot; no connectors");
                return Vec::new();
            }
        };
        let is_main = agent.kind == crate::engine::MAIN;
        self.hub
            .tools_for(&agent.id, is_main)
            .into_iter()
            .map(|tool| {
                Arc::new(ConnectorCall {
                    def: def(&tool),
                    tool,
                    hub: self.hub.clone(),
                }) as Arc<dyn Tool>
            })
            .collect()
    }
}

/// How a connector tool is offered: deferred, its risk from the server's hints, and its output
/// always untrusted (it is the app's data, which strangers may have written).
pub fn def(tool: &ConnectorTool) -> ToolDef {
    let about = if tool.tool.description.is_empty() {
        tool.tool.name.clone()
    } else {
        tool.tool.description.clone()
    };
    ToolDef {
        spec: ToolSpec {
            name: tool.name.clone(),
            description: format!("{}: {about}", tool.connector_name),
            schema: tool.tool.input_schema.clone(),
        },
        risk: match tool.tool.risk {
            McpRisk::Read => Risk::Read,
            McpRisk::Write => Risk::Write,
            McpRisk::Destructive => Risk::Destructive,
        },
        untrusted_output: true,
        deferred: true,
        background: false,
    }
}

struct ConnectorCall {
    def: ToolDef,
    tool: ConnectorTool,
    hub: Arc<Connectors>,
}

impl Tool for ConnectorCall {
    fn def(&self) -> ToolDef {
        self.def.clone()
    }

    fn run(&self, _key: &str, arguments: Value) -> ToolFuture {
        let hub = self.hub.clone();
        let (connector, name) = (self.tool.connector.clone(), self.tool.tool.name.clone());
        Box::pin(async move {
            match hub.call(&connector, &name, arguments).await {
                Ok(result) => super::ace::output(Ok(result)),
                Err(error) => output(error),
            }
        })
    }
}

/// What a call that returned no result tells the model.
fn output(error: CallError) -> ToolOutput {
    match error {
        CallError::NotRun(why) => {
            ToolOutput::error(format!("Not run: {why}. It is safe to try again."))
        }
        CallError::MaybeRan(why) => ToolOutput::maybe_ran(format!("{MAYBE_RAN} ({why})")),
        error @ CallError::NeedsReconnect(_) => ToolOutput::error(format!("Not run: {error}.")),
        CallError::Failed(why) => ToolOutput::error(why),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_call_cut_off_after_sending_never_reads_as_not_run() {
        let unknown = output(CallError::MaybeRan("connection reset".into()));
        assert!(unknown.uncertain && unknown.content.starts_with("Unknown outcome"));
        let not_run = output(CallError::NotRun("Linear could not be reached".into()));
        assert!(!not_run.uncertain && not_run.content.contains("safe to try again"));
        let expired = output(CallError::NeedsReconnect("Linear".into()));
        assert!(expired.content.contains("reconnect"), "{}", expired.content);
    }
}
