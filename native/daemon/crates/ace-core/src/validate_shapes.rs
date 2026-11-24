// SPDX-License-Identifier: Apache-2.0
//! The protocol-shape validators behind `shapeValid`: strict like the Zod
//! schemas (unknown fields reject the fact, except the `passthrough` extras
//! and `z.unknown()` leaves), checked in the same order.

use crate::json_io::{Json, Map, as_count, as_integer};

fn get_str<'a>(map: &'a Map, key: &str) -> Option<&'a str> {
    map.get(key).and_then(|value| value.as_str())
}

fn as_map(value: &Json) -> Option<&Map> {
    match value {
        Json::Object(map) => Some(map),
        _ => None,
    }
}

fn is_string(value: Option<&Json>) -> bool {
    matches!(value, Some(Json::String(_)))
}

fn optional_string(value: Option<&Json>) -> bool {
    matches!(value, None | Some(Json::String(_)))
}

fn optional_bool(value: Option<&Json>) -> bool {
    matches!(value, None | Some(Json::Null) | Some(Json::Bool(_)))
}

fn ensure_only(map: &Map, allowed: &[&str]) -> bool {
    map.keys().all(|key| allowed.contains(&key.as_str()))
}

fn valid_id(value: Option<&Json>, min: usize, max: usize) -> bool {
    match value {
        Some(Json::String(text)) => text.len() >= min && text.len() <= max,
        _ => false,
    }
}

pub(crate) fn valid_timestamp(value: Option<&Json>) -> bool {
    matches!(value, Some(Json::Number(_)) if as_count(value).is_some())
}

fn valid_optional_timestamp(value: Option<&Json>) -> bool {
    match value {
        None | Some(Json::Null) => true,
        Some(_) => valid_timestamp(value),
    }
}

/// A thread id: any non-empty string.
pub fn valid_thread_id(value: Option<&Json>) -> bool {
    matches!(value, Some(Json::String(id)) if !id.is_empty())
}

/// The provider enum every native reference names.
pub fn valid_provider_kind(value: Option<&Json>) -> bool {
    matches!(value, Some(Json::String(kind)) if crate::state::valid_provider(kind))
}

/// A native reference: provider plus optional identity and history.
pub fn valid_native_ref(value: Option<&Json>) -> bool {
    let Some(map) = value.and_then(as_map) else {
        return false;
    };
    if !ensure_only(
        map,
        &[
            "provider",
            "acpAgentId",
            "installationId",
            "instanceId",
            "nativeId",
            "path",
            "forkedFromNativeId",
            "aliases",
        ],
    ) {
        return false;
    }
    if !valid_provider_kind(map.get("provider")) {
        return false;
    }
    for key in [
        "acpAgentId",
        "installationId",
        "instanceId",
        "nativeId",
        "path",
    ] {
        if !optional_string(map.get(key)) {
            return false;
        }
    }
    match map.get("forkedFromNativeId") {
        None => {}
        Some(Json::String(text)) if !text.is_empty() && text.len() <= 1024 => {}
        _ => return false,
    }
    match map.get("aliases") {
        None => true,
        Some(Json::Array(aliases)) => aliases.iter().all(|alias| matches!(alias, Json::String(_))),
        _ => false,
    }
}

/// The paired machine a delegated child runs on.
pub fn valid_agent_machine(value: Option<&Json>) -> bool {
    let Some(map) = value.and_then(as_map) else {
        return false;
    };
    ensure_only(map, &["machine", "name", "hostId", "contact"])
        && matches!(map.get("machine"), Some(Json::String(machine)) if !machine.is_empty() && machine.len() <= 64)
        && matches!(map.get("name"), Some(Json::String(name)) if !name.is_empty() && name.len() <= 256)
        && optional_string(map.get("hostId"))
        && map.get("contact").is_none_or(|contact| {
            matches!(contact, Json::Null)
                || matches!(contact, Json::String(where_) if where_ == "lost" || where_ == "unconfirmed")
        })
}

/// Native history lineage.
pub fn valid_thread_lineage(value: Option<&Json>) -> bool {
    let Some(map) = value.and_then(as_map) else {
        return false;
    };
    if !ensure_only(
        map,
        &["parentThreadId", "parentAgentId", "point", "mode", "lossy"],
    ) {
        return false;
    }
    if !matches!(
        map.get("parentThreadId"),
        Some(Json::String(id)) if !id.is_empty()
    ) {
        return false;
    }
    if !matches!(
        map.get("parentAgentId"),
        Some(Json::String(id)) if !id.is_empty()
    ) {
        return false;
    }
    let point_valid = match map.get("point").and_then(as_map) {
        Some(point) => {
            let kind = point.get("type").and_then(|kind| kind.as_str());
            match kind {
                Some("turn") => {
                    ensure_only(point, &["type", "runId"])
                        && matches!(point.get("runId"), Some(Json::String(id)) if !id.is_empty())
                }
                Some("item") => {
                    ensure_only(point, &["type", "itemId"])
                        && matches!(point.get("itemId"), Some(Json::String(id)) if !id.is_empty())
                }
                _ => false,
            }
        }
        None => false,
    };
    if !point_valid {
        return false;
    }
    if !matches!(
        map.get("mode"),
        Some(Json::String(mode)) if mode == "native" || mode == "portable"
    ) {
        return false;
    }
    matches!(map.get("lossy"), Some(Json::Bool(_)))
}

/// Structured provider error detail.
fn valid_error_details(value: Option<&Json>) -> bool {
    let Some(map) = value.and_then(as_map) else {
        return false;
    };
    ensure_only(map, &["code", "provider", "title", "detail", "model"])
        && matches!(map.get("code"), Some(Json::String(code)) if !code.is_empty() && code.len() <= 256)
        && valid_provider_kind(map.get("provider"))
        && matches!(
            map.get("title"),
            None | Some(Json::Null) | Some(Json::String(_))
        )
        && map.get("title").is_none_or(|title| {
            matches!(title, Json::Null) | matches!(title, Json::String(title) if title.len() <= 256)
        })
        && map.get("detail").is_none_or(|detail| {
            matches!(detail, Json::Null)
                | matches!(detail, Json::String(detail) if detail.len() <= 2048)
        })
        && map.get("model").is_none_or(
            |model| matches!(model, Json::String(model) if !model.is_empty() && model.len() <= 256),
        )
}

/// An agent error: kind and message with optional detail.
pub fn valid_agent_error(value: Option<&Json>) -> bool {
    let Some(map) = value.and_then(as_map) else {
        return false;
    };
    if !ensure_only(
        map,
        &["kind", "message", "code", "title", "detail", "details"],
    ) {
        return false;
    }
    if !matches!(
        map.get("kind"),
        Some(Json::String(kind))
            if ["provider", "auth", "quota", "network", "process_exit", "unknown"]
                .contains(&kind.as_str())
    ) {
        return false;
    }
    if !is_string(map.get("message")) {
        return false;
    }
    for key in ["code", "title", "detail"] {
        if !optional_string(map.get(key)) {
            return false;
        }
    }
    if let Some(title) = map.get("title")
        && !matches!(title, Json::String(title) if title.len() <= 256)
    {
        return false;
    }
    if let Some(detail) = map.get("detail")
        && !matches!(detail, Json::String(detail) if detail.len() <= 2048)
    {
        return false;
    }
    match map.get("details") {
        None | Some(Json::Null) => true,
        Some(_) => valid_error_details(map.get("details")),
    }
}

/// An approval target: the tool call it allows.
fn valid_approval_target(value: Option<&Json>) -> bool {
    let Some(map) = value.and_then(as_map) else {
        return false;
    };
    if !ensure_only(
        map,
        &[
            "tool",
            "origin",
            "description",
            "riskClass",
            "command",
            "cwd",
            "paths",
            "access",
            "input",
        ],
    ) {
        return false;
    }
    if !matches!(
        map.get("tool"),
        Some(Json::String(tool)) if !tool.is_empty() && tool.len() <= 256
    ) {
        return false;
    }
    if !map
        .get("origin")
        .is_none_or(|origin| matches!(origin, Json::String(origin) if origin == "ace"))
    {
        return false;
    }
    if !map.get("description").is_none_or(
        |description| matches!(description, Json::String(description) if description.len() <= 2048),
    ) {
        return false;
    }
    if !map.get("riskClass").is_none_or(|class| {
        matches!(class, Json::String(class)
                if ["read-only", "thread-write", "agent-execution", "external-effect"]
                    .contains(&class.as_str()))
    }) {
        return false;
    }
    if !map
        .get("command")
        .is_none_or(|command| matches!(command, Json::String(command) if command.len() <= 32768))
    {
        return false;
    }
    if !map
        .get("cwd")
        .is_none_or(|cwd| matches!(cwd, Json::String(cwd) if cwd.len() <= 4096))
    {
        return false;
    }
    if !map.get("paths").is_none_or(|paths| {
        matches!(paths, Json::Array(paths)
        if paths.len() <= 128
            && paths.iter().all(
                |path| matches!(path, Json::String(path) if !path.is_empty() && path.len() <= 4096),
            ))
    }) {
        return false;
    }
    if !matches!(
        map.get("access"),
        Some(Json::String(access)) if ["read", "write", "execute", "unknown"].contains(&access.as_str())
    ) {
        return false;
    }
    true
}

fn valid_approval_option(value: &Json) -> bool {
    let Some(map) = as_map(value) else {
        return false;
    };
    ensure_only(map, &["id", "label", "kind"])
        && is_string(map.get("id"))
        && is_string(map.get("label"))
        && map.get("kind").is_none_or(|kind| {
            matches!(kind, Json::Null)
                | matches!(kind, Json::String(kind)
                    if [
                        "allow_once",
                        "allow_session",
                        "allow_always",
                        "deny",
                        "deny_always",
                        "cancel",
                        "other"
                    ]
                    .contains(&kind.as_str()))
        })
}

fn valid_question_option(value: &Json) -> bool {
    let Some(map) = as_map(value) else {
        return false;
    };
    ensure_only(map, &["id", "label", "description"])
        && is_string(map.get("id"))
        && is_string(map.get("label"))
        && optional_string(map.get("description"))
}

fn valid_question(value: &Json) -> bool {
    let Some(map) = as_map(value) else {
        return false;
    };
    ensure_only(
        map,
        &[
            "id",
            "header",
            "text",
            "options",
            "multiSelect",
            "allowOther",
            "secret",
        ],
    ) && is_string(map.get("id"))
        && optional_string(map.get("header"))
        && is_string(map.get("text"))
        && map
            .get("options")
            .and_then(|options| options.as_array())
            .is_some_and(|options| options.iter().all(valid_question_option))
        && map
            .get("multiSelect")
            .is_none_or(|value| matches!(value, Json::Bool(_)))
        && map
            .get("allowOther")
            .is_none_or(|value| matches!(value, Json::Bool(_)))
        && map
            .get("secret")
            .is_none_or(|value| matches!(value, Json::Bool(_)))
}

pub(crate) fn valid_todo_entry(value: &Json) -> bool {
    let Some(map) = as_map(value) else {
        return false;
    };
    ensure_only(map, &["id", "content", "status"])
        && optional_string(map.get("id"))
        && is_string(map.get("content"))
        && matches!(
            map.get("status"),
            Some(Json::String(status))
                if ["pending", "in_progress", "completed", "cancelled"].contains(&status.as_str())
        )
}

/// An interaction request, canonicalized with schema defaults on open.
pub fn valid_interaction_request(value: Option<&Json>) -> bool {
    let Some(map) = value.and_then(as_map) else {
        return false;
    };
    match map.get("kind").and_then(|kind| kind.as_str()) {
        Some("approval") => {
            ensure_only(
                map,
                &[
                    "kind",
                    "target",
                    "title",
                    "description",
                    "options",
                    "defaultToNo",
                    "suppressAlwaysAllowRule",
                    "mcpServer",
                    "permissionUpdates",
                ],
            ) && map.get("target").is_none_or(|target| {
                matches!(target, Json::Null) || valid_approval_target(Some(target))
            }) && is_string(map.get("title"))
                && optional_string(map.get("description"))
                && map
                    .get("options")
                    .and_then(|options| options.as_array())
                    .is_some_and(|options| options.iter().all(valid_approval_option))
                && optional_bool(map.get("defaultToNo"))
                && optional_bool(map.get("suppressAlwaysAllowRule"))
                && map.get("mcpServer").is_none_or(valid_mcp_server)
                && matches!(
                    map.get("permissionUpdates"),
                    None | Some(Json::Null) | Some(Json::Array(_))
                )
        }
        Some("question") => {
            ensure_only(map, &["kind", "questions", "target"])
                && map
                    .get("questions")
                    .and_then(|questions| questions.as_array())
                    .is_some_and(|questions| questions.iter().all(valid_question))
                && map
                    .get("target")
                    .is_none_or(|target| valid_approval_target(Some(target)))
        }
        Some("plan_review") => {
            ensure_only(
                map,
                &["kind", "title", "summary", "markdown", "planPath", "todos"],
            ) && optional_string(map.get("title"))
                && optional_string(map.get("summary"))
                && is_string(map.get("markdown"))
                && optional_string(map.get("planPath"))
                && map.get("todos").is_none_or(|todos| {
                    matches!(todos, Json::Null)
                        || matches!(todos, Json::Array(todos) if todos.iter().all(valid_todo_entry))
                })
        }
        Some("elicitation") => {
            ensure_only(
                map,
                &[
                    "kind",
                    "server",
                    "message",
                    "url",
                    "schema",
                    "mode",
                    "nativeId",
                    "title",
                    "description",
                ],
            ) && is_string(map.get("server"))
                && is_string(map.get("message"))
                && optional_string(map.get("url"))
                && optional_string(map.get("nativeId"))
                && optional_string(map.get("title"))
                && optional_string(map.get("description"))
                && map.get("mode").is_none_or(
                    |mode| matches!(mode, Json::String(mode) if mode == "form" || mode == "url"),
                )
        }
        Some("browser_help") => {
            ensure_only(
                map,
                &[
                    "kind", "target", "tabId", "reason", "message", "url", "title",
                ],
            ) && map
                .get("target")
                .is_none_or(|target| valid_approval_target(Some(target)))
                && matches!(map.get("tabId"), Some(Json::String(tab)) if !tab.is_empty() && tab.len() <= 256)
                && matches!(
                    map.get("reason"),
                    Some(Json::String(reason))
                        if ["login", "captcha", "two_factor", "dialog", "other"]
                            .contains(&reason.as_str())
                )
                && matches!(map.get("message"), Some(Json::String(message)) if message.len() <= 1000)
                && map
                    .get("url")
                    .is_none_or(|url| matches!(url, Json::String(url) if url.len() <= 8192))
                && map
                    .get("title")
                    .is_none_or(|title| matches!(title, Json::String(title) if title.len() <= 1024))
        }
        _ => false,
    }
}

fn valid_mcp_server(value: &Json) -> bool {
    let Some(map) = as_map(value) else {
        return false;
    };
    // `passthrough`: the name and source are typed, the rest is kept.
    is_string(map.get("name")) && is_string(map.get("source"))
}

/// An interaction resolution answers its request's kind.
pub fn valid_interaction_resolution(value: Option<&Json>) -> bool {
    let Some(map) = value.and_then(as_map) else {
        return false;
    };
    match map.get("kind").and_then(|kind| kind.as_str()) {
        Some("approval") => {
            ensure_only(map, &["kind", "optionId", "message"])
                && is_string(map.get("optionId"))
                && optional_string(map.get("message"))
        }
        Some("question") => {
            if !ensure_only(map, &["kind", "answers", "dismissed", "feedback"]) {
                return false;
            }
            let answers_valid = match map.get("answers") {
                Some(Json::Object(answers)) => answers.values().all(|options| {
                    matches!(options, Json::Array(options) if options.iter().all(|option| matches!(option, Json::String(_))))
                }),
                _ => false,
            };
            answers_valid
                && optional_bool(map.get("dismissed"))
                && map.get("feedback").is_none_or(
                    |feedback| matches!(feedback, Json::String(feedback) if feedback.len() <= 8192),
                )
        }
        Some("plan_review") => {
            ensure_only(map, &["kind", "decision", "feedback"])
                && matches!(
                    map.get("decision"),
                    Some(Json::String(decision))
                        if ["approve", "reject", "cancel"].contains(&decision.as_str())
                )
                && optional_string(map.get("feedback"))
        }
        Some("elicitation") => {
            ensure_only(map, &["kind", "action", "content"])
                && matches!(
                    map.get("action"),
                    Some(Json::String(action))
                        if ["accept", "decline", "cancel"].contains(&action.as_str())
                )
        }
        Some("browser_help") => {
            ensure_only(map, &["kind", "outcome"])
                && matches!(
                    map.get("outcome"),
                    Some(Json::String(outcome)) if outcome == "done" || outcome == "skipped"
                )
        }
        _ => false,
    }
}

/// Raw payloads: inline native data or a blob reference.
pub fn valid_raw_payload(value: &Json) -> bool {
    let Some(map) = as_map(value) else {
        return false;
    };
    if !is_string(map.get("type")) {
        return false;
    }
    if map.contains_key("blobRef") || map.contains_key("size") || map.contains_key("preview") {
        if !ensure_only(map, &["type", "name", "blobRef", "size", "preview"]) {
            return false;
        }
        if !optional_string(map.get("name")) {
            return false;
        }
        if !matches!(map.get("blobRef"), Some(Json::String(reference)) if !reference.is_empty()) {
            return false;
        }
        if as_count(map.get("size")).is_none() {
            return false;
        }
        if !map
            .get("preview")
            .is_none_or(|preview| matches!(preview, Json::String(preview) if preview.len() <= 2048))
        {
            return false;
        }
        return true;
    }
    ensure_only(map, &["type", "name", "data"])
        && optional_string(map.get("name"))
        && map.contains_key("data")
}

pub fn valid_raw_list(value: Option<&Json>) -> bool {
    match value {
        None => true,
        Some(Json::Array(raw)) => raw.iter().all(valid_raw_payload),
        _ => false,
    }
}

/// Usage metadata: latest occupied context with its scope and key.
fn valid_usage_metadata(map: &Map, allowed: &[&str]) -> bool {
    if !ensure_only(map, allowed) {
        return false;
    }
    for key in [
        "contextTokens",
        "reasoningTokens",
        "cacheWriteTokens",
        "cacheWrite1hTokens",
    ] {
        if let Some(value) = map.get(key)
            && as_count(Some(value)).is_none()
        {
            return false;
        }
    }
    if let Some(value) = map.get("contextSessionId")
        && !matches!(value, Json::String(id) if !id.is_empty() && id.len() <= 512)
    {
        return false;
    }
    if let Some(value) = map.get("model")
        && !matches!(value, Json::String(model) if !model.is_empty())
    {
        return false;
    }
    if let Some(value) = map.get("accountId")
        && !matches!(value, Json::String(id) if !id.is_empty() && id.len() <= 512)
    {
        return false;
    }
    for (key, values) in [
        (
            "billingMode",
            &["api", "subscription", "unknown"] as &[&str],
        ),
        ("counterMode", &["cumulative", "incremental"]),
        (
            "usageScope",
            &["agent", "provider_session", "model_session"],
        ),
    ] {
        if let Some(value) = map.get(key)
            && !matches!(value, Json::String(mode) if values.contains(&mode.as_str()))
        {
            return false;
        }
    }
    if let Some(value) = map.get("counterKey")
        && !matches!(value, Json::String(key) if !key.is_empty() && key.len() <= 512)
    {
        return false;
    }
    let scoped = map
        .get("usageScope")
        .and_then(|scope| scope.as_str())
        .is_some_and(|scope| scope == "provider_session" || scope == "model_session");
    if scoped && !matches!(map.get("counterKey"), Some(Json::String(key)) if !key.is_empty()) {
        return false;
    }
    true
}

/// A usage fact carries token counts plus usage metadata, and only the
/// fact's own keys besides them.
pub fn valid_usage_like(map: &Map, extra: &[&str]) -> bool {
    let mut allowed = vec![
        "contextTokens",
        "contextSessionId",
        "reasoningTokens",
        "cacheWriteTokens",
        "cacheWrite1hTokens",
        "model",
        "accountId",
        "billingMode",
        "counterMode",
        "counterKey",
        "usageScope",
        "inputTokens",
        "outputTokens",
        "cachedInputTokens",
        "contextWindow",
        "costUsd",
    ];
    allowed.extend_from_slice(extra);
    as_count(map.get("inputTokens")).is_some()
        && as_count(map.get("outputTokens")).is_some()
        && map
            .get("cachedInputTokens")
            .is_none_or(|value| !matches!(value, Json::Null) && as_count(Some(value)).is_some())
        && map.get("contextWindow").is_none_or(|value| {
            !matches!(value, Json::Null)
                && matches!(as_count(Some(value)), Some(window) if window > 0)
        }) && map.get("costUsd").is_none_or(|value| {
        !matches!(value, Json::Null)
            && matches!(value, Json::Number(cost) if cost.as_f64().is_some_and(|cost| cost >= 0.0))
    }) && valid_usage_metadata(map, &allowed)
}

/// A context sample carries the latest occupied context.
pub fn valid_context_sample(map: &Map) -> bool {
    as_count(map.get("usedTokens")).is_some()
        && map
            .get("windowTokens")
            .is_none_or(|value| matches!(as_count(Some(value)), Some(window) if window > 0))
        && optional_string(map.get("sessionId"))
        && optional_string(map.get("model"))
        && ensure_only(
            map,
            &[
                "agent",
                "usedTokens",
                "windowTokens",
                "sessionId",
                "model",
                "type",
            ],
        )
}

/// The provider's native goal changed, or was cleared.
pub fn valid_goal(map: &Map) -> bool {
    ensure_only(
        map,
        &[
            "objective",
            "status",
            "tokensUsed",
            "tokenBudget",
            "timeUsedSeconds",
            "checks",
            "lastReason",
            "setAt",
        ],
    ) && matches!(
        map.get("objective"),
        Some(Json::String(objective)) if !objective.is_empty() && objective.len() <= 4000
    ) && matches!(
        map.get("status"),
        Some(Json::String(status))
            if [
                "active",
                "paused",
                "blocked",
                "usage_limited",
                "budget_limited",
                "complete"
            ]
            .contains(&status.as_str())
    ) && map
        .get("tokensUsed")
        .is_none_or(|value| !matches!(value, Json::Null) && as_count(Some(value)).is_some())
        && map
            .get("tokenBudget")
            .is_none_or(|value| !matches!(value, Json::Null) && as_count(Some(value)).is_some())
        && map
            .get("timeUsedSeconds")
            .is_none_or(|value| !matches!(value, Json::Null) && as_count(Some(value)).is_some())
        && map
            .get("checks")
            .is_none_or(|value| !matches!(value, Json::Null) && as_count(Some(value)).is_some())
        && map.get("lastReason").is_none_or(|reason| {
            matches!(reason, Json::Null)
                | matches!(reason, Json::String(reason) if reason.len() <= 4000)
        })
        && map
            .get("setAt")
            .is_none_or(|value| !matches!(value, Json::Null) && as_count(Some(value)).is_some())
}

fn valid_screen_key(value: &Json) -> bool {
    matches!(value, Json::String(key) if super::validate_items::screen_key_valid(key))
}

/// One screen input: pointer, key, text, or scroll.
pub fn valid_screen_input(value: &Json) -> bool {
    let Some(map) = as_map(value) else {
        return false;
    };
    let finite = |value: Option<&Json>| matches!(value, Some(Json::Number(n)) if n.as_f64().is_some_and(|n| n.is_finite()));
    let nonneg_finite = |value: Option<&Json>| matches!(value, Some(Json::Number(n)) if n.as_f64().is_some_and(|n| n.is_finite() && n >= 0.0));
    match map.get("kind").and_then(|kind| kind.as_str()) {
        Some("pointer.move") => {
            map.keys().all(|key| ["kind", "x", "y"].contains(&key.as_str()))
                && nonneg_finite(map.get("x"))
                && nonneg_finite(map.get("y"))
        }
        Some("pointer.click") => {
            map.keys().all(|key| ["kind", "x", "y", "button"].contains(&key.as_str()))
                && nonneg_finite(map.get("x"))
                && nonneg_finite(map.get("y"))
                && map.get("button").is_none_or(|button| {
                    matches!(button, Json::Null)
                        | matches!(button, Json::String(button) if button == "left" || button == "right")
                })
        }
        Some("pointer.drag") => {
            map.keys().all(|key| {
                ["kind", "durationMs", "x", "y", "toX", "toY", "button"].contains(&key.as_str())
            }) && map.get("durationMs").is_none_or(|duration| {
                matches!(as_integer(Some(duration)), Some(duration) if (1..=10000).contains(&duration))
            }) && nonneg_finite(map.get("x"))
                && nonneg_finite(map.get("y"))
                && nonneg_finite(map.get("toX"))
                && nonneg_finite(map.get("toY"))
                && map.get("button").is_none_or(|button| {
                    matches!(button, Json::Null)
                        | matches!(button, Json::String(button) if button == "left" || button == "right")
                })
        }
        Some("key.press") => {
            map.keys().all(|key| ["kind", "key", "modifiers"].contains(&key.as_str()))
                && valid_screen_key(map.get("key").unwrap_or(&Json::Null))
                && matches!(map.get("modifiers"), Some(Json::Array(modifiers))
                    if modifiers.len() <= 4
                        && modifiers.iter().all(|modifier| {
                            matches!(modifier, Json::String(modifier)
                                if ["command", "shift", "option", "control", "alt", "meta", "super"]
                                    .contains(&modifier.as_str()))
                        }))
        }
        Some("text.type") => {
            map.keys().all(|key| ["kind", "text"].contains(&key.as_str()))
                && matches!(map.get("text"), Some(Json::String(text)) if text.len() <= 4096)
        }
        Some("scroll") => {
            map.keys().all(|key| ["kind", "x", "y", "dx", "dy"].contains(&key.as_str()))
                && map.get("x").is_none_or(|x| matches!(x, Json::Null) || finite(Some(x)))
                && map.get("y").is_none_or(|y| matches!(y, Json::Null) || finite(Some(y)))
                && matches!(as_integer(map.get("dx")), Some(dx) if (-1000..=1000).contains(&dx))
                && matches!(as_integer(map.get("dy")), Some(dy) if (-1000..=1000).contains(&dy))
        }
        Some("text.paste") => {
            map.keys().all(|key| ["kind", "text"].contains(&key.as_str()))
                && matches!(map.get("text"), Some(Json::String(text)) if text.len() <= 4096)
        }
        Some("pointer.down" | "pointer.up") => {
            map.keys().all(|key| ["kind", "x", "y"].contains(&key.as_str()))
                && nonneg_finite(map.get("x"))
                && nonneg_finite(map.get("y"))
        }
        Some("pointer.cancel") => map.keys().all(|key| key == "kind"),
        _ => false,
    }
}

/// One browser interaction action.
pub fn valid_browser_action(value: &Json) -> bool {
    // `strictObject`: unknown fields throw in the TypeScript, so they fail
    // here rather than stripping.
    let Some(map) = as_map(value) else {
        return false;
    };
    let reference = |value: Option<&Json>| matches!(value, Some(Json::String(reference)) if !reference.is_empty() && reference.len() <= 256);
    match map.get("action").and_then(|action| action.as_str()) {
        Some("click") => {
            map.keys()
                .all(|key| ["action", "ref"].contains(&key.as_str()))
                && reference(map.get("ref"))
        }
        Some("type") => {
            map.keys()
                .all(|key| ["action", "ref", "text"].contains(&key.as_str()))
                && reference(map.get("ref"))
                && matches!(map.get("text"), Some(Json::String(text)) if text.len() <= 65_536)
        }
        Some("press") => {
            map.keys()
                .all(|key| ["action", "key", "ref"].contains(&key.as_str()))
                && reference(map.get("key"))
                && map
                    .get("ref")
                    .is_none_or(|optional| reference(Some(optional)))
        }
        Some("scroll") => {
            map.keys()
                .all(|key| ["action", "x", "y"].contains(&key.as_str()))
                && matches!(map.get("x"), Some(Json::Number(x)) if x.as_f64().is_some_and(|x| x.is_finite() && (-100_000.0..=100_000.0).contains(&x)))
                && matches!(map.get("y"), Some(Json::Number(y)) if y.as_f64().is_some_and(|y| y.is_finite() && (-100_000.0..=100_000.0).contains(&y)))
        }
        Some("drag") => {
            map.keys()
                .all(|key| ["action", "ref", "toRef"].contains(&key.as_str()))
                && reference(map.get("ref"))
                && reference(map.get("toRef"))
        }
        _ => false,
    }
}

fn valid_interaction_target(value: &Json) -> bool {
    let Some(map) = as_map(value) else {
        return false;
    };
    match map.get("kind").and_then(|kind| kind.as_str()) {
        Some("window") => {
            map.keys()
                .all(|key| ["kind", "bundleId", "windowId"].contains(&key.as_str()))
                && matches!(map.get("bundleId"), Some(Json::String(id)) if !id.is_empty() && id.len() <= 256)
                && matches!(as_integer(map.get("windowId")), Some(id) if id > 0)
        }
        Some("browser-tab") => {
            map.keys()
                .all(|key| ["kind", "threadId", "tabId"].contains(&key.as_str()))
                && matches!(map.get("threadId"), Some(Json::String(id)) if !id.is_empty() && id.len() <= 256)
                && map.get("tabId").is_none_or(|tab| {
                    matches!(tab, Json::Null)
                        | matches!(tab, Json::String(tab) if !tab.is_empty() && tab.len() <= 256)
                })
        }
        _ => false,
    }
}

fn valid_metric_summary(value: &Json) -> bool {
    let Some(map) = as_map(value) else {
        return false;
    };
    map.keys()
        .all(|key| ["median", "worst"].contains(&key.as_str()))
        && matches!(map.get("median"), Some(Json::Number(n)) if n.as_f64().is_some_and(|n| n.is_finite() && n >= 0.0))
        && matches!(map.get("worst"), Some(Json::Number(n)) if n.as_f64().is_some_and(|n| n.is_finite() && n >= 0.0))
}

fn valid_interaction_gap(value: &Json) -> bool {
    let Some(map) = as_map(value) else {
        return false;
    };
    map.keys()
        .all(|key| ["atMs", "durationMs"].contains(&key.as_str()))
        && matches!(map.get("atMs"), Some(Json::Number(n)) if n.as_f64().is_some_and(|n| n.is_finite() && n >= 0.0))
        && matches!(map.get("durationMs"), Some(Json::Number(n)) if n.as_f64().is_some_and(|n| n.is_finite() && n >= 0.0))
}

/// Daemon-owned transcript evidence; the image case uses attachments.
pub fn valid_step_measurement(value: &Json) -> bool {
    let Some(map) = as_map(value) else {
        return false;
    };
    if map.keys().any(|key| {
        ![
            "source",
            "target",
            "action",
            "refreshHz",
            "windowMs",
            "latencyMs",
            "settleMs",
            "frames",
            "effectiveFps",
            "droppedFrames",
            "hitches",
            "hitchRatioMsPerS",
            "hitchTimeMs",
            "longTasks",
            "layoutShift",
            "verdict",
            "confidence",
            "hostLoad",
            "captureOverheadPct",
            "filmstrip",
            "notes",
            "repeat",
        ]
        .contains(&key.as_str())
    }) {
        return false;
    }
    if !matches!(
        map.get("source"),
        Some(Json::String(source)) if source == "screen-frames" || source == "browser-trace"
    ) {
        return false;
    }
    if !valid_interaction_target(map.get("target").unwrap_or(&Json::Null)) {
        return false;
    }
    if let Some(action) = map.get("action")
        && (matches!(action, Json::Null)
            || !(valid_screen_input(action) || valid_browser_action(action)))
    {
        return false;
    }
    if !matches!(map.get("refreshHz"), Some(Json::Number(hz)) if hz.as_f64().is_some_and(|hz| hz.is_finite() && hz > 0.0 && hz <= 240.0))
    {
        return false;
    }
    if !matches!(map.get("windowMs"), Some(Json::Number(ms)) if ms.as_f64().is_some_and(|ms| ms.is_finite() && (0.0..=10_000.0).contains(&ms)))
    {
        return false;
    }
    for key in [
        "latencyMs",
        "settleMs",
        "effectiveFps",
        "hitchRatioMsPerS",
        "hitchTimeMs",
        "layoutShift",
        "hostLoad",
        "captureOverheadPct",
    ] {
        if let Some(value) = map.get(key)
            && (matches!(value, Json::Null)
                || !matches!(value, Json::Number(n) if n.as_f64().is_some_and(|n| n.is_finite() && n >= 0.0)))
        {
            return false;
        }
    }
    if !matches!(as_integer(map.get("frames")), Some(frames) if (0..=2400).contains(&frames)) {
        return false;
    }
    if let Some(dropped) = map.get("droppedFrames")
        && (matches!(dropped, Json::Null) || as_integer(Some(dropped)).is_none())
    {
        return false;
    }
    if !map
        .get("hitches")
        .and_then(|hitches| hitches.as_array())
        .is_some_and(|hitches| hitches.len() <= 20 && hitches.iter().all(valid_interaction_gap))
    {
        return false;
    }
    if let Some(tasks) = map.get("longTasks")
        && (matches!(tasks, Json::Null)
            || !matches!(tasks, Json::Array(tasks) if tasks.len() <= 100 && tasks.iter().all(valid_interaction_gap)))
    {
        return false;
    }
    if !matches!(
        map.get("verdict"),
        Some(Json::String(verdict))
            if ["smooth", "minor_hitches", "janky", "no_change", "inconclusive"]
                .contains(&verdict.as_str())
    ) {
        return false;
    }
    if !matches!(
        map.get("confidence"),
        Some(Json::String(confidence)) if ["high", "medium", "low"].contains(&confidence.as_str())
    ) {
        return false;
    }
    if let Some(filmstrip) = map.get("filmstrip")
        && (matches!(filmstrip, Json::Null) || !super::validate_items::valid_attachment(filmstrip))
    {
        return false;
    }
    if !map
        .get("notes")
        .and_then(|notes| notes.as_array())
        .is_some_and(|notes| {
            notes.len() <= 32
                && notes
                    .iter()
                    .all(|note| matches!(note, Json::String(note) if note.len() <= 512))
        })
    {
        return false;
    }
    if let Some(repeat) = map.get("repeat") {
        if matches!(repeat, Json::Null) {
            return false;
        }
        let Some(repeat) = as_map(repeat) else {
            return false;
        };
        if repeat
            .keys()
            .any(|key| !["runs", "metrics"].contains(&key.as_str()))
        {
            return false;
        }
        if !repeat.get("runs").and_then(|runs| runs.as_array()).is_some_and(|runs| {
            !runs.is_empty()
                && runs.len() <= 5
                && runs.iter().all(|run| {
                    let Some(run) = as_map(run) else {
                        return false;
                    };
                    run.keys().all(|key| ["verdict", "confidence"].contains(&key.as_str()))
                        && matches!(
                            run.get("verdict"),
                            Some(Json::String(verdict))
                                if ["smooth", "minor_hitches", "janky", "no_change", "inconclusive"]
                                    .contains(&verdict.as_str())
                        )
                        && matches!(
                            run.get("confidence"),
                            Some(Json::String(confidence)) if ["high", "medium", "low"].contains(&confidence.as_str())
                        )
                })
        }) {
            return false;
        }
        let metrics_valid = match repeat.get("metrics").and_then(as_map) {
            Some(metrics) => {
                metrics.keys().all(|key| {
                    [
                        "refreshHz",
                        "windowMs",
                        "frames",
                        "latencyMs",
                        "settleMs",
                        "effectiveFps",
                        "droppedFrames",
                        "hitchRatioMsPerS",
                        "layoutShift",
                        "hostLoad",
                        "captureOverheadPct",
                        "longTaskMs",
                        "hitchMs",
                    ]
                    .contains(&key.as_str())
                }) && ["refreshHz", "windowMs", "frames", "hitchMs"]
                    .iter()
                    .all(|key| metrics.get(*key).is_some_and(valid_metric_summary))
                    && [
                        "latencyMs",
                        "settleMs",
                        "effectiveFps",
                        "droppedFrames",
                        "hitchRatioMsPerS",
                        "layoutShift",
                        "hostLoad",
                        "captureOverheadPct",
                        "longTaskMs",
                    ]
                    .iter()
                    .all(|key| {
                        metrics.get(*key).is_none_or(|value| {
                            matches!(value, Json::Null) || valid_metric_summary(value)
                        })
                    })
            }
            None => false,
        };
        if !metrics_valid {
            return false;
        }
    }
    true
}
