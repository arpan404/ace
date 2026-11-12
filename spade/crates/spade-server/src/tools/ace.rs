//! How ace's own tools (threads, agents, browser, screen, automations) are offered and called.
//! Every tool is offered deferred, so the model finds them with `tool_search` and the tool list it
//! is sent never changes; [`super::AceLink`] keeps the list current.

use std::sync::Arc;

use serde_json::Value;
use spade_ace::{AceTool, AceToolResult, AceTools, Part, Risk as AceRisk, ToolsError};
use spade_core::context::MAYBE_RAN;
use spade_core::tools::{Risk, ToolDef};
use spade_models::ToolSpec;

use super::{Tool, ToolFuture, ToolOutput};

/// ace's tools whose output is only ace's own state, never text from outside (web pages, agents'
/// output, other people). Every other ace tool's output is untrusted, so writes after it ask.
/// (Tools that return agents' output or notes, such as agents_status, context and threads_find,
/// are untrusted: an agent may have read a page written to trick Spade.)
const TRUSTED: &[&str] = &["machines", "models", "projects_find", "automations_list"];

/// ace's tools that can run for minutes, run as background jobs. `delegate` waits for its
/// children there, so the conversation shows as working while they run and their results come
/// back as a `<job_result>`; nothing wakes Spade when a child finishes otherwise.
const BACKGROUND: &[&str] = &["wait", "delegate"];

/// How long a background `delegate` waits for its children unless the model asked otherwise.
const DELEGATE_WAIT_SECONDS: u64 = 600;

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

/// Prepares a `delegate` call. Each task's request id is scoped to this call's key, which is
/// unique across conversations and stable across retries: a retried call, even after a restart,
/// returns the same children, and two conversations can never collide on a model's "task-1". The
/// call waits for its children (it runs as a background job) unless the model set a wait.
pub fn prepare_delegate(name: &str, key: &str, mut arguments: Value) -> Value {
    if name != "delegate" {
        return arguments;
    }
    let scope = id_safe(key);
    if let Some(tasks) = arguments.get_mut("tasks").and_then(Value::as_array_mut) {
        for (index, task) in tasks.iter_mut().enumerate() {
            if let Some(task) = task.as_object_mut() {
                let own = task
                    .get("requestId")
                    .and_then(Value::as_str)
                    .map(id_safe)
                    .filter(|id| !id.is_empty())
                    .unwrap_or_else(|| index.to_string());
                task.insert(
                    "requestId".to_owned(),
                    Value::String(format!("{scope}.{own}")),
                );
            }
        }
    }
    if let Some(object) = arguments.as_object_mut() {
        object
            .entry("waitSeconds")
            .or_insert(Value::from(DELEGATE_WAIT_SECONDS));
    }
    arguments
}

/// Only the characters ace accepts in an id (`[A-Za-z0-9_.-]`); anything else becomes `_`.
fn id_safe(text: &str) -> String {
    text.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-') {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// What a call's answer tells the model.
pub fn output(result: Result<AceToolResult, ToolsError>) -> ToolOutput {
    match result {
        Ok(result) => {
            let mut images = Vec::new();
            let parts: Vec<String> = result
                .parts
                .iter()
                .map(|part| match part {
                    Part::Text { text, .. } => text.clone(),
                    Part::Image {
                        mime_type, data, ..
                    } => match crate::images::decode(data) {
                        Ok(bytes) => {
                            images.push(bytes);
                            format!("[an image, {mime_type}, shown below]")
                        }
                        Err(error) => {
                            format!("[an image, {mime_type}, that could not be read: {error}]")
                        }
                    },
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
                uncertain: false,
                images,
                untrusted: false,
                files: Box::default(),
                shared: crate::tools::Shared::default(),
            }
        }
        Err(ToolsError::NotRun(why)) => {
            ToolOutput::error(format!("Not run: {why}. It is safe to try again."))
        }
        Err(error @ (ToolsError::OutcomeUnknown(_) | ToolsError::Timeout)) => {
            ToolOutput::maybe_ran(format!("{MAYBE_RAN} ({error})"))
        }
        Err(error) => ToolOutput::error(error.to_string()),
    }
}

/// Spade's tools for ace's `list`, each calling through `client`.
pub(crate) fn tools(client: &Arc<AceTools>, list: &[AceTool]) -> Vec<Arc<dyn Tool>> {
    list.iter()
        .map(|tool| {
            Arc::new(AceCall {
                def: def(tool),
                client: client.clone(),
            }) as Arc<dyn Tool>
        })
        .collect()
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
        let arguments = prepare_delegate(&name, key, arguments);
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
        assert!(def(&tool("agents_status", AceRisk::Read)).untrusted_output);
        assert!(!def(&tool("machines", AceRisk::Read)).untrusted_output);
        assert!(def(&tool("delegate", AceRisk::Write)).background);
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
    fn delegated_tasks_get_ids_scoped_to_the_call_and_wait_for_their_children() {
        let arguments = json!({ "tasks": [
            { "task": "fix the bug", "role": "Fix-bug" },
            { "task": "write docs", "role": "Docs", "requestId": "task 1" }
        ]});
        let key = "c_1.functions.delegate:0";
        let prepared = prepare_delegate("delegate", key, arguments.clone());
        assert_eq!(
            prepared["tasks"][0]["requestId"],
            "c_1.functions.delegate_0.0"
        );
        assert_eq!(
            prepared["tasks"][1]["requestId"],
            "c_1.functions.delegate_0.task_1"
        );
        assert_eq!(prepared["waitSeconds"], 600);
        assert_eq!(
            prepare_delegate("delegate", key, arguments.clone()),
            prepared,
            "stable on retry"
        );
        let other = prepare_delegate("delegate", "c_2.functions.delegate:0", arguments.clone());
        assert_ne!(
            other["tasks"][1]["requestId"],
            prepared["tasks"][1]["requestId"]
        );
        let asked = prepare_delegate("delegate", key, json!({ "tasks": [], "waitSeconds": 30 }));
        assert_eq!(asked["waitSeconds"], 30);
        assert_eq!(
            prepare_delegate("thread_start", key, arguments.clone()),
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
    fn a_result_reads_as_its_text_with_images_passed_on_and_errors_kept() {
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
            "Opened the page.
[an image, image/png, shown below]"
        );
        assert_eq!(shown.images, vec![b"hello!".to_vec()]);
        assert!(shown.is_error);
    }
}
