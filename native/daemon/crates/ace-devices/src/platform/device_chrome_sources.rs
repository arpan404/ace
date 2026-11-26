// SPDX-License-Identifier: Apache-2.0
//! `device-chrome-sources.ts`: where this machine keeps device looks, and the bounds a read
//! respects. Xcode's DeviceKit chrome bundles, the AVD folders, and the size past which a file
//! is not device art are all decided here; the shell reads and draws.

use std::collections::BTreeMap;

use super::paths::join;

/// Files the chrome reads are small; anything bigger isn't device art.
pub const FILE_LIMIT: usize = 4 * 1024 * 1024;

/// The longest side a PNG look image is drawn at, in pixels, and how many pixels a body unit is
/// drawn as (a phone's points at 3×).
pub const PNG_LONGEST: u32 = 2400;
pub const PNG_PER_UNIT: u32 = 3;
/// A data URL this long or longer travels badly in one message; draw smaller instead.
pub const BODY_URL_LIMIT: usize = 900_000;

/// The AVD folders looked in, in order: the environment's own, then the user's. Duplicates are
/// dropped and empty entries ignored.
pub fn avd_roots(env: &BTreeMap<String, String>, home: &str) -> Vec<String> {
    // An empty variable names no folder, as `userHome ? … : undefined` decides.
    let user_home = env.get("ANDROID_USER_HOME").filter(|root| !root.is_empty());
    let candidates = [
        env.get("ANDROID_AVD_HOME").cloned(),
        user_home.map(|root| join(&[root, "avd"])),
        Some(join(&[home, ".android/avd"])),
    ];
    let mut roots: Vec<String> = Vec::new();
    for candidate in candidates.into_iter().flatten() {
        if !candidate.is_empty() && !roots.contains(&candidate) {
            roots.push(candidate);
        }
    }
    roots
}

/// The directories Xcode keeps `*.devicechrome` bundles in, in order.
pub fn chrome_roots(home: &str) -> Vec<String> {
    vec![
        "/Library/Developer/DeviceKit/Chrome".to_string(),
        join(&[home, "Library/Developer/DeviceKit/Chrome"]),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(entries: &[(&str, &str)]) -> BTreeMap<String, String> {
        entries
            .iter()
            .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
            .collect()
    }

    #[test]
    fn the_avd_folders_are_the_environments_then_the_users_once() {
        assert_eq!(
            avd_roots(&env(&[("ANDROID_AVD_HOME", "/avds")]), "/home/a"),
            vec!["/avds".to_string(), "/home/a/.android/avd".to_string()]
        );
        assert_eq!(
            avd_roots(
                &env(&[
                    ("ANDROID_USER_HOME", "/android"),
                    ("ANDROID_AVD_HOME", "/android/avd")
                ]),
                "/home/a"
            ),
            vec![
                "/android/avd".to_string(),
                "/home/a/.android/avd".to_string()
            ]
        );
        assert_eq!(
            avd_roots(&env(&[]), "/home/a"),
            vec!["/home/a/.android/avd".to_string()]
        );
        // An empty `ANDROID_USER_HOME` names no folder, never a path relative to the cwd.
        assert_eq!(
            avd_roots(&env(&[("ANDROID_USER_HOME", "")]), "/home/a"),
            vec!["/home/a/.android/avd".to_string()]
        );
    }

    #[test]
    fn the_chrome_bundles_are_the_systems_then_the_users() {
        assert_eq!(
            chrome_roots("/home/a"),
            vec![
                "/Library/Developer/DeviceKit/Chrome".to_string(),
                "/home/a/Library/Developer/DeviceKit/Chrome".to_string()
            ]
        );
    }
}
