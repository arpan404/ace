// SPDX-License-Identifier: Apache-2.0
//! The device platform exports (D3.1): identity, the package lifecycle and the emulator's
//! discovery files. Every function translates arguments and one JSON answer; nothing here
//! decides anything.

use std::collections::HashMap;

use ace_devices::platform::{
    Error, Platform,
    identity::{self, SimulatorEntry},
    lifecycle,
};
use napi_derive::napi;

use super::answered;

/// One Simulator from `xcrun simctl list devices --json`, as the shell holds it.
#[napi(object)]
pub struct NativeSimulator {
    pub udid: String,
    pub name: String,
    pub state: String,
    pub runtime: String,
}

/// One `pid_<pid>.ini` the shell read from the emulator's running directory.
#[napi(object)]
pub struct NativeDiscoveryFile {
    pub name: String,
    pub text: String,
}

fn entries(inventory: Vec<NativeSimulator>) -> Vec<SimulatorEntry> {
    inventory
        .into_iter()
        .map(|device| SimulatorEntry {
            udid: device.udid,
            name: device.name,
            state: device.state,
            runtime: device.runtime,
        })
        .collect()
}

/// `simulatorDevice` / `simulatorIdentity`: the name, state and release the listed Simulator
/// gives the device, or the refusal that stops a capture.
#[napi]
pub fn device_platform_identity(
    id: String,
    capture: bool,
    inventory: Vec<NativeSimulator>,
) -> napi::Result<String> {
    answered(|| identity::simulator_device(&id, &entries(inventory), capture))
}

/// `install`: the `simctl install` or `adb install -r` step under the ten-minute budget.
#[napi]
pub fn device_platform_install(platform: String, path: String) -> napi::Result<String> {
    answered(|| {
        let platform = Platform::parse(&platform)?;
        lifecycle::install(platform, &path)
    })
}

/// `openApp`: the launch step, or the `resolve-activity` step whose output decides it.
#[napi]
pub fn device_platform_open_app(
    platform: String,
    app: String,
    resolved: Option<String>,
) -> napi::Result<String> {
    answered(|| {
        let platform = Platform::parse(&platform)?;
        lifecycle::open_app(platform, &app, resolved.as_deref())
    })
}

/// `openUrl`: the URL as data, through `simctl openurl` or an `ACTION_VIEW` intent.
#[napi]
pub fn device_platform_open_url(platform: String, url: String) -> napi::Result<String> {
    answered(|| {
        let platform = Platform::parse(&platform)?;
        lifecycle::open_url(platform, &url)
    })
}

/// `configure`: the appearance and location steps, in today's order.
#[napi]
pub fn device_platform_configure(
    platform: String,
    settings: String,
    physical: bool,
) -> napi::Result<String> {
    answered(|| {
        let platform = Platform::parse(&platform)?;
        let settings: lifecycle::Settings = serde_json::from_str(&settings)
            .map_err(|error| Error::Invalid(format!("device settings: {error}")))?;
        lifecycle::configure(platform, &settings, physical)
    })
}

/// `simctl launch`'s process id, when its output carries one.
#[napi]
pub fn device_platform_launch_pid(stdout: String) -> Option<String> {
    ace_devices::platform::commands::launch_pid(&stdout)
}

/// What one SDK root holds: adb from its `platform-tools`, the emulator from its `emulator`.
#[napi(object)]
pub struct NativeFoundTools {
    pub adb: Option<String>,
    pub emulator: Option<String>,
}

/// `androidSdkRoots`: every absolute SDK root this host offers, preferred first.
#[napi]
pub fn device_platform_android_sdk_roots(
    platform: String,
    home: Option<String>,
    env: HashMap<String, String>,
) -> Vec<String> {
    let env: std::collections::BTreeMap<String, String> = env.into_iter().collect();
    ace_devices::platform::sdk::android_sdk_roots(&env, home.as_deref(), &platform)
}

/// `findAndroidTools`' choice: an SDK holding both tools first, then the first of each, then adb
/// from PATH.
#[napi]
pub fn device_platform_choose_android_tools(
    found: Vec<NativeFoundTools>,
    path_adb: Option<String>,
) -> napi::Result<String> {
    let found: Vec<ace_devices::platform::sdk::FoundTools> = found
        .into_iter()
        .map(|root| ace_devices::platform::sdk::FoundTools {
            adb: root.adb,
            emulator: root.emulator,
        })
        .collect();
    answered(|| {
        Ok(ace_devices::platform::sdk::choose_android_tools(
            &found, path_adb,
        ))
    })
}

/// `resolveAndroidSDK`: the tools, or the refusal that names the install this host needs.
#[napi]
pub fn device_platform_resolve_android_sdk(
    adb: Option<String>,
    emulator: Option<String>,
    platform: String,
    arch: Option<String>,
) -> napi::Result<String> {
    answered(|| {
        let tools = ace_devices::platform::sdk::AndroidTools { adb, emulator };
        Ok(ace_devices::platform::sdk::resolve_android_sdk(
            &tools,
            &platform,
            arch.as_deref(),
        )?)
    })
}

/// `resolveXcode`'s host refusal: a paired Mac on Windows, macOS for every other non-Mac.
#[napi]
pub fn device_platform_xcode_host_refusal(platform: String) -> napi::Result<String> {
    answered(|| Ok(ace_devices::platform::sdk::xcode_host_refusal(&platform)))
}

/// `resolveXcode`'s refusal when `xcode-select`, `xcrun` or `open` is missing.
#[napi]
pub fn device_platform_xcode_tools_refusal() -> napi::Result<String> {
    answered(|| Ok(ace_devices::platform::sdk::xcode_tools_refusal()))
}

/// `resolveXcode`'s check of `xcode-select -p`; `code` is absent when the probe itself failed.
#[napi]
pub fn device_platform_xcode_selection(code: Option<i32>, stdout: String) -> napi::Result<String> {
    answered(|| Ok(ace_devices::platform::sdk::xcode_selection(code, &stdout).err()))
}

/// `iosNeedsMac`: Windows can't run the iOS Simulator.
#[napi]
pub fn device_platform_ios_needs_mac() -> napi::Result<String> {
    answered(|| Ok(ace_devices::platform::sdk::ios_needs_mac()))
}

/// `armEmulatorNote`: Google publishes no Android Emulator for Linux arm64.
#[napi]
pub fn device_platform_arm_emulator_note() -> napi::Result<String> {
    answered(|| Ok(ace_devices::platform::sdk::arm_emulator_note()))
}

/// `emulatorConsolePort`: `emulator-5554` is console port 5554; another serial reaches none.
#[napi]
pub fn device_platform_console_port(serial: String) -> Option<u32> {
    ace_devices::platform::emulator::console_port(&serial).map(u32::from)
}

/// `emulatorRunningDirectory`: where running emulators describe themselves, by host OS.
#[napi]
pub fn device_platform_running_directory(
    platform: String,
    home: String,
    env: HashMap<String, String>,
) -> Option<String> {
    let env: std::collections::BTreeMap<String, String> = env.into_iter().collect();
    ace_devices::platform::emulator::running_directory(&platform, &home, &env)
        .and_then(|path| path.into_os_string().into_string().ok())
}

/// `emulatorGrpc`: the gRPC endpoint of the emulator on `serial`'s console port, when it has
/// one ace may use.
#[napi]
pub fn device_platform_emulator_grpc(
    serial: String,
    files: Vec<NativeDiscoveryFile>,
) -> napi::Result<String> {
    answered(|| {
        let files: Vec<ace_devices::platform::emulator::DiscoveryFile> = files
            .into_iter()
            .map(|file| ace_devices::platform::emulator::DiscoveryFile {
                name: file.name,
                text: file.text,
            })
            .collect();
        let reached = ace_devices::platform::emulator::console_port(&serial)
            .and_then(|port| ace_devices::platform::emulator::grpc_endpoint(port, &files));
        Ok(serde_json::json!({ "grpc": reached }))
    })
}
