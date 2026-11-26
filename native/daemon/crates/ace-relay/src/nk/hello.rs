// SPDX-License-Identifier: Apache-2.0
//! The one-round-trip relay handshake's client half (`packages/protocol/src/relay-handshake.ts`):
//! `hello.early`, an allowlist rather than today's hello because a recorder can replay a first
//! message, and `hello.confirm`, which only the holder of the first message's ephemeral key can
//! send. Every field outside the allowlist is refused here, and the ones a client needs act on the
//! device only in the confirmation.

use ace_json::Value;

/// The handshake name a daemon announces in its welcome when it takes NK (`relayHandshakes`).
pub const RELAY_NK_HANDSHAKE: &str = "nk1";

/// At most this many thread subscribes, and sidebar windows, ride in a first message.
pub const EARLY_THREAD_SUBSCRIBES: usize = 4;
pub const EARLY_SIDEBAR_WINDOWS: usize = 2;
/// Both kinds together, as the array's own bound.
pub const EARLY_SUBSCRIBES: usize = EARLY_THREAD_SUBSCRIBES + EARLY_SIDEBAR_WINDOWS;

pub mod subscribe;

pub use subscribe::{EarlyScope, EarlySubscribe, Tail, Window};

/// A first message's hello (`HelloEarly`).
#[derive(Clone, PartialEq, Eq)]
pub struct HelloEarly {
    pub device_id: String,
    /// A one-use ticket the daemon handed in its last welcome to this device.
    pub ticket: Option<String>,
    /// The account device grant, as the relay upgrade already offered it.
    pub grant: Option<String>,
    pub trims: Vec<String>,
    pub framing: Vec<String>,
    pub compression: Vec<String>,
    pub flow_control: Vec<String>,
    pub subscribes: Vec<EarlySubscribe>,
}

/// The client's first transport message after the daemon's NK answer (`HelloConfirm`).
#[derive(Clone, PartialEq, Eq)]
pub struct HelloConfirm {
    pub install_id: Option<String>,
    pub link: Option<PairingLinkProof>,
    pub next_ticket: bool,
    pub machine_code: Option<String>,
}

/// A pairing credential's proof, carried by a confirmation of the same install (ADR 0115).
#[derive(Clone, PartialEq, Eq)]
pub struct PairingLinkProof {
    pub device_id: String,
    pub proof: String,
}

pub(super) const MAX_SAFE: u64 = 9_007_199_254_740_991;

fn string_at<'a>(object: &'a ace_json::Map, key: &str) -> Option<&'a str> {
    object.get(key).and_then(Value::as_str)
}

fn names(object: &ace_json::Map, key: &str, max: usize) -> Option<Vec<String>> {
    match object.get(key) {
        None => Some(Vec::new()),
        Some(Value::Array(items)) => {
            if items.len() > max {
                return None;
            }
            let mut names = Vec::with_capacity(items.len());
            for item in items {
                let name = item.as_str()?;
                if name.chars().count() > 32 {
                    return None;
                }
                names.push(name.to_owned());
            }
            Some(names)
        }
        Some(_) => None,
    }
}

/// An integer in `[min, max]`, as zod's `.int()` reads a JSON number.
fn integer(object: &ace_json::Map, key: &str, min: f64, max: f64) -> Option<f64> {
    let value = object.get(key)?.as_f64()?;
    (value.fract() == 0.0 && (min..=max).contains(&value)).then_some(value)
}

/// Every key present is in `allowed`: `z.strictObject`'s rule
/// (the protocol's schema refuses unknown fields here, unlike provider frames).
fn only_keys(object: &ace_json::Map, allowed: &[&str]) -> bool {
    object
        .iter()
        .all(|(key, _)| allowed.contains(&key.as_str()))
}

impl std::fmt::Debug for HelloEarly {
    /// The ticket and the grant are live bearers: Debug names that they are present, never them.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HelloEarly")
            .field("device_id", &self.device_id)
            .field("ticket", &self.ticket.is_some())
            .field("grant", &self.grant.is_some())
            .field("subscribes", &self.subscribes.len())
            .finish_non_exhaustive()
    }
}

impl std::fmt::Debug for HelloConfirm {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HelloConfirm")
            .field("install_id", &self.install_id.is_some())
            .field("link", &self.link.is_some())
            .field("next_ticket", &self.next_ticket)
            .field("machine_code", &self.machine_code.is_some())
            .finish_non_exhaustive()
    }
}

impl std::fmt::Debug for PairingLinkProof {
    /// The proof is a bearer of the paired credential's authority: only its device is named.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PairingLinkProof")
            .field("device_id", &self.device_id)
            .finish_non_exhaustive()
    }
}

impl HelloEarly {
    /// Parse a first message's payload. `None`: not a `hello.early` this daemon takes.
    pub fn parse(value: &Value) -> Option<Self> {
        let object = value.as_object()?;
        if !only_keys(
            object,
            &[
                "type",
                "protocolVersion",
                "deviceId",
                "ticket",
                "grant",
                "trims",
                "framing",
                "compression",
                "flowControl",
                "subscribes",
            ],
        ) {
            return None;
        }
        if string_at(object, "type")? != "hello.early" {
            return None;
        }
        if integer(object, "protocolVersion", 1.0, 1.0)? != 1.0 {
            return None;
        }
        let device_id = string_at(object, "deviceId")?;
        if device_id.is_empty() {
            return None;
        }
        let ticket = match object.get("ticket") {
            None => None,
            Some(Value::String(ticket)) => {
                let text = ticket.as_str();
                if !crate::is_ticket(text) {
                    return None;
                }
                Some(text.to_owned())
            }
            Some(_) => return None,
        };
        let grant = match object.get("grant") {
            None => None,
            Some(Value::String(grant)) => {
                let text = grant.as_str();
                if !(1..=2_048).contains(&text.chars().count()) {
                    return None;
                }
                Some(text.to_owned())
            }
            Some(_) => return None,
        };
        if ticket.is_some() == grant.is_some() {
            return None;
        }
        let subscribes = match object.get("subscribes") {
            None => Vec::new(),
            Some(Value::Array(items)) => {
                if items.len() > EARLY_SUBSCRIBES {
                    return None;
                }
                let mut subscribes = Vec::with_capacity(items.len());
                for item in items {
                    subscribes.push(EarlySubscribe::parse(item)?);
                }
                let threads = subscribes
                    .iter()
                    .filter(|subscribe| subscribe.thread_id().is_some())
                    .count();
                let windows = subscribes.len() - threads;
                if threads > EARLY_THREAD_SUBSCRIBES || windows > EARLY_SIDEBAR_WINDOWS {
                    return None;
                }
                let mut ids = std::collections::HashSet::new();
                if !subscribes
                    .iter()
                    .all(|subscribe| ids.insert(subscribe.subscription_id.as_str()))
                {
                    return None;
                }
                subscribes
            }
            Some(_) => return None,
        };
        Some(Self {
            device_id: device_id.to_owned(),
            ticket,
            grant,
            trims: names(object, "trims", 16)?,
            framing: names(object, "framing", 8)?,
            compression: names(object, "compression", 8)?,
            flow_control: names(object, "flowControl", 8)?,
            subscribes,
        })
    }

    /// The threads a first message reads, for the daemon's budget checks (`earlyThreads`).
    pub fn early_threads(&self) -> Vec<&str> {
        self.subscribes
            .iter()
            .filter_map(EarlySubscribe::thread_id)
            .collect()
    }
}

impl HelloConfirm {
    pub fn parse(value: &Value) -> Option<Self> {
        let object = value.as_object()?;
        if !only_keys(
            object,
            &["type", "installId", "link", "nextTicket", "machineCode"],
        ) || string_at(object, "type")? != "hello.confirm"
        {
            return None;
        }
        let install_id = match object.get("installId") {
            None => None,
            Some(Value::String(install)) => {
                let id = install.as_str();
                if !(8..=64).contains(&id.len())
                    || !id
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
                {
                    return None;
                }
                Some(id.to_owned())
            }
            Some(_) => return None,
        };
        let link = match object.get("link") {
            None => None,
            Some(value) => {
                // `PairingLinkProof` is a plain `z.object`: unknown keys are stripped, not
                // refused, so a client that adds one still confirms.
                let link = value.as_object()?;
                let device_id = string_at(link, "deviceId")?;
                let proof = string_at(link, "proof")?;
                if device_id.is_empty()
                    || proof.len() != 43
                    || !proof
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
                {
                    return None;
                }
                Some(PairingLinkProof {
                    device_id: device_id.to_owned(),
                    proof: proof.to_owned(),
                })
            }
        };
        let next_ticket = match object.get("nextTicket") {
            None => false,
            Some(Value::Bool(true)) => true,
            Some(_) => return None,
        };
        let machine_code = match object.get("machineCode") {
            None => None,
            Some(Value::String(code)) => {
                let text = code.as_str();
                if !(4..=128).contains(&text.chars().count()) {
                    return None;
                }
                Some(text.to_owned())
            }
            Some(_) => return None,
        };
        Some(Self {
            install_id,
            link,
            next_ticket,
            machine_code,
        })
    }
}

#[cfg(test)]
mod tests;
