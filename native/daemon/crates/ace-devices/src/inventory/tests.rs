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
        } => Some((*read_id, *scope, *liveness)),
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
