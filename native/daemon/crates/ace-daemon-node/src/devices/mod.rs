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
use serde_json::{Value, json};

/// An answer the shell parses: the value on success, or the refusal's code, message and hint.
fn answered<T: Serialize>(
    run: impl FnOnce() -> Result<T, ace_devices::platform::Error>,
) -> napi::Result<String> {
    let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(run));
    let value: Value = match caught {
        Ok(Ok(value)) => json!({ "ok": true, "value": value }),
        Ok(Err(ace_devices::platform::Error::Refused(refusal))) => {
            json!({ "ok": false, "error": refusal })
        }
        Ok(Err(ace_devices::platform::Error::Invalid(detail))) => {
            return Err(napi::Error::from_reason(format!("ace-devices: {detail}")));
        }
        Err(_) => {
            return Err(napi::Error::from_reason(
                "ace-devices: the device platform panicked",
            ));
        }
    };
    ace_json::ser::to_string(&value)
        .map_err(|error| napi::Error::from_reason(format!("ace-devices: {error}")))
}
