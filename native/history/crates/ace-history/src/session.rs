// SPDX-License-Identifier: Apache-2.0

//! A saved session's summary: `HistorySession` in `@ace/protocol/history`, with its fields in the
//! schema's order, as the TypeScript reader stored it.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum Support {
    Supported,
    Unsupported { reason: String },
}

impl Support {
    pub fn unsupported(reason: impl Into<String>) -> Support {
        Support::Unsupported {
            reason: reason.into(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Accuracy {
    Exact,
    Sampled,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub instance_id: String,
    pub provider: String,
    pub native_id: String,
    pub cwd: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub last_activity: i64,
    pub message_count: i64,
    pub count_accuracy: Accuracy,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_native_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub continuation: Option<Support>,
    pub support: Support,
}

/// `sourceId`: one source of one session in one home.
pub fn source_id(instance: &str, path: &str, native_id: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(instance.as_bytes());
    hash.update([0]);
    hash.update(path.as_bytes());
    hash.update([0]);
    hash.update(native_id.as_bytes());
    hash.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// How a catalog row stores its source.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Jsonl,
    Database,
    Storage,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Jsonl => "jsonl",
            Kind::Database => "database",
            Kind::Storage => "storage",
        }
    }

    pub fn parse(text: &str) -> Option<Kind> {
        match text {
            "jsonl" => Some(Kind::Jsonl),
            "database" => Some(Kind::Database),
            "storage" => Some(Kind::Storage),
            _ => None,
        }
    }
}

/// One catalog row: a summary and where it was read from (`Source` in catalog.ts).
#[derive(Debug, Clone, PartialEq)]
pub struct Source {
    pub summary: Session,
    pub path: String,
    pub fingerprint: String,
    pub kind: Kind,
    pub instance_id: String,
    pub hidden: bool,
}
