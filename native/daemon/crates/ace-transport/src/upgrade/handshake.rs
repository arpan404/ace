// SPDX-License-Identifier: Apache-2.0
//! `ws` 8.22's `handleUpgrade` and `abortHandshake` as a pure decision table:
//! the checks in its order, the exact bytes of every refusal and of the `101`,
//! and the request-header view Node builds. No socket, no timer.

use bytes::Bytes;
use http::{HeaderValue, Response, StatusCode, header};
use http_body_util::Full;
use tungstenite::handshake::derive_accept_key;

use crate::head::RequestHead;

use super::number::js_number;

/// An `abortHandshake` refusal: status, its three headers in `ws`'s order, the
/// version field only on the version row, then the message as the body.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct Refusal {
    status: StatusCode,
    message: &'static str,
    version_field: bool,
}

impl Refusal {
    pub(super) const INVALID_METHOD: Self = Self {
        status: StatusCode::METHOD_NOT_ALLOWED,
        message: "Invalid HTTP method",
        version_field: false,
    };
    pub(super) const INVALID_UPGRADE: Self = Self {
        status: StatusCode::BAD_REQUEST,
        message: "Invalid Upgrade header",
        version_field: false,
    };
    pub(super) const INVALID_KEY: Self = Self {
        status: StatusCode::BAD_REQUEST,
        message: "Missing or invalid Sec-WebSocket-Key header",
        version_field: false,
    };
    pub(super) const INVALID_VERSION: Self = Self {
        status: StatusCode::BAD_REQUEST,
        message: "Missing or invalid Sec-WebSocket-Version header",
        version_field: true,
    };
    pub(super) const INVALID_PROTOCOL: Self = Self {
        status: StatusCode::BAD_REQUEST,
        message: "Invalid Sec-WebSocket-Protocol header",
        version_field: false,
    };
    /// `completeUpgrade`'s `abortHandshake(socket, 503)` when the server closes.
    pub(super) const CLOSING: Self = Self {
        status: StatusCode::SERVICE_UNAVAILABLE,
        message: "Service Unavailable",
        version_field: false,
    };

    /// The bytes `abortHandshake` writes, for the raw path.
    pub(super) fn bytes(&self) -> Vec<u8> {
        let reason = self.status.canonical_reason().unwrap_or_default();
        let mut answer = format!(
            "HTTP/1.1 {} {reason}\r\nConnection: close\r\nContent-Type: text/html\r\nContent-Length: {}\r\n",
            self.status.as_u16(),
            self.message.len()
        );
        if self.version_field {
            answer.push_str("Sec-WebSocket-Version: 13, 8\r\n");
        }
        answer.push_str("\r\n");
        answer.push_str(self.message);
        answer.into_bytes()
    }

    /// The same answer for hyper to frame; a `HEAD`'s body becomes zero bytes
    /// there (the recorded difference).
    pub(super) fn response(&self) -> Response<Full<Bytes>> {
        let mut response = Response::new(Full::new(Bytes::from(self.message.as_bytes())));
        *response.status_mut() = self.status;
        let headers = response.headers_mut();
        headers.insert(header::CONNECTION, HeaderValue::from_static("close"));
        headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/html"));
        if let Ok(length) = HeaderValue::from_str(&self.message.len().to_string()) {
            headers.insert(header::CONTENT_LENGTH, length);
        }
        if self.version_field {
            headers.insert(
                header::SEC_WEBSOCKET_VERSION,
                HeaderValue::from_static("13, 8"),
            );
        }
        response
    }
}

/// `refuseUpgrade`'s empty-body answer, framed by hyper.
pub(super) fn empty_response(status: StatusCode) -> Response<Full<Bytes>> {
    let mut response = Response::new(Full::new(Bytes::new()));
    *response.status_mut() = status;
    let headers = response.headers_mut();
    headers.insert(header::CONNECTION, HeaderValue::from_static("close"));
    headers.insert(header::CONTENT_LENGTH, HeaderValue::from_static("0"));
    response
}

/// A handshake that passed every check: the accept digest and, when the client
/// offered one, the first protocol (`ws`'s default selection).
pub(super) struct Acceptance {
    digest: String,
    protocol: Option<String>,
}

impl Acceptance {
    pub(super) fn bytes(&self) -> Vec<u8> {
        let mut answer = format!(
            "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {}\r\n",
            self.digest
        );
        if let Some(protocol) = &self.protocol {
            answer.push_str(&format!("Sec-WebSocket-Protocol: {protocol}\r\n"));
        }
        answer.push_str("\r\n");
        answer.into_bytes()
    }

    pub(super) fn response(&self) -> Response<Full<Bytes>> {
        let mut response = Response::new(Full::new(Bytes::new()));
        *response.status_mut() = StatusCode::SWITCHING_PROTOCOLS;
        let headers = response.headers_mut();
        headers.insert(header::UPGRADE, HeaderValue::from_static("websocket"));
        headers.insert(header::CONNECTION, HeaderValue::from_static("Upgrade"));
        if let Ok(digest) = HeaderValue::from_str(&self.digest) {
            headers.insert(header::SEC_WEBSOCKET_ACCEPT, digest);
        }
        if let Some(protocol) = &self.protocol
            && let Ok(value) = HeaderValue::from_str(protocol)
        {
            headers.insert(header::SEC_WEBSOCKET_PROTOCOL, value);
        }
        response
    }
}

/// `ws`'s checks, in `handleUpgrade`'s order: method, Upgrade, key, version,
/// then the protocol list.
pub(super) fn handshake(head: &RequestHead) -> Result<Acceptance, Refusal> {
    if head.method != "GET" {
        return Err(Refusal::INVALID_METHOD);
    }
    let upgrade = node_header(&head.headers, "upgrade");
    if !upgrade
        .as_deref()
        .is_some_and(|value| value.eq_ignore_ascii_case(b"websocket"))
    {
        return Err(Refusal::INVALID_UPGRADE);
    }
    let Some(key) = node_header(&head.headers, "sec-websocket-key").filter(|key| valid_key(key))
    else {
        return Err(Refusal::INVALID_KEY);
    };
    if !node_header(&head.headers, "sec-websocket-version")
        .as_deref()
        .is_some_and(version_13_or_8)
    {
        return Err(Refusal::INVALID_VERSION);
    }
    let protocol = match node_header(&head.headers, "sec-websocket-protocol") {
        None => None,
        Some(value) => Some(parse_protocols(&value).ok_or(Refusal::INVALID_PROTOCOL)?),
    };
    Ok(Acceptance {
        digest: derive_accept_key(&key),
        protocol,
    })
}

/// The value Node's `req.headers` holds for `name`: the field's values joined
/// with `", "`, or only the first for the fields whose duplicates Node
/// discards (`user-agent` among them).
pub(super) fn node_header(headers: &[(String, Vec<u8>)], name: &str) -> Option<Vec<u8>> {
    let mut values = headers
        .iter()
        .filter(|(field, _)| field.eq_ignore_ascii_case(name))
        .map(|(_, value)| value);
    let first = values.next()?.clone();
    if duplicates_are_discarded(name) {
        return Some(first);
    }
    let mut joined = first;
    for value in values {
        joined.extend_from_slice(b", ");
        joined.extend_from_slice(value);
    }
    Some(joined)
}

/// Node's list of fields whose duplicate values are dropped, keeping the first.
fn duplicates_are_discarded(name: &str) -> bool {
    const DISCARDED: [&str; 18] = [
        "age",
        "authorization",
        "content-length",
        "content-type",
        "etag",
        "expires",
        "from",
        "host",
        "if-modified-since",
        "if-unmodified-since",
        "last-modified",
        "location",
        "max-forwards",
        "proxy-authorization",
        "referer",
        "retry-after",
        "server",
        "user-agent",
    ];
    DISCARDED
        .iter()
        .any(|discarded| name.eq_ignore_ascii_case(discarded))
}

/// `ws`'s key pattern, `^[+/0-9A-Za-z]{22}==$`.
fn valid_key(key: &[u8]) -> bool {
    key.len() == 24
        && key[22..] == *b"=="
        && key[..22]
            .iter()
            .all(|byte| matches!(byte, b'+' | b'/' | b'0'..=b'9' | b'A'..=b'Z' | b'a'..=b'z'))
}

/// `ws` reads `+req.headers['sec-websocket-version']` and compares with 13 and
/// 8, so the value goes through JavaScript's `Number()` (`"0xd"` is 13,
/// `"+0xd"` is not a number).
pub(super) fn version_13_or_8(value: &[u8]) -> bool {
    let number = js_number(&latin1(value));
    number == 13.0 || number == 8.0
}

/// A header value as Node decodes it: one character per byte (latin1).
pub(super) fn latin1(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| char::from(*byte)).collect()
}

/// `ws`'s `subprotocol.parse`: a comma-separated list of tokens, spaces and
/// tabs allowed around each; returns the first protocol.
fn parse_protocols(value: &[u8]) -> Option<String> {
    let mut start: Option<usize> = None;
    let mut end: Option<usize> = None;
    let mut seen: Vec<&[u8]> = Vec::new();
    let mut first: Option<String> = None;
    for (index, &byte) in value.iter().enumerate() {
        if end.is_none() && is_token(byte) {
            start.get_or_insert(index);
        } else if index != 0 && (byte == b' ' || byte == b'\t') {
            if end.is_none() && start.is_some() {
                end = Some(index);
            }
        } else if byte == b',' {
            let protocol = &value[start?..end.unwrap_or(index)];
            if seen.contains(&protocol) {
                return None;
            }
            seen.push(protocol);
            first.get_or_insert_with(|| latin1(protocol));
            start = None;
            end = None;
        } else {
            return None;
        }
    }
    let protocol = &value[start?..];
    if end.is_some() || seen.contains(&protocol) {
        return None;
    }
    first.get_or_insert_with(|| latin1(protocol));
    first
}

/// An RFC 9110 token character, `ws`'s `tokenChars`.
fn is_token(byte: u8) -> bool {
    byte.is_ascii_alphanumeric()
        || matches!(
            byte,
            b'!' | b'#'
                | b'$'
                | b'%'
                | b'&'
                | b'\''
                | b'*'
                | b'+'
                | b'-'
                | b'.'
                | b'^'
                | b'_'
                | b'`'
                | b'|'
                | b'~'
        )
}
