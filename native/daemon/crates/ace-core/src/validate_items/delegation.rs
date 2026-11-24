// SPDX-License-Identifier: Apache-2.0
//! Delegation items: the started update, its child status and the settled outcomes.

use super::kinds::valid_raw_array;
use super::{as_map, is_string};
use crate::json_io::{Json, Map, as_count, as_integer};
use crate::validate_shapes::{valid_agent_machine, valid_provider_kind};

pub(super) fn valid_delegation_outcome(value: &Json) -> bool {
    let Some(map) = as_map(value) else {
        return false;
    };
    if map.keys().any(|key| {
        ![
            "failure",
            "threadId",
            "outcome",
            "result",
            "truncated",
            "before",
        ]
        .contains(&key.as_str())
    }) {
        return false;
    }
    if let Some(failure) = map.get("failure") {
        if matches!(failure, Json::Null) {
            return false;
        }
        let Some(failure) = as_map(failure) else {
            return false;
        };
        if failure.keys().any(|key| {
            !["code", "message", "accountId", "accountLabel", "resetsAt"].contains(&key.as_str())
        }) {
            return false;
        }
        if !matches!(failure.get("code"), Some(Json::String(code)) if !code.is_empty() && code.len() <= 64)
        {
            return false;
        }
        if !matches!(failure.get("message"), Some(Json::String(message)) if !message.is_empty() && message.len() <= 512)
        {
            return false;
        }
        if let Some(account) = failure.get("accountId")
            && !matches!(account, Json::String(account) if account.len() <= 256)
        {
            return false;
        }
        if let Some(label) = failure.get("accountLabel")
            && !matches!(label, Json::String(label) if label.len() <= 256)
        {
            return false;
        }
        if let Some(resets) = failure.get("resetsAt")
            && !matches!(resets, Json::Number(resets) if resets.as_f64().is_some_and(|resets| resets.is_finite() && resets >= 0.0))
        {
            return false;
        }
    }
    if !is_string(map.get("threadId")) {
        return false;
    }
    if !matches!(
        map.get("outcome"),
        Some(Json::String(outcome)) if ["completed", "failed", "cancelled"].contains(&outcome.as_str())
    ) {
        return false;
    }
    if !matches!(map.get("result"), Some(Json::String(result)) if result.len() <= 4096) {
        return false;
    }
    if !matches!(map.get("truncated"), Some(Json::Bool(_))) {
        return false;
    }
    match map.get("before") {
        None | Some(Json::Null) => true,
        Some(_) => as_integer(map.get("before")).is_some(),
    }
}

fn valid_delegation_status(value: Option<&Json>) -> bool {
    match value {
        Some(Json::String(_)) | Some(Json::Object(_)) => {
            let status = value.unwrap_or(&Json::Null);
            crate::json_io::decode::<crate::status::ThreadStatus>(status).is_ok()
        }
        _ => false,
    }
}

pub(super) fn valid_delegation_started(candidate: &Map) -> bool {
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
            "origin",
            "childThreadId",
            "provider",
            "model",
            "accountId",
            "title",
            "role",
            "phase",
            "status",
            "updatedAt",
            "generation",
            "outcome",
            "machine",
            "raw",
        ]
        .contains(&key.as_str())
    }) {
        return false;
    }
    if !matches!(candidate.get("origin"), Some(Json::String(origin)) if origin == "ace") {
        return false;
    }
    if !is_string(candidate.get("childThreadId")) {
        return false;
    }
    if !valid_provider_kind(candidate.get("provider")) {
        return false;
    }
    if let Some(model) = candidate.get("model")
        && (matches!(model, Json::Null)
            || !matches!(model, Json::String(model) if !model.is_empty() && model.len() <= 256))
    {
        return false;
    }
    if let Some(account) = candidate.get("accountId")
        && (matches!(account, Json::Null)
            || !matches!(account, Json::String(account) if !account.is_empty() && account.len() <= 256))
    {
        return false;
    }
    if !matches!(candidate.get("title"), Some(Json::String(title)) if title.len() <= 256) {
        return false;
    }
    if !matches!(candidate.get("role"), Some(Json::String(role)) if role.len() <= 1024) {
        return false;
    }
    if !matches!(
        candidate.get("phase"),
        Some(Json::String(phase)) if ["created", "running", "cancelling", "settled"].contains(&phase.as_str())
    ) {
        return false;
    }
    if !valid_delegation_status(candidate.get("status")) {
        return false;
    }
    if as_count(candidate.get("updatedAt")).is_none() {
        return false;
    }
    if as_count(candidate.get("generation")).is_none() {
        return false;
    }
    if let Some(outcome) = candidate.get("outcome")
        && !matches!(outcome, Json::Null)
        && !valid_delegation_outcome(outcome)
    {
        return false;
    }
    if let Some(machine) = candidate.get("machine")
        && (matches!(machine, Json::Null) || !valid_agent_machine(Some(machine)))
    {
        return false;
    }
    valid_raw_array(candidate.get("raw"))
}
