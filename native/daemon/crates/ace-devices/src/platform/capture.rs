// SPDX-License-Identifier: Apache-2.0
//! `capture.ts`'s route choice, before any capture starts: whether a Simulator runs ace's
//! serve-sim or the public-API screen helper, when that needs the device tools downloaded,
//! whether the helper must be replaced, the one Simulator window showing a device, and the
//! Android refusals. The captures themselves, the SDK, the screen manager and the timers are
//! the shell's.

use crate::platform::{Code, Error, Failure};

use super::serve_sim::PINNED_SERVE_SIM;

/// The bundles whose windows show a Simulator device (`deviceWindowBundles`).
pub const DEVICE_WINDOW_BUNDLES: [&str; 2] = ["com.apple.iphonesimulator", "com.apple.dt.Devices"];
/// How many times a closed Simulator window is looked for before refusing.
pub const WINDOW_ATTEMPTS: usize = 12;
/// How long each look waits for the window to appear.
pub const WINDOW_RETRY_MS: u64 = 500;

/// Which capture a Simulator's run starts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SimulatorRoute {
    /// ace's serve-sim, the preferred path.
    ServeSim,
    /// The public-API screen helper, when serve-sim is missing or unpinned and allowed.
    ScreenHelper,
}

/// A Simulator capture's start: its route and whether an outdated helper is replaced first.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SimulatorStart {
    pub route: SimulatorRoute,
    pub replace_helper: bool,
}

/// Whether ace's tools still have to be downloaded for serve-sim: only when no supported
/// serve-sim was found and no explicit one was named.
pub fn needs_tools_download(supported: bool, serve_sim_env: bool) -> bool {
    !supported && !serve_sim_env
}

/// The route a Simulator takes. `command` is the serve-sim the shell found (none when it is not
/// installed), `version` its version, `serve_sim_env` whether `ACE_SERVE_SIM` was set, and
/// `screen_available` whether a screen helper is configured.
pub fn simulator_route(
    supported: bool,
    command: Option<&str>,
    version: Option<&str>,
    serve_sim_env: bool,
    screen_available: bool,
) -> Result<SimulatorStart, Error> {
    if supported && command.is_some() {
        return Ok(SimulatorStart {
            route: SimulatorRoute::ServeSim,
            replace_helper: version.is_some(),
        });
    }
    // serve-sim is preferred; an unpinned version falls back to the public-API screen helper.
    let unpinned = command.map(|_| unpinned_serve_sim(version));
    if serve_sim_env {
        return Err(unpinned.unwrap_or_else(serve_sim_not_found));
    }
    if !screen_available {
        return Err(unpinned.unwrap_or_else(screen_helper_missing));
    }
    Ok(SimulatorStart {
        route: SimulatorRoute::ScreenHelper,
        replace_helper: false,
    })
}

/// Whether an Android device may start a live view at all (`ACE_ANDROID_SCRCPY` not off).
pub fn android_capture_enabled(android_scrcpy_off: bool) -> bool {
    !android_scrcpy_off
}

/// A live view needs a booted device with a serial.
pub fn android_booted(serial: Option<&str>, booted: bool) -> Result<(), Error> {
    if serial.is_some() && booted {
        return Ok(());
    }
    Err(failed(
        Code::NotBooted,
        "Android device is not booted",
        "Boot the emulator, or connect and unlock the device, and wait for adb to report device state.",
    ))
}

/// Why an Android capture without scrcpy refuses a live view, which is video only.
pub fn android_live_view_error(why: &str) -> Error {
    failed(
        Code::NotSupported,
        &format!("The Android live view needs scrcpy-server: {why}"),
        "Use an Android 5 or later device or emulator image, check the network for the first download, unset ACE_ANDROID_SCRCPY, then start the live view again.",
    )
}

/// A screen helper that can't stream video for a Simulator live view.
pub fn helper_video_unavailable() -> Error {
    failed(
        Code::ToolMissing,
        "This Mac's screen helper can't stream video for the Simulator live view",
        &format!("Download device tools in Devices for ace's serve-sim {PINNED_SERVE_SIM}."),
    )
}

/// Whether a Simulator window's title names this device.
pub fn window_matches(name: &str, title: &str) -> bool {
    if title == name {
        return true;
    }
    // Newer Xcode appends the device's state to the window's title.
    [" –", " —", " -", " ("]
        .iter()
        .any(|suffix| title.starts_with(&format!("{name}{suffix}")))
}

/// What the window list says about one device.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowChoice {
    /// The matching window's index.
    One(usize),
    /// More than one window shows the device.
    Many,
    /// No window shows the device yet.
    None,
}

/// Chooses the one window showing this device from `(bundle, title)` pairs.
pub fn choose_window(windows: &[(&str, &str)], name: &str) -> WindowChoice {
    let matching: Vec<usize> = windows
        .iter()
        .enumerate()
        .filter(|(_, (bundle, title))| {
            DEVICE_WINDOW_BUNDLES.contains(bundle) && window_matches(name, title)
        })
        .map(|(index, _)| index)
        .collect();
    match matching.as_slice() {
        [] => WindowChoice::None,
        [one] => WindowChoice::One(*one),
        _ => WindowChoice::Many,
    }
}

pub fn ambiguous_window() -> Error {
    failed(
        Code::Busy,
        "More than one Simulator window shows this device's name",
        "Close the extra Simulator window, or rename one of the simulators, then start again.",
    )
}

pub fn window_not_found() -> Error {
    failed(
        Code::NotFound,
        "The Simulator window for this device isn't open",
        &format!(
            "Download device tools in Devices for ace's serve-sim {PINNED_SERVE_SIM}, which shows the Simulator without a window. Or open the device's window in Simulator, make sure it isn't minimized, then start again."
        ),
    )
}

fn unpinned_serve_sim(version: Option<&str>) -> Error {
    failed(
        Code::ToolMissing,
        &format!(
            "serve-sim {} isn't a version ace supports",
            version.unwrap_or("(unknown version)")
        ),
        &format!(
            "Download device tools in Devices for ace's serve-sim {PINNED_SERVE_SIM}, or unset ACE_SERVE_SIM."
        ),
    )
}

fn serve_sim_not_found() -> Error {
    failed(
        Code::ToolMissing,
        "serve-sim was not found",
        "Correct ACE_SERVE_SIM, or unset it to use ace's own serve-sim.",
    )
}

fn screen_helper_missing() -> Error {
    failed(
        Code::ToolMissing,
        "Screen helper is not configured",
        "Configure ACE_SCREEN_HELPER and grant Screen Recording and Accessibility permissions.",
    )
}

fn failed(code: Code, message: &str, hint: &str) -> Error {
    Error::Failed(Failure {
        code,
        message: message.to_string(),
        hint: hint.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn failure_code(error: Error) -> (Code, String) {
        match error {
            Error::Failed(failure) => (failure.code, failure.message),
            other => panic!("unexpected: {other}"),
        }
    }

    #[test]
    fn a_supported_serve_sim_is_the_first_route_and_an_outdated_helper_is_replaced() {
        let start = simulator_route(true, Some("/tools/serve-sim"), Some("0.1.49"), false, false)
            .expect("routes");
        assert_eq!(start.route, SimulatorRoute::ServeSim);
        assert!(start.replace_helper);
        let start =
            simulator_route(true, Some("/tools/serve-sim"), None, false, false).expect("routes");
        assert!(!start.replace_helper);
    }

    #[test]
    fn an_unpinned_serve_sim_is_refused_when_it_was_named_and_falls_back_when_a_helper_exists() {
        let (code, message) = failure_code(
            simulator_route(false, Some("/serve-sim"), Some("0.0.1"), true, false)
                .expect_err("refused"),
        );
        assert_eq!(code, Code::ToolMissing);
        assert_eq!(message, "serve-sim 0.0.1 isn't a version ace supports");
        let (_, message) = failure_code(
            simulator_route(false, Some("/serve-sim"), None, true, true).expect_err("refused"),
        );
        assert_eq!(
            message,
            "serve-sim (unknown version) isn't a version ace supports"
        );
        let start = simulator_route(false, Some("/serve-sim"), Some("0.0.1"), false, true)
            .expect("falls back");
        assert_eq!(start.route, SimulatorRoute::ScreenHelper);
    }

    #[test]
    fn a_missing_serve_sim_says_so_with_the_variable_set_and_otherwise_needs_the_helper() {
        let (code, message) =
            failure_code(simulator_route(false, None, None, true, true).expect_err("refused"));
        assert_eq!(code, Code::ToolMissing);
        assert_eq!(message, "serve-sim was not found");
        let (code, message) =
            failure_code(simulator_route(false, None, None, false, false).expect_err("refused"));
        assert_eq!(code, Code::ToolMissing);
        assert_eq!(message, "Screen helper is not configured");
        assert_eq!(
            simulator_route(false, None, None, false, true)
                .expect("helper")
                .route,
            SimulatorRoute::ScreenHelper
        );
    }

    #[test]
    fn the_tools_are_downloaded_only_when_no_supported_serve_sim_is_named() {
        assert!(needs_tools_download(false, false));
        assert!(!needs_tools_download(true, false));
        assert!(!needs_tools_download(false, true));
    }

    #[test]
    fn a_simulator_window_is_matched_by_bundle_and_title_and_must_be_the_only_one() {
        assert!(window_matches("iPhone 16 Pro", "iPhone 16 Pro – Booted"));
        assert!(window_matches("iPhone 16 Pro", "iPhone 16 Pro"));
        assert!(window_matches("iPhone 16 Pro", "iPhone 16 Pro (Booted)"));
        assert!(!window_matches("iPhone 16 Pro", "iPhone 16 Pro Max"));
        let windows = [
            ("com.apple.iphonesimulator", "iPhone 16 Pro"),
            ("com.apple.dt.Devices", "iPhone 16"),
            ("com.example.other", "iPhone 16 Pro"),
        ];
        assert_eq!(
            choose_window(&windows, "iPhone 16 Pro"),
            WindowChoice::One(0)
        );
        let two = [
            ("com.apple.iphonesimulator", "iPhone 16 Pro"),
            ("com.apple.dt.Devices", "iPhone 16 Pro - Booted"),
        ];
        assert_eq!(choose_window(&two, "iPhone 16 Pro"), WindowChoice::Many);
        assert_eq!(choose_window(&windows, "iPad"), WindowChoice::None);
        assert_eq!(failure_code(ambiguous_window()).0, Code::Busy);
        assert_eq!(failure_code(window_not_found()).0, Code::NotFound);
    }

    #[test]
    fn an_android_live_view_needs_a_booted_device_and_a_enabled_capture() {
        assert!(android_booted(Some("emulator-5554"), true).is_ok());
        assert_eq!(
            failure_code(android_booted(None, true).expect_err("refused")).0,
            Code::NotBooted
        );
        assert_eq!(
            failure_code(android_booted(Some("emulator-5554"), false).expect_err("refused")).0,
            Code::NotBooted
        );
        assert!(android_capture_enabled(false));
        assert!(!android_capture_enabled(true));
        let (code, message) = failure_code(android_live_view_error(
            "scrcpy-server couldn't be downloaded",
        ));
        assert_eq!(code, Code::NotSupported);
        assert_eq!(
            message,
            "The Android live view needs scrcpy-server: scrcpy-server couldn't be downloaded"
        );
        assert_eq!(
            failure_code(helper_video_unavailable()).0,
            Code::ToolMissing
        );
    }
}
