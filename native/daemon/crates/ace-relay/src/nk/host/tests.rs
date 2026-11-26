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
