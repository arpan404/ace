// SPDX-License-Identifier: Apache-2.0
//! Remote machine profile types and validation (`apps/daemon/src/cli/profiles.ts`).
//!
//! Covers profile schema validation, direct-vs-relay route selection, and the single-use
//! `POST /v1/tickets` response shape. Reading `cli-profiles.sqlite` on disk is intentionally
//! left out of `cli-wire` so the crate carries no `SQLite` dependency.

use serde::Deserialize;

use crate::error::WireError;
use crate::origin::RemoteOrigin;
use crate::types::{DeviceId, Fingerprint, HostId, Ticket, Token};

/// Validated remote profile name (`/^[a-zA-Z0-9_.-]{1,64}$/` and not `"local"`).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ProfileName(String);

impl ProfileName {
    /// Parses and validates a remote profile name.
    pub fn parse(raw: &str) -> Result<Self, WireError> {
        if raw.is_empty()
            || raw.len() > 64
            || raw == "local"
            || !raw
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
        {
            return Err(WireError::InvalidTarget {
                detail: format!("Invalid remote profile name: {raw}"),
            });
        }
        Ok(Self(raw.to_owned()))
    }

    /// Borrowed profile name.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Relay routing metadata stored on a remote profile (`ProfileRelay` in `profiles.ts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileRelay {
    url: String,
    relay_host_id: String,
}

impl ProfileRelay {
    /// Validates and constructs a [`ProfileRelay`].
    pub fn parse(url: &str, relay_host_id: &str) -> Result<Self, WireError> {
        validate_relay_url(url)?;
        if relay_host_id.len() != 52
            || !relay_host_id
                .bytes()
                .all(|b| b.is_ascii_uppercase() || (b'2'..=b'7').contains(&b))
        {
            return Err(WireError::InvalidTarget {
                detail: "Invalid relayHostId in profile".into(),
            });
        }
        Ok(Self {
            url: url.to_owned(),
            relay_host_id: relay_host_id.to_owned(),
        })
    }

    /// Relay WebSocket URL (`ws://` or `wss://`).
    #[must_use]
    pub fn url(&self) -> &str {
        &self.url
    }

    /// 52-char base32 relay host identifier.
    #[must_use]
    pub fn relay_host_id(&self) -> &str {
        &self.relay_host_id
    }
}

/// A validated remote machine profile (`RemoteProfile` in `apps/daemon/src/cli/profiles.ts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteProfile {
    pub id: String,
    pub name: ProfileName,
    pub origin: Option<RemoteOrigin>,
    pub fingerprint: Option<Fingerprint>,
    pub relay: Option<ProfileRelay>,
    pub device_id: DeviceId,
    pub token: Token,
    pub host_id: Option<HostId>,
    pub label: Option<String>,
}

/// Borrowed direct-TLS connection target extracted from a [`RemoteProfile`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DirectRemote<'a> {
    pub origin: &'a RemoteOrigin,
    pub fingerprint: &'a Fingerprint,
    pub device_id: &'a DeviceId,
    pub token: &'a Token,
    pub host_id: Option<&'a HostId>,
}

impl RemoteProfile {
    /// Parses a remote profile from the JSON payload stored in `cli-profiles.sqlite`, ignoring
    /// unknown fields so newer daemon builds remain readable.
    pub fn from_json(raw: &str) -> Result<Self, WireError> {
        let wire: RawProfile =
            serde_json::from_str(raw).map_err(|err| WireError::InvalidTarget {
                detail: format!("Invalid remote profile JSON: {err}"),
            })?;
        if !is_uuid(&wire.id) {
            return Err(WireError::InvalidTarget {
                detail: "Remote profile id must be a UUID".into(),
            });
        }
        let name = ProfileName::parse(&wire.name)?;
        let origin = wire
            .origin
            .as_deref()
            .map(RemoteOrigin::parse)
            .transpose()?;
        let fingerprint = wire
            .fingerprint
            .as_deref()
            .map(Fingerprint::parse)
            .transpose()?;
        let relay = wire
            .relay
            .map(|r| ProfileRelay::parse(&r.url, &r.relay_host_id))
            .transpose()?;

        if origin.is_some() != fingerprint.is_some() || (origin.is_none() && relay.is_none()) {
            return Err(WireError::InvalidTarget {
                detail: "A profile needs a pinned TLS address, a relay, or both".into(),
            });
        }

        let device_id = DeviceId::parse(&wire.device_id)?;
        let token = Token::parse(&wire.token)?;
        let host_id = wire.host_id.as_deref().map(HostId::parse).transpose()?;
        if let Some(ref label) = wire.label
            && (label.is_empty() || label.len() > 256)
        {
            return Err(WireError::InvalidTarget {
                detail: "Remote profile label must be 1..=256 bytes".into(),
            });
        }

        Ok(Self {
            id: wire.id,
            name,
            origin,
            fingerprint,
            relay,
            device_id,
            token,
            host_id,
            label: wire.label,
        })
    }

    /// Returns the direct pinned-TLS target for this profile, or [`WireError::RelayOnly`] if the
    /// machine was linked through a relay only (matching `apps/daemon/src/cli/connection.ts`).
    pub fn direct(&self) -> Result<DirectRemote<'_>, WireError> {
        match (&self.origin, &self.fingerprint) {
            (Some(origin), Some(fingerprint)) => Ok(DirectRemote {
                origin,
                fingerprint,
                device_id: &self.device_id,
                token: &self.token,
                host_id: self.host_id.as_ref(),
            }),
            _ => Err(WireError::RelayOnly {
                name: self.name.as_str().to_owned(),
            }),
        }
    }
}

/// Single-use WebSocket ticket returned by `POST /v1/tickets` (`SocketTicket` in `remote.ts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SocketTicket {
    pub ticket: Ticket,
    pub expires_at: u64,
}

impl SocketTicket {
    /// Parses a `SocketTicket` JSON body, ignoring unknown fields.
    pub fn from_json(raw: &str) -> Result<Self, WireError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct RawTicket<'a> {
            ticket: &'a str,
            expires_at: u64,
        }
        let parsed: RawTicket<'_> =
            serde_json::from_str(raw).map_err(|err| WireError::Protocol {
                detail: format!("Malformed /v1/tickets response: {err}"),
            })?;
        Ok(Self {
            ticket: Ticket::parse(parsed.ticket)?,
            expires_at: parsed.expires_at,
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawProfile {
    id: String,
    name: String,
    #[serde(default)]
    origin: Option<String>,
    #[serde(default)]
    fingerprint: Option<String>,
    #[serde(default)]
    relay: Option<RawRelay>,
    device_id: String,
    token: String,
    #[serde(default)]
    host_id: Option<String>,
    #[serde(default)]
    label: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawRelay {
    url: String,
    relay_host_id: String,
}

fn validate_relay_url(raw: &str) -> Result<(), WireError> {
    let rest = raw
        .strip_prefix("wss://")
        .or_else(|| raw.strip_prefix("ws://"))
        .ok_or_else(|| WireError::InvalidTarget {
            detail: "Relay URL must start with ws:// or wss://".into(),
        })?;
    if rest.is_empty()
        || rest.contains('@')
        || rest.contains('?')
        || rest.contains('#')
        || rest.bytes().any(|b| b.is_ascii_control() || b == b' ')
    {
        return Err(WireError::InvalidTarget {
            detail: "Relay URL must not contain credentials, queries, or fragments".into(),
        });
    }
    Ok(())
}

fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 36 {
        return false;
    }
    for (i, &ch) in b.iter().enumerate() {
        let is_dash = matches!(i, 8 | 13 | 18 | 23);
        if is_dash {
            if ch != b'-' {
                return false;
            }
        } else if !ch.is_ascii_hexdigit() {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    const FP: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const TOK: &str = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
    const RELAY_ID: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    #[test]
    fn parses_direct_profile_and_ignores_unknown_fields() {
        let json = format!(
            r#"{{
                "id": "550e8400-e29b-41d4-a716-446655440000",
                "name": "studio-mac",
                "origin": "https://studio.tailnet.ts.net:7331/",
                "fingerprint": "{FP}",
                "deviceId": "dev-1",
                "token": "{TOK}",
                "hostId": "host-studio",
                "label": "Studio Mac",
                "unknownFuture": 123
            }}"#
        );
        let profile = RemoteProfile::from_json(&json).unwrap();
        let direct = profile.direct().unwrap();
        assert_eq!(direct.origin.host(), "studio.tailnet.ts.net");
        assert_eq!(direct.origin.port(), 7331);
        assert_eq!(direct.fingerprint.as_str(), FP);
        assert_eq!(direct.host_id.map(HostId::as_str), Some("host-studio"));
    }

    #[test]
    fn relay_only_profile_fails_direct_with_relay_only_exit_4() {
        let json = format!(
            r#"{{
                "id": "550e8400-e29b-41d4-a716-446655440000",
                "name": "office",
                "relay": {{ "url": "wss://relay.acehq.dev/v1", "relayHostId": "{RELAY_ID}" }},
                "deviceId": "dev-1",
                "token": "{TOK}"
            }}"#
        );
        let profile = RemoteProfile::from_json(&json).unwrap();
        let err = profile.direct().unwrap_err();
        assert!(matches!(err, WireError::RelayOnly { ref name } if name == "office"));
        assert_eq!(err.exit_code(), 4);
    }

    #[test]
    fn rejects_local_name_and_unpaired_origin_fingerprint() {
        assert!(ProfileName::parse("local").is_err());
        assert!(ProfileName::parse("bad name").is_err());
        let bad_json = format!(
            r#"{{
                "id": "550e8400-e29b-41d4-a716-446655440000",
                "name": "box",
                "origin": "https://box.local:7331/",
                "deviceId": "dev-1",
                "token": "{TOK}"
            }}"#
        );
        assert!(RemoteProfile::from_json(&bad_json).is_err());
    }

    #[test]
    fn socket_ticket_parses_and_ignores_unknown_fields() {
        let ticket = SocketTicket::from_json(&format!(
            r#"{{"ticket":"{TOK}","expiresAt":1770000000000,"extra":true}}"#
        ))
        .unwrap();
        assert_eq!(ticket.ticket.as_str(), TOK);
        assert_eq!(ticket.expires_at, 1_770_000_000_000);
    }
}
