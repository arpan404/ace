// SPDX-License-Identifier: Apache-2.0
//! Interaction requests and resolutions (the port of `interactions.ts`).

use ace_json::{Map, Value};

use super::json::{list, object, str_of};

fn approval_target(name: &str, input: &Value, command: &Value, access: &str) -> Option<Value> {
    if name.is_empty() || name.chars().count() > 256 {
        return None;
    }
    if let Some(cmd) = match command {
        Value::Null => None,
        Value::String(s) => {
            if s.chars().count() > 32768 {
                return None;
            }
            Some(Value::String(s.clone()))
        }
        _ => return None,
    } {
        let _ = cmd;
    }
    let mut map = Map::with_capacity(5);
    map.insert("tool".to_owned(), Value::from(name.to_owned()));
    if let Value::String(cmd) = command {
        map.insert("command".to_owned(), Value::String(cmd.clone()));
    }
    // paths: the caller passes a single path string, if any.
    map.insert("access".to_owned(), Value::from(access.to_owned()));
    map.insert("input".to_owned(), input.clone());
    // Rebuild in schema order: tool, origin?, description?, riskClass?,
    // command?, cwd?, paths?, access, input. Only present keys survive.
    let mut ordered = Map::with_capacity(map.len());
    for key in [
        "tool",
        "origin",
        "description",
        "riskClass",
        "command",
        "cwd",
        "paths",
        "access",
        "input",
    ] {
        if let Some(v) = map.remove(key) {
            ordered.insert(key.to_owned(), v);
        }
    }
    Some(Value::Object(ordered))
}

fn approval_target_with_path(
    name: &str,
    input: &Value,
    command: &Value,
    path: Option<String>,
    access: &str,
) -> Option<Value> {
    let mut base = match approval_target(name, input, command, access) {
        Some(Value::Object(m)) => m,
        _ => return None,
    };
    if let Some(p) = path {
        // `ApprovalTarget.paths` is a patched-zod `.max(4096)`: code points.
        if p.is_empty() || p.chars().count() > 4096 {
            return None;
        }
        // Insert paths before access to keep schema order on rebuild.
        base.insert("paths".to_owned(), Value::from(vec![Value::from(p)]));
        let mut ordered = Map::with_capacity(base.len());
        for key in [
            "tool",
            "origin",
            "description",
            "riskClass",
            "command",
            "cwd",
            "paths",
            "access",
            "input",
        ] {
            if let Some(v) = base.remove(key) {
                ordered.insert(key.to_owned(), v);
            }
        }
        return Some(Value::Object(ordered));
    }
    Some(Value::Object(base))
}

fn mcp_server(value: &Value) -> Option<Value> {
    let obj = object(value);
    match (obj.get("name"), obj.get("source")) {
        (Some(Value::String(name)), Some(Value::String(source))) => {
            // passthrough: keep the whole object, including unknown fields.
            let mut map = Map::with_capacity(obj.len());
            for (k, v) in obj {
                map.insert(k.clone(), v.clone());
            }
            let _ = (name, source);
            Some(Value::Object(map))
        }
        _ => None,
    }
}

/// The interaction request for a permission tool call.
pub fn request_for(name: &str, input: &Value, options: &Value) -> Value {
    let input_obj = object(input);
    let options_obj = object(options);
    if name == "AskUserQuestion" {
        let mut questions = Vec::new();
        for value in list(input_obj.get("questions").unwrap_or(&Value::Null)) {
            let q = object(value);
            let text = str_of(q.get("question").unwrap_or(&Value::Null));
            let mut qmap = Map::with_capacity(7);
            qmap.insert("id".to_owned(), Value::from(text.clone()));
            qmap.insert("text".to_owned(), Value::from(text));
            qmap.insert(
                "multiSelect".to_owned(),
                Value::Bool(q.get("multiSelect") == Some(&Value::Bool(true))),
            );
            qmap.insert("allowOther".to_owned(), Value::Bool(true));
            qmap.insert("secret".to_owned(), Value::Bool(false));
            let mut opts = Vec::new();
            for option in list(q.get("options").unwrap_or(&Value::Null)) {
                let o = object(option);
                let label = str_of(o.get("label").unwrap_or(&Value::Null));
                let mut omap = Map::with_capacity(3);
                omap.insert("id".to_owned(), Value::from(label.clone()));
                omap.insert("label".to_owned(), Value::from(label));
                if let Some(Value::String(d)) = o.get("description") {
                    omap.insert("description".to_owned(), Value::String(d.clone()));
                }
                opts.push(Value::Object(omap));
            }
            qmap.insert("options".to_owned(), Value::from(opts));
            if let Some(Value::String(h)) = q.get("header") {
                qmap.insert("header".to_owned(), Value::String(h.clone()));
            }
            questions.push(Value::Object(qmap));
        }
        let mut map = Map::with_capacity(3);
        map.insert("kind".to_owned(), Value::from("question".to_owned()));
        map.insert("questions".to_owned(), Value::from(questions));
        return Value::Object(map);
    }
    if name == "ExitPlanMode" {
        let mut map = Map::with_capacity(4);
        map.insert("kind".to_owned(), Value::from("plan_review".to_owned()));
        map.insert(
            "markdown".to_owned(),
            Value::from(str_of(input_obj.get("plan").unwrap_or(&Value::Null))),
        );
        if let Some(Value::String(p)) = input_obj.get("planFilePath") {
            map.insert("planPath".to_owned(), Value::String(p.clone()));
        }
        return Value::Object(map);
    }
    let suggestions = list(options_obj.get("suggestions").unwrap_or(&Value::Null));
    // First-seen destination order, like the TypeScript Set spread
    // (missing destinations read as "" and fail the grant check there).
    let mut destinations: Vec<String> = Vec::new();
    for value in suggestions {
        let d = str_of(object(value).get("destination").unwrap_or(&Value::Null));
        if !destinations.contains(&d) {
            destinations.push(d);
        }
    }
    let known = [
        "session",
        "cliArg",
        "userSettings",
        "projectSettings",
        "localSettings",
    ];
    let labels = [
        ("session", "this session"),
        ("cliArg", "this invocation"),
        ("userSettings", "user settings"),
        ("projectSettings", "project settings"),
        ("localSettings", "local project settings"),
    ];
    let grant = !suggestions.is_empty()
        && options_obj.get("suppressAlwaysAllowRule") != Some(&Value::Bool(true))
        && destinations.iter().all(|d| known.contains(&d.as_str()));
    let target = {
        let path = input_obj
            .get("file_path")
            .or_else(|| input_obj.get("path"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_owned());
        let access = if ["Read", "Glob", "Grep"].contains(&name) {
            "read"
        } else if ["Edit", "Write", "NotebookEdit"].contains(&name) {
            "write"
        } else if name == "Bash" {
            "execute"
        } else {
            "unknown"
        };
        approval_target_with_path(
            name,
            input,
            input_obj.get("command").unwrap_or(&Value::Null),
            path,
            access,
        )
    };
    let title = {
        let t = str_of(options_obj.get("title").unwrap_or(&Value::Null));
        if !t.is_empty() {
            t
        } else {
            let d = str_of(options_obj.get("displayName").unwrap_or(&Value::Null));
            if !d.is_empty() { d } else { name.to_owned() }
        }
    };
    let mut map = Map::with_capacity(9);
    map.insert("kind".to_owned(), Value::from("approval".to_owned()));
    map.insert("title".to_owned(), Value::from(title));
    if let Some(t) = target {
        map.insert("target".to_owned(), t);
    }
    if let Some(Value::String(d)) = options_obj.get("description") {
        map.insert("description".to_owned(), Value::String(d.clone()));
    } else if let Some(Value::String(d)) = options_obj.get("decisionReason") {
        map.insert("description".to_owned(), Value::String(d.clone()));
    }
    if let Some(Value::Bool(b)) = options_obj.get("defaultToNo") {
        map.insert("defaultToNo".to_owned(), Value::Bool(*b));
    }
    if let Some(Value::Bool(b)) = options_obj.get("suppressAlwaysAllowRule") {
        map.insert("suppressAlwaysAllowRule".to_owned(), Value::Bool(*b));
    }
    if let Some(mcp) = options_obj.get("mcpServer").and_then(mcp_server) {
        map.insert("mcpServer".to_owned(), mcp);
    }
    map.insert(
        "permissionUpdates".to_owned(),
        Value::from(suggestions.to_vec()),
    );
    let mut opts = vec![
        option_value("allow_once", "Allow once", "allow_once"),
        option_value("deny", "Deny", "deny"),
    ];
    if grant {
        let label = format!(
            "Allow and update {}",
            destinations
                .iter()
                .map(|d| labels
                    .iter()
                    .find(|(k, _)| k == d)
                    .map(|(_, v)| *v)
                    .unwrap_or(d.as_str()))
                .collect::<Vec<_>>()
                .join(" and ")
        );
        let kind = if destinations.len() == 1 && destinations.contains(&"session".to_owned()) {
            "allow_session"
        } else {
            "allow_always"
        };
        opts.push(option_value("allow_updates", &label, kind));
    }
    map.insert("options".to_owned(), Value::from(opts));
    // TypeScript order: kind, title, target?, description?, defaultToNo?,
    // suppressAlwaysAllowRule?, mcpServer?, permissionUpdates, options.
    // Insertion above already follows it.
    Value::Object(map)
}

fn option_value(id: &str, label: &str, kind: &str) -> Value {
    let mut map = Map::with_capacity(3);
    map.insert("id".to_owned(), Value::from(id.to_owned()));
    map.insert("label".to_owned(), Value::from(label.to_owned()));
    map.insert("kind".to_owned(), Value::from(kind.to_owned()));
    Value::Object(map)
}

#[cfg(test)]
mod length_tests {
    use super::request_for;
    use ace_json::Value;

    #[test]
    fn an_approval_path_counts_code_points_like_approval_target_paths() {
        for length in [2000, 4096, 4097] {
            let input = ace_json::json!({"file_path": "😀".repeat(length)});
            let request = request_for("Edit", &input, &Value::Null);
            let paths = request.pointer("/target/paths");
            assert_eq!(paths.is_some(), length <= 4096, "{length}");
            if let Some(Value::Array(paths)) = paths {
                assert_eq!(paths.len(), 1);
                assert_eq!(paths[0], input.get("file_path").cloned().unwrap());
            }
        }
    }
}
