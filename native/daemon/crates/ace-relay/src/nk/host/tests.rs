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
    still: std::sync::atomic::AtomicBool,
}

impl NkAccount for Account {
    fn admit_device_cached(&self, _grant: &str, _device_id: &str) -> AccountAdmission {
        self.admits.fetch_add(1, Ordering::SeqCst);
        if *self.cached.lock().unwrap() {
            AccountAdmission {
                admitted: true,
                account: Some("user_a".to_owned()),
                expires_at: Some(1_300_000),
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
        self.still.load(Ordering::SeqCst)
    }
}

struct Fixture {
    clock: Arc<ManualClock>,
    auth: ace_auth::RemoteAuth,
    admission: NkAdmission,
    account: Arc<Account>,
    account_trait: Arc<dyn NkAccount>,
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
    let account = Arc::new(Account {
        admits: AtomicUsize::new(0),
        cached: Mutex::new(true),
        still: std::sync::atomic::AtomicBool::new(true),
    });
    Fixture {
        clock,
        auth,
        admission,
        account: Arc::clone(&account),
        account_trait: account,
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
    // The admissions are held, as the relay holds each channel: a dropped one releases at once.
    let mut accepted = Vec::new();
    for n in 0..40_u8 {
        let mut host = NkHost {
            admission: &f.admission,
            epoch: "relay-key".to_owned(),
            auth: &mut f.auth,
            account: Some(f.account_trait.clone()),
        };
        if !host.arrive() {
            break;
        }
        if let Some(entry) = host.admit(&early("phone"), &ephemeral(n), || {}) {
            accepted.push(entry);
        }
    }
    // The device's rate (burst 4) stops the flood before its grant is checked; 2 sessions open.
    assert_eq!(f.account.admits.load(Ordering::SeqCst), 4);
    assert_eq!(accepted.len(), 2);
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
            account: Some(f.account_trait.clone()),
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
        account: Some(f.account_trait.clone()),
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
        account: Some(f.account_trait.clone()),
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
        account: Some(f.account_trait.clone()),
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
        account: Some(f.account_trait.clone()),
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

#[test]
fn the_first_message_plaintext_is_wiped_after_it_is_admitted() {
    let mut f = setup();
    let mut host = NkHost {
        admission: &f.admission,
        epoch: "relay-key".to_owned(),
        auth: &mut f.auth,
        account: None,
    };
    let mut payload = zeroize::Zeroizing::new(
        "{\"type\":\"hello.early\",\"protocolVersion\":1,\"deviceId\":\"phone\",\
         \"grant\":\"grant\"}"
            .as_bytes()
            .to_vec(),
    );
    let accepted = host.admit_bytes(&mut payload, &ephemeral(1), || {});
    assert!(accepted.is_none(), "no account backend is configured");
    assert!(
        payload.iter().all(|byte| *byte == 0),
        "the plaintext is wiped"
    );
}

#[test]
fn an_account_device_that_loses_access_says_so_and_its_session_ends_at_the_deadline() {
    let mut f = setup();
    let mut host = NkHost {
        admission: &f.admission,
        epoch: "relay-key".to_owned(),
        auth: &mut f.auth,
        account: Some(f.account_trait.clone()),
    };
    let accepted = host
        .admit(&early("phone"), &ephemeral(1), || {})
        .expect("an admission");
    assert!(accepted.is_still_admitted());
    // The account backend revokes the device (or its grant lapses): the channel's own check
    // is the one that answers.
    f.account.still.store(false, Ordering::SeqCst);
    assert!(!accepted.is_still_admitted());
}

#[test]
fn a_confirmation_after_the_deadline_ran_does_not_run_the_device_effects() {
    let mut f = setup();
    let mut host = NkHost {
        admission: &f.admission,
        epoch: "relay-key".to_owned(),
        auth: &mut f.auth,
        account: Some(f.account_trait.clone()),
    };
    let mut accepted = host
        .admit(&early("phone"), &ephemeral(1), || {})
        .expect("an admission");
    f.clock.advance(5_000);
    assert!(accepted.session.closed());
    assert!(
        accepted
            .confirm(&mut f.auth, "{\"type\":\"hello.confirm\"}")
            .is_none()
    );
}

#[test]
fn unreadable_first_message_bytes_are_refused_and_wiped() {
    let mut f = setup();
    let mut host = NkHost {
        admission: &f.admission,
        epoch: "relay-key".to_owned(),
        auth: &mut f.auth,
        account: Some(f.account_trait.clone()),
    };
    // Not UTF-8 at all: the refusal comes before any parse, and the buffer still holds what a
    // client's first message can hold.
    let mut payload = zeroize::Zeroizing::new(vec![0xff, 0xfe, 0x00, b'g']);
    assert!(
        host.admit_bytes(&mut payload, &ephemeral(1), || {})
            .is_none()
    );
    assert!(
        payload.iter().all(|byte| *byte == 0),
        "the plaintext is wiped on the invalid-UTF-8 path"
    );
}

#[test]
fn an_admission_keeps_neither_the_ticket_nor_the_grant_it_checked() {
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
    let accepted = host
        .admit(&payload, &ephemeral(1), || {})
        .expect("the ticket is spent and the device admitted");
    assert!(accepted.early.ticket.is_none(), "the spent ticket is gone");
    assert!(accepted.early.grant.is_none());

    drop(accepted);

    // The grant path clears it too; the account id is what the channel's check keeps.
    let mut account_host = NkHost {
        admission: &f.admission,
        epoch: "relay-key".to_owned(),
        auth: &mut f.auth,
        account: Some(f.account_trait.clone()),
    };
    let accepted = account_host
        .admit(&early("phone"), &ephemeral(2), || {})
        .expect("an admission");
    assert!(accepted.early.grant.is_none(), "the checked grant is gone");
}

#[test]
fn a_revoked_paired_device_cannot_confirm_an_admitted_nk_session() {
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
        "{{\"type\":\"hello.early\",\"protocolVersion\":1,\"deviceId\":\"{}\",\"ticket\":\"{ticket}\"}}",
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
        .expect("admitted before revocation");
    // Revoke the device before hello.confirm arrives.
    assert!(f.auth.revoke(&paired.device.id).unwrap());
    let confirm = accepted.confirm(
        &mut f.auth,
        "{\"type\":\"hello.confirm\",\"installId\":\"install-1\"}",
    );
    assert!(confirm.is_none(), "revoked device must not confirm");
    assert!(accepted.session.closed());
    assert_eq!(f.admission.held().sessions, 0);
}

#[test]
fn a_revoked_or_expired_account_device_cannot_confirm_an_admitted_nk_session() {
    let mut f = setup();
    let mut host = NkHost {
        admission: &f.admission,
        epoch: "relay-key".to_owned(),
        auth: &mut f.auth,
        account: Some(f.account_trait.clone()),
    };
    let mut accepted = host
        .admit(&early("phone"), &ephemeral(1), || {})
        .expect("admitted while still_admitted is true");
    // Revoke account access before confirmation arrives.
    f.account.still.store(false, Ordering::SeqCst);
    assert!(
        accepted
            .confirm(&mut f.auth, "{\"type\":\"hello.confirm\"}")
            .is_none(),
        "account device that lost access must not confirm"
    );
    assert!(accepted.session.closed());
    assert_eq!(f.admission.held().sessions, 0);

    // Re-enable access, admit with an expiring grant, then advance time past expiry.
    f.account.still.store(true, Ordering::SeqCst);
    let mut host = NkHost {
        admission: &f.admission,
        epoch: "relay-key".to_owned(),
        auth: &mut f.auth,
        account: Some(f.account_trait.clone()),
    };
    let mut accepted = host
        .admit(&early("phone"), &ephemeral(2), || {})
        .expect("admitted");
    accepted.grant_expires_at = Some(f.auth.now());
    assert!(
        accepted
            .confirm(&mut f.auth, "{\"type\":\"hello.confirm\"}")
            .is_none(),
        "expired grant must not confirm"
    );
    assert!(accepted.session.closed());
    assert_eq!(f.admission.held().sessions, 0);
}

#[test]
fn malformed_confirmation_json_closes_and_releases_the_nk_session() {
    let mut f = setup();
    let mut host = NkHost {
        admission: &f.admission,
        epoch: "relay-key".to_owned(),
        auth: &mut f.auth,
        account: Some(f.account_trait.clone()),
    };
    let mut accepted = host
        .admit(&early("phone"), &ephemeral(1), || {})
        .expect("admitted");
    assert!(accepted.session.reserve_bytes(1024));
    assert!(accepted.confirm(&mut f.auth, "{not valid json").is_none());
    assert!(accepted.session.closed());
    assert_eq!(f.admission.held().sessions, 0);
    assert_eq!(f.admission.held().bytes, 0);
}

#[test]
fn dropping_an_unconfirmed_nk_accepted_releases_the_session_even_when_cloned() {
    let mut f = setup();
    let mut host = NkHost {
        admission: &f.admission,
        epoch: "relay-key".to_owned(),
        auth: &mut f.auth,
        account: Some(f.account_trait.clone()),
    };
    let accepted = host
        .admit(&early("phone"), &ephemeral(1), || {})
        .expect("admitted");
    assert!(accepted.session.reserve_bytes(2048));
    let cloned_session = accepted.session.clone();
    drop(accepted);
    assert!(cloned_session.closed());
    assert_eq!(f.admission.held().sessions, 0);
    assert_eq!(f.admission.held().bytes, 0);
}
