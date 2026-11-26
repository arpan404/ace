// SPDX-License-Identifier: Apache-2.0
//! The host core's behaviour, one table per thing it guards: the order of `receiveFrame` and what
//! crosses with a frame (`wire`), the hold and the diagnostics ports (`hold`), and the cases moved
//! from the six TypeScript host process files (`host_files`).

mod hold;
mod host_files;
mod wire;

use ace_json::Value;

use super::super::envelope::CursorLimits;
use super::{
    CursorHostConfig, CursorHostCore, HostEffect, MALFORMED, PORT_CONNECTION, PORT_ERROR_FRAME,
    PORT_STDERR, PORT_STOP, PORT_STRAY,
};

/// The envelope `frame-batch.test.ts` writes, in schema order.
const DELTA: &str = r#"{"schemaVersion":1,"operationId":"op","generation":"g","segment":0,"kind":"delta","body":{"type":"text-delta","text":"hi"}}"#;

fn core() -> CursorHostCore {
    CursorHostCore::new(CursorHostConfig {
        generation: "g".into(),
        limits: CursorLimits::default(),
    })
}

fn request_line(id: &str, params: &str) -> String {
    format!(r#"{{"jsonrpc":"2.0","id":"{id}","method":"frame","params":{params}}}"#)
}

fn notification_line(params: &str) -> String {
    format!(r#"{{"jsonrpc":"2.0","method":"frame","params":{params}}}"#)
}

fn feed(host: &mut CursorHostCore, lines: &[&str]) -> Vec<HostEffect> {
    let mut text = lines.join("\n");
    text.push('\n');
    host.stdout_bytes(text.as_bytes())
}

fn frames(effects: &[HostEffect]) -> Vec<(u64, Value, String)> {
    effects
        .iter()
        .filter_map(|effect| match effect {
            HostEffect::Frame { seq, data, text } => Some((*seq, data.clone(), text.clone())),
            _ => None,
        })
        .collect()
}

fn port(effects: &[HostEffect], name: &str) -> Option<String> {
    effects.iter().find_map(|effect| match effect {
        HostEffect::Port { name: found, json } if *found == name => Some(json.clone()),
        _ => None,
    })
}

/// The pipe takes every line the peer handed out, so the next one can go.
fn ack(host: &mut CursorHostCore, mut effects: Vec<HostEffect>) -> Vec<HostEffect> {
    let mut at = 0;
    while at < effects.len() {
        if let HostEffect::Write { ticket, .. } = effects[at] {
            let follow = host.written(ticket);
            effects.splice(at + 1..at + 1, follow);
        }
        at += 1;
    }
    effects
}

fn writes(effects: &[HostEffect]) -> Vec<String> {
    effects
        .iter()
        .filter_map(|effect| match effect {
            HostEffect::Write { wire, .. } => {
                Some(String::from_utf8_lossy(wire).trim_end().to_owned())
            }
            _ => None,
        })
        .collect()
}
