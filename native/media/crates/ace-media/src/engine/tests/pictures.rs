// SPDX-License-Identifier: Apache-2.0
//! JPEG sources ace-media encodes itself (E4): what the engine tells their encoder threads.
use super::*;

fn open(engine: &mut Engine, kind: &str) {
    send(
        engine,
        json!({ "type": "source.open", "source": "p", "handle": 3, "epoch": 2,
                "origin": { "kind": kind } }),
        &[9; 32],
        NOW,
    );
}

fn encodes(engine: &mut Engine, list: Value) -> Vec<Effect> {
    send(
        engine,
        json!({ "type": "source.encodes", "source": "p", "encodes": list }),
        &[],
        NOW,
    )
}

fn spec() -> Value {
    json!([{ "id": 1, "codec": "avc1.42E01F", "width": 640, "height": 400, "fps": 30, "bitrate": 2_000_000 }])
}

fn picture(engine: &mut Engine, epoch: u32, now: Now) -> Vec<Effect> {
    send(
        engine,
        json!({ "type": "source.picture", "source": "p", "ageMs": 5, "epoch": epoch }),
        b"aGVsbG8=",
        now,
    )
}

fn encode_effects(effects: &[Effect]) -> Vec<String> {
    effects
        .iter()
        .filter_map(|e| match e {
            Effect::Encode(command) => Some(format!("{command:?}")),
            _ => None,
        })
        .collect()
}

#[test]
fn pictures_of_a_source_with_encodes_go_to_its_encoder_stamped_and_aged() {
    for kind in ["tab-pictures", "user-tab"] {
        let mut engine = engine();
        open(&mut engine, kind);
        assert_eq!(
            encode_effects(&encodes(&mut engine, spec())),
            ["Configure(p, 1 encodes)"]
        );
        let effects = picture(&mut engine, 2, at(2_000));
        assert_eq!(encode_effects(&effects), ["Picture(p, epoch 2)"]);
        let aged = effects.iter().any(|e| {
            matches!(e, Effect::Encode(EncodeEffect::Picture { age_us: 5_000, text, .. }) if text == b"aGVsbG8=")
        });
        assert!(aged, "the text as received, with its age");
        assert!(statuses(&effects).is_empty(), "playing waits for a unit");
    }
}

#[test]
fn a_picture_newer_than_a_private_epoch_keeps_the_private_one_within_the_read_gap() {
    let mut engine = engine();
    open(&mut engine, "tab-pictures");
    encodes(&mut engine, spec());
    send(
        &mut engine,
        json!({ "type": "source.epoch", "source": "p", "seq": 1, "epoch": 3, "followsPrivate": true }),
        &[],
        at(2_000),
    );
    let early = picture(&mut engine, 3, at(2_050));
    let late = picture(&mut engine, 3, at(2_200));
    assert_eq!(encode_effects(&early), ["Picture(p, epoch 2)"]);
    assert_eq!(encode_effects(&late), ["Picture(p, epoch 3)"]);
}

#[test]
fn a_tab_source_takes_no_encodes_and_a_closed_source_stops_its_encoder() {
    let mut tab = engine();
    open_tab(&mut tab, "p", 3, 9);
    assert!(encode_effects(&encodes(&mut tab, spec())).is_empty());

    let mut engine = super::engine();
    open(&mut engine, "tab-pictures");
    encodes(&mut engine, spec());
    let closed = send(
        &mut engine,
        json!({ "type": "source.close", "source": "p" }),
        &[],
        NOW,
    );
    assert_eq!(encode_effects(&closed), ["Close(p)"]);
}

#[test]
fn encoded_units_play_the_source_and_its_steps_ride_its_status() {
    let mut engine = engine();
    open(&mut engine, "tab-pictures");
    encodes(&mut engine, spec());
    engine.encoded("p", unit(2, true), NOW);
    let effects: Vec<Effect> = engine.effects().collect();
    assert_eq!(statuses(&effects), [("p".into(), Status::Playing, None)]);
    let acceleration = media_wire::capability::Acceleration {
        steps: Vec::new(),
        degraded: false,
        reason: None,
    };
    engine.encoder_steps("p", acceleration);
    let effects: Vec<Effect> = engine.effects().collect();
    let carried = effects.iter().any(|e| {
        matches!(
            e,
            Effect::Normal(FromMedia::SourceStatus {
                status: Status::Playing,
                acceleration: Some(_),
                ..
            })
        )
    });
    assert!(carried);
}

#[test]
fn a_failed_encoder_ends_the_source_so_the_daemon_takes_it_back() {
    let mut engine = engine();
    open(&mut engine, "user-tab");
    encodes(&mut engine, spec());
    engine.encoder_failed("p", "encoder-unavailable");
    let effects: Vec<Effect> = engine.effects().collect();
    assert_eq!(
        statuses(&effects),
        [(
            "p".into(),
            Status::Ended,
            Some("encoder-unavailable".into())
        )]
    );
    assert_eq!(encode_effects(&effects), ["Close(p)"]);
    // Later pictures and units change nothing.
    assert!(encode_effects(&picture(&mut engine, 2, NOW)).is_empty());
    engine.encoded("p", unit(2, true), NOW);
    assert_eq!(engine.effects().count(), 0);
}
