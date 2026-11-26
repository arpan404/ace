// SPDX-License-Identifier: Apache-2.0
//! `pdf-objects.ts`'s object reader: the numbered objects of a PDF, their inflated streams, and
//! the first page's size, drawing and resources. Pure: bytes in, values out.

use super::pdf_lexer::{PdfDict, PdfLexer, PdfValue, is_js_space};

/// A PDF's numbered objects, in the order they were read. A repeated number replaces the value
/// where it first appeared, as `Map.set` does. Streams keep their encoded bytes until
/// [`stream_bytes`].
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PdfDocument {
    pub objects: Vec<(u32, PdfValue)>,
}

impl PdfDocument {
    pub fn get(&self, id: u32) -> Option<&PdfValue> {
        self.objects
            .iter()
            .find(|(existing, _)| *existing == id)
            .map(|(_, value)| value)
    }

    fn set(&mut self, id: u32, value: PdfValue) {
        for (existing, slot) in &mut self.objects {
            if *existing == id {
                *slot = value;
                return;
            }
        }
        self.objects.push((id, value));
    }
}

/// A PDF's text as latin-1: every byte becomes the character of the same code.
fn latin1(bytes: &[u8]) -> Vec<char> {
    bytes.iter().map(|byte| char::from(*byte)).collect()
}

/// `(\d+)\s+\d+\s+obj\b` at `index`, returning the object's number and the match's end.
fn object_header(text: &[char], index: usize) -> Option<(u32, usize)> {
    let mut at = index;
    let number_start = at;
    while at < text.len() && text[at].is_ascii_digit() {
        at += 1;
    }
    if at == number_start {
        return None;
    }
    let id: u32 = text[number_start..at]
        .iter()
        .collect::<String>()
        .parse()
        .ok()?;
    let mut spaces = 0;
    while at < text.len() && is_js_space(text[at]) {
        at += 1;
        spaces += 1;
    }
    if spaces == 0 {
        return None;
    }
    let generation_start = at;
    while at < text.len() && text[at].is_ascii_digit() {
        at += 1;
    }
    if at == generation_start {
        return None;
    }
    spaces = 0;
    while at < text.len() && is_js_space(text[at]) {
        at += 1;
        spaces += 1;
    }
    if spaces == 0 {
        return None;
    }
    for expected in ['o', 'b', 'j'] {
        if text.get(at) != Some(&expected) {
            return None;
        }
        at += 1;
    }
    // `\b`: a word character after `obj` means this was not the keyword.
    if let Some(next) = text.get(at)
        && (next.is_ascii_alphanumeric() || *next == '_')
    {
        return None;
    }
    Some((id, at))
}

/// `^\s*stream\r?\n` at `start`, returning the stream's first byte.
fn stream_start(text: &[char], start: usize) -> Option<usize> {
    let limit = (start + 16).min(text.len());
    let mut at = start;
    while at < limit && is_js_space(text[at]) {
        at += 1;
    }
    for expected in ['s', 't', 'r', 'e', 'a', 'm'] {
        if at >= limit || text[at] != expected {
            return None;
        }
        at += 1;
    }
    if at < limit && text[at] == '\r' {
        at += 1;
    }
    if at < limit && text[at] == '\n' {
        Some(at + 1)
    } else {
        None
    }
}

/// The text of `needle` found in `text` at or after `from`, character-indexed.
fn find_from(text: &[char], needle: &str, from: usize) -> Option<usize> {
    let needle: Vec<char> = needle.chars().collect();
    if needle.is_empty() || from >= text.len() || needle.len() > text.len() - from {
        return None;
    }
    (from..=text.len().saturating_sub(needle.len()))
        .find(|start| text[*start..*start + needle.len()] == needle[..])
}

pub fn pdf_objects(bytes: &[u8]) -> PdfDocument {
    let text = latin1(bytes);
    let mut document = PdfDocument::default();
    let mut index = 0;
    while index < text.len() {
        let Some((id, end)) = object_header(&text, index) else {
            index += 1;
            continue;
        };
        let mut lexer = PdfLexer::new(&text, end);
        let Some(mut value) = lexer.value() else {
            index = end.max(index + 1);
            continue;
        };
        // Only a dictionary can carry a stream, as `isDict(value)` decides; anything else is
        // read as the value it is and the scan carries on inside what followed.
        let mut streamed = false;
        if is_dict(Some(&value))
            && let Some(start) = stream_start(&text, lexer.position)
            && let Some(found) = find_from(&text, "endstream", start)
            && found > start
        {
            if start < bytes.len() {
                let mut stop = found.min(bytes.len());
                if stop > start && text.get(stop - 1) == Some(&'\n') {
                    stop -= 1;
                }
                if stop > start && text.get(stop - 1) == Some(&'\r') {
                    stop -= 1;
                }
                if let PdfValue::Dict(dict) = &mut value {
                    dict.stream = Some(bytes[start..stop].to_vec());
                }
            }
            index = found;
            streamed = true;
        }
        if !streamed {
            index = end.max(index + 1);
        }
        document.set(id, value);
    }
    document
}

pub fn is_dict(value: Option<&PdfValue>) -> bool {
    matches!(value, Some(PdfValue::Dict(_)))
}

/// Follows a reference to its object; anything else is returned as it is, and a chain longer
/// than eight hops is undefined.
pub fn resolve<'a>(document: &'a PdfDocument, value: Option<&'a PdfValue>) -> Option<&'a PdfValue> {
    let mut current = value;
    for _ in 0..8 {
        match current {
            Some(PdfValue::Reference(id)) => current = document.get(*id),
            other => return other,
        }
    }
    None
}

pub fn name_of(value: Option<&PdfValue>) -> Option<&str> {
    match value {
        Some(PdfValue::Name(name)) => Some(name.as_str()),
        _ => None,
    }
}

pub fn numbers_of(value: Option<&PdfValue>) -> Vec<f64> {
    match value {
        Some(PdfValue::Array(items)) => items.iter().filter_map(PdfValue::as_number).collect(),
        _ => Vec::new(),
    }
}

/// A stream's decoded bytes: unfiltered or Flate only; none for any other filter, and none for
/// a Flate stream that ends before its checksum, as `inflateSync` throws on a truncated one.
pub fn stream_bytes(dict: &PdfDict) -> Option<Vec<u8>> {
    let encoded = dict.stream.as_ref()?;
    let filters: Vec<Option<&str>> = match dict.get("Filter") {
        Some(PdfValue::Array(items)) => items.iter().map(|item| name_of(Some(item))).collect(),
        Some(value) => vec![name_of(Some(value))],
        None => Vec::new(),
    };
    let mut data = encoded.clone();
    for filter in filters {
        if filter != Some("FlateDecode") {
            return None;
        }
        data = inflate(&data)?;
    }
    Some(data)
}

/// A zlib stream's bytes, or none when it is corrupt or ends before its end marker: `inflateSync`
/// throws for both.
fn inflate(data: &[u8]) -> Option<Vec<u8>> {
    use flate2::{Decompress, FlushDecompress, Status};
    let mut decompress = Decompress::new(true);
    let mut out = Vec::new();
    let mut chunk = [0u8; 16 * 1024];
    loop {
        let before = decompress.total_out();
        let status = decompress
            .decompress(
                data.get(decompress.total_in() as usize..)
                    .unwrap_or_default(),
                &mut chunk,
                FlushDecompress::None,
            )
            .ok()?;
        let produced = (decompress.total_out() - before) as usize;
        out.extend_from_slice(&chunk[..produced]);
        match status {
            Status::StreamEnd => return Some(out),
            // No more input and nothing more produced: the stream is short of its end.
            Status::Ok if decompress.total_in() as usize >= data.len() && produced == 0 => {
                return None;
            }
            Status::Ok => {}
            Status::BufError => return None,
        }
    }
}

/// A page's drawing operators as text, or "" when it cannot be decoded.
pub fn stream_text(dict: &PdfDict) -> String {
    match stream_bytes(dict) {
        Some(data) => latin1(&data).into_iter().collect(),
        None => String::new(),
    }
}

/// One page as Apple's art uses it: its box, its drawing and its resources.
#[derive(Debug, Clone, PartialEq)]
pub struct PdfPage {
    /// `[x0, y0, x1, y1]` in PDF units.
    pub page_box: [f64; 4],
    pub content: String,
    pub resources: Option<PdfDict>,
    pub objects: PdfDocument,
}

/// The first page: its size, drawing and resources (inherited from its parents when absent).
pub fn first_page(bytes: &[u8]) -> Option<PdfPage> {
    let document = pdf_objects(bytes);
    let page_id = document
        .objects
        .iter()
        .find_map(|(id, value)| match value {
            PdfValue::Dict(dict) if name_of(dict.get("Type")) == Some("Page") => Some(*id),
            _ => None,
        })?;
    let page_box = numbers_of(resolve(
        &document,
        inherited(&document, page_id, "MediaBox"),
    ));
    if page_box.len() != 4 {
        return None;
    }
    let [x0, y0, x1, y1] = [page_box[0], page_box[1], page_box[2], page_box[3]];
    if !(x1 > x0 && y1 > y0) {
        return None;
    }
    let page = document.get(page_id)?;
    let PdfValue::Dict(page_dict) = page else {
        return None;
    };
    let contents = resolve(&document, page_dict.get("Contents"));
    let parts: Vec<&PdfValue> = match contents {
        Some(PdfValue::Array(items)) => items
            .iter()
            .filter_map(|item| resolve(&document, Some(item)))
            .collect(),
        other => other.into_iter().collect(),
    };
    let content = parts
        .iter()
        .filter_map(|part| match part {
            PdfValue::Dict(dict) => Some(stream_text(dict)),
            _ => None,
        })
        .collect::<Vec<String>>()
        .join("\n");
    let resources = resolve(&document, inherited(&document, page_id, "Resources"));
    let resources = match resources {
        Some(PdfValue::Dict(dict)) => Some(dict.clone()),
        _ => None,
    };
    Some(PdfPage {
        page_box: [x0, y0, x1, y1],
        content,
        resources,
        objects: document,
    })
}

/// A page attribute, taken from the first node up its parents that sets it.
fn inherited<'a>(document: &'a PdfDocument, page_id: u32, key: &str) -> Option<&'a PdfValue> {
    let mut current = document.get(page_id);
    for _ in 0..16 {
        let Some(PdfValue::Dict(dict)) = current else {
            return None;
        };
        if let Some(value) = dict.get(key) {
            return Some(value);
        }
        current = match dict.get("Parent") {
            Some(PdfValue::Reference(id)) => document.get(*id),
            other => other,
        };
    }
    None
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use super::*;

    fn flate(contents: &[u8]) -> Vec<u8> {
        let mut encoder =
            flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(contents).expect("compresses");
        encoder.finish().expect("compresses")
    }

    fn stream_pdf(encoded: &[u8]) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"%PDF-1.3\n");
        bytes.extend_from_slice(
            format!(
                "3 0 obj\n<< /Filter /FlateDecode /Length {} >>\nstream\n",
                encoded.len()
            )
            .as_bytes(),
        );
        bytes.extend_from_slice(encoded);
        bytes.extend_from_slice(b"\nendstream\nendobj\n");
        bytes
    }

    #[test]
    fn a_truncated_zlib_stream_does_not_decode() {
        let encoded = flate(b"0 0 10 10 re f");
        // Cut short of its checksum, as a half-written file is, but ended with `endstream`.
        let truncated = &encoded[..encoded.len() - 3];
        let document = pdf_objects(&stream_pdf(truncated));
        let Some(PdfValue::Dict(dict)) = document.get(3) else {
            panic!("the stream's dictionary is read");
        };
        assert_eq!(
            stream_bytes(dict),
            None,
            "a short zlib stream must not decode"
        );
        assert_eq!(stream_text(dict), "");
    }

    #[test]
    fn a_complete_zlib_stream_decodes() {
        let document = pdf_objects(&stream_pdf(&flate(b"0 0 10 10 re f")));
        let Some(PdfValue::Dict(dict)) = document.get(3) else {
            panic!("the stream's dictionary is read");
        };
        assert_eq!(stream_text(dict), "0 0 10 10 re f");
    }

    #[test]
    fn only_a_dictionary_keeps_the_stream_that_follows() {
        // A non-dictionary value with `stream` after it: the scan carries on inside it, as the
        // TypeScript's `isDict(value)` check leaves the header's position where the value ended.
        let text = "1 0 obj\n[ 1 2 ]\nstream\n2 0 obj\n<< /Type /Page >>\nendstream\nendobj\n";
        let document = pdf_objects(text.as_bytes());
        assert!(
            document.get(2).is_some(),
            "an object inside a non-dict's bytes is still read"
        );
        let Some(PdfValue::Array(items)) = document.get(1) else {
            panic!("the array is read");
        };
        assert_eq!(items.len(), 2);
    }

    #[test]
    fn an_object_header_needs_javascripts_spaces_not_a_nul() {
        assert!(pdf_objects(b"1 0 obj\n<< /Type /Page >>").get(1).is_some());
        assert!(
            pdf_objects(b"1\0 0 obj\n<< /Type /Page >>")
                .get(1)
                .is_none()
        );
    }
}
