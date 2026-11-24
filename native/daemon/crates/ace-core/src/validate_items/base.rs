// SPDX-License-Identifier: Apache-2.0
//! The fields every item carries: identity, timestamps and execution source.

use super::{as_map, is_string, optional_string};
use crate::json_io::{Json, Map, as_count};
use crate::validate_shapes::{valid_provider_kind, valid_timestamp};

pub(super) fn valid_base(candidate: &Map) -> bool {
    is_string(candidate.get("id"))
        && is_string(candidate.get("agentId"))
        && candidate
            .get("runId")
            .is_none_or(|run| is_string(Some(run)))
        && valid_timestamp(candidate.get("createdAt"))
        && candidate
            .get("nativeId")
            .is_none_or(|id| matches!(id, Json::String(id) if id.len() <= 256))
        && candidate
            .get("executionSource")
            .is_none_or(valid_execution_source)
        && candidate
            .get("complete")
            .is_none_or(|complete| matches!(complete, Json::Bool(_)))
        && candidate.get("inherited").is_none_or(valid_inherited)
        && candidate
            .get("rawOmitted")
            .is_none_or(|raw| matches!(raw, Json::Bool(true)))
}

fn valid_execution_source(value: &Json) -> bool {
    let Some(map) = as_map(value) else {
        return false;
    };
    if map
        .keys()
        .any(|key| !["nativeSessionId", "selection"].contains(&key.as_str()))
    {
        return false;
    }
    if !is_string(map.get("nativeSessionId")) {
        return false;
    }
    let Some(selection) = map.get("selection").and_then(as_map) else {
        return false;
    };
    if selection
        .keys()
        .any(|key| !["provider", "model", "instanceId", "options"].contains(&key.as_str()))
    {
        return false;
    }
    if !valid_provider_kind(selection.get("provider")) {
        return false;
    }
    if let Some(model) = selection.get("model")
        && (matches!(model, Json::Null)
            || !matches!(model, Json::String(model) if !model.is_empty() && model.len() <= 256))
    {
        return false;
    }
    if let Some(instance) = selection.get("instanceId")
        && (matches!(instance, Json::Null)
            || !matches!(instance, Json::String(instance) if !instance.is_empty() && instance.len() <= 256))
    {
        return false;
    }
    match selection.get("options") {
        None => true,
        Some(Json::Object(options)) => options.keys().all(|key| key.len() <= 128),
        _ => false,
    }
}

fn valid_inherited(value: &Json) -> bool {
    let Some(map) = as_map(value) else {
        return false;
    };
    map.keys()
        .all(|key| ["threadId", "itemId", "at"].contains(&key.as_str()))
        && is_string(map.get("threadId"))
        && optional_string(map.get("itemId"))
        && match map.get("at") {
            None => true,
            at => as_count(at).is_some(),
        }
}
