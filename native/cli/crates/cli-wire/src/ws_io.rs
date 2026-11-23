// SPDX-License-Identifier: Apache-2.0
//! Low-level WebSocket frame I/O and error classification helpers for [`crate::Connection`].

use std::collections::VecDeque;
use std::time::Instant;

use tungstenite::handshake::client::ClientHandshake;
use tungstenite::{HandshakeError, Message, WebSocket};

use crate::error::WireError;
use crate::protocol::{
    MAX_FRAME_BYTES, ServerEnvelope, classify_close_code, is_machine_code_refusal,
};
use crate::stream::{TransportStream, classify_io_error};

pub(crate) fn send_text(
    ws: &mut WebSocket<TransportStream>,
    payload: &str,
    deadline: Instant,
    context: &'static str,
) -> Result<(), WireError> {
    ws.get_ref().apply_deadline(deadline, context)?;
    ws.send(Message::Text(payload.into()))
        .map_err(|err| classify_ws_error(err, context))
}

pub(crate) fn read_text_frame(
    ws: &mut WebSocket<TransportStream>,
    read_buf: &mut String,
    queued_lines: &mut VecDeque<String>,
    deadline: Instant,
    context: &'static str,
    ignore_binary: bool,
) -> Result<(), WireError> {
    if let Some(line) = queued_lines.pop_front() {
        read_buf.clear();
        read_buf.push_str(&line);
        return Ok(());
    }

    loop {
        ws.get_ref().apply_deadline(deadline, context)?;
        match ws.read() {
            Ok(Message::Text(text)) => {
                if text.len() > MAX_FRAME_BYTES {
                    return Err(WireError::Limit {
                        detail: "Server frame exceeded size limit".into(),
                    });
                }
                if text.contains('\n') {
                    for line in text.split('\n').filter(|l| !l.is_empty()) {
                        queued_lines.push_back(line.to_owned());
                    }
                    if let Some(first) = queued_lines.pop_front() {
                        read_buf.clear();
                        read_buf.push_str(&first);
                        return Ok(());
                    }
                    continue;
                }
                read_buf.clear();
                read_buf.push_str(text.as_str());
                return Ok(());
            }
            Ok(Message::Ping(payload)) => {
                ws.get_ref().apply_deadline(deadline, context)?;
                ws.send(Message::Pong(payload))
                    .map_err(|err| classify_ws_error(err, context))?;
            }
            Ok(Message::Pong(_) | Message::Frame(_)) => {}
            Ok(Message::Binary(_)) => {
                if !ignore_binary {
                    return Err(WireError::Protocol {
                        detail: "Unexpected binary frame before welcome".into(),
                    });
                }
            }
            Ok(Message::Close(frame)) => {
                return Err(match frame {
                    Some(cf) => classify_close_code(u16::from(cf.code), cf.reason.as_str()),
                    None => WireError::Offline {
                        detail: "Daemon closed connection".into(),
                    },
                });
            }
            Err(err) => return Err(classify_ws_error(err, context)),
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
