// SPDX-License-Identifier: Apache-2.0
//! The moved cases of `media-paths.test.ts` (D3.3), beside the paths they name: the producer's
//! switches are the test's to answer, and every unit is handed in as egress would deliver it.

use super::*;

fn extension(sequence: u64, timestamp: f64, scale: f64) -> Vec<u8> {
    let mut out = vec![0, 1, 0, 24];
    out.extend(sequence.to_be_bytes());
    out.extend(timestamp.to_be_bytes());
    out.extend(scale.to_be_bytes());
    out
}

fn unit(path: &str, sequence: u64, keyframe: bool) -> EgressUnit {
    let mark = u8::try_from(sequence).unwrap_or(0);
    EgressUnit {
        source: path.to_string(),
        sequence,
        frame: EgressFrame {
            kind: 1,
            codec: 1,
            flags: if keyframe { 1 } else { 0 },
            width: 4,
            height: 4,
            encode: 0,
            codec_string: if keyframe {
                "avc1.640033".to_string()
            } else {
                String::new()
            },
            extension: extension(sequence, sequence as f64, 1.0),
            payload: vec![0, 0, 0, 1, if keyframe { 0x65 } else { 0x41 }, mark],
        },
    }
}

fn on() -> Switched {
    Switched {
        ingest: true,
        boundary: None,
        cut: false,
    }
}

fn off() -> Switched {
    Switched {
        ingest: false,
        boundary: None,
        cut: false,
    }
}

fn marks(actions: &[Action]) -> Vec<u8> {
    actions
        .iter()
        .filter_map(|action| match action {
            Action::Emit(unit) => unit.payload.get(5).copied(),
            _ => None,
        })
        .collect()
}

/// A device whose producer the test answers for, delivering units as egress does.
struct Device {
    paths: DevicePaths,
    next_unit: u64,
}

impl Device {
    fn new() -> Self {
        let (paths, actions) = DevicePaths::new("avc1.640033", false);
        assert_eq!(actions, vec![Action::Codes(vec![H264_ONLY.to_string()])]);
        Self {
            paths,
            next_unit: 0,
        }
    }

    fn point(&mut self, to: Option<&str>) -> u64 {
        let (token, actions) = self.paths.point(to);
        if let Some(Action::Switch {
            token: switched, ..
        }) = actions.first()
        {
            assert_eq!(*switched, token, "the new switch names its own token");
        }
        token
    }

    fn delivered(&mut self, path: &str, sequence: u64, keyframe: bool) -> Vec<Action> {
        self.next_unit += 1;
        self.paths
            .egress(self.next_unit, &unit(path, sequence, keyframe))
    }
}

#[test]
fn a_first_move_into_ace_media_hands_its_units_on_at_once() {
    let mut device = Device::new();
    let token = device.point(Some("p1"));
    let actions = device.paths.switched(token, on());
    assert!(actions.contains(&Action::PointDone { token }));
    let mut collected = marks(&device.delivered("p1", 1, true));
    collected.extend(marks(&device.delivered("p1", 2, false)));
    assert_eq!(collected, vec![1, 2]);
    assert_eq!(device.paths.stale(), 0);
}

#[test]
fn a_move_to_a_new_ace_media_path_holds_its_units_until_the_old_paths_last_ones_are_in() {
    let mut device = Device::new();
    let first = device.point(Some("p1"));
    device.paths.switched(first, on());
    let mut collected = marks(&device.delivered("p1", 1, true));
    let second = device.point(Some("p2"));
    device.paths.switched(second, on());
    // The new path's keyframe overtakes the old path's last deltas.
    assert!(marks(&device.delivered("p2", 4, true)).is_empty());
    collected.extend(marks(&device.delivered("p1", 2, false)));
    collected.extend(marks(&device.delivered("p1", 3, false)));
    collected.extend(marks(&device.paths.path_ended("p1", false)));
    collected.extend(marks(&device.delivered("p2", 5, false)));
    assert_eq!(collected, vec![1, 2, 3, 4, 5]);
    assert_eq!(device.paths.stale(), 0);
}

#[test]
fn a_failed_ingest_connection_stops_video_and_the_next_path_starts_at_its_keyframe() {
    let mut device = Device::new();
    let first = device.point(Some("p1"));
    device.paths.switched(first, on());
    device.delivered("p1", 1, true);
    device.delivered("p1", 2, false);
    assert_eq!(
        device.paths.ingest_closed(),
        vec![Action::Key { encode: 0 }, Action::Reconnect]
    );
    assert_eq!(
        device.paths.path_ended("p1", true),
        vec![Action::Key { encode: 0 }]
    );
    let second = device.point(Some("p2"));
    device.paths.switched(second, on());
    // Units the producer had sent ace-media may be lost: a delta can't start a decode.
    assert!(marks(&device.delivered("p2", 4, false)).is_empty());
    let mut collected = marks(&device.delivered("p2", 5, true));
    collected.extend(marks(&device.delivered("p2", 6, false)));
    assert_eq!(collected, vec![5, 6]);
    let _ = device.delivered("p1", 7, true);
    assert!(device.paths.stale() >= 1);
}

#[test]
fn a_producer_that_refuses_ace_medias_address_streams_nothing() {
    let mut device = Device::new();
    let token = device.point(Some("p1"));
    let actions = device.paths.switched(token, off());
    assert_eq!(
        actions.first(),
        Some(&Action::PointFailed {
            token,
            message: "The producer refused ace-media's ingest".to_string()
        })
    );
    assert!(marks(&device.delivered("p1", 2, true)).is_empty());
}

#[test]
fn paths_that_carry_one_live_stream_are_cut_at_a_switch() {
    let mut device = Device::new();
    let first = device.point(Some("p1"));
    device.paths.switched(first, on());
    device.delivered("p1", 1, true);
    device.delivered("p1", 2, false);
    let second = device.point(Some("p2"));
    let actions = device.paths.switched(
        second,
        Switched {
            ingest: true,
            boundary: None,
            cut: true,
        },
    );
    assert!(actions.contains(&Action::Key { encode: 0 }));
    assert_eq!(
        actions
            .iter()
            .find(|action| matches!(action, Action::Switch { .. })),
        None
    );
    // The new reader was already running: its older deltas are superseded by its keyframe.
    assert!(marks(&device.delivered("p2", 2, false)).is_empty());
    let mut collected = marks(&device.delivered("p2", 3, true));
    collected.extend(marks(&device.delivered("p2", 4, false)));
    // The old path's late units are never repeated.
    assert!(marks(&device.delivered("p1", 3, false)).is_empty());
    assert_eq!(collected, vec![3, 4]);
}

#[test]
fn a_path_that_ends_interrupted_asks_for_the_keyframe_its_successor_needs() {
    let mut device = Device::new();
    let first = device.point(Some("p1"));
    device.paths.switched(first, on());
    device.delivered("p1", 1, true);
    // ace-media went away: video stops, and its path ends cut.
    let stop = device.point(None);
    device.paths.switched(stop, off());
    assert_eq!(
        device.paths.path_ended("p1", true),
        vec![Action::Key { encode: 0 }]
    );
    let next = device.point(Some("p2"));
    device.paths.switched(next, on());
    assert!(marks(&device.delivered("p2", 2, false)).is_empty());
    let mut collected = marks(&device.delivered("p2", 3, true));
    collected.extend(marks(&device.delivered("p2", 4, false)));
    assert_eq!(collected, vec![3, 4]);
}

#[test]
fn closing_turns_the_producer_off_after_a_move_to_ace_media_still_in_flight() {
    let mut device = Device::new();
    let moving = device.point(Some("m1-a"));
    assert!(
        device.paths.close().is_empty(),
        "the move is still in flight"
    );
    let actions = device.paths.switched(moving, on());
    assert!(actions.contains(&Action::PointDone { token: moving }));
    let off = actions
        .iter()
        .find_map(|action| match action {
            Action::Switch { token, to } => Some((*token, to.clone())),
            _ => None,
        })
        .expect("the off switch follows the move");
    assert_eq!(off.1, None);
    assert!(device.paths.close().is_empty(), "close happens once");
    assert!(marks(&device.delivered("p1", 1, true)).is_empty());
}

#[test]
fn a_queued_move_that_close_caught_resolves_without_switching_and_the_off_still_goes() {
    let mut device = Device::new();
    let moving = device.point(Some("m1-a"));
    let _queued = device.point(Some("m1-b"));
    device.paths.close();
    let actions = device.paths.switched(moving, on());
    let switched: Vec<_> = actions
        .iter()
        .filter_map(|action| match action {
            Action::Switch { to, .. } => Some(to.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(
        switched,
        vec![None],
        "the queued move is dropped, the off is not"
    );
    assert_eq!(
        actions
            .iter()
            .filter(|action| matches!(action, Action::PointDone { .. }))
            .count(),
        2,
        "both point promises resolve"
    );
}

#[test]
fn a_switch_with_no_old_path_end_gives_up_after_the_hold_and_the_deltas_wait_for_a_keyframe() {
    let mut device = Device::new();
    let first = device.point(Some("p1"));
    device.paths.switched(first, on());
    device.delivered("p1", 1, true);
    let second = device.point(Some("p2"));
    let actions = device.paths.switched(second, on());
    let timer = actions
        .iter()
        .find_map(|action| match action {
            Action::ScheduleHold { timer } => Some(*timer),
            _ => None,
        })
        .expect("the hold has a timer");
    device.delivered("p2", 2, false);
    device.delivered("p2", 3, false);
    let settled = device.paths.hold_elapsed(timer);
    assert!(settled.contains(&Action::CancelHold { timer }));
    assert!(
        marks(&settled).is_empty(),
        "deltas held past a give-up are dropped"
    );
    assert_eq!(device.paths.stale(), 2);
}

#[test]
fn an_egress_unit_is_a_capture_unit_with_its_stamp_time_its_codec_and_its_keyframe() {
    let egress = unit("p1", 7, true);
    let video = egress_video_unit(&egress, "avc1.000000").expect("video");
    assert_eq!(
        video.video_codec, "avc1.640033",
        "a keyframe names its own codec"
    );
    assert_eq!(video.pts, 7_000);
    assert!(video.keyframe);
    let delta = unit("p1", 8, false);
    let video = egress_video_unit(&delta, "avc1.640033").expect("video");
    assert_eq!(
        video.video_codec, "avc1.640033",
        "a delta keeps the encode's codec"
    );
    assert_eq!(video.pts, 8_000);
    let mut not_video = unit("p1", 9, true);
    not_video.frame.kind = 2;
    assert!(egress_video_unit(&not_video, "avc1.640033").is_none());
}
