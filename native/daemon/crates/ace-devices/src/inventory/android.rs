// SPDX-License-Identifier: Apache-2.0
//! Merges installed AVDs, running emulators, and USB/network Android devices
//! into one insertion-ordered inventory keyed by device id
//! (ports `packages/devices/src/android-inventory.ts`).

use crate::error::{DeviceError, DevicePlatformKind};
use crate::inventory::adb_transports::{
    AdbBlock, AdbTransport, AdbTransportKind, DeviceState, blocked_error, physical_id_part,
    physical_name,
};
use ace_json::{JsString, ObjectWriter, Value};
use std::collections::HashMap;

/// Wire `AppDevice` (`packages/protocol/src/devices.ts:20-32`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppDevice {
    pub id: JsString,
    pub platform: DevicePlatformKind,
    pub name: JsString,
    pub state: DeviceState,
    pub runtime: Option<JsString>,
    pub serial: Option<JsString>,
    pub model: Option<JsString>,
}

impl AppDevice {
    /// Serializes via `ace-json` in exact `AppDevice` schema key order:
    /// `id`, `platform`, `name`, `state`, `runtime`?, `serial`?, `model`?.
    pub fn write_json(&self, out: &mut String) {
        let mut obj = ObjectWriter::new(out);
        obj.value("id", &Value::String(self.id.clone()));
        obj.str("platform", self.platform.as_str());
        obj.value("name", &Value::String(self.name.clone()));
        obj.str("state", self.state.as_str());
        if let Some(runtime) = &self.runtime {
            obj.value("runtime", &Value::String(runtime.clone()));
        }
        if let Some(serial) = &self.serial {
            obj.value("serial", &Value::String(serial.clone()));
        }
        if let Some(model) = &self.model {
            obj.value("model", &Value::String(model.clone()));
        }
        obj.finish();
    }

    /// Parses an `AppDevice` from an `ace_json::Value`.
    pub fn from_value(value: &Value) -> Result<Self, DeviceError> {
        let obj = value
            .as_object()
            .ok_or_else(|| DeviceError::InvalidInput("AppDevice must be an object".into()))?;
        let id = obj
            .get("id")
            .and_then(Value::as_js_str)
            .cloned()
            .ok_or_else(|| DeviceError::InvalidInput("AppDevice.id missing".into()))?;
        let platform_str = obj
            .get("platform")
            .and_then(Value::as_str)
            .ok_or_else(|| DeviceError::InvalidInput("AppDevice.platform missing".into()))?;
        let platform = DevicePlatformKind::parse(platform_str).ok_or_else(|| {
            DeviceError::InvalidInput(format!("unknown AppDevice.platform: {platform_str}"))
        })?;
        let name = obj
            .get("name")
            .and_then(Value::as_js_str)
            .cloned()
            .ok_or_else(|| DeviceError::InvalidInput("AppDevice.name missing".into()))?;
        let state_str = obj
            .get("state")
            .and_then(Value::as_str)
            .ok_or_else(|| DeviceError::InvalidInput("AppDevice.state missing".into()))?;
        let state = DeviceState::parse(state_str).ok_or_else(|| {
            DeviceError::InvalidInput(format!("unknown AppDevice.state: {state_str}"))
        })?;
        let runtime = opt_js_str(obj.get("runtime"), "AppDevice.runtime")?;
        let serial = opt_js_str(obj.get("serial"), "AppDevice.serial")?;
        let model = opt_js_str(obj.get("model"), "AppDevice.model")?;
        Ok(Self {
            id,
            platform,
            name,
            state,
            runtime,
            serial,
            model,
        })
    }
}

fn opt_js_str(value: Option<&Value>, field: &str) -> Result<Option<JsString>, DeviceError> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(v) => v
            .as_js_str()
            .cloned()
            .map(Some)
            .ok_or_else(|| DeviceError::InvalidInput(format!("{field} must be string"))),
    }
}

/// A phone's or network device's `ro.serialno` and Android release (`android-inventory.ts:6`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceHardware {
    pub serialno: JsString,
    pub release: Option<JsString>,
}

/// A running Android emulator input (`android-inventory.ts:24`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmulatorEntry {
    pub serial: JsString,
    pub state: DeviceState,
    pub name: JsString,
}

/// Summary of how a listed Android device is reached (`android-inventory.ts:11`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TransportMeta {
    pub kind: AdbTransportKind,
    pub block: Option<AdbBlock>,
}

/// Input to [`android_inventory`] (`android-inventory.ts:22-28`).
#[derive(Debug, Clone)]
pub struct AndroidInventoryInput {
    pub avds: Vec<JsString>,
    pub emulators: Vec<EmulatorEntry>,
    pub physical: Vec<AdbTransport>,
    pub hardware: HashMap<JsString, DeviceHardware>,
    pub platform: String,
}

/// Merged Android device list and transport metadata (`android-inventory.ts:9-16`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AndroidInventory {
    pub devices: Vec<AppDevice>,
    pub transports: Vec<(JsString, TransportMeta)>,
    pub blocked: Vec<DeviceError>,
    pub duplicate: bool,
}

impl AndroidInventory {
    /// Serializes with `ace-json` for the TypeScript shell (`devices`, `transports`, `blocked`, `duplicate`).
    pub fn to_json_string(&self) -> String {
        let mut out = String::new();
        out.push_str("{\"devices\":[");
        for (idx, device) in self.devices.iter().enumerate() {
            if idx > 0 {
                out.push(',');
            }
            device.write_json(&mut out);
        }
        out.push_str("],\"transports\":[");
        for (idx, (id, meta)) in self.transports.iter().enumerate() {
            if idx > 0 {
                out.push(',');
            }
            let mut entry = ObjectWriter::new(&mut out);
            entry.value("id", &Value::String(id.clone()));
            entry.str("kind", meta.kind.as_str());
            if let Some(block) = meta.block {
                entry.str("block", block.as_str());
            }
            entry.finish();
        }
        out.push_str("],\"blocked\":[");
        for (idx, err) in self.blocked.iter().enumerate() {
            if idx > 0 {
                out.push(',');
            }
            err.to_failure(None).write_json(&mut out);
        }
        out.push_str("],\"duplicate\":");
        out.push_str(if self.duplicate { "true" } else { "false" });
        out.push('}');
        out
    }
}

/// Small insertion-ordered map matching JavaScript `Map` iteration semantics.
struct OrderedMap<K: Eq + std::hash::Hash + Clone, V> {
    index: HashMap<K, usize>,
    entries: Vec<(K, V)>,
}

impl<K: Eq + std::hash::Hash + Clone, V> OrderedMap<K, V> {
    fn new() -> Self {
        Self {
            index: HashMap::new(),
            entries: Vec::new(),
        }
    }

    fn get(&self, key: &K) -> Option<&V> {
        self.index
            .get(key)
            .and_then(|&idx| self.entries.get(idx))
            .map(|(_, v)| v)
    }

    fn contains_key(&self, key: &K) -> bool {
        self.index.contains_key(key)
    }

    fn insert(&mut self, key: K, value: V) {
        if let Some(&idx) = self.index.get(&key) {
            if let Some(slot) = self.entries.get_mut(idx) {
                slot.1 = value;
            }
        } else {
            let idx = self.entries.len();
            self.index.insert(key.clone(), idx);
            self.entries.push((key, value));
        }
    }

    fn into_entries(self) -> Vec<(K, V)> {
        self.entries
    }

    fn into_values(self) -> Vec<V> {
        self.entries.into_iter().map(|(_, v)| v).collect()
    }
}

fn prefixed_android(part: &JsString) -> JsString {
    let mut id = JsString::from("android:");
    id.push_js(part);
    id
}

/// Merges installed AVDs, emulators, and physical/network devices (`android-inventory.ts:22-72`).
pub fn android_inventory(input: &AndroidInventoryInput) -> AndroidInventory {
    let mut devices: OrderedMap<JsString, AppDevice> = OrderedMap::new();
    let mut transports: OrderedMap<JsString, TransportMeta> = OrderedMap::new();

    for name in &input.avds {
        let id = prefixed_android(name);
        devices.insert(
            id.clone(),
            AppDevice {
                id: id.clone(),
                platform: DevicePlatformKind::Android,
                name: name.clone(),
                state: DeviceState::Shutdown,
                runtime: None,
                serial: None,
                model: None,
            },
        );
        transports.insert(
            id,
            TransportMeta {
                kind: AdbTransportKind::Emulator,
                block: None,
            },
        );
    }

    let mut duplicate = false;
    for emu in &input.emulators {
        let id = prefixed_android(&emu.name);
        if let Some(existing) = devices.get(&id)
            && let Some(existing_serial) = &existing.serial
            && !existing_serial.is_empty()
            && existing_serial != &emu.serial
        {
            duplicate = true;
            let mut updated = existing.clone();
            updated.state = DeviceState::Offline;
            devices.insert(id, updated);
            continue;
        }
        devices.insert(
            id.clone(),
            AppDevice {
                id: id.clone(),
                platform: DevicePlatformKind::Android,
                name: emu.name.clone(),
                state: emu.state,
                runtime: None,
                serial: Some(emu.serial.clone()),
                model: None,
            },
        );
        transports.insert(
            id,
            TransportMeta {
                kind: AdbTransportKind::Emulator,
                block: None,
            },
        );
    }

    let mut blocked: OrderedMap<AdbBlock, DeviceError> = OrderedMap::new();
    for transport in &input.physical {
        let hw = input.hardware.get(&transport.serial);
        let id_part = physical_id_part(
            &transport.serial,
            transport.usb.as_ref(),
            hw.map(|h| &h.serialno),
        );
        let id = prefixed_android(&id_part);
        if let Some(existing) = devices.get(&id) {
            let existing_kind = transports.get(&id).map(|meta| meta.kind);
            if !preferred(transport, existing, existing_kind) {
                continue;
            }
        }
        let name = physical_name(transport);
        let runtime = hw
            .and_then(|h| h.release.as_ref())
            .filter(|r| !r.is_empty())
            .map(|r| {
                let mut rt = JsString::from("Android ");
                rt.push_js(r);
                rt
            });
        devices.insert(
            id.clone(),
            AppDevice {
                id: id.clone(),
                platform: DevicePlatformKind::Android,
                name: name.clone(),
                state: transport.state,
                runtime,
                serial: Some(transport.serial.clone()),
                model: None,
            },
        );
        transports.insert(
            id,
            TransportMeta {
                kind: transport.kind,
                block: transport.block,
            },
        );
        if let Some(block) = transport.block
            && !blocked.contains_key(&block)
        {
            blocked.insert(
                block,
                blocked_error(transport.kind, transport.block, &name, &input.platform),
            );
        }
    }

    AndroidInventory {
        devices: devices.into_values(),
        transports: transports.into_entries(),
        blocked: blocked.into_values(),
        duplicate,
    }
}

/// Whether `transport` replaces an already-listed entry for the same phone (`android-inventory.ts:75-84`).
fn preferred(
    transport: &AdbTransport,
    existing: &AppDevice,
    existing_kind: Option<AdbTransportKind>,
) -> bool {
    if existing_kind == Some(AdbTransportKind::Emulator) {
        return false;
    }
    if transport.state == DeviceState::Booted && existing.state != DeviceState::Booted {
        return true;
    }
    if transport.state != DeviceState::Booted && existing.state == DeviceState::Booted {
        return false;
    }
    transport.kind == AdbTransportKind::Usb && existing_kind != Some(AdbTransportKind::Usb)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::DeviceErrorCode;

    #[test]
    fn duplicate_emulators_mark_avd_offline_and_preserve_avd_order() {
        let result = android_inventory(&AndroidInventoryInput {
            avds: vec![JsString::from("Pixel"), JsString::from("Tablet")],
            emulators: vec![
                EmulatorEntry {
                    serial: JsString::from("emulator-5554"),
                    state: DeviceState::Booted,
                    name: JsString::from("Pixel"),
                },
                EmulatorEntry {
                    serial: JsString::from("emulator-5556"),
                    state: DeviceState::Booted,
                    name: JsString::from("Pixel"),
                },
            ],
            physical: vec![],
            hardware: HashMap::new(),
            platform: "linux".into(),
        });
        assert!(result.duplicate);
        assert_eq!(result.devices.len(), 2);
        assert_eq!(result.devices[0].id, JsString::from("android:Pixel"));
        assert_eq!(result.devices[0].state, DeviceState::Offline);
        assert_eq!(result.devices[1].id, JsString::from("android:Tablet"));
        assert_eq!(result.devices[1].state, DeviceState::Shutdown);
    }

    #[test]
    fn phone_on_wifi_and_usb_prefers_usb_when_both_booted_and_deduplicates() {
        let mut hardware = HashMap::new();
        hardware.insert(
            JsString::from("adb-R58M-x._adb-tls-connect._tcp"),
            DeviceHardware {
                serialno: JsString::from("R58M123ABC"),
                release: Some(JsString::from("14")),
            },
        );
        hardware.insert(
            JsString::from("R58M123ABC"),
            DeviceHardware {
                serialno: JsString::from("R58M123ABC"),
                release: Some(JsString::from("14")),
            },
        );
        let result = android_inventory(&AndroidInventoryInput {
            avds: vec![],
            emulators: vec![],
            physical: vec![
                AdbTransport {
                    serial: JsString::from("adb-R58M-x._adb-tls-connect._tcp"),
                    kind: AdbTransportKind::Network,
                    state: DeviceState::Booted,
                    block: None,
                    model: Some(JsString::from("SM G973F")),
                    usb: None,
                },
                AdbTransport {
                    serial: JsString::from("R58M123ABC"),
                    kind: AdbTransportKind::Usb,
                    state: DeviceState::Booted,
                    block: None,
                    model: Some(JsString::from("SM G973F")),
                    usb: Some(JsString::from("1-1")),
                },
            ],
            hardware,
            platform: "linux".into(),
        });
        assert_eq!(result.devices.len(), 1);
        assert_eq!(result.devices[0].id, JsString::from("android:R58M123ABC"));
        assert_eq!(result.devices[0].serial, Some(JsString::from("R58M123ABC")));
        assert_eq!(
            result.devices[0].runtime,
            Some(JsString::from("Android 14"))
        );
    }

    #[test]
    fn booted_network_transport_beats_offline_usb_transport_for_same_phone() {
        let mut hardware = HashMap::new();
        hardware.insert(
            JsString::from("192.168.1.5:5555"),
            DeviceHardware {
                serialno: JsString::from("PHONE1"),
                release: Some(JsString::from("15")),
            },
        );
        hardware.insert(
            JsString::from("PHONE1"),
            DeviceHardware {
                serialno: JsString::from("PHONE1"),
                release: None,
            },
        );
        let result = android_inventory(&AndroidInventoryInput {
            avds: vec![],
            emulators: vec![],
            physical: vec![
                AdbTransport {
                    serial: JsString::from("PHONE1"),
                    kind: AdbTransportKind::Usb,
                    state: DeviceState::Offline,
                    block: None,
                    model: Some(JsString::from("Pixel 7")),
                    usb: Some(JsString::from("1-1")),
                },
                AdbTransport {
                    serial: JsString::from("192.168.1.5:5555"),
                    kind: AdbTransportKind::Network,
                    state: DeviceState::Booted,
                    block: None,
                    model: Some(JsString::from("Pixel 7")),
                    usb: None,
                },
            ],
            hardware,
            platform: "darwin".into(),
        });
        assert_eq!(result.devices.len(), 1);
        assert_eq!(result.devices[0].state, DeviceState::Booted);
        assert_eq!(
            result.devices[0].serial,
            Some(JsString::from("192.168.1.5:5555"))
        );
    }

    #[test]
    fn blocked_devices_report_one_error_per_block_kind_and_json_uses_schema_key_order() {
        let result = android_inventory(&AndroidInventoryInput {
            avds: vec![],
            emulators: vec![],
            physical: vec![
                AdbTransport {
                    serial: JsString::from("0123"),
                    kind: AdbTransportKind::Usb,
                    state: DeviceState::Unauthorized,
                    block: Some(AdbBlock::Unauthorized),
                    model: None,
                    usb: Some(JsString::from("1-2")),
                },
                AdbTransport {
                    serial: JsString::from("????????????"),
                    kind: AdbTransportKind::Usb,
                    state: DeviceState::Unauthorized,
                    block: Some(AdbBlock::NoPermissions),
                    model: None,
                    usb: Some(JsString::from("3-1")),
                },
            ],
            hardware: HashMap::new(),
            platform: "linux".into(),
        });
        assert_eq!(result.blocked.len(), 2);
        assert!(matches!(
            result.blocked[0],
            DeviceError::Coded {
                code: DeviceErrorCode::PermissionDenied,
                ..
            }
        ));
        assert_eq!(result.devices[1].id, JsString::from("android:usb-3-1"));
        let mut device_json = String::new();
        result.devices[0].write_json(&mut device_json);
        assert_eq!(
            device_json,
            r#"{"id":"android:0123","platform":"android","name":"Android device","state":"unauthorized","serial":"0123"}"#
        );
    }
}
