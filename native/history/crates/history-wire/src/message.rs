// SPDX-License-Identifier: Apache-2.0

//! The messages the daemon sends, as the reader worker received them.

use serde::Deserialize;
use serde_json::{Value, json};

/// One message from the daemon.
#[derive(Debug, Clone, PartialEq)]
pub enum Inbound {
    /// The reader's options, the first message.
    Init(Value),
    /// A request. `request` is `Err` with the op's name when this build does not know it.
    Envelope {
        id: i64,
        request: Result<Request, String>,
    },
    /// Abort the running scan or import.
    Cancel,
    /// Anything else, ignored as the worker ignored it.
    Unknown,
}

impl Inbound {
    /// Read one JSON message. Unknown shapes are [`Inbound::Unknown`], never an error.
    pub fn parse(text: &[u8]) -> Inbound {
        let Ok(value) = serde_json::from_slice::<Value>(text) else {
            return Inbound::Unknown;
        };
        if value.as_str() == Some("cancel") {
            return Inbound::Cancel;
        }
        let Some(object) = value.as_object() else {
            return Inbound::Unknown;
        };
        if let Some(init) = object.get("init") {
            return Inbound::Init(init.clone());
        }
        let (Some(id), Some(request)) = (
            object.get("id").and_then(Value::as_i64),
            object.get("request"),
        ) else {
            return Inbound::Unknown;
        };
        let op = request
            .get("op")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        let request = serde_json::from_value::<Request>(request.clone()).map_err(|_| op);
        Inbound::Envelope { id, request }
    }
}

/// A placeholder for the n-th body of a message.
pub fn body_ref(index: usize) -> Value {
    json!({ "$body": index })
}

/// The body index a placeholder names.
pub fn take_body_index(value: &Value) -> Option<usize> {
    value
        .get("$body")
        .and_then(Value::as_u64)
        .and_then(|n| usize::try_from(n).ok())
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "op")]
pub enum Request {
    #[serde(rename = "archive.write")]
    ArchiveWrite { command: ArchiveCommand },
    #[serde(rename = "archive.thread")]
    ArchiveThread { id: String },
    #[serde(rename = "archive.source")]
    ArchiveSource { id: String },
    #[serde(rename = "archive.delete")]
    ArchiveDelete { id: String },
    #[serde(rename = "archive.agents")]
    ArchiveAgents { id: String },
    #[serde(rename = "archive.page")]
    ArchivePage { request: PageRequest },
    #[serde(rename = "archive.blob")]
    ArchiveBlob { request: BlobRequest },
    #[serde(rename = "scan")]
    Scan,
    #[serde(rename = "list")]
    List {
        request: ListRequest,
        #[serde(default)]
        exclude: Vec<String>,
    },
    #[serde(rename = "get")]
    Get { id: String },
    #[serde(rename = "reference")]
    Reference { id: String },
    #[serde(rename = "import")]
    Import { init: ImportInit },
    #[serde(rename = "import.persist")]
    ImportPersist { init: ImportInit },
    #[serde(rename = "next")]
    Next,
    #[serde(rename = "return")]
    Return,
    #[serde(rename = "close")]
    Close,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportInit {
    pub source_id: String,
    pub thread_id: String,
    pub workspace_id: String,
    pub agent_id: String,
    pub at: i64,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListRequest {
    pub cwd: String,
    #[serde(default)]
    pub search: Option<String>,
    #[serde(default)]
    pub openable_only: Option<bool>,
    #[serde(default = "default_list_limit")]
    pub limit: i64,
    #[serde(default)]
    pub before: Option<ListBefore>,
}

fn default_list_limit() -> i64 {
    50
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListBefore {
    pub last_activity: i64,
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageRequest {
    pub thread_id: String,
    #[serde(default)]
    pub after: i64,
    #[serde(default = "default_page_limit")]
    pub limit: i64,
}

fn default_page_limit() -> i64 {
    200
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct BlobRequest {
    pub id: String,
    pub offset: i64,
    pub limit: i64,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "type")]
pub enum ArchiveCommand {
    #[serde(rename = "begin")]
    Begin { thread: Value },
    #[serde(rename = "agent")]
    Agent { agent: Value },
    #[serde(rename = "item")]
    Item { item: Value },
    #[serde(rename = "blob.start")]
    BlobStart { id: String, bytes: i64 },
    /// `bytes` is a body placeholder; see [`take_body_index`].
    #[serde(rename = "blob.chunk")]
    BlobChunk { id: String, bytes: Value },
    #[serde(rename = "blob.end")]
    BlobEnd { id: String },
    #[serde(rename = "commit")]
    Commit,
    #[serde(rename = "rollback")]
    Rollback,
}
