// SPDX-License-Identifier: Apache-2.0
//! Blocking WebSocket request client over `tungstenite` (no default features) and `std::net`.
//!
//! One reusable read buffer and one reusable write buffer live on [`Connection`], avoiding
//! per-frame reallocations. Replies retain their raw JSON as `Box<serde_json::value::RawValue>`
//! so `--json` prints them untouched and human output decodes borrowed fields on demand.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::value::RawValue;
use tungstenite::client::client_with_config;
use tungstenite::handshake::client::ClientHandshake;
use tungstenite::protocol::WebSocketConfig;
use tungstenite::{HandshakeError, Message, WebSocket};

use crate::error::WireError;
use crate::home::Local;
use crate::protocol::{
    Credential, DEFAULT_COLD_START_TIMEOUT, DEFAULT_HANDSHAKE_TIMEOUT, DEFAULT_REQUEST_TIMEOUT,
    MAX_FRAME_BYTES, Reply, Welcome, classify_close_code, decode_welcome, encode_hello,
    encode_request_into, inject_request_id, is_machine_code_refusal, parse_server_envelope,
};
use crate::stream::{TransportStream, classify_io_error, connect_local_tcp};
use crate::types::{DeviceId, HostId, RequestId};

/// Options controlling how [`Connection`] identifies itself and enforces deadlines.
#[derive(Debug, Clone)]
pub struct ConnectConfig {
    /// Device identity sent in `hello` (`"ace-cli"`, `"ace-agent"`, or a paired remote device id).
    pub device_id: DeviceId,
    /// Optional expected daemon `hostId`; mismatches fail with [`WireError::Identity`].
    pub expected_host_id: Option<HostId>,
    /// Deadline for TCP connect, WebSocket upgrade, and `welcome` reply.
    pub handshake_timeout: Duration,
    /// Extended deadline used when the daemon sends `{"type":"starting"}` during cold start.
    pub cold_start_timeout: Duration,
    /// Default deadline for [`Connection::request`].
    pub request_timeout: Duration,
}

impl Default for ConnectConfig {
    fn default() -> Self {
        Self {
            device_id: DeviceId::local_cli(),
            expected_host_id: None,
            handshake_timeout: DEFAULT_HANDSHAKE_TIMEOUT,
            cold_start_timeout: DEFAULT_COLD_START_TIMEOUT,
            request_timeout: DEFAULT_REQUEST_TIMEOUT,
        }
    }
}

/// Blocking WebSocket connection to an ace daemon.
pub struct Connection {
    ws: WebSocket<TransportStream>,
    welcome: Welcome,
    next_seq: u64,
    request_timeout: Duration,
    read_buf: String,
    send_buf: String,
    scratch_buf: Vec<u8>,
    queued_lines: VecDeque<String>,
}

impl Connection {
    /// Opens a blocking WebSocket connection to the local loopback daemon and completes the
    /// `hello` / `welcome` handshake.
    pub fn open_local(local: &Local, config: &ConnectConfig) -> Result<Self, WireError> {
        let deadline = Instant::now() + config.handshake_timeout;
        let tcp = connect_local_tcp(local.origin().socket_addr(), deadline)?;
        let ws_url = local.origin().ws_url();
        Self::open_stream(
            &ws_url,
            TransportStream::Plain(tcp),
            Credential::Token(local.token()),
            config,
            deadline,
        )
    }

    /// Completes the WebSocket upgrade and `hello` / `welcome` handshake over an already-connected
    /// plain or pinned-TLS [`TransportStream`].
    pub(crate) fn open_stream(
        ws_url: &str,
        stream: TransportStream,
        credential: Credential<'_>,
        config: &ConnectConfig,
        mut deadline: Instant,
    ) -> Result<Self, WireError> {
        stream.apply_deadline(deadline, "Handshake")?;
        let ws_config = WebSocketConfig::default()
            .max_message_size(Some(MAX_FRAME_BYTES))
            .max_frame_size(Some(MAX_FRAME_BYTES));

        let (mut ws, _response) = client_with_config(ws_url, stream, Some(ws_config))
            .map_err(|err| classify_handshake_error(err, "Handshake"))?;

        let mut read_buf = String::with_capacity(4096);
        let mut send_buf = String::with_capacity(512);
        let mut queued_lines = VecDeque::new();

        encode_hello(&config.device_id, credential, &mut send_buf)?;
        send_text(&mut ws, &send_buf, deadline, "Handshake")?;

        let cold_start_deadline = Instant::now() + config.cold_start_timeout;
        let welcome = loop {
            read_text_frame(
                &mut ws,
                &mut read_buf,
                &mut queued_lines,
                deadline,
                "Handshake",
                false,
            )?;
            let envelope = parse_server_envelope(&read_buf)?;
            match envelope.msg_type.as_ref() {
                "starting" => {
                    if cold_start_deadline > deadline {
                        deadline = cold_start_deadline;
                    }
                }
                "welcome" => {
                    break decode_welcome(&read_buf, config.expected_host_id.as_ref())?;
                }
                "error" => return Err(handshake_error_frame(&envelope)),
                other => {
                    return Err(WireError::Protocol {
                        detail: format!("Unexpected {other} before welcome"),
                    });
                }
            }
        };

        Ok(Self {
            ws,
            welcome,
            next_seq: 0,
            request_timeout: config.request_timeout,
            read_buf,
            send_buf,
            scratch_buf: Vec::with_capacity(512),
            queued_lines,
        })
    }

    /// Daemon handshake metadata returned in `welcome`.
    #[must_use]
    pub const fn welcome(&self) -> &Welcome {
        &self.welcome
    }

    /// Sends a correlated request (without a `requestId` field; one is injected automatically)
    /// and waits for the matching reply using [`ConnectConfig::request_timeout`].
    pub fn request<T: Serialize>(&mut self, op: &T) -> Result<Reply, WireError> {
        self.request_with_timeout(op, self.request_timeout)
    }

    /// Sends a correlated request and waits for the matching reply within `timeout`.
    pub fn request_with_timeout<T: Serialize>(
        &mut self,
        op: &T,
        timeout: Duration,
    ) -> Result<Reply, WireError> {
        let req_id = self.next_request_id()?;
        encode_request_into(op, &req_id, &mut self.scratch_buf, &mut self.send_buf)?;
        self.send_and_await_reply(req_id, timeout)
    }

    /// Sends a raw JSON object request string (without `requestId`) and waits for its reply.
    pub fn request_raw(
        &mut self,
        json_object: &str,
        timeout: Duration,
    ) -> Result<Reply, WireError> {
        let req_id = self.next_request_id()?;
        inject_request_id(json_object, &req_id, &mut self.send_buf)?;
        self.send_and_await_reply(req_id, timeout)
    }

    /// Convenience wrapper for `{"type":"cli.request","operation":operation}`.
    pub fn cli_request<T: Serialize>(&mut self, operation: &T) -> Result<Reply, WireError> {
        self.cli_request_with_timeout(operation, self.request_timeout)
    }

    /// Convenience wrapper for `{"type":"cli.request","operation":operation}` with explicit timeout.
    pub fn cli_request_with_timeout<T: Serialize>(
        &mut self,
        operation: &T,
        timeout: Duration,
    ) -> Result<Reply, WireError> {
        #[derive(Serialize)]
        struct CliRequestFrame<'a, T: Serialize> {
            #[serde(rename = "type")]
            msg_type: &'static str,
            operation: &'a T,
        }
        self.request_with_timeout(
            &CliRequestFrame {
                msg_type: "cli.request",
                operation,
            },
            timeout,
        )
    }

    /// Sends an application-level `{"type":"ping"}` and waits for `{"type":"pong"}`.
    pub fn ping(&mut self) -> Result<(), WireError> {
        let deadline = Instant::now() + self.request_timeout;
        self.send_buf.clear();
        self.send_buf.push_str(r#"{"type":"ping"}"#);
        self.send_text_buf(deadline, "Ping")?;
        loop {
            self.read_next_text_frame(deadline, "Ping", true)?;
            let envelope = parse_server_envelope(&self.read_buf)?;
            if envelope.msg_type == "pong" {
                return Ok(());
            }
            if envelope.msg_type == "error" && envelope.code.as_deref() == Some("unauthorized") {
                return Err(WireError::Auth {
                    detail: envelope
                        .message
                        .map_or_else(|| "Unauthorized".into(), std::borrow::Cow::into_owned),
                    revoked: false,
                });
            }
        }
    }

    /// Gracefully closes the WebSocket connection (best effort).
    pub fn close(mut self) {
        let _ = self.ws.close(None);
        self.ws.get_ref().shutdown_both();
    }

    fn next_request_id(&mut self) -> Result<RequestId, WireError> {
        self.next_seq = self.next_seq.wrapping_add(1);
        RequestId::parse(format!("r{}", self.next_seq))
    }

    fn send_and_await_reply(
        &mut self,
        request_id: RequestId,
        timeout: Duration,
    ) -> Result<Reply, WireError> {
        let deadline = Instant::now() + timeout;
        self.send_text_buf(deadline, "Request")?;

        loop {
            self.read_next_text_frame(deadline, "Request", true)?;
            let envelope = parse_server_envelope(&self.read_buf)?;

            if envelope.msg_type == "error" {
                if envelope.code.as_deref() == Some("unauthorized") {
                    return Err(WireError::Auth {
                        detail: envelope
                            .message
                            .map_or_else(|| "Unauthorized".into(), std::borrow::Cow::into_owned),
                        revoked: false,
                    });
                }
                if envelope.request_id.as_deref() == Some(request_id.as_str()) {
                    return Err(WireError::Daemon {
                        code: envelope
                            .code
                            .map_or_else(|| "daemon".into(), std::borrow::Cow::into_owned),
                        message: envelope
                            .message
                            .map_or_else(String::new, std::borrow::Cow::into_owned),
                    });
                }
                // Uncorrelated or other-id error leaves the connection usable (client-core.ts).
                continue;
            }

            if envelope.msg_type == "welcome" {
                return Err(WireError::Protocol {
                    detail: "Second welcome".into(),
                });
            }

            if envelope.msg_type == "history.operation.progress" {
                continue;
            }

            if envelope.request_id.as_deref() == Some(request_id.as_str()) {
                let msg_type = envelope.msg_type.into_owned();
                let raw = RawValue::from_string(self.read_buf.clone()).map_err(|err| {
                    WireError::Protocol {
                        detail: format!("Malformed JSON reply: {err}"),
                    }
                })?;
                return Ok(Reply::new(request_id, msg_type, raw));
            }
        }
    }

    fn send_text_buf(&mut self, deadline: Instant, context: &'static str) -> Result<(), WireError> {
        send_text(&mut self.ws, &self.send_buf, deadline, context)
    }

    fn read_next_text_frame(
        &mut self,
        deadline: Instant,
        context: &'static str,
        ignore_binary: bool,
    ) -> Result<(), WireError> {
        read_text_frame(
            &mut self.ws,
            &mut self.read_buf,
            &mut self.queued_lines,
            deadline,
            context,
            ignore_binary,
        )
    }
}

fn send_text(
    ws: &mut WebSocket<TransportStream>,
    payload: &str,
    deadline: Instant,
    context: &'static str,
) -> Result<(), WireError> {
    ws.get_ref().apply_deadline(deadline, context)?;
    ws.send(Message::Text(payload.into()))
        .map_err(|err| classify_ws_error(err, context))
}

fn read_text_frame(
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

fn handshake_error_frame(envelope: &crate::protocol::ServerEnvelope<'_>) -> WireError {
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

fn classify_handshake_error(
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

fn classify_ws_error(err: tungstenite::Error, context: &'static str) -> WireError {
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
