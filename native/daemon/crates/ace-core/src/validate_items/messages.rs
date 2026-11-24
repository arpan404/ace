// SPDX-License-Identifier: Apache-2.0
//! Message items: roles, parts, attachments, origin, speaker and merged context.

use super::content::{valid_attachment, valid_content_part};
use super::kinds::valid_raw_array;
use super::people::valid_speaker;
use super::{as_map, is_string, optional_string};
use crate::json_io::{Json, Map};
use crate::validate_shapes::valid_provider_kind;

fn valid_message_origin(value: &Json) -> bool {
    let Some(map) = as_map(value) else {
        return false;
    };
    if map.keys().any(|key| {
        ![
            "kind",
            "client",
            "commandId",
            "interactionId",
            "threadIds",
            "parentThreadId",
            "role",
            "from",
            "to",
            "sources",
            "lossy",
            "freshSession",
            "afterExit",
            "via",
        ]
        .contains(&key.as_str())
    }) {
        return false;
    }
    if !matches!(
        map.get("kind"),
        Some(Json::String(kind))
            if [
                "person",
                "interaction_answer",
                "subagent_result",
                "handoff",
                "spawn",
                "parent_agent",
                "restart",
                "limit_resume",
                "queue",
                "steer",
                "automation",
                "schedule",
                "background_completion"
            ]
            .contains(&kind.as_str())
    ) {
        return false;
    }
    if let Some(client) = map.get("client") {
        if matches!(client, Json::Null) {
            return false;
        }
        let Some(client) = as_map(client) else {
            return false;
        };
        if client
            .keys()
            .any(|key| !["grantId", "name"].contains(&key.as_str()))
        {
            return false;
        }
        if !matches!(client.get("grantId"), Some(Json::String(id)) if !id.is_empty() && id.len() <= 128)
        {
            return false;
        }
        if !matches!(client.get("name"), Some(Json::String(name)) if !name.is_empty() && name.len() <= 256)
        {
            return false;
        }
    }
    for key in ["commandId", "interactionId"] {
        if let Some(id) = map.get(key)
            && (matches!(id, Json::Null) || !is_string(Some(id)))
        {
            return false;
        }
    }
    if let Some(threads) = map.get("threadIds")
        && (matches!(threads, Json::Null)
            || !matches!(threads, Json::Array(threads) if threads.iter().all(|id| is_string(Some(id)))))
    {
        return false;
    }
    if !optional_string(map.get("role")) {
        return false;
    }
    if !optional_string(map.get("parentThreadId")) {
        return false;
    }
    for key in ["from", "to"] {
        if let Some(endpoint) = map.get(key) {
            let Some(endpoint) = as_map(endpoint) else {
                return false;
            };
            if endpoint
                .keys()
                .any(|key| !["provider", "model"].contains(&key.as_str()))
            {
                return false;
            }
            if !valid_provider_kind(endpoint.get("provider")) {
                return false;
            }
            if let Some(model) = endpoint.get("model")
                && !matches!(model, Json::String(model) if !model.is_empty())
            {
                return false;
            }
        }
    }
    if let Some(sources) = map.get("sources") {
        if matches!(sources, Json::Null) {
            return false;
        }
        let valid = match sources {
            Json::Array(sources) => {
                sources.len() <= 8
                    && sources.iter().all(|source| {
                        let Some(source) = as_map(source) else {
                            return false;
                        };
                        source.keys().all(|key| ["provider", "model"].contains(&key.as_str()))
                            && valid_provider_kind(source.get("provider"))
                            && source.get("model").is_none_or(|model| {
                                matches!(model, Json::String(model) if !model.is_empty() && model.len() <= 256)
                            })
                    })
            }
            _ => false,
        };
        if !valid {
            return false;
        }
    }
    for key in ["lossy", "freshSession", "afterExit"] {
        if !matches!(map.get(key), None | Some(Json::Bool(_))) {
            return false;
        }
    }
    if let Some(via) = map.get("via") {
        if matches!(via, Json::Null) {
            return false;
        }
        let Some(via) = as_map(via) else {
            return false;
        };
        if via
            .keys()
            .any(|key| !["threadId", "title"].contains(&key.as_str()))
        {
            return false;
        }
        if !is_string(via.get("threadId")) {
            return false;
        }
        if let Some(title) = via.get("title")
            && !matches!(title, Json::String(title) if title.len() <= 256)
        {
            return false;
        }
    }
    true
}

fn valid_handoff_citation(value: &Json) -> bool {
    let Some(map) = as_map(value) else {
        return false;
    };
    map.keys()
        .all(|key| ["threadId", "itemId"].contains(&key.as_str()))
        && is_string(map.get("threadId"))
        && optional_string(map.get("itemId"))
}

fn valid_merged_fork(value: &Json) -> bool {
    let Some(map) = as_map(value) else {
        return false;
    };
    map.keys().all(|key| {
        ["sourceThreadId", "summary", "citations", "patchApplied"].contains(&key.as_str())
    }) && is_string(map.get("sourceThreadId"))
        && matches!(map.get("summary"), Some(Json::String(summary)) if !summary.is_empty() && summary.len() <= 256 * 1024)
        && map
            .get("citations")
            .and_then(|citations| citations.as_array())
            .is_some_and(|citations| {
                !citations.is_empty()
                    && citations.len() <= 100
                    && citations.iter().all(valid_handoff_citation)
            })
        && matches!(map.get("patchApplied"), Some(Json::Bool(_)))
}

pub(super) fn valid_message_shape(candidate: &Map) -> bool {
    if candidate.keys().any(|key| {
        ![
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
            "role",
            "parts",
            "attachments",
            "synthetic",
            "origin",
            "notAnswered",
            "mergedContext",
            "speaker",
            "raw",
        ]
        .contains(&key.as_str())
    }) {
        return false;
    }
    if !matches!(
        candidate.get("role"),
        Some(Json::String(role)) if role == "user" || role == "assistant"
    ) {
        return false;
    }
    if !candidate
        .get("parts")
        .and_then(|parts| parts.as_array())
        .is_some_and(|parts| parts.iter().all(valid_content_part))
    {
        return false;
    }
    if let Some(attachments) = candidate.get("attachments") {
        if matches!(attachments, Json::Null) {
            return false;
        }
        let valid = match attachments {
            Json::Array(attachments) => {
                attachments.len() <= 64 && attachments.iter().all(valid_attachment)
            }
            _ => false,
        };
        if !valid {
            return false;
        }
    }
    if !candidate
        .get("synthetic")
        .is_none_or(|synthetic| matches!(synthetic, Json::Null | Json::Bool(_)))
    {
        return false;
    }
    if let Some(origin) = candidate.get("origin")
        && (matches!(origin, Json::Null) || !valid_message_origin(origin))
    {
        return false;
    }
    if let Some(not_answered) = candidate.get("notAnswered")
        && (matches!(not_answered, Json::Null)
            || !matches!(not_answered, Json::String(state) if state == "stopped"))
    {
        return false;
    }
    if let Some(merged) = candidate.get("mergedContext")
        && (matches!(merged, Json::Null) || !valid_merged_fork(merged))
    {
        return false;
    }
    if let Some(speaker) = candidate.get("speaker")
        && (matches!(speaker, Json::Null) || !valid_speaker(speaker))
    {
        return false;
    }
    valid_raw_array(candidate.get("raw"))
}
