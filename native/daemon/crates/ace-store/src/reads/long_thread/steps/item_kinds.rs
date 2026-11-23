// SPDX-License-Identifier: Apache-2.0
//! Message-family items re-encoded in the schema's order.
//!
//! Each variant lists its fields in the schema's order; unknown keys fail the
//! read, as the loader's schema does. Values splice verbatim.

use super::super::common::{LongError, invalid};
use super::item_call::normalize_part;
use super::item_norm::{Out, opt_field, req, req_bool};

pub(super) fn base_into(
    out: &mut Out,
    root: &serde_json::value::RawValue,
    agent_required: bool,
) -> Result<(), LongError> {
    out.field("id", req(root, "id")?.get());
    if agent_required {
        out.field("agentId", req(root, "agentId")?.get());
    } else if let Some(agent) = opt_field(root, "agentId")? {
        out.field("agentId", agent.get());
    }
    if let Some(run) = opt_field(root, "runId")? {
        out.field("runId", run.get());
    }
    out.field("createdAt", req(root, "createdAt")?.get());
    if let Some(native) = opt_field(root, "nativeId")? {
        out.field("nativeId", native.get());
    }
    if let Some(source) = opt_field(root, "executionSource")? {
        out.field("executionSource", source.get());
    }
    out.field(
        "complete",
        if req_bool(root, "complete", true)? {
            "true"
        } else {
            "false"
        },
    );
    if let Some(inherited) = opt_field(root, "inherited")? {
        out.field("inherited", inherited.get());
    }
    if let Some(omitted) = opt_field(root, "rawOmitted")? {
        out.field("rawOmitted", omitted.get());
    }
    Ok(())
}

fn raw_defaulted(out: &mut Out, root: &serde_json::value::RawValue) -> Result<(), LongError> {
    match opt_field(root, "raw")? {
        None => out.field("raw", "[]"),
        Some(raw) => out.field("raw", raw.get()),
    }
    Ok(())
}

fn source_into(out: &mut Out, root: &serde_json::value::RawValue) -> Result<(), LongError> {
    if let Some(source) = opt_field(root, "source")? {
        out.field("source", &normalize_source(source)?);
    }
    Ok(())
}

pub(super) fn normalize_source(raw: &serde_json::value::RawValue) -> Result<String, LongError> {
    let mut out = Out::new(128);
    out.begin();
    out.field("streamId", req(raw, "streamId")?.get());
    out.field("bytes", req(raw, "bytes")?.get());
    out.field("encoding", req(raw, "encoding")?.get());
    if let Some(offset) = opt_field(raw, "offset")? {
        out.field("offset", offset.get());
    }
    out.end();
    Ok(out.finish())
}

fn parts_into(out: &mut Out, root: &serde_json::value::RawValue) -> Result<(), LongError> {
    let parts = req(root, "parts")?;
    let text = parts.get();
    let bytes = text.as_bytes();
    let mut pos = super::span::skip_ws(bytes, 0).ok_or_else(|| invalid("invalid index row"))?;
    if bytes.get(pos) != Some(&b'[') {
        return Err(invalid("invalid index row"));
    }
    pos += 1;
    let mut items = Vec::new();
    loop {
        pos = super::span::skip_ws(bytes, pos).ok_or_else(|| invalid("invalid index row"))?;
        match bytes.get(pos) {
            None => return Err(invalid("invalid index row")),
            Some(b']') => {
                pos += 1;
                break;
            }
            Some(_) => {}
        }
        let end =
            super::span::skip_value(bytes, pos).ok_or_else(|| invalid("invalid index row"))?;
        let span = text
            .get(pos..end)
            .ok_or_else(|| invalid("invalid index row"))?;
        let raw: &serde_json::value::RawValue =
            serde_json::from_str(span).map_err(|_| invalid("invalid index row"))?;
        items.push(normalize_part(raw)?);
        pos = super::span::skip_ws(bytes, end).ok_or_else(|| invalid("invalid index row"))?;
        match bytes.get(pos) {
            Some(b',') => pos += 1,
            Some(b']') => continue,
            _ => return Err(invalid("invalid index row")),
        }
    }
    let _ = pos;
    let mut joined = String::with_capacity(text.len());
    joined.push('[');
    for (index, item) in items.iter().enumerate() {
        if index > 0 {
            joined.push(',');
        }
        joined.push_str(item);
    }
    joined.push(']');
    out.field("parts", &joined);
    Ok(())
}

pub(super) fn normalize_message(root: &serde_json::value::RawValue) -> Result<String, LongError> {
    let mut out = Out::new(4096);
    out.begin();
    base_into(&mut out, root, true)?;
    out.field("type", req(root, "type")?.get());
    out.field("role", req(root, "role")?.get());
    parts_into(&mut out, root)?;
    if let Some(attachments) = opt_field(root, "attachments")? {
        out.field("attachments", attachments.get());
    }
    out.field(
        "synthetic",
        if req_bool(root, "synthetic", false)? {
            "true"
        } else {
            "false"
        },
    );
    for key in ["origin", "notAnswered", "mergedContext", "speaker"] {
        if let Some(value) = opt_field(root, key)? {
            out.field(key, value.get());
        }
    }
    raw_defaulted(&mut out, root)?;
    out.end();
    Ok(out.finish())
}

pub(super) fn normalize_notice(root: &serde_json::value::RawValue) -> Result<String, LongError> {
    let mut out = Out::new(2048);
    out.begin();
    base_into(&mut out, root, true)?;
    out.field("type", req(root, "type")?.get());
    out.field("level", req(root, "level")?.get());
    for key in [
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
    ] {
        if let Some(value) = opt_field(root, key)? {
            out.field(key, value.get());
        }
    }
    out.field("text", req(root, "text")?.get());
    source_into(&mut out, root)?;
    raw_defaulted(&mut out, root)?;
    out.end();
    Ok(out.finish())
}

pub(super) fn normalize_reasoning(root: &serde_json::value::RawValue) -> Result<String, LongError> {
    let mut out = Out::new(2048);
    out.begin();
    base_into(&mut out, root, true)?;
    out.field("type", req(root, "type")?.get());
    out.field("text", req(root, "text")?.get());
    source_into(&mut out, root)?;
    out.field(
        "summary",
        if req_bool(root, "summary", false)? {
            "true"
        } else {
            "false"
        },
    );
    raw_defaulted(&mut out, root)?;
    out.end();
    Ok(out.finish())
}

pub(super) fn normalize_delegation_started(
    root: &serde_json::value::RawValue,
) -> Result<String, LongError> {
    let mut out = Out::new(1024);
    out.begin();
    base_into(&mut out, root, true)?;
    out.field("type", req(root, "type")?.get());
    for key in ["origin", "childThreadId", "provider"] {
        out.field(key, req(root, key)?.get());
    }
    for key in ["model", "accountId"] {
        if let Some(value) = opt_field(root, key)? {
            out.field(key, value.get());
        }
    }
    for key in [
        "title",
        "role",
        "phase",
        "status",
        "updatedAt",
        "generation",
    ] {
        out.field(key, req(root, key)?.get());
    }
    match opt_field(root, "outcome")? {
        None => out.field("outcome", "null"),
        Some(outcome) => out.field("outcome", outcome.get()),
    }
    if let Some(machine) = opt_field(root, "machine")? {
        out.field("machine", machine.get());
    }
    raw_defaulted(&mut out, root)?;
    out.end();
    Ok(out.finish())
}

pub(super) fn normalize_delegation_settled(
    root: &serde_json::value::RawValue,
) -> Result<String, LongError> {
    let mut out = Out::new(1024);
    out.begin();
    base_into(&mut out, root, true)?;
    out.field("type", req(root, "type")?.get());
    out.field("origin", req(root, "origin")?.get());
    out.field("results", req(root, "results")?.get());
    out.field("delivery", req(root, "delivery")?.get());
    raw_defaulted(&mut out, root)?;
    out.end();
    Ok(out.finish())
}

pub(super) fn normalize_compaction(
    root: &serde_json::value::RawValue,
) -> Result<String, LongError> {
    let mut out = Out::new(1024);
    out.begin();
    base_into(&mut out, root, true)?;
    out.field("type", req(root, "type")?.get());
    for key in ["tokensBefore", "tokensAfter", "summary"] {
        if let Some(value) = opt_field(root, key)? {
            out.field(key, value.get());
        }
    }
    raw_defaulted(&mut out, root)?;
    out.end();
    Ok(out.finish())
}

pub(super) fn normalize_wrapped(
    root: &serde_json::value::RawValue,
    body: &str,
) -> Result<String, LongError> {
    let mut out = Out::new(1024);
    out.begin();
    base_into(&mut out, root, true)?;
    out.field("type", req(root, "type")?.get());
    out.field(body, req(root, body)?.get());
    raw_defaulted(&mut out, root)?;
    out.end();
    Ok(out.finish())
}

pub(super) fn normalize_artifact(root: &serde_json::value::RawValue) -> Result<String, LongError> {
    let mut out = Out::new(1024);
    out.begin();
    base_into(&mut out, root, false)?;
    out.field("type", req(root, "type")?.get());
    for key in ["filename", "flags"] {
        if let Some(value) = opt_field(root, key)? {
            out.field(key, value.get());
        }
    }
    out.field("source", req(root, "source")?.get());
    for key in ["artifactId", "path", "mimeType", "bytes"] {
        out.field(key, req(root, key)?.get());
    }
    out.end();
    Ok(out.finish())
}

pub(super) fn normalize_unknown(root: &serde_json::value::RawValue) -> Result<String, LongError> {
    let mut out = Out::new(1024);
    out.begin();
    base_into(&mut out, root, true)?;
    out.field("type", "\"unknown\"");
    raw_defaulted(&mut out, root)?;
    out.field("data", root.get());
    out.end();
    Ok(out.finish())
}
