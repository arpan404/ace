// SPDX-License-Identifier: Apache-2.0
//! `Item` as `JSON.stringify` writes it. The TypeScript builds every stored item with
//! `Item.parse`, so its keys come out in the protocol schema's order: the identity fields,
//! then `type`, then the variant's own fields. serde's tagged enum would put `type` first,
//! so the order is written here, field for field, exactly as `packages/protocol` declares it.

use serde::Serialize;
use serde::ser::{SerializeMap, Serializer};

use crate::items::{ArtifactBase, Item, ItemBase};

/// The identity fields every item carries, in `ItemBase` order.
fn base_fields<S: SerializeMap>(map: &mut S, base: &ItemBase) -> Result<(), S::Error> {
    map.serialize_entry("id", &base.id)?;
    map.serialize_entry("agentId", &base.agent_id)?;
    if let Some(run_id) = &base.run_id {
        map.serialize_entry("runId", run_id)?;
    }
    map.serialize_entry("createdAt", &base.created_at)?;
    if let Some(native_id) = &base.native_id {
        map.serialize_entry("nativeId", native_id)?;
    }
    if let Some(source) = &base.execution_source {
        map.serialize_entry("executionSource", source)?;
    }
    map.serialize_entry("complete", &base.complete)?;
    if let Some(inherited) = &base.inherited {
        map.serialize_entry("inherited", inherited)?;
    }
    if let Some(omitted) = &base.raw_omitted {
        map.serialize_entry("rawOmitted", omitted)?;
    }
    Ok(())
}

/// An artifact's identity fields, in the protocol's order (its `agentId` is optional).
fn artifact_fields<S: SerializeMap>(map: &mut S, base: &ArtifactBase) -> Result<(), S::Error> {
    map.serialize_entry("id", &base.id)?;
    if let Some(agent_id) = &base.agent_id {
        map.serialize_entry("agentId", agent_id)?;
    }
    if let Some(run_id) = &base.run_id {
        map.serialize_entry("runId", run_id)?;
    }
    map.serialize_entry("createdAt", &base.created_at)?;
    if let Some(native_id) = &base.native_id {
        map.serialize_entry("nativeId", native_id)?;
    }
    if let Some(source) = &base.execution_source {
        map.serialize_entry("executionSource", source)?;
    }
    map.serialize_entry("complete", &base.complete)?;
    if let Some(inherited) = &base.inherited {
        map.serialize_entry("inherited", inherited)?;
    }
    if let Some(omitted) = &base.raw_omitted {
        map.serialize_entry("rawOmitted", omitted)?;
    }
    Ok(())
}

impl Serialize for Item {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(None)?;
        match self {
            Self::Html {
                base,
                visualization,
                raw,
            } => {
                base_fields(&mut map, base)?;
                map.serialize_entry("type", "html")?;
                map.serialize_entry("visualization", visualization)?;
                map.serialize_entry("raw", raw)?;
            }
            Self::Image { base, image, raw } => {
                base_fields(&mut map, base)?;
                map.serialize_entry("type", "image")?;
                map.serialize_entry("image", image)?;
                map.serialize_entry("raw", raw)?;
            }
            Self::Message {
                base,
                role,
                parts,
                attachments,
                synthetic,
                origin,
                not_answered,
                merged_context,
                speaker,
                raw,
            } => {
                base_fields(&mut map, base)?;
                map.serialize_entry("type", "message")?;
                map.serialize_entry("role", role)?;
                map.serialize_entry("parts", parts)?;
                if let Some(attachments) = attachments {
                    map.serialize_entry("attachments", attachments)?;
                }
                map.serialize_entry("synthetic", synthetic)?;
                if let Some(origin) = origin {
                    map.serialize_entry("origin", origin)?;
                }
                if let Some(not_answered) = not_answered {
                    map.serialize_entry("notAnswered", not_answered)?;
                }
                if let Some(context) = merged_context {
                    map.serialize_entry("mergedContext", context)?;
                }
                if let Some(speaker) = speaker {
                    map.serialize_entry("speaker", speaker)?;
                }
                map.serialize_entry("raw", raw)?;
            }
            Self::DelegationStarted {
                base,
                delegation,
                raw,
            } => {
                base_fields(&mut map, base)?;
                map.serialize_entry("type", "delegation.started")?;
                map.serialize_entry("origin", &delegation.origin)?;
                map.serialize_entry("childThreadId", &delegation.child_thread_id)?;
                map.serialize_entry("provider", &delegation.provider)?;
                if let Some(model) = &delegation.model {
                    map.serialize_entry("model", model)?;
                }
                if let Some(account_id) = &delegation.account_id {
                    map.serialize_entry("accountId", account_id)?;
                }
                map.serialize_entry("title", &delegation.title)?;
                map.serialize_entry("role", &delegation.role)?;
                map.serialize_entry("phase", &delegation.phase)?;
                map.serialize_entry("status", &delegation.status)?;
                map.serialize_entry("updatedAt", &delegation.updated_at)?;
                map.serialize_entry("generation", &delegation.generation)?;
                map.serialize_entry("outcome", &delegation.outcome)?;
                if let Some(machine) = &delegation.machine {
                    map.serialize_entry("machine", machine)?;
                }
                map.serialize_entry("raw", raw)?;
            }
            Self::DelegationSettled {
                base,
                delegation,
                raw,
            } => {
                base_fields(&mut map, base)?;
                map.serialize_entry("type", "delegation.settled")?;
                map.serialize_entry("origin", &delegation.origin)?;
                map.serialize_entry("results", &delegation.results)?;
                map.serialize_entry("delivery", &delegation.delivery)?;
                map.serialize_entry("raw", raw)?;
            }
            Self::Reasoning {
                base,
                text,
                source,
                summary,
                raw,
            } => {
                base_fields(&mut map, base)?;
                map.serialize_entry("type", "reasoning")?;
                map.serialize_entry("text", text)?;
                if let Some(source) = source {
                    map.serialize_entry("source", source)?;
                }
                map.serialize_entry("summary", summary)?;
                map.serialize_entry("raw", raw)?;
            }
            Self::ToolCall {
                base,
                call,
                measurement,
            } => {
                base_fields(&mut map, base)?;
                map.serialize_entry("type", "tool_call")?;
                map.serialize_entry("call", call)?;
                if let Some(measurement) = measurement {
                    map.serialize_entry("measurement", measurement)?;
                }
            }
            Self::Notice {
                base,
                level,
                command_id,
                interaction_id,
                code,
                diagnostic,
                title,
                detail,
                details,
                tool_call_id,
                measurement,
                asked,
                text,
                source,
                raw,
            } => {
                base_fields(&mut map, base)?;
                map.serialize_entry("type", "notice")?;
                map.serialize_entry("level", level)?;
                if let Some(command_id) = command_id {
                    map.serialize_entry("commandId", command_id)?;
                }
                if let Some(interaction_id) = interaction_id {
                    map.serialize_entry("interactionId", interaction_id)?;
                }
                if let Some(code) = code {
                    map.serialize_entry("code", code)?;
                }
                if let Some(diagnostic) = diagnostic {
                    map.serialize_entry("diagnostic", diagnostic)?;
                }
                if let Some(title) = title {
                    map.serialize_entry("title", title)?;
                }
                if let Some(detail) = detail {
                    map.serialize_entry("detail", detail)?;
                }
                if let Some(details) = details {
                    map.serialize_entry("details", details)?;
                }
                if let Some(tool_call_id) = tool_call_id {
                    map.serialize_entry("toolCallId", tool_call_id)?;
                }
                if let Some(measurement) = measurement {
                    map.serialize_entry("measurement", measurement)?;
                }
                if let Some(asked) = asked {
                    map.serialize_entry("asked", asked)?;
                }
                map.serialize_entry("text", text)?;
                if let Some(source) = source {
                    map.serialize_entry("source", source)?;
                }
                map.serialize_entry("raw", raw)?;
            }
            Self::Compaction {
                base,
                tokens_before,
                tokens_after,
                summary,
                raw,
            } => {
                base_fields(&mut map, base)?;
                map.serialize_entry("type", "compaction")?;
                if let Some(tokens) = tokens_before {
                    map.serialize_entry("tokensBefore", tokens)?;
                }
                if let Some(tokens) = tokens_after {
                    map.serialize_entry("tokensAfter", tokens)?;
                }
                if let Some(summary) = summary {
                    map.serialize_entry("summary", summary)?;
                }
                map.serialize_entry("raw", raw)?;
            }
            Self::Unknown { base, raw, data } => {
                base_fields(&mut map, base)?;
                map.serialize_entry("type", "unknown")?;
                map.serialize_entry("raw", raw)?;
                map.serialize_entry("data", data)?;
            }
            Self::Artifact {
                base,
                filename,
                flags,
                source,
                artifact_id,
                path,
                mime_type,
                bytes,
            } => {
                artifact_fields(&mut map, base)?;
                map.serialize_entry("type", "artifact")?;
                if let Some(filename) = filename {
                    map.serialize_entry("filename", filename)?;
                }
                if let Some(flags) = flags {
                    map.serialize_entry("flags", flags)?;
                }
                map.serialize_entry("source", source)?;
                if let Some(artifact_id) = artifact_id {
                    map.serialize_entry("artifactId", artifact_id)?;
                }
                map.serialize_entry("path", path)?;
                map.serialize_entry("mimeType", mime_type)?;
                map.serialize_entry("bytes", bytes)?;
            }
        }
        map.end()
    }
}
