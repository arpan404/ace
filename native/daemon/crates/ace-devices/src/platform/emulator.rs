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

/// `emulatorGrpc`: the gRPC endpoint of the emulator on console port `console_port`, from the
/// first discovery file that names that port. An emulator with JWT authentication (Android
/// Studio's default), without gRPC, or with an unreadable endpoint has none ace can use.
pub fn grpc_endpoint(console_port: u16, files: &[DiscoveryFile]) -> Option<Grpc> {
    for file in files {
        let Some(pid) = file
            .name
            .strip_prefix("pid_")
            .and_then(|rest| rest.strip_suffix(".ini"))
        else {
            continue;
        };
        if pid.is_empty() || !pid.bytes().all(|byte| byte.is_ascii_digit()) {
            continue;
        }
        let entries = discovery_entries(&file.text);
        let Some(serial) = value(&entries, "port.serial") else {
            continue;
        };
        if serial.parse::<u16>().ok() != Some(console_port) {
            continue;
        }
        let port = value(&entries, "grpc.port").and_then(|text| text.parse::<u16>().ok())?;
        if port == 0 {
            return None;
        }
        let token = value(&entries, "grpc.token").unwrap_or_default();
        if token.is_empty() {
            return None;
        }
        return Some(Grpc {
            port,
            token: token.to_string(),
        });
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
