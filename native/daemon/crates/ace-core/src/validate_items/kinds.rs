// SPDX-License-Identifier: Apache-2.0
//! The per-kind shape of a merged item, and the raw and visualization fields it shares.

use super::base::valid_base;
use super::content::{valid_attachment, valid_text_source};
use super::delegation::{valid_delegation_outcome, valid_delegation_started};
use super::messages::valid_message_shape;
use super::notices::valid_notice_shape;
use super::tools::valid_tool_call;
use super::{as_map, is_string, optional_string};
use crate::json_io::{Json, Map, as_count, as_integer};

pub(super) fn valid_item_shape(candidate: &Map) -> bool {
    if !valid_base(candidate) {
        return false;
    }
    let kind = candidate.get("type").and_then(|kind| kind.as_str());
    match kind {
        Some("html") => {
            candidate.keys().all(|key| {
                [
                    "id",
                    "agentId",
                    "runId",
                    "createdAt",
                    "nativeId",
                    "executionSource",
                    "complete",
                    "inherited",
                    "rawOmitted",
                    "type",
                    "visualization",
                    "raw",
                ]
                .contains(&key.as_str())
            }) && valid_html_visualization(candidate.get("visualization"))
                && valid_raw_array(candidate.get("raw"))
        }
        Some("image") => {
            candidate.keys().all(|key| {
                [
                    "id",
                    "agentId",
                    "runId",
                    "createdAt",
                    "nativeId",
                    "executionSource",
                    "complete",
                    "inherited",
                    "rawOmitted",
                    "type",
                    "image",
                    "raw",
                ]
                .contains(&key.as_str())
            }) && valid_shared_image(candidate.get("image"))
                && valid_raw_array(candidate.get("raw"))
        }
        Some("message") => valid_message_shape(candidate),
        Some("delegation.started") => valid_delegation_started(candidate),
        Some("delegation.settled") => {
            candidate.keys().all(|key| {
                [
                    "id",
                    "agentId",
                    "runId",
                    "createdAt",
                    "nativeId",
                    "executionSource",
                    "complete",
                    "inherited",
                    "rawOmitted",
                    "type",
                    "origin",
                    "results",
                    "delivery",
                    "raw",
                ]
                .contains(&key.as_str())
            }) && matches!(candidate.get("origin"), Some(Json::String(origin)) if origin == "ace")
                && candidate
                    .get("results")
                    .and_then(|results| results.as_array())
                    .is_some_and(|results| {
                        !results.is_empty()
                            && results.len() <= 64
                            && results.iter().all(valid_delegation_outcome)
                    })
                && matches!(candidate.get("delivery"), Some(Json::String(delivery)) if delivery == "tool" || delivery == "ace-input")
                && valid_raw_array(candidate.get("raw"))
        }
        Some("reasoning") => {
            candidate.keys().all(|key| {
                [
                    "id",
                    "agentId",
                    "runId",
                    "createdAt",
                    "nativeId",
                    "executionSource",
                    "complete",
                    "inherited",
                    "rawOmitted",
                    "type",
                    "text",
                    "source",
                    "summary",
                    "raw",
                ]
                .contains(&key.as_str())
            }) && is_string(candidate.get("text"))
                && candidate.get("source").is_none_or(valid_text_source)
                && candidate
                    .get("summary")
                    .is_none_or(|summary| matches!(summary, Json::Null | Json::Bool(_)))
                && valid_raw_array(candidate.get("raw"))
        }
        Some("tool_call") => {
            candidate.keys().all(|key| {
                [
                    "id",
                    "agentId",
                    "runId",
                    "createdAt",
                    "nativeId",
                    "executionSource",
                    "complete",
                    "inherited",
                    "rawOmitted",
                    "type",
                    "call",
                    "measurement",
                ]
                .contains(&key.as_str())
            }) && candidate
                .get("call")
                .and_then(as_map)
                .is_some_and(valid_tool_call)
                && candidate.get("measurement").is_none_or(|measurement| {
                    crate::validate_shapes::valid_step_measurement(measurement)
                })
        }
        Some("notice") => valid_notice_shape(candidate),
        Some("compaction") => {
            candidate.keys().all(|key| {
                [
                    "id",
                    "agentId",
                    "runId",
                    "createdAt",
                    "nativeId",
                    "executionSource",
                    "complete",
                    "inherited",
                    "rawOmitted",
                    "type",
                    "tokensBefore",
                    "tokensAfter",
                    "summary",
                    "raw",
                ]
                .contains(&key.as_str())
            }) && candidate
                .get("tokensBefore")
                .is_none_or(|value| as_integer(Some(value)).is_some())
                && candidate
                    .get("tokensAfter")
                    .is_none_or(|value| as_integer(Some(value)).is_some())
                && optional_string(candidate.get("summary"))
                && valid_raw_array(candidate.get("raw"))
        }
        Some("unknown") => {
            candidate.keys().all(|key| {
                [
                    "id",
                    "agentId",
                    "runId",
                    "createdAt",
                    "nativeId",
                    "executionSource",
                    "complete",
                    "inherited",
                    "rawOmitted",
                    "type",
                    "raw",
                    "data",
                ]
                .contains(&key.as_str())
            }) && valid_raw_array(candidate.get("raw"))
                && candidate.contains_key("data")
        }
        Some("artifact") => candidate.keys().all(|key| {
            [
                "id",
                "agentId",
                "runId",
                "createdAt",
                "nativeId",
                "executionSource",
                "complete",
                "inherited",
                "rawOmitted",
                "type",
                "filename",
                "flags",
                "source",
                "artifactId",
                "path",
                "mimeType",
                "bytes",
            ]
            .contains(&key.as_str())
        }) && optional_string(candidate.get("filename"))
            && candidate.get("flags").is_none_or(|flags| {
                matches!(flags, Json::Array(flags) if flags.iter().all(|flag| {
                    matches!(flag, Json::String(flag) if flag == "executable" || flag == "archive")
                }))
            })
            && matches!(candidate.get("source"), Some(Json::String(source)) if source == "browser" || source == "device")
            && candidate.get("artifactId").is_none_or(
                |id| matches!(id, Json::String(id) if !id.is_empty() && id.len_code_points() <= 256),
            )
            && is_string(candidate.get("path"))
            && is_string(candidate.get("mimeType"))
            && as_count(candidate.get("bytes")).is_some(),
        _ => false,
    }
}

pub(super) fn valid_raw_array(value: Option<&Json>) -> bool {
    match value {
        None => true,
        Some(Json::Array(raw)) => raw.iter().all(crate::validate_shapes::valid_raw_payload),
        _ => false,
    }
}

fn valid_html_visualization(value: Option<&Json>) -> bool {
    let Some(map) = value.and_then(as_map) else {
        return false;
    };
    map.keys()
        .all(|key| ["title", "document", "height", "mode", "kit"].contains(&key.as_str()))
        && matches!(map.get("title"), Some(Json::String(title)) if !title.is_empty() && title.len_code_points() <= 160)
        && map.get("document").is_some_and(valid_attachment)
}

fn valid_shared_image(value: Option<&Json>) -> bool {
    // Shared images carry the same attachment shape with image bounds.
    value.is_some_and(valid_attachment)
}
