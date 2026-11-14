// SPDX-License-Identifier: Apache-2.0
//! Replay the immutable K1 outputs, rather than recomputing expected policy decisions.
use media_core::{
    device_control::*, fanout::*, gate::*, link_rate::*, plan::*, quantizer::*, scale::*,
    screen_profile::*,
};
use serde_json::{Value, json};
fn load(area: &str) -> Value {
    let path = format!(
        "{}/../../vectors/{area}/scenarios.json",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{e}")))
        .unwrap_or_else(|e| panic!("{e}"))
}
fn rows(v: &Value) -> &[Value] {
    v.as_array().unwrap_or_else(|| panic!("expected array"))
}
fn n(v: &Value, key: &str) -> f64 {
    v[key].as_f64().unwrap_or_else(|| panic!("missing {key}"))
}
fn b(v: &Value, key: &str) -> bool {
    v[key].as_bool().unwrap_or_else(|| panic!("missing {key}"))
}
fn s<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or_else(|| panic!("missing {key}"))
}
fn u(v: &Value, key: &str) -> u64 {
    v[key].as_u64().unwrap_or_else(|| panic!("missing {key}"))
}
#[test]
fn gate_replays_every_shared_decision() {
    let mut gate = ChunkGate::default();
    for row in rows(&load("gate")) {
        let out = gate.offer(b(&row["input"], "key"), || b(&row["input"], "accept"));
        assert_eq!(
            json!({"sent":out.sent,"keyframe":out.keyframe}),
            row["output"]
        );
    }
}
#[test]
fn scale_replays_every_shared_decision() {
    let mut scale = PictureScale::default();
    for row in rows(&load("scale")) {
        let i = &row["input"];
        let actual = scale.update(n(i, "link"), n(i, "pixels"), n(i, "fps"), n(i, "now"));
        assert!((actual - row["output"].as_f64().unwrap_or_default()).abs() < 1e-14);
    }
}
#[test]
fn link_rate_replays_every_shared_decision() {
    let mut rate = LinkRate::new(Limits {
        initial: 1_000_000.0,
        ..Limits::default()
    });
    for (seq, row) in rows(&load("link-rate")).iter().enumerate() {
        let i = &row["input"];
        let at = n(i, "at");
        let ack = at + n(i, "rtt");
        rate.sent(seq as u64, u(i, "bytes") as usize, at);
        rate.acknowledged(seq as u64, ack);
        if b(row, "drop") {
            rate.dropped(ack);
        }
        assert_eq!(rate.rate(), n(&row["output"], "rate"), "step {seq}");
        assert!((rate.rtt().unwrap_or_default() - n(&row["output"], "rtt")).abs() < 1e-10);
    }
}
#[test]
fn quantizer_replays_every_shared_decision() {
    let mut q = QuantizerControl::new(1_000_000.0, 60.0);
    for row in rows(&load("quantizer")) {
        let i = &row["input"];
        let key = b(i, "key");
        assert_eq!(q.next(key), n(&row["output"], "next"));
        q.observe(u(i, "bytes") as usize, key);
        if key {
            assert_eq!(q.settled(), row["output"]["settled"].as_f64());
        }
    }
}
fn settings(v: &Value) -> StreamSettings {
    StreamSettings {
        codec: match s(v, "codec") {
            "jpeg" => Codec::Jpeg,
            "h264" => Codec::H264,
            other => panic!("{other}"),
        },
        max_width: u(v, "maxWidth") as u32,
        max_height: u(v, "maxHeight") as u32,
        fps: u(v, "fps") as u32,
        bitrate: u(v, "bitrate") as u32,
    }
}
#[test]
fn device_and_screen_profiles_and_common_budgets_replay_every_vector() {
    let v = load("device-control");
    for row in rows(&v["scenarios"]) {
        let i = &row["input"];
        let connection = match s(i, "connection") {
            "local" => Connection::Local,
            "remote" => Connection::Remote,
            "relay" => Connection::Relay,
            other => panic!("{other}"),
        };
        let panel = (n(&i["panel"], "width"), n(&i["panel"], "height"));
        assert_eq!(
            device_stream_profile(panel, connection, n(i, "pressure")),
            settings(&row["device"])
        );
        assert_eq!(
            screen_stream_profile(panel, connection, n(i, "pressure")),
            settings(&row["screen"])
        );
    }
    for row in rows(&v["common"]) {
        let profiles: Vec<_> = rows(&row["input"]).iter().map(settings).collect();
        assert_eq!(common_device_stream(&profiles), settings(&row["output"]));
    }
}
fn strings(v: &Value) -> Vec<&str> {
    rows(v)
        .iter()
        .map(|s| s.as_str().unwrap_or_default())
        .collect()
}
#[test]
fn plan_replays_sizes_groups_rates_and_assignments() {
    let v = load("plan");
    let i = &v["input"];
    let source = &i["source"];
    let codecs = strings(&source["codecs"]);
    let source = Source {
        width: n(source, "width"),
        height: n(source, "height"),
        scale: n(source, "scale"),
        codecs: &codecs,
    };
    let vc: Vec<_> = rows(&i["viewers"])
        .iter()
        .map(|v| strings(&v["codecs"]))
        .collect();
    let viewers: Vec<_> = rows(&i["viewers"])
        .iter()
        .zip(&vc)
        .map(|(v, codecs)| VideoViewer {
            id: s(v, "id"),
            viewport: Viewport {
                width: n(&v["viewport"], "width"),
                height: n(&v["viewport"], "height"),
                device_pixel_ratio: n(&v["viewport"], "devicePixelRatio"),
                native_shown: false,
            },
            codecs,
            link: n(v, "link"),
            scale: 1.0,
        })
        .collect();
    let plan = plan_video(&source, &viewers);
    let encodes:Vec<_> = plan.encodes.iter().map(|e|json!({"key":e.key,"codec":e.codec,"width":e.width,"height":e.height,"fps":e.fps,"bitrate":e.bitrate})).collect();
    assert_eq!(
        json!({"encodes":encodes,"capture":{"width":plan.capture.width,"height":plan.capture.height},"viewers":plan.viewers}),
        v["output"]
    );
}
fn record(event: Event, events: &mut Vec<Value>) {
    match event {
        Event::Keyframe => events.push(json!({"keyframe":"e"})),
        Event::Playing(playing) => events.push(json!({"id":"v","playing":playing})),
        Event::Dropped => events.push(json!({"dropped":"v"})),
        Event::Sent(_) => {}
    }
}
#[test]
fn fanout_replays_waiting_keyframes_drops_and_cumulative_ack_events() {
    let v = load("fanout");
    let mut events = Vec::new();
    let mut viewer = Viewer::new(Window {
        frames: 2,
        bytes: 30,
    });
    viewer.assign(Some(1), |e| record(e, &mut events));
    // Keep sink and state events in one ordered log without making the core allocate.
    let log = std::cell::RefCell::new(events);
    for step in rows(&v["steps"]) {
        let p = Piece {
            sequence: u(step, "sequence"),
            key: b(step, "key"),
            bytes: u(&step["bytes"], "length") as usize,
        };
        let send = |p: Piece| {
            log.borrow_mut().push(json!({"sent":p.sequence}));
            true
        };
        let event = |e| record(e, &mut log.borrow_mut());
        viewer.publish(1, p, send, event);
        if p.sequence == u(&v["ack"], "after") {
            viewer.acknowledge(u(&v["ack"], "sequence"), send, event);
        }
    }
    assert_eq!(Value::Array(log.into_inner()), v["events"]);
}
fn edge_event(event: Event, log: &mut Vec<Value>) {
    match event {
        Event::Sent(p) => log.push(json!({"counted":p.sequence,"bytes":p.bytes})),
        other => record(other, log),
    }
}
#[test]
fn fanout_replays_refusals_wraparound_stale_acks_empty_frames_and_late_joins() {
    for scenario in rows(&load("fanout-edges")) {
        let name = s(scenario, "name");
        let w = &scenario["window"];
        let mut viewer = Viewer::new(Window {
            frames: u(w, "frames") as usize,
            bytes: u(w, "bytes") as usize,
        });
        let log = std::cell::RefCell::new(Vec::new());
        let accepting = std::cell::Cell::new(true);
        let send = |p: Piece| {
            log.borrow_mut().push(json!({"offered":p.sequence}));
            accepting.get()
        };
        let event = |e| edge_event(e, &mut log.borrow_mut());
        for op in rows(&scenario["ops"]) {
            if let Some(p) = op.get("publish") {
                let p = Piece {
                    sequence: u(p, "sequence"),
                    key: b(p, "key"),
                    bytes: u(&p["bytes"], "length") as usize,
                };
                viewer.publish(1, p, send, event);
            } else if let Some(ack) = op["ack"].as_u64() {
                viewer.acknowledge(ack, send, event);
            } else if let Some(refuse) = op["refuse"].as_bool() {
                accepting.set(!refuse);
            } else if op.get("flush").is_some() {
                viewer.flush(send, event);
            } else if op.get("assign").is_some() {
                viewer.assign(Some(1), event);
            } else {
                panic!("{name}: unknown op {op}");
            }
        }
        assert_eq!(Value::Array(log.into_inner()), scenario["events"], "{name}");
    }
}
#[test]
fn link_rate_replays_wraparound_stale_acks_empty_frames_and_the_outstanding_bound() {
    for scenario in rows(&load("link-rate-edges")) {
        let name = s(scenario, "name");
        let mut rate = LinkRate::new(Limits {
            initial: 1_000_000.0,
            ..Limits::default()
        });
        for (index, step) in rows(&scenario["steps"]).iter().enumerate() {
            let op = &step["op"];
            if let Some(sent) = op.get("sent") {
                rate.sent(
                    u(sent, "sequence"),
                    u(sent, "bytes") as usize,
                    n(sent, "at"),
                );
            } else if let Some(ack) = op.get("ack") {
                rate.acknowledged(u(ack, "sequence"), n(ack, "at"));
            } else {
                rate.dropped(n(&op["drop"], "at"));
            }
            let out = &step["output"];
            assert_eq!(rate.rate(), n(out, "rate"), "{name} step {index}");
            match (rate.rtt(), out["rtt"].as_f64()) {
                (Some(actual), Some(expected)) => {
                    assert!((actual - expected).abs() < 1e-10, "{name} step {index}")
                }
                (actual, expected) => assert_eq!(actual, expected, "{name} step {index}"),
            }
        }
    }
}
