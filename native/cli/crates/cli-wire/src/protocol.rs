// SPDX-License-Identifier: Apache-2.0
//! Pure WebSocket wire framing, handshake decoding, and close-code classification.
//!
//! Matches `packages/protocol/src/wire-core.ts`, `packages/client/src/connection.ts`, and
//! `packages/client/src/lifecycle.ts`. Unknown fields in daemon replies are always ignored.

use std::borrow::Cow;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;

use crate::error::WireError;
use crate::types::{DeviceId, HostId, RequestId, Ticket, Token};

/// Current ace daemon wire protocol version.
pub const PROTOCOL_VERSION: u32 = 1;

/// Maximum incoming WebSocket frame size in bytes (2 MiB, matching `defaultLimits.frameBytes`).
pub const MAX_FRAME_BYTES: usize = 2 * 1024 * 1024;

/// Maximum outgoing WebSocket message size in bytes (1 MiB, matching `defaultLimits.sendBytes`).
pub const MAX_SEND_BYTES: usize = 1024 * 1024;

/// Default WebSocket open + welcome handshake timeout (15 s, matching `connection.ts`).
pub const DEFAULT_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);

/// Extended handshake deadline when a daemon replies `{"type":"starting"}` (120 s).
pub const DEFAULT_COLD_START_TIMEOUT: Duration = Duration::from_mins(2);

/// Default per-request deadline (15 s, matching `defaultLimits.requestMs`).
pub const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

/// Credential presented in the WebSocket `hello` frame.
#[derive(Debug, Clone, Copy)]
pub enum Credential<'a> {
    /// Local host token (`daemon-token`).
    Token(&'a Token),
    /// Single-use ticket exchanged via `POST /v1/tickets` on a remote daemon.
    Ticket(&'a Ticket),
}

/// Decoded daemon `welcome` message (unknown fields are ignored, never fatal).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Welcome {
    pub host_id: HostId,
    pub protocol_version: u32,
    pub head_seq: u64,
    pub database_id: Option<String>,
    pub release_line: Option<String>,
}

/// A correlated reply to a WebSocket request, preserving the exact raw JSON body.
///
/// `--json` callers can write [`Reply::as_str`] directly without decoding and re-encoding; human
/// output callers can borrow only the fields they print via [`Reply::decode`].
#[derive(Debug, Clone)]
pub struct Reply {
    request_id: RequestId,
    msg_type: String,
    raw: Box<RawValue>,
}

impl Reply {
    pub(crate) const fn new(request_id: RequestId, msg_type: String, raw: Box<RawValue>) -> Self {
        Self {
            request_id,
            msg_type,
            raw,
        }
    }

    /// Correlated `requestId` echoed by the daemon.
    #[must_use]
    pub const fn request_id(&self) -> &RequestId {
        &self.request_id
    }

    /// The daemon message's `"type"` discriminator (for example `"cli.result"`).
    #[must_use]
    pub fn msg_type(&self) -> &str {
        &self.msg_type
    }

    /// Raw validated JSON message as received from the daemon.
    #[must_use]
    pub fn raw(&self) -> &RawValue {
        &self.raw
    }

    /// Raw validated JSON message string slice.
    #[must_use]
    pub fn as_str(&self) -> &str {
        self.raw.get()
    }

    /// Consumes the reply and returns the owned [`RawValue`].
    #[must_use]
    pub fn into_raw(self) -> Box<RawValue> {
        self.raw
    }

    /// Decodes only the fields needed by `T`, borrowing directly from `self` where possible.
    pub fn decode<'a, T: Deserialize<'a>>(&'a self) -> Result<T, WireError> {
        serde_json::from_str(self.raw.get()).map_err(|err| WireError::Protocol {
            detail: format!("Failed to decode daemon reply: {err}"),
        })
    }
}

/// Minimal borrowed header extracted from any incoming server JSON frame.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerEnvelope<'a> {
    #[serde(rename = "type", borrow)]
    pub msg_type: Cow<'a, str>,
    #[serde(default, borrow)]
    pub request_id: Option<Cow<'a, str>>,
    #[serde(default, borrow)]
    pub code: Option<Cow<'a, str>>,
    #[serde(default, borrow)]
    pub message: Option<Cow<'a, str>>,
    #[serde(default)]
    pub locked_until: Option<u64>,
}

/// Parses the minimal server envelope without failing on unknown fields.
pub fn parse_server_envelope(text: &str) -> Result<ServerEnvelope<'_>, WireError> {
    serde_json::from_str(text).map_err(|err| WireError::Protocol {
        detail: format!("Malformed server frame: {err}"),
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawWelcome<'a> {
    #[serde(borrow)]
    host_id: Cow<'a, str>,
    protocol_version: u32,
    head_seq: u64,
    #[serde(default, borrow)]
    database_id: Option<Cow<'a, str>>,
    #[serde(default, borrow)]
    release_line: Option<Cow<'a, str>>,
}

/// Decodes a `welcome` frame, checking `protocolVersion == 1` and optional `expected_host_id`.
pub fn decode_welcome(text: &str, expected_host_id: Option<&HostId>) -> Result<Welcome, WireError> {
    let raw: RawWelcome<'_> = serde_json::from_str(text).map_err(|err| WireError::Protocol {
        detail: format!("Malformed welcome frame: {err}"),
    })?;
    if raw.protocol_version != PROTOCOL_VERSION {
        return Err(WireError::Protocol {
            detail: format!("Unsupported protocol version {}", raw.protocol_version),
        });
    }
    let host_id = HostId::parse(raw.host_id.into_owned())?;
    if let Some(expected) = expected_host_id
        && expected != &host_id
    {
        return Err(WireError::Identity {
            detail: "Unexpected daemon identity".into(),
        });
    }
    Ok(Welcome {
        host_id,
        protocol_version: raw.protocol_version,
        head_seq: raw.head_seq,
        database_id: raw.database_id.map(Cow::into_owned),
        release_line: raw.release_line.map(Cow::into_owned),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HelloFrame<'a> {
    #[serde(rename = "type")]
    msg_type: &'static str,
    protocol_version: u32,
    device_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    token: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ticket: Option<&'a str>,
}

/// Encodes a WebSocket `hello` frame into `out` (reusing its allocation).
pub fn encode_hello(
    device_id: &DeviceId,
    credential: Credential<'_>,
    out: &mut String,
) -> Result<(), WireError> {
    let (token, ticket) = match credential {
        Credential::Token(t) => (Some(t.as_str()), None),
        Credential::Ticket(t) => (None, Some(t.as_str())),
    };
    let frame = HelloFrame {
        msg_type: "hello",
        protocol_version: PROTOCOL_VERSION,
        device_id: device_id.as_str(),
        token,
        ticket,
    };
    out.clear();
    let encoded = serde_json::to_string(&frame).map_err(|err| WireError::Protocol {
        detail: format!("Failed to encode hello frame: {err}"),
    })?;
    if encoded.len() > MAX_SEND_BYTES {
        return Err(WireError::Limit {
            detail: "Hello frame exceeds send limit".into(),
        });
    }
    out.push_str(&encoded);
    Ok(())
}

/// Encodes an arbitrary serializable request object with an injected `"requestId"` into `out`,
/// reusing `scratch` and `out` without allocating an intermediate `serde_json::Value`.
pub fn encode_request_into<T: Serialize>(
    op: &T,
    request_id: &RequestId,
    scratch: &mut Vec<u8>,
    out: &mut String,
) -> Result<(), WireError> {
    scratch.clear();
    serde_json::to_writer(&mut *scratch, op).map_err(|err| WireError::Protocol {
        detail: format!("Failed to serialize request: {err}"),
    })?;
    let json = std::str::from_utf8(scratch).map_err(|_| WireError::Protocol {
        detail: "Serialized request is not valid UTF-8".into(),
    })?;
    inject_request_id(json, request_id, out)
}

/// Injects `"requestId"` into a serialized JSON object string, writing into `out`.
pub fn inject_request_id(
    json_object: &str,
    request_id: &RequestId,
    out: &mut String,
) -> Result<(), WireError> {
    let trimmed = json_object.trim();
    let inner = trimmed
        .strip_prefix('{')
        .and_then(|s| s.strip_suffix('}'))
        .map(str::trim)
        .ok_or_else(|| WireError::Protocol {
            detail: "Request operation must serialize as a JSON object".into(),
        })?;
    if inner.is_empty() {
        return Err(WireError::Protocol {
            detail: "Request operation must not be an empty JSON object".into(),
        });
    }

    let id_json =
        serde_json::to_string(request_id.as_str()).map_err(|err| WireError::Protocol {
            detail: format!("Failed to encode requestId: {err}"),
        })?;

    out.clear();
    out.reserve(inner.len() + id_json.len() + 18);
    out.push_str("{\"requestId\":");
    out.push_str(&id_json);
    out.push(',');
    out.push_str(inner);
    out.push('}');

    if out.len() > MAX_SEND_BYTES {
        return Err(WireError::Limit {
            detail: "Outgoing request exceeds send limit".into(),
        });
    }
    Ok(())
}

/// True when `code` is one of the daemon's `MachineCodeRefusal` codes.
#[must_use]
pub fn is_machine_code_refusal(code: &str) -> bool {
    matches!(
        code,
        "machine_code_required" | "machine_code_wrong" | "machine_code_locked"
    )
}

/// Maps a WebSocket close code and reason to [`WireError`], matching `disconnectDecision` and
/// `Connection.#lost` in `packages/client/src/lifecycle.ts` and `connection.ts`.
#[must_use]
pub fn classify_close_code(code: u16, reason: &str) -> WireError {
    match code {
        4001 if reason == "Credential replaced" => WireError::Offline {
            detail: "Credential replaced".into(),
        },
        4001 => WireError::Auth {
            detail: if reason.is_empty() {
                "Unauthorized".into()
            } else {
                reason.to_owned()
            },
            revoked: false,
        },
        4003 => WireError::Auth {
            detail: if reason.is_empty() {
                "Device revoked".into()
            } else {
                reason.to_owned()
            },
            revoked: reason == "Device revoked",
        },
        4403 => WireError::Auth {
            detail: "This machine isn't on your ace account.".into(),
            revoked: false,
        },
        4011 => WireError::MachineCode {
            code: if reason.is_empty() {
                "machine_code_required".into()
            } else {
                reason.to_owned()
            },
            locked_until: None,
        },
        4002 => WireError::Protocol {
            detail: if reason.is_empty() {
                "Protocol error".into()
            } else {
                reason.to_owned()
            },
        },
        4013 => WireError::Limit {
            detail: "Device state subscriber capacity reached".into(),
        },
        _ => WireError::Offline {
            detail: if reason.is_empty() {
                format!("Connection closed ({code})")
            } else {
                format!("Connection closed ({code}): {reason}")
            },
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Serialize)]
    struct HealthReq {
        #[serde(rename = "type")]
        msg_type: &'static str,
    }

    #[test]
    fn encode_hello_formats_token_or_ticket() {
        let mut buf = String::new();
        let token = Token::parse("a".repeat(64)).unwrap();
        encode_hello(&DeviceId::local_cli(), Credential::Token(&token), &mut buf).unwrap();
        assert_eq!(
            buf,
            format!(
                r#"{{"type":"hello","protocolVersion":1,"deviceId":"ace-cli","token":"{}"}}"#,
                "a".repeat(64)
            )
        );

        let ticket = Ticket::parse("b".repeat(64)).unwrap();
        encode_hello(
            &DeviceId::local_agent(),
            Credential::Ticket(&ticket),
            &mut buf,
        )
        .unwrap();
        assert_eq!(
            buf,
            format!(
                r#"{{"type":"hello","protocolVersion":1,"deviceId":"ace-agent","ticket":"{}"}}"#,
                "b".repeat(64)
            )
        );
    }

    #[test]
    fn encode_request_injects_request_id_without_value_dom() {
        let mut scratch = Vec::new();
        let mut out = String::new();
        let req_id = RequestId::parse("r1").unwrap();
        encode_request_into(
            &HealthReq {
                msg_type: "diagnostics.health",
            },
            &req_id,
            &mut scratch,
            &mut out,
        )
        .unwrap();
        assert_eq!(out, r#"{"requestId":"r1","type":"diagnostics.health"}"#);
    }

    #[test]
    fn decode_welcome_ignores_unknown_fields_and_checks_host_id() {
        let frame = r#"{"type":"welcome","hostId":"host-1","protocolVersion":1,"headSeq":42,"futureFlag":true,"nested":{"x":1}}"#;
        let welcome = decode_welcome(frame, None).unwrap();
        assert_eq!(welcome.host_id.as_str(), "host-1");
        assert_eq!(welcome.head_seq, 42);

        let wrong_host = HostId::parse("host-2").unwrap();
        let err = decode_welcome(frame, Some(&wrong_host)).unwrap_err();
        assert!(matches!(err, WireError::Identity { .. }));
    }

    #[test]
    fn close_codes_match_ts_lifecycle_rules() {
        assert_eq!(
            classify_close_code(4001, "unauthorized"),
            WireError::Auth {
                detail: "unauthorized".into(),
                revoked: false,
            }
        );
        assert!(matches!(
            classify_close_code(4001, "Credential replaced"),
            WireError::Offline { .. }
        ));
        assert_eq!(
            classify_close_code(4003, "Device revoked"),
            WireError::Auth {
                detail: "Device revoked".into(),
                revoked: true,
            }
        );
        assert!(matches!(
            classify_close_code(4011, "machine_code_required"),
            WireError::MachineCode { .. }
        ));
        assert!(matches!(
            classify_close_code(4002, "bad frame"),
            WireError::Protocol { .. }
        ));
        assert!(matches!(
            classify_close_code(1006, ""),
            WireError::Offline { .. }
        ));
    }
}
