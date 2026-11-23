// SPDX-License-Identifier: Apache-2.0
//! Base64 data URLs carry whole attachments, often several megabytes. They are
//! read by index and scanned in one loop, never matched with a regular
//! expression: in a long-running daemon V8 can run out of stack matching a
//! pattern against a string this long, which refused every large screenshot
//! sent to Claude. Ported from `packages/provider-kit/src/data-url.ts`; the
//! TypeScript module stays for the daemon code that still uses it.

/// A data URL split into its media type and its exact base64 bytes.
#[derive(Debug, PartialEq, Eq)]
pub struct Base64DataUrl<'a> {
    pub mime_type: &'a str,
    pub data: &'a str,
}

/// Splits `data:<mime>;base64,<payload>`. Anything else (remote URLs,
/// raw-data URLs, empty media types, extra parameters) is refused.
pub fn base64_data_url(url: &str) -> Option<Base64DataUrl<'_>> {
    if !url.starts_with("data:") {
        return None;
    }
    let marker = url.find(";base64,")?;
    if marker <= 5 {
        return None;
    }
    let mime_type = url.get(5..marker)?;
    if mime_type.contains(',') || mime_type.contains(';') {
        return None;
    }
    let data = url.get(marker + ";base64,".len()..)?;
    Some(Base64DataUrl { mime_type, data })
}

/// True for a non-empty base64 alphabet string with at most two trailing `=`.
pub fn is_base64(value: &str) -> bool {
    let bytes = value.as_bytes();
    let mut end = bytes.len();
    while end > 0 && bytes.len() - end < 2 && bytes[end - 1] == b'=' {
        end -= 1;
    }
    if end == 0 {
        return false;
    }
    bytes[..end]
        .iter()
        .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'+' || *byte == b'/')
}

#[cfg(test)]
mod tests {
    use super::{base64_data_url, is_base64};

    #[test]
    fn screenshot_data_url_yields_media_type_and_exact_base64_bytes() {
        // Same shape as the TypeScript case: 5 MiB of patterned bytes.
        let mut bytes = vec![0u8; 5 * 1024 * 1024];
        for (i, byte) in bytes.iter_mut().enumerate() {
            *byte = ((i * 31 + (i >> 10)) % 256) as u8;
        }
        let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes);
        let url = format!("data:image/png;base64,{encoded}");
        let image = base64_data_url(&url).expect("screenshot URL parses");
        assert_eq!(image.mime_type, "image/png");
        assert_eq!(image.data, encoded);
        assert!(is_base64(image.data));
    }

    #[test]
    fn data_urls_that_are_not_plain_base64_with_one_media_type_are_refused() {
        assert_eq!(base64_data_url("https://example.com/a.png"), None);
        assert_eq!(base64_data_url("data:image/png,rawbytes"), None);
        assert_eq!(base64_data_url("data:;base64,AAAA"), None);
        assert_eq!(
            base64_data_url("data:image/png;name=a.png;base64,AAAA"),
            None
        );
        assert_eq!(
            base64_data_url("data:image/png;base64,"),
            Some(super::Base64DataUrl {
                mime_type: "image/png",
                data: ""
            })
        );
    }

    #[test]
    fn base64_text_allows_two_pads_and_nothing_outside_the_alphabet() {
        assert!(is_base64("QUJD"));
        assert!(is_base64("QUI="));
        assert!(is_base64("QQ=="));
        assert!(!is_base64("Q==="));
        assert!(!is_base64("QU=I"));
        assert!(!is_base64("QU I"));
        assert!(!is_base64("QU-_"));
        assert!(!is_base64("=="));
        assert!(!is_base64(""));
    }
}
