// SPDX-License-Identifier: Apache-2.0
use super::recorder::{RecordSpec, Recorder, Recorders};
use super::*;
use media_wire::control::{FromMedia, Part, Refusal, Status, ToMedia};
use media_wire::frame::MediaFrame;
use media_wire::keys::KeyBlock;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

const NOW: Now = Now {
    mono_ms: 1_000,
    wall_ms: 50_000,
};

fn at(mono_ms: u64) -> Now {
    Now {
        mono_ms,
        wall_ms: NOW.wall_ms,
    }
}

fn message(value: Value) -> ToMedia {
    match serde_json::from_value(value) {
        Ok(message) => message,
        Err(error) => panic!("bad test message: {error}"),
    }
}

fn send(engine: &mut Engine, value: Value, payload: &[u8], now: Now) -> Vec<Effect> {
    engine.control(message(value), Zeroizing::new(payload.to_vec()), now);
    engine.effects().collect()
}

fn owner(device: &str, admission: Value) -> Value {
    json!({ "session": "s1", "device": device, "admission": admission })
}

fn pairing(generation: u64) -> Value {
    json!({ "kind": "pairing", "generation": generation })
}

fn account(name: &str) -> Value {
    json!({ "kind": "account", "account": name })
}

fn frame(kind: u8, flags: u32, epoch: u32, payload: Vec<u8>) -> MediaFrame {
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

fn hello(token: u8) -> MediaFrame {
    frame(5, 0, 0, vec![token; 32])
}

fn unit(epoch: u32, key: bool) -> MediaFrame {
    frame(1, u32::from(key), epoch, vec![0; 100])
}

fn open_tab(engine: &mut Engine, source: &str, handle: u32, token: u8) -> Vec<Effect> {
    send(
        engine,
        json!({ "type": "source.open", "source": source, "handle": handle, "epoch": 1,
                "origin": { "kind": "tab" } }),
        &[token; 32],
        NOW,
    )
}

fn statuses(effects: &[Effect]) -> Vec<(String, Status, Option<String>)> {
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

fn closes(effects: &[Effect]) -> Vec<u64> {
    effects
        .iter()
        .filter_map(|e| match e {
            Effect::CloseIngest(id) => Some(*id),
            _ => None,
        })
        .collect()
}

fn refusals(effects: &[Effect]) -> Vec<(String, Refusal)> {
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

fn closed_connections(effects: &[Effect]) -> Vec<String> {
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

fn ingest(engine: &mut Engine, conn: u64, frame: MediaFrame, now: Now) -> Vec<Effect> {
    engine.ingest(conn, frame, now);
    engine.effects().collect()
}

fn engine() -> Engine {
    Engine::new(Box::new(super::recorder::NoRecorders))
}

#[test]
fn an_ingest_connection_stays_open_only_after_a_hello_with_an_unused_token_of_an_open_source() {
    let mut engine = engine();
    open_tab(&mut engine, "s1", 1, 9);
    let cases: [(&str, MediaFrame, bool); 3] = [
        ("unit before hello", unit(1, true), false),
        ("wrong token", hello(8), false),
        ("right token", hello(9), true),
    ];
    for (conn, (name, first, kept)) in (1u64..).zip(cases) {
        let effects = ingest(&mut engine, conn, first, NOW);
        assert_eq!(closes(&effects).is_empty(), kept, "{name}");
    }
    // Tokens are single use.
    assert_eq!(closes(&ingest(&mut engine, 4, hello(9), NOW)), [4]);
    // A closed source's token is gone with it.
    open_tab(&mut engine, "s2", 2, 3);
    send(
        &mut engine,
        json!({ "type": "source.close", "source": "s2" }),
        &[],
        NOW,
    );
    assert_eq!(closes(&ingest(&mut engine, 5, hello(3), NOW)), [5]);
}

#[test]
fn a_source_reports_starting_then_playing_at_its_first_unit_retrying_when_its_producer_drops_and_ended_at_its_end()
 {
    let mut engine = engine();
    let opened = open_tab(&mut engine, "s1", 1, 9);
    assert_eq!(statuses(&opened), [("s1".into(), Status::Starting, None)]);
    assert!(statuses(&ingest(&mut engine, 1, hello(9), NOW)).is_empty());
    let first = ingest(&mut engine, 1, unit(1, true), NOW);
    assert_eq!(statuses(&first), [("s1".into(), Status::Playing, None)]);
    assert!(statuses(&ingest(&mut engine, 1, unit(1, false), NOW)).is_empty());

    engine.ingest_closed(1, NOW);
    let dropped: Vec<Effect> = engine.effects().collect();
    assert!(matches!(
        dropped.as_slice(),
        [Effect::Normal(FromMedia::SourceStatus {
            status: Status::Retrying,
            attempts: Some(1),
            ..
        })]
    ));

    // The daemon reopens the source with a fresh token; the producer streams again and ends.
    open_tab(&mut engine, "s1", 2, 4);
    ingest(&mut engine, 2, hello(4), NOW);
    ingest(&mut engine, 2, unit(1, true), NOW);
    let ended = ingest(&mut engine, 2, frame(4, 0, 0, Vec::new()), NOW);
    assert_eq!(statuses(&ended), [("s1".into(), Status::Ended, None)]);
    assert_eq!(closes(&ended), [2]);
}

#[test]
fn a_reused_handle_and_an_origin_without_a_reader_end_the_source_at_once() {
    let mut engine = engine();
    open_tab(&mut engine, "s1", 1, 9);
    let reused = open_tab(&mut engine, "s2", 1, 8);
    assert_eq!(
        statuses(&reused),
        [("s2".into(), Status::Ended, Some("handle-reused".into()))]
    );
    let simulator = send(
        &mut engine,
        json!({ "type": "source.open", "source": "sim", "handle": 2, "epoch": 0,
                "origin": { "kind": "simulator", "streamUrl": "http://x", "stillUrl": "http://y" } }),
        &[1; 32],
        NOW,
    );
    assert_eq!(
        statuses(&simulator),
        [
            ("sim".into(), Status::Starting, None),
            (
                "sim".into(),
                Status::Ended,
                Some("reader-unavailable".into())
            )
        ]
    );
}

#[test]
fn source_epochs_are_acknowledged_on_the_priority_lane() {
    let mut engine = engine();
    send(
        &mut engine,
        json!({ "type": "source.open", "source": "p", "handle": 1, "epoch": 3,
                "origin": { "kind": "tab-pictures" } }),
        &[1; 32],
        NOW,
    );
    let applied = send(
        &mut engine,
        json!({ "type": "source.epoch", "source": "p", "seq": 0, "epoch": 4, "followsPrivate": true }),
        &[],
        NOW,
    );
    assert!(matches!(
        applied.as_slice(),
        [Effect::Priority(FromMedia::EpochApplied { epoch: 4, .. })]
    ));
    // An unknown source has nothing to apply.
    let unknown = send(
        &mut engine,
        json!({ "type": "source.epoch", "source": "q", "seq": 0, "epoch": 4, "followsPrivate": false }),
        &[],
        NOW,
    );
    assert!(unknown.is_empty());
}

fn ticket(
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
    let cases = [
        Case {
            name: "unknown connection",
            connection: "nope",
            owner: owner("d1", pairing(1)),
            issued: 5,
            refused: Some(Refusal::UnknownConnection),
        },
        Case {
            name: "another device",
            connection: "c1",
            owner: owner("d2", pairing(1)),
            issued: 5,
            refused: Some(Refusal::Owner),
        },
        Case {
            name: "another admission",
            connection: "c1",
            owner: owner("d1", pairing(2)),
            issued: 5,
            refused: Some(Refusal::Owner),
        },
        Case {
            name: "issued before the revocation",
            connection: "c2",
            owner: owner("d3", pairing(1)),
            issued: 6,
            refused: Some(Refusal::Revoked),
        },
        Case {
            name: "issued after the revocation",
            connection: "c2",
            owner: owner("d3", pairing(1)),
            issued: 8,
            refused: None,
        },
        Case {
            name: "its own owner",
            connection: "c1",
            owner: owner("d1", pairing(1)),
            issued: 5,
            refused: None,
        },
    ];
    for case in cases {
        let mut engine = engine();
        ticket(&mut engine, "c1", owner("d1", pairing(1)), 4, 1);
        revoke(&mut engine, "r", 7, "d3", None);
        ticket(&mut engine, "c2", owner("d3", pairing(1)), 8, 2);
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

type Log = Arc<Mutex<Vec<String>>>;

struct FakeRecorder(Log);

impl Recorder for FakeRecorder {
    fn write(&mut self, frame: &MediaFrame) {
        self.push(format!("write {} {}", frame.epoch, frame.flags & 1));
    }
    fn gap(&mut self) {
        self.push("gap".into());
    }
    fn cut(&mut self) {}
    fn meta(&mut self, _: u32, _: &serde_json::Value) {}
    fn finish(self: Box<Self>) -> Result<Vec<Part>, String> {
        self.push("finish".into());
        Ok(Vec::new())
    }
}

impl FakeRecorder {
    fn push(&self, line: String) {
        if let Ok(mut log) = self.0.lock() {
            log.push(line);
        }
    }
}

struct FakeRecorders(Log);

impl Recorders for FakeRecorders {
    fn start(&mut self, _: &RecordSpec<'_>) -> Result<Box<dyn Recorder>, String> {
        Ok(Box::new(FakeRecorder(self.0.clone())))
    }
}

fn written(log: &Log) -> Vec<String> {
    log.lock().map(|l| l.clone()).unwrap_or_default()
}

fn decide(
    engine: &mut Engine,
    seq: u64,
    decided: u32,
    clear: Value,
    discard: Value,
    now: Now,
) -> Vec<Effect> {
    send(
        engine,
        json!({ "type": "record.epochs", "source": "s1", "seq": seq, "decided": decided,
                "clear": clear, "discard": discard }),
        &[],
        now,
    )
}

#[test]
fn recorded_frames_reach_the_recorder_only_once_their_epoch_is_decided_clear() {
    let log = Log::default();
    let mut engine = Engine::new(Box::new(FakeRecorders(log.clone())));
    open_tab(&mut engine, "s1", 1, 9);
    send(
        &mut engine,
        json!({ "type": "record.start", "recording": "r1", "source": "s1", "directory": "/tmp/r",
                "maxBytes": 1_000_000, "pointerTrack": false }),
        &[],
        NOW,
    );
    ingest(&mut engine, 1, hello(9), NOW);
    ingest(&mut engine, 1, unit(1, true), NOW);
    ingest(&mut engine, 1, unit(2, false), NOW);
    ingest(&mut engine, 1, unit(3, true), NOW);
    assert!(written(&log).is_empty(), "held until decided");

    // Decisions out of order: seq 1 waits for seq 0.
    assert!(decide(&mut engine, 1, 3, json!([[3, 3]]), json!([]), NOW).is_empty());
    let applied = decide(&mut engine, 0, 2, json!([[1, 1]]), json!([[2, 2]]), NOW);
    let answers: Vec<u64> = applied
        .iter()
        .filter_map(|e| match e {
            Effect::Priority(FromMedia::EpochsApplied { seq, .. }) => Some(seq.get()),
            _ => None,
        })
        .collect();
    assert_eq!(answers, [0, 1]);
    // Epoch 2 was discarded; the next part starts at epoch 3's keyframe.
    assert_eq!(written(&log), ["write 1 1", "write 3 1"]);

    let stopped = send(
        &mut engine,
        json!({ "type": "record.stop", "recording": "r1" }),
        &[],
        NOW,
    );
    assert!(matches!(
        stopped.as_slice(),
        [Effect::Normal(FromMedia::RecordDone { .. })]
    ));
}

#[test]
fn frames_held_past_the_bound_become_a_gap_and_never_reach_the_recorder() {
    let log = Log::default();
    let mut engine = Engine::new(Box::new(FakeRecorders(log.clone())));
    open_tab(&mut engine, "s1", 1, 9);
    send(
        &mut engine,
        json!({ "type": "record.start", "recording": "r1", "source": "s1", "directory": "/tmp/r",
                "maxBytes": 1_000_000, "pointerTrack": false }),
        &[],
        NOW,
    );
    ingest(&mut engine, 1, hello(9), NOW);
    ingest(&mut engine, 1, unit(1, true), at(1_000));
    engine.tick(at(1_000 + media_core::privacy::HOLD_MS + 1));
    let ticked: Vec<Effect> = engine.effects().collect();
    assert!(ticked.iter().any(|e| matches!(
        e,
        Effect::Normal(FromMedia::SourceKeyframe { encode: 7, .. })
    )));
    decide(&mut engine, 0, 1, json!([[1, 1]]), json!([]), at(5_000));
    assert_eq!(written(&log), ["gap"]);
}

#[test]
fn without_a_recorder_recording_fails_and_decisions_are_still_answered() {
    let mut engine = engine();
    open_tab(&mut engine, "s1", 1, 9);
    let started = send(
        &mut engine,
        json!({ "type": "record.start", "recording": "r1", "source": "s1", "directory": "/tmp/r",
                "maxBytes": 1, "pointerTrack": false }),
        &[],
        NOW,
    );
    assert!(matches!(
        started.as_slice(),
        [Effect::Normal(FromMedia::RecordFailed { reason, .. })] if reason == "recorder-unavailable"
    ));
    let answered = decide(&mut engine, 0, 1, json!([[1, 1]]), json!([]), NOW);
    assert!(matches!(
        answered.as_slice(),
        [Effect::Priority(FromMedia::EpochsApplied { .. })]
    ));
}

#[test]
fn work_this_binary_does_not_do_yet_fails_at_once_so_the_daemon_falls_back() {
    let mut engine = engine();
    let still = send(
        &mut engine,
        json!({ "type": "still.take", "request": "q", "source": "s1", "maxWidth": 10,
                "maxHeight": 10, "maxPixels": 100, "quality": 80, "deadlineMs": 500 }),
        &[],
        NOW,
    );
    assert!(matches!(
        still.as_slice(),
        [Effect::Normal(FromMedia::StillFailed { .. })]
    ));
    let dial = send(
        &mut engine,
        json!({ "type": "relay.dial", "stream": "st", "url": "wss://relay/join" }),
        &[],
        NOW,
    );
    assert!(matches!(
        dial.as_slice(),
        [Effect::Normal(FromMedia::RelayFailed { .. })]
    ));
}

#[test]
fn finishing_closes_every_connection_and_recording() {
    let log = Log::default();
    let mut engine = Engine::new(Box::new(FakeRecorders(log.clone())));
    open_tab(&mut engine, "s1", 1, 9);
    send(
        &mut engine,
        json!({ "type": "record.start", "recording": "r1", "source": "s1", "directory": "/tmp/r",
                "maxBytes": 1, "pointerTrack": false }),
        &[],
        NOW,
    );
    ticket(&mut engine, "c1", owner("d1", pairing(1)), 1, 1);
    engine.finish();
    let effects: Vec<Effect> = engine.effects().collect();
    assert_eq!(closed_connections(&effects), ["c1"]);
    assert!(
        effects
            .iter()
            .any(|e| matches!(e, Effect::Normal(FromMedia::RecordDone { .. })))
    );
    assert_eq!(written(&log), ["finish"]);
}
