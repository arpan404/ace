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
///
/// Matches the CLI's outer `AbortSignal.timeout(15000)` cap in `apps/daemon/src/cli/connection.ts`:
/// even when the daemon sends `{"type":"starting"}`, readiness never exceeds this outer cap.
pub const DEFAULT_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);

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

/// Borrowed metadata from an outgoing request JSON object used to match its expected reply type
/// and verify `entities.page` ownership.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OutgoingRequestMeta<'a> {
    #[serde(rename = "type", borrow)]
    pub msg_type: Cow<'a, str>,
    #[serde(default, borrow)]
    pub thread_id: Option<Cow<'a, str>>,
    #[serde(default, borrow)]
    pub collection: Option<Cow<'a, str>>,
}

pub(crate) fn parse_outgoing_request_meta(
    json_object: &str,
) -> Result<OutgoingRequestMeta<'_>, WireError> {
    serde_json::from_str(json_object).map_err(|err| WireError::Protocol {
        detail: format!("Request object must include a string \"type\" field: {err}"),
    })
}

/// Verifies that an `entities.page` reply belongs to the requested `threadId` and `collection`,
/// matching `decodeServiceResponse` in `packages/client/src/service-requests.ts`.
pub(crate) fn verify_entities_page_owner(
    reply_json: &str,
    expected_thread_id: Option<&str>,
    expected_collection: Option<&str>,
) -> Result<(), WireError> {
    #[derive(Deserialize)]
    struct Wrapper<'a> {
        #[serde(borrow)]
        page: PageOwner<'a>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct PageOwner<'a> {
        #[serde(borrow)]
        thread_id: Cow<'a, str>,
        #[serde(borrow)]
        collection: Cow<'a, str>,
    }

    let (Some(exp_thread), Some(exp_collection)) = (expected_thread_id, expected_collection) else {
        return Ok(());
    };
    let parsed: Wrapper<'_> =
        serde_json::from_str(reply_json).map_err(|err| WireError::Protocol {
            detail: format!("Malformed entities.page reply: {err}"),
        })?;
    if parsed.page.thread_id != exp_thread || parsed.page.collection != exp_collection {
        return Err(WireError::Protocol {
            detail: "Unexpected entity page owner".into(),
        });
    }
    Ok(())
}

/// Expected server reply `"type"` values for a given client request `"type"`, matching
/// `replyTypes` + prefix rules in `packages/client/src/service-requests.ts`.
#[must_use]
#[expect(
    clippy::too_many_lines,
    reason = "1:1 lookup table of protocol request->reply types"
)]
pub fn expected_reply_types(request_type: &str) -> Option<&'static [&'static str]> {
    match request_type {
        "cli.request" => Some(&["cli.result"]),
        "entities.page" => Some(&["entities.page"]),
        "items.page" => Some(&["items.page"]),
        "turns.page" => Some(&["turns.page"]),
        "items.window" => Some(&["items.window"]),
        "turn.steps" => Some(&["turn.steps"]),
        "item.raw" => Some(&["item.raw"]),
        "output.read" => Some(&["output.data"]),
        "interaction.read" => Some(&["interaction.data"]),
        "media.connect" => Some(&["media.connect.result"]),
        "notification.config" => Some(&["notification.config.result"]),
        "notification.register" => Some(&["notification.register.result"]),
        "notification.unregister" => Some(&["notification.unregister.result"]),
        "notification.feed" => Some(&["notification.feed.result"]),
        "prompts.request" => Some(&["prompts.result"]),
        "skills.request" => Some(&["skills.result"]),
        "spade.status" => Some(&["spade.status.result"]),
        "spade.grant.revoke" => Some(&["spade.grant.revoke.result"]),
        "spade.http" => Some(&["spade.http.result", "spade.http.open"]),
        "spade.http.read" => Some(&["spade.http.chunk"]),
        "host.identity" => Some(&["host.identity.result"]),
        "machine.code.status" | "machine.code.set" | "machine.code.clear" => {
            Some(&["machine.code.result"])
        }
        "lockedUse.subscribe" => Some(&["lockedUse.status"]),
        "lockedUse.unsubscribe" | "lockedUse.install" | "lockedUse.remove" | "lockedUse.repair" => {
            Some(&["lockedUse.result"])
        }
        "activity.reads" | "activity.markRead" => Some(&["activity.reads.result"]),
        "verify.request" => Some(&["verify.result"]),
        "icons.resolve" => Some(&["icons.resolve"]),
        "icons.read" => Some(&["icons.read"]),
        "avatars.resolve" => Some(&["avatars.resolve"]),
        "thread.search" => Some(&["thread.search"]),
        "thread.catchUp" => Some(&["thread.catchUp"]),
        "thread.readState" => Some(&["thread.readState"]),
        "permissions.capabilities" => Some(&["permissions.capabilities.result"]),
        "machines.request" => Some(&["machines.result"]),
        "fleet.request" => Some(&["fleet.result"]),
        "transfers.request" => Some(&["transfers.result"]),
        "pi.control" => Some(&["pi.result"]),
        "history.list" => Some(&["history.list"]),
        "history.release" => Some(&["history.release"]),
        "history.import" => Some(&["history.import"]),
        "history.continue" => Some(&["history.continue"]),
        "devices.request" => Some(&["devices.result"]),
        "preview.request" => Some(&["preview.result"]),
        "storage.request" => Some(&["storage.result"]),
        "admission.request" => Some(&["admission.result"]),
        "outside.request" => Some(&["outside.result"]),
        "appUpdate.request" => Some(&["appUpdate.result"]),
        "machineUpdate.request" => Some(&["machineUpdate.result"]),
        "user_browser.settings" => Some(&["user_browser.settings.result"]),
        "terminal.request" => Some(&["terminal.result"]),
        "workspace.request" => Some(&["workspace.result"]),
        "projects.request" => Some(&["projects.result"]),
        "source-control.request" => Some(&["source-control.result"]),
        "repositories.request" => Some(&["repositories.result"]),
        "providers.request" => Some(&["providers.result"]),
        "provider.accounts.list"
        | "provider.accounts.add"
        | "provider.accounts.rename"
        | "provider.accounts.setDefault"
        | "provider.accounts.remove"
        | "provider.accounts.reauth" => Some(&["provider.accounts.result"]),
        "provider.install.plan"
        | "provider.install.run"
        | "provider.install.poll"
        | "provider.install.active"
        | "provider.install.cancel" => Some(&["provider.install.result"]),
        "provider.login.apiKey"
        | "provider.login.start"
        | "provider.login.poll"
        | "provider.login.input"
        | "provider.login.cancel"
        | "provider.login.terminal"
        | "provider.logout" => Some(&["provider.login.result"]),
        "onboarding.query" | "onboarding.dismiss" => Some(&["onboarding.result"]),
        "worktree.creation.request" => Some(&["worktree.creation.result"]),
        "context.request" => Some(&["context.result"]),
        "models.list" | "models.refresh" | "models.load" | "models.resolve" => {
            Some(&["models.result"])
        }
        "settings.get"
        | "settings.set"
        | "settings.setMany"
        | "settings.reset"
        | "settings.subscribe"
        | "settings.unsubscribe" => Some(&["settings.result"]),
        "usage.summary" | "usage.series" => Some(&["usage.result"]),
        "usage.session_totals" => Some(&["usage.session_totals.result"]),
        "search.query" => Some(&["search.results", "search.error"]),
        "search.status" => Some(&["search.progress", "search.error"]),
        "accounts.add" | "accounts.rename" | "accounts.remove" | "accounts.setDefault" => {
            Some(&["accounts.changed"])
        }
        "accounts.login" | "accounts.logout" => Some(&["accounts.auth"]),
        "accounts.list" | "accounts.refreshLimits" => Some(&["accounts.list"]),
        "accounts.consumeReset" => Some(&["accounts.consumeReset"]),
        "accounts.status" => Some(&["accounts.status"]),
        "accounts.migrate" => Some(&["accounts.migrate"]),
        "files.pull" => Some(&["files.data", "files.error"]),
        "files.chunk" => Some(&["files.upload", "files.error"]),
        "files.request" => Some(&["files.result", "files.ready", "files.error", "files.upload"]),
        "catalog.list" => Some(&["catalog.list.result"]),
        "commands.list" => Some(&["commands.list.result"]),
        "commands.resolve" => Some(&["commands.resolve.result"]),
        "pluginRequest" => Some(&["pluginResult"]),
        "suitRequest" => Some(&["suitResult"]),
        "marketplace.request" => Some(&["marketplace.result"]),
        "account.standing" | "device.standing" => Some(&["account.standing.result"]),
        "account.owner.release" => Some(&["account.owner.release.result"]),
        "account.owner.enroll" => Some(&["account.owner.enroll.result"]),
        "account.owner.enroll.confirm" => Some(&["account.owner.enroll.confirm.result"]),
        "diagnostics.health" => Some(&["diagnostics.health.result"]),
        "diagnostics.request" => Some(&["diagnostics.result"]),
        "screen.request" => Some(&["screen.result"]),
        "automation.webhook" => Some(&["automation.webhookResult"]),
        other if other.starts_with("automation.") => Some(&["automation.result"]),
        other if other.starts_with("queue.") => Some(&["queue.result"]),
        other if other.starts_with("registry.") => Some(&["registry.result"]),
        other if other.starts_with("mcp.") => Some(&["mcp.result"]),
        other if other.starts_with("browser.") => Some(&["browser.result"]),
        _ => None,
    }
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

/// True for `CredentialReplacedClose` (`4001 "Credential replaced"`, ADR 0115).
#[must_use]
pub fn is_credential_replaced_close(code: u16, reason: &str) -> bool {
    code == 4001 && reason == "Credential replaced"
}

/// Maps a WebSocket close code and reason to [`WireError`], matching `disconnectDecision` and
/// `Connection.#lost` in `packages/client/src/lifecycle.ts` and `connection.ts`.
#[must_use]
pub fn classify_close_code(code: u16, reason: &str) -> WireError {
    match code {
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
