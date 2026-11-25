// SPDX-License-Identifier: Apache-2.0
//! `Simulators` (`@ace/screen`'s `simulator.ts`): the parse of `xcrun simctl list devices --json`
//! into the available Simulators the platform lists. The probe stays in the shell; this decides
//! which devices count and keeps every name and UDID as a JavaScript string.

use ace_json::{JsString, Value};

use super::Error;

/// The protocol's caps for a Simulator's fields, as `simulator.ts` declares them.
const NAME_MAX: usize = 256;
const STATE_MAX: usize = 64;
const DEVICE_TYPE_MAX: usize = 256;
const DEVICES_MAX: usize = 1024;

/// One available Simulator as `Simulators.list` returns it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Simulator {
    pub udid: JsString,
    pub name: JsString,
    pub state: JsString,
    pub is_available: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_type_identifier: Option<JsString>,
    /// The runtime record's key (`com.apple.CoreSimulator.SimRuntime.iOS-18-0`).
    pub runtime: JsString,
}

fn invalid(detail: &str) -> Error {
    Error::Invalid(format!("Simulator discovery: {detail}"))
}

fn units(text: &JsString) -> usize {
    text.encode_utf16().count()
}

/// `z.string().uuid()`: 8-4-4-4-12 hexadecimal digits, either case.
fn is_uuid(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => *byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        })
}

/// One device record's fields, in `simulator.ts`'s schema.
fn parse_entry(value: &Value, runtime: &JsString) -> Result<Option<Simulator>, Error> {
    let Some(fields) = value.as_object() else {
        return Err(invalid("a device is not an object"));
    };
    let string = |name: &str| {
        fields
            .get(name)
            .and_then(Value::as_js_str)
            .cloned()
            .ok_or_else(|| invalid(&format!("{name} is not a string")))
    };
    let udid = string("udid")?;
    if !is_uuid(&udid) {
        return Err(invalid("udid is not a UUID"));
    }
    let name = string("name")?;
    if units(&name) > NAME_MAX {
        return Err(invalid("name is too long"));
    }
    let state = string("state")?;
    if units(&state) > STATE_MAX {
        return Err(invalid("state is too long"));
    }
    let Some(is_available) = fields.get("isAvailable").and_then(Value::as_bool) else {
        return Err(invalid("isAvailable is not a boolean"));
    };
    // `.optional().catch(undefined)`: a value that does not fit the schema is absent, not fatal.
    let device_type_identifier = fields
        .get("deviceTypeIdentifier")
        .and_then(Value::as_js_str)
        .filter(|value| units(value) <= DEVICE_TYPE_MAX)
        .cloned();
    if !is_available {
        return Ok(None);
    }
    Ok(Some(Simulator {
        udid,
        name,
        state,
        is_available,
        device_type_identifier,
        runtime: runtime.clone(),
    }))
}

/// `Simulators.list`: `xcrun simctl list devices --json`'s output as the available devices, in
/// the order the SDK printed them, or the caller's parse failure.
pub fn list(output: &str) -> Result<Vec<Simulator>, Error> {
    let value = ace_json::parse(output).map_err(|error| invalid(&error.to_string()))?;
    let Some(devices) = value.as_object().and_then(|root| root.get("devices")) else {
        return Err(invalid("devices is missing"));
    };
    let Some(devices) = devices.as_object() else {
        return Err(invalid("devices is not an object"));
    };
    let mut available = Vec::new();
    for (runtime, entries) in devices.iter() {
        let Some(entries) = entries.as_array() else {
            return Err(invalid("a runtime's devices are not an array"));
        };
        if entries.len() > DEVICES_MAX {
            return Err(invalid("a runtime lists too many devices"));
        }
        for entry in entries.iter() {
            if let Some(device) = parse_entry(entry, runtime)? {
                available.push(device);
            }
        }
    }
    Ok(available)
}

#[cfg(test)]
mod tests {
    use super::*;

    const UDID: &str = "11111111-1111-4111-8111-111111111111";

    fn document(devices: &str) -> String {
        format!("{{\"devices\":{{\"com.apple.CoreSimulator.SimRuntime.iOS-18-0\":[{devices}]}}}}")
    }

    #[test]
    fn available_simulators_keep_their_order_names_and_runtime() {
        let output = format!(
            "{{\"devices\":{{\
              \"com.apple.CoreSimulator.SimRuntime.iOS-18-0\":[\
                {{\"udid\":\"{UDID}\",\"name\":\"iPhone \\ud800 Pro\",\"state\":\"Booted\",\"isAvailable\":true,\"deviceTypeIdentifier\":\"com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro\"}}],\
              \"com.apple.CoreSimulator.SimRuntime.iOS-17-5\":[\
                {{\"udid\":\"22222222-2222-4222-8222-222222222222\",\"name\":\"iPad\",\"state\":\"Shutdown\",\"isAvailable\":true}}]}}}}"
        );
        let listed = list(&output).expect("list");
        assert_eq!(listed.len(), 2);
        assert_eq!(
            listed[0].name,
            JsString::from_units(&[
                0x69, 0x50, 0x68, 0x6f, 0x6e, 0x65, 0x20, 0xd800, 0x20, 0x50, 0x72, 0x6f,
            ])
        );
        assert_eq!(
            listed[0].runtime.as_str(),
            "com.apple.CoreSimulator.SimRuntime.iOS-18-0"
        );
        assert_eq!(
            listed[0]
                .device_type_identifier
                .as_ref()
                .map(JsString::as_str),
            Some("com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro")
        );
        assert_eq!(listed[1].name, "iPad");
        assert!(listed[1].device_type_identifier.is_none());
    }

    #[test]
    fn unavailable_devices_are_not_listed() {
        let output = document(&format!(
            "{{\"udid\":\"{UDID}\",\"name\":\"iPhone\",\"state\":\"Shutdown\",\"isAvailable\":false}}"
        ));
        assert!(list(&output).expect("list").is_empty());
    }

    #[test]
    fn a_field_the_schema_rejects_fails_the_list() {
        for entry in [
            "{\"udid\":\"not-a-uuid\",\"name\":\"iPhone\",\"state\":\"Booted\",\"isAvailable\":true}".to_string(),
            format!("{{\"udid\":\"{UDID}\",\"name\":\"{}\",\"state\":\"Booted\",\"isAvailable\":true}}", "n".repeat(257)),
            format!("{{\"udid\":\"{UDID}\",\"name\":\"iPhone\",\"state\":\"{}\",\"isAvailable\":true}}", "s".repeat(65)),
            format!("{{\"udid\":\"{UDID}\",\"name\":\"iPhone\",\"isAvailable\":true}}"),
        ] {
            assert!(list(&document(&entry)).is_err(), "{entry}");
        }
    }

    #[test]
    fn an_unusable_device_type_identifier_is_absent_rather_than_fatal() {
        let output = document(&format!(
            "{{\"udid\":\"{UDID}\",\"name\":\"iPhone\",\"state\":\"Booted\",\"isAvailable\":true,\"deviceTypeIdentifier\":42}}"
        ));
        let listed = list(&output).expect("list");
        assert!(listed[0].device_type_identifier.is_none());
        let output = document(&format!(
            "{{\"udid\":\"{UDID}\",\"name\":\"iPhone\",\"state\":\"Booted\",\"isAvailable\":true,\"deviceTypeIdentifier\":\"{}\"}}",
            "d".repeat(257)
        ));
        assert!(
            list(&output).expect("list")[0]
                .device_type_identifier
                .is_none()
        );
    }
}
