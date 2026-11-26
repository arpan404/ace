// SPDX-License-Identifier: Apache-2.0
//! Pairing links (`pairing-codes.ts`, `pairing-issue.ts`, `@ace/client`'s `pairing-link.ts`): the
//! one-use code, its store (in memory, or in the daemon's database by the code's SHA-256 so a
//! restart doesn't void a link being scanned), the request a link is made from, and the URL a
//! person opens. Codes are never stored or logged, only their hashes.

use std::collections::HashMap;

use ace_json::Value;

use crate::devices::Scope;
use crate::error::{AuthError, Result};

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

/// Where pairing links wait. `take` is the single use: it removes the link as it returns it, so
/// one code can never pair two devices (`pairing-codes.ts:21`).
pub trait PairingCodeStore: Send {
    fn put(&mut self, code_hash: &str, pending: &PendingCode) -> Result<()>;
    fn take(&mut self, code_hash: &str) -> Result<Option<PendingCode>>;
    /// Unexpired links, oldest expiry first; expired ones are dropped on the way.
    fn pending(&mut self, now: i64) -> Result<Vec<PendingCode>>;
    fn remove(&mut self, id: &str) -> Result<bool>;
    fn clear(&mut self) -> Result<()>;
}

/// Links that last as long as the process, for embedded servers and tests (`pairing-codes.ts:31`).
#[derive(Debug, Default)]
pub struct MemoryPairingCodes {
    codes: HashMap<String, PendingCode>,
    order: Vec<String>,
}

impl MemoryPairingCodes {
    pub fn new() -> Self {
        Self::default()
    }
}

impl PairingCodeStore for MemoryPairingCodes {
    fn put(&mut self, code_hash: &str, pending: &PendingCode) -> Result<()> {
        if self
            .codes
            .insert(code_hash.to_owned(), pending.clone())
            .is_none()
        {
            self.order.push(code_hash.to_owned());
        }
        Ok(())
    }

    fn take(&mut self, code_hash: &str) -> Result<Option<PendingCode>> {
        let taken = self.codes.remove(code_hash);
        if taken.is_some() {
            self.order.retain(|key| key != code_hash);
        }
        Ok(taken)
    }

    fn pending(&mut self, now: i64) -> Result<Vec<PendingCode>> {
        let expired: Vec<String> = self
            .codes
            .iter()
            .filter(|(_, code)| code.expires_at <= now)
            .map(|(key, _)| key.clone())
            .collect();
        for key in &expired {
            self.codes.remove(key);
        }
        self.order.retain(|key| !expired.contains(key));
        let mut pending: Vec<PendingCode> = self
            .order
            .iter()
            .filter_map(|key| self.codes.get(key).cloned())
            .collect();
        // A stable sort keeps insertion order between links with the same expiry.
        pending.sort_by_key(|code| code.expires_at);
        Ok(pending)
    }

    fn remove(&mut self, id: &str) -> Result<bool> {
        let key = self
            .order
            .iter()
            .find(|key| self.codes.get(*key).is_some_and(|code| code.id == id))
            .cloned();
        match key {
            Some(key) => {
                self.codes.remove(&key);
                self.order.retain(|each| *each != key);
                Ok(true)
            }
            None => Ok(false),
        }
    }

    fn clear(&mut self) -> Result<()> {
        self.codes.clear();
        self.order.clear();
        Ok(())
    }
}

/// Links kept in the daemon's database, so a restart doesn't void one being scanned
/// (`pairing-codes.ts:85`). Only the code's SHA-256 is stored; a link still ends at its expiry.
pub struct SqlitePairingCodes {
    conn: std::sync::Arc<ace_store::Connection>,
}

impl SqlitePairingCodes {
    pub fn new(conn: std::sync::Arc<ace_store::Connection>) -> Result<Self> {
        conn.exec(
            "CREATE TABLE IF NOT EXISTS pairing_codes (\n\
             code_hash TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL,\n\
             scopes TEXT NOT NULL, label TEXT, device_ttl_ms INTEGER, person INTEGER)",
        )?;
        // A table from before links said who made them: a column added, no row rewritten.
        let columns = conn.prepare("SELECT name FROM pragma_table_info('pairing_codes')")?;
        let mut has_person = false;
        while let Some(values) = columns.step()? {
            if values.first().and_then(|value| match value {
                ace_store::Value::Text(text) => Some(text.as_str()),
                _ => None,
            }) == Some("person")
            {
                has_person = true;
            }
        }
        if !has_person {
            conn.exec("ALTER TABLE pairing_codes ADD COLUMN person INTEGER")?;
        }
        Ok(Self { conn })
    }

    fn all(&self, sql: &str, params: &[Option<ace_store::Value>]) -> Result<Vec<PendingCode>> {
        let statement = self.conn.prepare(sql)?;
        statement.bind(params)?;
        let mut codes = Vec::new();
        while let Some(values) = statement.step()? {
            codes.push(decode_row(&values)?);
        }
        Ok(codes)
    }
}

impl PairingCodeStore for SqlitePairingCodes {
    fn put(&mut self, code_hash: &str, pending: &PendingCode) -> Result<()> {
        let statement = self.conn.prepare(
            "INSERT INTO pairing_codes (code_hash, id, expires_at, scopes, label, device_ttl_ms, \
             person) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )?;
        statement.bind(&[
            text(code_hash),
            text(&pending.id),
            integer(pending.expires_at),
            text(&scopes_json(&pending.scopes)),
            opt_text(pending.label.as_deref()),
            opt_integer(pending.device_ttl_ms),
            integer(i64::from(pending.person)),
        ])?;
        statement.step()?;
        Ok(())
    }

    fn take(&mut self, code_hash: &str) -> Result<Option<PendingCode>> {
        let statement = self
            .conn
            .prepare("DELETE FROM pairing_codes WHERE code_hash = ? RETURNING *")?;
        statement.bind(&[text(code_hash)])?;
        match statement.step()? {
            Some(values) => Ok(Some(decode_row(&values)?)),
            None => Ok(None),
        }
    }

    fn pending(&mut self, now: i64) -> Result<Vec<PendingCode>> {
        let expired = self
            .conn
            .prepare("DELETE FROM pairing_codes WHERE expires_at <= ?")?;
        expired.bind(&[integer(now)])?;
        expired.step()?;
        self.all("SELECT * FROM pairing_codes ORDER BY expires_at, id", &[])
    }

    fn remove(&mut self, id: &str) -> Result<bool> {
        let statement = self
            .conn
            .prepare("DELETE FROM pairing_codes WHERE id = ?")?;
        statement.bind(&[text(id)])?;
        statement.step()?;
        Ok(statement.changes()?.0 > 0)
    }

    fn clear(&mut self) -> Result<()> {
        self.conn.exec("DELETE FROM pairing_codes")?;
        Ok(())
    }
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
        // A field that is present but not a number is invalid, not absent.
        let ttl_ms = match object.get("ttlMs") {
            None => None,
            Some(value) => match integer_field(Some(value)) {
                Some(ttl) if LINK_TTLS.contains(&ttl) => Some(ttl),
                _ => return None,
            },
        };
        let device_ttl_ms = match object.get("deviceTtlMs") {
            None | Some(Value::Null) => None,
            Some(value) => match integer_field(Some(value)) {
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
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IssuedPairing {
    pub id: String,
    pub url: String,
    pub code: String,
    pub expires_at: i64,
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

/// The link a person opens to pair (`pairing-link.ts:102`). Code and fingerprint travel in the
/// URL fragment, which no HTTP request carries.
pub fn pairing_link_url(
    connection: &PairingConnection,
    code: &str,
    scopes: &[Scope],
    app: Option<&str>,
) -> String {
    let names: Vec<&str> = scopes.iter().map(|scope| scope.as_str()).collect();
    let scopes = names.join(",");
    match connection {
        PairingConnection::Relay(relay) => {
            let base = app.unwrap_or("https://app.acehq.dev");
            format!(
                "{}/pair#{}",
                origin(base),
                form(&[
                    ("relay", relay.url.as_str()),
                    ("hostId", relay.host_id.as_str()),
                    ("code", code),
                    ("scopes", &scopes),
                ])
            )
        }
        PairingConnection::Direct {
            origin: daemon,
            fingerprint,
            also_relay,
        } => {
            let daemon = origin(daemon);
            let base = match app {
                Some(app) => origin(app),
                None => daemon.clone(),
            };
            let mut fields: Vec<(&str, &str)> = Vec::new();
            let host;
            if app.is_some() {
                host = daemon.clone();
                fields.push(("host", host.as_str()));
            }
            fields.push(("fingerprint", fingerprint.as_str()));
            fields.push(("code", code));
            fields.push(("scopes", scopes.as_str()));
            if let Some(relay) = also_relay {
                fields.push(("viaRelay", relay.url.as_str()));
                fields.push(("viaRelayHostId", relay.host_id.as_str()));
            }
            format!("{base}/pair#{}", form(&fields))
        }
    }
}

/// A URL's origin (`new URL(value).origin`): scheme, host and port, without a path.
fn origin(value: &str) -> String {
    let (scheme, rest) = value.split_once("://").unwrap_or(("https", value));
    let authority = rest
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default()
        .trim_end_matches('/');
    format!("{scheme}://{authority}")
}

/// `URLSearchParams.toString()`: application/x-www-form-urlencoded, spaces as `+`.
fn form(fields: &[(&str, &str)]) -> String {
    let mut out = String::new();
    for (index, (key, value)) in fields.iter().enumerate() {
        if index > 0 {
            out.push('&');
        }
        percent(key, &mut out);
        out.push('=');
        percent(value, &mut out);
    }
    out
}

fn percent(value: &str, out: &mut String) {
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => {
                out.push(byte as char)
            }
            b' ' => out.push('+'),
            other => {
                out.push('%');
                out.push_str(&format!("{other:02X}"));
            }
        }
    }
}

fn decode_row(values: &[ace_store::Value]) -> Result<PendingCode> {
    use ace_store::Value as Sql;
    let field = |index: usize| values.get(index).cloned().unwrap_or(Sql::Null);
    let id = match field(1) {
        Sql::Text(text) => text,
        _ => {
            return Err(AuthError::Token(
                "a pairing_codes row names no id".to_owned(),
            ));
        }
    };
    let expires_at = match field(2) {
        Sql::Integer(number) => number,
        _ => {
            return Err(AuthError::Token(
                "a pairing_codes row names no expiry".to_owned(),
            ));
        }
    };
    let scopes = match field(3) {
        Sql::Text(text) => decode_scopes(&text),
        _ => Vec::new(),
    };
    Ok(PendingCode {
        id,
        expires_at,
        scopes,
        label: match field(4) {
            Sql::Text(text) => Some(text),
            _ => None,
        },
        device_ttl_ms: match field(5) {
            Sql::Integer(number) => Some(number),
            _ => None,
        },
        person: matches!(field(6), Sql::Integer(1)),
    })
}

fn decode_scopes(text: &str) -> Vec<Scope> {
    match ace_json::parse(text) {
        Ok(value) => value
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_str().and_then(Scope::parse))
                    .collect()
            })
            .unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

fn integer_field(value: Option<&Value>) -> Option<i64> {
    match value {
        Some(Value::Number(number)) => number.as_f64().map(|value| value as i64),
        _ => None,
    }
}

fn scopes_json(scopes: &[Scope]) -> String {
    let names: Vec<String> = scopes
        .iter()
        .map(|scope| format!("\"{}\"", scope.as_str()))
        .collect();
    format!("[{}]", names.join(","))
}

fn text(value: &str) -> Option<ace_store::Value> {
    Some(ace_store::Value::Text(value.to_owned()))
}

fn integer(value: i64) -> Option<ace_store::Value> {
    Some(ace_store::Value::Integer(value))
}

fn opt_integer(value: Option<i64>) -> Option<ace_store::Value> {
    value.map(ace_store::Value::Integer)
}

fn opt_text(value: Option<&str>) -> Option<ace_store::Value> {
    value.map(|text| ace_store::Value::Text(text.to_owned()))
}
#[cfg(test)]
mod tests {
    //! Ports `packages/client/src/pairing-link.test.ts`'s link generation (its parsing half is
    //! the client's), and `pairing-codes.ts`' memory store's single-use and expiry order.

    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::{
        MemoryPairingCodes, PairingCodeStore, PairingConnection, PairingRequest, PendingCode,
        RelayRoute, pairing_link_url,
    };
    use crate::devices::Scope;

    const PIN: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const DAEMON: &str = "https://studio.tail1234.ts.net:4243";

    #[test]
    fn a_link_on_the_daemons_own_web_app_pairs_with_that_daemon() {
        let url = pairing_link_url(
            &PairingConnection::Direct {
                origin: DAEMON.to_owned(),
                fingerprint: PIN.to_owned(),
                also_relay: None,
            },
            "c0de",
            &[Scope::Read],
            None,
        );
        assert_eq!(
            url,
            format!("{DAEMON}/pair#fingerprint={PIN}&code=c0de&scopes=read")
        );
    }

    #[test]
    fn a_link_on_the_hosted_web_app_opens_there_and_still_names_the_daemon() {
        let url = pairing_link_url(
            &PairingConnection::Direct {
                origin: format!("{DAEMON}/"),
                fingerprint: PIN.to_owned(),
                also_relay: None,
            },
            "c0de",
            &[Scope::Read, Scope::Operate],
            Some("https://app.acehq.dev"),
        );
        assert_eq!(
            url,
            format!(
                "https://app.acehq.dev/pair#host=https%3A%2F%2Fstudio.tail1234.ts.net%3A4243\
                 &fingerprint={PIN}&code=c0de&scopes=read%2Coperate"
            )
        );
    }

    #[test]
    fn a_relay_link_opens_the_web_app_and_names_the_relay_and_host_key() {
        let host_id = "A".repeat(52);
        let url = pairing_link_url(
            &PairingConnection::Relay(RelayRoute {
                url: "wss://relay.example.com/".to_owned(),
                host_id: host_id.clone(),
            }),
            "c0de",
            &[Scope::Read],
            Some("https://app.acehq.dev"),
        );
        assert_eq!(
            url,
            format!(
                "https://app.acehq.dev/pair#relay=wss%3A%2F%2Frelay.example.com%2F\
                 &hostId={host_id}&code=c0de&scopes=read"
            )
        );
    }

    #[test]
    fn a_direct_link_can_also_name_the_persons_own_relay_as_a_second_way_in() {
        let host_id = "A".repeat(52);
        let url = pairing_link_url(
            &PairingConnection::Direct {
                origin: "https://192.168.1.4:7443/".to_owned(),
                fingerprint: PIN.to_owned(),
                also_relay: Some(RelayRoute {
                    url: "wss://relay.example.com/".to_owned(),
                    host_id: host_id.clone(),
                }),
            },
            "c0de",
            &[Scope::Read, Scope::Operate],
            None,
        );
        assert_eq!(
            url,
            format!(
                "https://192.168.1.4:7443/pair#fingerprint={PIN}&code=c0de\
                 &scopes=read%2Coperate&viaRelay=wss%3A%2F%2Frelay.example.com%2F\
                 &viaRelayHostId={host_id}"
            )
        );
    }

    #[test]
    fn a_memory_link_is_taken_once_and_expires_on_the_way_out() {
        let mut codes = MemoryPairingCodes::new();
        let code = PendingCode {
            id: "pairing-1".to_owned(),
            expires_at: 10_000,
            scopes: vec![Scope::Read],
            label: None,
            device_ttl_ms: None,
            person: false,
        };
        codes.put("hash", &code).unwrap();
        assert_eq!(codes.pending(9_999).unwrap().len(), 1);
        assert_eq!(codes.take("hash").unwrap(), Some(code.clone()));
        assert_eq!(codes.take("hash").unwrap(), None);
        let later = PendingCode {
            id: "pairing-2".to_owned(),
            expires_at: 20_000,
            ..code
        };
        codes.put("hash", &later).unwrap();
        assert_eq!(codes.pending(10_000).unwrap().len(), 1);
        // At its expiry the store drops it on the way out, so it can never be taken again.
        assert!(codes.pending(20_000).unwrap().is_empty());
        assert_eq!(codes.take("hash").unwrap(), None);
    }

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
}
