// SPDX-License-Identifier: Apache-2.0
//! `sdk.ts`, `sdk-roots.ts` and `android-tools.ts`: where Xcode and the Android SDK are, which
//! tools ace runs, and the exact refusal when one is missing. The caller finds files on disk;
//! the choice and the words are decided here.

use std::collections::BTreeMap;
use std::path::Path;

use serde::Serialize;

use super::{Refusal, words};

/// An absolute SDK root, as `ANDROID_HOME` or Android Studio's default spells it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Roots(pub Vec<String>);

/// What one SDK root holds: adb from its `platform-tools`, the emulator from its `emulator`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FoundTools {
    pub adb: Option<String>,
    pub emulator: Option<String>,
}

/// The Android tools ace runs, by absolute path; a tool that was not found is absent.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct AndroidTools {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub adb: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub emulator: Option<String>,
}

/// `androidSdkRoots`: `ANDROID_HOME`, `ANDROID_SDK_ROOT`, Android Studio's folder on macOS and
/// Linux, and on Windows `%LOCALAPPDATA%\Android\Sdk`. Only absolute paths count; the first
/// spelling of a root wins.
pub fn android_sdk_roots(
    env: &BTreeMap<String, String>,
    home: Option<&str>,
    platform: &str,
) -> Vec<String> {
    let mut candidates: Vec<String> = Vec::new();
    for key in ["ANDROID_HOME", "ANDROID_SDK_ROOT"] {
        if let Some(value) = env.get(key) {
            candidates.push(value.clone());
        }
    }
    if let Some(home) = home {
        candidates.push(join(platform, home, &["Library", "Android", "sdk"]));
        candidates.push(join(platform, home, &["Android", "Sdk"]));
    }
    if platform == "win32"
        && let Some(local) = env.get("LOCALAPPDATA")
    {
        candidates.push(join(platform, local, &["Android", "Sdk"]));
    }
    let mut roots: Vec<String> = Vec::new();
    for candidate in candidates {
        if candidate.is_empty() || !is_absolute(platform, &candidate) {
            continue;
        }
        if !roots.contains(&candidate) {
            roots.push(candidate);
        }
    }
    roots
}

/// Node's `path.isAbsolute` for the host the decision is about, not the host that compiled it:
/// Windows accepts a drive root (`C:\sdk`, `C:/sdk`), a rooted `\sdk` or a UNC share; every
/// other platform accepts a leading `/`.
fn is_absolute(platform: &str, path: &str) -> bool {
    if platform != "win32" {
        return path.starts_with('/');
    }
    let bytes = path.as_bytes();
    match bytes {
        [drive, b':', separator, ..] => {
            drive.is_ascii_alphabetic() && (*separator == b'\\' || *separator == b'/')
        }
        [b'\\', b'\\', _, ..] => true,
        [b'\\', _, ..] => true,
        [b'/', _, ..] => true,
        _ => false,
    }
}

/// Node's `path.join` for the host the decision is about: Windows spells separators as `\`,
/// every other platform as `/`.
fn join(platform: &str, base: &str, parts: &[&str]) -> String {
    let separator = if platform == "win32" { '\\' } else { '/' };
    let mut path = if platform == "win32" {
        base.replace('/', "\\")
    } else {
        base.to_string()
    };
    for part in parts {
        path.push(separator);
        path.push_str(part);
    }
    path
}

/// `findAndroidTools`: an SDK holding both wins, so they come from one install; otherwise the
/// emulator from the first SDK that has it, and adb from the first SDK that has it or else from
/// PATH, as distributions install it.
pub fn choose_android_tools(found: &[FoundTools], path_adb: Option<String>) -> AndroidTools {
    if let Some(paired) = found
        .iter()
        .find(|root| root.adb.is_some() && root.emulator.is_some())
    {
        return AndroidTools {
            adb: paired.adb.clone(),
            emulator: paired.emulator.clone(),
        };
    }
    let emulator = found.iter().find_map(|root| root.emulator.clone());
    let adb = found.iter().find_map(|root| root.adb.clone()).or(path_adb);
    AndroidTools { adb, emulator }
}

/// `resolveAndroidSDK`: the tools when adb was found, else the refusal for this host: Google
/// publishes no emulator for Linux arm64, and Linux distributions ship adb on its own.
pub fn resolve_android_sdk(
    tools: &AndroidTools,
    platform: &str,
    arch: Option<&str>,
) -> Result<AndroidTools, Refusal> {
    if tools.adb.is_some() {
        return Ok(tools.clone());
    }
    if platform == "linux" && arch == Some("arm64") {
        return Err(words::refusal("adbMissingArm"));
    }
    if platform == "linux" {
        return Err(words::refusal("adbMissingLinux"));
    }
    Err(words::refusal("sdkMissing"))
}

/// `iosNeedsMac`: Windows can't run the iOS Simulator, said where people and agents look.
pub fn ios_needs_mac() -> Refusal {
    words::refusal("iosNeedsMac")
}

/// `armEmulatorNote`: said once where Google publishes no Android Emulator.
pub fn arm_emulator_note() -> Refusal {
    words::refusal("armEmulatorNote")
}

/// `resolveXcode`'s host refusal: Windows needs a paired Mac, every other non-Mac needs macOS.
pub fn xcode_host_refusal(platform: &str) -> Option<Refusal> {
    match platform {
        "darwin" => None,
        "win32" => Some(ios_needs_mac()),
        _ => Some(words::refusal("iosNeedsMacOs")),
    }
}

/// `resolveXcode`'s refusal when `xcode-select`, `xcrun` or `open` is missing.
pub fn xcode_tools_refusal() -> Refusal {
    words::refusal("xcodeMissing")
}

/// `resolveXcode`'s refusal when the selection probe itself could not run; today's `try` around
/// `probeOutput`, which is a different refusal from a probe that answered with a failing code.
pub fn xcode_probe_failure() -> Refusal {
    words::refusal("xcodeUnavailable")
}

/// `resolveXcode`'s check of `xcode-select -p`. `code` is the probe's exit code as it answered,
/// including `None` for a process killed before it could report one (today's `code !== 0`); a
/// CommandLineTools selection, a relative path, an answer over 4,096 units or a non-zero exit is
/// not a Simulator SDK.
pub fn xcode_selection(code: Option<i32>, stdout: &str) -> Result<(), Refusal> {
    // probeOutput trims; trimming again keeps the check honest for any caller.
    let selected = stdout.trim_end();
    let units = selected.chars().count();
    let absolute = Path::new(selected).is_absolute();
    if code != Some(0) || units > 4096 || !absolute || selected.ends_with("CommandLineTools") {
        return Err(words::refusal("xcodeNotFull"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect()
    }

    fn tool(path: &str) -> Option<String> {
        Some(path.to_string())
    }

    #[test]
    fn sdk_roots_prefer_the_environment_then_studios_folders_and_keep_only_absolute_paths() {
        let roots = android_sdk_roots(
            &env(&[
                ("ANDROID_HOME", "/opt/android"),
                ("ANDROID_SDK_ROOT", "/opt/android"),
                ("LOCALAPPDATA", "/local"),
            ]),
            Some("/home/a"),
            "darwin",
        );
        assert_eq!(
            roots,
            vec![
                "/opt/android".to_string(),
                "/home/a/Library/Android/sdk".to_string(),
                "/home/a/Android/Sdk".to_string(),
            ]
        );
    }

    #[test]
    fn a_relative_sdk_root_is_not_an_sdk_root() {
        let roots = android_sdk_roots(&env(&[("ANDROID_HOME", "relative/sdk")]), None, "darwin");
        assert!(roots.is_empty());
    }

    #[test]
    fn android_studios_localappdata_folder_counts_on_windows_and_nowhere_else() {
        // The host argument decides Windows' spelling, so this holds on every build host.
        let windows = android_sdk_roots(
            &env(&[("LOCALAPPDATA", "C:/Users/a/AppData/Local")]),
            None,
            "win32",
        );
        assert_eq!(
            windows,
            vec!["C:\\Users\\a\\AppData\\Local\\Android\\Sdk".to_string()]
        );
        let mac = android_sdk_roots(&env(&[("LOCALAPPDATA", "/local")]), None, "darwin");
        assert!(mac.is_empty());
    }

    #[test]
    fn windows_absolute_roots_keep_a_drive_rooting_even_when_the_test_host_is_not_windows() {
        for root in ["C:\\sdk", "C:/sdk", "\\\\server\\share\\sdk", "\\sdk"] {
            let roots = android_sdk_roots(&env(&[("ANDROID_HOME", root)]), None, "win32");
            assert_eq!(roots, vec![root.to_string()], "{root}");
        }
        for root in ["sdk", "C:sdk"] {
            assert!(
                android_sdk_roots(&env(&[("ANDROID_HOME", root)]), None, "win32").is_empty(),
                "{root}"
            );
        }
        assert_eq!(
            android_sdk_roots(&env(&[("ANDROID_HOME", "C:\\")]), None, "win32"),
            vec!["C:\\".to_string()]
        );
    }

    #[test]
    fn a_posix_absolute_root_is_a_leading_slash_and_nothing_else() {
        assert_eq!(
            android_sdk_roots(&env(&[("ANDROID_HOME", "/opt/android")]), None, "linux"),
            vec!["/opt/android".to_string()]
        );
        assert!(android_sdk_roots(&env(&[("ANDROID_HOME", "\\sdk")]), None, "darwin").is_empty());
    }

    #[test]
    fn an_sdk_holding_both_tools_wins_over_one_holding_either() {
        let found = [
            FoundTools {
                adb: tool("/one/platform-tools/adb"),
                emulator: None,
            },
            FoundTools {
                adb: tool("/two/platform-tools/adb"),
                emulator: tool("/two/emulator/emulator"),
            },
        ];
        assert_eq!(
            choose_android_tools(&found, None),
            AndroidTools {
                adb: tool("/two/platform-tools/adb"),
                emulator: tool("/two/emulator/emulator"),
            }
        );
    }

    #[test]
    fn adb_falls_back_to_path_while_the_emulator_comes_from_an_sdk() {
        let found = [FoundTools {
            adb: None,
            emulator: tool("/one/emulator/emulator"),
        }];
        assert_eq!(
            choose_android_tools(&found, tool("/usr/bin/adb")),
            AndroidTools {
                adb: tool("/usr/bin/adb"),
                emulator: tool("/one/emulator/emulator"),
            }
        );
    }

    #[test]
    fn a_host_without_adb_refuses_with_the_hint_that_fixes_it() {
        let none = AndroidTools::default();
        let arm = resolve_android_sdk(&none, "linux", Some("arm64")).expect_err("arm64");
        assert!(
            arm.hint.contains("apt install adb")
                && arm.hint.contains("aren't available on Linux arm64")
        );
        let linux = resolve_android_sdk(&none, "linux", Some("x64")).expect_err("linux");
        assert!(linux.hint.contains("Android Studio's Platform Tools"));
        let mac = resolve_android_sdk(&none, "darwin", Some("arm64")).expect_err("mac");
        assert_eq!(mac.message, "Android SDK platform-tools were not found");
    }

    #[test]
    fn adb_from_path_is_enough_for_phones_and_network_devices() {
        let tools = AndroidTools {
            adb: tool("/usr/bin/adb"),
            emulator: None,
        };
        assert_eq!(
            resolve_android_sdk(&tools, "linux", Some("arm64")).expect("adb"),
            tools
        );
    }

    #[test]
    fn xcode_sends_windows_to_a_paired_mac_and_other_nothing_hosts_to_a_mac_daemon() {
        assert_eq!(
            xcode_host_refusal("win32").expect("windows").message,
            "iOS Simulators need a paired Mac"
        );
        assert_eq!(
            xcode_host_refusal("linux").expect("linux").message,
            "iOS Simulator requires macOS"
        );
        assert_eq!(xcode_host_refusal("darwin"), None);
    }

    #[test]
    fn a_command_line_tools_selection_is_not_a_simulator_sdk() {
        let selected = xcode_selection(Some(0), "/Library/Developer/CommandLineTools\n")
            .expect_err("command line tools");
        assert_eq!(selected.message, "A full Xcode installation is required");
        let relative = xcode_selection(Some(0), "Xcode.app\n").expect_err("relative");
        assert_eq!(relative.code.as_str(), "sdk_missing");
        let failed = xcode_selection(Some(1), "/Applications/Xcode.app\n").expect_err("failed");
        assert_eq!(failed.message, "A full Xcode installation is required");
    }

    #[test]
    fn a_probe_that_could_not_run_and_a_full_selection_are_different_refusals() {
        assert_eq!(
            xcode_probe_failure().message,
            "Xcode developer directory is unavailable"
        );
        assert_eq!(
            xcode_selection(Some(0), "/Applications/Xcode.app/Contents/Developer\n"),
            Ok(())
        );
    }

    #[test]
    fn a_selection_probe_that_answered_without_an_exit_code_is_a_failed_selection() {
        // `probeOutput` resolves with `code: null` when the process was killed; today's
        // `code !== 0` treats that as a failed selection, not as a probe that never ran.
        let failed = xcode_selection(None, "/Applications/Xcode.app/Contents/Developer\n")
            .expect_err("null code");
        assert_eq!(failed.message, "A full Xcode installation is required");
    }

    #[test]
    fn an_answer_longer_than_the_4096_unit_schema_is_not_a_developer_directory() {
        let long = format!("/{}", "a".repeat(4096));
        assert_eq!(
            xcode_selection(Some(0), &long)
                .expect_err("over 4096")
                .message,
            "A full Xcode installation is required"
        );
        let longest = format!("/{}", "a".repeat(4095));
        assert_eq!(xcode_selection(Some(0), &longest), Ok(()));
    }

    #[test]
    fn xcode_selection_bounds_the_path_in_code_points() {
        for length in [4095, 4096] {
            let path = format!("/{}", "😀".repeat(length));
            assert_eq!(xcode_selection(Some(0), &path).is_ok(), length == 4095);
        }
    }
}
