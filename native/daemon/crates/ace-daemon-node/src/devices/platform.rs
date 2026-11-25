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
