//! What `workspace_read` makes of a file, from its first bytes: an image it shows as the image, a
//! document it reads as text through Spade's document reader, or text. Pure.

/// What a file is, for reading it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Shape {
    /// PNG, JPEG, GIF or WebP: every endpoint that reads images reads these.
    Image,
    /// A PDF, or a ZIP that may be a Word or Excel file (the document reader decides).
    Document,
    Text,
}

/// How many first bytes [`shape`] needs.
pub const HEAD: usize = 16;
/// The largest image a read shows: what a provider takes in one image.
pub const LARGEST_IMAGE: u64 = crate::images::MOST_BYTES as u64;
/// The largest document a read reads.
pub const LARGEST_DOCUMENT: u64 = 32 * 1024 * 1024;

/// What the file starting with `head` is.
pub fn shape(head: &[u8]) -> Shape {
    if crate::images::sniff(head).is_some() {
        Shape::Image
    } else if head.starts_with(b"%PDF-") || head.starts_with(b"PK\x03\x04") {
        Shape::Document
    } else {
        Shape::Text
    }
}

/// The line the model reads beside an image it was shown.
pub fn image_line(path: &str, bytes: &[u8]) -> String {
    let kind = match crate::images::sniff(bytes) {
        Some("image/png") => "PNG",
        Some("image/jpeg") => "JPEG",
        Some("image/gif") => "GIF",
        Some("image/webp") => "WebP",
        _ => "an",
    };
    format!("{path}: a {kind} image, {} bytes.", bytes.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_file_is_read_by_what_its_first_bytes_say_not_its_name() {
        assert_eq!(shape(b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR"), Shape::Image);
        assert_eq!(shape(&[0xFF, 0xD8, 0xFF, 0xE0]), Shape::Image);
        assert_eq!(shape(b"%PDF-1.7\n"), Shape::Document);
        assert_eq!(shape(b"PK\x03\x04\x14\0"), Shape::Document);
        assert_eq!(shape(b"date,count\n"), Shape::Text);
        assert_eq!(shape(b""), Shape::Text);
        assert_eq!(
            image_line("chart.png", b"\x89PNG\r\n\x1a\n"),
            "chart.png: a PNG image, 8 bytes."
        );
    }
}
