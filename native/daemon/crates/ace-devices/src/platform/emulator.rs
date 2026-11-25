// SPDX-License-Identifier: Apache-2.0
//! `emulator-discovery.ts`: where running emulators describe themselves, and which of them
//! serves the gRPC endpoint ace may encode from. The caller lists the directory and reads the
//! files; the parse and the choice happen here.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// One `pid_<pid>.ini` file as the emulator wrote it.
#[derive(Debug, Clone, Deserialize)]
pub struct DiscoveryFile {
    pub name: String,
    pub text: String,
}

/// An emulator's gRPC endpoint: localhost, behind its own console token.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Grpc {
    pub port: u16,
    pub token: String,
}

/// `emulatorRunningDirectory`: the discovery directory by host OS, `None` where there is none.
pub fn running_directory(
    platform: &str,
    home: &str,
    env: &std::collections::BTreeMap<String, String>,
) -> Option<PathBuf> {
    match platform {
        "darwin" => Some(PathBuf::from(home).join("Library/Caches/TemporaryItems/avd/running")),
        "win32" => env.get("LOCALAPPDATA").map(|local| {
            PathBuf::from(local)
                .join("Temp")
                .join("avd")
                .join("running")
        }),
        "linux" => Some(match env.get("XDG_RUNTIME_DIR") {
            Some(runtime) => PathBuf::from(runtime).join("avd").join("running"),
            None => PathBuf::from("/tmp")
                .join(format!(
                    "android-{}",
                    env.get("USER").map(String::as_str).unwrap_or("unknown")
                ))
                .join("avd")
                .join("running"),
        }),
        _ => None,
    }
}

/// `discoveryEntries`: one file's `key=value` lines; a later line for a key replaces the value
/// in its place, as a JavaScript `Map` does.
pub fn discovery_entries(text: &str) -> Vec<(String, String)> {
    let mut entries: Vec<(String, String)> = Vec::new();
    for line in text.split('\n') {
        let Some(at) = line.find('=') else {
            continue;
        };
        if at == 0 {
            continue;
        }
        let key = line[..at].trim().to_string();
        let value = line[at + 1..].trim().to_string();
        match entries.iter_mut().find(|(name, _)| *name == key) {
            Some(entry) => entry.1 = value,
            None => entries.push((key, value)),
        }
    }
    entries
}

fn value<'a>(entries: &'a [(String, String)], key: &str) -> Option<&'a str> {
    entries
        .iter()
        .find(|(name, _)| name == key)
        .map(|(_, value)| value.as_str())
}

/// `emulatorConsolePort`: `emulator-5554` is console port 5554; another serial reaches no
/// emulator console.
pub fn console_port(serial: &str) -> Option<u16> {
    let digits = serial.strip_prefix("emulator-")?;
    if !(4..=5).contains(&digits.len()) || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

/// `emulatorBootArgs`: the command line ace boots an emulator with. macOS serves its screen over
/// gRPC on the console port plus 3000; without a window the GPU mode is named for the host
/// (`host` on macOS, `auto` on Linux) unless the person set one.
pub fn boot_args(
    avd: &str,
    port: u16,
    window: bool,
    platform: &str,
    gpu: Option<&str>,
) -> Vec<String> {
    let mut args = vec![
        "-avd".to_string(),
        avd.to_string(),
        "-port".to_string(),
        port.to_string(),
    ];
    if platform == "darwin" {
        args.push("-grpc".to_string());
        args.push((u32::from(port) + 3000).to_string());
        args.push("-grpc-use-token".to_string());
    }
    let mode = emulator_gpu(gpu).or_else(|| {
        if window {
            None
        } else {
            default_gpu(platform).map(str::to_string)
        }
    });
    if !window {
        args.push("-no-window".to_string());
        args.push("-no-boot-anim".to_string());
    }
    if let Some(mode) = mode
        && mode != "none"
    {
        args.push("-gpu".to_string());
        args.push(mode);
    }
    args
}

/// A `-gpu` mode as the person set it, when it is one the emulator could take.
fn emulator_gpu(value: Option<&str>) -> Option<String> {
    let mode = value?.trim().to_lowercase();
    if (1..=32).contains(&mode.len())
        && mode
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte == b'_')
    {
        Some(mode)
    } else {
        None
    }
}

fn default_gpu(platform: &str) -> Option<&'static str> {
    match platform {
        "darwin" => Some("host"),
        "linux" => Some("auto"),
        _ => None,
    }
}

/// What one discovery file says about the emulator ace is asking about.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GrpcMatch {
    /// Another emulator wrote it, or it is not a `pid_<pid>.ini` at all.
    NotThisDevice,
    /// It names this emulator, and the endpoint it describes is not one ace may use.
    Unusable,
    Endpoint(Grpc),
}

/// `emulatorGrpc` for one file: the shell reads discovery files in order and stops at the first
/// match, so a later unrelated file (a FIFO, an unreadable one) is never opened.
pub fn grpc_file(console_port: u16, file: &DiscoveryFile) -> GrpcMatch {
    let Some(pid) = file
        .name
        .strip_prefix("pid_")
        .and_then(|rest| rest.strip_suffix(".ini"))
    else {
        return GrpcMatch::NotThisDevice;
    };
    if pid.is_empty() || !pid.bytes().all(|byte| byte.is_ascii_digit()) {
        return GrpcMatch::NotThisDevice;
    }
    let entries = discovery_entries(&file.text);
    let Some(serial) = value(&entries, "port.serial") else {
        return GrpcMatch::NotThisDevice;
    };
    if serial.parse::<u16>().ok() != Some(console_port) {
        return GrpcMatch::NotThisDevice;
    }
    let Some(port) = value(&entries, "grpc.port").and_then(|text| text.parse::<u16>().ok()) else {
        return GrpcMatch::Unusable;
    };
    if port == 0 {
        return GrpcMatch::Unusable;
    }
    let token = value(&entries, "grpc.token").unwrap_or_default();
    if token.is_empty() {
        return GrpcMatch::Unusable;
    }
    GrpcMatch::Endpoint(Grpc {
        port,
        token: token.to_string(),
    })
}

/// `emulatorGrpc`: the gRPC endpoint of the emulator on console port `console_port`, from the
/// first discovery file that names that port. An emulator with JWT authentication (Android
/// Studio's default), without gRPC, or with an unreadable endpoint has none ace can use.
pub fn grpc_endpoint(console_port: u16, files: &[DiscoveryFile]) -> Option<Grpc> {
    for file in files {
        match grpc_file(console_port, file) {
            GrpcMatch::NotThisDevice => continue,
            GrpcMatch::Unusable => return None,
            GrpcMatch::Endpoint(grpc) => return Some(grpc),
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(name: &str, text: &str) -> DiscoveryFile {
        DiscoveryFile {
            name: name.to_string(),
            text: text.to_string(),
        }
    }

    fn env(pairs: &[(&str, &str)]) -> std::collections::BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect()
    }

    #[test]
    fn a_grpc_endpoint_is_read_from_the_discovery_file_of_its_console_port() {
        let files = [
            file(
                "pid_100.ini",
                "port.serial=5554\ngrpc.port=8554\ngrpc.token=one\n",
            ),
            file(
                "pid_200.ini",
                "port.serial=5556\ngrpc.port=8556\ngrpc.token=two\n",
            ),
            file("notes.txt", "port.serial=5558\n"),
        ];
        assert_eq!(
            grpc_endpoint(console_port("emulator-5556").expect("console port"), &files),
            Some(Grpc {
                port: 8556,
                token: "two".to_string(),
            })
        );
    }

    #[test]
    fn an_emulator_without_a_token_or_without_grpc_has_no_endpoint_ace_uses() {
        let files = [
            file(
                "pid_100.ini",
                "port.serial=5554\ngrpc.port=8554\ngrpc.jwks=/tmp/jwks\n",
            ),
            file("pid_200.ini", "port.serial=5556\n"),
        ];
        assert_eq!(grpc_endpoint(5554, &files), None);
        assert_eq!(grpc_endpoint(5556, &files), None);
        assert_eq!(grpc_endpoint(5560, &files), None);
        assert_eq!(grpc_endpoint(5554, &[]), None);
    }

    #[test]
    fn an_endpoint_outside_the_port_range_is_not_used() {
        let files = [
            file("pid_1.ini", "port.serial=5554\ngrpc.port=0\ngrpc.token=t\n"),
            file(
                "pid_2.ini",
                "port.serial=5556\ngrpc.port=70000\ngrpc.token=t\n",
            ),
        ];
        assert_eq!(grpc_endpoint(5554, &files), None);
        assert_eq!(grpc_endpoint(5556, &files), None);
    }

    #[test]
    fn only_a_pid_files_digits_name_an_emulator() {
        assert_eq!(console_port("emulator-5554"), Some(5554));
        assert_eq!(console_port("emulator-55545"), Some(55545));
        assert_eq!(console_port("emulator-555"), None);
        assert_eq!(console_port("emulator-555555"), None);
        assert_eq!(console_port("R5CT1234"), None);
        assert_eq!(console_port("emulator-55a4"), None);
    }

    #[test]
    fn emulators_describe_themselves_where_each_os_keeps_them() {
        assert_eq!(
            running_directory("darwin", "/Users/a", &env(&[])),
            Some(PathBuf::from(
                "/Users/a/Library/Caches/TemporaryItems/avd/running"
            ))
        );
        assert_eq!(
            running_directory(
                "linux",
                "/home/a",
                &env(&[("XDG_RUNTIME_DIR", "/run/user/1000")])
            ),
            Some(PathBuf::from("/run/user/1000/avd/running"))
        );
        assert_eq!(
            running_directory("linux", "/home/a", &env(&[("USER", "a")])),
            Some(PathBuf::from("/tmp/android-a/avd/running"))
        );
        assert_eq!(
            running_directory(
                "win32",
                "C:/Users/a",
                &env(&[("LOCALAPPDATA", "C:/Users/a/AppData/Local")])
            ),
            Some(PathBuf::from("C:/Users/a/AppData/Local/Temp/avd/running"))
        );
        assert_eq!(running_directory("win32", "C:/Users/a", &env(&[])), None);
        assert_eq!(running_directory("freebsd", "/home/a", &env(&[])), None);
    }

    #[test]
    fn an_emulator_boots_without_a_window_and_a_named_gpu_mode() {
        assert_eq!(
            boot_args("Pixel_API_35", 5554, false, "darwin", None),
            vec![
                "-avd",
                "Pixel_API_35",
                "-port",
                "5554",
                "-grpc",
                "8554",
                "-grpc-use-token",
                "-no-window",
                "-no-boot-anim",
                "-gpu",
                "host",
            ]
        );
        assert_eq!(
            boot_args("Pixel_API_35", 5556, false, "linux", Some(" SwiftShader ")),
            vec![
                "-avd",
                "Pixel_API_35",
                "-port",
                "5556",
                "-no-window",
                "-no-boot-anim",
                "-gpu",
                "swiftshader",
            ]
        );
    }

    #[test]
    fn a_window_keeps_the_emulators_gpu_choice_unless_the_person_names_one() {
        assert_eq!(
            boot_args("Pixel_API_35", 5554, true, "darwin", None),
            vec!["-avd", "Pixel_API_35", "-port", "5554", "-grpc", "8554", "-grpc-use-token"]
        );
        assert_eq!(
            boot_args("Pixel_API_35", 5554, true, "win32", Some("none")),
            vec!["-avd", "Pixel_API_35", "-port", "5554"]
        );
        assert_eq!(
            boot_args("Pixel_API_35", 5554, false, "linux", Some("not a mode")),
            vec![
                "-avd",
                "Pixel_API_35",
                "-port",
                "5554",
                "-no-window",
                "-no-boot-anim",
                "-gpu",
                "auto",
            ]
        );
    }

    #[test]
    fn one_discovery_file_says_whether_it_names_this_emulator_at_all() {
        let ours = file(
            "pid_100.ini",
            "port.serial=5554\ngrpc.port=8554\ngrpc.token=one\n",
        );
        assert_eq!(
            grpc_file(5554, &ours),
            GrpcMatch::Endpoint(Grpc {
                port: 8554,
                token: "one".to_string(),
            })
        );
        assert_eq!(grpc_file(5556, &ours), GrpcMatch::NotThisDevice);
        assert_eq!(
            grpc_file(5554, &file("pid_100.ini", "port.serial=5554\n")),
            GrpcMatch::Unusable
        );
        assert_eq!(
            grpc_file(5554, &file("notes.txt", "port.serial=5554\ngrpc.token=t\n")),
            GrpcMatch::NotThisDevice
        );
    }

    #[test]
    fn a_key_that_repeats_keeps_its_first_place_and_its_last_value() {
        let entries = discovery_entries("a=1\nb=2\na=3\n\ntext\nc=\n");
        assert_eq!(
            entries,
            vec![
                ("a".to_string(), "3".to_string()),
                ("b".to_string(), "2".to_string()),
                ("c".to_string(), String::new()),
            ]
        );
    }
}
