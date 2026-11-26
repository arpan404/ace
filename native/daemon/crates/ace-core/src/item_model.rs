// SPDX-License-Identifier: Apache-2.0
//! Protocol leaf types read by the item fold. Stored records keep extras
//! where they are represented on the Rust type.

use serde::{Deserialize, Serialize};

use crate::error::CoreError;
use crate::json_io::{Json, Map, Maybe, de_i64};
use ace_json::JsString;

pub use crate::tool_model::{LineRange, OutputSummary, ToolCall, ToolDetail};

/// A provider's original payload, stored verbatim as canonical ace-json.
#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum RawPayload {
    /// The native payload with its type, name and data.
    Inline {
        #[serde(rename = "type")]
        payload_type: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(
            deserialize_with = "crate::json_io::deserialize_raw",
            serialize_with = "crate::json_io::serialize_raw"
        )]
        data: ace_json::Raw,
    },
    /// A blob reference the daemon resolves on demand.
    Blob {
        #[serde(rename = "type")]
        payload_type: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(rename = "blobRef")]
        blob_ref: String,
        #[serde(deserialize_with = "crate::json_io::de_i64")]
        size: i64,
        #[serde(skip_serializing_if = "Option::is_none")]
        preview: Option<String>,
    },
}

impl RawPayload {
    /// Read a payload from its canonical text: a blob reference, or inline data kept verbatim.
    /// Iterative throughout (the borrowed reader never recurses), so a payload of any depth is
    /// read without growing the stack.
    pub fn from_raw(raw: &ace_json::Raw) -> Result<RawPayload, String> {
        let view = raw.view();
        let text = |value: Option<ace_json::RawRef<'_>>| -> Result<String, String> {
            value
                .and_then(|value| value.as_js_string())
                .map(|text| text.to_rust().into_owned())
                .ok_or_else(|| "raw payload needs a string".to_owned())
        };
        let optional_text =
            |value: Option<ace_json::RawRef<'_>>| -> Result<Option<String>, String> {
                match value {
                    None => Ok(None),
                    Some(value) if value.is_null() => Ok(None),
                    Some(value) => text(Some(value)).map(Some),
                }
            };
        let payload_type = text(view.get("type"))?;
        let name = optional_text(view.get("name"))?;
        let blob = view.get("blobRef").is_some()
            || view.get("size").is_some()
            || view.get("preview").is_some();
        if blob {
            let blob_ref = text(view.get("blobRef"))?;
            let size = view
                .get("size")
                .and_then(|size| size.as_f64())
                .ok_or_else(|| "invalid raw payload".to_owned())? as i64;
            let preview = optional_text(view.get("preview"))?;
            Ok(Self::Blob {
                payload_type,
                name,
                blob_ref,
                size,
                preview,
            })
        } else {
            let data = view
                .get("data")
                .ok_or_else(|| "invalid raw payload".to_owned())?;
            Ok(Self::Inline {
                payload_type,
                name,
                data: data.to_raw(),
            })
        }
    }
}

impl<'de> serde::Deserialize<'de> for RawPayload {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        use serde::de::Error as _;
        // Untagged enums buffer into content that raw slices cannot decode from, so
        // discriminate manually: a blob reference reads as a blob, everything else as inline
        // data kept as canonical ace-json (JavaScript's numbers and key order, verbatim).
        let value = Json::deserialize(deserializer)?;
        let Json::Object(map) = &value else {
            return Err(D::Error::custom("raw payload must be an object"));
        };
        let payload_type = map
            .get("type")
            .and_then(|value| value.as_str())
            .ok_or_else(|| D::Error::custom("raw payload needs a type"))?
            .to_owned();
        let name = match map.get("name") {
            None => None,
            Some(Json::String(name)) => Some(name.to_string()),
            Some(_) => return Err(D::Error::custom("invalid raw payload")),
        };
        if map.contains_key("blobRef") || map.contains_key("size") || map.contains_key("preview") {
            let blob_ref = map
                .get("blobRef")
                .and_then(|value| value.as_str())
                .ok_or_else(|| D::Error::custom("invalid raw payload"))?
                .to_owned();
            let size = map
                .get("size")
                .and_then(|value| value.as_i64())
                .ok_or_else(|| D::Error::custom("invalid raw payload"))?;
            let preview = match map.get("preview") {
                None => None,
                Some(Json::String(preview)) => Some(preview.to_string()),
                Some(_) => return Err(D::Error::custom("invalid raw payload")),
            };
            Ok(Self::Blob {
                payload_type,
                name,
                blob_ref,
                size,
                preview,
            })
        } else {
            let data = map
                .get("data")
                .ok_or_else(|| D::Error::custom("invalid raw payload"))?;
            Ok(Self::Inline {
                payload_type,
                name,
                data: ace_json::Raw::from_value(data),
            })
        }
    }
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
#[serde()]
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
#[serde()]
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
    /// Fields a newer build wrote; the TypeScript validates without stripping and writes the
    /// raw value back, so they travel with the object.
    #[serde(flatten, default, skip_serializing_if = "serde_json::Map::is_empty")]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// A single file change, normalised from provider edits.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde()]
pub struct FileChange {
    pub path: String,
    pub kind: String,
    #[serde(rename = "movePath", skip_serializing_if = "Option::is_none")]
    pub move_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diff: Option<String>,
    #[serde(
        rename = "oldText",
        default,
        deserialize_with = "Maybe::<String>::deserialize",
        serialize_with = "Maybe::<String>::serialize",
        skip_serializing_if = "Maybe::<String>::is_missing"
    )]
    pub old_text: Maybe<String>,
    #[serde(rename = "newText", skip_serializing_if = "Option::is_none")]
    pub new_text: Option<String>,
}

/// One entry of a plan or todo list.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde()]
pub struct TodoEntry {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub content: String,
    pub status: String,
}

/// Bounded native file content carried beside a file part.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "encoding")]
pub enum FileContent {
    /// Base64 bytes, at most 44 MiB of characters.
    #[serde(rename = "base64")]
    Base64 { data: String },
    /// Text, at most 128 KiB.
    #[serde(rename = "text")]
    Text { data: String },
}

/// One content part of a message.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
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
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::json_io::deserialize_opt_raw",
            serialize_with = "crate::json_io::serialize_opt_raw"
        )]
        values: Option<ace_json::Raw>,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::json_io::deserialize_opt_raw",
            serialize_with = "crate::json_io::serialize_opt_raw"
        )]
        invocation: Option<ace_json::Raw>,
        #[serde(flatten, default, skip_serializing_if = "serde_json::Map::is_empty")]
        extra: serde_json::Map<String, serde_json::Value>,
    },
    /// Plain text, with its stream source when it is a preview. A JavaScript string: a
    /// provider can split a surrogate pair across frames, and the units must survive.
    #[serde(rename = "text")]
    Text {
        #[serde(default = "JsString::new")]
        text: JsString,
        #[serde(skip_serializing_if = "Option::is_none")]
        source: Option<TextSource>,
        #[serde(flatten, default, skip_serializing_if = "serde_json::Map::is_empty")]
        extra: serde_json::Map<String, serde_json::Value>,
    },
    /// An image by URL.
    #[serde(rename = "image")]
    Image {
        #[serde(rename = "mimeType")]
        mime_type: String,
        url: String,
        #[serde(flatten, default, skip_serializing_if = "serde_json::Map::is_empty")]
        extra: serde_json::Map<String, serde_json::Value>,
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
        #[serde(flatten, default, skip_serializing_if = "serde_json::Map::is_empty")]
        extra: serde_json::Map<String, serde_json::Value>,
    },
}

impl ContentPart {
    pub(crate) fn text(text: JsString) -> Self {
        Self::Text {
            text,
            source: None,
            extra: Default::default(),
        }
    }
}

/// The JSON behind a vetted-but-opaque leaf: validated structurally,
/// stored as canonical ace-json so clients read back exactly what the
/// adapter sent. Deserialization captures the raw text verbatim through
/// serde_json (typed decoding still runs there), then keeps its canonical
/// ace-json form; serialization from then on splices verbatim.
#[derive(Debug, Clone)]
pub struct Vetted(pub ace_json::Raw);

impl serde::Serialize for Vetted {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        self.0.serialize(serializer)
    }
}

impl<'de> serde::Deserialize<'de> for Vetted {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        // Via `Value` (which survives the buffering internally tagged enums do), then
        // canonical ace-json: the exact number and JavaScript's key order survive, so a
        // re-read is verbatim.
        let value = ace_json::Value::deserialize(deserializer).map_err(serde::de::Error::custom)?;
        Ok(Self(ace_json::Raw::from_value(&value)))
    }
}

/// Read a vetted leaf back as JSON for validation.
pub fn vetted_json(raw: &ace_json::Raw) -> Result<Json, CoreError> {
    ace_json::parse(raw.get()).map_err(CoreError::invalid_json)
}

/// Keep a JSON subtree as canonical ace-json for vetted storage.
pub fn vet_json(value: &Json) -> Result<Vetted, CoreError> {
    Ok(Vetted(ace_json::Raw::from_value(value)))
}

/// The passthrough extras of an approval's MCP server: kept, never dropped.
pub type Passthrough = Map;
