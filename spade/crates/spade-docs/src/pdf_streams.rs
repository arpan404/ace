//! Bounding what a PDF's streams inflate to, on the parser's own reading path (ADR 0134).
//!
//! Spade never lets the parser inflate a stream it has not inflated within the caps itself first,
//! following that stream's parsed `/Filter` chain:
//!
//! - **While loading**, lopdf calls [`load_filter`] on every object it reads, before it inflates
//!   any object stream (`/Type /ObjStm`). Object streams are counted there; image XObjects
//!   (`/Subtype /Image`) lose their data and filters, since text extraction never reads them.
//! - **After loading**, [`check_loaded`] counts every stream that still has filters (page
//!   contents, forms, fonts), before any page is read.
//! - **Cross-reference streams**, which lopdf inflates before any object is read, are found the
//!   way lopdf finds them (`startxref`, then `/Prev` and `/XRefStm`) and counted first by
//!   [`check_xref_streams`], every way they could inflate.
//!
//! An encrypted file's object streams are decrypted and inflated by lopdf before they can be
//! counted; there, the child process's memory cap is the bound.

use std::cell::RefCell;

use pdf_extract::{Document, Object, ObjectId, Stream};

use crate::bounded::Budget;
use crate::{DocError, Limits};

/// Filter layers followed on one stream.
const MOST_LAYERS: usize = 8;
/// Cross-reference sections followed.
const MOST_SECTIONS: usize = 64;

thread_local! {
    /// The budget of the file loading on this thread, set by [`Loading::start`].
    static LOADING: RefCell<Option<Load>> = const { RefCell::new(None) };
}

struct Load {
    budget: Budget,
    refused: bool,
}

/// One file's budget across loading and checking.
pub struct Loading;

impl Loading {
    pub fn start(limits: &Limits) -> Self {
        LOADING.with(|load| {
            *load.borrow_mut() = Some(Load {
                budget: Budget::new(limits),
                refused: false,
            });
        });
        Self
    }

    /// Whether every stream counted so far fit.
    pub fn refused(&self) -> bool {
        LOADING.with(|load| load.borrow().as_ref().is_none_or(|l| l.refused))
    }

    /// Counts every stream of the loaded `doc` that still has filters.
    pub fn check_loaded(&self, doc: &mut Document) -> Result<(), DocError> {
        for object in doc.objects.values_mut() {
            if let Object::Stream(stream) = object {
                with_budget(|budget| check_stream(stream, budget))?;
            }
        }
        Ok(())
    }
}

impl Drop for Loading {
    fn drop(&mut self) {
        LOADING.with(|load| *load.borrow_mut() = None);
    }
}

/// Runs `work` with this thread's budget; no budget (another thread) fails closed.
fn with_budget(work: impl FnOnce(&mut Budget) -> Result<(), DocError>) -> Result<(), DocError> {
    LOADING.with(|load| {
        let mut load = load.borrow_mut();
        let Some(load) = load.as_mut() else {
            return Err(DocError::Expands);
        };
        if load.refused {
            return Err(DocError::Expands);
        }
        let result = work(&mut load.budget);
        if result.is_err() {
            load.refused = true;
        }
        result
    })
}

/// lopdf's per-object hook while loading. Answers the object to keep (lopdf keeps the mutated
/// one for top-level objects and the answer for objects inside object streams, which are never
/// streams); `None` drops it, and a refusal is read back with [`Loading::refused`].
pub fn load_filter(id: ObjectId, object: &mut Object) -> Option<(ObjectId, Object)> {
    if let Object::Stream(stream) = object {
        if stream.dict.get(b"Subtype").and_then(Object::as_name).ok() == Some(b"Image".as_slice()) {
            stream.dict.remove(b"Filter");
            stream.dict.remove(b"DecodeParms");
            // Not empty: lopdf rereads an empty stream from the file.
            stream.set_content(vec![0]);
        } else if stream.dict.has_type(b"ObjStm") {
            with_budget(|budget| check_stream(stream, budget)).ok()?;
        }
        return Some((id, Object::Null));
    }
    Some((id, object.clone()))
}

/// Inflates `stream` within the budget, following its filters as lopdf would.
fn check_stream(stream: &Stream, budget: &mut Budget) -> Result<(), DocError> {
    let Ok(filters) = stream.filters() else {
        return Ok(());
    };
    let early_change = stream
        .dict
        .get(b"DecodeParms")
        .and_then(Object::as_dict)
        .ok()
        .and_then(|p| p.get(b"EarlyChange").ok())
        .and_then(|v| v.as_i64().ok())
        .is_none_or(|v| v != 0);
    let mut data = stream.content.clone();
    for filter in filters.iter().take(MOST_LAYERS) {
        data = match *filter {
            b"FlateDecode" => flate(&data, budget)?,
            b"LZWDecode" => lzw(&data, early_change, budget)?,
            b"ASCII85Decode" => {
                let decoded = ascii85(&data).unwrap_or_default();
                budget.count(decoded.len(), data.len(), decoded.len())?;
                decoded
            }
            // lopdf decodes nothing else, so nothing else can expand.
            _ => return Ok(()),
        };
    }
    Ok(())
}

/// Zlib, and raw deflate when zlib gives nothing, as lopdf reads Flate.
fn flate(data: &[u8], budget: &mut Budget) -> Result<Vec<u8>, DocError> {
    let mut zlib = flate2::read::ZlibDecoder::new(data);
    let out = budget.read_lenient(&mut zlib, data.len())?;
    if out.is_empty() && data.len() > 2 {
        let mut raw = flate2::read::DeflateDecoder::new(&data[2..]);
        return budget.read_lenient(&mut raw, data.len());
    }
    Ok(out)
}

/// LZW as PDF writes it, counted as it comes out.
fn lzw(data: &[u8], early_change: bool, budget: &mut Budget) -> Result<Vec<u8>, DocError> {
    let mut decoder = if early_change {
        weezl::decode::Decoder::with_tiff_size_switch(weezl::BitOrder::Msb, 8)
    } else {
        weezl::decode::Decoder::new(weezl::BitOrder::Msb, 8)
    };
    let mut out = Vec::new();
    let mut chunk = vec![0u8; 64 * 1024];
    let mut input = data;
    loop {
        let result = decoder.decode_bytes(input, &mut chunk);
        input = &input[result.consumed_in..];
        if result.consumed_out > 0 {
            budget.count(
                out.len() + result.consumed_out,
                data.len(),
                result.consumed_out,
            )?;
            out.extend_from_slice(&chunk[..result.consumed_out]);
        }
        match result.status {
            Ok(weezl::LzwStatus::Ok) if result.consumed_in + result.consumed_out > 0 => {}
            _ => break,
        }
    }
    Ok(out)
}

/// ASCII85 text decoded; `z` stands for four zero bytes. `None` when it is not ASCII85.
fn ascii85(data: &[u8]) -> Option<Vec<u8>> {
    let body = data.strip_prefix(b"<~").unwrap_or(data);
    let end = find(body, b"~>").unwrap_or(body.len());
    let body = &body[..end];
    let mut out = Vec::with_capacity(body.len());
    let mut group: Vec<u8> = Vec::with_capacity(5);
    for &b in body.iter().filter(|b| !b.is_ascii_whitespace()) {
        if b == b'z' && group.is_empty() {
            out.extend_from_slice(&[0; 4]);
            continue;
        }
        if !(b'!'..=b'u').contains(&b) {
            return None;
        }
        group.push(b - b'!');
        if group.len() == 5 {
            let value = group.iter().fold(0u64, |v, &d| v * 85 + u64::from(d));
            out.extend_from_slice(&(u32::try_from(value).ok()?).to_be_bytes());
            group.clear();
        }
    }
    if !group.is_empty() {
        let n = group.len();
        group.resize(5, 84);
        let value = group.iter().fold(0u64, |v, &d| v * 85 + u64::from(d));
        let word = u32::try_from(value).ok()?.to_be_bytes();
        out.extend_from_slice(&word[..n.saturating_sub(1)]);
    }
    Some(out)
}

/// Counts every cross-reference stream lopdf will inflate while finding objects: the section at
/// `startxref` and those its `/Prev` and `/XRefStm` name. Their filters are not parsed yet, so
/// each is inflated every way lopdf could (a chain of Flate, LZW and ASCII85).
pub fn check_xref_streams(bytes: &[u8], limits: &Limits) -> Result<(), DocError> {
    let mut budget = Budget::new(limits);
    let Some(start) = startxref(bytes) else {
        return Ok(());
    };
    let mut queue = vec![start];
    let mut seen = std::collections::HashSet::new();
    while let Some(offset) = queue.pop() {
        if seen.len() >= MOST_SECTIONS || !seen.insert(offset) || offset >= bytes.len() {
            continue;
        }
        let section = &bytes[offset..];
        // A classic table's trailer, or a stream object's dictionary, up to its data.
        let (head, data) = match find(section, b"stream") {
            Some(at) if !section.trim_ascii_start().starts_with(b"xref") => {
                let after = &section[at + b"stream".len()..];
                let after = after
                    .strip_prefix(b"\r\n")
                    .or_else(|| after.strip_prefix(b"\n"))
                    .or_else(|| after.strip_prefix(b"\r"))
                    .unwrap_or(after);
                let end = find(after, b"endstream").unwrap_or(after.len());
                (&section[..at], Some(&after[..end]))
            }
            _ => {
                let end = find(section, b"startxref").unwrap_or(section.len());
                (&section[..end], None)
            }
        };
        if let Some(data) = data {
            layers(data, &mut budget, 0)?;
        }
        for key in [b"/Prev".as_slice(), b"/XRefStm".as_slice()] {
            if let Some(next) = number_after(head, key) {
                queue.push(next);
            }
        }
    }
    Ok(())
}

/// Every way a stream whose filters are unknown could inflate, chained.
fn layers(data: &[u8], budget: &mut Budget, depth: usize) -> Result<(), DocError> {
    if depth >= MOST_LAYERS || data.len() < 2 {
        return Ok(());
    }
    let inflated = flate(data, budget)?;
    if !inflated.is_empty() {
        layers(&inflated, budget, depth + 1)?;
    }
    for early_change in [true, false] {
        let decoded = lzw(data, early_change, budget)?;
        if decoded.len() > data.len() {
            layers(&decoded, budget, depth + 1)?;
        }
    }
    if let Some(decoded) = ascii85(data) {
        budget.count(decoded.len(), data.len(), decoded.len())?;
        layers(&decoded, budget, depth + 1)?;
    }
    Ok(())
}

/// The offset after the last `startxref` in the file, as lopdf reads it.
fn startxref(bytes: &[u8]) -> Option<usize> {
    let at = rfind(bytes, b"startxref")?;
    let rest = &bytes[at + b"startxref".len()..];
    let digits: Vec<u8> = rest
        .iter()
        .skip_while(|b| b.is_ascii_whitespace())
        .take_while(|b| b.is_ascii_digit())
        .copied()
        .collect();
    std::str::from_utf8(&digits).ok()?.parse().ok()
}

/// The number after `key` in a dictionary's bytes.
fn number_after(head: &[u8], key: &[u8]) -> Option<usize> {
    let at = find(head, key)?;
    let rest = &head[at + key.len()..];
    let digits: Vec<u8> = rest
        .iter()
        .skip_while(|b| b.is_ascii_whitespace())
        .take_while(|b| b.is_ascii_digit())
        .copied()
        .collect();
    std::str::from_utf8(&digits).ok()?.parse().ok()
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

fn rfind(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).rposition(|w| w == needle)
}
