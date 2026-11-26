// SPDX-License-Identifier: Apache-2.0
//! Carrying an `install.sh` release across a fresh start
//! (`packages/service/src/home-release.ts`): the program is not data, so it moves
//! back into the fresh home and keeps running, while the old data stays in the
//! backup. Nothing is executed; the pointers and metadata are only read.
//!
//! TypeScript cases ported: `packages/service/src/home-release.process.test.ts`
//! ("a fresh start keeps the installed release", "a half-applied update is not
//! carried", "a launcher installed for another home is not carried").

use std::path::Path;

/// The installation entries an `install.sh` home keeps beside its data.
const INSTALLATION: [&str; 4] = ["releases", "current", "previous", "bin"];

/// `carryRelease`: moves the release from `backup` into `home`, returning its
/// version, or none when the backup holds no release this build would run.
pub fn carry(backup: &Path, home: &Path) -> Option<String> {
    let version = carried_version(backup, home)?;
    for name in INSTALLATION {
        if present(&backup.join(name)) && !present(&home.join(name)) {
            let _ = std::fs::rename(backup.join(name), home.join(name));
        }
    }
    Some(version)
}

/// `carriedVersion`: the release's version when its `current` pointer, release
/// metadata and launcher are what the installer writes for `home`, and no update
/// is half applied.
fn carried_version(backup: &Path, home: &Path) -> Option<String> {
    if present(&backup.join("update.json")) {
        return None;
    }
    let target = release_target(backup)?;
    let directory = backup.join(&target);
    let metadata = std::fs::read(directory.join("release.json")).ok()?;
    let metadata = &metadata[..metadata.len().min(16 * 1024)];
    let release: serde_json::Value = serde_json::from_slice(metadata).ok()?;
    let version = release.get("version")?.as_str()?.to_owned();
    let platform = release.get("target")?.as_str()?;
    if target != format!("releases/{version}-{platform}") {
        return None;
    }
    // The launcher names the home it was installed for, so it is correct again
    // once moved back; a launcher for another home is left alone.
    let launcher = std::fs::read_to_string(backup.join("bin/ace")).ok()?;
    if !launcher.contains(&home.display().to_string()) {
        return None;
    }
    Some(version)
}

/// The `releases/<version>-<target>` a `current` pointer names: a symlink on
/// macOS and Linux, a pointer file on Windows.
fn release_target(backup: &Path) -> Option<String> {
    let current = backup.join("current");
    let metadata = std::fs::symlink_metadata(&current).ok()?;
    let target = if metadata.file_type().is_symlink() {
        std::fs::read_link(&current)
            .ok()?
            .to_string_lossy()
            .into_owned()
    } else {
        std::fs::read_to_string(&current).ok()?.trim().to_owned()
    };
    target
        .strip_prefix("releases/")
        .filter(|name| name.contains('-') && !name.contains('/'))
        .map(|name| format!("releases/{name}"))
}

/// `present`: anything at the path, a dangling pointer included.
fn present(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok()
}
