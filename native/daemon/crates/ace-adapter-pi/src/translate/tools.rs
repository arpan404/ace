// SPDX-License-Identifier: Apache-2.0
//! Pi tool details, mirroring `tools.ts`. Reads borrow `&Raw`; tool
//! results stream through `result_suffix` without joining historical prefixes.

use super::native::{
    bare_tool_name, field, parse_array, parse_object, str_field, utf16_len, utf16_slice,
    utf16_to_byte_index,
};
use ace_json::Raw;
use serde::Serialize;
use std::collections::HashMap;

const MAX_PATCH: usize = 1 << 20;

/// The tool detail draft the translator embeds in a `tool_call` fact.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind")]
pub enum ToolDetail {
    #[serde(rename = "shell")]
    Shell { command: String },
    #[serde(rename = "file.read")]
    FileRead { path: String },
    #[serde(rename = "file.write")]
    FileWrite { changes: Vec<FileChange> },
    #[serde(rename = "file.edit")]
    FileEdit { changes: Vec<FileChange> },
    #[serde(rename = "search")]
    Search { query: String, path: String },
    #[serde(rename = "mcp")]
    Mcp {
        server: String,
        tool: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        arguments: Option<Raw>,
    },
    #[serde(rename = "custom")]
    Custom {},
}

/// One file change inside a read/write/edit detail.
#[derive(Debug, Clone, Serialize)]
pub struct FileChange {
    pub path: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "oldText")]
    pub old_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "newText")]
    pub new_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diff: Option<String>,
}

fn clone_raw(raw: &Raw) -> Option<Raw> {
    Some(raw.clone())
}

/// Build the detail for a tool start, mirroring `toolDetail`.
pub fn tool_detail(name: &str, args_raw: Option<&Raw>) -> ToolDetail {
    let args = match args_raw {
        Some(raw) => parse_object(raw).unwrap_or_default(),
        None => HashMap::new(),
    };
    if name == "bash" {
        return ToolDetail::Shell {
            command: str_field(&args, "command"),
        };
    }
    if name == "read" {
        return ToolDetail::FileRead {
            path: str_field(&args, "path"),
        };
    }
    if name == "write" {
        let path = str_field(&args, "path");
        let new_text = match field(&args, "content") {
            Some(raw) => super::native::raw_as_str(raw),
            None => None,
        };
        return ToolDetail::FileWrite {
            changes: vec![FileChange {
                path,
                kind: "add".to_owned(),
                old_text: None,
                new_text,
                diff: None,
            }],
        };
    }
    if name == "edit" {
        let changes = replacements(&args);
        return ToolDetail::FileEdit { changes };
    }
    if matches!(name, "grep" | "find" | "ls") {
        return ToolDetail::Search {
            query: str_field(&args, "pattern"),
            path: str_field(&args, "path"),
        };
    }
    if name.starts_with("ace_") {
        let tool = bare_tool_name(name).to_owned();
        let arguments = match args_raw {
            Some(raw) => clone_raw(raw),
            None => None,
        };
        return ToolDetail::Mcp {
            server: "ace".to_owned(),
            tool,
            arguments,
        };
    }
    ToolDetail::Custom {}
}

/// The text replacements of a Pi edit, mirroring `replacements`.
pub fn replacements(args: &super::native::Fields) -> Vec<FileChange> {
    let path = str_field(args, "path");
    let mut changes = Vec::new();
    if let Some(edits_raw) = field(args, "edits") {
        let items = parse_array(edits_raw).unwrap_or_default();
        for item in &items {
            let pair = parse_object(item).unwrap_or_default();
            push_replacement(&mut changes, &path, &pair);
        }
    }
    push_replacement(&mut changes, &path, args);
    if changes.is_empty() {
        changes.push(FileChange {
            path,
            kind: "update".to_owned(),
            old_text: None,
            new_text: None,
            diff: None,
        });
    }
    changes
}

fn push_replacement(out: &mut Vec<FileChange>, path: &str, pair: &super::native::Fields) {
    let old = match field(pair, "oldText") {
        Some(raw) => super::native::raw_as_str(raw),
        None => None,
    };
    let new = match field(pair, "newText") {
        Some(raw) => super::native::raw_as_str(raw),
        None => None,
    };
    if let (Some(old_text), Some(new_text)) = (old, new) {
        out.push(FileChange {
            path: path.to_owned(),
            kind: "update".to_owned(),
            old_text: Some(old_text),
            new_text: Some(new_text),
            diff: None,
        });
    }
}

/// A finished Pi edit's patch detail, mirroring `editResultDetail`.
pub fn edit_result_detail(
    name: &str,
    args_raw: Option<&Raw>,
    result_raw: Option<&Raw>,
) -> Option<ToolDetail> {
    if name != "edit" {
        return None;
    }
    let result = {
        let raw = result_raw?;
        parse_object(raw).unwrap_or_default()
    };
    let details_raw = field(&result, "details")?;
    let details = parse_object(details_raw).unwrap_or_default();
    let patch_raw = field(&details, "patch")?;
    let patch = super::native::raw_as_str(patch_raw)?;
    if patch.is_empty() || utf16_len(&patch) > MAX_PATCH {
        return None;
    }
    let args = match args_raw {
        Some(raw) => parse_object(raw).unwrap_or_default(),
        None => HashMap::new(),
    };
    let path = str_field(&args, "path");
    if path.is_empty() {
        return None;
    }
    Some(ToolDetail::FileEdit {
        changes: vec![FileChange {
            path,
            kind: "update".to_owned(),
            old_text: None,
            new_text: None,
            diff: Some(patch),
        }],
    })
}

/// Visit cumulative blocks without joining their historical prefix.
/// Mirrors `resultSuffix` in UTF-16 units, as JavaScript `length` does.
pub fn result_suffix(value: Option<&Raw>, seen: usize) -> (String, usize) {
    let mut append = String::new();
    let mut length = 0_usize;
    let mut first = true;
    let items: Vec<Raw> = match value {
        Some(raw) => {
            let obj = parse_object(raw).unwrap_or_default();
            match field(&obj, "content") {
                Some(content) => parse_array(content).unwrap_or_default(),
                None => Vec::new(),
            }
        }
        None => Vec::new(),
    };
    for item in &items {
        if !first {
            if length >= seen {
                append.push('\n');
            }
            length += 1;
        }
        first = false;
        let text = block_text(item);
        let text_units = utf16_len(&text);
        let end = length + text_units;
        if end > seen {
            let skip = seen.saturating_sub(length);
            let take = end.saturating_sub(seen.max(length));
            let start_byte = utf16_to_byte_index(&text, skip.min(text_units));
            let end_byte = utf16_to_byte_index(&text, (skip + take).min(text_units));
            if start_byte < end_byte {
                if let Some(part) = text.get(start_byte..end_byte) {
                    append.push_str(part);
                } else {
                    let fallback = utf16_slice(&text, skip, skip + take);
                    append.push_str(fallback);
                }
            }
        }
        length = end;
    }
    (append, length)
}

fn block_text(block_raw: &Raw) -> String {
    let block = parse_object(block_raw).unwrap_or_default();
    str_field(&block, "text")
}

/// The `kind` string for a tool detail, mirroring the TypeScript shape.
pub fn tool_kind(detail: &ToolDetail) -> String {
    match detail {
        ToolDetail::Shell { .. } => "shell".to_owned(),
        ToolDetail::FileRead { .. } => "file.read".to_owned(),
        ToolDetail::FileWrite { .. } => "file.write".to_owned(),
        ToolDetail::FileEdit { .. } => "file.edit".to_owned(),
        ToolDetail::Search { .. } => "search".to_owned(),
        ToolDetail::Mcp { .. } => "mcp".to_owned(),
        ToolDetail::Custom {} => "custom".to_owned(),
    }
}

/// Whether `result.details.aceMcp.isError` is true.
pub fn ace_mcp_error(map: &super::native::Fields) -> bool {
    let result_raw = match field(map, "result") {
        Some(raw) => raw,
        None => return false,
    };
    let result = parse_object(result_raw).unwrap_or_default();
    let details_raw = match field(&result, "details") {
        Some(raw) => raw,
        None => return false,
    };
    let details = parse_object(details_raw).unwrap_or_default();
    let ace_raw = match field(&details, "aceMcp") {
        Some(raw) => raw,
        None => return false,
    };
    let ace = parse_object(ace_raw).unwrap_or_default();
    super::native::bool_field(&ace, "isError").unwrap_or(false)
}

/// Whether `result.isError` is true.
pub fn result_is_error(map: &super::native::Fields) -> bool {
    let result_raw = match field(map, "result") {
        Some(raw) => raw,
        None => return false,
    };
    let result = parse_object(result_raw).unwrap_or_default();
    super::native::bool_field(&result, "isError").unwrap_or(false)
}

/// Join block texts with newlines, mirroring `resultText`.
pub fn result_text(value: Option<&Raw>) -> String {
    let items: Vec<Raw> = match value {
        Some(raw) => {
            let obj = parse_object(raw).unwrap_or_default();
            match field(&obj, "content") {
                Some(content) => parse_array(content).unwrap_or_default(),
                None => Vec::new(),
            }
        }
        None => Vec::new(),
    };
    let mut parts = Vec::new();
    for item in &items {
        parts.push(block_text(item));
    }
    parts.join("\n")
}
