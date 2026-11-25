// SPDX-License-Identifier: Apache-2.0

//! Language-neutral device words loaded from `native/daemon/catalog/devices.json`
//! via `ace-json` (ADR 0225 safeguard 3).

use crate::error::DeviceError;
use ace_json::Value;
use std::sync::OnceLock;

const DEVICES_CATALOG_JSON: &str = include_str!("../../../catalog/devices.json");

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TooManyTransportsText {
    pub message: String,
    pub hint: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoPermissionsText {
    pub message_suffix: String,
    pub hint_linux: String,
    pub hint_other: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlockedKindText {
    pub message_suffix: String,
    pub hint: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlockedTexts {
    pub no_permissions: NoPermissionsText,
    pub network: BlockedKindText,
    pub usb: BlockedKindText,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdbTransportsCatalog {
    pub default_physical_name: String,
    pub too_many_transports: TooManyTransportsText,
    pub blocked: BlockedTexts,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DevicesCatalog {
    pub adb_transports: AdbTransportsCatalog,
}

fn req_obj<'a>(obj: &'a ace_json::Map, key: &str) -> Result<&'a ace_json::Map, DeviceError> {
    obj.get(key)
        .and_then(Value::as_object)
        .ok_or_else(|| DeviceError::InvalidInput(format!("catalog missing object '{key}'")))
}

fn req_str(obj: &ace_json::Map, key: &str) -> Result<String, DeviceError> {
    obj.get(key)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .ok_or_else(|| DeviceError::InvalidInput(format!("catalog missing string '{key}'")))
}

pub fn parse_devices_catalog(raw: &str) -> Result<DevicesCatalog, DeviceError> {
    let parsed = ace_json::parse(raw)
        .map_err(|err| DeviceError::InvalidInput(format!("invalid devices catalog JSON: {err}")))?;
    let root = parsed.as_object().ok_or_else(|| {
        DeviceError::InvalidInput("devices catalog root must be an object".into())
    })?;
    let adb = req_obj(root, "adbTransports")?;
    let too_many = req_obj(adb, "tooManyTransports")?;
    let blocked = req_obj(adb, "blocked")?;
    let no_perm = req_obj(blocked, "noPermissions")?;
    let network = req_obj(blocked, "network")?;
    let usb = req_obj(blocked, "usb")?;

    Ok(DevicesCatalog {
        adb_transports: AdbTransportsCatalog {
            default_physical_name: req_str(adb, "defaultPhysicalName")?,
            too_many_transports: TooManyTransportsText {
                message: req_str(too_many, "message")?,
                hint: req_str(too_many, "hint")?,
            },
            blocked: BlockedTexts {
                no_permissions: NoPermissionsText {
                    message_suffix: req_str(no_perm, "messageSuffix")?,
                    hint_linux: req_str(no_perm, "hintLinux")?,
                    hint_other: req_str(no_perm, "hintOther")?,
                },
                network: BlockedKindText {
                    message_suffix: req_str(network, "messageSuffix")?,
                    hint: req_str(network, "hint")?,
                },
                usb: BlockedKindText {
                    message_suffix: req_str(usb, "messageSuffix")?,
                    hint: req_str(usb, "hint")?,
                },
            },
        },
    })
}

static CATALOG: OnceLock<DevicesCatalog> = OnceLock::new();

/// Returns the embedded `native/daemon/catalog/devices.json` catalog parsed once with `ace-json`.
pub fn devices_catalog() -> &'static DevicesCatalog {
    CATALOG.get_or_init(|| match parse_devices_catalog(DEVICES_CATALOG_JSON) {
        Ok(catalog) => catalog,
        Err(_) => DevicesCatalog {
            adb_transports: AdbTransportsCatalog {
                default_physical_name: String::new(),
                too_many_transports: TooManyTransportsText {
                    message: String::new(),
                    hint: String::new(),
                },
                blocked: BlockedTexts {
                    no_permissions: NoPermissionsText {
                        message_suffix: String::new(),
                        hint_linux: String::new(),
                        hint_other: String::new(),
                    },
                    network: BlockedKindText {
                        message_suffix: String::new(),
                        hint: String::new(),
                    },
                    usb: BlockedKindText {
                        message_suffix: String::new(),
                        hint: String::new(),
                    },
                },
            },
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_devices_catalog_parses_cleanly() {
        let parsed = match parse_devices_catalog(DEVICES_CATALOG_JSON) {
            Ok(c) => c,
            Err(err) => panic!("embedded devices.json failed to parse: {err}"),
        };
        assert_eq!(parsed, *devices_catalog());
        assert!(
            !parsed
                .adb_transports
                .blocked
                .no_permissions
                .hint_linux
                .is_empty()
        );
        assert!(!parsed.adb_transports.blocked.network.hint.is_empty());
        assert!(!parsed.adb_transports.blocked.usb.hint.is_empty());
    }
}
