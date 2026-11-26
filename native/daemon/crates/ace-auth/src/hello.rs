// SPDX-License-Identifier: Apache-2.0
//! The hello and the actor it authenticates (`apps/daemon/src/socket-hello.ts`,
//! `wire-core.ts:276`–`:404`), plus the refusals `server.ts` gives its frames. Texts and the
//! `4001` close are contract: a binary first frame, a non-hello frame and a hello that
//! authenticates nothing each send one `unauthorized` error and then close, and a second hello
//! on an authenticated socket is refused without another welcome.

use ace_json::Value;

pub mod actor;
pub mod gate;

pub use actor::hello_actor;
pub use gate::{FirstFrame, HelloGate};

/// A hello frame, whole (`wire-core.ts:285`-`:390`): every field the schema carries, so the frame
/// can be validated before its credential is classified or spent. Unknown keys are stripped, as
/// `z.object` does.
#[derive(Clone, PartialEq, Eq)]
pub struct Hello {
    pub device_id: String,
    pub token: Option<String>,
    pub ticket: Option<String>,
    /// An ace account grant (ADR 0111). Its verification is the account backend's; T2 carries it.
    pub grant: Option<String>,
    pub machine_code: Option<String>,
    /// With a grant: proof this account device holds a paired credential (ADR 0115).
    pub link: Option<crate::devices::PairingLinkProof>,
    pub install_id: Option<String>,
    pub channel: Option<String>,
    /// With `channel: "media"`: the ticket from the same device's `media.connect`.
    pub media_ticket: Option<String>,
    pub compression: Vec<String>,
    pub flow_control: Vec<String>,
    pub trims: Vec<String>,
    pub framing: Vec<String>,
    pub next_ticket: bool,
}

impl std::fmt::Debug for Hello {
    /// Tokens, tickets, grants, machine codes and link proofs are live credentials: Debug names
    /// that they are present and never prints them.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Hello")
            .field("device_id", &self.device_id)
            .field("token", &self.token.is_some())
            .field("ticket", &self.ticket.is_some())
            .field("grant", &self.grant.is_some())
            .field("machine_code", &self.machine_code.is_some())
            .field("link", &self.link.is_some())
            .field("install_id", &self.install_id.is_some())
            .field("channel", &self.channel)
            .field("media_ticket", &self.media_ticket.is_some())
            .field("next_ticket", &self.next_ticket)
            .finish_non_exhaustive()
    }
}

/// Why a first frame isn't a hello this daemon accepts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HelloRefusal {
    /// The frame is not a JSON hello (`server.ts:866`, `:1018`).
    NotHello,
    /// The frame isn't JSON, or doesn't match the schema (`server.ts:857`).
    Malformed,
    /// A binary first frame, even one holding a valid hello (`server.ts:836`).
    Binary,
    /// A valid hello that authenticates nothing (`server.ts:895`).
    Unauthorized,
    /// A hello after the welcome (`server.ts:1019`).
    Later,
}

impl HelloRefusal {
    /// The error frame's `code`.
    pub fn code(self) -> &'static str {
        "unauthorized"
    }

    /// The error frame's `message`, byte for byte as `server.ts` sends it.
    pub fn message(self) -> &'static str {
        match self {
            Self::NotHello | Self::Unauthorized => "Valid hello required",
            Self::Malformed => "Message does not match the protocol",
            Self::Binary => "Message does not match the protocol",
            Self::Later => "Hello is only valid once",
        }
    }

    /// Every refusal closes the socket with `4001`, reason `unauthorized`
    /// (`close.rs`'s `HELLO_REFUSED_*`).
    pub fn close_code(self) -> u16 {
        crate::close::HELLO_REFUSED_CLOSE
    }

    pub fn close_reason(self) -> &'static str {
        crate::close::HELLO_REFUSED_REASON
    }
}

const CHANNELS: [&str; 8] = [
    "files",
    "devices",
    "browser",
    "screen",
    "provider_auth",
    "media",
    "machine",
    "tunnel",
];

impl Hello {
    /// The hello schema, whole, before anything classifies the frame or spends its credential
    /// (`wire-core.ts:285`-`:390`, `server.ts:855`-`:866`): the type, protocol version 1, a device
    /// id, every optional field at its own bound, exactly one of token/ticket/grant, `machineCode`
    /// and `link` only with a grant, and a known channel.
    pub fn parse(value: &Value) -> Result<Self, HelloRefusal> {
        // A frame that parses as JSON but isn't an object fails the schema, as it does through
        // `parseSocketMessage`; only a socket message of another type is "Valid hello required".
        let object = value.as_object().ok_or(HelloRefusal::Malformed)?;
        let malformed = HelloRefusal::Malformed;
        match object.get("type") {
            Some(Value::String(kind)) if kind.as_str() == "hello" => {}
            Some(Value::String(_)) => return Err(HelloRefusal::NotHello),
            _ => return Err(malformed),
        }
        if object.get("protocolVersion").and_then(Value::as_u64) != Some(1) {
            return Err(malformed);
        }
        let device_id = object
            .get("deviceId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .ok_or(malformed)?
            .to_owned();
        let credential = |key: &str| -> Result<Option<String>, HelloRefusal> {
            match object.get(key) {
                None => Ok(None),
                Some(Value::String(text)) => Ok(Some(text.as_str().to_owned())),
                Some(_) => Err(malformed),
            }
        };
        let token = credential("token")?;
        let ticket = credential("ticket")?;
        let grant = credential("grant")?;
        // A grant is `z.string().min(1).max(2048)` in code points (wire-core.ts:301).
        if let Some(grant) = &grant
            && !(1..=2_048).contains(&grant.chars().count())
        {
            return Err(malformed);
        }
        let count = [token.is_some(), ticket.is_some(), grant.is_some()]
            .into_iter()
            .filter(|present| *present)
            .count();
        if count != 1 {
            return Err(malformed);
        }
        let machine_code = match object.get("machineCode") {
            None => None,
            // `MachineCode`: 4 to 128 characters.
            Some(Value::String(text)) if (4..=128).contains(&text.as_str().chars().count()) => {
                Some(text.as_str().to_owned())
            }
            Some(_) => return Err(malformed),
        };
        let link = match object.get("link") {
            None => None,
            Some(value) => match parse_link(value) {
                Some(link) => Some(link),
                None => return Err(malformed),
            },
        };
        if machine_code.is_some() && grant.is_none() {
            return Err(malformed);
        }
        if link.is_some() && grant.is_none() {
            return Err(malformed);
        }
        let install_id = match object.get("installId") {
            None => None,
            Some(Value::String(text)) => {
                let id = text.as_str();
                if !is_install_id(id) {
                    return Err(malformed);
                }
                Some(id.to_owned())
            }
            Some(_) => return Err(malformed),
        };
        let channel = match object.get("channel") {
            None => None,
            Some(Value::String(text)) => {
                let name = text.as_str();
                if !CHANNELS.contains(&name) {
                    return Err(malformed);
                }
                Some(name.to_owned())
            }
            Some(_) => return Err(malformed),
        };
        let media_ticket = match object.get("mediaTicket") {
            None => None,
            Some(Value::String(text)) if is_base64url(text.as_str(), 43) => {
                Some(text.as_str().to_owned())
            }
            Some(_) => return Err(malformed),
        };
        let next_ticket = match object.get("nextTicket") {
            None => false,
            Some(Value::Bool(true)) => true,
            Some(_) => return Err(malformed),
        };
        Ok(Self {
            device_id,
            token,
            ticket,
            grant,
            machine_code,
            link,
            install_id,
            channel,
            media_ticket,
            compression: names(object, "compression", 8)?,
            flow_control: names(object, "flowControl", 8)?,
            trims: names(object, "trims", 16)?,
            framing: names(object, "framing", 8)?,
            next_ticket,
        })
    }
}

/// `z.array(z.string().max(32)).max(max)`, absent as empty.
fn names(object: &ace_json::Map, key: &str, max: usize) -> Result<Vec<String>, HelloRefusal> {
    match object.get(key) {
        None => Ok(Vec::new()),
        Some(Value::Array(items)) => {
            if items.len() > max {
                return Err(HelloRefusal::Malformed);
            }
            let mut names = Vec::with_capacity(items.len());
            for item in items {
                let Some(name) = item.as_str() else {
                    return Err(HelloRefusal::Malformed);
                };
                if name.chars().count() > 32 {
                    return Err(HelloRefusal::Malformed);
                }
                names.push(name.to_owned());
            }
            Ok(names)
        }
        Some(_) => Err(HelloRefusal::Malformed),
    }
}

/// A `PairingLinkProof`: `{deviceId: min 1, proof: 43 base64url}`, extra keys stripped.
fn parse_link(value: &Value) -> Option<crate::devices::PairingLinkProof> {
    let object = value.as_object()?;
    let device_id = object
        .get("deviceId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())?;
    let proof = object.get("proof").and_then(Value::as_str)?;
    if !is_base64url(proof, 43) {
        return None;
    }
    Some(crate::devices::PairingLinkProof {
        device_id: device_id.to_owned(),
        proof: proof.to_owned(),
    })
}

fn is_base64url(text: &str, length: usize) -> bool {
    text.len() == length
        && text
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

/// `InstallId`: `/^[A-Za-z0-9-]{8,64}$/`, counted in UTF-16 code units as TypeScript's regex is
/// (only ASCII can match, so bytes and code units agree).
fn is_install_id(id: &str) -> bool {
    let length = id.len();
    (8..=64).contains(&length)
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

#[cfg(test)]
mod tests {
    //! Ports `apps/daemon/src/auth.server.process.test.ts`: the hello refusals a first frame
    //! gets, and the host, ticket and desktop-bearer actor rules it connects with. Those
    //! TypeScript cases drive a real socket; these call the same `helloActor` the socket calls.

    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use std::sync::{Arc, Mutex};

    use super::{Hello, HelloRefusal, hello_actor};
    use crate::devices::{Devices, PairedDevice, Scope};
    use crate::pairing::PairingTerms;
    use crate::remote_auth::RemoteAuth;
    use crate::{CredentialRuntime, Runtime};

    /// A clock a test moves, secrets that never repeat, and ids that number themselves.
    fn runtime(clock: Arc<Mutex<i64>>) -> Runtime {
        let secrets = Arc::new(Mutex::new(0_u64));
        let ids = Arc::new(Mutex::new(0_u64));
        Runtime::new(
            move || *clock.lock().unwrap(),
            move || {
                let mut secret = secrets.lock().unwrap();
                *secret += 1;
                format!("{secret:064}")
            },
            move || {
                let mut id = ids.lock().unwrap();
                *id += 1;
                format!("pairing-{id}")
            },
        )
    }

    fn devices(directory: &tempfile::TempDir) -> Devices {
        let counter = Arc::new(Mutex::new(0_u64));
        let entropy = Arc::new(Mutex::new(0_u64));
        let runtime = CredentialRuntime::new(
            move || {
                let mut id = counter.lock().unwrap();
                *id += 1;
                format!("device-{id}")
            },
            move |size| {
                let mut seed = entropy.lock().unwrap();
                *seed += 1;
                let mut bytes = vec![7_u8; size];
                let width = size.min(8);
                bytes[..width].copy_from_slice(&seed.to_be_bytes()[8 - width..]);
                bytes
            },
        );
        let path = directory.path().join("events.sqlite");
        Devices::open(path.to_str().unwrap(), runtime).unwrap()
    }

    fn paired_auth(clock: i64) -> (RemoteAuth, PairedDevice, tempfile::TempDir) {
        let directory = tempfile::tempdir().unwrap();
        let devices = devices(&directory);
        let mut auth = RemoteAuth::with_memory(
            devices,
            "aa".repeat(32),
            runtime(Arc::new(Mutex::new(clock))),
        );
        let ticket = auth
            .pairing(&[Scope::Read], &PairingTerms::default())
            .unwrap();
        let redeemed = auth.redeem(&ticket.code, "Phone", None, None).unwrap();
        let paired = auth.device_bearer(&redeemed.token).unwrap();
        (auth, paired, directory)
    }

    #[test]
    fn the_whole_frame_is_validated_before_any_credential_is_classified() {
        // `{}` fails the schema: it is malformed, not "Valid hello required".
        assert_eq!(
            Hello::parse(&ace_json::parse("{}").unwrap()),
            Err(HelloRefusal::Malformed)
        );
        // A socket message of another type is the other case.
        assert_eq!(
            Hello::parse(&ace_json::parse("{\"type\":\"ping\"}").unwrap()),
            Err(HelloRefusal::NotHello)
        );
        // A well-formed ticket hello with an invalid field is malformed, and the ticket is never
        // seen: a frame with a live ticket and `compression: true` parses to nothing.
        let (mut auth, paired, _home) = paired_auth(1_000);
        let ticket = auth.ticket(&paired, "").unwrap().ticket;
        let frame = format!(
            "{{\"type\":\"hello\",\"protocolVersion\":1,\"deviceId\":\"{}\",\
             \"ticket\":\"{ticket}\",\"compression\":true}}",
            paired.device.id
        );
        assert_eq!(
            Hello::parse(&ace_json::parse(&frame).unwrap()),
            Err(HelloRefusal::Malformed)
        );
        // The ticket is still spendable: nothing classified it.
        let hello = Hello::parse(
            &ace_json::parse(&format!(
                "{{\"type\":\"hello\",\"protocolVersion\":1,\"deviceId\":\"{}\",\
                 \"ticket\":\"{ticket}\"}}",
                paired.device.id
            ))
            .unwrap(),
        )
        .unwrap();
        assert!(hello_actor(&hello, &mut auth, false).unwrap().is_some());
    }

    #[test]
    fn every_optional_field_holds_its_own_bound() {
        let hello = |extra: &str| {
            ace_json::parse(&format!(
                "{{\"type\":\"hello\",\"protocolVersion\":1,\"deviceId\":\"device\",\
                 \"token\":\"x\"{extra}}}"
            ))
            .unwrap()
        };
        // mediaTicket: 43 base64url characters.
        assert!(
            Hello::parse(&hello(
                ",\"mediaTicket\":\"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\""
            ))
            .is_ok()
        );
        assert_eq!(
            Hello::parse(&hello(",\"mediaTicket\":\"short\"")),
            Err(HelloRefusal::Malformed)
        );
        // trims up to 16 names of 32 characters, framing/compression/flowControl up to 8.
        let names = |n: usize| format!("[{}]", vec!["\"x\""; n].join(","));
        assert!(Hello::parse(&hello(&format!(",\"trims\":{}", names(16)))).is_ok());
        assert_eq!(
            Hello::parse(&hello(&format!(",\"trims\":{}", names(17)))),
            Err(HelloRefusal::Malformed)
        );
        let long = "y".repeat(33);
        assert_eq!(
            Hello::parse(&hello(&format!(",\"framing\":[\"{long}\"]"))),
            Err(HelloRefusal::Malformed)
        );
        // machineCode only with a grant, and 4 to 128 characters.
        assert_eq!(
            Hello::parse(&hello(",\"machineCode\":\"1234\"")),
            Err(HelloRefusal::Malformed)
        );
        let grant = |extra: &str| {
            ace_json::parse(&format!(
                "{{\"type\":\"hello\",\"protocolVersion\":1,\"deviceId\":\"device\",\
                 \"grant\":\"g\"{extra}}}"
            ))
            .unwrap()
        };
        assert!(Hello::parse(&grant(",\"machineCode\":\"1234\"")).is_ok());
        assert_eq!(
            Hello::parse(&grant(",\"machineCode\":\"123\"")),
            Err(HelloRefusal::Malformed)
        );
        // A link proof is 43 base64url characters and needs a grant.
        let proof = "A".repeat(43);
        assert!(
            Hello::parse(&grant(&format!(
                ",\"link\":{{\"deviceId\":\"d\",\"proof\":\"{proof}\"}}"
            )))
            .is_ok()
        );
        assert_eq!(
            Hello::parse(&hello(&format!(
                ",\"link\":{{\"deviceId\":\"d\",\"proof\":\"{proof}\"}}"
            ))),
            Err(HelloRefusal::Malformed)
        );
    }

    #[test]
    fn debug_names_credentials_by_presence_never_by_value() {
        let hello = Hello::parse(
            &ace_json::parse(
                "{\"type\":\"hello\",\"protocolVersion\":1,\"deviceId\":\"device\",\
                 \"grant\":\"sensitive-grant\",\"machineCode\":\"1234\",\
                 \"link\":{\"deviceId\":\"d\",\"proof\":\"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\"}}",
            )
            .unwrap(),
        )
        .unwrap();
        let printed = format!("{hello:?}");
        for secret in [
            "sensitive-grant",
            "1234",
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        ] {
            assert!(!printed.contains(secret), "{printed}");
        }
        assert!(printed.contains("grant: true"), "{printed}");
    }

    #[test]
    fn a_grant_is_between_one_and_2048_code_points_or_the_hello_is_malformed() {
        let hello = |grant: &str| {
            ace_json::parse(&format!(
                "{{\"type\":\"hello\",\"protocolVersion\":1,\"deviceId\":\"device\",\
                 \"grant\":\"{grant}\"}}"
            ))
            .unwrap()
        };
        let parse = |value: &ace_json::Value| Hello::parse(value);
        assert!(parse(&hello("g".repeat(2_048).as_str())).is_ok());
        assert_eq!(parse(&hello("")), Err(HelloRefusal::Malformed));
        assert_eq!(
            parse(&hello("g".repeat(2_049).as_str())),
            Err(HelloRefusal::Malformed)
        );
        // The bound counts code points, so 2048 emoji pass (rule 17).
        assert!(parse(&hello("😀".repeat(2_048).as_str())).is_ok());
    }

    #[test]
    fn a_host_token_is_the_host_on_loopback_and_a_prefix_authenticates_nothing() {
        let directory = tempfile::tempdir().unwrap();
        let token = "cc".repeat(32);
        let mut auth = RemoteAuth::with_memory(
            devices(&directory),
            token.clone(),
            runtime(Arc::new(Mutex::new(7))),
        );
        let hello = Hello {
            device_id: "device".to_owned(),
            token: Some(token.clone()),
            ticket: None,
            grant: None,
            install_id: None,
            channel: None,
            next_ticket: false,
            machine_code: None,
            link: None,
            media_ticket: None,
            compression: Vec::new(),
            flow_control: Vec::new(),
            trims: Vec::new(),
            framing: Vec::new(),
        };
        let actor = hello_actor(&hello, &mut auth, true)
            .unwrap()
            .expect("the host credential");
        assert_eq!(actor.device.id, "device");
        assert!(!actor.revocable);
        assert_eq!(
            actor.device.scopes,
            vec![Scope::Admin, Scope::Projects, Scope::Accounts]
        );
        assert_eq!(actor.device.last_seen_at, 7);
        // `token + "suffix"` is not the token.
        let prefixed = Hello {
            token: Some(format!("{token}suffix")),
            ..hello.clone()
        };
        assert!(hello_actor(&prefixed, &mut auth, true).unwrap().is_none());
        // The host token counts only on loopback.
        assert!(hello_actor(&hello, &mut auth, false).unwrap().is_none());
    }

    #[test]
    fn a_ticket_must_name_the_device_it_was_issued_to_and_is_spent_anyway() {
        let (mut auth, paired, _home) = paired_auth(1_000);
        let ticket = auth.ticket(&paired, "").unwrap().ticket;
        let wrong = Hello {
            device_id: "another-device".to_owned(),
            token: None,
            ticket: Some(ticket),
            grant: None,
            install_id: None,
            channel: None,
            next_ticket: false,
            machine_code: None,
            link: None,
            media_ticket: None,
            compression: Vec::new(),
            flow_control: Vec::new(),
            trims: Vec::new(),
            framing: Vec::new(),
        };
        assert!(hello_actor(&wrong, &mut auth, false).unwrap().is_none());
        // Spent first: the same ticket no longer opens the right device.
        let right = Hello {
            device_id: paired.device.id.clone(),
            ..wrong
        };
        assert!(hello_actor(&right, &mut auth, false).unwrap().is_none());
    }

    #[test]
    fn a_ticket_opens_its_paired_device_and_is_revocable() {
        let (mut auth, paired, _home) = paired_auth(1_000);
        let ticket = auth.ticket(&paired, "").unwrap().ticket;
        let hello = Hello {
            device_id: paired.device.id.clone(),
            token: None,
            ticket: Some(ticket),
            grant: None,
            install_id: None,
            channel: None,
            next_ticket: false,
            machine_code: None,
            link: None,
            media_ticket: None,
            compression: Vec::new(),
            flow_control: Vec::new(),
            trims: Vec::new(),
            framing: Vec::new(),
        };
        let authenticated = hello_actor(&hello, &mut auth, false)
            .unwrap()
            .expect("a valid ticket");
        assert!(authenticated.revocable);
        assert_eq!(authenticated.device.id, paired.device.id);
        assert_eq!(authenticated.generation, Some(paired.generation));
        assert_eq!(authenticated.person, Some(false));
    }

    #[test]
    fn a_desktop_bearer_names_its_own_device_and_cannot_be_ticketed() {
        let directory = tempfile::tempdir().unwrap();
        let devices = devices(&directory);
        let (desktop, token) = devices
            .create("Desktop", &[Scope::Desktop], 1_000, None, None, false, None)
            .unwrap();
        let mut auth = RemoteAuth::with_memory(
            devices,
            "dd".repeat(32),
            runtime(Arc::new(Mutex::new(1_000))),
        );
        let hello = Hello {
            device_id: desktop.id.clone(),
            token: Some(token),
            ticket: None,
            grant: None,
            install_id: None,
            channel: None,
            next_ticket: false,
            machine_code: None,
            link: None,
            media_ticket: None,
            compression: Vec::new(),
            flow_control: Vec::new(),
            trims: Vec::new(),
            framing: Vec::new(),
        };
        let actor = hello_actor(&hello, &mut auth, true)
            .unwrap()
            .expect("the desktop bearer");
        assert!(actor.revocable);
        assert_eq!(actor.device.id, desktop.id);
        // Another device id makes the local credential authenticate nothing.
        let wrong = Hello {
            device_id: "another-device".to_owned(),
            ..hello
        };
        assert!(hello_actor(&wrong, &mut auth, true).unwrap().is_none());
        // A desktop device never gets a ticket: 403, "Desktop credentials are local only".
        let paired = auth
            .devices()
            .authenticate(&wrong.token.clone().unwrap(), 1_000)
            .unwrap()
            .unwrap();
        let error = auth.ticket(&paired, "").unwrap_err();
        assert_eq!(error.status(), 403);
        assert_eq!(error.message(), "Desktop credentials are local only");
    }
}
