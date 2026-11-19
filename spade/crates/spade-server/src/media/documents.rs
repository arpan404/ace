//! Documents the person attaches and files a bot shares (ADR 0134): the bytes by hash in
//! `<data>/documents`, the extracted text beside them as `<hash>.txt`, and the reference events
//! carry, with the view the prompt shows fixed when it is made.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use spade_core::context::DOCUMENT_ID_CHARS;
use spade_core::event::DocumentRef;
use spade_docs::Extracted;
use spade_models::Image;

use super::store::HashStore;

/// The most documents one message may carry.
pub const MOST_DOCUMENTS: usize = 8;
/// Characters of a document's text the prompt shows.
pub const VIEW_CHARS: usize = 6_000;
/// The most characters one `document_read` window holds.
pub const WINDOW_CHARS: usize = 20_000;
/// A PDF sent natively has at most this many pages ...
pub const NATIVE_PAGES: u32 = 100;
/// ... and fewer than this many characters of text a page on average (a scan).
pub const THIN_TEXT_PER_PAGE: u64 = 200;

#[derive(Debug, Clone)]
pub struct DocumentStore(pub(super) HashStore);

/// A window of a document's text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Window {
    pub sha256: String,
    pub text: String,
    pub total_chars: usize,
    pub next_offset: Option<usize>,
}

impl DocumentStore {
    /// Stores the file and its text once, and answers its reference.
    pub fn put(
        &self,
        name: &str,
        bytes: &[u8],
        extracted: &Extracted,
    ) -> std::io::Result<DocumentRef> {
        let sha256 = self.0.put(bytes)?;
        let reader = extracted.kind.reader();
        self.0
            .put_as(&format!("{sha256}.{reader}.txt"), extracted.text.as_bytes())?;
        Ok(DocumentRef {
            sha256,
            name: file_name(name),
            media_type: extracted.kind.media_type().to_owned(),
            bytes: bytes.len() as u64,
            pages: extracted.pages,
            sheets: extracted.sheets,
            chars: extracted.chars() as u64,
            cut: extracted.cut,
            view: extracted.text.chars().take(VIEW_CHARS).collect(),
            reader,
        })
    }

    pub fn bytes(&self, sha256: &str) -> Option<Vec<u8>> {
        self.0.read(sha256)
    }

    /// The window from `offset` of at most `limit` characters of the text `id` names: a
    /// document's handle (its hash, or at least its first [`DOCUMENT_ID_CHARS`] characters, then
    /// `-` and the reader that made the text). With no reader, the text of the newest reader.
    pub fn window(&self, id: &str, offset: usize, limit: usize) -> Option<Window> {
        let (prefix, reader) = id
            .trim()
            .split_once('-')
            .map_or((id.trim(), None), |(p, r)| (p, Some(r)));
        let sha256 = self.0.find(prefix, DOCUMENT_ID_CHARS)?;
        let name = match reader {
            Some(reader) => format!("{sha256}.{reader}.txt"),
            None => self.0.newest_text(&sha256)?,
        };
        let text = String::from_utf8(self.0.read(&name)?).ok()?;
        let total_chars = text.chars().count();
        let limit = limit.clamp(1, WINDOW_CHARS);
        let piece: String = text.chars().skip(offset).take(limit).collect();
        let end = offset.saturating_add(limit);
        Some(Window {
            sha256,
            text: piece,
            total_chars,
            next_offset: (end < total_chars).then_some(end),
        })
    }

    /// The PDF itself for a model that reads PDFs, when that reads better per token: a short
    /// document whose text layer is thin (a scan). Otherwise `None`, and the text is shown.
    pub fn native(&self, document: &DocumentRef) -> Option<Image> {
        if !reads_better_natively(document) {
            return None;
        }
        let bytes = self.bytes(&document.sha256)?;
        Some(Image {
            media_type: "application/pdf".to_owned(),
            data: STANDARD.encode(bytes).into(),
        })
    }
}

/// Whether a model that reads PDFs should get this one as a file: its text layer is thin, so the
/// page images carry what text cannot, and it is short enough to send whole.
pub fn reads_better_natively(document: &DocumentRef) -> bool {
    let Some(pages) = document.pages.filter(|p| *p > 0) else {
        return false;
    };
    document.media_type == "application/pdf"
        && pages <= NATIVE_PAGES
        && document.chars / u64::from(pages) < THIN_TEXT_PER_PAGE
}

/// A file name as Spade keeps it: the last part of what was given, without control characters
/// or path separators, at most 120 characters; `file` when nothing is left.
pub fn file_name(name: &str) -> String {
    let last = name.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = last.chars().filter(|c| !c.is_control()).take(120).collect();
    let cleaned = cleaned.trim().trim_start_matches('.').to_owned();
    if cleaned.is_empty() {
        "file".to_owned()
    } else {
        cleaned
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pdf(pages: Option<u32>, chars: u64) -> DocumentRef {
        DocumentRef {
            sha256: "a".repeat(64),
            name: "x.pdf".into(),
            media_type: "application/pdf".into(),
            bytes: 10,
            pages,
            sheets: None,
            chars,
            cut: false,
            view: String::new(),
            reader: "pdf-v1".into(),
        }
    }

    #[test]
    fn only_a_short_pdf_with_thin_text_goes_to_the_model_as_a_file() {
        assert!(reads_better_natively(&pdf(Some(10), 500)));
        assert!(!reads_better_natively(&pdf(Some(10), 50_000)));
        assert!(!reads_better_natively(&pdf(Some(300), 0)));
        assert!(!reads_better_natively(&pdf(None, 0)));
        let mut sheet = pdf(Some(1), 0);
        sheet.media_type = "text/csv".into();
        assert!(!reads_better_natively(&sheet));
    }

    #[test]
    fn names_keep_only_their_last_part_and_no_control_characters() {
        assert_eq!(file_name("../../etc/passwd"), "passwd");
        assert_eq!(file_name("C:\\Users\\a\\report.pdf"), "report.pdf");
        assert_eq!(file_name("a\nb.txt"), "ab.txt");
        assert_eq!(file_name(".."), "file");
        assert_eq!(file_name(".hidden"), "hidden");
    }
}
