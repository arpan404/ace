// SPDX-License-Identifier: Apache-2.0
//! Notice items: level, diagnostic text, provider error details and the asked line.

use super::asked::valid_asked_line;
use super::content::valid_text_source;
use super::kinds::valid_raw_array;
use super::{as_map, is_string};
use crate::json_io::{Json, Map};
use crate::validate_shapes::valid_provider_kind;

pub(super) fn valid_notice_shape(candidate: &Map) -> bool {
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
            "level",
            "commandId",
            "interactionId",
            "code",
            "diagnostic",
            "title",
            "detail",
            "details",
            "toolCallId",
            "measurement",
            "asked",
            "text",
            "source",
            "raw",
        ]
        .contains(&key.as_str())
    }) {
        return false;
    }
    if !matches!(
        candidate.get("level"),
        Some(Json::String(level)) if ["info", "warning", "error"].contains(&level.as_str())
    ) {
        return false;
    }
    for key in [
        "commandId",
        "interactionId",
        "code",
        "title",
        "detail",
        "toolCallId",
    ] {
        if let Some(value) = candidate.get(key)
            && (matches!(value, Json::Null) || !is_string(Some(value)))
        {
            return false;
        }
    }
    if let Some(diagnostic) = candidate.get("diagnostic")
        && (matches!(diagnostic, Json::Null) || !matches!(diagnostic, Json::Bool(_)))
    {
        return false;
    }
    if let Some(details) = candidate.get("details")
        && (matches!(details, Json::Null) || !valid_provider_error_details(details))
    {
        return false;
    }
    if let Some(measurement) = candidate.get("measurement")
        && !crate::validate_shapes::valid_step_measurement(measurement)
    {
        return false;
    }
    if let Some(asked) = candidate.get("asked")
        && !valid_asked_line(asked)
    {
        return false;
    }
    if !is_string(candidate.get("text")) {
        return false;
    }
    if let Some(source) = candidate.get("source")
        && !valid_text_source(source)
    {
        return false;
    }
    valid_raw_array(candidate.get("raw"))
}

fn valid_provider_error_details(value: &Json) -> bool {
    let Some(map) = as_map(value) else {
        return false;
    };
    map.keys()
        .all(|key| ["code", "provider", "title", "detail", "model"].contains(&key.as_str()))
        && matches!(map.get("code"), Some(Json::String(code)) if !code.is_empty() && code.len_code_points() <= 256)
        && valid_provider_kind(map.get("provider"))
        && map.get("title").is_none_or(|title| {
            matches!(title, Json::Null) | matches!(title, Json::String(title) if title.len_code_points() <= 256)
        })
        && map.get("detail").is_none_or(|detail| {
            matches!(detail, Json::Null)
                | matches!(detail, Json::String(detail) if detail.len_code_points() <= 2048)
        })
        && map.get("model").is_none_or(|model| {
            matches!(model, Json::Null)
                | matches!(model, Json::String(model) if !model.is_empty() && model.len_code_points() <= 256)
        })
}
