// SPDX-License-Identifier: Apache-2.0
//! Stored tool call records and their tagged details.

use serde::{Deserialize, Serialize};

use crate::item_model::{Attachment, FileChange, RawPayload, TodoEntry};
use crate::json_io::de_i64;

/// The normalised view of a call, by kind.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum ToolDetail {
    /// A shell command with its bounded output summary.
    #[serde(rename = "shell")]
    Shell {
        command: String,
        #[serde(rename = "rawCommand", skip_serializing_if = "Option::is_none")]
        raw_command: Option<String>,
        /// What the provider says the command is for (Claude's Bash `description`).
        #[serde(skip_serializing_if = "Option::is_none")]
        description: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
        #[serde(rename = "exitCode", skip_serializing_if = "Option::is_none")]
        exit_code: Option<Option<i64>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        output: Option<OutputSummary>,
        #[serde(flatten, default, skip_serializing_if = "serde_json::Map::is_empty")]
        extra: serde_json::Map<String, serde_json::Value>,
    },
    /// Reading a file, with an optional line range.
    #[serde(rename = "file.read")]
    FileRead {
        path: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        range: Option<LineRange>,
        #[serde(flatten, default, skip_serializing_if = "serde_json::Map::is_empty")]
        extra: serde_json::Map<String, serde_json::Value>,
    },
    /// Editing, writing, deleting or moving files.
    #[serde(rename = "file.edit")]
    FileEdit {
        changes: Vec<FileChange>,
        #[serde(flatten, default, skip_serializing_if = "serde_json::Map::is_empty")]
        extra: serde_json::Map<String, serde_json::Value>,
    },
    /// Writing a file.
    #[serde(rename = "file.write")]
    FileWrite {
        changes: Vec<FileChange>,
        #[serde(flatten, default, skip_serializing_if = "serde_json::Map::is_empty")]
        extra: serde_json::Map<String, serde_json::Value>,
    },
    /// Deleting a file.
    #[serde(rename = "file.delete")]
    FileDelete {
        changes: Vec<FileChange>,
        #[serde(flatten, default, skip_serializing_if = "serde_json::Map::is_empty")]
        extra: serde_json::Map<String, serde_json::Value>,
    },
    /// Moving a file.
    #[serde(rename = "file.move")]
    FileMove {
        changes: Vec<FileChange>,
        #[serde(flatten, default, skip_serializing_if = "serde_json::Map::is_empty")]
        extra: serde_json::Map<String, serde_json::Value>,
    },
    /// Searching code or the tool list.
    #[serde(rename = "search")]
    Search {
        query: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        path: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        matches: Option<i64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        scope: Option<String>,
        #[serde(flatten, default, skip_serializing_if = "serde_json::Map::is_empty")]
        extra: serde_json::Map<String, serde_json::Value>,
    },
    /// A web search.
    #[serde(rename = "web.search")]
    WebSearch {
        query: String,
        #[serde(flatten, default, skip_serializing_if = "serde_json::Map::is_empty")]
        extra: serde_json::Map<String, serde_json::Value>,
    },
    /// Fetching a URL.
    #[serde(rename = "web.fetch")]
    WebFetch {
        url: String,
        #[serde(flatten, default, skip_serializing_if = "serde_json::Map::is_empty")]
        extra: serde_json::Map<String, serde_json::Value>,
    },
    /// An MCP tool call with its verbatim arguments.
    #[serde(rename = "mcp")]
    Mcp {
        server: String,
        tool: String,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::json_io::deserialize_opt_raw",
            serialize_with = "crate::json_io::serialize_opt_raw"
        )]
        arguments: Option<ace_json::Raw>,
        #[serde(flatten, default, skip_serializing_if = "serde_json::Map::is_empty")]
        extra: serde_json::Map<String, serde_json::Value>,
    },
    /// Spawning a subagent.
    #[serde(rename = "agent.spawn")]
    AgentSpawn {
        #[serde(skip_serializing_if = "Option::is_none")]
        description: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        prompt: Option<String>,
        #[serde(rename = "agentType", skip_serializing_if = "Option::is_none")]
        agent_type: Option<String>,
        #[serde(rename = "childAgentId", skip_serializing_if = "Option::is_none")]
        child_agent_id: Option<String>,
        #[serde(flatten, default, skip_serializing_if = "serde_json::Map::is_empty")]
        extra: serde_json::Map<String, serde_json::Value>,
    },
    /// Messaging another agent.
    #[serde(rename = "agent.message")]
    AgentMessage {
        #[serde(rename = "targetAgentId", skip_serializing_if = "Option::is_none")]
        target_agent_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
        #[serde(flatten, default, skip_serializing_if = "serde_json::Map::is_empty")]
        extra: serde_json::Map<String, serde_json::Value>,
    },
    /// A todo list.
    #[serde(rename = "todo")]
    Todo {
        todos: Vec<TodoEntry>,
        #[serde(flatten, default, skip_serializing_if = "serde_json::Map::is_empty")]
        extra: serde_json::Map<String, serde_json::Value>,
    },
    /// A plan with its markdown and todos.
    #[serde(rename = "plan")]
    Plan {
        #[serde(skip_serializing_if = "Option::is_none")]
        markdown: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        todos: Option<Vec<TodoEntry>>,
        #[serde(flatten, default, skip_serializing_if = "serde_json::Map::is_empty")]
        extra: serde_json::Map<String, serde_json::Value>,
    },
    /// Asking the person (the native ask-user tool).
    #[serde(rename = "ask_user")]
    // No unknown fields are possible in this unit variant.
    AskUser,
    /// An image the agent posted.
    #[serde(rename = "image")]
    Image {
        #[serde(skip_serializing_if = "Option::is_none")]
        path: Option<String>,
        #[serde(rename = "sourcePath", skip_serializing_if = "Option::is_none")]
        source_path: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        attachment: Option<Box<Attachment>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        unavailable: Option<String>,
        #[serde(flatten, default, skip_serializing_if = "serde_json::Map::is_empty")]
        extra: serde_json::Map<String, serde_json::Value>,
    },
    /// A browser, notebook or custom tool call.
    #[serde(rename = "browser")]
    // No unknown fields are possible in this unit variant.
    Browser,
    /// A notebook tool call.
    #[serde(rename = "notebook")]
    // No unknown fields are possible in this unit variant.
    Notebook,
    /// Any other provider tool call.
    #[serde(rename = "custom")]
    // No unknown fields are possible in this unit variant.
    Custom,
}

/// A line range within a file.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde()]
pub struct LineRange {
    #[serde(deserialize_with = "de_i64")]
    pub start: i64,
    #[serde(deserialize_with = "de_i64")]
    pub end: i64,
}

/// Full output lives in the daemon stream store; the summary stays bounded.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde()]
pub struct OutputSummary {
    #[serde(rename = "streamId")]
    pub stream_id: String,
    #[serde(deserialize_with = "de_i64")]
    pub bytes: i64,
    #[serde(default)]
    pub tail: String,
    pub truncated: bool,
}

/// One tool call in the transcript. Its JSON order is written in `item_json`.
#[derive(Debug, Clone, Deserialize)]
#[serde()]
pub struct ToolCall {
    pub id: String,
    #[serde(rename = "agentId")]
    pub agent_id: String,
    pub kind: String,
    /// Human-readable one-liner, e.g. "Read src/math.ts".
    pub title: String,
    pub status: String,
    pub detail: ToolDetail,
    /// Set when the call outlives the turn.
    #[serde(rename = "backgroundTaskId", skip_serializing_if = "Option::is_none")]
    pub background_task_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<crate::item_meta::ToolResult>,
    #[serde(rename = "startedAt", deserialize_with = "de_i64")]
    pub started_at: i64,
    #[serde(rename = "endedAt", skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<i64>,
    /// Complete native call and result, verbatim.
    #[serde(default)]
    pub raw: Vec<RawPayload>,
    /// Keys the fold added after the item was parsed (`item.call.backgroundTaskId = ...`):
    /// JavaScript appends a new own key at the end, so they serialize last.
    #[serde(skip)]
    pub trailing: Vec<&'static str>,

    /// Fields a newer build wrote; the raw record keeps them.
    #[serde(flatten, default, skip_serializing_if = "serde_json::Map::is_empty")]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl ToolCall {
    /// Record a key the fold appended, as `item.call[key] = value` does for a new key.
    pub fn appended(&mut self, key: &'static str) {
        if !self.trailing.contains(&key) {
            self.trailing.push(key);
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::item_input::{ItemIdentity, merge_candidate, tool_detail_kind};
    use crate::items::Item;
    use crate::json_io::{Json, parse_typed, to_value};

    #[test]
    fn tool_detail_extras_round_trip_only_for_the_same_kind() {
        let prior: Item = parse_typed(
            r#"{"type":"tool_call","id":"i","agentId":"a","createdAt":1,"call":{
                 "id":"i","agentId":"a","kind":"shell","title":"shell","status":"pending",
                 "startedAt":1,"detail":{"kind":"shell","command":"pwd","future":{"value":[1,null]}}
               }}"#,
        )
        .unwrap();
        let Item::ToolCall { call, .. } = &prior else {
            panic!("expected a tool call");
        };
        assert_eq!(tool_detail_kind(&call.detail), "shell");
        let stored = ace_json::ser::to_string(&call.detail).unwrap();
        assert_eq!(stored.matches(r#""future":"#).count(), 1);
        assert_eq!(stored.matches(r#""kind":"#).count(), 1);

        for (patch, expected_detail) in [
            (
                r#"{"type":"tool_call","call":{"detail":{"kind":"shell","command":"ls"}}}"#,
                r#"{"kind":"shell","command":"ls","future":{"value":[1,null]}}"#,
            ),
            (
                r#"{"type":"tool_call","call":{"kind":"web.search","detail":{"kind":"web.search","query":"rust"}}}"#,
                r#"{"kind":"web.search","query":"rust"}"#,
            ),
        ] {
            assert_eq!(
                patched_detail(&prior, patch),
                parse_typed::<Json>(expected_detail).unwrap()
            );
        }
    }

    #[test]
    fn mcp_detail_extras_survive_normalizing_a_custom_draft() {
        let prior = parse_typed(
            r#"{"type":"tool_call","id":"i","agentId":"a","createdAt":1,"call":{
                 "id":"i","agentId":"a","kind":"mcp","title":"browser_snapshot","status":"pending",
                 "startedAt":1,"detail":{"kind":"mcp","server":"ace","tool":"browser_snapshot","arguments":{"limit":1},"future":true}
               }}"#,
        ).unwrap();
        let patch = r#"{"type":"tool_call","call":{"kind":"custom","title":"mcp__ace__browser_snapshot","detail":{"kind":"custom"}}}"#;
        assert_eq!(
            patched_detail(&prior, patch),
            parse_typed::<Json>(
                r#"{"kind":"mcp","server":"ace","tool":"browser_snapshot","arguments":{"limit":1},"future":true}"#,
            ).unwrap()
        );
    }

    fn patched_detail(prior: &Item, patch: &str) -> Json {
        let base = ItemIdentity {
            id: "i".to_owned(),
            agent_id: "a".to_owned(),
            created_at: 1,
            run_id: None,
        };
        let Json::Object(patch) = parse_typed::<Json>(patch).unwrap() else {
            panic!("expected an item patch");
        };
        let Some(Json::Object(detail_patch)) =
            patch.get("call").and_then(|call| call.get("detail"))
        else {
            panic!("expected a detail patch");
        };
        let item: Item = crate::json_io::decode(&Json::Object(merge_candidate(
            Some(prior),
            &base,
            &patch,
            1,
            Some(detail_patch),
        )))
        .unwrap();
        let Item::ToolCall { call, .. } = &item else {
            panic!("expected a tool call");
        };
        to_value(&call.detail)
    }
}
