// SPDX-License-Identifier: Apache-2.0
//! Protocol leaf types the item fold reads or validates, mirroring
//! `packages/protocol` JSON for JSON. Optional fields are omitted, never
//! `null`. Unknown fields are rejected at validation (the Zod schemas strip
//! them and `preservesFields` then fails), so every struct below denies them;
//! the few `passthrough` / `z.unknown()` leaves keep their bytes verbatim in
//! `Box<RawValue>`.

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;

use crate::error::CoreError;
use crate::json_io::{Json, Map, de_i64};

/// A provider's original payload, stored verbatim.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
#[serde(untagged)]
pub enum RawPayload {
    /// The native payload with its type, name and data.
    Inline {
        #[serde(rename = "type")]
        payload_type: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        data: Box<RawValue>,
    },
    /// A blob reference the daemon resolves on demand.
    Blob {
        #[serde(rename = "type")]
        payload_type: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(rename = "blobRef")]
        blob_ref: String,
        #[serde(deserialize_with = "de_i64")]
        size: i64,
        #[serde(skip_serializing_if = "Option::is_none")]
        preview: Option<String>,
    },
}

/// Adapter-owned identity: native ids within a provider process.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NativeRef {
    pub provider: String,
    #[serde(rename = "acpAgentId", skip_serializing_if = "Option::is_none")]
    pub acp_agent_id: Option<String>,
    #[serde(rename = "installationId", skip_serializing_if = "Option::is_none")]
    pub installation_id: Option<String>,
    #[serde(rename = "instanceId", skip_serializing_if = "Option::is_none")]
    pub instance_id: Option<String>,
    #[serde(rename = "nativeId", skip_serializing_if = "Option::is_none")]
    pub native_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(rename = "forkedFromNativeId", skip_serializing_if = "Option::is_none")]
    pub forked_from_native_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub aliases: Option<Vec<String>>,
}

/// Where a text's whole value lives when the carried text is a preview.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TextSource {
    #[serde(rename = "streamId")]
    pub stream_id: String,
    #[serde(deserialize_with = "de_i64")]
    pub bytes: i64,
    pub encoding: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offset: Option<i64>,
}

/// A bounded native document or resource prepared by the daemon.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Attachment {
    pub sha256: String,
    pub bytes: i64,
    #[serde(rename = "mimeType")]
    pub mime_type: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivery: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<i64>,
    #[serde(rename = "thumbnailAvailable", skip_serializing_if = "Option::is_none")]
    pub thumbnail_available: Option<bool>,
}

/// A single file change, normalised from provider edits.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FileChange {
    pub path: String,
    pub kind: String,
    #[serde(rename = "movePath", skip_serializing_if = "Option::is_none")]
    pub move_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diff: Option<String>,
    #[serde(rename = "oldText", skip_serializing_if = "Option::is_none")]
    pub old_text: Option<Option<String>>,
    #[serde(rename = "newText", skip_serializing_if = "Option::is_none")]
    pub new_text: Option<String>,
}

/// One entry of a plan or todo list.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TodoEntry {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub content: String,
    pub status: String,
}

/// Bounded native file content carried beside a file part.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "encoding", deny_unknown_fields)]
pub enum FileContent {
    /// Base64 bytes, at most 44 MiB of characters.
    #[serde(rename = "base64")]
    Base64 {
        data: String,
    },
    /// Text, at most 128 KiB.
    #[serde(rename = "text")]
    Text {
        data: String,
    },
}

/// One content part of a message.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
pub enum ContentPart {
    /// A catalog mention (skill, command, plugin, agent, workflow…).
    #[serde(rename = "mention")]
    Mention {
        #[serde(rename = "entryId")]
        entry_id: String,
        name: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        kind: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        icon: Option<String>,
        #[serde(default)]
        arguments: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        values: Option<Box<RawValue>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        invocation: Option<Box<RawValue>>,
    },
    /// Plain text, with its stream source when it is a preview.
    #[serde(rename = "text")]
    Text {
        text: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        source: Option<TextSource>,
    },
    /// An image by URL.
    #[serde(rename = "image")]
    Image {
        #[serde(rename = "mimeType")]
        mime_type: String,
        url: String,
    },
    /// A file by path, with bounded content when the daemon prepared it.
    #[serde(rename = "file")]
    File {
        path: String,
        #[serde(rename = "mimeType", skip_serializing_if = "Option::is_none")]
        mime_type: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        content: Option<FileContent>,
    },
}

/// The normalised view of a call, by kind.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum ToolDetail {
    /// A shell command with its bounded output summary.
    #[serde(rename = "shell")]
    Shell {
        command: String,
        #[serde(rename = "rawCommand", skip_serializing_if = "Option::is_none")]
        raw_command: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
        #[serde(rename = "exitCode", skip_serializing_if = "Option::is_none")]
        exit_code: Option<Option<i64>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        output: Option<OutputSummary>,
    },
    /// Reading a file, with an optional line range.
    #[serde(rename = "file.read")]
    FileRead {
        path: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        range: Option<LineRange>,
    },
    /// Editing, writing, deleting or moving files.
    #[serde(rename = "file.edit")]
    FileEdit {
        changes: Vec<FileChange>,
    },
    /// Writing a file.
    #[serde(rename = "file.write")]
    FileWrite {
        changes: Vec<FileChange>,
    },
    /// Deleting a file.
    #[serde(rename = "file.delete")]
    FileDelete {
        changes: Vec<FileChange>,
    },
    /// Moving a file.
    #[serde(rename = "file.move")]
    FileMove {
        changes: Vec<FileChange>,
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
    },
    /// A web search.
    #[serde(rename = "web.search")]
    WebSearch {
        query: String,
    },
    /// Fetching a URL.
    #[serde(rename = "web.fetch")]
    WebFetch {
        url: String,
    },
    /// An MCP tool call with its verbatim arguments.
    #[serde(rename = "mcp")]
    Mcp {
        server: String,
        tool: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        arguments: Option<Box<RawValue>>,
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
    },
    /// Messaging another agent.
    #[serde(rename = "agent.message")]
    AgentMessage {
        #[serde(rename = "targetAgentId", skip_serializing_if = "Option::is_none")]
        target_agent_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    /// A todo list.
    #[serde(rename = "todo")]
    Todo {
        todos: Vec<TodoEntry>,
    },
    /// A plan with its markdown and todos.
    #[serde(rename = "plan")]
    Plan {
        #[serde(skip_serializing_if = "Option::is_none")]
        markdown: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        todos: Option<Vec<TodoEntry>>,
    },
    /// Asking the person (the native ask-user tool).
    #[serde(rename = "ask_user")]
    AskUser,
    /// An image the agent posted.
    #[serde(rename = "image")]
    Image {
        #[serde(skip_serializing_if = "Option::is_none")]
        path: Option<String>,
        #[serde(rename = "sourcePath", skip_serializing_if = "Option::is_none")]
        source_path: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        attachment: Option<Attachment>,
        #[serde(skip_serializing_if = "Option::is_none")]
        unavailable: Option<String>,
    },
    /// A browser, notebook or custom tool call.
    #[serde(rename = "browser")]
    Browser,
    /// A notebook tool call.
    #[serde(rename = "notebook")]
    Notebook,
    /// Any other provider tool call.
    #[serde(rename = "custom")]
    Custom,
}

/// A line range within a file.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LineRange {
    #[serde(deserialize_with = "de_i64")]
    pub start: i64,
    #[serde(deserialize_with = "de_i64")]
    pub end: i64,
}

/// Full output lives in the daemon stream store; the summary stays bounded.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OutputSummary {
    #[serde(rename = "streamId")]
    pub stream_id: String,
    #[serde(deserialize_with = "de_i64")]
    pub bytes: i64,
    #[serde(default)]
    pub tail: String,
    pub truncated: bool,
}

/// One tool call in the transcript.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
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
}

/// The JSON behind a vetted-but-opaque leaf: validated structurally,
/// stored verbatim so clients read back exactly what the adapter sent.
pub type Vetted = Box<RawValue>;

/// Read a vetted leaf back as JSON for validation.
pub fn vetted_json(raw: &RawValue) -> Result<Json, CoreError> {
    serde_json::from_str(raw.get()).map_err(CoreError::invalid_json)
}

/// Re-encode a JSON subtree verbatim for vetted storage.
pub fn vet_json(value: &Json) -> Result<Vetted, CoreError> {
    let text = serde_json::to_string(value).map_err(CoreError::invalid_json)?;
    crate::json_io::raw_from(&text)
}

/// The passthrough extras of an approval's MCP server: kept, never dropped.
pub type Passthrough = Map;
