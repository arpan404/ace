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
use tungstenite::WebSocket;
use tungstenite::client::client_with_config;
use tungstenite::protocol::WebSocketConfig;

use crate::error::WireError;
use crate::home::Local;
use crate::http::exchange_ticket_with_tls;
use crate::profile::DirectRemote;
use crate::protocol::{
    Credential, DEFAULT_COLD_START_TIMEOUT, DEFAULT_HANDSHAKE_TIMEOUT, DEFAULT_REQUEST_TIMEOUT,
    MAX_FRAME_BYTES, Reply, Welcome, decode_welcome, encode_hello, encode_request_into,
    inject_request_id, parse_server_envelope,
};
use crate::stream::{TransportStream, connect_local_tcp, remaining_until};
use crate::tls::{TlsPinConfig, connect_pinned_tls};
use crate::types::{DeviceId, HostId, RequestId};
use crate::ws_io::{classify_handshake_error, handshake_error_frame, read_text_frame, send_text};

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
            &config.device_id,
            config.expected_host_id.as_ref(),
            config,
            deadline,
        )
    }

    /// Opens a blocking pinned-TLS WebSocket connection to a direct remote machine.
    ///
    /// Exchanges a fresh single-use ticket via `POST /v1/tickets` over pinned HTTPS, then upgrades
    /// a pinned WSS connection and authenticates with `ticket` and `direct.device_id`.
    pub fn open_remote(
        direct: &DirectRemote<'_>,
        config: &ConnectConfig,
    ) -> Result<Self, WireError> {
        let tls = TlsPinConfig::new(direct.fingerprint.clone());
        Self::open_remote_with_tls(direct, &tls, config)
    }

    /// Opens a blocking pinned-TLS WebSocket connection using an explicit [`TlsPinConfig`] (for
    /// custom clocks or `.ts.net` fallback roots).
    pub fn open_remote_with_tls(
        direct: &DirectRemote<'_>,
        tls: &TlsPinConfig,
        config: &ConnectConfig,
    ) -> Result<Self, WireError> {
        let deadline = Instant::now() + config.handshake_timeout;
        let ticket_budget = remaining_until(deadline, "Handshake")?;
        let socket_ticket = exchange_ticket_with_tls(direct, tls, ticket_budget)?;
        let stream = connect_pinned_tls(direct.origin, tls, deadline)?;
        let ws_url = direct.origin.wss_url();
        let expected_host_id = config.expected_host_id.as_ref().or(direct.host_id);
        Self::open_stream(
            &ws_url,
            stream,
            Credential::Ticket(&socket_ticket.ticket),
            direct.device_id,
            expected_host_id,
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
        device_id: &DeviceId,
        expected_host_id: Option<&HostId>,
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

        encode_hello(device_id, credential, &mut send_buf)?;
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
                    break decode_welcome(&read_buf, expected_host_id)?;
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
        send_text(&mut self.ws, &self.send_buf, deadline, "Ping")?;
        loop {
            read_text_frame(
                &mut self.ws,
                &mut self.read_buf,
                &mut self.queued_lines,
                deadline,
                "Ping",
                true,
            )?;
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
        send_text(&mut self.ws, &self.send_buf, deadline, "Request")?;

        loop {
            read_text_frame(
                &mut self.ws,
                &mut self.read_buf,
                &mut self.queued_lines,
                deadline,
                "Request",
                true,
            )?;
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
}
