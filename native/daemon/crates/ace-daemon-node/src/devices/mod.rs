// SPDX-License-Identifier: Apache-2.0
//! The device platform's binding (D3.1) and the device inventory's (D2): values in, JSON out,
//! never logic. Every platform export answers `{"ok":true,"value":…}` or
//! `{"ok":false,"error":{code,message,hint}}`, which the shell raises as today's `DeviceError`;
//! a caller mistake is a thrown `ace-devices:` error, never a refusal. Behaviour lives in
//! `ace-devices`.

// napi-derive registers this module's exports only outside test builds, so in the lib test
// target every export reads as unused.
#![cfg_attr(test, allow(dead_code))]

pub mod chrome;
pub mod chrome_simulator;
pub mod chrome_skin;
pub mod input;
pub mod platform;

mod inventory;

use serde::Serialize;

/// [`answered`] for a task the native runtime runs: the same one-line answer, awaited off the
/// JavaScript thread.
pub(super) async fn answered_async<T: Serialize>(
    run: impl std::future::Future<Output = Result<T, ace_devices::platform::Error>>,
) -> napi::Result<String> {
    fn text<T: Serialize>(value: &T) -> napi::Result<String> {
        ace_json::ser::to_string(value)
            .map_err(|error| napi::Error::from_reason(format!("ace-devices: {error}")))
    }
    let caught = std::panic::AssertUnwindSafe(run);
    match caught.await {
        Ok(value) => Ok(format!("{{\"ok\":true,\"value\":{}}}", text(&value)?)),
        Err(ace_devices::platform::Error::Refused(refusal)) => {
            Ok(format!("{{\"ok\":false,\"error\":{}}}", text(&refusal)?))
        }
        Err(ace_devices::platform::Error::Failed(failure)) => {
            Ok(format!("{{\"ok\":false,\"error\":{}}}", text(&failure)?))
        }
        Err(ace_devices::platform::Error::Invalid(detail)) => {
            Err(napi::Error::from_reason(format!("ace-devices: {detail}")))
        }
    }
}

/// An answer the shell parses: the value on success, or the failure's code, message and hint.
/// Each side is serialized by `ace-json`, so a device name keeps its UTF-16 units, lone
/// surrogate included, instead of passing through serde_json's UTF-8 strings.
fn answered<T: Serialize>(
    run: impl FnOnce() -> Result<T, ace_devices::platform::Error>,
) -> napi::Result<String> {
    fn text<T: Serialize>(value: &T) -> napi::Result<String> {
        ace_json::ser::to_string(value)
            .map_err(|error| napi::Error::from_reason(format!("ace-devices: {error}")))
    }
    let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(run));
    match caught {
        Ok(Ok(value)) => Ok(format!("{{\"ok\":true,\"value\":{}}}", text(&value)?)),
        Ok(Err(ace_devices::platform::Error::Refused(refusal))) => {
            Ok(format!("{{\"ok\":false,\"error\":{}}}", text(&refusal)?))
        }
        Ok(Err(ace_devices::platform::Error::Failed(failure))) => {
            Ok(format!("{{\"ok\":false,\"error\":{}}}", text(&failure)?))
        }
        Ok(Err(ace_devices::platform::Error::Invalid(detail))) => {
            Err(napi::Error::from_reason(format!("ace-devices: {detail}")))
        }
        Err(_) => Err(napi::Error::from_reason(
            "ace-devices: the device platform panicked",
        )),
    }
}

use ace_devices::error::DeviceError;
use ace_devices::inventory::adb_transports::{
    AdbBlock, AdbTransport, AdbTransportKind, DeviceState, adb_transports, blocked_error,
    hardware_serial, physical_id_part, physical_name, transport_kind,
};
use ace_devices::inventory::android::{
    AndroidInventoryInput, DeviceHardware, EmulatorEntry, android_inventory,
};
use ace_json::{JsString, Value, write_js_string};
use napi_derive::napi;
use std::collections::HashMap;
use std::panic::{AssertUnwindSafe, catch_unwind};

pub(super) fn bind_error(error: DeviceError) -> napi::Error {
    napi::Error::from_reason(error.to_string())
}

pub(super) fn parse_json(text: &str) -> napi::Result<Value> {
    ace_json::parse(text).map_err(|err| napi::Error::from_reason(format!("invalid JSON: {err}")))
}

pub(super) fn guarded<T>(context: &str, run: impl FnOnce() -> napi::Result<T>) -> napi::Result<T> {
    match catch_unwind(AssertUnwindSafe(run)) {
        Ok(outcome) => outcome,
        Err(_) => Err(napi::Error::from_reason(format!("{context} panicked"))),
    }
}

fn parse_js_string_arg(json: &str, name: &str) -> napi::Result<JsString> {
    let val = parse_json(json)?;
    val.as_js_str()
        .cloned()
        .ok_or_else(|| napi::Error::from_reason(format!("{name} must be a JSON string")))
}

fn encode_js_string(value: &JsString) -> String {
    let mut out = String::new();
    write_js_string(&mut out, value);
    out
}

/// Parses `adb devices -l` stdout (`output_json` is a JSON-encoded string).
/// Returns `{"ok":true,"transports":[...]}` or `{"ok":false,"error":{...}}`.
#[napi(catch_unwind)]
pub fn device_adb_transports(output_json: String) -> napi::Result<String> {
    guarded("device_adb_transports", || {
        let output = parse_js_string_arg(&output_json, "output")?;
        let mut out = String::new();
        match adb_transports(&output) {
            Ok(transports) => {
                out.push_str("{\"ok\":true,\"transports\":[");
                for (idx, t) in transports.iter().enumerate() {
                    if idx > 0 {
                        out.push(',');
                    }
                    t.write_json(&mut out);
                }
                out.push_str("]}");
            }
            Err(err) => {
                out.push_str("{\"ok\":false,\"error\":");
                err.to_failure(None).write_json(&mut out);
                out.push('}');
            }
        }
        Ok(out)
    })
}

/// Classifies an adb serial (`serial_json` is a JSON-encoded string).
#[napi(catch_unwind)]
pub fn device_transport_kind(serial_json: String) -> napi::Result<String> {
    guarded("device_transport_kind", || {
        let serial = parse_js_string_arg(&serial_json, "serial")?;
        Ok(transport_kind(&serial).as_str().to_owned())
    })
}

/// Computes the stable id suffix for a physical/network transport.
#[napi(catch_unwind)]
pub fn device_physical_id_part(input_json: String) -> napi::Result<String> {
    guarded("device_physical_id_part", || {
        let val = parse_json(&input_json)?;
        let obj = val
            .as_object()
            .ok_or_else(|| napi::Error::from_reason("input must be an object"))?;
        let serial = obj
            .get("serial")
            .and_then(Value::as_js_str)
            .ok_or_else(|| napi::Error::from_reason("serial missing"))?;
        let usb = obj.get("usb").and_then(Value::as_js_str);
        let hardware = obj.get("hardware").and_then(Value::as_js_str);
        Ok(encode_js_string(&physical_id_part(serial, usb, hardware)))
    })
}

/// Parses `getprop ro.serialno` output (`output_json` is a JSON-encoded string).
#[napi(catch_unwind)]
pub fn device_hardware_serial(output_json: String) -> napi::Result<Option<String>> {
    guarded("device_hardware_serial", || {
        let output = parse_js_string_arg(&output_json, "output")?;
        Ok(hardware_serial(&output).map(|s| encode_js_string(&s)))
    })
}

/// Computes the display name for a physical/network transport.
#[napi(catch_unwind)]
pub fn device_physical_name(transport_json: String) -> napi::Result<String> {
    guarded("device_physical_name", || {
        let val = parse_json(&transport_json)?;
        let transport = AdbTransport::from_value(&val).map_err(bind_error)?;
        Ok(encode_js_string(&physical_name(&transport)))
    })
}

/// Formats the actionable `DeviceFailure` for an unauthorized / no-permissions transport.
#[napi(catch_unwind)]
pub fn device_blocked_error(input_json: String) -> napi::Result<String> {
    guarded("device_blocked_error", || {
        let val = parse_json(&input_json)?;
        let obj = val
            .as_object()
            .ok_or_else(|| napi::Error::from_reason("input must be an object"))?;
        let kind_str = obj
            .get("kind")
            .and_then(Value::as_str)
            .ok_or_else(|| napi::Error::from_reason("kind missing"))?;
        let kind = AdbTransportKind::parse(kind_str)
            .ok_or_else(|| napi::Error::from_reason("unknown transport kind"))?;
        let block = match obj.get("block") {
            None | Some(Value::Null) => None,
            Some(v) => {
                let s = v
                    .as_str()
                    .ok_or_else(|| napi::Error::from_reason("block must be string"))?;
                Some(
                    AdbBlock::parse(s)
                        .ok_or_else(|| napi::Error::from_reason("unknown adb block"))?,
                )
            }
        };
        let name = obj
            .get("name")
            .and_then(Value::as_js_str)
            .ok_or_else(|| napi::Error::from_reason("name missing"))?;
        let platform = obj
            .get("platform")
            .and_then(Value::as_str)
            .ok_or_else(|| napi::Error::from_reason("platform missing"))?;
        let mut out = String::new();
        blocked_error(kind, block, name, platform)
            .to_failure(None)
            .write_json(&mut out);
        Ok(out)
    })
}

/// Merges installed AVDs, running emulators, and physical/network Android transports.
#[napi(catch_unwind)]
pub fn device_android_inventory(input_json: String) -> napi::Result<String> {
    guarded("device_android_inventory", || {
        let val = parse_json(&input_json)?;
        let obj = val
            .as_object()
            .ok_or_else(|| napi::Error::from_reason("input must be an object"))?;

        let avds_arr = obj
            .get("avds")
            .and_then(Value::as_array)
            .ok_or_else(|| napi::Error::from_reason("avds must be an array"))?;
        let mut avds = Vec::with_capacity(avds_arr.len());
        for item in avds_arr {
            let s = item
                .as_js_str()
                .ok_or_else(|| napi::Error::from_reason("avd entry must be string"))?;
            avds.push(s.clone());
        }

        let emus_arr = obj
            .get("emulators")
            .and_then(Value::as_array)
            .ok_or_else(|| napi::Error::from_reason("emulators must be an array"))?;
        let mut emulators = Vec::with_capacity(emus_arr.len());
        for item in emus_arr {
            let e = item
                .as_object()
                .ok_or_else(|| napi::Error::from_reason("emulator entry must be object"))?;
            let serial = e
                .get("serial")
                .and_then(Value::as_js_str)
                .ok_or_else(|| napi::Error::from_reason("emulator.serial missing"))?
                .clone();
            let state_str = e
                .get("state")
                .and_then(Value::as_str)
                .ok_or_else(|| napi::Error::from_reason("emulator.state missing"))?;
            let state = DeviceState::parse(state_str)
                .ok_or_else(|| napi::Error::from_reason("unknown emulator.state"))?;
            let name = e
                .get("name")
                .and_then(Value::as_js_str)
                .ok_or_else(|| napi::Error::from_reason("emulator.name missing"))?
                .clone();
            emulators.push(EmulatorEntry {
                serial,
                state,
                name,
            });
        }

        let phys_arr = obj
            .get("physical")
            .and_then(Value::as_array)
            .ok_or_else(|| napi::Error::from_reason("physical must be an array"))?;
        let mut physical = Vec::with_capacity(phys_arr.len());
        for item in phys_arr {
            physical.push(AdbTransport::from_value(item).map_err(bind_error)?);
        }

        let hw_arr = obj
            .get("hardware")
            .and_then(Value::as_array)
            .ok_or_else(|| napi::Error::from_reason("hardware must be an array"))?;
        let mut hardware = HashMap::with_capacity(hw_arr.len());
        for item in hw_arr {
            let h = item
                .as_object()
                .ok_or_else(|| napi::Error::from_reason("hardware entry must be object"))?;
            let serial = h
                .get("serial")
                .and_then(Value::as_js_str)
                .ok_or_else(|| napi::Error::from_reason("hardware.serial missing"))?
                .clone();
            let serialno = h
                .get("serialno")
                .and_then(Value::as_js_str)
                .ok_or_else(|| napi::Error::from_reason("hardware.serialno missing"))?
                .clone();
            let release = match h.get("release") {
                None | Some(Value::Null) => None,
                Some(v) => Some(
                    v.as_js_str()
                        .ok_or_else(|| napi::Error::from_reason("hardware.release must be string"))?
                        .clone(),
                ),
            };
            hardware.insert(serial, DeviceHardware { serialno, release });
        }

        let platform = obj
            .get("platform")
            .and_then(Value::as_str)
            .ok_or_else(|| napi::Error::from_reason("platform missing"))?
            .to_owned();

        let result = android_inventory(&AndroidInventoryInput {
            avds,
            emulators,
            physical,
            hardware,
            platform,
        });
        Ok(result.to_json_string())
    })
}
