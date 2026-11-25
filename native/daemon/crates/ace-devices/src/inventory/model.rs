// SPDX-License-Identifier: Apache-2.0

//! Shared data model, equality, and liveness diff helpers for device inventory (D2).

use crate::error::{DeviceError, DeviceFailure, DevicePlatformKind};
use crate::inventory::adb_transports::DeviceState;
use crate::inventory::android::AppDevice;
use ace_json::{JsString, Value};
use std::collections::HashSet;

/// Default fallback read interval while a source is unhealthy (`inventory.ts`, D2).
pub const DEFAULT_FALLBACK_INTERVAL_MS: u64 = 4_000;
/// Debounce window for trigger-driven reads (D2).
pub const DEBOUNCE_MS: u64 = 250;
/// Independent liveness reconcile cadence while viewed (D2).
pub const LIVENESS_RECONCILE_MS: u64 = 60_000;
/// Initial reconnect backoff for dead sources (D2).
pub const BACKOFF_INITIAL_MS: u64 = 100;
/// Maximum reconnect backoff for dead sources (D2).
pub const BACKOFF_MAX_MS: u64 = 5_000;
/// Maximum simultaneous inventory listeners (`inventory.ts:77`).
pub const MAX_SUBSCRIBERS: usize = 64;

/// One inventory snapshot (`inventory.ts:12`, `packages/protocol/src/devices.ts:118`).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Inventory {
    pub devices: Vec<AppDevice>,
    pub issues: Vec<DeviceFailure>,
}

impl Inventory {
    /// Serializes via `ace-json` in `DeviceInventory` schema key order (`devices`, `issues`).
    pub fn to_json_string(&self) -> String {
        let mut out = String::new();
        out.push_str("{\"devices\":[");
        for (idx, device) in self.devices.iter().enumerate() {
            if idx > 0 {
                out.push(',');
            }
            device.write_json(&mut out);
        }
        out.push_str("],\"issues\":[");
        for (idx, issue) in self.issues.iter().enumerate() {
            if idx > 0 {
                out.push(',');
            }
            issue.write_json(&mut out);
        }
        out.push_str("]}");
        out
    }

    /// Parses an `Inventory` from an `ace_json::Value`.
    pub fn from_value(value: &Value) -> Result<Self, DeviceError> {
        let obj = value
            .as_object()
            .ok_or_else(|| DeviceError::InvalidInput("Inventory must be an object".into()))?;
        let devices_arr = obj
            .get("devices")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                DeviceError::InvalidInput("Inventory.devices must be an array".into())
            })?;
        let mut devices = Vec::with_capacity(devices_arr.len());
        for item in devices_arr {
            devices.push(AppDevice::from_value(item)?);
        }
        let issues_arr = obj
            .get("issues")
            .and_then(Value::as_array)
            .ok_or_else(|| DeviceError::InvalidInput("Inventory.issues must be an array".into()))?;
        let mut issues = Vec::with_capacity(issues_arr.len());
        for item in issues_arr {
            issues.push(DeviceFailure::from_value(item)?);
        }
        Ok(Self { devices, issues })
    }
}

/// Device equality matching `inventory.ts:14-23` (plus platform check).
pub fn same_device(a: &AppDevice, b: &AppDevice) -> bool {
    a.id == b.id
        && a.platform == b.platform
        && a.name == b.name
        && a.state == b.state
        && a.runtime == b.runtime
        && a.serial == b.serial
        && a.model == b.model
}

/// Inventory equality matching `inventory.ts:25-35`.
pub fn same_inventory(a: &Inventory, b: &Inventory) -> bool {
    a.devices.len() == b.devices.len()
        && a.devices
            .iter()
            .zip(b.devices.iter())
            .all(|(x, y)| same_device(x, y))
        && a.issues.len() == b.issues.len()
        && a.issues
            .iter()
            .zip(b.issues.iter())
            .all(|(x, y)| x.message == y.message)
}

/// The three inventory trigger sources (D2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum InventorySource {
    Adb = 0,
    Avds = 1,
    Ios = 2,
}

impl InventorySource {
    pub const ALL: [Self; 3] = [Self::Adb, Self::Avds, Self::Ios];

    pub fn index(self) -> usize {
        self as usize
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Adb => "adb",
            Self::Avds => "avds",
            Self::Ios => "ios",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "adb" => Some(Self::Adb),
            "avds" => Some(Self::Avds),
            "ios" => Some(Self::Ios),
            _ => None,
        }
    }
}

/// Health state of one inventory source.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceHealth {
    /// Not running (no view holds the inventory, or disabled on this platform).
    Stopped,
    /// Watcher/track failed, disconnected, missing target folder, or caught silent; uses 4 s fallback.
    Unhealthy,
    /// Watcher/track is up on its target; awaiting a reconcile read that started after it came up.
    Reconciling,
    /// Watcher/track is up and reconciled; trigger-driven with no 4 s fallback.
    Healthy,
}

/// Which list(s) a read command covers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadScope {
    All,
    Source(InventorySource),
}

impl ReadScope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::All => "all",
            Self::Source(s) => s.as_str(),
        }
    }
}

/// Timers managed by the coordinator and executed by the injected timer shell.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TimerKind {
    Debounce(InventorySource),
    Fallback(InventorySource),
    Reconnect(InventorySource),
    Liveness,
}

/// Side effects emitted synchronously by `InventoryCoordinator`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CoordinatorAction {
    StartWatcher(InventorySource),
    StopWatcher(InventorySource),
    ArmTimer {
        id: u64,
        kind: TimerKind,
        delay_ms: u64,
    },
    CancelTimer {
        id: u64,
    },
    StartRead {
        read_id: u64,
        scope: ReadScope,
        liveness: bool,
    },
    Publish(Inventory),
    LogWarn {
        message: String,
        detail: String,
    },
}

/// Configuration for `InventoryCoordinator`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CoordinatorConfig {
    /// Whether iOS Simulators exist on this host (`platform == "darwin"`).
    pub enable_ios: bool,
    /// Fallback interval while a source is unhealthy (default 4,000 ms).
    pub fallback_interval_ms: u64,
    /// Trigger debounce delay (default 250 ms).
    pub debounce_ms: u64,
    /// Liveness reconcile cadence (default 60,000 ms).
    pub liveness_interval_ms: u64,
}

impl Default for CoordinatorConfig {
    fn default() -> Self {
        Self {
            enable_ios: false,
            fallback_interval_ms: DEFAULT_FALLBACK_INTERVAL_MS,
            debounce_ms: DEBOUNCE_MS,
            liveness_interval_ms: LIVENESS_RECONCILE_MS,
        }
    }
}

/// Identifies which trigger source(s) missed a change detected by a 60 s liveness reconcile.
pub fn diff_missed_sources(before: &Inventory, after: &Inventory) -> Vec<InventorySource> {
    let mut missed = Vec::new();

    // iOS: any change in iOS devices.
    let ios_before: Vec<&AppDevice> = before
        .devices
        .iter()
        .filter(|d| d.platform == DevicePlatformKind::Ios)
        .collect();
    let ios_after: Vec<&AppDevice> = after
        .devices
        .iter()
        .filter(|d| d.platform == DevicePlatformKind::Ios)
        .collect();
    let ios_changed = ios_before.len() != ios_after.len()
        || ios_before
            .iter()
            .zip(ios_after.iter())
            .any(|(a, b)| !same_device(a, b));
    if ios_changed {
        missed.push(InventorySource::Ios);
    }

    // ADB: any change in connected Android transports (devices with serial or non-shutdown state).
    let adb_before: Vec<&AppDevice> = before
        .devices
        .iter()
        .filter(|d| {
            d.platform == DevicePlatformKind::Android
                && (d.serial.is_some() || d.state != DeviceState::Shutdown)
        })
        .collect();
    let adb_after: Vec<&AppDevice> = after
        .devices
        .iter()
        .filter(|d| {
            d.platform == DevicePlatformKind::Android
                && (d.serial.is_some() || d.state != DeviceState::Shutdown)
        })
        .collect();
    let adb_changed = adb_before.len() != adb_after.len()
        || adb_before
            .iter()
            .zip(adb_after.iter())
            .any(|(a, b)| !same_device(a, b));
    if adb_changed {
        missed.push(InventorySource::Adb);
    }

    // AVDs: any installed AVD added or removed (shutdown/no-serial Android device whose id wasn't in the other snapshot).
    let all_android_before: HashSet<&JsString> = before
        .devices
        .iter()
        .filter(|d| d.platform == DevicePlatformKind::Android)
        .map(|d| &d.id)
        .collect();
    let all_android_after: HashSet<&JsString> = after
        .devices
        .iter()
        .filter(|d| d.platform == DevicePlatformKind::Android)
        .map(|d| &d.id)
        .collect();
    let avd_added = after.devices.iter().any(|d| {
        d.platform == DevicePlatformKind::Android
            && d.serial.is_none()
            && d.state == DeviceState::Shutdown
            && !all_android_before.contains(&d.id)
    });
    let avd_removed = before.devices.iter().any(|d| {
        d.platform == DevicePlatformKind::Android
            && d.serial.is_none()
            && d.state == DeviceState::Shutdown
            && !all_android_after.contains(&d.id)
    });
    if avd_added || avd_removed {
        missed.push(InventorySource::Avds);
    }

    missed
}
