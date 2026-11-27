// SPDX-License-Identifier: Apache-2.0
//! Tool calls and message parts re-encoded in the schema's order.
//!
//! Each shape lists its fields in the schema's order; an unknown discriminator
//! fails the read, as the loader's schema does. Values splice verbatim.

use super::super::common::{LongError, invalid};
use super::item_kinds::normalize_source;
use super::item_norm::{Out, opt_field, req, req_str};

/// One message part, reordered by its type. Unknown parts fail the read.
pub(super) fn normalize_part(raw: &serde_json::value::RawValue) -> Result<String, LongError> {
    let kind: std::borrow::Cow<'_, str> = req_str(raw, "type")?;
    let mut out = Out::new(512);
    out.begin();
    match &*kind {
        "text" => {
            out.field("type", req(raw, "type")?.get());
            out.field("text", req(raw, "text")?.get());
            if let Some(source) = opt_field(raw, "source")? {
                out.field("source", &normalize_source(source)?);
            }
        }
        "image" => {
            out.field("type", req(raw, "type")?.get());
            out.field("mimeType", req(raw, "mimeType")?.get());
            out.field("url", req(raw, "url")?.get());
        }
        "file" => {
            out.field("type", req(raw, "type")?.get());
            out.field("path", req(raw, "path")?.get());
            for key in ["mimeType", "name", "content"] {
                if let Some(value) = opt_field(raw, key)? {
                    out.field(key, value.get());
                }
            }
        }
        "mention" => {
            out.field("type", req(raw, "type")?.get());
            out.field("entryId", req(raw, "entryId")?.get());
            out.field("name", req(raw, "name")?.get());
            if let Some(title) = opt_field(raw, "title")? {
                out.field("title", title.get());
            }
            out.field("kind", req(raw, "kind")?.get());
            if let Some(icon) = opt_field(raw, "icon")? {
                out.field("icon", icon.get());
            }
            match opt_field(raw, "arguments")? {
                None => out.field("arguments", "\"\""),
                Some(arguments) => out.field("arguments", arguments.get()),
            }
            for key in ["values", "invocation"] {
                if let Some(value) = opt_field(raw, key)? {
                    out.field(key, value.get());
                }
            }
        }
        _ => return Err(invalid("invalid index row")),
    }
    out.end();
    Ok(out.finish())
}

/// A tool call detail, reordered by its kind. Unknown kinds fail the read.
fn normalize_detail(raw: &serde_json::value::RawValue) -> Result<String, LongError> {
    let kind: std::borrow::Cow<'_, str> = req_str(raw, "kind")?;
    let mut out = Out::new(512);
    out.begin();
    match &*kind {
        "shell" => {
            out.field("kind", req(raw, "kind")?.get());
            out.field("command", req(raw, "command")?.get());
            for key in ["rawCommand", "cwd", "exitCode", "output"] {
                if let Some(value) = opt_field(raw, key)? {
                    out.field(key, value.get());
                }
            }
        }
        "file.read" => {
            out.field("kind", req(raw, "kind")?.get());
            out.field("path", req(raw, "path")?.get());
            if let Some(range) = opt_field(raw, "range")? {
                out.field("range", range.get());
            }
        }
        "file.edit" | "file.write" | "file.delete" | "file.move" => {
            out.field("kind", req(raw, "kind")?.get());
            out.field("changes", req(raw, "changes")?.get());
        }
        "search" => {
            out.field("kind", req(raw, "kind")?.get());
            out.field("query", req(raw, "query")?.get());
            for key in ["path", "matches", "scope"] {
                if let Some(value) = opt_field(raw, key)? {
                    out.field(key, value.get());
                }
            }
        }
        "web.search" => {
            out.field("kind", req(raw, "kind")?.get());
            out.field("query", req(raw, "query")?.get());
        }
        "web.fetch" => {
            out.field("kind", req(raw, "kind")?.get());
            out.field("url", req(raw, "url")?.get());
        }
        "mcp" => {
            out.field("kind", req(raw, "kind")?.get());
            out.field("server", req(raw, "server")?.get());
            out.field("tool", req(raw, "tool")?.get());
            if let Some(arguments) = opt_field(raw, "arguments")? {
                out.field("arguments", arguments.get());
            }
        }
        "agent.spawn" => {
            out.field("kind", req(raw, "kind")?.get());
            for key in ["description", "prompt", "agentType", "childAgentId"] {
                if let Some(value) = opt_field(raw, key)? {
                    out.field(key, value.get());
                }
            }
        }
        "agent.message" => {
            out.field("kind", req(raw, "kind")?.get());
            for key in ["targetAgentId", "message"] {
                if let Some(value) = opt_field(raw, key)? {
                    out.field(key, value.get());
                }
            }
        }
        "todo" => {
            out.field("kind", req(raw, "kind")?.get());
            out.field("todos", req(raw, "todos")?.get());
        }
        "plan" => {
            out.field("kind", req(raw, "kind")?.get());
            for key in ["markdown", "todos"] {
                if let Some(value) = opt_field(raw, key)? {
                    out.field(key, value.get());
                }
            }
        }
        "ask_user" => {
            out.field("kind", req(raw, "kind")?.get());
        }
        "image" => {
            out.field("kind", req(raw, "kind")?.get());
            for key in ["path", "sourcePath", "attachment", "unavailable"] {
                if let Some(value) = opt_field(raw, key)? {
                    out.field(key, value.get());
                }
            }
        }
        "browser" | "notebook" | "custom" => {
            out.field("kind", req(raw, "kind")?.get());
        }
        _ => return Err(invalid("invalid index row")),
    }
    out.end();
    Ok(out.finish())
}

/// A tool call, in the schema's order.
fn normalize_call(raw: &serde_json::value::RawValue) -> Result<String, LongError> {
    let mut out = Out::new(1024);
    out.begin();
    for key in ["id", "agentId", "kind", "title", "status"] {
        out.field(key, req(raw, key)?.get());
    }
    out.field("detail", &normalize_detail(req(raw, "detail")?)?);
    for key in [
        "backgroundTaskId",
        "error",
        "result",
        "startedAt",
        "endedAt",
        "raw",
    ] {
        if key == "raw" {
            match opt_field(raw, key)? {
                None => out.field("raw", "[]"),
                Some(value) => out.field("raw", value.get()),
            }
        } else if let Some(value) = opt_field(raw, key)? {
            out.field(key, value.get());
        }
    }
    out.end();
    Ok(out.finish())
}

/// A `tool_call` item, in the schema's order.
pub(super) fn normalize_tool_call(root: &serde_json::value::RawValue) -> Result<String, LongError> {
    let mut out = Out::new(2048);
    out.begin();
    super::item_kinds::base_into(&mut out, root, true)?;
    out.field("type", req(root, "type")?.get());
    out.field("call", &normalize_call(req(root, "call")?)?);
    if let Some(measurement) = opt_field(root, "measurement")? {
        out.field("measurement", measurement.get());
    }
    out.end();
    Ok(out.finish())
}
