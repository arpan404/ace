// SPDX-License-Identifier: Apache-2.0
//! Approval targets (`packages/adapter-opencode/src/approval-target.ts`).
//! Permission resources and save patterns are never authority: only exact
//! native inputs and edit file metadata are.

use crate::translate::data::{arr, fields, get, utf16_len};
use ace_json::{JsString, Map, Value};
use serde::Serialize;

/// The exact input an approval decides on: a value, or a whole metadata map.
pub enum ApprovalInput<'a> {
    Value(&'a Value),
    Map(&'a Map),
}

impl Serialize for ApprovalInput<'_> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            ApprovalInput::Value(value) => value.serialize(serializer),
            ApprovalInput::Map(map) => map.serialize(serializer),
        }
    }
}

/// An exact provider input the approval decides on.
pub struct ApprovalTarget<'a> {
    tool: &'a str,
    cwd: Option<&'a str>,
    command: Option<&'a str>,
    paths: Option<Vec<&'a JsString>>,
    access: &'static str,
    input: ApprovalInput<'a>,
    /// Whether the TypeScript built the target as a literal (the edit branch) rather than
    /// through `ApprovalTarget.safeParse`, which emits the schema's key order.
    literal: bool,
}

impl Serialize for ApprovalTarget<'_> {
    /// The TypeScript's key order: the edit branch's literal is `tool, cwd, access, paths,
    /// input`; zod's parse of the schema is `tool, command, cwd, paths, access, input`.
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut map = serializer.serialize_map(None)?;
        map.serialize_entry("tool", self.tool)?;
        if self.literal {
            if let Some(cwd) = self.cwd {
                map.serialize_entry("cwd", cwd)?;
            }
            map.serialize_entry("access", self.access)?;
            if let Some(paths) = &self.paths {
                map.serialize_entry("paths", paths)?;
            }
        } else {
            if let Some(command) = self.command {
                map.serialize_entry("command", command)?;
            }
            if let Some(cwd) = self.cwd {
                map.serialize_entry("cwd", cwd)?;
            }
            if let Some(paths) = &self.paths {
                map.serialize_entry("paths", paths)?;
            }
            map.serialize_entry("access", self.access)?;
        }
        map.serialize_entry("input", &self.input)?;
        map.end()
    }
}

fn units(text: &str) -> usize {
    utf16_len(text)
}

fn units_js(text: &JsString) -> usize {
    text.len_utf16()
}

/// The files OpenCode reports an edit over, each named with its own patch
/// status (`files` in TypeScript).
fn edit_files(value: &Value) -> Option<Vec<&JsString>> {
    let files = arr(value);
    if files.is_empty() || files.len() > 128 {
        return None;
    }
    let mut paths = Vec::with_capacity(files.len());
    for file in files {
        if !matches!(file, Value::Object(_)) {
            return None;
        }
        let entry = fields(file);
        match (entry.get("file"), entry.get("status")) {
            (Some(Value::String(path)), Some(Value::String(status)))
                if !path.is_empty()
                    && units_js(path) <= 4096
                    && (status == "modified" || status == "added") =>
            {
                // Keep the exact JS string: a lone surrogate path must not
                // become U+FFFD the way `as_str` would.
                paths.push(path);
            }
            _ => return None,
        }
    }
    Some(paths)
}

/// Build the approval's target from edit metadata or exact native input, or
/// nothing when neither parses the way `ApprovalTarget.safeParse` requires.
pub fn approval_target<'a>(
    action: &'a str,
    metadata: &'a Map,
    native_input: Option<&'a Value>,
    directory: Option<&'a str>,
) -> Option<ApprovalTarget<'a>> {
    if action == "edit" && metadata.contains_key("files") {
        let paths = edit_files(get(metadata, "files"))?;
        return Some(ApprovalTarget {
            tool: "edit",
            cwd: directory,
            command: None,
            paths: Some(paths),
            access: "write",
            input: ApprovalInput::Map(metadata),
            literal: true,
        });
    }
    // The metadata's own input when present (even null), else the tool's.
    let input_value = match metadata.get("input") {
        Some(input) => input,
        None => native_input?,
    };
    let input = fields(input_value);
    if !matches!(input_value, Value::Object(_)) || input.is_empty() {
        return None;
    }
    if action.is_empty() || units(action) > 256 {
        return None;
    }
    let path: Option<&JsString> = match input.get("path").or_else(|| input.get("filePath")) {
        Some(Value::String(path)) if !path.is_empty() => Some(path),
        _ => None,
    };
    if let Some(path) = path
        && units_js(path) > 4096
    {
        return None;
    }
    let cwd = match input.get("workdir").or_else(|| input.get("cwd")) {
        Some(Value::String(cwd)) => Some(cwd.as_str()),
        _ => directory,
    };
    if let Some(cwd) = cwd
        && units(cwd) > 4096
    {
        return None;
    }
    let command = if action == "shell" || action == "bash" {
        match input.get("command") {
            Some(Value::String(command)) => {
                if units_js(command) > 32768 {
                    return None;
                }
                Some(command.as_str())
            }
            _ => None,
        }
    } else {
        None
    };
    Some(ApprovalTarget {
        tool: action,
        cwd,
        command,
        paths: path.map(|path| vec![path]),
        access: if action == "read" {
            "read"
        } else if action == "edit" || action == "write" {
            "write"
        } else if action == "shell" || action == "bash" {
            "execute"
        } else {
            "unknown"
        },
        input: ApprovalInput::Value(input_value),
        literal: false,
    })
}
