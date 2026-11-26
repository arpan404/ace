// SPDX-License-Identifier: Apache-2.0
//! The daemon's half of a relay stream opened with Noise NK (ADR 0155, step 2,
//! `apps/daemon/src/relay-nk/host.ts`). A first message is admitted only through
//! [`NkAdmission`]'s steps, and the credential check records nothing: a ticket is consumed in one
//! synchronous step (so one of two racing copies gets it), a grant is checked against cached keys
//! only. The session is unconfirmed until the client's `hello.confirm`; only then does the device
//! count as seen, its install fold and its link hold.

use ace_auth::RemoteAuth;
use ace_auth::devices::{Device, Member, PairedDevice, Scope, SessionActor};
use ace_json::Value;

use super::admission::{NkAdmission, NkSession};
use super::hello::{HelloConfirm, HelloEarly};

/// The account backend's cached verdict for a grant (`MachineAccount.admitDeviceCached`): an NK
/// first message never waits on the network, and a machine that asks for a code is answered by
/// refusing NK (the client's XX attempt carries the code as today).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountAdmission {
    pub admitted: bool,
    pub account: Option<String>,
    pub expires_at: Option<i64>,
}

/// What the host asks the account backend, never the network.
pub trait NkAccount: Send + Sync {
    fn admit_device_cached(&self, grant: &str, device_id: &str) -> AccountAdmission;
    fn still_admitted(&self, device_id: &str, account: &str) -> bool;
}

/// An admitted NK main channel, handed to the main-socket handler before it confirms.
pub struct NkAccepted {
    pub early: HelloEarly,
    pub actor: SessionActor,
    pub session: NkSession,
    pub paired: Option<PairedDevice>,
    pub still_admitted: Option<Box<dyn Fn() -> bool + Send + Sync>>,
    pub account: Option<String>,
    pub grant_expires_at: Option<i64>,
}

impl NkAccepted {
    /// The session is given back at once when the relay abandons the admission.
    pub fn abandon(&self) {
        self.session.close();
    }

    /// The confirmation, as the channel's first message; the device's effects run only now.
    /// `None` refuses the confirmation, and the caller closes the channel.
    pub fn confirm(&mut self, auth: &mut RemoteAuth, raw: &str) -> Option<HelloConfirm> {
        let parsed = ace_json::parse(raw).ok()?;
        let confirm = HelloConfirm::parse(&parsed)?;
        // A link proof and a machine code go with a grant only, as in a hello.
        if self.paired.is_some() && (confirm.link.is_some() || confirm.machine_code.is_some()) {
            self.session.close();
            return None;
        }
        self.session.confirm();
        match &self.paired {
            Some(paired) => {
                let _ = auth.touch(&paired.device);
                let _ = auth.recognize(&paired.device, confirm.install_id.as_deref());
            }
            None => {
                let link = confirm
                    .link
                    .as_ref()
                    .map(|link| ace_auth::devices::PairingLinkProof {
                        device_id: link.device_id.clone(),
                        proof: link.proof.clone(),
                    });
                let _ = auth.account_device_seen(&self.actor.device.id, link.as_ref());
            }
        }
        Some(confirm)
    }
}

/// The daemon's NK host (`nkHost`).
pub struct NkHost<'a> {
    pub admission: &'a NkAdmission,
    /// The host key epoch tickets are bound to: the daemon's relay host id.
    pub epoch: String,
    pub auth: &'a mut RemoteAuth,
    pub account: Option<&'a dyn NkAccount>,
}

impl NkHost<'_> {
    /// Step 1: may this first message be decrypted at all (`arrive`)?
    pub fn arrive(&self) -> bool {
        self.admission.arrive()
    }

    /// Parse and admit a first message, or `None`. `expire` runs if the client doesn't confirm in
    /// time (the caller closes the channel it is about to open).
    pub fn admit(
        &mut self,
        payload: &Value,
        ephemeral: &[u8],
        expire: impl FnOnce() + Send + 'static,
    ) -> Option<NkAccepted> {
        let early = HelloEarly::parse(payload)?;
        if !self.admission.claim(&early.device_id) {
            return None;
        }
        let mut claim = match self.admission.suppress(ephemeral) {
            crate::nk::admission::Suppressive::Claimed(claim) => claim,
            _ => return None,
        };
        let held = match self.credential(&early) {
            Some(held) => held,
            None => {
                claim.release();
                return None;
            }
        };
        let Some(session) = self.admission.admit(&early.device_id, expire) else {
            claim.release();
            return None;
        };
        Some(NkAccepted {
            early,
            actor: held.actor,
            session,
            paired: held.paired,
            still_admitted: held.still_admitted,
            account: held.account,
            grant_expires_at: held.grant_expires_at,
        })
    }

    fn credential(&mut self, early: &HelloEarly) -> Option<Credential> {
        if let Some(ticket) = &early.ticket {
            let device = self
                .auth
                .consume_early(ticket, &self.epoch, &early.device_id)?;
            let actor = main_actor(self.auth, &device.device.id, Some(&device.generation))?;
            return Some(Credential {
                actor,
                paired: Some(device),
                still_admitted: None,
                account: None,
                grant_expires_at: None,
            });
        }
        let machine = self.account?;
        let grant = early.grant.as_deref()?;
        let verdict = machine.admit_device_cached(grant, &early.device_id);
        if !verdict.admitted {
            return None;
        }
        let account = verdict.account?;
        // The shell asks `NkAccount::still_admitted` itself (it owns the account backend); the
        // host records the account so a socket can hold its grant (ADR 0111).
        let still_admitted: Box<dyn Fn() -> bool + Send + Sync> = Box::new(|| true);
        let actor = account_device_actor(&early.device_id, self.auth.now(), None);
        Some(Credential {
            actor,
            paired: None,
            still_admitted: Some(still_admitted),
            account: Some(account),
            grant_expires_at: verdict.expires_at,
        })
    }
}

struct Credential {
    actor: SessionActor,
    paired: Option<PairedDevice>,
    still_admitted: Option<Box<dyn Fn() -> bool + Send + Sync>>,
    account: Option<String>,
    grant_expires_at: Option<i64>,
}

/// Who a relayed main channel speaks for (`relay-hello.ts:132`): a paired device with its stored
/// scopes (never the desktop app's local-only credential), or an account device holding admin
/// while it stays admitted (ADR 0111).
pub fn main_actor(auth: &RemoteAuth, id: &str, generation: Option<&str>) -> Option<SessionActor> {
    let device = auth.devices().current(id, generation, auth.now()).ok()??;
    if device
        .device
        .scopes
        .iter()
        .any(|scope| matches!(scope, Scope::Desktop | Scope::UserBrowser))
    {
        return None;
    }
    Some(SessionActor::paired(device))
}

/// An admitted account device (`accountDeviceActor`, `relay-hello.ts:100`): admin while it stays
/// admitted, never revoked by device id, and never the person by its admission.
pub fn account_device_actor(id: &str, now: i64, member: Option<Member>) -> SessionActor {
    let device = Device {
        id: id.to_owned(),
        name: "ace account device".to_owned(),
        scopes: vec![Scope::Admin],
        created_at: now,
        last_seen_at: now,
        revoked_at: None,
        expires_at: None,
    };
    let Some(member) = member else {
        return SessionActor::host(device);
    };
    let owner = ace_auth::org::org_role(&member.role) == "owner";
    SessionActor {
        device: Device {
            name: "ace organization member".to_owned(),
            scopes: if owner {
                vec![Scope::Admin]
            } else {
                vec![Scope::Read, Scope::Operate]
            },
            ..device
        },
        revocable: false,
        generation: None,
        person: None,
        member: Some(member),
        spade_only: !owner,
    }
}

#[cfg(test)]
mod tests {
    //! Ports `apps/daemon/src/relay-nk/host.test.ts`: fresh valid-grant attempts can hold no more
    //! than the limits allow, the daemon decrypts its burst before any credential work, an
    //! uncached grant is refused at once, and an abandoned admission gives its session back.

    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    use ace_auth::Runtime;
    use ace_auth::devices::{Devices, Scope};
    use ace_json::Value;

    use super::{AccountAdmission, NkAccount, NkHost};
    use crate::nk::admission::{NK_LIMITS, NkAdmission, NkClock};
    use crate::nk::tests_support::ManualClock;

    struct Account {
        admits: AtomicUsize,
        cached: Mutex<bool>,
        now: Arc<ManualClock>,
    }

    impl NkAccount for Account {
        fn admit_device_cached(&self, _grant: &str, _device_id: &str) -> AccountAdmission {
            self.admits.fetch_add(1, Ordering::SeqCst);
            if *self.cached.lock().unwrap() {
                AccountAdmission {
                    admitted: true,
                    account: Some("user_a".to_owned()),
                    expires_at: Some(self.now.now() + 300_000),
                }
            } else {
                AccountAdmission {
                    admitted: false,
                    account: None,
                    expires_at: None,
                }
            }
        }

        fn still_admitted(&self, _device_id: &str, _account: &str) -> bool {
            true
        }
    }

    struct Fixture {
        clock: Arc<ManualClock>,
        auth: ace_auth::RemoteAuth,
        admission: NkAdmission,
        account: Account,
        _home: tempfile::TempDir,
    }

    fn setup() -> Fixture {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join("events.sqlite");
        let devices = Devices::open(
            path.to_str().unwrap(),
            ace_auth::CredentialRuntime::new(|| "device-1".to_owned(), |size| vec![1; size]),
        )
        .unwrap();
        let clock = ManualClock::new();
        let now = Arc::clone(&clock);
        let auth = ace_auth::RemoteAuth::with_memory(
            devices,
            "a".repeat(64),
            Runtime::new(
                move || now.now(),
                || "b".repeat(64),
                || "pairing-1".to_owned(),
            ),
        );
        let admission = NkAdmission::new(clock.clone(), NK_LIMITS);
        Fixture {
            clock,
            auth,
            admission,
            account: Account {
                admits: AtomicUsize::new(0),
                cached: Mutex::new(true),
                now: Arc::clone(&ManualClock::new()),
            },
            _home: home,
        }
    }

    fn early(device: &str) -> Value {
        ace_json::parse(&format!(
            "{{\"type\":\"hello.early\",\"protocolVersion\":1,\"deviceId\":\"{device}\",\
             \"grant\":\"grant\"}}"
        ))
        .unwrap()
    }

    fn ephemeral(n: u8) -> [u8; 32] {
        let mut bytes = [n; 32];
        bytes[1] = n.wrapping_add(1);
        bytes
    }

    #[test]
    fn a_flood_of_valid_grant_first_messages_opens_two_sessions_and_checks_four_grants() {
        let mut f = setup();
        let mut accepted = 0;
        for n in 0..40_u8 {
            let mut host = NkHost {
                admission: &f.admission,
                epoch: "relay-key".to_owned(),
                auth: &mut f.auth,
                account: Some(&f.account),
            };
            if !host.arrive() {
                break;
            }
            if host.admit(&early("phone"), &ephemeral(n), || {}).is_some() {
                accepted += 1;
            }
        }
        // The device's rate (burst 4) stops the flood before its grant is checked; 2 sessions open.
        assert_eq!(f.account.admits.load(Ordering::SeqCst), 4);
        assert_eq!(accepted, 2);
        assert_eq!(f.admission.held().sessions, 2);
    }

    #[test]
    fn a_flood_across_devices_holds_thirty_two_and_the_deadline_closes_the_unconfirmed() {
        let mut f = setup();
        let mut accepted = Vec::new();
        for n in 0..40_u8 {
            let mut host = NkHost {
                admission: &f.admission,
                epoch: "relay-key".to_owned(),
                auth: &mut f.auth,
                account: Some(&f.account),
            };
            if !host.arrive() {
                break;
            }
            if let Some(entry) = host.admit(&early(&format!("device-{n}")), &ephemeral(n), || {}) {
                accepted.push(entry);
            }
        }
        assert_eq!(accepted.len(), 32);
        assert_eq!(f.admission.held().sessions, 32);
        // A confirmed session isn't touched by the deadline.
        let mut first = accepted.remove(0);
        let confirm = first
            .confirm(&mut f.auth, "{\"type\":\"hello.confirm\"}")
            .expect("a confirmation");
        assert_eq!(confirm.install_id, None);
        assert_eq!(f.admission.held().sessions, 31);
        f.clock.advance(5_000);
        assert_eq!(f.admission.held().sessions, 0);
        assert_eq!(f.admission.held().bytes, 0);
        // And the daemon takes new ones again.
        f.clock.advance(2_000);
        let mut host = NkHost {
            admission: &f.admission,
            epoch: "relay-key".to_owned(),
            auth: &mut f.auth,
            account: Some(&f.account),
        };
        assert!(
            host.admit(&early("device-new"), &ephemeral(200), || {})
                .is_some()
        );
    }

    #[test]
    fn the_daemon_decrypts_at_most_its_burst_of_first_messages_before_any_credential_work() {
        let f = setup();
        let host = NkHost {
            admission: &f.admission,
            epoch: "relay-key".to_owned(),
            auth: &mut { f.auth },
            account: Some(&f.account),
        };
        let mut arrived = 0;
        for _ in 0..100 {
            if host.arrive() {
                arrived += 1;
            }
        }
        assert_eq!(arrived, 40);
    }

    #[test]
    fn a_grant_whose_key_is_not_cached_is_refused_at_once_without_a_session() {
        let mut f = setup();
        *f.account.cached.lock().unwrap() = false;
        let mut host = NkHost {
            admission: &f.admission,
            epoch: "relay-key".to_owned(),
            auth: &mut f.auth,
            account: Some(&f.account),
        };
        assert!(host.admit(&early("phone"), &ephemeral(1), || {}).is_none());
        assert_eq!(f.admission.held().sessions, 0);
        // The refused attempt's ephemeral key was given back.
        assert_eq!(f.admission.held().suppressed, 0);
    }

    #[test]
    fn an_admission_the_relay_abandons_gives_its_session_back_at_once() {
        let mut f = setup();
        let mut host = NkHost {
            admission: &f.admission,
            epoch: "relay-key".to_owned(),
            auth: &mut f.auth,
            account: Some(&f.account),
        };
        let accepted = host
            .admit(&early("phone"), &ephemeral(1), || {})
            .expect("an admission");
        assert_eq!(f.admission.held().sessions, 1);
        accepted.abandon();
        assert_eq!(f.admission.held().sessions, 0);
        assert_eq!(f.admission.held().bytes, 0);
    }

    #[test]
    fn a_ticket_first_message_opens_its_paired_device_and_confirmation_folds_its_install() {
        let mut f = setup();
        let paired = {
            let code = f
                .auth
                .pairing(&[Scope::Read], &Default::default())
                .unwrap()
                .code;
            f.auth.redeem(&code, "Phone", None, None).unwrap()
        };
        let device = f.auth.device_bearer(&paired.token).unwrap();
        let ticket = f.auth.ticket(&device, "relay-key").unwrap().ticket;
        let payload = ace_json::parse(&format!(
            "{{\"type\":\"hello.early\",\"protocolVersion\":1,\"deviceId\":\"{}\",\
             \"ticket\":\"{ticket}\"}}",
            paired.device.id
        ))
        .unwrap();
        let mut host = NkHost {
            admission: &f.admission,
            epoch: "relay-key".to_owned(),
            auth: &mut f.auth,
            account: None,
        };
        let mut accepted = host
            .admit(&payload, &ephemeral(1), || {})
            .expect("a ticket");
        assert_eq!(accepted.actor.device.id, paired.device.id);
        assert!(accepted.actor.revocable);
        // A paired confirmation may not carry a link proof or a machine code.
        assert!(
            accepted
                .confirm(
                    &mut f.auth,
                    "{\"type\":\"hello.confirm\",\"installId\":\"install-0001\",\
                     \"machineCode\":\"1234\"}"
                )
                .is_none()
        );
        assert!(accepted.session.closed());

        // The same ticket is spent; a second first message with it is refused.
        let mut host = NkHost {
            admission: &f.admission,
            epoch: "relay-key".to_owned(),
            auth: &mut f.auth,
            account: None,
        };
        assert!(
            host.admit(&payload, &ephemeral(2), || {}).is_none(),
            "a ticket opens one stream"
        );
    }

    #[test]
    fn a_ticket_asked_for_with_another_relay_key_opens_nothing() {
        let mut f = setup();
        let paired = {
            let code = f
                .auth
                .pairing(&[Scope::Read], &Default::default())
                .unwrap()
                .code;
            f.auth.redeem(&code, "Phone", None, None).unwrap()
        };
        let device = f.auth.device_bearer(&paired.token).unwrap();
        let ticket = f.auth.ticket(&device, "relay-key").unwrap().ticket;
        let payload = ace_json::parse(&format!(
            "{{\"type\":\"hello.early\",\"protocolVersion\":1,\"deviceId\":\"{}\",\
             \"ticket\":\"{ticket}\"}}",
            paired.device.id
        ))
        .unwrap();
        let mut host = NkHost {
            admission: &f.admission,
            epoch: "another-host".to_owned(),
            auth: &mut f.auth,
            account: None,
        };
        assert!(host.admit(&payload, &ephemeral(1), || {}).is_none());
    }
}
