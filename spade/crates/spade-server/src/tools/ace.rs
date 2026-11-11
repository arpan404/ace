//! ace's own tools (threads, agents, browser, screen, automations) through the daemon's loopback
//! MCP endpoint (spade-ace). The list is fetched at start and again whenever ace says it changed;
//! every tool is offered deferred, so the model finds them with `tool_search` and the tool list
//! it is sent never changes.

use std::sync::{Arc, RwLock};
use std::time::Duration;

use serde_json::Value;
use spade_ace::{AceTool, AceToolResult, AceTools, Part, Risk as AceRisk, ToolsError};
use spade_core::context::MAYBE_RAN;
use spade_core::tools::{Risk, ToolDef};
use spade_models::ToolSpec;

use super::{Tool, ToolFuture, ToolOutput, ToolSource};

/// How often the list is fetched again when ace sends no change notice.
const REFRESH: Duration = Duration::from_secs(300);

/// ace's tools whose output is only ace's own state, never text from outside (web pages, agents'
/// output, other people). Every other ace tool's output is untrusted, so writes after it ask.
const TRUSTED: &[&str] = &[
    "context",
    "machines",
    "models",
    "projects_find",
    "threads_find",
    "automations_list",
    "agents_status",
];

/// ace's tools that can run for minutes, run as background jobs.
const BACKGROUND: &[&str] = &["wait"];

/// How Spade offers one of ace's tools.
pub fn def(tool: &AceTool) -> ToolDef {
    ToolDef {
        spec: ToolSpec {
            name: tool.name.clone(),
            description: tool.description.clone(),
            schema: tool.input_schema.clone(),
        },
        risk: match tool.risk {
            AceRisk::Read => Risk::Read,
            AceRisk::Write => Risk::Write,
            AceRisk::Destructive => Risk::Destructive,
        },
        untrusted_output: !TRUSTED.contains(&tool.name.as_str()),
        deferred: true,
        background: BACKGROUND.contains(&tool.name.as_str()),
    }
}

/// Gives each task of a `delegate` call a request id derived from the call's key, unless the
/// model chose one. ace returns the same child for a repeated request id, so a retried call,
/// even after a restart, never starts a second agent.
pub fn with_request_ids(name: &str, key: &str, mut arguments: Value) -> Value {
    if name != "delegate" {
        return arguments;
    }
    if let Some(tasks) = arguments.get_mut("tasks").and_then(Value::as_array_mut) {
        for (index, task) in tasks.iter_mut().enumerate() {
            if let Some(task) = task.as_object_mut()
                && !task.contains_key("requestId")
            {
                task.insert(
                    "requestId".to_owned(),
                    Value::String(format!("{key}.{index}")),
                );
            }
        }
    }
    arguments
}

/// What a call's answer tells the model.
pub fn output(result: Result<AceToolResult, ToolsError>) -> ToolOutput {
    match result {
        Ok(result) => {
            let parts: Vec<String> = result
                .parts
                .iter()
                .map(|part| match part {
                    Part::Text { text, .. } => text.clone(),
                    Part::Image {
                        mime_type, data, ..
                    } => {
                        format!("[an image, {mime_type}, {} bytes]", data.len() * 3 / 4)
                    }
                    Part::Other(value) => value.to_string(),
                })
                .collect();
            let mut text = parts.join("\n");
            if text.is_empty()
                && let Some(structured) = &result.structured
            {
                text = structured.to_string();
            }
            ToolOutput {
                content: text,
                is_error: result.is_error,
            }
        }
        Err(ToolsError::NotRun(why)) => {
            ToolOutput::error(format!("Not run: {why}. It is safe to try again."))
        }
        Err(error @ (ToolsError::OutcomeUnknown(_) | ToolsError::Timeout)) => {
            ToolOutput::error(format!("{MAYBE_RAN} ({error})"))
        }
        Err(error) => ToolOutput::error(error.to_string()),
    }
}

/// ace's tools as they are now.
pub struct AceSource {
    client: Arc<AceTools>,
    current: RwLock<Vec<Arc<dyn Tool>>>,
}

impl AceSource {
    /// Starts listing ace's tools now, again whenever ace says the list changed, and every few
    /// minutes otherwise.
    pub fn start(client: Arc<AceTools>) -> Arc<Self> {
        let source = Arc::new(Self {
            client,
            current: RwLock::default(),
        });
        let weak = Arc::downgrade(&source);
        tokio::spawn(async move {
            let Some(mut changes) = weak.upgrade().map(|s| s.client.changes()) else {
                return;
            };
            loop {
                let Some(source) = weak.upgrade() else { return };
                source.refresh().await;
                drop(source);
                tokio::select! {
                    changed = changes.changed() => if changed.is_err() { return },
                    _ = tokio::time::sleep(REFRESH) => {}
                }
            }
        });
        source
    }

    async fn refresh(&self) {
        match self.client.tools().await {
            Ok(tools) => {
                let tools: Vec<Arc<dyn Tool>> = tools
                    .iter()
                    .map(|tool| {
                        Arc::new(AceCall {
                            def: def(tool),
                            client: self.client.clone(),
                        }) as Arc<dyn Tool>
                    })
                    .collect();
                *self.current.write().unwrap_or_else(|p| p.into_inner()) = tools;
            }
            Err(error) => tracing::warn!(%error, "could not list ace's tools"),
        }
    }
}

impl ToolSource for AceSource {
    fn tools(&self) -> Vec<Arc<dyn Tool>> {
        self.current
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }
}

struct AceCall {
    def: ToolDef,
    client: Arc<AceTools>,
}

impl Tool for AceCall {
    fn def(&self) -> ToolDef {
        self.def.clone()
    }

    fn run(&self, key: &str, arguments: Value) -> ToolFuture {
        let (client, name) = (self.client.clone(), self.def.spec.name.clone());
        let arguments = with_request_ids(&name, key, arguments);
        Box::pin(async move { output(client.call(&name, arguments).await) })
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{Map, json};

    use super::*;

    fn tool(name: &str, risk: AceRisk) -> AceTool {
        AceTool {
            name: name.into(),
            description: format!("{name} tool"),
            input_schema: json!({ "type": "object" }),
            risk,
        }
    }

    #[test]
    fn ace_tools_are_deferred_keep_their_risk_and_most_output_is_untrusted() {
        let read = def(&tool("thread_read", AceRisk::Read));
        assert!(read.deferred && read.untrusted_output && read.risk == Risk::Read);
        let status = def(&tool("agents_status", AceRisk::Read));
        assert!(!status.untrusted_output);
        let start = def(&tool("thread_start", AceRisk::Write));
        assert_eq!(start.risk, Risk::Write);
        assert!(!start.background);
        assert!(def(&tool("wait", AceRisk::Read)).background);
        assert_eq!(
            def(&tool("delete", AceRisk::Destructive)).risk,
            Risk::Destructive
        );
    }

    #[test]
    fn each_delegated_task_gets_a_stable_request_id_unless_the_model_gave_one() {
        let arguments = json!({ "tasks": [
            { "task": "fix the bug", "role": "Fix-bug" },
            { "task": "write docs", "role": "Docs", "requestId": "mine" }
        ]});
        let keyed = with_request_ids("delegate", "c_1.call_7", arguments.clone());
        assert_eq!(keyed["tasks"][0]["requestId"], "c_1.call_7.0");
        assert_eq!(keyed["tasks"][1]["requestId"], "mine");
        assert_eq!(
            with_request_ids("delegate", "c_1.call_7", arguments.clone()),
            keyed
        );
        assert_eq!(
            with_request_ids("thread_start", "c_1.call_7", arguments.clone()),
            arguments
        );
    }

    #[test]
    fn a_call_that_may_have_run_says_so_and_one_that_did_not_is_safe_to_retry() {
        let unknown = output(Err(ToolsError::OutcomeUnknown("connection reset".into())));
        assert!(unknown.is_error && unknown.content.starts_with("Unknown outcome"));
        let timed_out = output(Err(ToolsError::Timeout));
        assert!(timed_out.content.starts_with("Unknown outcome"));
        let not_run = output(Err(ToolsError::NotRun("session expired".into())));
        assert!(not_run.content.contains("safe to try again"));
    }

    #[test]
    fn a_result_reads_as_its_text_with_images_named_and_errors_kept() {
        let result = AceToolResult {
            parts: vec![
                Part::text("Opened the page."),
                Part::Image {
                    mime_type: "image/png".into(),
                    data: "aGVsbG8h".into(),
                    extra: Map::new(),
                },
            ],
            is_error: true,
            structured: None,
            extra: Map::new(),
        };
        let shown = output(Ok(result));
        assert_eq!(
            shown.content,
            "Opened the page.\n[an image, image/png, 6 bytes]"
        );
        assert!(shown.is_error);
    }
}
