// SPDX-License-Identifier: Apache-2.0
//! Tickets, viewers, relay keys, closes and revocations.
use super::super::*;
use super::*;
use media_wire::control::{FromMedia, Refusal};
use media_wire::keys::KeyBlock;
use serde_json::{Value, json};

fn viewer(engine: &mut Engine, connection: &str, who: Value, issued: u64) -> Vec<Effect> {
    send(
        engine,
        json!({ "type": "viewer.open", "viewer": "v", "connection": connection, "owner": who,
                "issued": issued, "source": "s1", "codecs": ["avc1.640028"],
                "viewport": { "width": 800, "height": 600, "dpr": 2, "scale": 1 },
                "local": true, "audio": false }),
        &[],
        NOW,
    )
}

fn revoke(
    engine: &mut Engine,
    id: &str,
    issued: u64,
    device: &str,
    admission: Option<Value>,
) -> Vec<Effect> {
    let mut value = json!({ "type": "revoke", "id": id, "issued": issued, "device": device });
    if let Some(admission) = admission {
        value["admission"] = admission;
    }
    send(engine, value, &[], NOW)
}

#[test]
fn viewer_grants_are_refused_for_unknown_connections_other_owners_and_revoked_owners() {
    struct Case {
        name: &'static str,
        connection: &'static str,
        owner: Value,
        issued: u64,
        refused: Option<Refusal>,
    }
    let case = |name, connection, owner, issued, refused| Case {
        name,
        connection,
        owner,
        issued,
        refused,
    };
    let cases = [
        case(
            "unknown connection",
            "nope",
            owner("d1", pairing(1)),
            6,
            Some(Refusal::UnknownConnection),
        ),
        case(
            "another device",
            "c1",
            owner("d2", pairing(1)),
            6,
            Some(Refusal::Owner),
        ),
        case(
            "another admission",
            "c1",
            owner("d1", pairing(2)),
            6,
            Some(Refusal::Owner),
        ),
        case(
            "issued before the revocation",
            "c2",
            owner("d3", pairing(1)),
            6,
            Some(Refusal::Revoked),
        ),
        case(
            "a connection the revocation closed",
            "c2",
            owner("d3", pairing(1)),
            8,
            Some(Refusal::UnknownConnection),
        ),
        case(
            "a connection issued after the revocation",
            "c3",
            owner("d3", pairing(1)),
            9,
            None,
        ),
        case("its own owner", "c1", owner("d1", pairing(1)), 6, None),
    ];
    for case in cases {
        let mut engine = engine();
        ticket(&mut engine, "c1", owner("d1", pairing(1)), 4, 1);
        ticket(&mut engine, "c2", owner("d3", pairing(1)), 5, 2);
        revoke(&mut engine, "r", 7, "d3", None);
        if case.connection == "c3" {
            ticket(&mut engine, "c3", owner("d3", pairing(1)), 8, 3);
        }
        let effects = viewer(&mut engine, case.connection, case.owner, case.issued);
        let expected: Vec<_> = case
            .refused
            .into_iter()
            .map(|r| ("viewer.open".to_owned(), r))
            .collect();
        assert_eq!(refusals(&effects), expected, "{}", case.name);
    }
}

#[test]
fn a_grant_issued_before_a_close_that_overtook_it_is_refused_and_installs_nothing() {
    let mut engine = engine();
    // The daemon issued a ticket and keys for c1, then closed it; the close (priority lane)
    // arrives first.
    let closed = send(
        &mut engine,
        json!({ "type": "connection.close", "id": "k", "connection": "c1", "reason": "session" }),
        &[],
        NOW,
    );
    assert!(matches!(
        closed.as_slice(),
        [Effect::Priority(FromMedia::Closed { .. })]
    ));
    let late_ticket = ticket(&mut engine, "c1", owner("d1", pairing(1)), 1, 1);
    assert_eq!(
        refusals(&late_ticket),
        [("media.ticket".into(), Refusal::UnknownConnection)]
    );
    assert!(engine.claim_ticket(&[1; 32], NOW).is_none());
    let late_keys = send(
        &mut engine,
        json!({ "type": "relay.keys", "stream": "st", "connection": "c1",
                "owner": owner("d1", pairing(1)), "issued": 2 }),
        &key_block(),
        NOW,
    );
    assert_eq!(
        refusals(&late_keys),
        [("relay.keys".into(), Refusal::UnknownConnection)]
    );

    // The same for one stream: closed before its keys arrive.
    send(
        &mut engine,
        json!({ "type": "relay.close", "id": "x", "stream": "st2", "reason": "done" }),
        &[],
        NOW,
    );
    let late_stream = send(
        &mut engine,
        json!({ "type": "relay.keys", "stream": "st2", "connection": "c2",
                "owner": owner("d1", pairing(1)), "issued": 3 }),
        &key_block(),
        NOW,
    );
    assert_eq!(
        refusals(&late_stream),
        [("relay.keys".into(), Refusal::UnknownConnection)]
    );
    assert_eq!(engine.counts().connections, 0, "nothing installed");
}

#[test]
fn a_grant_arriving_out_of_issue_order_is_refused() {
    let mut engine = engine();
    ticket(&mut engine, "c1", owner("d1", pairing(1)), 5, 1);
    let older = ticket(&mut engine, "c2", owner("d1", pairing(1)), 4, 2);
    assert_eq!(
        refusals(&older),
        [("media.ticket".into(), Refusal::Revoked)]
    );
}

#[test]
fn a_revocation_closes_exactly_the_owners_it_names_before_it_is_answered() {
    struct Case {
        name: &'static str,
        admission: Option<Value>,
        closed: &'static [&'static str],
    }
    let cases = [
        Case {
            name: "the pairing generation",
            admission: Some(pairing(1)),
            closed: &["paired"],
        },
        Case {
            name: "the account",
            admission: Some(account("a1")),
            closed: &["account"],
        },
        Case {
            name: "every admission",
            admission: None,
            closed: &["account", "paired"],
        },
        Case {
            name: "another generation",
            admission: Some(pairing(2)),
            closed: &[],
        },
    ];
    for case in cases {
        let mut engine = engine();
        ticket(&mut engine, "paired", owner("d1", pairing(1)), 1, 1);
        ticket(&mut engine, "account", owner("d1", account("a1")), 2, 2);
        ticket(&mut engine, "other", owner("d2", pairing(1)), 3, 3);
        let effects = revoke(&mut engine, "r1", 10, "d1", case.admission);
        let mut closed = closed_connections(&effects);
        closed.sort();
        assert_eq!(closed, case.closed, "{}", case.name);
        assert!(
            matches!(effects.last(), Some(Effect::Priority(FromMedia::Revoked { id })) if id.get() == "r1"),
            "{}: the answer comes after the closes",
            case.name
        );
        // A revoked ticket can no longer open its connection.
        for (token, name) in [(1u8, "paired"), (2, "account")] {
            let claimed = engine.claim_ticket(&[token; 32], NOW).is_some();
            assert_eq!(
                claimed,
                !case.closed.contains(&name),
                "{}: {name}",
                case.name
            );
        }
    }
}

#[test]
fn a_ticket_opens_its_connection_once_and_only_before_it_expires() {
    let mut engine = engine();
    ticket(&mut engine, "c1", owner("d1", pairing(1)), 1, 1);
    let claimed = engine.claim_ticket(&[1; 32], NOW);
    assert_eq!(claimed.as_ref().map(|c| c.get()), Some("c1"));
    assert!(matches!(
        engine.effects().collect::<Vec<_>>().as_slice(),
        [Effect::Normal(FromMedia::ConnectionOpen { .. })]
    ));
    assert!(engine.claim_ticket(&[1; 32], NOW).is_none(), "reused");
    assert!(engine.claim_ticket(&[2; 32], NOW).is_none(), "never issued");

    let expired = send(
        &mut engine,
        json!({ "type": "media.ticket", "connection": "late", "owner": owner("d1", pairing(1)),
                "issued": 2, "expiresAt": NOW.wall_ms }),
        &[3; 32],
        NOW,
    );
    assert_eq!(
        refusals(&expired),
        [("media.ticket".into(), Refusal::Expired)]
    );

    ticket(&mut engine, "unused", owner("d1", pairing(1)), 3, 4);
    let later = Now {
        mono_ms: NOW.mono_ms,
        wall_ms: NOW.wall_ms + 30_000,
    };
    assert!(
        engine.claim_ticket(&[4; 32], later).is_none(),
        "expired at claim"
    );
    ticket(&mut engine, "idle", owner("d1", pairing(1)), 4, 5);
    engine.tick(later);
    let ticked: Vec<Effect> = engine.effects().collect();
    assert_eq!(closed_connections(&ticked), ["idle"]);
}

fn key_block() -> Vec<u8> {
    let block = KeyBlock {
        send_key: Zeroizing::new([1; 32]),
        receive_key: Zeroizing::new([2; 32]),
        send_nonce: 0,
        receive_nonce: 0,
        frames_sent: 0,
        frames_received: 0,
        flags: 0,
        window: 0,
        unacked: 0,
        owed: 0,
        uncounted: 0,
    };
    match block.encode() {
        Ok(bytes) => bytes.to_vec(),
        Err(_) => panic!("key block did not encode"),
    }
}

fn keys(engine: &mut Engine, stream: &str, who: Value, issued: u64, payload: &[u8]) -> Vec<Effect> {
    send(
        engine,
        json!({ "type": "relay.keys", "stream": stream, "connection": "rc", "owner": who, "issued": issued }),
        payload,
        NOW,
    )
}

#[test]
fn relay_keys_install_only_for_a_live_owner_and_close_with_their_stream() {
    let mut engine = engine();
    let installed = keys(&mut engine, "st1", owner("d1", pairing(1)), 3, &key_block());
    assert!(matches!(
        installed.as_slice(),
        [Effect::Normal(FromMedia::ConnectionOpen { .. })]
    ));
    let other = keys(&mut engine, "st2", owner("d2", pairing(1)), 4, &key_block());
    assert_eq!(refusals(&other), [("relay.keys".into(), Refusal::Owner)]);
    let mut bad = key_block();
    bad[0] ^= 1;
    let corrupt = keys(&mut engine, "st3", owner("d1", pairing(1)), 4, &bad);
    assert!(matches!(
        corrupt.as_slice(),
        [Effect::Normal(FromMedia::RelayFailed { .. })]
    ));

    revoke(&mut engine, "r", 5, "d1", None);
    assert_eq!(engine.counts().connections, 0);
    let late = keys(&mut engine, "st4", owner("d1", pairing(1)), 5, &key_block());
    assert_eq!(refusals(&late), [("relay.keys".into(), Refusal::Revoked)]);

    let closed = send(
        &mut engine,
        json!({ "type": "relay.close", "id": "x", "stream": "gone", "reason": "done" }),
        &[],
        NOW,
    );
    assert!(matches!(
        closed.as_slice(),
        [Effect::Priority(FromMedia::Closed { .. })]
    ));
}

#[test]
fn closing_a_connection_ends_its_viewers_and_is_answered_after_it() {
    let mut engine = engine();
    ticket(&mut engine, "c1", owner("d1", pairing(1)), 1, 1);
    viewer(&mut engine, "c1", owner("d1", pairing(1)), 2);
    assert_eq!(engine.counts().viewers, 1);
    let effects = send(
        &mut engine,
        json!({ "type": "connection.close", "id": "k", "connection": "c1", "reason": "session" }),
        &[],
        NOW,
    );
    assert_eq!(closed_connections(&effects), ["c1"]);
    assert!(matches!(
        effects.last(),
        Some(Effect::Priority(FromMedia::Closed { .. }))
    ));
    assert_eq!(engine.counts().viewers, 0);
}
