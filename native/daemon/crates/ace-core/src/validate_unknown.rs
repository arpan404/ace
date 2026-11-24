// SPDX-License-Identifier: Apache-2.0
//! The unknown-field walk behind `preservesFields`: the merged candidate
//! keeps every draft field, so anything the Zod schemas would strip is still
//! visible here. Stripping the unknowns and re-validating distinguishes an
//! unknown field from a misshapen one, exactly like `safeParse` followed by
//! `preservesFields`.
//!
//! Leaves the schemas type as `unknown` (`data`, `arguments`, `schema`,
//! `content`, `input`, `raw` payload data, `permissionUpdates`,
//! `structuredContent`, record values) or `passthrough` (MCP server extras)
//! are kept verbatim: no valid fact can fail there. `strictObject` levels
//! (browser actions, device items) are never stripped: the TypeScript throws
//! on their unknowns instead of stripping them.

use crate::json_io::{Json, Map};

/// Strip unknown fields from a merged item candidate, reporting whether
/// anything was removed.
pub fn strip_item_unknowns(candidate: &Map) -> (Map, bool) {
    let mut removed = false;
    let mut stripped = Map::new();
    for (key, value) in candidate.iter() {
        if !is_base_key(key) && !is_variant_key(candidate, key) {
            removed = true;
            continue;
        }
        stripped.insert(
            key.clone(),
            strip_item_field(candidate, key, value, &mut removed),
        );
    }
    (stripped, removed)
}

fn is_base_key(key: &str) -> bool {
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
    ]
    .contains(&key)
}

fn variant_kind(candidate: &Map) -> Option<&str> {
    candidate.get("type").and_then(|kind| kind.as_str())
}

fn is_variant_key(candidate: &Map, key: &str) -> bool {
    if key == "type" {
        return true;
    }
    match variant_kind(candidate) {
        Some("html") => ["visualization", "raw"].contains(&key),
        Some("image") => ["image", "raw"].contains(&key),
        Some("message") => [
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
        .contains(&key),
        Some("delegation.started") => [
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
        .contains(&key),
        Some("delegation.settled") => ["origin", "results", "delivery", "raw"].contains(&key),
        Some("reasoning") => ["text", "source", "summary", "raw"].contains(&key),
        Some("tool_call") => ["call", "measurement"].contains(&key),
        Some("notice") => [
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
        .contains(&key),
        Some("compaction") => ["tokensBefore", "tokensAfter", "summary", "raw"].contains(&key),
        Some("unknown") => ["raw", "data"].contains(&key),
        Some("artifact") => [
            "filename",
            "flags",
            "source",
            "artifactId",
            "path",
            "mimeType",
            "bytes",
        ]
        .contains(&key),
        _ => false,
    }
}

fn strip_item_field(candidate: &Map, key: &str, value: &Json, removed: &mut bool) -> Json {
    if key == "raw" {
        return strip_raw_array(value, removed);
    }
    if key == "executionSource" {
        return strip_execution_source(value, removed);
    }
    if key == "inherited" {
        return strip_inherited(value, removed);
    }
    match variant_kind(candidate) {
        Some("message") => match key {
            "parts" => strip_parts(value, removed),
            "attachments" => strip_attachments(value, removed),
            "origin" => strip_message_origin(value, removed),
            "mergedContext" => strip_merged_fork(value, removed),
            "speaker" => strip_speaker(value, removed),
            "source" => strip_text_source(value, removed),
            _ => value.clone(),
        },
        Some("tool_call") => match key {
            "call" => strip_tool_call(value, removed),
            "measurement" => strip_measurement(value, removed),
            _ => value.clone(),
        },
        Some("notice") => match key {
            "details" => strip_error_details(value, removed),
            "asked" => strip_asked(value, removed),
            "source" => strip_text_source(value, removed),
            "measurement" => strip_measurement(value, removed),
            _ => value.clone(),
        },
        Some("reasoning") => match key {
            "source" => strip_text_source(value, removed),
            _ => value.clone(),
        },
        Some("delegation.started") => match key {
            "status" => strip_thread_status(value, removed),
            "outcome" => strip_outcome(value, removed),
            "machine" => strip_machine(value, removed),
            _ => value.clone(),
        },
        Some("delegation.settled") => match key {
            "results" => strip_outcomes(value, removed),
            _ => value.clone(),
        },
        Some("html") => match key {
            "visualization" => strip_html_visualization(value, removed),
            _ => value.clone(),
        },
        Some("image") => match key {
            "image" => strip_attachment(value, removed),
            _ => value.clone(),
        },
        _ => value.clone(),
    }
}

fn strip_object(value: &Json, allowed: &[&str], removed: &mut bool) -> Json {
    match value {
        Json::Object(map) => Json::Object(
            map.iter()
                .filter(|(key, _)| {
                    let keep = allowed.contains(&key.as_str());
                    if !keep {
                        *removed = true;
                    }
                    keep
                })
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect(),
        ),
        _ => value.clone(),
    }
}

fn as_map(value: &Json) -> Option<&Map> {
    match value {
        Json::Object(map) => Some(map),
        _ => None,
    }
}

fn strip_raw_array(value: &Json, removed: &mut bool) -> Json {
    match value {
        Json::Array(raw) => Json::Array(
            raw.iter()
                .map(|payload| strip_raw_payload(payload, removed))
                .collect(),
        ),
        _ => value.clone(),
    }
}

fn strip_raw_payload(value: &Json, removed: &mut bool) -> Json {
    let Some(map) = as_map(value) else {
        return value.clone();
    };
    let blob =
        map.contains_key("blobRef") || map.contains_key("size") || map.contains_key("preview");
    let allowed: &[&str] = if blob {
        &["type", "name", "blobRef", "size", "preview"]
    } else {
        &["type", "name", "data"]
    };
    strip_object(value, allowed, removed)
}

fn strip_text_source(value: &Json, removed: &mut bool) -> Json {
    strip_object(value, &["streamId", "bytes", "encoding", "offset"], removed)
}

fn strip_attachments(value: &Json, removed: &mut bool) -> Json {
    match value {
        Json::Array(items) => Json::Array(
            items
                .iter()
                .map(|item| strip_attachment(item, removed))
                .collect(),
        ),
        _ => value.clone(),
    }
}

fn strip_attachment(value: &Json, removed: &mut bool) -> Json {
    strip_object(
        value,
        &[
            "sha256",
            "bytes",
            "mimeType",
            "name",
            "kind",
            "delivery",
            "width",
            "height",
            "thumbnailAvailable",
        ],
        removed,
    )
}

fn strip_parts(value: &Json, removed: &mut bool) -> Json {
    match value {
        Json::Array(parts) => {
            Json::Array(parts.iter().map(|part| strip_part(part, removed)).collect())
        }
        _ => value.clone(),
    }
}

fn strip_part(value: &Json, removed: &mut bool) -> Json {
    let Some(map) = as_map(value) else {
        return value.clone();
    };
    match map.get("type").and_then(|kind| kind.as_str()) {
        Some("text") => {
            let mut stripped = strip_object(value, &["type", "text", "source"], removed);
            if let Json::Object(stripped) = &mut stripped
                && let Some(source) = stripped.get("source").cloned()
            {
                stripped.insert("source".to_owned(), strip_text_source(&source, removed));
            }
            stripped
        }
        Some("image") => strip_object(value, &["type", "mimeType", "url"], removed),
        Some("file") => {
            let mut stripped = strip_object(
                value,
                &["type", "path", "mimeType", "name", "content"],
                removed,
            );
            if let Json::Object(stripped) = &mut stripped
                && let Some(content) = stripped.get("content").cloned()
            {
                stripped.insert("content".to_owned(), strip_file_content(&content, removed));
            }
            stripped
        }
        Some("mention") => {
            let mut stripped = strip_object(
                value,
                &[
                    "type",
                    "entryId",
                    "name",
                    "title",
                    "kind",
                    "icon",
                    "arguments",
                    "values",
                    "invocation",
                ],
                removed,
            );
            if let Json::Object(stripped) = &mut stripped {
                // `values` and `invocation` keep their keys: records and
                // variants validate them on re-validation.
                let _ = stripped;
            }
            stripped
        }
        _ => value.clone(),
    }
}

fn strip_file_content(value: &Json, removed: &mut bool) -> Json {
    strip_object(value, &["encoding", "data"], removed)
}

fn strip_tool_call(value: &Json, removed: &mut bool) -> Json {
    let mut stripped = strip_object(
        value,
        &[
            "id",
            "agentId",
            "kind",
            "title",
            "status",
            "detail",
            "backgroundTaskId",
            "error",
            "result",
            "startedAt",
            "endedAt",
            "raw",
        ],
        removed,
    );
    if let Json::Object(stripped) = &mut stripped {
        if let Some(detail) = stripped.get("detail").cloned() {
            stripped.insert("detail".to_owned(), strip_tool_detail(&detail, removed));
        }
        if let Some(raw) = stripped.get("raw").cloned() {
            stripped.insert("raw".to_owned(), strip_raw_array(&raw, removed));
        }
        if let Some(result) = stripped.get("result").cloned() {
            stripped.insert("result".to_owned(), strip_tool_result(&result, removed));
        }
    }
    stripped
}

fn strip_tool_detail(value: &Json, removed: &mut bool) -> Json {
    let Some(map) = as_map(value) else {
        return value.clone();
    };
    let allowed: &[&str] = match map.get("kind").and_then(|kind| kind.as_str()) {
        Some("shell") => &["kind", "command", "rawCommand", "cwd", "exitCode", "output"],
        Some("file.read") => &["kind", "path", "range"],
        Some("file.edit" | "file.write" | "file.delete" | "file.move") => &["kind", "changes"],
        Some("search") => &["kind", "query", "path", "matches", "scope"],
        Some("web.search") => &["kind", "query"],
        Some("web.fetch") => &["kind", "url"],
        Some("mcp") => &["kind", "server", "tool", "arguments"],
        Some("agent.spawn") => &["kind", "description", "prompt", "agentType", "childAgentId"],
        Some("agent.message") => &["kind", "targetAgentId", "message"],
        Some("todo") => &["kind", "todos"],
        Some("plan") => &["kind", "markdown", "todos"],
        Some("ask_user") => &["kind"],
        Some("image") => &["kind", "path", "sourcePath", "attachment", "unavailable"],
        Some("browser" | "notebook" | "custom") => &["kind"],
        _ => return value.clone(),
    };
    let mut stripped = strip_object(value, allowed, removed);
    if let Json::Object(stripped) = &mut stripped
        && let Some(range) = stripped.get("range").cloned()
    {
        stripped.insert(
            "range".to_owned(),
            strip_object(&range, &["start", "end"], removed),
        );
    }
    if let Json::Object(stripped) = &mut stripped {
        if let Some(output) = stripped.get("output").cloned() {
            stripped.insert("output".to_owned(), strip_output_summary(&output, removed));
        }
        if let Some(changes) = stripped.get("changes").cloned()
            && let Json::Array(changes) = &changes
        {
            stripped.insert(
                "changes".to_owned(),
                Json::Array(
                    changes
                        .iter()
                        .map(|change| strip_file_change(change, removed))
                        .collect(),
                ),
            );
        }
        if let Some(todos) = stripped.get("todos").cloned()
            && let Json::Array(todos) = &todos
        {
            stripped.insert(
                "todos".to_owned(),
                Json::Array(
                    todos
                        .iter()
                        .map(|todo| strip_todo_entry(todo, removed))
                        .collect(),
                ),
            );
        }
        if let Some(attachment) = stripped.get("attachment").cloned() {
            stripped.insert(
                "attachment".to_owned(),
                strip_attachment(&attachment, removed),
            );
        }
        if let Some(result) = stripped.get("result").cloned() {
            stripped.insert("result".to_owned(), strip_tool_result(&result, removed));
        }
    }
    stripped
}

fn strip_file_change(value: &Json, removed: &mut bool) -> Json {
    strip_object(
        value,
        &["path", "kind", "movePath", "diff", "oldText", "newText"],
        removed,
    )
}

fn strip_todo_entry(value: &Json, removed: &mut bool) -> Json {
    strip_object(value, &["id", "content", "status"], removed)
}

fn strip_output_summary(value: &Json, removed: &mut bool) -> Json {
    strip_object(value, &["streamId", "bytes", "tail", "truncated"], removed)
}

fn strip_tool_result(value: &Json, removed: &mut bool) -> Json {
    let mut stripped = strip_object(
        value,
        &[
            "isError",
            "content",
            "structuredContent",
            "durationMs",
            "target",
            "mode",
            "scale",
            "size",
        ],
        removed,
    );
    if let Json::Object(stripped) = &mut stripped {
        if let Some(Json::Array(content)) = stripped.get("content").cloned() {
            stripped.insert(
                "content".to_owned(),
                Json::Array(
                    content
                        .iter()
                        .map(|entry| strip_result_content(entry, removed))
                        .collect(),
                ),
            );
        }
        if let Some(target) = stripped.get("target").cloned() {
            stripped.insert(
                "target".to_owned(),
                strip_object(&target, &["bundleId", "windowId", "displayName"], removed),
            );
        }
        if let Some(size) = stripped.get("size").cloned() {
            stripped.insert(
                "size".to_owned(),
                strip_object(&size, &["width", "height"], removed),
            );
        }
    }
    stripped
}

fn strip_result_content(value: &Json, removed: &mut bool) -> Json {
    let Some(map) = as_map(value) else {
        return value.clone();
    };
    match map.get("type").and_then(|kind| kind.as_str()) {
        Some("text") => strip_object(value, &["type", "text"], removed),
        Some("image") => {
            let mut stripped = strip_object(value, &["type", "attachment"], removed);
            if let Json::Object(stripped) = &mut stripped
                && let Some(attachment) = stripped.get("attachment").cloned()
            {
                stripped.insert(
                    "attachment".to_owned(),
                    strip_attachment(&attachment, removed),
                );
            }
            stripped
        }
        _ => value.clone(),
    }
}

fn strip_message_origin(value: &Json, removed: &mut bool) -> Json {
    let mut stripped = strip_object(
        value,
        &[
            "kind",
            "client",
            "commandId",
            "interactionId",
            "threadIds",
            "role",
            "from",
            "to",
            "sources",
            "lossy",
            "freshSession",
            "afterExit",
            "via",
        ],
        removed,
    );
    if let Json::Object(stripped) = &mut stripped {
        for key in ["client", "from", "to"] {
            if let Some(part) = stripped.get(key).cloned() {
                stripped.insert(key.to_owned(), strip_origin_part(&part, key, removed));
            }
        }
        if let Some(Json::Array(sources)) = stripped.get("sources").cloned() {
            stripped.insert(
                "sources".to_owned(),
                Json::Array(
                    sources
                        .iter()
                        .map(|source| strip_object(source, &["provider", "model"], removed))
                        .collect(),
                ),
            );
        }
        if let Some(via) = stripped.get("via").cloned() {
            stripped.insert(
                "via".to_owned(),
                strip_object(&via, &["threadId", "title"], removed),
            );
        }
    }
    stripped
}

fn strip_origin_part(value: &Json, key: &str, removed: &mut bool) -> Json {
    match key {
        "client" => strip_object(value, &["grantId", "name"], removed),
        _ => strip_object(value, &["provider", "model"], removed),
    }
}

fn strip_merged_fork(value: &Json, removed: &mut bool) -> Json {
    let mut stripped = strip_object(
        value,
        &["sourceThreadId", "summary", "citations", "patchApplied"],
        removed,
    );
    if let Json::Object(stripped) = &mut stripped
        && let Some(Json::Array(citations)) = stripped.get("citations").cloned()
    {
        stripped.insert(
            "citations".to_owned(),
            Json::Array(
                citations
                    .iter()
                    .map(|citation| strip_object(citation, &["threadId", "itemId"], removed))
                    .collect(),
            ),
        );
    }
    stripped
}

fn strip_speaker(value: &Json, removed: &mut bool) -> Json {
    strip_object(
        value,
        &[
            "kind", "id", "name", "avatar", "club", "machine", "about", "ask",
        ],
        removed,
    )
}

fn strip_execution_source(value: &Json, removed: &mut bool) -> Json {
    let mut stripped = strip_object(value, &["nativeSessionId", "selection"], removed);
    if let Json::Object(stripped) = &mut stripped
        && let Some(selection) = stripped.get("selection").cloned()
    {
        stripped.insert(
            "selection".to_owned(),
            strip_object(
                &selection,
                &["provider", "model", "instanceId", "options"],
                removed,
            ),
        );
    }
    stripped
}

fn strip_inherited(value: &Json, removed: &mut bool) -> Json {
    strip_object(value, &["threadId", "itemId", "at"], removed)
}

fn strip_asked(value: &Json, removed: &mut bool) -> Json {
    let mut stripped = strip_object(
        value,
        &["about", "to", "devices", "share", "shares", "words"],
        removed,
    );
    if let Json::Object(stripped) = &mut stripped {
        if let Some(Json::Array(to)) = stripped.get("to").cloned() {
            stripped.insert(
                "to".to_owned(),
                Json::Array(
                    to.iter()
                        .map(|entry| strip_addressed_to(entry, removed))
                        .collect(),
                ),
            );
        }
        if let Some(Json::Array(devices)) = stripped.get("devices").cloned() {
            stripped.insert(
                "devices".to_owned(),
                Json::Array(
                    devices
                        .iter()
                        .map(|device| strip_device_item(device, removed))
                        .collect(),
                ),
            );
        }
    }
    stripped
}

fn strip_addressed_to(value: &Json, removed: &mut bool) -> Json {
    let mut stripped = strip_object(value, &["to", "state", "detail"], removed);
    if let Json::Object(stripped) = &mut stripped
        && let Some(to) = stripped.get("to").cloned()
    {
        stripped.insert("to".to_owned(), strip_addressee(&to, removed));
    }
    stripped
}

fn strip_addressee(value: &Json, removed: &mut bool) -> Json {
    let Some(map) = as_map(value) else {
        return value.clone();
    };
    // Addressee variants are strict in one case only through re-validation;
    // strip the known keys per kind here.
    match map.get("kind").and_then(|kind| kind.as_str()) {
        Some("bot") => strip_object(value, &["kind", "id", "name", "avatar", "machine"], removed),
        Some("club") => {
            let mut stripped =
                strip_object(value, &["kind", "id", "name", "faces", "machine"], removed);
            if let Json::Object(stripped) = &mut stripped {
                if let Some(Json::Array(faces)) = stripped.get("faces").cloned() {
                    stripped.insert(
                        "faces".to_owned(),
                        Json::Array(
                            faces
                                .iter()
                                .map(|face| strip_object(face, &["id", "avatar"], removed))
                                .collect(),
                        ),
                    );
                }
                if let Some(machine) = stripped.get("machine").cloned() {
                    stripped.insert(
                        "machine".to_owned(),
                        strip_object(&machine, &["id", "name"], removed),
                    );
                }
            }
            stripped
        }
        Some("agent") => strip_object(value, &["kind", "threadId", "title", "provider"], removed),
        _ => value.clone(),
    }
}

fn strip_device_item(value: &Json, _removed: &mut bool) -> Json {
    // `strictObject`: never strip; the TypeScript throws on unknowns.
    value.clone()
}

fn strip_error_details(value: &Json, removed: &mut bool) -> Json {
    let _ = removed;
    strip_object(
        value,
        &["code", "provider", "title", "detail", "model"],
        removed,
    )
}

fn strip_thread_status(value: &Json, removed: &mut bool) -> Json {
    let Some(map) = as_map(value) else {
        return value.clone();
    };
    let allowed: &[&str] = match map.get("state").and_then(|state| state.as_str()) {
        Some("needs_you") => &["state", "interactions"],
        Some("working") => &["state", "agents"],
        Some("waiting") => &[
            "state",
            "on",
            "slotLimit",
            "slotsInUse",
            "queuePosition",
            "waitingFor",
        ],
        Some("limited") => &["state", "until"],
        Some("failed" | "unresponsive" | "done" | "new") => &["state"],
        Some("moved") => {
            let mut stripped = strip_object(value, &["state", "to"], removed);
            if let Json::Object(stripped) = &mut stripped
                && let Some(to) = stripped.get("to").cloned()
            {
                stripped.insert(
                    "to".to_owned(),
                    strip_object(&to, &["hostId", "name", "threadId"], removed),
                );
            }
            return stripped;
        }
        Some("unknown") => return value.clone(),
        _ => return value.clone(),
    };
    strip_object(value, allowed, removed)
}

fn strip_outcomes(value: &Json, removed: &mut bool) -> Json {
    match value {
        Json::Array(outcomes) => Json::Array(
            outcomes
                .iter()
                .map(|outcome| strip_outcome(outcome, removed))
                .collect(),
        ),
        _ => value.clone(),
    }
}

fn strip_outcome(value: &Json, removed: &mut bool) -> Json {
    let mut stripped = strip_object(
        value,
        &[
            "failure",
            "threadId",
            "outcome",
            "result",
            "truncated",
            "before",
        ],
        removed,
    );
    if let Json::Object(stripped) = &mut stripped
        && let Some(failure) = stripped.get("failure").cloned()
    {
        stripped.insert(
            "failure".to_owned(),
            strip_object(
                &failure,
                &["code", "message", "accountId", "accountLabel", "resetsAt"],
                removed,
            ),
        );
    }
    stripped
}

fn strip_machine(value: &Json, removed: &mut bool) -> Json {
    strip_object(value, &["machine", "name", "hostId", "contact"], removed)
}

fn strip_html_visualization(value: &Json, removed: &mut bool) -> Json {
    let mut stripped = strip_object(
        value,
        &["title", "document", "height", "mode", "kit"],
        removed,
    );
    if let Json::Object(stripped) = &mut stripped
        && let Some(document) = stripped.get("document").cloned()
    {
        stripped.insert("document".to_owned(), strip_attachment(&document, removed));
    }
    stripped
}

fn strip_screen_input(value: &Json, removed: &mut bool) -> Json {
    let Some(map) = as_map(value) else {
        return value.clone();
    };
    let allowed: &[&str] = match map.get("kind").and_then(|kind| kind.as_str()) {
        Some("pointer.move") => &["kind", "x", "y"],
        Some("pointer.click") => &["kind", "x", "y", "button"],
        Some("pointer.drag") => &["kind", "durationMs", "x", "y", "toX", "toY", "button"],
        Some("key.press") => &["kind", "key", "modifiers"],
        Some("text.type") => &["kind", "text"],
        Some("scroll") => &["kind", "x", "y", "dx", "dy"],
        Some("text.paste") => &["kind", "text"],
        Some("pointer.down" | "pointer.up") => &["kind", "x", "y"],
        Some("pointer.cancel") => &["kind"],
        _ => return value.clone(),
    };
    strip_object(value, allowed, removed)
}

fn strip_browser_action(value: &Json, _removed: &mut bool) -> Json {
    // `strictObject` variants: never strip; the TypeScript throws instead.
    value.clone()
}

fn strip_interaction_target(value: &Json, removed: &mut bool) -> Json {
    let Some(map) = as_map(value) else {
        return value.clone();
    };
    match map.get("kind").and_then(|kind| kind.as_str()) {
        Some("window") => strip_object(value, &["kind", "bundleId", "windowId"], removed),
        Some("browser-tab") => strip_object(value, &["kind", "threadId", "tabId"], removed),
        _ => value.clone(),
    }
}

fn strip_metric_summary(value: &Json, removed: &mut bool) -> Json {
    strip_object(value, &["median", "worst"], removed)
}

fn strip_interaction_gap(value: &Json, removed: &mut bool) -> Json {
    strip_object(value, &["atMs", "durationMs"], removed)
}

fn strip_measurement(value: &Json, removed: &mut bool) -> Json {
    let mut stripped = strip_object(
        value,
        &[
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
        ],
        removed,
    );
    if let Json::Object(stripped) = &mut stripped {
        for key in ["target", "action"] {
            if let Some(part) = stripped.get(key).cloned() {
                let cleaned = if key == "target" {
                    strip_interaction_target(&part, removed)
                } else if as_map(&part).and_then(|map| map.get("action")).is_some() {
                    strip_browser_action(&part, removed)
                } else {
                    strip_screen_input(&part, removed)
                };
                stripped.insert(key.to_owned(), cleaned);
            }
        }
        if let Some(filmstrip) = stripped.get("filmstrip").cloned() {
            stripped.insert(
                "filmstrip".to_owned(),
                strip_attachment(&filmstrip, removed),
            );
        }
        if let Some(repeat) = stripped.get("repeat").cloned() {
            stripped.insert("repeat".to_owned(), strip_repeat(&repeat, removed));
        }
        for key in ["hitches", "longTasks"] {
            if let Some(Json::Array(gaps)) = stripped.get(key).cloned() {
                stripped.insert(
                    key.to_owned(),
                    Json::Array(
                        gaps.iter()
                            .map(|gap| strip_interaction_gap(gap, removed))
                            .collect(),
                    ),
                );
            }
        }
    }
    stripped
}

fn strip_repeat(value: &Json, removed: &mut bool) -> Json {
    let mut stripped = strip_object(value, &["runs", "metrics"], removed);
    if let Json::Object(stripped) = &mut stripped {
        if let Some(Json::Array(runs)) = stripped.get("runs").cloned() {
            stripped.insert(
                "runs".to_owned(),
                Json::Array(
                    runs.iter()
                        .map(|run| strip_object(run, &["verdict", "confidence"], removed))
                        .collect(),
                ),
            );
        }
        if let Some(metrics) = stripped.get("metrics").cloned() {
            stripped.insert("metrics".to_owned(), strip_metrics(&metrics, removed));
        }
    }
    stripped
}

fn strip_metrics(value: &Json, removed: &mut bool) -> Json {
    let mut stripped = strip_object(
        value,
        &[
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
        ],
        removed,
    );
    if let Json::Object(stripped) = &mut stripped {
        for key in [
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
        ] {
            if let Some(metric) = stripped.get(key).cloned() {
                stripped.insert(key.to_owned(), strip_metric_summary(&metric, removed));
            }
        }
    }
    stripped
}
