// SPDX-License-Identifier: Apache-2.0
//! Blocking WebSocket request client over `tungstenite` (no default features) and `std::net`.
//!
//! Uses a zero-copy [`FrameBuffer`] over `tungstenite::Utf8Bytes` so incoming text frames and
//! `\n`-packed lines avoid intermediate copies and per-line allocations. Replies retain their raw
//! JSON as `Box<serde_json::value::RawValue>` so `--json` prints them untouched and human output
//! decodes borrowed fields on demand.

use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::value::RawValue;
use tungstenite::WebSocket;
use tungstenite::client::client_with_config;
use tungstenite::protocol::WebSocketConfig;

use crate::error::WireError;
use crate::fragments::FragmentAssembler;
use crate::home::Local;
use crate::http::exchange_ticket_with_tls;
use crate::profile::DirectRemote;
use crate::protocol::{
    Credential, DEFAULT_HANDSHAKE_TIMEOUT, DEFAULT_REQUEST_TIMEOUT, MAX_FRAME_BYTES,
    MAX_SEND_BYTES, Reply, Welcome, decode_welcome, encode_hello, encode_request_into,
    expected_reply_types, inject_request_id, parse_outgoing_request_meta, parse_server_envelope,
    verify_entities_page_owner,
};
use crate::stream::{TransportStream, connect_local_tcp, remaining_until};
use crate::tls::{TlsPinConfig, connect_pinned_tls};
use crate::types::{DeviceId, HostId, LocalIdentity, RequestId};
use crate::ws_io::{
    FrameBuffer, ReadError, classify_handshake_error, handshake_error_frame, read_next_line,
    send_text,
};

/// Options controlling how [`Connection`] verifies daemon identity and enforces deadlines.
///
/// Local identity (`"ace-cli"` vs `"ace-agent"`) is intentionally NOT defaulted here: callers must
/// pass [`LocalIdentity`] to [`Connection::open_local`] (matching `person-gate.ts`).
#[derive(Debug, Clone)]
pub struct ConnectConfig {
    /// Optional expected daemon `hostId`; mismatches fail with [`WireError::Identity`].
    pub expected_host_id: Option<HostId>,
    /// Outer deadline for TCP connect, TLS/WS upgrade, `starting` wait, and `welcome` reply
    /// (default 15 s, matching `AbortSignal.timeout(15000)` in `apps/daemon/src/cli/connection.ts`).
    pub handshake_timeout: Duration,
    /// Default deadline for [`Connection::request`].
    pub request_timeout: Duration,
}

impl Default for ConnectConfig {
    fn default() -> Self {
        Self {
            expected_host_id: None,
            handshake_timeout: DEFAULT_HANDSHAKE_TIMEOUT,
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
    frame_buf: FrameBuffer,
    send_buf: String,
    scratch_buf: Vec<u8>,
    fragments: FragmentAssembler,
}

impl Connection {
    /// Opens a blocking WebSocket connection to the local loopback daemon and completes the
    /// `hello` / `welcome` handshake.
    ///
    /// Callers must pass [`LocalIdentity`] (typically [`LocalIdentity::from_env`]) so an agent
    /// shell (`ACE_THREAD_ID` / `ACE_NO_INPUT`) never connects as `"ace-cli"`.
    pub fn open_local(
        local: &Local,
        identity: LocalIdentity,
        config: &ConnectConfig,
    ) -> Result<Self, WireError> {
        let deadline = Instant::now() + config.handshake_timeout;
        let tcp = connect_local_tcp(local.origin().socket_addr(), deadline)?;
        let ws_url = local.origin().ws_url();
        let device_id = identity.device_id();
        Self::open_stream(
            &ws_url,
            TransportStream::Plain(tcp),
            Credential::Token(local.token()),
            &device_id,
            config.expected_host_id.as_ref(),
            config,
            deadline,
        )
        .map_err(read_error_to_wire)
    }

    /// Opens a blocking pinned-TLS WebSocket connection to a direct remote machine.
    ///
    /// Exchanges a fresh single-use ticket via `POST /v1/tickets` over pinned HTTPS, then upgrades
    /// a pinned WSS connection and authenticates with `ticket` and `direct.device_id`. If the
    /// daemon closes the handshake with `4001 Credential replaced`, retries once with a fresh ticket
    /// within the same outer deadline before failing with [`WireError::Auth`] (`refused`, exit 4).
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
        let ws_url = direct.origin.wss_url();
        let expected_host_id = config.expected_host_id.as_ref().or(direct.host_id);

        for attempt in 0..2 {
            let ticket_budget = remaining_until(deadline, "Handshake")?;
            let socket_ticket = exchange_ticket_with_tls(direct, tls, ticket_budget)?;
            let stream = connect_pinned_tls(direct.origin, tls, deadline)?;
            match Self::open_stream(
                &ws_url,
                stream,
                Credential::Ticket(&socket_ticket.ticket),
                direct.device_id,
                expected_host_id,
                config,
                deadline,
            ) {
                Ok(conn) => return Ok(conn),
                Err(ReadError::CredentialReplaced) if attempt == 0 => {}
                Err(err) => return Err(read_error_to_wire(err)),
            }
        }

        Err(WireError::Auth {
            detail: "Credential replaced".into(),
            revoked: false,
        })
    }

    /// Completes the WebSocket upgrade and `hello` / `welcome` handshake over an already-connected
    /// plain or pinned-TLS [`TransportStream`].
    fn open_stream(
        ws_url: &str,
        mut stream: TransportStream,
        credential: Credential<'_>,
        device_id: &DeviceId,
        expected_host_id: Option<&HostId>,
        config: &ConnectConfig,
        deadline: Instant,
    ) -> Result<Self, ReadError> {
        stream.set_deadline(deadline, "Handshake")?;
        let ws_config = WebSocketConfig::default()
            .max_message_size(Some(MAX_FRAME_BYTES))
            .max_frame_size(Some(MAX_FRAME_BYTES));

        let (mut ws, _response) = client_with_config(ws_url, stream, Some(ws_config))
            .map_err(|err| ReadError::Wire(classify_handshake_error(err, "Handshake")))?;

        let mut frame_buf = FrameBuffer::new();
        let mut send_buf = String::with_capacity(512);

        encode_hello(device_id, credential, &mut send_buf)?;
        send_text(&mut ws, &send_buf, deadline, "Handshake")?;

        let welcome = loop {
            let line = read_next_line(&mut ws, &mut frame_buf, deadline, "Handshake", false)?;
            let envelope = parse_server_envelope(line)?;
            match envelope.msg_type.as_ref() {
                // `starting` signals a cold start; keep waiting strictly under the outer
                // `handshake_timeout` cap (15 s in CLI, matching `connection.ts:149`).
                "starting" => {}
                "welcome" => break decode_welcome(line, expected_host_id)?,
                "error" => return Err(ReadError::Wire(handshake_error_frame(&envelope))),
                other => {
                    return Err(ReadError::Wire(WireError::Protocol {
                        detail: format!("Unexpected {other} before welcome"),
                    }));
                }
            }
        };

        Ok(Self {
            ws,
            welcome,
            next_seq: 0,
            request_timeout: config.request_timeout,
            frame_buf,
            send_buf,
            scratch_buf: Vec::with_capacity(512),
            fragments: FragmentAssembler::default(),
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
        let expectations = extract_expectations(&self.send_buf, None)?;
        self.send_and_await_reply(req_id, &expectations, timeout)
    }

    /// Sends a correlated request and waits specifically for one of `expected_types`.
    pub fn request_expecting<T: Serialize>(
        &mut self,
        op: &T,
        expected_types: &[&str],
        timeout: Duration,
    ) -> Result<Reply, WireError> {
        let req_id = self.next_request_id()?;
        encode_request_into(op, &req_id, &mut self.scratch_buf, &mut self.send_buf)?;
        let expectations = extract_expectations(&self.send_buf, Some(expected_types))?;
        self.send_and_await_reply(req_id, &expectations, timeout)
    }

    /// Sends a raw JSON object request string (without `requestId`) and waits for its reply.
    pub fn request_raw(
        &mut self,
        json_object: &str,
        timeout: Duration,
    ) -> Result<Reply, WireError> {
        let req_id = self.next_request_id()?;
        inject_request_id(json_object, &req_id, &mut self.send_buf)?;
        let expectations = extract_expectations(&self.send_buf, None)?;
        self.send_and_await_reply(req_id, &expectations, timeout)
    }

    /// Sends a raw JSON object request string and waits specifically for one of `expected_types`.
    pub fn request_raw_expecting(
        &mut self,
        json_object: &str,
        expected_types: &[&str],
        timeout: Duration,
    ) -> Result<Reply, WireError> {
        let req_id = self.next_request_id()?;
        inject_request_id(json_object, &req_id, &mut self.send_buf)?;
        let expectations = extract_expectations(&self.send_buf, Some(expected_types))?;
        self.send_and_await_reply(req_id, &expectations, timeout)
    }

    /// Convenience wrapper for `{"type":"cli.request","operation":operation}` expecting `"cli.result"`.
    pub fn cli_request<T: Serialize>(&mut self, operation: &T) -> Result<Reply, WireError> {
        self.cli_request_with_timeout(operation, self.request_timeout)
    }

    /// Convenience wrapper for `{"type":"cli.request","operation":operation}` expecting `"cli.result"`
    /// within an explicit `timeout`.
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
        self.request_expecting(
            &CliRequestFrame {
                msg_type: "cli.request",
                operation,
            },
            &["cli.result"],
            timeout,
        )
    }

    /// Sends a durable `{"type":"command","command":{...}}` frame and waits for its
    /// `commandResult` with the same `commandId`.
    ///
    /// `frame_json` is the full command frame (with `type` and `command`); `command_id` is the
    /// command's id for correlation. An `error` frame with the same `commandId` and
    /// `retryable: true` resends the frame and keeps waiting; any other `error` with the same
    /// `commandId` fails as [`WireError::Daemon`]. Anything else is ignored, as the TypeScript
    /// client's durable wait is. Matches `client.command` in `packages/client/src/client-core.ts`
    /// and the receipt rules in `apps/daemon/src/cli/mutations.ts`.
    pub fn command_raw_with_timeout(
        &mut self,
        frame_json: &str,
        command_id: &str,
        timeout: Duration,
    ) -> Result<Box<serde_json::value::RawValue>, WireError> {
        let deadline = Instant::now() + timeout;
        if frame_json.len() > MAX_SEND_BYTES {
            return Err(WireError::Limit {
                detail: "Command exceeds send limit".into(),
            });
        }
        self.send_buf.clear();
        self.send_buf.push_str(frame_json);
        send_text(&mut self.ws, &self.send_buf, deadline, "Command")?;
        loop {
            let effective = self
                .fragments
                .earliest_deadline()
                .map_or(deadline, |frag| frag.min(deadline));
            let line = read_next_line(
                &mut self.ws,
                &mut self.frame_buf,
                effective,
                "Command",
                true,
            )
            .map_err(|err| match err {
                ReadError::Wire(WireError::Timeout { .. })
                    if self.fragments.check_expired(Instant::now()).is_err()
                        && Instant::now() < deadline =>
                {
                    WireError::Offline {
                        detail: "Fragments timed out".into(),
                    }
                }
                other => read_error_to_wire(other),
            })?;
            let envelope = parse_server_envelope(line)?;
            let msg_type = envelope.msg_type.as_ref();
            if msg_type == "snapshot.part" {
                continue;
            }
            if msg_type == "entities.page.part" {
                if self
                    .fragments
                    .add_entities_page_part(line, Instant::now())
                    .is_err()
                {
                    continue;
                }
                continue;
            }
            if msg_type == "welcome" {
                return Err(WireError::Protocol {
                    detail: "Second welcome".into(),
                });
            }
            if msg_type == "error" && envelope.command_id.as_deref() == Some(command_id) {
                if envelope.retryable == Some(true) {
                    send_text(&mut self.ws, frame_json, deadline, "Command")?;
                    continue;
                }
                if envelope.code.as_deref() == Some("unauthorized") {
                    return Err(WireError::Auth {
                        detail: envelope
                            .message
                            .map_or_else(|| "Unauthorized".into(), std::borrow::Cow::into_owned),
                        revoked: false,
                    });
                }
                return Err(WireError::Daemon {
                    code: envelope
                        .code
                        .map_or_else(|| "daemon".into(), std::borrow::Cow::into_owned),
                    message: envelope
                        .message
                        .map_or_else(String::new, std::borrow::Cow::into_owned),
                });
            }
            if msg_type == "error" && envelope.code.as_deref() == Some("unauthorized") {
                return Err(WireError::Auth {
                    detail: envelope
                        .message
                        .map_or_else(|| "Unauthorized".into(), std::borrow::Cow::into_owned),
                    revoked: false,
                });
            }
            if msg_type == "commandResult" && envelope.command_id.as_deref() == Some(command_id) {
                let raw =
                    RawValue::from_string(line.to_owned()).map_err(|err| WireError::Protocol {
                        detail: format!("Malformed commandResult: {err}"),
                    })?;
                return Ok(raw);
            }
        }
    }

    /// Sends an application-level `{"type":"ping"}` and waits for `{"type":"pong"}`.
    pub fn ping(&mut self) -> Result<(), WireError> {
        let deadline = Instant::now() + self.request_timeout;
        self.send_buf.clear();
        self.send_buf.push_str(r#"{"type":"ping"}"#);
        send_text(&mut self.ws, &self.send_buf, deadline, "Ping")?;
        loop {
            let line = read_next_line(&mut self.ws, &mut self.frame_buf, deadline, "Ping", true)
                .map_err(read_error_to_wire)?;
            let envelope = parse_server_envelope(line)?;
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
        self.fragments.clear();
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
        expectations: &ReplyExpectations<'_>,
        timeout: Duration,
    ) -> Result<Reply, WireError> {
        let request_deadline = Instant::now() + timeout;
        send_text(&mut self.ws, &self.send_buf, request_deadline, "Request")?;

        loop {
            let effective_deadline = self
                .fragments
                .earliest_deadline()
                .map_or(request_deadline, |frag| frag.min(request_deadline));
            let line = read_next_line(
                &mut self.ws,
                &mut self.frame_buf,
                effective_deadline,
                "Request",
                true,
            )
            .map_err(|err| match err {
                ReadError::Wire(WireError::Timeout { .. })
                    if self.fragments.check_expired(Instant::now()).is_err()
                        && Instant::now() < request_deadline =>
                {
                    WireError::Offline {
                        detail: "Fragments timed out".into(),
                    }
                }
                other => read_error_to_wire(other),
            })?;

            let envelope = parse_server_envelope(line)?;
            let msg_type = envelope.msg_type.as_ref();

            if msg_type == "snapshot.part" {
                continue;
            }
            if msg_type == "entities.page.part" {
                if let Some(complete_json) = self
                    .fragments
                    .add_entities_page_part(line, Instant::now())?
                    && let Some(reply) =
                        match_owned_reply(complete_json, &request_id, expectations)?
                {
                    return Ok(reply);
                }
                continue;
            }

            if msg_type == "error" {
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

            if msg_type == "welcome" {
                return Err(WireError::Protocol {
                    detail: "Second welcome".into(),
                });
            }

            if envelope.request_id.as_deref() == Some(request_id.as_str())
                && reply_type_matches(msg_type, expectations.expected_types)
            {
                if msg_type == "entities.page"
                    && let Some((exp_thread, exp_collection)) = expectations.entity_owner.as_ref()
                {
                    verify_entities_page_owner(
                        line,
                        Some(exp_thread.as_str()),
                        Some(exp_collection.as_str()),
                    )?;
                }
                let msg_type_owned = envelope.msg_type.into_owned();
                let raw =
                    RawValue::from_string(line.to_owned()).map_err(|err| WireError::Protocol {
                        detail: format!("Malformed JSON reply: {err}"),
                    })?;
                return Ok(Reply::new(request_id, msg_type_owned, raw));
            }
        }
    }
}

struct ReplyExpectations<'a> {
    expected_types: Option<&'a [&'a str]>,
    entity_owner: Option<(String, String)>,
}

fn reply_type_matches(msg_type: &str, expected_types: Option<&[&str]>) -> bool {
    match expected_types {
        Some(allowed) => allowed.contains(&msg_type),
        None => !matches!(
            msg_type,
            "history.operation.progress" | "threads.patch" | "entities.page.part" | "snapshot.part"
        ),
    }
}

fn match_owned_reply(
    complete_json: String,
    request_id: &RequestId,
    expectations: &ReplyExpectations<'_>,
) -> Result<Option<Reply>, WireError> {
    let msg_type_owned = {
        let envelope = parse_server_envelope(&complete_json)?;
        if envelope.request_id.as_deref() != Some(request_id.as_str()) {
            return Ok(None);
        }
        let msg_type = envelope.msg_type.as_ref();
        if !reply_type_matches(msg_type, expectations.expected_types) {
            return Ok(None);
        }
        if msg_type == "entities.page"
            && let Some((exp_thread, exp_collection)) = expectations.entity_owner.as_ref()
        {
            verify_entities_page_owner(
                &complete_json,
                Some(exp_thread.as_str()),
                Some(exp_collection.as_str()),
            )?;
        }
        envelope.msg_type.into_owned()
    };
    let raw = RawValue::from_string(complete_json).map_err(|err| WireError::Protocol {
        detail: format!("Malformed JSON reply: {err}"),
    })?;
    Ok(Some(Reply::new(request_id.clone(), msg_type_owned, raw)))
}

fn extract_expectations<'a>(
    json_object: &str,
    explicit_types: Option<&'a [&'a str]>,
) -> Result<ReplyExpectations<'a>, WireError> {
    let meta = parse_outgoing_request_meta(json_object)?;
    let expected_types = explicit_types.or_else(|| expected_reply_types(meta.msg_type.as_ref()));
    let entity_owner = if meta.msg_type == "entities.page" {
        match (meta.thread_id, meta.collection) {
            (Some(thread_id), Some(collection)) => {
                Some((thread_id.into_owned(), collection.into_owned()))
            }
            _ => None,
        }
    } else {
        None
    };
    Ok(ReplyExpectations {
        expected_types,
        entity_owner,
    })
}

fn read_error_to_wire(err: ReadError) -> WireError {
    match err {
        ReadError::CredentialReplaced => WireError::Auth {
            detail: "Credential replaced".into(),
            revoked: false,
        },
        ReadError::Wire(wire) => wire,
    }
}
