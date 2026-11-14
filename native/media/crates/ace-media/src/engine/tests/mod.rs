// SPDX-License-Identifier: Apache-2.0
//! Shared helpers for the engine's behaviour tests.
mod egress;
mod grants;
mod sources;

use super::*;
use media_wire::control::{FromMedia, Refusal, Status, ToMedia};
use media_wire::frame::MediaFrame;
use serde_json::{Value, json};

pub(super) const NOW: Now = Now {
    mono_ms: 1_000,
    wall_ms: 50_000,
};

pub(super) fn at(mono_ms: u64) -> Now {
    Now {
        mono_ms,
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

pub(super) fn pairing(generation: u64) -> Value {
    json!({ "kind": "pairing", "generation": generation })
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
