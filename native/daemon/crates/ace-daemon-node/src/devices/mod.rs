// SPDX-License-Identifier: Apache-2.0
//! The device platform's binding: values in, one JSON answer out, never logic. Each export
//! answers `{"ok":true,"value":…}` or `{"ok":false,"error":{code,message,hint}}`, which the
//! shell raises as today's `DeviceError`; a caller mistake is a thrown `ace-devices:` error,
//! never a refusal. Behaviour lives in `ace-devices`.

// napi-derive registers this module's exports only outside test builds, so in the lib test
// target every export reads as unused.
#![cfg_attr(test, allow(dead_code))]

pub mod platform;

use serde::Serialize;

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
