// SPDX-License-Identifier: Apache-2.0
use super::*;
use media_wire::frame::MediaFrame;

fn address(n: u8) -> Address {
    Address {
        socket: format!("ingest-{n}"),
        token: Zeroizing::new([n; TOKEN_LEN]),
    }
}

fn unit(sequence: u64, key: bool) -> VideoUnit {
    VideoUnit {
        sequence,
        timestamp_ms: 1.0,
        scale: 1.0,
        width: 64,
        height: 64,
        key,
        codec: key.then(|| "avc1.42001F".into()),
        epoch: 1,
        captured_us: 0,
        payload: vec![0, 0, 0, 1, if key { 0x65 } else { 0x41 }],
    }
}

/// Switches to `n` and reports its connection open; returns its generation.
fn connect(route: &mut Route, n: u8, now: u64, out: &mut Vec<RouteAction>) -> (u64, Switch) {
    let Switch::Connect { generation, socket } = route.begin(Some(address(n)), now, out) else {
        panic!("expected a connection")
    };
    assert_eq!(socket, format!("ingest-{n}"));
    (generation, route.connected(generation, now, out))
}

/// The frames written to `generation`, as (id, kind, sequence of the stamp or none).
fn frames(out: &[RouteAction], generation: u64) -> Vec<(u64, u8)> {
    out.iter()
        .filter_map(|a| match a {
            RouteAction::Write {
                generation: g,
                id,
                bytes,
            } if *g == generation => {
                Some((*id, MediaFrame::decode(bytes.as_slice()).unwrap().kind))
            }
            _ => None,
        })
        .collect()
}

fn ack(route: &mut Route, out: &[RouteAction], generation: u64) -> Vec<RouteAction> {
    let mut next = Vec::new();
    for (id, _) in frames(out, generation) {
        route.written(generation, id, &mut next);
    }
    next
}

#[test]
fn video_starts_on_the_daemon_path() {
    let mut route = Route::new(Config::default());
    let mut out = Vec::new();
    route.publish(&unit(0, true), 0, 0, &mut out);
    assert_eq!(out, vec![RouteAction::Legacy(unit(0, true))]);
    assert_eq!(route.begin(None, 0, &mut out), Switch::Same);
}

#[test]
fn a_switch_to_ace_media_has_the_daemon_path_last_sequence_as_its_boundary() {
    let mut route = Route::new(Config::default());
    let mut out = Vec::new();
    route.publish(&unit(0, true), 0, 0, &mut out);
    route.legacy_still(1);
    route.publish(&unit(2, false), 0, 0, &mut out);
    let (generation, switch) = connect(&mut route, 1, 0, &mut out);
    assert_eq!(switch, Switch::Switched { boundary: Some(2) });
    route.publish(&unit(3, true), 0, 0, &mut out);
    assert_eq!(
        frames(&out, generation)
            .iter()
            .map(|f| f.1)
            .collect::<Vec<_>>(),
        vec![5, 1]
    );
    assert!(route.ingesting());
    assert_eq!(route.begin(Some(address(1)), 0, &mut out), Switch::Same);
}

#[test]
fn switching_back_finishes_the_old_connection_cleanly_after_its_units() {
    let mut route = Route::new(Config::default());
    let mut out = Vec::new();
    let (generation, _) = connect(&mut route, 1, 0, &mut out);
    route.publish(&unit(0, true), 0, 0, &mut out);
    route.publish(&unit(1, false), 0, 0, &mut out);
    assert_eq!(
        route.begin(None, 0, &mut out),
        Switch::Switched { boundary: Some(1) }
    );
    assert_eq!(
        frames(&out, generation)
            .iter()
            .map(|f| f.1)
            .collect::<Vec<_>>(),
        vec![5, 1, 1, 4]
    );
    route.publish(&unit(2, true), 0, 0, &mut out);
    assert!(out.contains(&RouteAction::Legacy(unit(2, true))));
    assert_eq!(route.retiring(), 1);
    let done = ack(&mut route, &out, generation);
    assert_eq!(done, vec![RouteAction::Shutdown { generation }]);
    assert_eq!(route.retiring(), 0);
}

#[test]
fn a_retired_connection_failing_never_touches_the_current_one() {
    let mut route = Route::new(Config::default());
    let mut out = Vec::new();
    let (first, _) = connect(&mut route, 1, 0, &mut out);
    route.publish(&unit(0, true), 0, 0, &mut out);
    let (second, switch) = connect(&mut route, 2, 0, &mut out);
    assert_eq!(switch, Switch::Switched { boundary: Some(0) });
    let mut failed = Vec::new();
    route.write_failed(first, &mut failed);
    route.socket_closed(first, &mut failed);
    assert_eq!(failed, vec![RouteAction::Destroy { generation: first }]);
    assert!(route.ingesting());
    route.publish(&unit(1, true), 0, 0, &mut failed);
    assert_eq!(frames(&failed, second).len(), 1);
}

#[test]
fn the_current_connection_cut_sends_video_back_once_with_its_boundary() {
    let mut route = Route::new(Config::default());
    let mut out = Vec::new();
    let (generation, _) = connect(&mut route, 1, 0, &mut out);
    route.publish(&unit(4, true), 0, 0, &mut out);
    let mut cut = Vec::new();
    route.socket_closed(generation, &mut cut);
    route.socket_closed(generation, &mut cut);
    route.write_failed(generation, &mut cut);
    assert_eq!(
        cut,
        vec![
            RouteAction::Destroy { generation },
            RouteAction::IngestClosed {
                boundary: Some(4),
                cut: Cut::Closed
            },
        ]
    );
    assert!(!route.ingesting());
    let mut after = Vec::new();
    route.publish(&unit(5, true), 0, 0, &mut after);
    assert_eq!(after, vec![RouteAction::Legacy(unit(5, true))]);
}

#[test]
fn a_connection_superseded_before_it_opened_is_stale() {
    let mut route = Route::new(Config::default());
    let mut out = Vec::new();
    let Switch::Connect {
        generation: first, ..
    } = route.begin(Some(address(1)), 0, &mut out)
    else {
        panic!()
    };
    let Switch::Connect {
        generation: second, ..
    } = route.begin(Some(address(2)), 0, &mut out)
    else {
        panic!()
    };
    assert_eq!(route.connected(first, 0, &mut out), Switch::Stale);
    assert!(!route.ingesting());
    assert_eq!(
        route.connected(second, 0, &mut out),
        Switch::Switched { boundary: None }
    );
    // A failed connection leaves video where it is.
    let Switch::Connect {
        generation: third, ..
    } = route.begin(Some(address(3)), 0, &mut out)
    else {
        panic!()
    };
    route.connect_failed(third);
    assert_eq!(route.connected(third, 0, &mut out), Switch::Stale);
    assert!(route.ingesting());
}

#[test]
fn the_retired_set_is_capped_and_the_oldest_is_cut_silently() {
    let mut route = Route::new(Config::default());
    let mut out = Vec::new();
    let mut generations = Vec::new();
    for n in 1..=6 {
        generations.push(connect(&mut route, n, 0, &mut out).0);
    }
    // Five replaced, four kept: the first is destroyed, nothing reported.
    assert_eq!(route.retiring(), 4);
    assert!(out.contains(&RouteAction::Destroy {
        generation: generations[0]
    }));
    assert!(
        !out.iter()
            .any(|a| matches!(a, RouteAction::IngestClosed { .. }))
    );
    assert!(route.ingesting());
}

#[test]
fn a_retired_connection_that_never_finishes_is_cut_at_its_deadline() {
    let mut route = Route::new(Config::default());
    let mut out = Vec::new();
    let (first, _) = connect(&mut route, 1, 100, &mut out);
    connect(&mut route, 2, 100, &mut out);
    let mut later = Vec::new();
    route.tick(100 + DRAIN_LIMIT_MS, &mut later);
    assert_eq!(later, vec![RouteAction::Destroy { generation: first }]);
    assert_eq!(route.retiring(), 0);
    assert!(route.ingesting());
}

#[test]
fn close_destroys_every_connection() {
    let mut route = Route::new(Config::default());
    let mut out = Vec::new();
    let (first, _) = connect(&mut route, 1, 0, &mut out);
    let (second, _) = connect(&mut route, 2, 0, &mut out);
    let mut closed = Vec::new();
    route.close(&mut closed);
    assert_eq!(
        closed,
        vec![
            RouteAction::Destroy { generation: second },
            RouteAction::Destroy { generation: first }
        ]
    );
    assert!(!route.ingesting());
}
