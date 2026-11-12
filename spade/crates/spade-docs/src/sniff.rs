//! What a file is, from its bytes (and its name only to tell CSV and TSV from other text).

use std::io::Cursor;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Pdf,
    Docx,
    Xlsx,
    Csv,
    Tsv,
    Text,
}

impl Kind {
    /// The media type Spade stores and serves it as.
    pub const fn media_type(self) -> &'static str {
        match self {
            Self::Pdf => "application/pdf",
            Self::Docx => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            Self::Xlsx => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            Self::Csv => "text/csv",
            Self::Tsv => "text/tab-separated-values",
            Self::Text => "text/plain",
        }
    }
}

/// The kind of document `bytes` are, or `None` when Spade does not read it.
pub fn sniff(bytes: &[u8], name: &str) -> Option<Kind> {
    if bytes.starts_with(b"%PDF-") {
        return Some(Kind::Pdf);
    }
    if bytes.starts_with(b"PK\x03\x04") {
        let archive = zip::ZipArchive::new(Cursor::new(bytes)).ok()?;
        let has = |part: &str| archive.index_for_name(part).is_some();
        return if has("word/document.xml") {
            Some(Kind::Docx)
        } else if has("xl/workbook.xml") {
            Some(Kind::Xlsx)
        } else {
            None
        };
    }
    let body = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    if body.contains(&0) || std::str::from_utf8(body).is_err() {
        return None;
    }
    let lower = name.to_ascii_lowercase();
    Some(if lower.ends_with(".csv") {
        Kind::Csv
    } else if lower.ends_with(".tsv") || lower.ends_with(".tab") {
        Kind::Tsv
    } else {
        Kind::Text
    })
}
