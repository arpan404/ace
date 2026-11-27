// SPDX-License-Identifier: Apache-2.0
//! Pairing links (`pairing-codes.ts`, `pairing-issue.ts`, `@ace/client`'s `pairing-link.ts`): the
//! one-use code, its store (in memory, or in the daemon's database by the code's SHA-256 so a
//! restart doesn't void a link being scanned), the request a link is made from, and the URL a
//! person opens. Codes are never stored or logged, only their hashes.

use ace_json::Value;

use crate::devices::Scope;

pub mod codes;
pub mod link;

pub use codes::{MemoryPairingCodes, PairingCodeStore, SqlitePairingCodes};

/// A JSON number read as the integer a `PairingRequest` TTL must be. A string, a boolean or a
/// fraction is `None`, which `parse` turns into the schema's refusal rather than a default: zod's
/// literal unions reject `"300000"` and `300000.5` alike (`remote.ts:34`-`:50`).
fn integer_field(value: &Value) -> Option<i64> {
    let Value::Number(number) = value else {
        return None;
    };
    let number = number.as_f64()?;
    if !number.is_finite() || number.fract() != 0.0 {
        return None;
    }
    Some(number as i64)
}
pub use link::pairing_link_url;

/// A pairing link waiting to be redeemed. Its code is known only by its hash.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingCode {
    pub id: String,
    pub expires_at: i64,
    pub scopes: Vec<Scope>,
    pub label: Option<String>,
    pub device_ttl_ms: Option<i64>,
    /// Made by someone with the person's standing (ADR 0190); its device inherits that.
    pub person: bool,
}

/// What a pairing link grants beyond its scopes (`remote-auth.ts:23`–`:35`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PairingTerms {
    /// Names the redeemed device instead of the name it sends.
    pub label: Option<String>,
    /// How long the link can be redeemed; 5 minutes when omitted.
    pub ttl_ms: Option<i64>,
    /// How long the paired device keeps access; until revoked when omitted or null.
    pub device_ttl_ms: Option<i64>,
    /// Its maker had the person's standing (ADR 0190).
    pub person: bool,
}

/// A pairing link not yet redeemed or expired (`PendingPairing`, `remote.ts:56`). Never carries
/// its code or URL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingPairing {
    pub id: String,
    pub label: Option<String>,
    pub scopes: Vec<Scope>,
    pub expires_at: i64,
    pub device_ttl_ms: Option<i64>,
}

impl From<&PendingCode> for PendingPairing {
    fn from(code: &PendingCode) -> Self {
        Self {
            id: code.id.clone(),
            label: code.label.clone(),
            scopes: code.scopes.clone(),
            expires_at: code.expires_at,
            device_ttl_ms: code.device_ttl_ms,
        }
    }
}

/// The scopes a link requests, `PairingRequest`'s rules (`remote.ts:46`–`:53`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairingRequest {
    pub scopes: Vec<Scope>,
    pub label: Option<String>,
    pub ttl_ms: Option<i64>,
    pub device_ttl_ms: Option<i64>,
}

const LINK_TTLS: [i64; 4] = [300_000, 3_600_000, 86_400_000, 604_800_000];
const DEVICE_TTLS: [i64; 3] = [86_400_000, 604_800_000, 2_592_000_000];

impl PairingRequest {
    /// Parse `POST /v1/pairings`' body. `None`: a body that doesn't match (`400 Invalid scopes`).
    pub fn parse(value: &Value) -> Option<Self> {
        let object = value.as_object()?;
        let scopes = match object.get("scopes") {
            None => vec![Scope::Read, Scope::Operate],
            Some(Value::Array(items)) => {
                if items.is_empty() || items.len() > 5 {
                    return None;
                }
                let mut scopes = Vec::with_capacity(items.len());
                for item in items {
                    let scope = Scope::parse(item.as_str()?)?;
                    if !scope.pairable() {
                        return None;
                    }
                    scopes.push(scope);
                }
                scopes
            }
            Some(_) => return None,
        };
        let label = match object.get("label") {
            None => None,
            Some(Value::String(text)) => {
                let label = text.as_str();
                // zod counts code points, not UTF-16 units (rule 17).
                let length = label.chars().count();
                if !(1..=64).contains(&length) {
                    return None;
                }
                Some(label.to_owned())
            }
            Some(_) => return None,
        };
        let ttl_ms = match object.get("ttlMs") {
            None => None,
            // A field that is present but not one of the schema's integers is invalid, not
            // absent.
            Some(value) => match integer_field(value) {
                Some(ttl) if LINK_TTLS.contains(&ttl) => Some(ttl),
                _ => return None,
            },
        };
        let device_ttl_ms = match object.get("deviceTtlMs") {
            None | Some(Value::Null) => None,
            Some(value) => match integer_field(value) {
                Some(ttl) if DEVICE_TTLS.contains(&ttl) => Some(ttl),
                _ => return None,
            },
        };
        Some(Self {
            scopes,
            label,
            ttl_ms,
            device_ttl_ms,
        })
    }
}

/// Where a redeeming device reaches this daemon (`pairing-issue.ts:10`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PairingConnection {
    /// Its own HTTPS address and the TLS key it pins, with the person's own relay as a second way
    /// in when the daemon is also on one (ADR 0182).
    Direct {
        origin: String,
        fingerprint: String,
        also_relay: Option<RelayRoute>,
    },
    /// A self-hosted relay and the host key it pins there.
    Relay(RelayRoute),
}

/// A relay address and the host key to pin there.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelayRoute {
    pub url: String,
    pub host_id: String,
}

/// One pairing link as `POST /v1/pairings` and `fleet.request` issue it.
#[derive(Clone, PartialEq, Eq)]
pub struct IssuedPairing {
    pub id: String,
    pub url: String,
    pub code: String,
    pub expires_at: i64,
}

impl std::fmt::Debug for IssuedPairing {
    /// The code is a live credential, and the URL carries it in its fragment: Debug names only
    /// what a log may repeat.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("IssuedPairing")
            .field("id", &self.id)
            .field("url", &"<redacted>")
            .field("code", &"<redacted>")
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

/// The scope names a refusal quotes (`pairing-issue.ts:26`).
pub fn scope_label(scope: Scope) -> &'static str {
    match scope {
        Scope::Read => "Read",
        Scope::Operate => "Operate",
        Scope::Admin => "Admin",
        Scope::Projects => "Projects",
        Scope::Accounts => "Accounts",
        Scope::Desktop => "Desktop",
        Scope::UserBrowser => "Use my Chrome",
    }
}

#[cfg(test)]
mod tests {
    //! Ports `packages/client/src/pairing-link.test.ts`'s link generation (its parsing half is
    //! the client's), and `pairing-codes.ts`' memory store's single-use and expiry order.

    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::PairingRequest;
    use crate::devices::Scope;

    #[test]
    fn a_pairing_request_keeps_the_offered_scopes_and_lifetimes_only() {
        let request = PairingRequest::parse(
            &ace_json::parse("{\"scopes\":[\"read\",\"read\",\"operate\"]}").unwrap(),
        )
        .unwrap();
        assert_eq!(
            request.scopes,
            vec![Scope::Read, Scope::Read, Scope::Operate]
        );
        assert!(
            PairingRequest::parse(
                &ace_json::parse("{\"scopes\":[\"read\"],\"ttlMs\":123}").unwrap()
            )
            .is_none()
        );
        // A label's bound counts code points (rule 17): 64 emoji pass, 65 don't.
        let label = "😀".repeat(64);
        let request =
            PairingRequest::parse(&ace_json::parse(&format!("{{\"label\":\"{label}\"}}")).unwrap())
                .unwrap();
        assert_eq!(request.label.as_deref(), Some(label.as_str()));
        let long = "😀".repeat(65);
        assert!(
            PairingRequest::parse(&ace_json::parse(&format!("{{\"label\":\"{long}\"}}")).unwrap())
                .is_none()
        );
    }

    #[test]
    fn a_lifetime_must_be_one_of_the_schemas_integers_never_a_string_or_a_fraction() {
        // `remote.ts:34`-`:50`'s literal unions: a string TTL is not 300000, and 300000.5 is not
        // either, so `pairing-issue.ts:58` answers `400 Invalid scopes` instead of defaulting or
        // truncating.
        let parsed = |body: &str| PairingRequest::parse(&ace_json::parse(body).unwrap());
        for body in [
            "{\"ttlMs\":\"300000\"}",
            "{\"ttlMs\":300000.5}",
            "{\"ttlMs\":true}",
            "{\"deviceTtlMs\":\"86400000\"}",
            "{\"deviceTtlMs\":86400000.5}",
        ] {
            assert!(parsed(body).is_none(), "{body}");
        }
        assert_eq!(parsed("{\"ttlMs\":300000}").unwrap().ttl_ms, Some(300_000));
        assert_eq!(
            parsed("{\"deviceTtlMs\":86400000}").unwrap().device_ttl_ms,
            Some(86_400_000)
        );
        // Omitted or null: the paired device keeps access until revoked.
        let null = parsed("{\"deviceTtlMs\":null}").unwrap();
        assert_eq!(null.device_ttl_ms, None);
        assert_eq!(null.ttl_ms, None);
    }
}
