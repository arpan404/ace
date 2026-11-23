// SPDX-License-Identifier: Apache-2.0
//! Low-level WebSocket frame I/O and error classification helpers for [`crate::Connection`].
//!
//! Uses [`FrameBuffer`] backed directly by `tungstenite::Utf8Bytes` with a byte cursor so neither
//! incoming text frames nor `\n`-packed lines incur intermediate `String` copies or allocations.

use std::ops::Range;
use std::time::Instant;

use tungstenite::handshake::client::ClientHandshake;
use tungstenite::{HandshakeError, Message, Utf8Bytes, WebSocket};

use crate::error::WireError;
use crate::protocol::{
    MAX_FRAME_BYTES, ServerEnvelope, classify_close_code, is_credential_replaced_close,
    is_machine_code_refusal,
};
use crate::stream::{TransportStream, classify_io_error};

/// Zero-copy line iterator over the most recently received WebSocket text frame.
pub(crate) struct FrameBuffer {
    frame: Utf8Bytes,
    cursor: usize,
}

impl FrameBuffer {
    pub(crate) const fn new() -> Self {
        Self {
            frame: Utf8Bytes::from_static(""),
            cursor: 0,
        }
    }

    /// Advances to the next non-empty `\n`-delimited byte range in the currently held frame
    /// without allocating, or returns `None` when the current frame is exhausted.
    fn next_buffered_range(&mut self) -> Option<Range<usize>> {
        let full = self.frame.as_str();
        while self.cursor < full.len() {
            let start = self.cursor;
            let rest = &full[start..];
            let (end, next_cursor) = match rest.find('\n') {
                Some(idx) => (start + idx, start + idx + 1),
                None => (full.len(), full.len()),
            };
            self.cursor = next_cursor;
            if start < end {
                return Some(start..end);
            }
        }
        None
    }

    /// Replaces the held frame without copying its bytes and resets the cursor.
    fn load(&mut self, frame: Utf8Bytes) {
        self.frame = frame;
        self.cursor = 0;
    }
}

/// Outcome of reading a frame during open/handshake so `open_remote_with_tls` can retry once on
/// `4001 Credential replaced` before surfacing [`WireError::Auth`] (`refused`, exit 4).
pub(crate) enum ReadError {
    CredentialReplaced,
    Wire(WireError),
}

impl From<WireError> for ReadError {
    fn from(err: WireError) -> Self {
        Self::Wire(err)
    }
}

pub(crate) fn send_text(
    ws: &mut WebSocket<TransportStream>,
    payload: &str,
    deadline: Instant,
    context: &'static str,
) -> Result<(), WireError> {
    ws.get_mut().set_deadline(deadline, context)?;
    ws.send(Message::Text(payload.into()))
        .map_err(|err| classify_ws_error(err, context))
}

/// Reads the next non-empty text line from `buffer` or the WebSocket without copying the frame.
pub(crate) fn read_next_line<'a>(
    ws: &mut WebSocket<TransportStream>,
    buffer: &'a mut FrameBuffer,
    deadline: Instant,
    context: &'static str,
    ignore_binary: bool,
) -> Result<&'a str, ReadError> {
    if let Some(range) = buffer.next_buffered_range() {
        return Ok(&buffer.frame.as_str()[range]);
    }

    loop {
        ws.get_mut().set_deadline(deadline, context)?;
        match ws.read() {
            Ok(Message::Text(text)) => {
                if text.len() > MAX_FRAME_BYTES {
                    return Err(ReadError::Wire(WireError::Limit {
                        detail: "Server frame exceeded size limit".into(),
                    }));
                }
                buffer.load(text);
                if let Some(range) = buffer.next_buffered_range() {
                    return Ok(&buffer.frame.as_str()[range]);
                }
            }
            Ok(Message::Ping(payload)) => {
                ws.get_mut().set_deadline(deadline, context)?;
                ws.send(Message::Pong(payload))
                    .map_err(|err| ReadError::Wire(classify_ws_error(err, context)))?;
            }
            Ok(Message::Pong(_) | Message::Frame(_)) => {}
            Ok(Message::Binary(_)) => {
                if !ignore_binary {
                    return Err(ReadError::Wire(WireError::Protocol {
                        detail: "Unexpected binary frame before welcome".into(),
                    }));
                }
            }
            Ok(Message::Close(frame)) => {
                return Err(match frame {
                    Some(cf)
                        if is_credential_replaced_close(u16::from(cf.code), cf.reason.as_str()) =>
                    {
                        ReadError::CredentialReplaced
                    }
                    Some(cf) => {
                        ReadError::Wire(classify_close_code(u16::from(cf.code), cf.reason.as_str()))
                    }
                    None => ReadError::Wire(WireError::Offline {
                        detail: "Daemon closed connection".into(),
                    }),
                });
            }
            Err(err) => return Err(ReadError::Wire(classify_ws_error(err, context))),
        }
    }
}

pub(crate) fn handshake_error_frame(envelope: &ServerEnvelope<'_>) -> WireError {
    let code = envelope.code.as_deref().unwrap_or("daemon");
    let message = envelope.message.as_deref().unwrap_or("");
    if code == "unauthorized" {
        return WireError::Auth {
            detail: if message.is_empty() {
                "Unauthorized".into()
            } else {
                message.to_owned()
            },
            revoked: false,
        };
    }
    if is_machine_code_refusal(code) {
        return WireError::MachineCode {
            code: code.to_owned(),
            locked_until: envelope.locked_until,
        };
    }
    WireError::Daemon {
        code: code.to_owned(),
        message: message.to_owned(),
    }
}

pub(crate) fn classify_handshake_error(
    err: HandshakeError<ClientHandshake<TransportStream>>,
    context: &'static str,
) -> WireError {
    match err {
        HandshakeError::Interrupted(_) => WireError::Offline {
            detail: "WebSocket handshake interrupted".into(),
        },
        HandshakeError::Failure(ws_err) => classify_ws_error(ws_err, context),
    }
}

pub(crate) fn classify_ws_error(err: tungstenite::Error, context: &'static str) -> WireError {
    match err {
        tungstenite::Error::Io(io_err) => classify_io_error(&io_err, context),
        tungstenite::Error::Capacity(cap) => WireError::Limit {
            detail: cap.to_string(),
        },
        tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed => {
            WireError::Offline {
                detail: "Daemon connection closed".into(),
            }
        }
        tungstenite::Error::Http(resp) => {
            let status = resp.status().as_u16();
            if status == 401 || status == 403 {
                WireError::Auth {
                    detail: format!("HTTP {status}"),
                    revoked: false,
                }
            } else if status == 429 || status >= 500 {
                WireError::Offline {
                    detail: format!("HTTP {status}"),
                }
            } else {
                WireError::Protocol {
                    detail: format!("WebSocket upgrade failed with HTTP {status}"),
                }
            }
        }
        other => WireError::Protocol {
            detail: other.to_string(),
        },
    }
}
