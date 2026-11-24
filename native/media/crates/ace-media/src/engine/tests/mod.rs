// SPDX-License-Identifier: Apache-2.0
//! Shared helpers for the engine's behaviour tests.
mod delivery;
mod egress;
mod flow;
mod grants;
mod headers;
mod pacing;
mod pictures;
mod relay_streams;
mod sources;
mod stills;
mod views;

use super::*;
use crate::engine::delivery::MediaOut;
use media_wire::control::{EncodeSpec, FromMedia, Refusal, Status, ToMedia};
use media_wire::frame::MediaFrame;
use serde_json::{Value, json};

pub(super) const NOW: Now = Now {
    mono_ms: 1_000,
    mono_us: 1_000_000,
    wall_ms: 50_000,
};

pub(super) fn at(mono_ms: u64) -> Now {
    Now {
        mono_ms,
        mono_us: mono_ms * 1_000,
        wall_ms: NOW.wall_ms,
    }
}

pub(super) fn message(value: Value) -> ToMedia {
    match serde_json::from_value(value) {
        Ok(message) => message,
        Err(error) => panic!("bad test message: {error}"),
    }
}

pub(super) fn send(engine: &mut Engine, value: Value, payload: &[u8], now: Now) -> Vec<Effect> {
    engine.control(message(value), Zeroizing::new(payload.to_vec()), now);
    engine.effects().collect()
}

pub(super) fn owner(device: &str, admission: Value) -> Value {
    json!({ "session": "s1", "device": device, "admission": admission })
}

/// A pairing admission: generations are opaque strings (credential hashes) the daemon gives.
pub(super) fn pairing(generation: u64) -> Value {
    json!({ "kind": "pairing", "generation": format!("{generation:032x}") })
}

pub(super) fn account(name: &str) -> Value {
    json!({ "kind": "account", "account": name })
}

pub(super) fn frame(kind: u8, flags: u32, epoch: u32, payload: Vec<u8>) -> MediaFrame {
    MediaFrame {
        kind,
        flags,
        age_us: 0,
        width: 2,
        height: 2,
        display_width: 2,
        display_height: 2,
        scale: 1000,
        rotation: 0,
        codec: if kind == 5 || kind == 4 { 0 } else { 1 },
        encode: 7,
        epoch,
        codec_string: String::new(),
        description: Vec::new(),
        extension: Vec::new(),
        payload,
    }
}

/// The shell hands a connection's hello to the engine; the effects say whether it stays.
pub(super) fn hello(engine: &mut Engine, conn: u64, token: u8) -> Vec<Effect> {
    let admitted = engine.ingest_hello(conn, &[token; 32]);
    let effects: Vec<Effect> = engine.effects().collect();
    assert_eq!(admitted, closes(&effects).is_empty());
    effects
}

pub(super) fn unit(epoch: u32, key: bool) -> MediaFrame {
    frame(1, u32::from(key), epoch, vec![0; 100])
}

pub(super) fn open_tab(engine: &mut Engine, source: &str, handle: u32, token: u8) -> Vec<Effect> {
    send(
        engine,
        json!({ "type": "source.open", "source": source, "handle": handle, "epoch": 1,
                "origin": { "kind": "tab" } }),
        &[token; 32],
        NOW,
    )
}

pub(super) fn statuses(effects: &[Effect]) -> Vec<(String, Status, Option<String>)> {
    effects
        .iter()
        .filter_map(|e| match e {
            Effect::Normal(FromMedia::SourceStatus {
                source,
                status,
                reason,
                ..
            }) => Some((source.get().to_owned(), status.clone(), reason.clone())),
            _ => None,
        })
        .collect()
}

pub(super) fn closes(effects: &[Effect]) -> Vec<u64> {
    effects
        .iter()
        .filter_map(|e| match e {
            Effect::CloseIngest(id) => Some(*id),
            _ => None,
        })
        .collect()
}

pub(super) fn refusals(effects: &[Effect]) -> Vec<(String, Refusal)> {
    effects
        .iter()
        .filter_map(|e| match e {
            Effect::Normal(FromMedia::GrantRefused { kind, reason, .. }) => {
                Some((kind.clone(), reason.clone()))
            }
            _ => None,
        })
        .collect()
}

pub(super) fn closed_connections(effects: &[Effect]) -> Vec<String> {
    effects
        .iter()
        .filter_map(|e| match e {
            Effect::Normal(FromMedia::ConnectionClosed { connection, .. }) => {
                Some(connection.get().to_owned())
            }
            _ => None,
        })
        .collect()
}

pub(super) fn ingest(engine: &mut Engine, conn: u64, frame: MediaFrame, now: Now) -> Vec<Effect> {
    engine.ingest(conn, frame, now);
    engine.effects().collect()
}

pub(super) fn engine() -> Engine {
    Engine::new(
        Box::new(super::recorder::NoRecorders),
        Box::new(super::egress::NoEgress),
    )
}

pub(super) fn ticket(
    engine: &mut Engine,
    connection: &str,
    who: Value,
    issued: u64,
    token: u8,
) -> Vec<Effect> {
    send(
        engine,
        json!({ "type": "media.ticket", "connection": connection, "owner": who,
                "issued": issued, "expiresAt": NOW.wall_ms + 30_000 }),
        &[token; 32],
        NOW,
    )
}

const CONNECTION: &str = "mc_test";

/// An engine with source `s1` (handle 1, producer connection 1) and an open media connection.
fn watched(target: Value) -> Engine {
    watched_decoding(target, json!(["avc1.42E033"]))
}

/// `watched`, with a view that decodes `codecs`, best first.
fn watched_decoding(target: Value, codecs: Value) -> Engine {
    watched_view(target, codecs, false)
}

/// `watched_decoding`, with `local`: whether the view is on this machine, as the daemon tells
/// ace-media for a viewer on its loopback listener (the desktop app).
fn watched_view(target: Value, codecs: Value, local: bool) -> Engine {
    let mut engine = engine();
    open_tab(&mut engine, "s1", 1, 3);
    hello(&mut engine, 1, 3);
    ticket(&mut engine, CONNECTION, owner("phone", pairing(1)), 1, 9);
    assert!(engine.claim_ticket(&[9; 32], NOW).is_some());
    engine.effects().for_each(drop);
    send(
        &mut engine,
        json!({ "type": "viewer.open", "viewer": "v1", "connection": CONNECTION,
                "owner": owner("phone", pairing(1)), "issued": 2, "source": "s1",
                "target": target, "codecs": codecs,
                "viewport": { "width": 390, "height": 844, "dpr": 3, "scale": 1 },
                "local": local, "audio": false }),
        &[],
        NOW,
    );
    engine
}

/// The view's client shows everything it has been given: one cumulative ack, numbered far
/// ahead of the view's own sequence counter.
fn shown(engine: &mut Engine, now: Now) {
    engine.media_message(
        CONNECTION,
        &json!({ "type": "browser.ack", "threadId": "t1", "sequence": 4_000_000_000_u64,
                 "video": true })
        .to_string(),
        now,
    );
}

/// The view's rate and dropped count as `viewer.stats` last reported them.
fn reported(effects: &[Effect]) -> Option<(f64, u64)> {
    effects.iter().rev().find_map(|e| match e {
        Effect::Normal(FromMedia::ViewerStats { rate, dropped, .. }) => {
            Some((f64::from(*rate), dropped.get()))
        }
        _ => None,
    })
}

fn binaries(effects: &[Effect]) -> Vec<Vec<u8>> {
    effects
        .iter()
        .filter_map(|e| match e {
            Effect::Media {
                out: MediaOut::Binary(bytes),
                ..
            } => Some(bytes.clone()),
            _ => None,
        })
        .collect()
}

fn wants(effects: &[Effect]) -> Vec<Vec<EncodeSpec>> {
    effects
        .iter()
        .filter_map(|e| match e {
            Effect::Normal(FromMedia::SourceWant { encodes, .. }) => Some(encodes.clone()),
            _ => None,
        })
        .collect()
}

fn keyframes(effects: &[Effect]) -> usize {
    effects
        .iter()
        .filter(|e| matches!(e, Effect::Normal(FromMedia::SourceKeyframe { .. })))
        .count()
}

fn h264(key: bool, n: u8, codec: u8, description: Vec<u8>) -> MediaFrame {
    let mut unit = frame(1, u32::from(key), 1, Vec::new());
    unit.encode = 0;
    unit.width = 1170;
    unit.height = 2532;
    unit.display_width = 390;
    unit.display_height = 844;
    unit.scale = 3000;
    unit.codec = codec;
    unit.codec_string = "avc1.42E033".into();
    unit.description = description;
    unit.payload = if codec == 2 {
        vec![0, 0, 0, 2, if key { 0x65 } else { 0x41 }, n]
    } else {
        vec![0, 0, 0, 1, if key { 0x65 } else { 0x41 }, n]
    };
    unit
}
