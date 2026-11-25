// SPDX-License-Identifier: Apache-2.0
//! `DevicePlatform.list`: the inventory a view sees, from each platform's read. The reads
//! (three SDK commands plus `simctl list`) stay with the shell; this crate decides what each
//! device becomes, which failures are missing SDKs rather than errors, and when no platform
//! answered at all.

use serde::{Deserialize, Serialize};

use super::commands::simulator_runtime;
use super::{Error, Failure};

/// One `AppDevice` as the protocol schema orders it.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct DeviceRecord {
    pub id: String,
    pub platform: String,
    pub name: String,
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub serial: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

/// One platform's read: its devices, or the failure that stopped it.
#[derive(Debug, Clone, Deserialize)]
pub struct Source {
    pub platform: String,
    #[serde(default)]
    pub devices: Vec<DeviceRecord>,
    #[serde(default)]
    pub failure: Option<Failure>,
}

/// A missing-SDK issue, as `diagnostics` shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Missing {
    pub code: String,
    pub message: String,
    pub hint: String,
    pub platform: String,
}

/// The inventory and the missing SDKs a list found.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ListAnswer {
    pub devices: Vec<DeviceRecord>,
    pub missing: Vec<Missing>,
}

/// `list`: a source that answered contributes its devices; a `sdk_missing` failure becomes a
/// diagnostic; any other failure is the list's own. When every source failed, the first one is
/// thrown: there is no inventory to show.
pub fn list(sources: Vec<Source>) -> Result<ListAnswer, Error> {
    let mut devices = Vec::new();
    let mut missing = Vec::new();
    let mut first_failure: Option<Failure> = None;
    let mut answered = 0;
    for source in &sources {
        match &source.failure {
            None => {
                answered += 1;
                devices.extend(source.devices.iter().cloned());
            }
            Some(failure) if failure.code == super::Code::SdkMissing => {
                missing.push(Missing {
                    code: failure.code.as_str().to_string(),
                    message: failure.message.clone(),
                    hint: failure.hint.clone(),
                    platform: source.platform.clone(),
                });
            }
            Some(failure) => {
                if first_failure.is_none() {
                    first_failure = Some(failure.clone());
                }
            }
        }
    }
    if answered == 0
        && let Some(failure) = first_failure
    {
        return Err(Error::Failed(failure));
    }
    Ok(ListAnswer { devices, missing })
}

/// `Simulators.list`'s device: an available Simulator as the device list shows it. `Booted` is
/// the only state a view drives; anything else is shut down.
pub fn simulator_record(
    udid: &str,
    name: &str,
    state: &str,
    runtime: &str,
    device_type: Option<&str>,
) -> DeviceRecord {
    DeviceRecord {
        id: format!("ios:{udid}"),
        platform: "ios".to_string(),
        name: name.to_string(),
        state: if state == "Booted" { "booted" } else { "shutdown" }.to_string(),
        runtime: Some(simulator_runtime(runtime)),
        serial: None,
        model: device_type.map(str::to_string),
    }
}

/// `android-platform.ts`'s renamed transport: an adb serial with no AVD name is still an
/// emulator, and says so rather than showing `emulator-5554` to a person.
pub fn android_record(mut device: DeviceRecord) -> DeviceRecord {
    if is_unnamed_emulator(&device.name) {
        device.name = "Android emulator".to_string();
    }
    device
}

fn is_unnamed_emulator(name: &str) -> bool {
    let Some(digits) = name.strip_prefix("emulator-") else {
        return false;
    };
    !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::Code;

    fn device(id: &str, name: &str) -> DeviceRecord {
        DeviceRecord {
            id: id.to_string(),
            platform: "android".to_string(),
            name: name.to_string(),
            state: "booted".to_string(),
            runtime: None,
            serial: Some("emulator-5554".to_string()),
            model: None,
        }
    }

    fn failure(code: Code) -> Failure {
        Failure {
            code,
            message: format!("{} message", code.as_str()),
            hint: "fix it".to_string(),
        }
    }

    #[test]
    fn each_answering_platforms_devices_are_listed_together() {
        let answer = list(vec![
            Source {
                platform: "ios".to_string(),
                devices: vec![simulator_record(
                    "11111111-1111-4111-8111-111111111111",
                    "iPhone 18 Pro",
                    "Booted",
                    "com.apple.CoreSimulator.SimRuntime.iOS-18-0",
                    Some("com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro"),
                )],
                failure: None,
            },
            Source {
                platform: "android".to_string(),
                devices: vec![device("android:Pixel_API_35", "Pixel_API_35")],
                failure: None,
            },
        ])
        .expect("list");
        assert_eq!(answer.devices.len(), 2);
        assert_eq!(answer.devices[0].id, "ios:11111111-1111-4111-8111-111111111111");
        assert_eq!(answer.devices[0].state, "booted");
        assert_eq!(answer.devices[0].runtime.as_deref(), Some("iOS 18.0"));
        assert!(answer.missing.is_empty());
    }

    #[test]
    fn a_missing_sdk_is_a_tagged_diagnostic_while_the_other_platform_still_lists() {
        let answer = list(vec![
            Source {
                platform: "ios".to_string(),
                devices: Vec::new(),
                failure: Some(failure(Code::SdkMissing)),
            },
            Source {
                platform: "android".to_string(),
                devices: vec![device("android:Pixel_API_35", "Pixel_API_35")],
                failure: None,
            },
        ])
        .expect("one platform answered");
        assert_eq!(answer.devices.len(), 1);
        assert_eq!(answer.missing.len(), 1);
        assert_eq!(answer.missing[0].platform, "ios");
        assert_eq!(answer.missing[0].code, "sdk_missing");
    }

    #[test]
    fn a_failure_that_is_not_a_missing_sdk_is_the_lists_own() {
        let error = list(vec![
            Source {
                platform: "ios".to_string(),
                devices: Vec::new(),
                failure: Some(failure(Code::PermissionDenied)),
            },
            Source {
                platform: "android".to_string(),
                devices: vec![device("android:Pixel_API_35", "Pixel_API_35")],
                failure: None,
            },
        ])
        .expect_err("permission");
        assert!(matches!(error, Error::Refused(refusal) if refusal.code == Code::PermissionDenied));
    }

    #[test]
    fn when_every_platform_failed_the_first_failure_is_the_lists() {
        let error = list(vec![
            Source {
                platform: "ios".to_string(),
                devices: Vec::new(),
                failure: Some(failure(Code::SdkMissing)),
            },
            Source {
                platform: "android".to_string(),
                devices: Vec::new(),
                failure: Some(failure(Code::SdkMissing)),
            },
        ])
        .expect_err("nothing answered");
        assert!(matches!(error, Error::Failed(failure) if failure.code == Code::SdkMissing));
    }

    #[test]
    fn an_unnamed_emulator_transport_reads_as_an_android_emulator() {
        assert_eq!(
            android_record(device("android:emulator-5554", "emulator-5554")).name,
            "Android emulator"
        );
        assert_eq!(
            android_record(device("android:Pixel", "Pixel_7")).name,
            "Pixel_7"
        );
        assert_eq!(
            android_record(device("android:emulator-abc", "emulator-abc")).name,
            "emulator-abc"
        );
    }
}
