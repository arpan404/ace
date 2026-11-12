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
            b"ASCII85Decode" => ascii85(&data, budget)?,
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

/// ASCII85 decoded exactly as lopdf decodes it, counted as it comes out: `~>` is dropped only at
/// the very end, whitespace is skipped, `z` gives four zero bytes, and the first byte outside
/// `!`..=`u` ends the data while what came before is kept (so `<~` ends it at once, as `~` is
/// outside). Where lopdf fails (a `z` inside a group, a value past 32 bits) it decodes nothing,
/// and so nothing is counted.
fn ascii85(data: &[u8], budget: &mut Budget) -> Result<Vec<u8>, DocError> {
    let input = data.strip_suffix(b"~>").unwrap_or(data);
    let mut out = Vec::new();
    let mut counted = 0usize;
    let mut buffer: u32 = 0;
    let mut count = 0usize;
    for &ch in input {
        if ch == b'z' {
            if count != 0 {
                return Ok(Vec::new());
            }
            out.extend_from_slice(&[0, 0, 0, 0]);
        } else if ch.is_ascii_whitespace() {
            continue;
        } else if !(b'!'..=b'u').contains(&ch) {
            break;
        } else {
            let Some(times) = buffer.checked_mul(85) else {
                return Ok(Vec::new());
            };
            // lopdf adds without a check; a release build wraps.
            buffer = times.wrapping_add(u32::from(ch - b'!'));
            count += 1;
            if count == 5 {
                out.extend_from_slice(&buffer.to_be_bytes());
                buffer = 0;
                count = 0;
            }
        }
        if out.len() - counted >= 64 * 1024 {
            budget.count(out.len(), data.len(), out.len() - counted)?;
            counted = out.len();
        }
    }
    if count > 0 {
        for _ in count..5 {
            let Some(times) = buffer.checked_mul(85) else {
                return Ok(Vec::new());
            };
            buffer = times.wrapping_add(84);
        }
        out.extend_from_slice(&buffer.to_be_bytes()[..count - 1]);
    }
    budget.count(out.len(), data.len(), out.len() - counted)?;
    Ok(out)
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
                (&section[..at], Some(after))
            }
            _ => {
                let end = find(section, b"startxref").unwrap_or(section.len());
                (&section[..end], None)
            }
        };
        if let Some(after) = data {
            for data in xref_data(head, after) {
                layers(data, &mut budget, 0)?;
            }
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
    let decoded = ascii85(data, budget)?;
    if !decoded.is_empty() {
        layers(&decoded, budget, depth + 1)?;
    }
    Ok(())
}

/// A cross-reference stream's data, every way lopdf may slice it: by its direct `/Length`, and
/// up to the last `endstream` before the object's `endobj` (where lopdf looks when the length is
/// indirect or wrong). `after` starts right after the `stream` keyword's line end.
fn xref_data<'a>(head: &[u8], after: &'a [u8]) -> Vec<&'a [u8]> {
    let mut out: Vec<&[u8]> = Vec::new();
    if let Some(length) = direct_length(head) {
        out.push(&after[..length.min(after.len())]);
    }
    let object = find(after, b"endobj").unwrap_or(after.len());
    let end = rfind(&after[..object], b"endstream").unwrap_or(object);
    let to_end = &after[..end];
    if !out.contains(&to_end) {
        out.push(to_end);
    }
    out
}

/// A dictionary's `/Length` when it is a number written there, not a reference (`12 0 R`).
fn direct_length(head: &[u8]) -> Option<usize> {
    let at = find(head, b"/Length")?;
    let rest = &head[at + b"/Length".len()..];
    let rest = rest.trim_ascii_start();
    let digits = rest.iter().take_while(|b| b.is_ascii_digit()).count();
    if digits == 0 {
        return None;
    }
    let tail = rest[digits..].trim_ascii_start();
    let generation = tail.iter().take_while(|b| b.is_ascii_digit()).count();
    if generation > 0 && tail[generation..].trim_ascii_start().starts_with(b"R") {
        return None;
    }
    std::str::from_utf8(&rest[..digits]).ok()?.parse().ok()
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
