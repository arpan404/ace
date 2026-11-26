// SPDX-License-Identifier: Apache-2.0
//! Stored transcript items and their shared record fields.

use std::ops::{Deref, DerefMut};

use ace_json::JsString;
use serde::{Deserialize, Serialize};

use crate::item_meta::{DelegationSettled, DelegationStarted};
use crate::item_model::{Attachment, ContentPart, RawPayload, TextSource, ToolCall, Vetted};
pub use crate::{item_delta::append_item, item_upsert::upsert_item};

/// Agent-owned transcript entries, plus the thread-level rows the core folds.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type")]
pub enum Item {
    /// A visualization.
    #[serde(rename = "html")]
    Html {
        #[serde(flatten)]
        base: ItemBase,
        visualization: Vetted,
        #[serde(default)]
        raw: Vec<RawPayload>,
    },
    /// A shared image.
    #[serde(rename = "image")]
    Image {
        #[serde(flatten)]
        base: ItemBase,
        image: Vetted,
        #[serde(default)]
        raw: Vec<RawPayload>,
    },
    /// A user or assistant message.
    #[serde(rename = "message")]
    Message {
        #[serde(flatten)]
        base: ItemBase,
        role: String,
        #[serde(default)]
        parts: Vec<ContentPart>,
        #[serde(skip_serializing_if = "Option::is_none")]
        attachments: Option<Vec<Attachment>>,
        #[serde(default)]
        synthetic: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        origin: Option<crate::item_meta::MessageOrigin>,
        #[serde(rename = "notAnswered", skip_serializing_if = "Option::is_none")]
        not_answered: Option<String>,
        #[serde(rename = "mergedContext", skip_serializing_if = "Option::is_none")]
        merged_context: Option<Vetted>,
        #[serde(skip_serializing_if = "Option::is_none")]
        speaker: Option<crate::item_meta::Speaker>,
        #[serde(default)]
        raw: Vec<RawPayload>,
    },
    /// A delegated child thread started. The payload owns the extra fields.
    #[serde(rename = "delegation.started")]
    DelegationStarted {
        #[serde(flatten)]
        base: ItemFields,
        #[serde(flatten)]
        delegation: DelegationStarted,
        #[serde(default)]
        raw: Vec<RawPayload>,
    },
    /// A delegated child thread settled. The payload owns the extra fields.
    #[serde(rename = "delegation.settled")]
    DelegationSettled {
        #[serde(flatten)]
        base: ItemFields,
        #[serde(flatten)]
        delegation: DelegationSettled,
        #[serde(default)]
        raw: Vec<RawPayload>,
    },
    /// Provider thinking.
    #[serde(rename = "reasoning")]
    Reasoning {
        #[serde(flatten)]
        base: ItemBase,
        text: JsString,
        #[serde(skip_serializing_if = "Option::is_none")]
        source: Option<TextSource>,
        #[serde(default)]
        summary: bool,
        #[serde(default)]
        raw: Vec<RawPayload>,
    },
    /// One tool call.
    #[serde(rename = "tool_call")]
    ToolCall {
        #[serde(flatten)]
        base: ItemBase,
        call: ToolCall,
        #[serde(skip_serializing_if = "Option::is_none")]
        measurement: Option<Vetted>,
    },
    /// A notice: warnings, errors, and adapter evidence.
    #[serde(rename = "notice")]
    Notice {
        #[serde(flatten)]
        base: ItemBase,
        level: String,
        #[serde(rename = "commandId", skip_serializing_if = "Option::is_none")]
        command_id: Option<String>,
        #[serde(rename = "interactionId", skip_serializing_if = "Option::is_none")]
        interaction_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        code: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        diagnostic: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        details: Option<crate::status::ProviderErrorDetails>,
        #[serde(rename = "toolCallId", skip_serializing_if = "Option::is_none")]
        tool_call_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        measurement: Option<Vetted>,
        #[serde(skip_serializing_if = "Option::is_none")]
        asked: Option<crate::item_meta::AskedLine>,
        text: JsString,
        #[serde(skip_serializing_if = "Option::is_none")]
        source: Option<TextSource>,
        #[serde(default)]
        raw: Vec<RawPayload>,
    },
    /// A compaction summary.
    #[serde(rename = "compaction")]
    Compaction {
        #[serde(flatten)]
        base: ItemBase,
        #[serde(rename = "tokensBefore", skip_serializing_if = "Option::is_none")]
        tokens_before: Option<i64>,
        #[serde(rename = "tokensAfter", skip_serializing_if = "Option::is_none")]
        tokens_after: Option<i64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        summary: Option<String>,
        #[serde(default)]
        raw: Vec<RawPayload>,
    },
    /// A newer-than-this-build item, kept whole.
    #[serde(rename = "unknown")]
    Unknown {
        #[serde(flatten)]
        base: ItemBase,
        #[serde(default)]
        raw: Vec<RawPayload>,
        data: Vetted,
    },
    /// A thread artifact from before an agent started.
    #[serde(rename = "artifact")]
    Artifact {
        #[serde(flatten)]
        base: ArtifactBase,
        #[serde(skip_serializing_if = "Option::is_none")]
        filename: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        flags: Option<Vec<String>>,
        source: String,
        #[serde(rename = "artifactId", skip_serializing_if = "Option::is_none")]
        artifact_id: Option<String>,
        path: String,
        #[serde(rename = "mimeType")]
        mime_type: String,
        bytes: i64,
    },
}

/// The identity and liveness fields every item carries.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ItemFields {
    pub id: String,
    #[serde(rename = "agentId")]
    pub agent_id: String,
    #[serde(rename = "runId", skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    /// Exact inclusive native fork boundary, when the adapter establishes it.
    #[serde(rename = "nativeId", skip_serializing_if = "Option::is_none")]
    pub native_id: Option<String>,
    #[serde(rename = "executionSource", skip_serializing_if = "Option::is_none")]
    pub execution_source: Option<Vetted>,
    /// False while the provider still streams into this item.
    #[serde(default = "default_true")]
    pub complete: bool,
    /// The source thread's, in a fork.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inherited: Option<Vetted>,
    /// Sent to a client whose hello asked for raw on demand; never stored.
    #[serde(rename = "rawOmitted", skip_serializing_if = "Option::is_none")]
    pub raw_omitted: Option<bool>,
}

/// Shared item fields and the remaining keys of a variant with no other flattened payload.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ItemBase {
    #[serde(flatten)]
    pub fields: ItemFields,
    /// Fields a newer build wrote; the raw record keeps them.
    #[serde(flatten, default, skip_serializing_if = "serde_json::Map::is_empty")]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl Deref for ItemBase {
    type Target = ItemFields;

    fn deref(&self) -> &ItemFields {
        &self.fields
    }
}

impl DerefMut for ItemBase {
    fn deref_mut(&mut self) -> &mut ItemFields {
        &mut self.fields
    }
}

fn default_true() -> bool {
    true
}

/// The artifact base: artifacts can exist before the first agent starts.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArtifactBase {
    pub id: String,
    #[serde(rename = "agentId", skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(rename = "runId", skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(rename = "nativeId", skip_serializing_if = "Option::is_none")]
    pub native_id: Option<String>,
    #[serde(rename = "executionSource", skip_serializing_if = "Option::is_none")]
    pub execution_source: Option<Vetted>,
    #[serde(default = "default_true")]
    pub complete: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inherited: Option<Vetted>,
    #[serde(rename = "rawOmitted", skip_serializing_if = "Option::is_none")]
    pub raw_omitted: Option<bool>,
    #[serde(flatten, default, skip_serializing_if = "serde_json::Map::is_empty")]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl Item {
    /// The item's protocol type tag.
    pub fn item_type(&self) -> &str {
        match self {
            Self::Html { .. } => "html",
            Self::Image { .. } => "image",
            Self::Message { .. } => "message",
            Self::DelegationStarted { .. } => "delegation.started",
            Self::DelegationSettled { .. } => "delegation.settled",
            Self::Reasoning { .. } => "reasoning",
            Self::ToolCall { .. } => "tool_call",
            Self::Notice { .. } => "notice",
            Self::Compaction { .. } => "compaction",
            Self::Unknown { .. } => "unknown",
            Self::Artifact { .. } => "artifact",
        }
    }

    /// False while the provider still streams into this item.
    pub fn complete(&self) -> bool {
        match self {
            Self::Html { base, .. } => base.complete,
            Self::Image { base, .. } => base.complete,
            Self::Message { base, .. } => base.complete,
            Self::DelegationStarted { base, .. } => base.complete,
            Self::DelegationSettled { base, .. } => base.complete,
            Self::Reasoning { base, .. } => base.complete,
            Self::ToolCall { base, .. } => base.complete,
            Self::Notice { base, .. } => base.complete,
            Self::Compaction { base, .. } => base.complete,
            Self::Unknown { base, .. } => base.complete,
            Self::Artifact { base, .. } => base.complete,
        }
    }

    /// The owning agent's ace id.
    pub fn agent_id(&self) -> &str {
        match self {
            Self::Html { base, .. } => &base.agent_id,
            Self::Image { base, .. } => &base.agent_id,
            Self::Message { base, .. } => &base.agent_id,
            Self::DelegationStarted { base, .. } => &base.agent_id,
            Self::DelegationSettled { base, .. } => &base.agent_id,
            Self::Reasoning { base, .. } => &base.agent_id,
            Self::ToolCall { base, .. } => &base.agent_id,
            Self::Notice { base, .. } => &base.agent_id,
            Self::Compaction { base, .. } => &base.agent_id,
            Self::Unknown { base, .. } => &base.agent_id,
            Self::Artifact { base, .. } => base.agent_id.as_deref().unwrap_or(""),
        }
    }

    /// The item's ace id.
    pub fn id(&self) -> &str {
        match self {
            Self::Html { base, .. } => &base.id,
            Self::Image { base, .. } => &base.id,
            Self::Message { base, .. } => &base.id,
            Self::DelegationStarted { base, .. } => &base.id,
            Self::DelegationSettled { base, .. } => &base.id,
            Self::Reasoning { base, .. } => &base.id,
            Self::ToolCall { base, .. } => &base.id,
            Self::Notice { base, .. } => &base.id,
            Self::Compaction { base, .. } => &base.id,
            Self::Unknown { base, .. } => &base.id,
            Self::Artifact { base, .. } => &base.id,
        }
    }

    /// The run the item belongs to.
    pub fn run_id(&self) -> Option<&str> {
        match self {
            Self::Html { base, .. } => base.run_id.as_deref(),
            Self::Image { base, .. } => base.run_id.as_deref(),
            Self::Message { base, .. } => base.run_id.as_deref(),
            Self::DelegationStarted { base, .. } => base.run_id.as_deref(),
            Self::DelegationSettled { base, .. } => base.run_id.as_deref(),
            Self::Reasoning { base, .. } => base.run_id.as_deref(),
            Self::ToolCall { base, .. } => base.run_id.as_deref(),
            Self::Notice { base, .. } => base.run_id.as_deref(),
            Self::Compaction { base, .. } => base.run_id.as_deref(),
            Self::Unknown { base, .. } => base.run_id.as_deref(),
            Self::Artifact { base, .. } => base.run_id.as_deref(),
        }
    }
}

/// The created time of a stored item.
pub(crate) fn item_created_at(item: &Item) -> i64 {
    match item {
        Item::Html { base, .. } => base.created_at,
        Item::Image { base, .. } => base.created_at,
        Item::Message { base, .. } => base.created_at,
        Item::DelegationStarted { base, .. } => base.created_at,
        Item::DelegationSettled { base, .. } => base.created_at,
        Item::Reasoning { base, .. } => base.created_at,
        Item::ToolCall { base, .. } => base.created_at,
        Item::Notice { base, .. } => base.created_at,
        Item::Compaction { base, .. } => base.created_at,
        Item::Unknown { base, .. } => base.created_at,
        Item::Artifact { base, .. } => base.created_at,
    }
}
