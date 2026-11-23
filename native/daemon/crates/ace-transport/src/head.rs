// SPDX-License-Identifier: Apache-2.0
//! The driver's peek at a connection's first request head: `httparse` over at
//! most Node's 16 KiB of headers, the request-target exactly as received, and
//! the two refusals Node writes for a head it cannot accept. Pure: no socket,
//! no timer, no clock.

use httparse::Error as ParseError;
use httparse::Status;

/// Node's `maxHeaderSize`: a head that needs more than this gets 431.
pub const MAX_HEAD_BYTES: usize = 16 * 1024;

/// How many header fields the peek keeps. hyper's server refuses more than 100
/// of its own, so the peek must not be the lower limit.
const MAX_HEADERS: usize = 256;

/// What Node answers for a head over [`MAX_HEAD_BYTES`], then closes.
pub const TOO_LARGE: &[u8] =
    b"HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\n\r\n";

/// What Node answers for a head that does not parse, then closes.
pub const BAD_REQUEST: &[u8] = b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n";

/// A connection's first request head, as received.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestHead {
    pub method: String,
    /// The request-target exactly as received: `/`, `/?x`, `//` and
    /// absolute-form stay distinct.
    pub target: String,
    /// Every field, in order, with its value as received.
    pub headers: Vec<(String, Vec<u8>)>,
}

/// What a buffer holds so far.
#[derive(Debug)]
pub enum Parsed {
    /// A complete head and the bytes it took.
    Head(RequestHead, usize),
    /// A head that is not complete yet, within the size limit.
    Incomplete,
    /// A head that would exceed [`MAX_HEAD_BYTES`] or one with too many fields.
    TooLarge,
    /// Bytes that are not an HTTP/1 request head.
    Malformed,
}

/// Parse as much of a request head as `buf` holds.
pub fn parse(buf: &[u8]) -> Parsed {
    let mut headers = [httparse::EMPTY_HEADER; MAX_HEADERS];
    let mut request = httparse::Request::new(&mut headers);
    match request.parse(buf) {
        Ok(Status::Complete(consumed)) => {
            if consumed > MAX_HEAD_BYTES {
                return Parsed::TooLarge;
            }
            let (Some(method), Some(target)) = (request.method, request.path) else {
                return Parsed::Malformed;
            };
            let headers = request
                .headers
                .iter()
                .map(|field| (field.name.to_owned(), field.value.to_vec()))
                .collect();
            Parsed::Head(
                RequestHead {
                    method: method.to_owned(),
                    target: target.to_owned(),
                    headers,
                },
                consumed,
            )
        }
        Ok(Status::Partial) => {
            if buf.len() >= MAX_HEAD_BYTES {
                Parsed::TooLarge
            } else {
                Parsed::Incomplete
            }
        }
        // Node answers 431 for a head with too many fields as well.
        Err(ParseError::TooManyHeaders) => Parsed::TooLarge,
        Err(_) => Parsed::Malformed,
    }
}

/// Whether Node's `upgrade` event would fire for this head: it carries an
/// `Upgrade` field and names `upgrade` among its `Connection` tokens.
pub fn is_upgrade_candidate(head: &RequestHead) -> bool {
    let has_upgrade = head
        .headers
        .iter()
        .any(|(name, _)| name.eq_ignore_ascii_case("upgrade"));
    has_upgrade
        && connection_names(&head.headers)
            .iter()
            .any(|name| name == "upgrade")
}

/// Every token every `Connection` field names, lower-cased. These headers are
/// hop-by-hop: hyper frames each leg itself, so neither direction forwards them
/// (RFC 9110 §7.6.1).
pub fn connection_names(headers: &[(String, Vec<u8>)]) -> Vec<String> {
    let mut names = Vec::new();
    for (name, value) in headers {
        if !name.eq_ignore_ascii_case("connection") {
            continue;
        }
        let text = String::from_utf8_lossy(value);
        for token in text.split(',') {
            let token = token.trim();
            if !token.is_empty() {
                names.push(token.to_ascii_lowercase());
            }
        }
    }
    names
}

#[cfg(test)]
mod tests {
    use super::*;

    fn head(raw: &str) -> RequestHead {
        match parse(raw.as_bytes()) {
            Parsed::Head(head, consumed) => {
                assert_eq!(consumed, raw.len(), "the peek consumed the whole head");
                head
            }
            other => panic!("expected a complete head, got {other:?}"),
        }
    }

    #[test]
    fn keeps_the_request_target_exactly_as_received() {
        for target in ["/", "/?x", "//", "http://127.0.0.1:7842/a?b"] {
            let raw = format!("GET {target} HTTP/1.1\r\nHost: localhost\r\n\r\n");
            assert_eq!(head(&raw).target, target);
        }
    }

    #[test]
    fn keeps_header_values_as_received() {
        let raw = "POST /a HTTP/1.1\r\nx-ace-sha256: 00ff\r\nx-dup: one\r\nx-dup: two\r\n\r\n";
        let parsed = head(raw);
        assert_eq!(parsed.method, "POST");
        assert_eq!(
            parsed.headers,
            vec![
                ("x-ace-sha256".to_owned(), b"00ff".to_vec()),
                ("x-dup".to_owned(), b"one".to_vec()),
                ("x-dup".to_owned(), b"two".to_vec()),
            ]
        );
    }

    #[test]
    fn a_head_without_a_terminator_is_incomplete_within_the_limit() {
        assert!(matches!(
            parse(b"GET / HTTP/1.1\r\nHost: localhost\r\n"),
            Parsed::Incomplete
        ));
    }

    #[test]
    fn an_upgrade_candidate_needs_both_the_header_and_the_connection_token() {
        let both =
            head("GET / HTTP/1.1\r\nUpgrade: websocket\r\nConnection: keep-alive, Upgrade\r\n\r\n");
        assert!(is_upgrade_candidate(&both));

        let header_only =
            head("GET / HTTP/1.1\r\nUpgrade: websocket\r\nConnection: keep-alive\r\n\r\n");
        assert!(!is_upgrade_candidate(&header_only));

        let token_only = head("GET / HTTP/1.1\r\nConnection: upgrade\r\n\r\n");
        assert!(!is_upgrade_candidate(&token_only));
    }

    #[test]
    fn an_upgrade_header_in_any_case_counts() {
        let raw = "GET / HTTP/1.1\r\nUPGRADE: WebSocket\r\nCONNECTION: Upgrade\r\n\r\n";
        assert!(is_upgrade_candidate(&head(raw)));
    }

    #[test]
    fn a_head_past_sixteen_kib_is_too_large() {
        let mut raw = String::from("GET / HTTP/1.1\r\n");
        while raw.len() < MAX_HEAD_BYTES {
            raw.push_str("x-pad: 0123456789abcdef0123456789abcdef\r\n");
        }
        assert!(matches!(parse(raw.as_bytes()), Parsed::TooLarge));
    }

    #[test]
    fn bytes_that_are_not_a_request_head_are_malformed() {
        assert!(matches!(
            parse(b"this is not http\r\n\r\n"),
            Parsed::Malformed
        ));
        assert!(matches!(
            parse(b"GET / HTTP/1.1\r\nbad field\r\n\r\n"),
            Parsed::Malformed
        ));
    }
}
