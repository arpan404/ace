// SPDX-License-Identifier: Apache-2.0
//! The actor a hello authenticates (`socket-hello.ts`): the host token on loopback, a ticket or a
//! desktop bearer naming its own device, and the install a ticket recognises (ADR 0115).

use crate::devices::{Device, Scope, SessionActor};
use crate::error::AuthError;
use crate::remote_auth::RemoteAuth;

use super::Hello;

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
    //! Ports `apps/daemon/src/auth.server.process.test.ts`'s hello actor cases: the host token on
    //! loopback and its prefix, a ticket naming its device (and spent first), and the desktop
    //! bearer that cannot be ticketed.

    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use std::sync::{Arc, Mutex};

    use super::hello_actor;
    use crate::devices::{Devices, PairedDevice, Scope};
    use crate::hello::Hello;
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
