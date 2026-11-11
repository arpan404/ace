//! Paging through extracted text, and which content types Spade reads. Pure.

/// How many characters one page holds unless asked otherwise.
pub const DEFAULT_PAGE_CHARS: usize = 20_000;

/// A window of a page's extracted text, counted in characters.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Page {
    pub offset: usize,
    /// At least 1.
    pub max_chars: usize,
}

impl Default for Page {
    fn default() -> Self {
        Self {
            offset: 0,
            max_chars: DEFAULT_PAGE_CHARS,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Window {
    pub text: String,
    /// Characters in the whole text.
    pub total_chars: usize,
    /// Where the next page starts, when more remains.
    pub next_offset: Option<usize>,
}

/// The part of `text` that `page` selects. An offset past the end gives empty text.
#[must_use]
pub fn window(text: &str, page: Page) -> Window {
    let total_chars = text.chars().count();
    let max = page.max_chars.max(1);
    let piece: String = text.chars().skip(page.offset).take(max).collect();
    let end = page.offset.saturating_add(max);
    Window {
        text: piece,
        total_chars,
        next_offset: (end < total_chars).then_some(end),
    }
}

/// How a response's body is read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reading {
    /// HTML or XHTML: extract the readable text.
    Html,
    /// Plain text, JSON or XML: pass through, trimmed.
    Text,
}

/// The media type of a `Content-Type` header value, lowercased and without parameters.
#[must_use]
pub fn media_type(content_type: &str) -> String {
    content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
}

/// How a body of `media_type` is read, or `None` when Spade does not read it.
#[must_use]
pub fn reading(media_type: &str) -> Option<Reading> {
    match media_type {
        "text/html" | "application/xhtml+xml" => Some(Reading::Html),
        "application/json" | "application/xml" => Some(Reading::Text),
        t if t.starts_with("text/") || t.ends_with("+json") || t.ends_with("+xml") => {
            Some(Reading::Text)
        }
        _ => None,
    }
}
