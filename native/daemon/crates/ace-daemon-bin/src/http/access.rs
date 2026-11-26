// SPDX-License-Identifier: Apache-2.0
//! The access HTTP routes T2 owns, beyond status and stop: tickets for a paired
//! device, the device list and revocation, pairing redemption and issuance
//! (`apps/daemon/src/access-http.ts`).
//!
//! The decisions are `ace-auth`'s; this module parses the bodies the protocol
//! schemas accept, calls `DaemonAuth`, and renders the same JSON and status the
//! TypeScript renders. `/v1/status` and `/v1/stop` stay in `http.rs`.

use http::StatusCode;
use serde_json::{Value, json};

use super::{HttpState, Reply};
use crate::auth::DaemonAuth;

/// `POST /v1/tickets`: a fresh one-use ticket for the device the bearer names.
pub(super) fn ticket(state: &HttpState, token: &str) -> Reply {
    let Some(device) = state.config.auth.bearer(token) else {
        return error(StatusCode::UNAUTHORIZED, "Device token required");
    };
    match state.config.auth.ticket(&device) {
        Ok(ticket) => (
            StatusCode::OK,
            json!({"ticket": ticket.ticket, "expiresAt": ticket.expires_at}),
        ),
        Err(refusal) => auth_error(&refusal),
    }
}

/// `GET /v1/devices`: every device this daemon knows, admin only.
pub(super) fn devices(state: &HttpState, token: &str) -> Reply {
    if !state.config.auth.is_admin(token) {
        return error(StatusCode::FORBIDDEN, "Admin scope required");
    }
    match state.config.auth.devices() {
        Ok(devices) => (
            StatusCode::OK,
            Value::Array(devices.iter().map(device_value).collect()),
        ),
        Err(refusal) => auth_error(&refusal),
    }
}

/// `DELETE /v1/devices/<id>`: revoke one, admin only.
pub(super) fn revoke(state: &HttpState, token: &str, id: &str) -> Reply {
    if !state.config.auth.is_admin(token) {
        return error(StatusCode::FORBIDDEN, "Admin scope required");
    }
    match state.config.auth.revoke(id) {
        Ok(true) => (StatusCode::OK, json!({"revoked": true})),
        Ok(false) => error(StatusCode::NOT_FOUND, "Active device not found"),
        Err(refusal) => auth_error(&refusal),
    }
}

/// `POST /v1/pair`: redeem a pairing link. No credential; the code is the proof.
/// Every attempt counts before the body is read, as `remote-auth.ts:313` does.
pub(super) fn pair(state: &HttpState, body: &[u8], source: &str) -> Reply {
    let address =
        if crate::testing::var("ACE_TEST_PAIRING_ADDRESSES").as_deref() == Some("distinct") {
            use std::sync::atomic::{AtomicU64, Ordering};
            static NEXT: AtomicU64 = AtomicU64::new(1);
            format!("test-{}", NEXT.fetch_add(1, Ordering::Relaxed))
        } else {
            source.to_owned()
        };
    if let Err(refusal) = state.config.auth.pairing_attempt(&address) {
        return auth_error(&refusal);
    }
    let body = match parse_body(body) {
        Ok(body) => body,
        Err(reply) => return reply,
    };
    let Some(code) = body.get("code").and_then(Value::as_str) else {
        return error(StatusCode::BAD_REQUEST, "Invalid pairing redemption");
    };
    let Some(name) = body.get("name").and_then(Value::as_str) else {
        return error(StatusCode::BAD_REQUEST, "Invalid pairing redemption");
    };
    if code.is_empty()
        || code.chars().count() > 256
        || name.is_empty()
        || name.chars().count() > 256
    {
        return error(StatusCode::BAD_REQUEST, "Invalid pairing redemption");
    }
    let install_id = match body.get("installId") {
        None => None,
        Some(Value::String(text)) => {
            let id = text.as_str();
            if !(8..=64).contains(&id.len())
                || !id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            {
                return error(StatusCode::BAD_REQUEST, "Invalid pairing redemption");
            }
            Some(id)
        }
        Some(_) => return error(StatusCode::BAD_REQUEST, "Invalid pairing redemption"),
    };
    let standing_key = match body.get("standingKey") {
        None => None,
        Some(Value::String(text)) => {
            let key = text.as_str();
            if key.len() != 87
                || !key
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
            {
                return error(StatusCode::BAD_REQUEST, "Invalid pairing redemption");
            }
            Some(key)
        }
        Some(_) => return error(StatusCode::BAD_REQUEST, "Invalid pairing redemption"),
    };
    match state
        .config
        .auth
        .redeem(code, name, install_id, standing_key)
    {
        Ok(redeemed) => (
            StatusCode::OK,
            json!({"device": device_value(&redeemed.device), "token": redeemed.token}),
        ),
        Err(refusal) => auth_error(&refusal),
    }
}

/// `POST /v1/pairings`: issue one link, admin only, when remote access is on.
pub(super) fn pairings(state: &HttpState, token: &str, body: &[u8]) -> Reply {
    if !state.config.auth.is_admin(token) {
        return error(StatusCode::FORBIDDEN, "Admin scope required");
    }
    let origin = state
        .config
        .pairing
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .clone();
    let Some(origin) = origin else {
        return error(
            StatusCode::CONFLICT,
            "Turn on remote access in Settings, then choose LAN or Tailscale to pair.",
        );
    };
    let body = match parse_body_or_empty(body) {
        Ok(body) => body,
        Err(reply) => return reply,
    };
    let Ok(json) = ace_json::parse(&body.to_string()) else {
        return error(StatusCode::BAD_REQUEST, "Invalid scopes");
    };
    let Some(request) = ace_auth::pairing::PairingRequest::parse(&json) else {
        return error(StatusCode::BAD_REQUEST, "Invalid scopes");
    };
    // The creator may grant only what it holds (ADR 0070): admin does not imply
    // projects or accounts (`pairing-issue.ts:59`).
    let creator = state.config.auth.creator_scopes(token);
    if let Some(held) = &creator {
        for scope in &request.scopes {
            if !held.contains(scope) {
                return error(
                    StatusCode::FORBIDDEN,
                    &format!(
                        "You can't grant {}: this device doesn't have it.",
                        ace_auth::pairing::scope_label(*scope)
                    ),
                );
            }
        }
    }
    let scopes = request.scopes.clone();
    let terms = ace_auth::PairingTerms {
        label: request.label.clone(),
        ttl_ms: request.ttl_ms,
        device_ttl_ms: request.device_ttl_ms,
        person: false,
    };
    match state.config.auth.issue_pairing(&scopes, &terms) {
        Ok(issued) => {
            let url =
                DaemonAuth::pairing_url(&origin.origin, &origin.fingerprint, &issued.code, &scopes);
            (
                StatusCode::OK,
                json!({"url": url, "expiresAt": issued.expires_at, "id": issued.id}),
            )
        }
        Err(refusal) => auth_error(&refusal),
    }
}

/// One device as the protocol's `Device` renders it.
fn device_value(device: &ace_auth::devices::Device) -> Value {
    json!({
        "id": device.id,
        "name": device.name,
        "scopes": device.scopes.iter().map(|scope| scope.as_str()).collect::<Vec<_>>(),
        "createdAt": device.created_at,
        "lastSeenAt": device.last_seen_at,
        "revokedAt": device.revoked_at,
        "expiresAt": device.expires_at,
    })
}

fn error(status: StatusCode, message: &str) -> Reply {
    (status, json!({"error": message}))
}

fn auth_error(refusal: &ace_auth::AuthError) -> Reply {
    let status =
        StatusCode::from_u16(refusal.status()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    (status, json!({"error": refusal.message()}))
}

/// `body(request)`: a JSON object, or `400 JSON object required`.
fn parse_body(body: &[u8]) -> Result<Value, Reply> {
    match serde_json::from_slice(body) {
        Ok(Value::Object(object)) => Ok(Value::Object(object)),
        _ => Err(error(StatusCode::BAD_REQUEST, "JSON object required")),
    }
}

/// `optionalBody`: an empty body is `{}`.
fn parse_body_or_empty(body: &[u8]) -> Result<Value, Reply> {
    if body.iter().all(u8::is_ascii_whitespace) {
        return Ok(json!({}));
    }
    parse_body(body)
}
