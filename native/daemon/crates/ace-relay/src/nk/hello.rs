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

/// What an early subscribe may read (`EarlyScope`): a thread, or a sidebar window with its limit,
/// project and archived filter.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EarlyScope {
    Thread { thread_id: String },
    Threads { window: Window },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Window {
    pub limit: u8,
    pub project: Option<String>,
    pub archived: Option<bool>,
}

/// A bounded tail a resume may ask for (`tail`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Tail {
    pub items: u8,
    pub bytes: usize,
}

/// A read subscribe, as the main socket takes it, with nothing more (`EarlySubscribe`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EarlySubscribe {
    pub subscription_id: String,
    pub scope: EarlyScope,
    pub paced: bool,
    pub after_seq: Option<u64>,
    pub tail: Option<Tail>,
}

/// A first message's hello (`HelloEarly`).
#[derive(Debug, Clone, PartialEq, Eq)]
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
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HelloConfirm {
    pub install_id: Option<String>,
    pub link: Option<PairingLinkProof>,
    pub next_ticket: bool,
    pub machine_code: Option<String>,
}

/// A pairing credential's proof, carried by a confirmation of the same install (ADR 0115).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairingLinkProof {
    pub device_id: String,
    pub proof: String,
}

const MAX_SAFE: u64 = 9_007_199_254_740_991;

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

impl EarlySubscribe {
    pub fn parse(value: &Value) -> Option<Self> {
        let object = value.as_object()?;
        if !only_keys(
            object,
            &["subscriptionId", "scope", "paced", "afterSeq", "tail"],
        ) {
            return None;
        }
        let subscription_id = string_at(object, "subscriptionId")?;
        let length = subscription_id.chars().count();
        if !(1..=128).contains(&length) {
            return None;
        }
        let scope = parse_scope(object.get("scope")?)?;
        let paced = match object.get("paced") {
            None => false,
            Some(Value::Bool(paced)) => *paced,
            Some(_) => return None,
        };
        let after_seq = match object.get("afterSeq") {
            None => None,
            Some(value) => {
                let number = value.as_f64()?;
                if number.fract() != 0.0 || !(0.0..=MAX_SAFE as f64).contains(&number) {
                    return None;
                }
                Some(number as u64)
            }
        };
        let tail = match object.get("tail") {
            None => None,
            Some(value) => {
                let tail = value.as_object()?;
                if !only_keys(tail, &["items", "bytes"]) {
                    return None;
                }
                Some(Tail {
                    items: integer(tail, "items", 1.0, 200.0)? as u8,
                    bytes: integer(tail, "bytes", 1_024.0, 1_024.0 * 1_024.0)? as usize,
                })
            }
        };
        Some(Self {
            subscription_id: subscription_id.to_owned(),
            scope,
            paced,
            after_seq,
            tail,
        })
    }

    pub fn thread_id(&self) -> Option<&str> {
        match &self.scope {
            EarlyScope::Thread { thread_id } => Some(thread_id),
            EarlyScope::Threads { .. } => None,
        }
    }

    /// The subscribe carried to the main-socket handler, with the cursor early events ended at
    /// when they were answered (`{type: "subscribe", ...subscribe, afterSeq}`), in the schema's
    /// key order.
    pub fn to_subscribe_message(&self, after_seq: Option<u64>) -> Value {
        let mut message = ace_json::Map::new();
        message.insert("type", Value::String("subscribe".into()));
        message.insert(
            "subscriptionId",
            Value::String(self.subscription_id.clone().into()),
        );
        message.insert("scope", self.scope.to_value());
        if self.paced {
            message.insert("paced", Value::Bool(true));
        }
        if let Some(after_seq) = after_seq.or(self.after_seq) {
            message.insert("afterSeq", ace_json::to_value(&after_seq));
        }
        if let Some(tail) = self.tail {
            let mut value = ace_json::Map::new();
            value.insert("items", ace_json::to_value(&tail.items));
            value.insert("bytes", ace_json::to_value(&tail.bytes));
            message.insert("tail", Value::Object(value));
        }
        Value::Object(message)
    }
}

impl EarlyScope {
    fn to_value(&self) -> Value {
        let mut scope = ace_json::Map::new();
        match self {
            Self::Thread { thread_id } => {
                scope.insert("kind", Value::String("thread".into()));
                scope.insert("threadId", Value::String(thread_id.clone().into()));
            }
            Self::Threads { window } => {
                scope.insert("kind", Value::String("threads".into()));
                let mut value = ace_json::Map::new();
                value.insert("limit", ace_json::to_value(&window.limit));
                if let Some(project) = &window.project {
                    value.insert("project", Value::String(project.clone().into()));
                }
                if let Some(archived) = window.archived {
                    value.insert("archived", Value::Bool(archived));
                }
                scope.insert("window", Value::Object(value));
            }
        }
        Value::Object(scope)
    }
}

fn parse_scope(value: &Value) -> Option<EarlyScope> {
    let object = value.as_object()?;
    match string_at(object, "kind")? {
        "thread" => {
            if !only_keys(object, &["kind", "threadId"]) {
                return None;
            }
            let thread_id = string_at(object, "threadId")?;
            if thread_id.is_empty() {
                return None;
            }
            Some(EarlyScope::Thread {
                thread_id: thread_id.to_owned(),
            })
        }
        "threads" => {
            if !only_keys(object, &["kind", "window"]) {
                return None;
            }
            let window = object.get("window")?.as_object()?;
            if !only_keys(window, &["limit", "project", "archived"]) {
                return None;
            }
            let limit = integer(window, "limit", 1.0, 20.0)? as u8;
            let project = match window.get("project") {
                None => None,
                Some(Value::String(project)) => {
                    if project.as_str().is_empty() {
                        return None;
                    }
                    Some(project.as_str().to_owned())
                }
                Some(_) => return None,
            };
            let archived = match window.get("archived") {
                None => None,
                Some(Value::Bool(archived)) => Some(*archived),
                Some(_) => return None,
            };
            Some(EarlyScope::Threads {
                window: Window {
                    limit,
                    project,
                    archived,
                },
            })
        }
        _ => None,
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
                let link = value.as_object()?;
                if !only_keys(link, &["deviceId", "proof"]) {
                    return None;
                }
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
mod tests {
    //! Ports `packages/protocol/src/relay-handshake.test.ts`: the allowlist, the one-credential
    //! rule, the subscribe bounds and distinct ids, and the confirmation's own fields.

    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::{EarlyScope, HelloConfirm, HelloEarly, RELAY_NK_HANDSHAKE};

    fn json(text: &str) -> ace_json::Value {
        ace_json::parse(text).unwrap()
    }

    fn hello(extra: &str) -> String {
        format!(
            "{{\"type\":\"hello.early\",\"protocolVersion\":1,\"deviceId\":\"device-1\",\
             \"ticket\":\"{}{}\"{extra}}}",
            "a".repeat(60),
            "b".repeat(4)
        )
    }

    #[test]
    fn a_ticket_hello_and_a_grant_hello_parse_and_one_credential_is_required() {
        assert_eq!(RELAY_NK_HANDSHAKE, "nk1");
        assert!(HelloEarly::parse(&json(&hello(""))).is_some());
        let ticket = format!("{}{}", "a".repeat(60), "b".repeat(4));
        let with_grant =
            hello("").replace(&format!("\"ticket\":\"{ticket}\""), "\"grant\":\"grant\"");
        assert!(HelloEarly::parse(&json(&with_grant)).is_some());
        // Both, or neither, is refused.
        let both = hello("").replace("}", ",\"grant\":\"grant\"}");
        assert!(HelloEarly::parse(&json(&both)).is_none());
        let neither = "{\"type\":\"hello.early\",\"protocolVersion\":1,\"deviceId\":\"device-1\"}";
        assert!(HelloEarly::parse(&json(neither)).is_none());
    }

    #[test]
    fn fields_outside_the_allowlist_are_refused() {
        for extra in [
            ",\"token\":\"x\"",
            ",\"machineCode\":\"1234\"",
            ",\"installId\":\"install-0001\"",
            ",\"channel\":\"files\"",
            ",\"nextTicket\":true",
            ",\"mediaTicket\":\"x\"",
            ",\"presence\":\"online\"",
            ",\"commands\":[]",
        ] {
            let text = hello(extra);
            assert!(HelloEarly::parse(&json(&text)).is_none(), "{extra}");
        }
    }

    #[test]
    fn a_protocol_version_other_than_one_or_a_bad_ticket_is_refused() {
        let two = hello("").replace("\"protocolVersion\":1", "\"protocolVersion\":2");
        assert!(HelloEarly::parse(&json(&two)).is_none());
        let short = hello("").replace(&"a".repeat(60), &"a".repeat(59));
        assert!(HelloEarly::parse(&json(&short)).is_none());
        let upper = hello("").replace(&"a".repeat(60), &"A".repeat(60));
        assert!(HelloEarly::parse(&json(&upper)).is_none());
    }

    fn subscribe(id: &str, scope: &str) -> String {
        format!("{{\"subscriptionId\":\"{id}\",\"scope\":{scope}}}")
    }

    #[test]
    fn at_most_four_thread_subscribes_and_two_sidebar_windows_with_distinct_ids() {
        let thread = "{\"kind\":\"thread\",\"threadId\":\"t\"}";
        let window = "{\"kind\":\"threads\",\"window\":{\"limit\":20}}";
        let subs = |items: &[String]| format!(",\"subscribes\":[{}]", items.join(","));
        let ok: Vec<String> = (0..4)
            .map(|n| subscribe(&format!("t{n}"), thread))
            .chain((0..2).map(|n| subscribe(&format!("w{n}"), window)))
            .collect();
        assert!(HelloEarly::parse(&json(&hello(&subs(&ok)))).is_some());
        let five_threads: Vec<String> = (0..5)
            .map(|n| subscribe(&format!("t{n}"), thread))
            .collect();
        assert!(HelloEarly::parse(&json(&hello(&subs(&five_threads)))).is_none());
        let three_windows: Vec<String> = (0..3)
            .map(|n| subscribe(&format!("w{n}"), window))
            .collect();
        assert!(HelloEarly::parse(&json(&hello(&subs(&three_windows)))).is_none());
        let duplicates = vec![subscribe("same", thread), subscribe("same", thread)];
        assert!(HelloEarly::parse(&json(&hello(&subs(&duplicates)))).is_none());
    }

    #[test]
    fn a_scope_is_strict_and_a_window_takes_only_its_limit_project_and_archived() {
        let thread_with_more =
            subscribe("t", "{\"kind\":\"thread\",\"threadId\":\"t\",\"tail\":{}}");
        assert!(
            HelloEarly::parse(&json(&hello(&format!(
                ",\"subscribes\":[{thread_with_more}]"
            ))))
            .is_none()
        );
        let window_with_resume = subscribe(
            "w",
            "{\"kind\":\"threads\",\"window\":{\"limit\":20,\"resume\":\"x\"}}",
        );
        assert!(
            HelloEarly::parse(&json(&hello(&format!(
                ",\"subscribes\":[{window_with_resume}]"
            ))))
            .is_none()
        );
        let ok = subscribe(
            "w",
            "{\"kind\":\"threads\",\"window\":{\"limit\":20,\"project\":\"p\",\"archived\":true}}",
        );
        let parsed = HelloEarly::parse(&json(&hello(&format!(",\"subscribes\":[{ok}]")))).unwrap();
        assert_eq!(
            parsed.subscribes[0].scope,
            EarlyScope::Threads {
                window: super::Window {
                    limit: 20,
                    project: Some("p".to_owned()),
                    archived: Some(true),
                }
            }
        );
        assert_eq!(parsed.early_threads(), Vec::<&str>::new());
    }

    #[test]
    fn a_confirmation_carries_the_device_fields_and_the_allowlist() {
        assert!(HelloConfirm::parse(&json("{\"type\":\"hello.confirm\"}")).is_some());
        let full = "{\"type\":\"hello.confirm\",\"installId\":\"01936d1e-3f8a-7c2b\",\
                    \"link\":{\"deviceId\":\"d\",\"proof\":\"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\"},\
                    \"nextTicket\":true,\"machineCode\":\"1234\"}";
        let confirm = HelloConfirm::parse(&json(full)).unwrap();
        assert_eq!(confirm.install_id.as_deref(), Some("01936d1e-3f8a-7c2b"));
        assert_eq!(confirm.link.unwrap().device_id, "d");
        assert!(confirm.next_ticket);
        assert_eq!(confirm.machine_code.as_deref(), Some("1234"));
        for extra in [
            ",\"token\":\"x\"",
            ",\"ticket\":\"x\"",
            ",\"channel\":\"files\"",
            ",\"grant\":\"g\"",
        ] {
            let text = format!("{{\"type\":\"hello.confirm\"{extra}}}");
            assert!(HelloConfirm::parse(&json(&text)).is_none(), "{extra}");
        }
        // A proof is 43 base64url characters; an install id 8-64 of letters, digits and '-'.
        let short_proof = full.replace(&"A".repeat(43), &"A".repeat(42));
        assert!(HelloConfirm::parse(&json(&short_proof)).is_none());
        let short_install = full.replace("01936d1e-3f8a-7c2b", "short");
        assert!(HelloConfirm::parse(&json(&short_install)).is_none());
    }
}
