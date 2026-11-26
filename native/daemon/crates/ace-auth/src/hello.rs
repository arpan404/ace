// SPDX-License-Identifier: Apache-2.0
//! The hello and the actor it authenticates (`apps/daemon/src/socket-hello.ts`,
//! `wire-core.ts:276`–`:404`), plus the refusals `server.ts` gives its frames. Texts and the
//! `4001` close are contract: a binary first frame, a non-hello frame and a hello that
//! authenticates nothing each send one `unauthorized` error and then close, and a second hello
//! on an authenticated socket is refused without another welcome.

use ace_json::Value;

use crate::devices::{Device, Scope, SessionActor};
use crate::error::AuthError;
use crate::remote_auth::RemoteAuth;

/// The credential fields of a hello, as the schema allows exactly one of them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hello {
    pub device_id: String,
    pub token: Option<String>,
    pub ticket: Option<String>,
    /// An ace account grant (ADR 0111). Its verification is the account backend's; T2 carries it.
    pub grant: Option<String>,
    pub install_id: Option<String>,
    pub channel: Option<String>,
    pub next_ticket: bool,
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

/// A first frame, as the transport saw it.
#[derive(Debug, Clone, Copy)]
pub enum FirstFrame<'a> {
    Text(&'a str),
    Binary,
}

/// The hello exchange's own state: one hello per socket.
#[derive(Debug, Clone, Copy, Default)]
pub struct HelloGate {
    authenticated: bool,
}

impl HelloGate {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn authenticated(&self) -> bool {
        self.authenticated
    }

    /// Parse the first frame. The actor's resolution is separate, so a caller can run the hello
    /// against a live [`RemoteAuth`] and answer with its refusal.
    pub fn first(&mut self, frame: FirstFrame<'_>) -> Result<Hello, HelloRefusal> {
        let text = match frame {
            FirstFrame::Text(text) => text,
            FirstFrame::Binary => return Err(HelloRefusal::Binary),
        };
        let value = ace_json::parse(text).map_err(|_| HelloRefusal::Malformed)?;
        Hello::parse(&value)
    }

    /// A hello after the welcome is refused, without another welcome or heartbeat.
    pub fn later(&mut self) -> HelloRefusal {
        HelloRefusal::Later
    }

    /// The welcome is on the wire: the socket is no longer pre-authentication.
    pub fn welcomed(&mut self) {
        self.authenticated = true;
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
    /// The schema's rules, in `CoreClientMessage`'s order: `hello`, protocol version 1, a device
    /// id, exactly one of token/ticket/grant, `machineCode` and `link` only with a grant, and a
    /// known channel.
    pub fn parse(value: &Value) -> Result<Self, HelloRefusal> {
        let object = value.as_object().ok_or(HelloRefusal::NotHello)?;
        match object.get("type").and_then(Value::as_str) {
            Some("hello") => {}
            _ => return Err(HelloRefusal::NotHello),
        }
        let malformed = HelloRefusal::Malformed;
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
        let count = [token.is_some(), ticket.is_some(), grant.is_some()]
            .into_iter()
            .filter(|present| *present)
            .count();
        if count != 1 {
            return Err(malformed);
        }
        if object.get("machineCode").is_some() && grant.is_none() {
            return Err(malformed);
        }
        if object.get("link").is_some() && grant.is_none() {
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
            install_id,
            channel,
            next_ticket,
        })
    }
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

/// The device a hello authenticates, or `None` when it authenticates nothing (`socket-hello.ts`).
/// The host token counts only on loopback. A ticket or a desktop bearer must name the device the
/// hello claims, and both stay revocable; the host token does not.
///
/// The ticket is spent before the claimed device is checked (behaviour.md §6), so a mismatched
/// hello still spends it. A store failure is a `1011 service_unavailable` at the caller, never a
/// refusal.
pub fn hello_actor(
    hello: &Hello,
    auth: &mut RemoteAuth,
    is_local: bool,
) -> Result<Option<SessionActor>, AuthError> {
    let bearer = match hello.token.as_deref() {
        Some(token) if is_local && !auth.local(token) => auth.device_bearer(token),
        _ => None,
    };
    let desktop = bearer
        .clone()
        .filter(|device| is_local_only_scopes(&device.device.scopes));
    let revocable = hello.ticket.is_some() || desktop.is_some();
    let mut actor = match hello.ticket.as_deref() {
        Some(ticket) => auth.consume(ticket).map(SessionActor::paired),
        None => match hello.token.as_deref() {
            Some(token) if is_local && auth.local(token) => Some(SessionActor::host(host_device(
                &hello.device_id,
                auth.now(),
            ))),
            _ => desktop.map(SessionActor::paired),
        },
    };
    let Some(ref mut authenticated) = actor else {
        return Ok(None);
    };
    authenticated.revocable = revocable;
    if revocable && authenticated.device.id != hello.device_id {
        return Ok(None);
    }
    // A paired device names its app install, so its records fold into one (ADR 0115).
    if hello.ticket.is_some() {
        auth.recognize(&authenticated.device, hello.install_id.as_deref())?;
    }
    Ok(actor)
}

fn is_local_only_scopes(scopes: &[Scope]) -> bool {
    scopes
        .iter()
        .any(|scope| matches!(scope, Scope::Desktop | Scope::UserBrowser))
}

fn host_device(id: &str, now: i64) -> Device {
    Device {
        id: id.to_owned(),
        name: "Host".to_owned(),
        scopes: vec![Scope::Admin, Scope::Projects, Scope::Accounts],
        created_at: 0,
        last_seen_at: now,
        revoked_at: None,
        expires_at: None,
    }
}

#[cfg(test)]
mod tests {
    //! Ports `apps/daemon/src/auth.server.process.test.ts`: the hello refusals a first frame
    //! gets, and the host, ticket and desktop-bearer actor rules it connects with. Those
    //! TypeScript cases drive a real socket; these call the same `helloActor` the socket calls.

    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use std::sync::{Arc, Mutex};

    use super::{FirstFrame, Hello, HelloGate, HelloRefusal, hello_actor};
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
    fn a_non_hello_first_frame_is_refused_without_data() {
        let mut gate = HelloGate::new();
        assert_eq!(
            gate.first(FirstFrame::Text("{\"type\":\"ping\"}")),
            Err(HelloRefusal::NotHello)
        );
        assert_eq!(HelloRefusal::NotHello.code(), "unauthorized");
        assert_eq!(HelloRefusal::NotHello.message(), "Valid hello required");
        assert_eq!(HelloRefusal::NotHello.close_code(), 4001);
        assert_eq!(HelloRefusal::NotHello.close_reason(), "unauthorized");
    }

    #[test]
    fn a_binary_first_frame_is_refused_even_when_it_contains_a_valid_hello() {
        let mut gate = HelloGate::new();
        assert_eq!(gate.first(FirstFrame::Binary), Err(HelloRefusal::Binary));
        assert_eq!(HelloRefusal::Binary.code(), "unauthorized");
        assert_eq!(HelloRefusal::Binary.close_code(), 4001);
    }

    #[test]
    fn an_unsupported_protocol_version_a_missing_or_a_doubled_credential_is_malformed() {
        let mut gate = HelloGate::new();
        let two =
            "{\"type\":\"hello\",\"protocolVersion\":2,\"deviceId\":\"device\",\"token\":\"x\"}";
        assert_eq!(
            gate.first(FirstFrame::Text(two)),
            Err(HelloRefusal::Malformed)
        );
        let none = "{\"type\":\"hello\",\"protocolVersion\":1,\"deviceId\":\"device\"}";
        assert_eq!(
            gate.first(FirstFrame::Text(none)),
            Err(HelloRefusal::Malformed)
        );
        let both = "{\"type\":\"hello\",\"protocolVersion\":1,\"deviceId\":\"device\",\"token\":\"x\",\"ticket\":\"y\"}";
        assert_eq!(
            gate.first(FirstFrame::Text(both)),
            Err(HelloRefusal::Malformed)
        );
        // A malformed frame answers the schema's message, as `server.ts` does.
        assert_eq!(
            HelloRefusal::Malformed.message(),
            "Message does not match the protocol"
        );
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
    fn a_second_hello_is_refused_without_another_welcome() {
        let mut gate = HelloGate::new();
        gate.welcomed();
        assert!(gate.authenticated());
        assert_eq!(gate.later(), HelloRefusal::Later);
        assert_eq!(HelloRefusal::Later.message(), "Hello is only valid once");
        assert_eq!(HelloRefusal::Later.close_code(), 4001);
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
