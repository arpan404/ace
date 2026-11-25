// SPDX-License-Identifier: Apache-2.0

use crate::error::{DeviceErrorCode, DeviceFailure, DevicePlatformKind};
use crate::inventory::adb_transports::DeviceState;
use crate::inventory::android::AppDevice;
use crate::inventory::{
    CoordinatorAction, CoordinatorConfig, Inventory, InventoryCoordinator, InventorySource,
    ReadScope, SourceHealth, TimerKind, diff_missed_sources, same_inventory,
};
use ace_json::JsString;

fn ios_device(udid: &str, state: DeviceState) -> AppDevice {
    AppDevice {
        id: JsString::from(format!("ios:{udid}")),
        platform: DevicePlatformKind::Ios,
        name: JsString::from("iPhone 16"),
        state,
        runtime: Some(JsString::from("iOS 26.5")),
        serial: None,
        model: None,
    }
}

fn avd_device(name: &str, state: DeviceState, serial: Option<&str>) -> AppDevice {
    AppDevice {
        id: JsString::from(format!("android:{name}")),
        platform: DevicePlatformKind::Android,
        name: JsString::from(name),
        state,
        runtime: None,
        serial: serial.map(JsString::from),
        model: None,
    }
}

fn physical_android(serial: &str, state: DeviceState) -> AppDevice {
    AppDevice {
        id: JsString::from(format!("android:{serial}")),
        platform: DevicePlatformKind::Android,
        name: JsString::from("Pixel 9"),
        state,
        runtime: None,
        serial: Some(JsString::from(serial)),
        model: Some(JsString::from("Pixel_9")),
    }
}

fn sample_failure(msg: &str) -> DeviceFailure {
    DeviceFailure {
        code: DeviceErrorCode::CommandFailed,
        message: JsString::from(msg),
        hint: JsString::from("Check the device tooling and try again."),
        platform: None,
        permission: None,
    }
}

fn find_timer(actions: &[CoordinatorAction], target: TimerKind) -> Option<(u64, u64)> {
    actions.iter().find_map(|a| match a {
        CoordinatorAction::ArmTimer { id, kind, delay_ms } if *kind == target => {
            Some((*id, *delay_ms))
        }
        _ => None,
    })
}

fn find_read(actions: &[CoordinatorAction]) -> Option<(u64, ReadScope, bool)> {
    actions.iter().find_map(|a| match a {
        CoordinatorAction::StartRead {
            read_id,
            scope,
            liveness,
            ..
        } => Some((*read_id, *scope, *liveness)),
        _ => None,
    })
}

fn find_read_full(actions: &[CoordinatorAction]) -> Option<(u64, ReadScope, bool, bool)> {
    actions.iter().find_map(|a| match a {
        CoordinatorAction::StartRead {
            read_id,
            scope,
            liveness,
            invalidate_adb_cache,
        } => Some((*read_id, *scope, *liveness, *invalidate_adb_cache)),
        _ => None,
    })
}

fn read_ids(actions: &[CoordinatorAction]) -> Vec<(u64, ReadScope, bool)> {
    actions
        .iter()
        .filter_map(|a| match a {
            CoordinatorAction::StartRead {
                read_id,
                scope,
                liveness,
                ..
            } => Some((*read_id, *scope, *liveness)),
            _ => None,
        })
        .collect()
}

fn make_all_healthy(coord: &mut InventoryCoordinator, initial: Inventory) -> u64 {
    let start = coord.set_active(true);
    let Some((read1, ReadScope::All, false)) = find_read(&start) else {
        panic!("expected initial reconcile read, got {start:?}");
    };
    let Some((liveness_id, 60_000)) = find_timer(&start, TimerKind::Liveness) else {
        panic!("expected 60s liveness timer, got {start:?}");
    };
    let _ = coord.on_watcher_ready(InventorySource::Adb, true);
    let _ = coord.on_watcher_ready(InventorySource::Avds, true);
    let _ = coord.on_watcher_ready(InventorySource::Ios, true);
    // Completing read1 (started before watchers were ready) triggers pending reconcile read2.
    let after1 = coord.on_read_succeeded(read1, initial.clone());
    assert_eq!(
        coord.source_health(InventorySource::Adb),
        SourceHealth::Reconciling
    );
    let Some((read2, ReadScope::All, false)) = find_read(&after1) else {
        panic!("expected post-ready reconcile read, got {after1:?}");
    };
    let after2 = coord.on_read_succeeded(read2, initial);
    assert_eq!(
        coord.source_health(InventorySource::Adb),
        SourceHealth::Healthy
    );
    assert_eq!(
        coord.source_health(InventorySource::Avds),
        SourceHealth::Healthy
    );
    assert_eq!(
        coord.source_health(InventorySource::Ios),
        SourceHealth::Healthy
    );
    // Becoming healthy cancels fallback timers.
    assert!(
        after2
            .iter()
            .any(|a| matches!(a, CoordinatorAction::CancelTimer { .. }))
    );
    liveness_id
}

#[test]
fn poll_failure_keeps_last_devices_reports_issue_and_dedups_warning() {
    // Moved (b) case from packages/devices/src/audit.test.ts:199-224.
    let mut coord = InventoryCoordinator::new(CoordinatorConfig {
        enable_ios: false,
        fallback_interval_ms: 4_000,
        ..CoordinatorConfig::default()
    });
    let initial = Inventory {
        devices: vec![avd_device("Pixel", DeviceState::Booted, None)],
        issues: vec![],
    };
    let pub_initial = coord.update(initial);
    assert!(matches!(pub_initial, Some(CoordinatorAction::Publish(_))));

    let start = coord.set_active(true);
    let Some((read1, ReadScope::All, false)) = find_read(&start) else {
        panic!("expected initial read");
    };
    let failed1 = coord.on_read_failed(read1, sample_failure("read failed"), "read failed");
    assert!(failed1.iter().any(|a| matches!(
        a,
        CoordinatorAction::LogWarn { detail, .. } if detail == "read failed"
    )));
    let published = failed1.iter().find_map(|a| match a {
        CoordinatorAction::Publish(inv) => Some(inv),
        _ => None,
    });
    let Some(published) = published else {
        panic!("expected failed read to publish preserved devices with issue");
    };
    assert_eq!(published.devices.len(), 1);
    assert_eq!(published.devices[0].name.as_str(), "Pixel");
    assert_eq!(published.issues.len(), 1);
    assert!(!published.issues[0].hint.is_empty());

    // A second failure with the same message does not spam the warn log.
    let Some((fb_id, 4_000)) = find_timer(&start, TimerKind::Fallback(InventorySource::Adb)) else {
        panic!("expected 4s fallback timer for Adb");
    };
    let fire = coord.on_timer_fired(fb_id);
    let Some((read2, ReadScope::Source(InventorySource::Adb), false)) = find_read(&fire) else {
        panic!("expected Adb fallback read");
    };
    let failed2 = coord.on_read_failed(read2, sample_failure("read failed"), "read failed");
    assert!(
        !failed2
            .iter()
            .any(|a| matches!(a, CoordinatorAction::LogWarn { .. }))
    );
    // Same error message does not re-publish an identical inventory.
    assert!(
        !failed2
            .iter()
            .any(|a| matches!(a, CoordinatorAction::Publish(_)))
    );
}

#[test]
fn nothing_runs_while_inactive_and_stopping_cancels_timers_and_watchers() {
    let mut coord = InventoryCoordinator::new(CoordinatorConfig {
        enable_ios: false,
        ..CoordinatorConfig::default()
    });
    assert!(coord.on_source_trigger(InventorySource::Adb).is_empty());
    assert!(coord.on_watcher_lost(InventorySource::Avds).is_empty());
    assert!(coord.on_timer_fired(1).is_empty());

    let start = coord.set_active(true);
    // Only Adb and Avds start on non-macOS (`enable_ios: false`).
    assert!(start.contains(&CoordinatorAction::StartWatcher(InventorySource::Adb)));
    assert!(start.contains(&CoordinatorAction::StartWatcher(InventorySource::Avds)));
    assert!(!start.contains(&CoordinatorAction::StartWatcher(InventorySource::Ios)));
    assert_eq!(
        coord.source_health(InventorySource::Ios),
        SourceHealth::Stopped
    );

    let armed_ids: Vec<u64> = start
        .iter()
        .filter_map(|a| match a {
            CoordinatorAction::ArmTimer { id, .. } => Some(*id),
            _ => None,
        })
        .collect();
    assert!(!armed_ids.is_empty());

    let stop = coord.set_active(false);
    assert!(stop.contains(&CoordinatorAction::StopWatcher(InventorySource::Adb)));
    assert!(stop.contains(&CoordinatorAction::StopWatcher(InventorySource::Avds)));
    for id in &armed_ids {
        assert!(stop.contains(&CoordinatorAction::CancelTimer { id: *id }));
    }
    assert_eq!(
        coord.source_health(InventorySource::Adb),
        SourceHealth::Stopped
    );
    assert_eq!(
        coord.source_health(InventorySource::Avds),
        SourceHealth::Stopped
    );

    // Stale timers or triggers after stop are completely ignored.
    for id in armed_ids {
        assert!(coord.on_timer_fired(id).is_empty());
    }
    assert!(coord.on_source_trigger(InventorySource::Adb).is_empty());
}

#[test]
fn parent_attached_watcher_stays_unhealthy_with_fallback_until_target_reconciles() {
    let mut coord = InventoryCoordinator::new(CoordinatorConfig {
        enable_ios: true,
        ..CoordinatorConfig::default()
    });
    let start = coord.set_active(true);
    let Some((read1, ReadScope::All, false)) = find_read(&start) else {
        panic!("expected initial reconcile read");
    };
    // AVDs folder doesn't exist yet -> watch attached to parent (`on_target = false`).
    let parent_ready = coord.on_watcher_ready(InventorySource::Avds, false);
    assert_eq!(
        coord.source_health(InventorySource::Avds),
        SourceHealth::Unhealthy
    );
    assert!(find_read(&parent_ready).is_none());

    let _ = coord.on_read_succeeded(read1, Inventory::default());
    assert_eq!(
        coord.source_health(InventorySource::Avds),
        SourceHealth::Unhealthy
    );

    // Once the AVDs folder appears and the watcher attaches directly, it reconciles and turns healthy.
    let target_ready = coord.on_watcher_ready(InventorySource::Avds, true);
    assert_eq!(
        coord.source_health(InventorySource::Avds),
        SourceHealth::Reconciling
    );
    let Some((read2, ReadScope::All, false)) = find_read(&target_ready) else {
        panic!("expected reconcile read when target watcher comes up");
    };
    let _ = coord.on_read_succeeded(read2, Inventory::default());
    assert_eq!(
        coord.source_health(InventorySource::Avds),
        SourceHealth::Healthy
    );
}

#[test]
fn triggers_are_debounced_coalesced_and_bounded_to_one_in_flight_per_list() {
    let mut coord = InventoryCoordinator::new(CoordinatorConfig {
        enable_ios: true,
        ..CoordinatorConfig::default()
    });
    let _liveness = make_all_healthy(&mut coord, Inventory::default());

    // Burst of 5 triggers arms only one 250 ms debounce timer.
    let t1 = coord.on_source_trigger(InventorySource::Ios);
    let Some((deb1, 250)) = find_timer(&t1, TimerKind::Debounce(InventorySource::Ios)) else {
        panic!("expected 250ms debounce timer, got {t1:?}");
    };
    for _ in 0..4 {
        assert!(coord.on_source_trigger(InventorySource::Ios).is_empty());
    }

    // Firing debounce starts one Ios read; Adb can still run independently without blocking.
    let fire1 = coord.on_timer_fired(deb1);
    let Some((ios_read1, ReadScope::Source(InventorySource::Ios), false)) = find_read(&fire1)
    else {
        panic!("expected Ios read, got {fire1:?}");
    };
    // Burst of triggers while Ios read is in flight coalesces to dirty without starting a second read.
    for _ in 0..10 {
        let during = coord.on_source_trigger(InventorySource::Ios);
        assert!(during.is_empty());
    }
    // Completing the in-flight read arms at most one extra debounced read.
    let done1 = coord.on_read_succeeded(ios_read1, Inventory::default());
    let Some((deb2, 250)) = find_timer(&done1, TimerKind::Debounce(InventorySource::Ios)) else {
        panic!("expected one coalesced follow-up debounce, got {done1:?}");
    };
    let fire2 = coord.on_timer_fired(deb2);
    assert_eq!(read_ids(&fire2).len(), 1);
}

#[test]
fn dead_source_reconnects_with_exponential_backoff_capped_at_5s_and_falls_back() {
    let mut coord = InventoryCoordinator::new(CoordinatorConfig {
        enable_ios: true,
        ..CoordinatorConfig::default()
    });
    let _liveness = make_all_healthy(&mut coord, Inventory::default());

    let expected_delays = [100_u64, 200, 400, 800, 1600, 3200, 5000, 5000];
    for (step, expected) in expected_delays.iter().enumerate() {
        let lost = coord.on_watcher_lost(InventorySource::Adb);
        assert_eq!(
            coord.source_health(InventorySource::Adb),
            SourceHealth::Unhealthy
        );
        // Other healthy sources are untouched.
        assert_eq!(
            coord.source_health(InventorySource::Ios),
            SourceHealth::Healthy
        );
        let Some((reconnect_id, delay)) =
            find_timer(&lost, TimerKind::Reconnect(InventorySource::Adb))
        else {
            panic!("step {step}: expected reconnect timer, got {lost:?}");
        };
        assert_eq!(delay, *expected);
        if step == 0 {
            // Only the unhealthy source gets a 4 s fallback timer.
            assert!(find_timer(&lost, TimerKind::Fallback(InventorySource::Adb)).is_some());
            assert!(find_timer(&lost, TimerKind::Fallback(InventorySource::Ios)).is_none());
        }
        // Duplicate loss before reconnect timer fires must NOT arm a concurrent reconnect.
        let dup = coord.on_watcher_lost(InventorySource::Adb);
        assert!(find_timer(&dup, TimerKind::Reconnect(InventorySource::Adb)).is_none());

        let fire = coord.on_timer_fired(reconnect_id);
        assert!(fire.contains(&CoordinatorAction::StartWatcher(InventorySource::Adb)));
    }

    // Reconnecting successfully resets backoff to 100 ms and reconciles.
    let ready = coord.on_watcher_ready(InventorySource::Adb, true);
    let Some((reconcile_read, ReadScope::All, false)) = find_read(&ready) else {
        panic!("expected reconcile read on reconnect");
    };
    let _ = coord.on_read_succeeded(reconcile_read, Inventory::default());
    assert_eq!(
        coord.source_health(InventorySource::Adb),
        SourceHealth::Healthy
    );

    let lost_again = coord.on_watcher_lost(InventorySource::Adb);
    let Some((_, reset_delay)) =
        find_timer(&lost_again, TimerKind::Reconnect(InventorySource::Adb))
    else {
        panic!("expected reset backoff timer");
    };
    assert_eq!(reset_delay, 100);
}

#[test]
fn liveness_reconcile_catches_silent_source_without_blaming_healthy_ones() {
    let mut coord = InventoryCoordinator::new(CoordinatorConfig {
        enable_ios: true,
        ..CoordinatorConfig::default()
    });
    let initial = Inventory {
        devices: vec![
            ios_device("1111", DeviceState::Shutdown),
            avd_device("Pixel_9", DeviceState::Shutdown, None),
        ],
        issues: vec![],
    };
    let liveness_id = make_all_healthy(&mut coord, initial);

    // 60 s liveness timer fires while all sources claim Healthy.
    let fire = coord.on_timer_fired(liveness_id);
    let Some((live_read, ReadScope::All, true)) = find_read(&fire) else {
        panic!("expected liveness full read, got {fire:?}");
    };

    // Suppose iOS booted silently without FSEvents firing, while Android stayed unchanged.
    let after = Inventory {
        devices: vec![
            ios_device("1111", DeviceState::Booted),
            avd_device("Pixel_9", DeviceState::Shutdown, None),
        ],
        issues: vec![],
    };
    let res = coord.on_read_succeeded(live_read, after);
    assert_eq!(
        coord.source_health(InventorySource::Ios),
        SourceHealth::Unhealthy
    );
    assert_eq!(
        coord.source_health(InventorySource::Adb),
        SourceHealth::Healthy
    );
    assert_eq!(
        coord.source_health(InventorySource::Avds),
        SourceHealth::Healthy
    );
    assert!(res.contains(&CoordinatorAction::StopWatcher(InventorySource::Ios)));
    assert!(find_timer(&res, TimerKind::Fallback(InventorySource::Ios)).is_some());
    assert!(find_timer(&res, TimerKind::Reconnect(InventorySource::Ios)).is_some());
    // Next 60 s liveness timer is re-armed.
    assert!(find_timer(&res, TimerKind::Liveness).is_some());
}

#[test]
fn diff_missed_sources_distinguishes_adb_from_avd_and_ios() {
    let shutdown_avd = Inventory {
        devices: vec![avd_device("Pixel_9", DeviceState::Shutdown, None)],
        issues: vec![],
    };
    let booted_avd = Inventory {
        devices: vec![avd_device(
            "Pixel_9",
            DeviceState::Booted,
            Some("emulator-5554"),
        )],
        issues: vec![],
    };
    // An existing AVD booting is an ADB transport change, NOT an AVD folder change.
    assert_eq!(
        diff_missed_sources(&shutdown_avd, &booted_avd),
        vec![InventorySource::Adb]
    );
    assert_eq!(
        diff_missed_sources(&booted_avd, &shutdown_avd),
        vec![InventorySource::Adb]
    );

    // Adding a new shutdown AVD is an AVD folder change, NOT an ADB change.
    let two_avds = Inventory {
        devices: vec![
            avd_device("Pixel_9", DeviceState::Shutdown, None),
            avd_device("Tablet", DeviceState::Shutdown, None),
        ],
        issues: vec![],
    };
    assert_eq!(
        diff_missed_sources(&shutdown_avd, &two_avds),
        vec![InventorySource::Avds]
    );

    // Plugging in a physical phone is an ADB change only.
    let with_phone = Inventory {
        devices: vec![
            avd_device("Pixel_9", DeviceState::Shutdown, None),
            physical_android("R5CT1234", DeviceState::Booted),
        ],
        issues: vec![],
    };
    assert_eq!(
        diff_missed_sources(&shutdown_avd, &with_phone),
        vec![InventorySource::Adb]
    );
}

#[test]
fn inventory_json_roundtrip_and_same_inventory_dedup() {
    let inv = Inventory {
        devices: vec![
            ios_device("2222", DeviceState::Booted),
            physical_android("ABC123", DeviceState::Unauthorized),
        ],
        issues: vec![sample_failure("simctl slow")],
    };
    let json = inv.to_json_string();
    let parsed_val = match ace_json::parse(&json) {
        Ok(v) => v,
        Err(err) => panic!("parse failed: {err}"),
    };
    let roundtrip = match Inventory::from_value(&parsed_val) {
        Ok(v) => v,
        Err(err) => panic!("from_value failed: {err}"),
    };
    assert!(same_inventory(&inv, &roundtrip));
    assert_eq!(inv, roundtrip);
}

#[test]
fn stopping_and_reopening_after_dropped_start_read_does_not_block_reconcile() {
    let mut coord = InventoryCoordinator::new(CoordinatorConfig {
        enable_ios: true,
        ..CoordinatorConfig::default()
    });
    let start1 = coord.set_active(true);
    let Some((read1, ReadScope::All, false)) = find_read(&start1) else {
        panic!("expected initial reconcile read, got {start1:?}");
    };
    assert!(coord.has_in_flight_reads());

    // Simulate view release while `read1` was queued in N-API and dropped by JS.
    let _stop = coord.set_active(false);
    assert!(!coord.has_in_flight_reads());

    // Reopening the view MUST immediately dispatch a fresh full reconcile read.
    let start2 = coord.set_active(true);
    let Some((read2, ReadScope::All, false)) = find_read(&start2) else {
        panic!("expected fresh reconcile read after reopen, got {start2:?}");
    };
    assert_ne!(read1, read2);

    // A stale completion or failure from the pre-stop read must not publish or break the active read.
    let stale_ok = coord.on_read_succeeded(
        read1,
        Inventory {
            devices: vec![ios_device("stale-0000", DeviceState::Booted)],
            issues: vec![],
        },
    );
    assert!(stale_ok.is_empty());
    assert!(coord.current().is_none());
    let stale = coord.on_read_failed(read1, sample_failure("stale"), "stale");
    assert!(stale.is_empty());
    assert!(coord.has_in_flight_reads());

    let done = coord.on_read_succeeded(
        read2,
        Inventory {
            devices: vec![ios_device("1111", DeviceState::Booted)],
            issues: vec![],
        },
    );
    assert!(
        done.iter()
            .any(|a| matches!(a, CoordinatorAction::Publish(_)))
    );
    assert!(!coord.has_in_flight_reads());

    // Calling on_read_cancelled for an already-stopped pre-stop read is a safe no-op,
    // and cancelling an active read clears in_flight and drains pending work.
    assert!(coord.on_read_cancelled(read1).is_empty());
    let trig = coord.on_source_trigger(InventorySource::Ios);
    let Some((deb_id, _)) = find_timer(&trig, TimerKind::Debounce(InventorySource::Ios)) else {
        panic!("expected debounce timer");
    };
    let Some((active_read, ReadScope::Source(InventorySource::Ios), false)) =
        find_read(&coord.on_timer_fired(deb_id))
    else {
        panic!("expected scoped Ios read");
    };
    assert!(coord.has_in_flight_reads());
    let cancelled = coord.on_read_cancelled(active_read);
    assert!(!coord.has_in_flight_reads());
    assert!(
        find_read(&cancelled).is_none()
            || matches!(find_read(&cancelled), Some((_, ReadScope::All, _)))
    );
}

#[test]
fn scoped_read_failure_while_healthy_drains_pending_liveness_reconcile_and_dirty_triggers() {
    // Case 1: liveness timer fires while a scoped read is in flight, then scoped read fails.
    let mut coord = InventoryCoordinator::new(CoordinatorConfig {
        enable_ios: true,
        ..CoordinatorConfig::default()
    });
    let liveness_id = make_all_healthy(&mut coord, Inventory::default());

    let trig = coord.on_source_trigger(InventorySource::Ios);
    let Some((deb_id, _)) = find_timer(&trig, TimerKind::Debounce(InventorySource::Ios)) else {
        panic!("expected debounce timer");
    };
    let fire = coord.on_timer_fired(deb_id);
    let Some((scoped_read, ReadScope::Source(InventorySource::Ios), false)) = find_read(&fire)
    else {
        panic!("expected scoped Ios read");
    };

    // 60 s liveness fires while scoped read is in flight; no read starts yet.
    assert!(find_read(&coord.on_timer_fired(liveness_id)).is_none());

    // Scoped read fails while watches are healthy -> pending liveness MUST drain!
    let failed = coord.on_read_failed(
        scoped_read,
        sample_failure("simctl hiccup"),
        "simctl hiccup",
    );
    let Some((live_read, ReadScope::All, true)) = find_read(&failed) else {
        panic!("expected pending liveness read to drain after scoped failure, got {failed:?}");
    };
    // If that liveness read also fails, it must re-arm 60 s liveness without spinning.
    let live_fail = coord.on_read_failed(live_read, sample_failure("simctl down"), "simctl down");
    assert!(find_read(&live_fail).is_none());
    assert!(find_timer(&live_fail, TimerKind::Liveness).is_some());

    // Case 2: queued reconnect reconcile drains after scoped read failure.
    let mut coord2 = InventoryCoordinator::new(CoordinatorConfig {
        enable_ios: true,
        ..CoordinatorConfig::default()
    });
    let _liveness2 = make_all_healthy(&mut coord2, Inventory::default());
    let trig2 = coord2.on_source_trigger(InventorySource::Ios);
    let Some((deb2, _)) = find_timer(&trig2, TimerKind::Debounce(InventorySource::Ios)) else {
        panic!("expected debounce timer");
    };
    let Some((scoped2, ReadScope::Source(InventorySource::Ios), false)) =
        find_read(&coord2.on_timer_fired(deb2))
    else {
        panic!("expected scoped Ios read");
    };
    // Adb reconnects while Ios read is in flight -> queues pending_reconcile.
    let _ = coord2.on_watcher_lost(InventorySource::Adb);
    let _ = coord2.on_watcher_ready(InventorySource::Adb, true);
    let failed2 = coord2.on_read_failed(scoped2, sample_failure("ios err"), "ios err");
    assert!(
        matches!(find_read(&failed2), Some((_, ReadScope::All, false))),
        "expected queued reconnect reconcile to drain after scoped failure, got {failed2:?}"
    );

    // Case 3: dirty trigger drains (arms debounce) after scoped read failure.
    let mut coord3 = InventoryCoordinator::new(CoordinatorConfig {
        enable_ios: true,
        ..CoordinatorConfig::default()
    });
    let _liveness3 = make_all_healthy(&mut coord3, Inventory::default());
    let trig3 = coord3.on_source_trigger(InventorySource::Ios);
    let Some((deb3, _)) = find_timer(&trig3, TimerKind::Debounce(InventorySource::Ios)) else {
        panic!("expected debounce timer");
    };
    let Some((scoped3, ReadScope::Source(InventorySource::Ios), false)) =
        find_read(&coord3.on_timer_fired(deb3))
    else {
        panic!("expected scoped Ios read");
    };
    // Another trigger arrives while scoped3 is running -> sets dirty.
    assert!(coord3.on_source_trigger(InventorySource::Ios).is_empty());
    let failed3 = coord3.on_read_failed(scoped3, sample_failure("ios err"), "ios err");
    assert!(
        find_timer(&failed3, TimerKind::Debounce(InventorySource::Ios)).is_some(),
        "expected dirty trigger to arm debounce after scoped failure, got {failed3:?}"
    );
}

#[tokio::test]
async fn real_adb_restart_and_folder_replacement_reconcile_missed_updates() {
    use crate::inventory::adb_track::{
        AdbServerStarter, AdbTrackConfig, AdbTrackEvent, TokioTrackClock, run_adb_track_once,
    };
    use crate::inventory::watch::{DirWatchEvent, start_dir_watch};
    use std::future::Future;
    use std::pin::Pin;
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio::sync::{mpsc, oneshot};
    use tokio_util::sync::CancellationToken;

    struct NoopStarter;
    impl AdbServerStarter for NoopStarter {
        fn start_server(
            &self,
            _adb_path: String,
            _env: Vec<(String, String)>,
            _timeout: Duration,
            _cancel: CancellationToken,
        ) -> Pin<Box<dyn Future<Output = Result<(), crate::error::DeviceError>> + Send>> {
            Box::pin(async { Ok(()) })
        }
    }

    async fn spawn_fake_adb(
        addr: std::net::SocketAddr,
        initial_frame: &'static str,
    ) -> (std::net::SocketAddr, oneshot::Sender<()>) {
        let Ok(listener) = TcpListener::bind(addr).await else {
            panic!("bind fake adb on {addr}");
        };
        let Ok(bound) = listener.local_addr() else {
            panic!("fake adb local_addr");
        };
        let (stop_tx, mut stop_rx) = oneshot::channel::<()>();
        tokio::spawn(async move {
            tokio::select! {
                _ = &mut stop_rx => {}
                accepted = listener.accept() => {
                    if let Ok((mut sock, _)) = accepted {
                        let mut req = [0u8; 24];
                        if sock.read_exact(&mut req).await.is_ok() {
                            let msg = format!("OKAY{:04x}{initial_frame}", initial_frame.len());
                            let _ = sock.write_all(msg.as_bytes()).await;
                            let _ = stop_rx.await;
                        }
                    }
                }
            }
        });
        (bound, stop_tx)
    }

    // Shared truth for both ADB transports and real AVD .ini files on disk.
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let root = std::env::temp_dir().join(format!(
        "ace-devices-restart-{}-{nanos}",
        std::process::id()
    ));
    let avd_dir = root.join("avd");
    assert!(std::fs::create_dir_all(&avd_dir).is_ok());
    assert!(std::fs::write(avd_dir.join("Pixel_8.ini"), b"path=Pixel_8.avd\n").is_ok());

    let adb_devices: Arc<Mutex<Vec<AppDevice>>> = Arc::new(Mutex::new(Vec::new()));
    let read_real_inventory = |adb_state: &Arc<Mutex<Vec<AppDevice>>>, dir: &std::path::Path| {
        let mut devices = adb_state.lock().map(|g| g.clone()).unwrap_or_default();
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|s| s.to_str()) == Some("ini")
                    && let Some(stem) = path.file_stem().and_then(|s| s.to_str())
                {
                    devices.push(avd_device(stem, DeviceState::Shutdown, None));
                }
            }
        }
        Inventory {
            devices,
            issues: vec![],
        }
    };

    let mut coord = InventoryCoordinator::new(CoordinatorConfig {
        enable_ios: false,
        ..CoordinatorConfig::default()
    });
    let start_actions = coord.set_active(true);
    let Some((init_read, ReadScope::All, false)) = find_read(&start_actions) else {
        panic!("expected initial reconcile read");
    };
    let _ = coord.on_read_succeeded(init_read, read_real_inventory(&adb_devices, &avd_dir));

    // --- Part 1: Real ADB loopback server restart loses connection while a new phone plugs in ---
    let (addr, stop_adb1) =
        spawn_fake_adb(std::net::SocketAddr::from(([127, 0, 0, 1], 0)), "").await;
    let (adb_tx1, mut adb_rx1) = mpsc::unbounded_channel();
    let cancel1 = CancellationToken::new();
    let track1 = tokio::spawn(run_adb_track_once(
        AdbTrackConfig::loopback(addr.port(), None, vec![]),
        Arc::new(NoopStarter),
        Arc::new(TokioTrackClock),
        adb_tx1,
        cancel1.clone(),
    ));
    let conn1 = tokio::time::timeout(Duration::from_secs(3), adb_rx1.recv()).await;
    assert_eq!(conn1, Ok(Some(AdbTrackEvent::Connected)));
    let ready1 = coord.on_watcher_ready(InventorySource::Adb, true);
    let Some((rec1, ReadScope::All, false)) = find_read(&ready1) else {
        panic!("expected reconcile read when ADB connects");
    };
    let _ = coord.on_read_succeeded(rec1, read_real_inventory(&adb_devices, &avd_dir));
    assert_eq!(
        coord.source_health(InventorySource::Adb),
        SourceHealth::Healthy
    );

    // Kill fake ADB server #1 -> track loop must emit Disconnected.
    let _ = stop_adb1.send(());
    let _ = track1.await;
    let mut saw_disconnect = false;
    while let Ok(ev) = adb_rx1.try_recv() {
        if matches!(ev, AdbTrackEvent::Disconnected(_)) {
            saw_disconnect = true;
        }
    }
    assert!(
        saw_disconnect,
        "expected real Disconnected after ADB server exit"
    );

    let lost_adb = coord.on_watcher_lost(InventorySource::Adb);
    assert_eq!(
        coord.source_health(InventorySource::Adb),
        SourceHealth::Unhealthy
    );
    let Some((reconnect_adb, _)) =
        find_timer(&lost_adb, TimerKind::Reconnect(InventorySource::Adb))
    else {
        panic!("expected ADB reconnect timer");
    };

    // Mutate real device state WHILE ADB server is down (no track event can be received!).
    if let Ok(mut list) = adb_devices.lock() {
        list.push(physical_android("R58M999", DeviceState::Booted));
    }

    // Start fake ADB server #2 on the same port and fire coordinator's reconnect timer.
    let (_addr2, stop_adb2) = spawn_fake_adb(addr, "R58M999 device\n").await;
    let fire_adb = coord.on_timer_fired(reconnect_adb);
    assert!(fire_adb.contains(&CoordinatorAction::StartWatcher(InventorySource::Adb)));

    let (adb_tx2, mut adb_rx2) = mpsc::unbounded_channel();
    let cancel2 = CancellationToken::new();
    let track2 = tokio::spawn(run_adb_track_once(
        AdbTrackConfig::loopback(addr.port(), None, vec![]),
        Arc::new(NoopStarter),
        Arc::new(TokioTrackClock),
        adb_tx2,
        cancel2.clone(),
    ));
    let conn2 = tokio::time::timeout(Duration::from_secs(3), adb_rx2.recv()).await;
    assert_eq!(conn2, Ok(Some(AdbTrackEvent::Connected)));

    let ready2 = coord.on_watcher_ready(InventorySource::Adb, true);
    let Some((rec2, ReadScope::All, false, inv_adb2)) = find_read_full(&ready2) else {
        panic!("expected full reconcile read on ADB reconnect");
    };
    assert!(
        inv_adb2,
        "real ADB restart reconcile must invalidate cached serial->AVD names"
    );
    let pub_adb = coord.on_read_succeeded(rec2, read_real_inventory(&adb_devices, &avd_dir));
    assert_eq!(
        coord.source_health(InventorySource::Adb),
        SourceHealth::Healthy
    );
    assert!(
        pub_adb.iter().any(|a| matches!(
            a,
            CoordinatorAction::Publish(inv)
                if inv.devices.iter().any(|d| d.id == "android:R58M999")
        )),
        "missed update across real ADB restart was not published: {pub_adb:?}"
    );
    cancel2.cancel();
    let _ = stop_adb2.send(());
    let _ = track2.await;

    // --- Part 2: Real AVD directory deletion & replacement reconciles new AVD ---
    let (fs_tx1, mut fs_rx1) = mpsc::unbounded_channel();
    let Ok(watch1) = start_dir_watch(&avd_dir, fs_tx1) else {
        let _ = std::fs::remove_dir_all(&root);
        panic!("start_dir_watch #1");
    };
    assert!(watch1.is_on_target());
    let ready_avd1 = coord.on_watcher_ready(InventorySource::Avds, true);
    let Some((rec_avd1, ReadScope::All, false)) = find_read(&ready_avd1) else {
        let _ = std::fs::remove_dir_all(&root);
        panic!("expected reconcile read for AVDs");
    };
    let _ = coord.on_read_succeeded(rec_avd1, read_real_inventory(&adb_devices, &avd_dir));
    assert_eq!(
        coord.source_health(InventorySource::Avds),
        SourceHealth::Healthy
    );

    // Delete the watched AVD directory -> real notify watch emits RestartNeeded.
    assert!(std::fs::remove_dir_all(&avd_dir).is_ok());
    let mut saw_restart = false;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while tokio::time::Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        match tokio::time::timeout(remaining, fs_rx1.recv()).await {
            Ok(Some(DirWatchEvent::RestartNeeded(_))) => {
                saw_restart = true;
                break;
            }
            Ok(Some(DirWatchEvent::Changed)) => continue,
            _ => break,
        }
    }
    drop(watch1);
    assert!(
        saw_restart,
        "expected real DirWatchEvent::RestartNeeded on folder removal"
    );

    let lost_avd = coord.on_watcher_lost(InventorySource::Avds);
    assert_eq!(
        coord.source_health(InventorySource::Avds),
        SourceHealth::Unhealthy
    );
    let Some((reconnect_avd, _)) =
        find_timer(&lost_avd, TimerKind::Reconnect(InventorySource::Avds))
    else {
        let _ = std::fs::remove_dir_all(&root);
        panic!("expected AVD reconnect timer");
    };

    // Recreate AVD directory with a brand-new AVD while watcher is down.
    assert!(std::fs::create_dir_all(&avd_dir).is_ok());
    assert!(std::fs::write(avd_dir.join("Pixel_9.ini"), b"path=Pixel_9.avd\n").is_ok());

    let fire_avd = coord.on_timer_fired(reconnect_avd);
    assert!(fire_avd.contains(&CoordinatorAction::StartWatcher(InventorySource::Avds)));
    let (fs_tx2, _fs_rx2) = mpsc::unbounded_channel();
    let Ok(watch2) = start_dir_watch(&avd_dir, fs_tx2) else {
        let _ = std::fs::remove_dir_all(&root);
        panic!("start_dir_watch #2");
    };
    assert!(watch2.is_on_target());

    let ready_avd2 = coord.on_watcher_ready(InventorySource::Avds, true);
    let Some((rec_avd2, ReadScope::All, false)) = find_read(&ready_avd2) else {
        drop(watch2);
        let _ = std::fs::remove_dir_all(&root);
        panic!("expected full reconcile read on AVD watcher restart");
    };
    let pub_avd = coord.on_read_succeeded(rec_avd2, read_real_inventory(&adb_devices, &avd_dir));
    assert_eq!(
        coord.source_health(InventorySource::Avds),
        SourceHealth::Healthy
    );
    assert!(
        pub_avd.iter().any(|a| matches!(
            a,
            CoordinatorAction::Publish(inv)
                if inv.devices.iter().any(|d| d.id == "android:Pixel_9")
                    && !inv.devices.iter().any(|d| d.id == "android:Pixel_8")
        )),
        "missed folder-replacement update was not published: {pub_avd:?}"
    );

    drop(watch2);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn adb_restart_and_liveness_request_adb_identity_cache_invalidation() {
    let mut coord = InventoryCoordinator::new(CoordinatorConfig {
        enable_ios: true,
        ..CoordinatorConfig::default()
    });
    let liveness_id = make_all_healthy(&mut coord, Inventory::default());

    // Normal healthy ADB trigger keeps cached per-serial AVD names.
    let trig = coord.on_source_trigger(InventorySource::Adb);
    let Some((deb, _)) = find_timer(&trig, TimerKind::Debounce(InventorySource::Adb)) else {
        panic!("expected debounce timer");
    };
    let Some((r_healthy, ReadScope::Source(InventorySource::Adb), false, inv_healthy)) =
        find_read_full(&coord.on_timer_fired(deb))
    else {
        panic!("expected healthy scoped ADB read");
    };
    assert!(
        !inv_healthy,
        "healthy ADB trigger should not invalidate cache"
    );
    let _ = coord.on_read_succeeded(r_healthy, Inventory::default());

    // ADB disconnects and reconnects -> reconcile read MUST request cache invalidation.
    let lost = coord.on_watcher_lost(InventorySource::Adb);
    let Some((fb_id, _)) = find_timer(&lost, TimerKind::Fallback(InventorySource::Adb)) else {
        panic!("expected fallback timer on ADB loss");
    };
    let ready = coord.on_watcher_ready(InventorySource::Adb, true);
    let Some((r_rec1, ReadScope::All, false, inv_rec1)) = find_read_full(&ready) else {
        panic!("expected reconnect reconcile read");
    };
    assert!(
        inv_rec1,
        "ADB reconnect reconcile must invalidate cached serial->AVD names"
    );

    // If that reconcile fails, the existing 4 s fallback retry MUST STILL request cache invalidation.
    let _fail = coord.on_read_failed(r_rec1, sample_failure("adb busy"), "adb busy");
    let Some((r_rec2, ReadScope::All, false, inv_rec2)) =
        find_read_full(&coord.on_timer_fired(fb_id))
    else {
        panic!("expected fallback reconcile read");
    };
    assert!(
        inv_rec2,
        "retry after failed reconnect reconcile must still invalidate cache"
    );

    // Once reconcile succeeds, normal healthy ADB triggers stop invalidating.
    let _ = coord.on_read_succeeded(r_rec2, Inventory::default());
    let trig2 = coord.on_source_trigger(InventorySource::Adb);
    let Some((deb2, _)) = find_timer(&trig2, TimerKind::Debounce(InventorySource::Adb)) else {
        panic!("expected debounce timer");
    };
    let Some((r_healthy2, ReadScope::Source(InventorySource::Adb), false, inv_healthy2)) =
        find_read_full(&coord.on_timer_fired(deb2))
    else {
        panic!("expected healthy scoped ADB read after recovery");
    };
    assert!(
        !inv_healthy2,
        "post-recovery healthy ADB trigger should keep cache"
    );
    let _ = coord.on_read_succeeded(r_healthy2, Inventory::default());

    // 60 s liveness reconcile also requests cache invalidation so swapped AVDs on the same serial are caught.
    let Some((_r_live, ReadScope::All, true, inv_live)) =
        find_read_full(&coord.on_timer_fired(liveness_id))
    else {
        panic!("expected liveness read");
    };
    assert!(
        inv_live,
        "60 s liveness reconcile must invalidate cached serial->AVD names"
    );
}
