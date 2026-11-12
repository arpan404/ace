//! PDF: every stream the parser will inflate is inflated within the caps first (see
//! `pdf_streams`), then the text of each page through `pdf-extract`, a page at a time so the text
//! stops at its cap and a page the parser panics on is skipped rather than losing the rest.

use pdf_extract::{Document, LoadOptions, PlainTextOutput, output_doc_page};

use crate::bounded::short;
use crate::pdf_streams::{Loading, check_xref_streams, load_filter};
use crate::{DocError, Extracted, Kind, Limits};

pub fn read(bytes: &[u8], limits: &Limits) -> Result<Extracted, DocError> {
    check_xref_streams(bytes, limits)?;
    let loading = Loading::start(limits);
    let loaded = Document::load_mem_with_options(bytes, LoadOptions::with_filter(load_filter));
    if loading.refused() {
        return Err(DocError::Expands);
    }
    let mut doc = loaded.map_err(|e| DocError::Damaged(short(&e.to_string())))?;
    if doc.is_encrypted() && doc.decrypt("").is_err() {
        return Err(DocError::Encrypted);
    }
    loading.check_loaded(&mut doc)?;
    drop(loading);
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
