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
fn picture_link(i: &Value) -> PictureLink {
    PictureLink {
        link: n(i, "link"),
        pixels: n(i, "pixels"),
        side: i["side"].as_f64().unwrap_or(0.0),
        fps: n(i, "fps"),
        now: n(i, "now"),
        probing: b(i, "probing"),
    }
}
fn same_step(actual: Step, expected: &Value, what: &str) {
    assert!(
        (actual.scale - n(expected, "scale")).abs() < 1e-14,
        "{what}: {actual:?} vs {expected}"
    );
    assert_eq!(actual.fps, n(expected, "fps"), "{what}");
}
#[test]
fn scale_replays_every_shared_decision() {
    let mut scale = PictureScale::default();
    for row in rows(&load("scale")) {
        same_step(
            scale.update(picture_link(&row["input"])),
            &row["output"],
            "scale",
        );
    }
}
#[test]
fn scale_steps_replay_frame_rate_first_then_size_and_the_probing_ladder() {
    for scenario in rows(&load("scale-steps")) {
        let name = s(scenario, "name");
        let mut scale = PictureScale::default();
        for (index, step) in rows(&scenario["steps"]).iter().enumerate() {
            let actual = scale.update(picture_link(&step["input"]));
            same_step(actual, &step["output"], &format!("{name} step {index}"));
        }
    }
}
#[test]
fn quantizer_cap_replays_keyframes_held_to_half_a_second() {
    let v = load("quantizer-cap");
    let mut q = QuantizerControl::new(n(&v, "bitrate"), n(&v, "fps"));
    for (index, row) in rows(&v["steps"]).iter().enumerate() {
        let i = &row["input"];
        let key = b(i, "key");
        assert_eq!(q.next(key), n(&row["output"], "next"), "step {index}");
        q.observe(u(i, "bytes") as usize, key);
        if let Some(settled) = row["output"].get("settled") {
            assert_eq!(q.settled(), settled.as_f64(), "step {index}");
        }
        if let Some(rate) = i["retarget"].as_f64() {
            q.retarget(rate, n(&v, "fps"));
        }
    }
}
fn hint(v: &Value) -> LinkHint {
    LinkHint {
        effective_type: v["effectiveType"].as_str().map(str::to_owned),
        downlink_kbps: v["downlinkKbps"].as_f64(),
        rtt_ms: v["rttMs"].as_f64(),
        save_data: v["saveData"].as_bool().unwrap_or(false),
        expensive: v["expensive"].as_bool().unwrap_or(false),
        constrained: v["constrained"].as_bool().unwrap_or(false),
    }
}
fn limits(v: &Value) -> Limits {
    Limits {
        min: n(v, "min"),
        max: n(v, "max"),
        initial: n(v, "initial"),
    }
}
#[test]
fn link_hints_replay_the_start_they_pick() {
    for row in rows(&load("link-hint")) {
        let i = &row["input"];
        let rate = LinkRate::with_hint(limits(&i["limits"]), Some(&hint(&i["hint"])));
        assert_eq!(rate.rate(), n(&row["output"], "rate"), "{}", i["hint"]);
        assert_eq!(
            rate.probing(),
            b(&row["output"], "probing"),
            "{}",
            i["hint"]
        );
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
        match (rate.rtt(), row["output"]["rtt"].as_f64()) {
            (Some(actual), Some(expected)) => assert!((actual - expected).abs() < 1e-10),
            (actual, expected) => assert_eq!(actual, expected, "step {seq}"),
        }
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
    replay_plan(&load("plan"));
}
#[test]
fn plan_replays_stepped_viewers_frame_rates_in_place() {
    replay_plan(&load("plan-steps"));
}
#[test]
fn plan_breaks_equal_viewers_ties_in_utf16_order_like_the_typescript() {
    for case in rows(&load("plan-ties")) {
        replay_plan(case);
    }
}
fn replay_plan(v: &Value) {
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
            scale: v["scale"].as_f64().unwrap_or(1.0),
            fps: v["fps"].as_f64().unwrap_or(60.0),
        })
        .collect();
    let plan = plan_video(&source, &viewers);
    let encodes:Vec<_> = plan.encodes.iter().map(|e|json!({"key":e.key,"codec":e.codec,"width":e.width,"height":e.height,"fps":e.fps,"bitrate":e.bitrate})).collect();
    assert_eq!(
        json!({"encodes":encodes,"capture":{"width":plan.capture.width,"height":plan.capture.height},"viewers":plan.viewers}),
        v["output"]
    );
}
#[test]
fn link_capped_replays_a_view_held_to_its_link_step() {
    for row in rows(&load("link-capped")) {
        let i = &row["input"];
        let step = i["step"].as_object().map(|_| Step {
            scale: n(&i["step"], "scale"),
            fps: n(&i["step"], "fps"),
        });
        let actual = link_capped(settings(&i["asked"]), i["rate"].as_f64(), step);
        assert_eq!(actual, settings(&row["output"]), "{i}");
    }
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
            } else if let Some(bound) = op.get("bound") {
                viewer.bound(bound.as_u64().map(|v| v as usize));
            } else {
                panic!("{name}: unknown op {op}");
            }
        }
        assert_eq!(Value::Array(log.into_inner()), scenario["events"], "{name}");
    }
}
#[test]
fn link_rate_replays_edges_the_3g_link_loss_stalls_queueing_and_hints() {
    for scenario in rows(&load("link-rate-edges")) {
        let name = s(scenario, "name");
        let given = scenario.get("hint").map(hint);
        let mut rate = LinkRate::with_hint(limits(&scenario["limits"]), given.as_ref());
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
            assert_eq!(rate.probing(), b(out, "probing"), "{name} step {index}");
            // A byte count from float round trips: a last-bit difference may flip a .5 tie.
            match (rate.backlog_bytes(), out["backlogBytes"].as_u64()) {
                (Some(actual), Some(expected)) => {
                    assert!(
                        (actual as i64 - expected as i64).abs() <= 1,
                        "{name} step {index}"
                    )
                }
                (actual, expected) => {
                    assert_eq!(actual.map(|v| v as u64), expected, "{name} step {index}")
                }
            }
            match (rate.rtt(), out["rtt"].as_f64()) {
                (Some(actual), Some(expected)) => {
                    assert!((actual - expected).abs() < 1e-10, "{name} step {index}")
                }
                (actual, expected) => assert_eq!(actual, expected, "{name} step {index}"),
            }
        }
    }
}
