//! PDF: every stream inflated within the caps first, then the text of each page through
//! `pdf-extract`, a page at a time so the text stops at its cap and a page the parser panics on is
//! skipped rather than losing the rest.

use pdf_extract::{Document, PlainTextOutput, output_doc_page};

use crate::bounded::{Budget, short};
use crate::{DocError, Extracted, Kind, Limits};

/// Filter layers tried on one stream: PDF allows chains, and an attacker can stack them.
const MOST_LAYERS: usize = 4;
/// How far back from `stream` its dictionary is looked for.
const DICTIONARY_REACH: usize = 4096;

pub fn read(bytes: &[u8], limits: &Limits) -> Result<Extracted, DocError> {
    check_streams(bytes, limits)?;
    let mut doc =
        Document::load_mem(bytes).map_err(|e| DocError::Damaged(short(&e.to_string())))?;
    if doc.is_encrypted() && doc.decrypt("").is_err() {
        return Err(DocError::Encrypted);
    }
    let count = doc.get_pages().len();
    if count > limits.pages {
        return Err(DocError::TooManyPages(limits.pages));
    }
    let mut text = String::new();
    let mut cut = false;
    for number in 1..=count {
        let page = u32::try_from(number).unwrap_or(u32::MAX);
        if let Some(words) = page_text(&doc, page) {
            text.push_str(words.trim());
            text.push_str("\n\n");
        }
        if text.len() > limits.text_bytes || text.len() > limits.chars.saturating_mul(4) {
            cut = number < count;
            break;
        }
    }
    Ok(Extracted {
        kind: Kind::Pdf,
        text,
        pages: u32::try_from(count).ok(),
        sheets: None,
        cut,
    })
}

/// One page's text; `None` when the parser fails or panics on it.
fn page_text(doc: &Document, page: u32) -> Option<String> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let mut words = String::new();
        output_doc_page(doc, &mut PlainTextOutput::new(&mut words), page).ok()?;
        Some(words)
    }))
    .ok()
    .flatten()
}

/// Inflates every stream in the file the ways the parser could (Flate, LZW, ASCII85, in any
/// chain up to [`MOST_LAYERS`] deep) under the caps, before the parser sees it. Image streams
/// are skipped: text extraction never decodes them.
fn check_streams(bytes: &[u8], limits: &Limits) -> Result<(), DocError> {
    let mut budget = Budget::new(limits);
    let mut at = 0;
    while let Some(found) = find(&bytes[at..], b"stream") {
        let keyword = at + found;
        at = keyword + b"stream".len();
        if keyword >= 3 && &bytes[keyword - 3..keyword] == b"end" {
            continue;
        }
        let start = match &bytes[at..] {
            [b'\r', b'\n', ..] => at + 2,
            [b'\n', ..] | [b'\r', ..] => at + 1,
            _ => continue,
        };
        let end = find(&bytes[start..], b"endstream").map_or(bytes.len(), |n| start + n);
        if is_image(&bytes[keyword.saturating_sub(DICTIONARY_REACH)..keyword]) {
            at = end;
            continue;
        }
        layers(&bytes[start..end], &mut budget, 0)?;
        at = end;
    }
    Ok(())
}

/// Whether the dictionary just before a stream (back to its `obj`) declares an image.
fn is_image(before: &[u8]) -> bool {
    let from = rfind(before, b"obj").map_or(0, |n| n + 3);
    find(&before[from..], b"/Image").is_some()
}

fn layers(data: &[u8], budget: &mut Budget, depth: usize) -> Result<(), DocError> {
    if depth >= MOST_LAYERS || data.len() < 2 {
        return Ok(());
    }
    let mut zlib = flate2::read::ZlibDecoder::new(data);
    let inflated = budget.read_lenient(&mut zlib, data.len())?;
    if !inflated.is_empty() {
        layers(&inflated, budget, depth + 1)?;
    }
    let lzw = lzw(data, budget)?;
    if lzw.len() > data.len() {
        layers(&lzw, budget, depth + 1)?;
    }
    if let Some(decoded) = ascii85(data) {
        budget.count(decoded.len(), data.len(), decoded.len())?;
        layers(&decoded, budget, depth + 1)?;
    }
    Ok(())
}

/// LZW as PDF writes it (most significant bit first, early change), counted as it comes out.
fn lzw(data: &[u8], budget: &mut Budget) -> Result<Vec<u8>, DocError> {
    let mut decoder = weezl::decode::Decoder::with_tiff_size_switch(weezl::BitOrder::Msb, 8);
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

/// ASCII85 text decoded, when the data looks like it; `z` stands for four zero bytes.
fn ascii85(data: &[u8]) -> Option<Vec<u8>> {
    let body = data.strip_prefix(b"<~").unwrap_or(data);
    let end = find(body, b"~>").unwrap_or(body.len());
    let body = &body[..end];
    let looks = !body.is_empty()
        && body
            .iter()
            .all(|b| (b'!'..=b'u').contains(b) || *b == b'z' || b.is_ascii_whitespace());
    if !looks {
        return None;
    }
    let mut out = Vec::with_capacity(body.len());
    let mut group: Vec<u8> = Vec::with_capacity(5);
    for &b in body.iter().filter(|b| !b.is_ascii_whitespace()) {
        if b == b'z' && group.is_empty() {
            out.extend_from_slice(&[0; 4]);
            continue;
        }
        group.push(b.wrapping_sub(b'!'));
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

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

fn rfind(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).rposition(|w| w == needle)
}
