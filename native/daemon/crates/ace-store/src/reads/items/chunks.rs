// SPDX-License-Identifier: Apache-2.0
use super::json::{J, encode_units, lossy};
use super::parse::parse_error;
use super::parse::parse_string;
use super::{ReadError, Result, Trust, trusted};

/// Whether the text carries its stream's end, so a delta extends it.
pub(crate) fn holds_tail(text: &[u16], source: Option<&J>) -> bool {
    let Some(source) = source else {
        return true;
    };
    let offset = source.get("offset").and_then(|offset| offset.as_int().ok());
    let bytes = source.get("bytes").and_then(|bytes| bytes.as_int().ok());
    match (offset, bytes) {
        (None, Some(bytes)) => text.len() as i64 * 2 == bytes,
        (Some(offset), Some(bytes)) => offset + text.len() as i64 * 2 == bytes,
        _ => false,
    }
}

pub(crate) fn append_text(target: &mut J, append: &[u16]) -> Result<()> {
    let J::Obj(_) = target else {
        return Err(parse_error());
    };
    let source = target.get("source").cloned();
    let holds = match target.get("text") {
        Some(J::Str(text)) => holds_tail(text, source.as_ref()),
        _ => false,
    };
    if holds {
        let mut text = match target.get("text") {
            Some(J::Str(text)) => text.clone(),
            _ => Vec::new(),
        };
        text.extend_from_slice(append);
        target.set("text", J::Str(text));
    }
    if let Some(mut source) = source
        && let J::Obj(_) = source
    {
        let bytes = source.get("bytes").and_then(|bytes| bytes.as_int().ok());
        if let Some(bytes) = bytes {
            source.set(
                "bytes",
                J::Num((bytes + append.len() as i64 * 2).to_string()),
            );
            target.set("source", source);
        }
    }
    Ok(())
}

/// `applyDelta`: text appends to text targets, without mutation for other fields.
pub(crate) fn apply_delta(item: &mut J, field: &str, append: &[u16]) -> Result<bool> {
    let item_type = item
        .get("type")
        .and_then(|kind| match kind {
            J::Str(units) => Some(lossy(units)),
            _ => None,
        })
        .ok_or_else(parse_error)?;
    if field == "output" {
        let shell = item_type == "tool_call"
            && item
                .get("call")
                .and_then(|call| call.get("detail"))
                .and_then(|detail| detail.get("kind"))
                .and_then(|kind| match kind {
                    J::Str(units) => Some(lossy(units)),
                    _ => None,
                })
                .as_deref()
                == Some("shell");
        return Ok(shell);
    }
    if item_type == "reasoning" || item_type == "notice" {
        append_text(item, append)?;
        return Ok(true);
    }
    if field == "text" && item_type == "message" {
        let parts = item.get_mut("parts").ok_or_else(parse_error)?;
        let J::Arr(parts) = parts else {
            return Err(parse_error());
        };
        let last_text = parts
            .iter_mut()
            .last()
            .filter(|part| {
                part.get("type").and_then(|kind| match kind {
                    J::Str(units) => Some(lossy(units)),
                    _ => None,
                }) == Some("text".to_owned())
            })
            .is_some();
        if last_text {
            let Some(J::Arr(parts)) = item.get_mut("parts") else {
                return Err(parse_error());
            };
            let Some(last) = parts.last_mut() else {
                return Err(parse_error());
            };
            append_text(last, append)?;
        } else {
            let Some(J::Arr(parts)) = item.get_mut("parts") else {
                return Err(parse_error());
            };
            let mut part = J::Obj(Vec::new());
            part.set("type", J::Str(encode_units("text")));
            part.set("text", J::Str(append.to_vec()));
            parts.push(part);
        }
        return Ok(true);
    }
    Ok(false)
}

/// An item's unmerged text chunks, in sequence order, applied.
pub(crate) fn with_chunks(
    item: &mut J,
    chunks: &[(i64, String, Vec<u16>)],
    trust: Trust,
) -> Result<()> {
    if chunks.is_empty() {
        return Ok(());
    }
    let trusted = chunks.iter().all(|(seq, _, _)| trusted(trust, *seq));
    let field = chunks
        .first()
        .map(|(_, field, _)| field.as_str())
        .ok_or_else(parse_error)?;
    if !trusted && !matches!(field, "text" | "reasoning" | "output") {
        return Err(ReadError::Row("Invalid text delta"));
    }
    let mut joined = Vec::new();
    for (_, _, append) in chunks {
        joined.extend_from_slice(append);
    }
    let _ = apply_delta(item, field, &joined)?;
    Ok(())
}

/// One chunk row's append: the stored JSON string it was written as.
pub(crate) fn chunk_append(append: &str) -> Result<Vec<u16>> {
    parse_string(append)
}
