//! Spade's document reading (ADR 0134, docs/media.md): text from PDF, DOCX, XLSX, CSV, TSV and
//! UTF-8 text files, with fixed limits on what a hostile file can cost.
//!
//! [`extract`] is the pure reader: bytes in, text out, every inflation counted against
//! [`Limits`]. [`Extractor`] is how Spade runs it: in a child process it kills after a deadline
//! ([`Extractor::child`]), so a parser that loops or overflows its stack never takes the server
//! with it, or in the caller for tests ([`Extractor::in_process`]).

mod bounded;
mod child;
mod docx;
mod pdf;
mod pdf_streams;
mod sniff;
mod table;
mod text;
mod xlsx;
mod xml;
mod zipped;

use serde::{Deserialize, Serialize};

pub use child::{CHILD_ARG, CHILD_MEMORY, Extractor, child_memory, limit_memory, serve_child};
pub use sniff::{Kind, READER_VERSION, sniff};

/// What reading may cost. [`Limits::default`] is what Spade uses; tests may tighten it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    /// The largest file read, in bytes.
    pub file_bytes: usize,
    /// Entries a ZIP (DOCX, XLSX) may list.
    pub zip_entries: usize,
    /// The most one ZIP entry or one PDF stream may inflate to.
    pub inflated_part: usize,
    /// The most everything inflated from one file may add up to.
    pub inflated_total: usize,
    /// How many times its compressed size a part may grow, once it is past 1 MB.
    pub ratio: usize,
    pub pages: usize,
    pub cells: usize,
    /// Characters of text kept; the rest is cut.
    pub chars: usize,
    /// Bytes of text kept (UTF-8); the rest is cut.
    pub text_bytes: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            file_bytes: 32 * 1024 * 1024,
            zip_entries: 10_000,
            inflated_part: 64 * 1024 * 1024,
            inflated_total: 256 * 1024 * 1024,
            ratio: 200,
            pages: 2_000,
            cells: 1_000_000,
            chars: 4_000_000,
            text_bytes: 8 * 1024 * 1024,
        }
    }
}

/// A document's text and what it is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Extracted {
    pub kind: Kind,
    pub text: String,
    /// A PDF's page count.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pages: Option<u32>,
    /// A spreadsheet's sheet count.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sheets: Option<u32>,
    /// The text stopped at the limit; the document holds more.
    #[serde(default)]
    pub cut: bool,
}

impl Extracted {
    /// Characters of text kept.
    pub fn chars(&self) -> usize {
        self.text.chars().count()
    }
}

/// Why a document was not read, in one line that never quotes it.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error, Serialize, Deserialize)]
pub enum DocError {
    #[error(
        "this is not a file Spade reads; it reads PDF, Word (.docx), Excel (.xlsx), CSV and text"
    )]
    Unsupported,
    #[error("the file is larger than {0} MB")]
    TooLarge(usize),
    #[error("it expands too far to read safely")]
    Expands,
    #[error("it holds more than {0} files inside")]
    TooManyEntries(usize),
    #[error("it has more than {0} pages")]
    TooManyPages(usize),
    #[error("it has more than {0} cells")]
    TooManyCells(usize),
    #[error("it is damaged or not what its type says: {0}")]
    Damaged(String),
    #[error("it is protected with a password")]
    Encrypted,
    #[error("reading it took longer than {0} seconds")]
    TimedOut(u64),
    #[error("it could not be read ({0})")]
    Failed(String),
}

/// Reads `bytes` as the document they are; `name` (the file's name) tells CSV and TSV from other
/// text. Pure apart from CPU and memory, both bounded by `limits`.
pub fn extract(bytes: &[u8], name: &str, limits: &Limits) -> Result<Extracted, DocError> {
    if bytes.len() > limits.file_bytes {
        return Err(DocError::TooLarge(limits.file_bytes / (1024 * 1024)));
    }
    let kind = sniff(bytes, name).ok_or(DocError::Unsupported)?;
    let mut out = match kind {
        Kind::Pdf => pdf::read(bytes, limits)?,
        Kind::Docx => docx::read(bytes, limits)?,
        Kind::Xlsx => xlsx::read(bytes, limits)?,
        Kind::Csv | Kind::Tsv => table::read(bytes, kind, limits)?,
        Kind::Text => text::read(bytes),
    };
    let (text, cut) = text::tidy(&out.text, limits);
    out.text = text;
    out.cut |= cut;
    Ok(out)
}

#[cfg(test)]
mod tests;
