// SPDX-License-Identifier: Apache-2.0
//! Pure HTTP/1.1 response parser, chunked decoder, and access error mapper.

use std::io::{BufRead, ErrorKind, Read};

use serde::Deserialize;
use serde_json::value::RawValue;

use crate::error::WireError;
use crate::http::{HttpResponse, MAX_HTTP_HEADER_BYTES, MAX_HTTP_RESPONSE_BYTES};
use crate::stream::classify_io_error;

/// Maximum character length kept from a daemon HTTP error JSON body (`detail.slice(0, 512)`).
const MAX_ERROR_DETAIL_CHARS: usize = 512;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BodyFraming {
    ContentLength(usize),
    Chunked,
    UntilEof,
}

/// Reads and frames an HTTP/1.1 response from `reader`, enforcing header and 1 MiB body bounds.
pub fn read_http_response<R: BufRead>(reader: &mut R) -> Result<(u16, Vec<u8>), WireError> {
    let header_block = read_header_block(reader)?;
    let (status, framing) = parse_response_head(&header_block)?;
    let body = match framing {
        BodyFraming::ContentLength(len) => read_exact_bounded(reader, len)?,
        BodyFraming::Chunked => read_chunked_body(reader)?,
        BodyFraming::UntilEof => read_until_eof_bounded(reader)?,
    };
    Ok((status, body))
}

fn read_header_block<R: BufRead>(reader: &mut R) -> Result<String, WireError> {
    let mut raw = Vec::with_capacity(512);
    let mut line = Vec::with_capacity(128);
    loop {
        line.clear();
        let n = reader
            .read_until(b'\n', &mut line)
            .map_err(|err| classify_io_error(&err, "Request"))?;
        if n == 0 {
            return Err(WireError::Offline {
                detail: "Connection closed before HTTP headers completed".into(),
            });
        }
        if raw.len().saturating_add(n) > MAX_HTTP_HEADER_BYTES {
            return Err(WireError::Limit {
                detail: "HTTP response headers too large".into(),
            });
        }
        if line == b"\r\n" || line == b"\n" {
            break;
        }
        raw.extend_from_slice(&line);
    }
    String::from_utf8(raw).map_err(|_| WireError::Protocol {
        detail: "HTTP response headers are not valid UTF-8".into(),
    })
}

fn parse_response_head(head: &str) -> Result<(u16, BodyFraming), WireError> {
    let mut lines = head.lines();
    let status_line = lines.next().ok_or_else(|| WireError::Protocol {
        detail: "Empty HTTP response".into(),
    })?;
    let status = parse_status_line(status_line)?;

    let mut content_length: Option<usize> = None;
    let mut chunked = false;

    for raw_line in lines {
        let line = raw_line.trim_end_matches('\r');
        let (name, value) = line.split_once(':').ok_or_else(|| WireError::Protocol {
            detail: "Malformed HTTP response header".into(),
        })?;
        let name = name.trim();
        let value = value.trim();

        if name.eq_ignore_ascii_case("transfer-encoding") {
            let mut saw_chunked = false;
            for coding in value.split(',').map(str::trim).filter(|s| !s.is_empty()) {
                if coding.eq_ignore_ascii_case("chunked") {
                    saw_chunked = true;
                } else {
                    return Err(WireError::Protocol {
                        detail: format!("Unsupported HTTP transfer-encoding: {coding}"),
                    });
                }
            }
            if saw_chunked {
                chunked = true;
            }
        } else if name.eq_ignore_ascii_case("content-length") {
            let parsed: usize = value.parse().map_err(|_| WireError::Protocol {
                detail: "Invalid HTTP Content-Length header".into(),
            })?;
            if let Some(prev) = content_length
                && prev != parsed
            {
                return Err(WireError::Protocol {
                    detail: "Conflicting HTTP Content-Length headers".into(),
                });
            }
            if parsed > MAX_HTTP_RESPONSE_BYTES {
                return Err(WireError::Limit {
                    detail: "Response too large".into(),
                });
            }
            content_length = Some(parsed);
        }
    }

    if chunked && content_length.is_some() {
        return Err(WireError::Protocol {
            detail: "HTTP response carries both Transfer-Encoding and Content-Length".into(),
        });
    }

    let framing = if chunked {
        BodyFraming::Chunked
    } else if let Some(len) = content_length {
        BodyFraming::ContentLength(len)
    } else {
        BodyFraming::UntilEof
    };

    Ok((status, framing))
}

fn parse_status_line(line: &str) -> Result<u16, WireError> {
    let line = line.trim_end_matches('\r');
    let mut parts = line.splitn(3, ' ');
    let version = parts.next().unwrap_or("");
    let code_str = parts.next().unwrap_or("");
    if !(version == "HTTP/1.1" || version == "HTTP/1.0") || code_str.len() != 3 {
        return Err(WireError::Protocol {
            detail: "Invalid HTTP status line".into(),
        });
    }
    code_str.parse::<u16>().map_err(|_| WireError::Protocol {
        detail: "Invalid HTTP status code".into(),
    })
}

fn read_exact_bounded<R: Read>(reader: &mut R, len: usize) -> Result<Vec<u8>, WireError> {
    if len > MAX_HTTP_RESPONSE_BYTES {
        return Err(WireError::Limit {
            detail: "Response too large".into(),
        });
    }
    let mut body = vec![0u8; len];
    reader.read_exact(&mut body).map_err(|err| {
        if err.kind() == ErrorKind::UnexpectedEof {
            WireError::Offline {
                detail: "HTTP response truncated before Content-Length".into(),
            }
        } else {
            classify_io_error(&err, "Request")
        }
    })?;
    Ok(body)
}

fn read_until_eof_bounded<R: Read>(reader: &mut R) -> Result<Vec<u8>, WireError> {
    let mut body = Vec::with_capacity(512);
    let mut buf = [0u8; 4096];
    loop {
        let n = reader
            .read(&mut buf)
            .map_err(|err| classify_io_error(&err, "Request"))?;
        if n == 0 {
            break;
        }
        if body.len().saturating_add(n) > MAX_HTTP_RESPONSE_BYTES {
            return Err(WireError::Limit {
                detail: "Response too large".into(),
            });
        }
        body.extend_from_slice(&buf[..n]);
    }
    Ok(body)
}

fn read_chunked_body<R: BufRead>(reader: &mut R) -> Result<Vec<u8>, WireError> {
    let mut body = Vec::with_capacity(512);
    let mut line = Vec::with_capacity(64);
    loop {
        line.clear();
        let n = reader
            .read_until(b'\n', &mut line)
            .map_err(|err| classify_io_error(&err, "Request"))?;
        if n == 0 {
            return Err(WireError::Offline {
                detail: "Chunked HTTP response ended unexpectedly".into(),
            });
        }
        let line_str = std::str::from_utf8(&line).map_err(|_| WireError::Protocol {
            detail: "Invalid UTF-8 in HTTP chunk header".into(),
        })?;
        let trimmed = line_str.trim_end_matches(['\r', '\n']);
        let size_hex = trimmed.split(';').next().unwrap_or("").trim();
        if size_hex.is_empty() || size_hex.len() > 16 {
            return Err(WireError::Protocol {
                detail: "Invalid HTTP chunk size".into(),
            });
        }
        let chunk_size = usize::from_str_radix(size_hex, 16).map_err(|_| WireError::Protocol {
            detail: "Invalid HTTP chunk size".into(),
        })?;
        if chunk_size == 0 {
            drain_chunk_trailers(reader)?;
            return Ok(body);
        }
        let new_len = body
            .len()
            .checked_add(chunk_size)
            .ok_or_else(|| WireError::Limit {
                detail: "Response too large".into(),
            })?;
        if new_len > MAX_HTTP_RESPONSE_BYTES {
            return Err(WireError::Limit {
                detail: "Response too large".into(),
            });
        }
        let start = body.len();
        body.resize(new_len, 0);
        reader.read_exact(&mut body[start..]).map_err(|err| {
            if err.kind() == ErrorKind::UnexpectedEof {
                WireError::Offline {
                    detail: "Chunked HTTP payload truncated".into(),
                }
            } else {
                classify_io_error(&err, "Request")
            }
        })?;
        let mut crlf = [0u8; 2];
        reader
            .read_exact(&mut crlf)
            .map_err(|err| classify_io_error(&err, "Request"))?;
        if crlf != *b"\r\n" {
            return Err(WireError::Protocol {
                detail: "Missing CRLF after HTTP chunk payload".into(),
            });
        }
    }
}

fn drain_chunk_trailers<R: BufRead>(reader: &mut R) -> Result<(), WireError> {
    let mut line = Vec::with_capacity(64);
    let mut total = 0usize;
    loop {
        line.clear();
        let n = reader
            .read_until(b'\n', &mut line)
            .map_err(|err| classify_io_error(&err, "Request"))?;
        if n == 0 || line == b"\r\n" || line == b"\n" {
            return Ok(());
        }
        total = total.saturating_add(n);
        if total > MAX_HTTP_HEADER_BYTES {
            return Err(WireError::Limit {
                detail: "HTTP chunk trailers too large".into(),
            });
        }
    }
}

#[derive(Deserialize)]
struct AccessFailureBody<'a> {
    #[serde(borrow)]
    error: Option<&'a str>,
}

/// Converts a framed HTTP status and body into [`HttpResponse`] or a mapped [`WireError`].
///
/// Matches `accessFailure` (`apps/daemon/src/client-access.ts`) and `accessResponseError`
/// (`packages/client/src/access-http.ts`).
pub fn finish_http_response(status: u16, body: Vec<u8>) -> Result<HttpResponse, WireError> {
    let text = String::from_utf8(body).map_err(|_| WireError::Protocol {
        detail: "HTTP response body is not valid UTF-8".into(),
    })?;
    if status != 200 {
        let detail = serde_json::from_str::<AccessFailureBody<'_>>(&text)
            .ok()
            .and_then(|parsed| parsed.error)
            .filter(|msg| !msg.is_empty())
            .map_or_else(
                || format!("HTTP {status}"),
                |msg| {
                    let truncated: String = msg.chars().take(MAX_ERROR_DETAIL_CHARS).collect();
                    format!("HTTP {status}: {truncated}")
                },
            );
        return Err(match status {
            401 | 403 => WireError::Auth {
                detail,
                revoked: false,
            },
            429 | 500..=599 => WireError::Offline { detail },
            _ => WireError::Daemon {
                code: format!("http_{status}"),
                message: detail,
            },
        });
    }
    let raw = RawValue::from_string(text).map_err(|_| WireError::Protocol {
        detail: "Invalid JSON response".into(),
    })?;
    Ok(HttpResponse::new(status, raw))
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::*;

    #[derive(Deserialize)]
    struct PartialHealth<'a> {
        running: bool,
        ready: bool,
        #[serde(borrow)]
        version: &'a str,
    }

    #[test]
    fn content_length_response_preserves_raw_json_and_borrows_on_decode() {
        let raw_http = concat!(
            "HTTP/1.1 200 OK\r\n",
            "Content-Type: application/json\r\n",
            "Content-Length: 59\r\n",
            "\r\n",
            "{\"running\":true,\"ready\":true,\"version\":\"1.2\",\"extra\":12345}"
        );
        let mut cursor = Cursor::new(raw_http.as_bytes());
        let (status, body) = read_http_response(&mut cursor).unwrap();
        let response = finish_http_response(status, body).unwrap();
        assert_eq!(response.status(), 200);
        let decoded: PartialHealth<'_> = response.decode().unwrap();
        assert!(decoded.running);
        assert!(decoded.ready);
        assert_eq!(decoded.version, "1.2");
    }

    #[test]
    fn chunked_response_decodes_extensions_and_trailers() {
        let raw_http = concat!(
            "HTTP/1.1 200 OK\r\n",
            "Transfer-Encoding: chunked\r\n",
            "\r\n",
            "a;ext=1\r\n",
            "{\"ok\":true\r\n",
            "11\r\n",
            ",\"version\":\"1.0\"}\r\n",
            "0\r\n",
            "X-Trailer: ignored\r\n",
            "\r\n"
        );
        let mut cursor = Cursor::new(raw_http.as_bytes());
        let (status, body) = read_http_response(&mut cursor).unwrap();
        let response = finish_http_response(status, body).unwrap();
        assert_eq!(response.as_str(), "{\"ok\":true,\"version\":\"1.0\"}");
    }

    #[test]
    fn response_over_1_mib_fails_with_limit() {
        let oversized = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n",
            MAX_HTTP_RESPONSE_BYTES + 1
        );
        let mut cursor = Cursor::new(oversized.as_bytes());
        let err = read_http_response(&mut cursor).unwrap_err();
        assert!(matches!(err, WireError::Limit { .. }));
    }

    #[test]
    fn rejects_conflicting_framing_headers() {
        let raw = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Length: 2\r\n\r\n{}";
        let mut cursor = Cursor::new(raw.as_bytes());
        let err = read_http_response(&mut cursor).unwrap_err();
        assert!(matches!(err, WireError::Protocol { .. }));
    }

    #[test]
    fn non_200_statuses_map_like_ts_access_failure() {
        let auth = finish_http_response(401, br#"{"error":"Device token required"}"#.to_vec())
            .unwrap_err();
        assert_eq!(
            auth,
            WireError::Auth {
                detail: "HTTP 401: Device token required".into(),
                revoked: false,
            }
        );
        assert_eq!(auth.exit_code(), 4);

        let forbidden = finish_http_response(403, b"not json".to_vec()).unwrap_err();
        assert_eq!(
            forbidden,
            WireError::Auth {
                detail: "HTTP 403".into(),
                revoked: false,
            }
        );

        let unavailable =
            finish_http_response(503, br#"{"error":"Starting"}"#.to_vec()).unwrap_err();
        assert!(matches!(unavailable, WireError::Offline { .. }));
        assert_eq!(unavailable.exit_code(), 5);

        let bad_req = finish_http_response(400, br#"{"error":"Turn on remote access"}"#.to_vec())
            .unwrap_err();
        assert_eq!(
            bad_req,
            WireError::Daemon {
                code: "http_400".into(),
                message: "HTTP 400: Turn on remote access".into(),
            }
        );
    }
}
