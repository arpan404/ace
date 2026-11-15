// SPDX-License-Identifier: Apache-2.0
//! Relay media streams: the daemon's pulls before the keys, then ace-media's own sealing.
use super::super::relay::RelayEffect;
use super::super::*;
use super::*;
use media_noise::{RelayStream, credit_fragment};
use media_wire::control::FromMedia;
use media_wire::keys::KeyBlock;
use serde_json::json;

fn sid(stream: &str) -> Id {
    match Id::new(stream.to_owned()) {
        Ok(id) => id,
        Err(_) => panic!("bad id"),
    }
}

fn block(send: u8, receive: u8, flags: u8, window: u32) -> Zeroizing<Vec<u8>> {
    let block = KeyBlock {
        send_key: Zeroizing::new([send; 32]),
        receive_key: Zeroizing::new([receive; 32]),
        send_nonce: 0,
        receive_nonce: 0,
        frames_sent: 0,
        frames_received: 0,
        flags,
        window,
        unacked: 0,
        owed: 0,
        uncounted: 0,
    };
    match block.encode() {
        Ok(bytes) => Zeroizing::new(bytes.to_vec()),
        Err(_) => panic!("key block did not encode"),
    }
}

/// The client's end of the same stream: the daemon's keys, crossed.
fn client() -> RelayStream {
    match RelayStream::import(block(2, 1, 1, 1024 * 1024)) {
        Ok(stream) => stream,
        Err(_) => panic!("client keys"),
    }
}

fn dial(engine: &mut Engine, stream: &str) -> Vec<Effect> {
    send(
        engine,
        json!({ "type": "relay.dial", "stream": stream, "url": "ws://127.0.0.1:9/join?ticket=t" }),
        &[],
        NOW,
    )
}

fn hand_over(engine: &mut Engine, stream: &str, issued: u64) -> Vec<Effect> {
    engine.control(
        message(
            json!({ "type": "relay.keys", "stream": stream, "connection": "rc",
                        "owner": owner("d1", pairing(1)), "issued": issued }),
        ),
        block(1, 2, 1, 1024 * 1024),
        NOW,
    );
    engine.effects().collect()
}

fn json_fragment(text: &str) -> Vec<u8> {
    let mut plain = vec![1u8];
    plain.extend_from_slice(text.as_bytes());
    plain
}

fn sent(effects: &[Effect]) -> Vec<Vec<u8>> {
    effects
        .iter()
        .filter_map(|e| match e {
            Effect::Relay(RelayEffect::Send { frame, .. }) => Some(frame.clone()),
            _ => None,
        })
        .collect()
}

fn relay_in(effects: &[Effect]) -> Vec<Vec<u8>> {
    effects
        .iter()
        .filter_map(|e| match e {
            Effect::NormalWith(FromMedia::RelayIn { .. }, frame) => Some(frame.clone()),
            _ => None,
        })
        .collect()
}

#[test]
fn before_its_keys_a_stream_hands_the_daemon_one_frame_per_pull_in_order() {
    let mut engine = engine();
    assert!(matches!(
        dial(&mut engine, "st").as_slice(),
        [Effect::Relay(RelayEffect::Dial { .. })]
    ));
    // Nothing is written before the socket is up.
    let early = send(
        &mut engine,
        json!({ "type": "relay.out", "stream": "st" }),
        &[7],
        NOW,
    );
    assert!(sent(&early).is_empty());
    assert!(engine.relay_dialed(&sid("st")));
    let up: Vec<Effect> = engine.effects().collect();
    assert!(matches!(
        up.as_slice(),
        [Effect::Normal(FromMedia::RelayDialed { .. })]
    ));
    let out = send(
        &mut engine,
        json!({ "type": "relay.out", "stream": "st" }),
        &[7],
        NOW,
    );
    assert_eq!(sent(&out), [vec![7]]);

    engine.relay_frame(&sid("st"), vec![1]);
    engine.relay_frame(&sid("st"), vec![2]);
    assert!(relay_in(&engine.effects().collect::<Vec<_>>()).is_empty());
    let pull = json!({ "type": "relay.pull", "stream": "st" });
    assert_eq!(
        relay_in(&send(&mut engine, pull.clone(), &[], NOW)),
        [vec![1]]
    );
    assert_eq!(
        relay_in(&send(&mut engine, pull.clone(), &[], NOW)),
        [vec![2]]
    );
    // A pull ahead of its frame is answered when the frame arrives.
    assert!(relay_in(&send(&mut engine, pull, &[], NOW)).is_empty());
    engine.relay_frame(&sid("st"), vec![3]);
    assert_eq!(relay_in(&engine.effects().collect::<Vec<_>>()), [vec![3]]);
}

#[test]
fn a_stream_the_daemon_stops_pulling_is_failed_past_its_bound_and_shut() {
    let mut engine = engine();
    dial(&mut engine, "st");
    engine.relay_dialed(&sid("st"));
    engine.effects().for_each(drop);
    for n in 0..relay::MAX_HELD_FRAMES {
        engine.relay_frame(&sid("st"), vec![n as u8]);
    }
    assert!(engine.effects().next().is_none());
    engine.relay_frame(&sid("st"), vec![0]);
    let effects: Vec<Effect> = engine.effects().collect();
    assert!(
        effects
            .iter()
            .any(|e| matches!(e, Effect::Relay(RelayEffect::Close { .. })))
    );
    assert!(effects.iter().any(
        |e| matches!(e, Effect::Normal(FromMedia::RelayFailed { reason, .. }) if reason == "backlog")
    ));
}

#[test]
fn dials_are_refused_for_tls_relays_and_for_streams_closed_before() {
    let mut engine = engine();
    let tls = send(
        &mut engine,
        json!({ "type": "relay.dial", "stream": "a", "url": "wss://relay/join" }),
        &[],
        NOW,
    );
    assert!(matches!(
        tls.as_slice(),
        [Effect::Normal(FromMedia::RelayFailed { .. })]
    ));
    send(
        &mut engine,
        json!({ "type": "relay.close", "id": "x", "stream": "b", "reason": "done" }),
        &[],
        NOW,
    );
    let again = dial(&mut engine, "b");
    assert!(matches!(
        again.as_slice(),
        [Effect::Normal(FromMedia::RelayFailed { .. })]
    ));
}

#[test]
fn after_the_keys_ace_media_opens_what_the_daemon_never_pulled_and_answers_it() {
    let mut engine = engine();
    let mut client = client();
    dial(&mut engine, "st");
    engine.relay_dialed(&sid("st"));
    engine.effects().for_each(drop);
    // The client's flow start and a ping, sent after its hello and never pulled.
    let start = match client.seal(&credit_fragment(0)) {
        Ok(frame) => frame,
        Err(_) => panic!("seal"),
    };
    let ping = match client.seal(&json_fragment(r#"{"type":"ping","rttMs":40}"#)) {
        Ok(frame) => frame,
        Err(_) => panic!("seal"),
    };
    engine.relay_frame(&sid("st"), start);
    engine.relay_frame(&sid("st"), ping);
    let effects = hand_over(&mut engine, "st", 3);
    assert!(
        effects
            .iter()
            .any(|e| matches!(e, Effect::Normal(FromMedia::ConnectionOpen { .. })))
    );
    let frames = sent(&effects);
    assert_eq!(frames.len(), 1, "one pong");
    let pong = match client.open(&frames[0]) {
        Ok(plain) => plain,
        Err(_) => panic!("the client could not open ace-media's frame"),
    };
    assert_eq!(&pong[..], &json_fragment(r#"{"type":"pong"}"#)[..]);

    // Pieces go out as binary messages the client opens, while its window allows.
    assert!(engine.relay_send("rc", true, &[5; 1000]));
    let piece = sent(&engine.effects().collect::<Vec<_>>());
    let opened = match client.open(&piece[0]) {
        Ok(plain) => plain,
        Err(_) => panic!("piece"),
    };
    assert_eq!(opened[0], 3, "a binary message's last fragment");
    assert_eq!(&opened[1..], &[5; 1000][..]);
}

#[test]
fn a_piece_waits_for_credit_when_the_clients_window_is_spent() {
    let mut engine = engine();
    dial(&mut engine, "st");
    engine.relay_dialed(&sid("st"));
    engine.control(
        message(
            json!({ "type": "relay.keys", "stream": "st", "connection": "rc",
                        "owner": owner("d1", pairing(1)), "issued": 1 }),
        ),
        block(1, 2, 1, 8192),
        NOW,
    );
    engine.effects().for_each(drop);
    assert!(engine.relay_send("rc", true, &[1; 4000]));
    assert!(engine.relay_send("rc", true, &[1; 4000]));
    assert!(
        !engine.relay_send("rc", true, &[1; 4000]),
        "the window is spent"
    );
}

#[test]
fn a_client_sending_anything_but_acks_and_pings_loses_its_connection() {
    let mut engine = engine();
    let mut client = client();
    dial(&mut engine, "st");
    engine.relay_dialed(&sid("st"));
    hand_over(&mut engine, "st", 1);
    let subscribe = match client.seal(&json_fragment(r#"{"type":"browser.subscribe"}"#)) {
        Ok(frame) => frame,
        Err(_) => panic!("seal"),
    };
    engine.relay_frame(&sid("st"), subscribe);
    let effects: Vec<Effect> = engine.effects().collect();
    assert_eq!(closed_connections(&effects), ["rc"]);
    assert!(
        effects
            .iter()
            .any(|e| matches!(e, Effect::Relay(RelayEffect::Close { .. })))
    );
    assert_eq!(engine.counts().connections, 0);
}

#[test]
fn a_revocation_shuts_the_relay_socket_before_it_is_answered() {
    let mut engine = engine();
    dial(&mut engine, "st");
    engine.relay_dialed(&sid("st"));
    hand_over(&mut engine, "st", 1);
    let effects = send(
        &mut engine,
        json!({ "type": "revoke", "id": "r", "issued": 2, "device": "d1" }),
        &[],
        NOW,
    );
    let close = effects
        .iter()
        .position(|e| matches!(e, Effect::Relay(RelayEffect::Close { .. })));
    let answer = effects
        .iter()
        .position(|e| matches!(e, Effect::Priority(FromMedia::Revoked { .. })));
    assert!(matches!((close, answer), (Some(c), Some(a)) if c < a));
    // A frame still in flight on the shut stream is dropped, not opened.
    engine.relay_frame(&sid("st"), vec![0; 40]);
    assert!(sent(&engine.effects().collect::<Vec<_>>()).is_empty());
}

#[test]
fn sealed_frames_reuse_pooled_buffers_once_written() {
    let mut engine = engine();
    dial(&mut engine, "st");
    engine.relay_dialed(&sid("st"));
    hand_over(&mut engine, "st", 1);
    let pool = engine.relay_pool();
    assert!(engine.relay_send("rc", true, &[1; 2000]));
    let frame = sent(&engine.effects().collect::<Vec<_>>()).remove(0);
    let mut written = Vec::with_capacity(relay::FRAME_CAPACITY);
    written.extend_from_slice(&frame);
    pool.give(written);
    assert_eq!(pool.held(), 1);
    assert!(engine.relay_send("rc", true, &[1; 2000]));
    engine.effects().for_each(drop);
    assert_eq!(
        pool.held(),
        0,
        "the next frame was sealed into the pooled buffer"
    );
}
