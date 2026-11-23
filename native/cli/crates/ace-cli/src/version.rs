// SPDX-License-Identifier: Apache-2.0
//! This build's version, read the way `doctor/install.ts` reads it (ADR 0178 §5): a stamped
//! `ACE_VERSION`, the release folder the binary sits in, the desktop app that bundles it, else
//! `development`.

use std::path::{Component, Path, PathBuf};

/// A release version: `0.0.25` or `0.0.25-beta.3`, at most 80 bytes.
#[must_use]
pub fn is_release_version(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() > 80 {
        return false;
    }
    let mut parts = 0;
    let mut digits = 0;
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        if byte.is_ascii_digit() {
            digits += 1;
            index += 1;
        } else if byte == b'.' && digits > 0 && parts < 2 {
            parts += 1;
            digits = 0;
            index += 1;
        } else {
            break;
        }
    }
    if parts != 2 || digits == 0 {
        return false;
    }
    if index == bytes.len() {
        return true;
    }
    // `-prerelease`: one or more of a-z, 0-9 and dots.
    if bytes[index] != b'-' {
        return false;
    }
    index += 1;
    let start = index;
    while index < bytes.len() {
        let byte = bytes[index];
        if !byte.is_ascii_lowercase() && !byte.is_ascii_digit() && byte != b'.' {
            return false;
        }
        index += 1;
    }
    index > start
}

/// This process's version. The binary's own path is only read when no `ACE_VERSION` is stamped,
/// so help and version touch no file system at all in a release.
#[must_use]
pub fn current() -> String {
    let stamped = std::env::var("ACE_VERSION").ok();
    if stamped.is_some() {
        return version(stamped.as_deref(), Path::new(""));
    }
    let exe = std::env::current_exe().unwrap_or_default();
    version(None, &exe)
}

/// The version the binary was built or installed as.
#[must_use]
pub fn version(stamped: Option<&str>, exe: &Path) -> String {
    if let Some(stamped) = stamped {
        return if is_release_version(stamped) {
            stamped.to_owned()
        } else {
            "development".to_owned()
        };
    }
    if let Some(release) = release_version(exe) {
        return release;
    }
    if let Some(version) = bundled_version(exe) {
        return version;
    }
    "development".to_owned()
}

/// `…/releases/<version>-<target>/bin/ace` names its own release.
fn release_version(exe: &Path) -> Option<String> {
    let components: Vec<String> = exe
        .components()
        .filter_map(|component| match component {
            Component::Normal(name) => Some(name.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect();
    let position = components
        .iter()
        .position(|component| component == "releases")?;
    let directory = components.get(position + 1)?;
    for target in ["darwin", "linux", "win32"] {
        if let Some((version, _)) = directory.rsplit_once(&format!("-{target}-")) {
            return is_release_version(version).then(|| version.to_owned());
        }
    }
    None
}

/// The desktop app a binary in `Contents/Resources/bin` belongs to.
fn bundled_version(exe: &Path) -> Option<String> {
    let contents = app_contents(exe)?;
    let marker = contents
        .join("Resources")
        .join("daemon")
        .join("desktop-app.json");
    if let Some(version) = read_desktop_app(&marker) {
        return Some(version);
    }
    read_info_plist(&contents.join("Info.plist"))
}

fn app_contents(exe: &Path) -> Option<PathBuf> {
    let mut path = exe.to_path_buf();
    // `…/ace.app/Contents/Resources/bin/ace` → `…/ace.app/Contents`.
    for _ in 0..3 {
        path.pop();
    }
    path.file_name()
        .is_some_and(|name| name == "Contents")
        .then_some(path)
}

/// `{ "version": "0.0.25" }` beside the bundled daemon.
fn read_desktop_app(path: &Path) -> Option<String> {
    #[derive(serde::Deserialize)]
    struct DesktopApp {
        version: String,
    }
    let text = std::fs::read_to_string(path).ok()?;
    let app: DesktopApp = serde_json::from_str(&text).ok()?;
    is_release_version(&app.version).then_some(app.version)
}

const BUNDLE_ID: &str = "dev.ace.app";

/// The version a macOS `Info.plist` records, when the bundle is ace's own.
fn read_info_plist(path: &Path) -> Option<String> {
    let text = read_head(path, 64 * 1024)?;
    if plist_string(&text, "CFBundleIdentifier")? != BUNDLE_ID {
        return None;
    }
    let version = plist_string(&text, "CFBundleShortVersionString")?;
    is_release_version(version).then(|| version.to_owned())
}

fn read_head(path: &Path, limit: u64) -> Option<String> {
    use std::io::Read as _;
    let file = std::fs::File::open(path).ok()?;
    let mut bytes = Vec::new();
    file.take(limit).read_to_end(&mut bytes).ok()?;
    String::from_utf8(bytes).ok()
}

/// A string key from an XML plist, or `None` when it's missing or not a plain string.
fn plist_string<'a>(text: &'a str, key: &str) -> Option<&'a str> {
    let open = format!("<key>{key}</key>");
    let start = text.find(&open)? + open.len();
    let rest = text[start..].trim_start();
    let rest = rest.strip_prefix("<string>")?;
    let end = rest.find('<')?;
    let value = rest[..end].trim();
    (!value.is_empty() && value.len() <= 200).then_some(value)
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{is_release_version, release_version};

    #[test]
    fn release_versions_are_the_shapes_the_version_comparator_reads() {
        for version in ["0.0.25", "0.0.25-beta.3", "1.2.3-rc.1", "12.0.300"] {
            assert!(is_release_version(version), "{version} should be a release");
        }
        for version in [
            "development",
            "0.0",
            "0.0.25-",
            "0.0.25-Beta",
            "v0.0.25",
            "1.2",
        ] {
            assert!(
                !is_release_version(version),
                "{version} should not be a release"
            );
        }
        assert!(!is_release_version(&"1".repeat(81)));
    }

    #[test]
    fn a_release_folder_names_its_version() {
        for (path, version) in [
            (
                "/home/me/.ace/releases/0.0.25-darwin-arm64/bin/ace",
                "0.0.25",
            ),
            (
                "/srv/ace/releases/0.0.26-beta.1-linux-x64/bin/ace",
                "0.0.26-beta.1",
            ),
        ] {
            assert_eq!(
                release_version(Path::new(path)).as_deref(),
                Some(version),
                "{path}"
            );
        }
        #[cfg(windows)]
        assert_eq!(
            release_version(Path::new(
                "C:\\Users\\me\\.ace\\releases\\0.0.27-win32-x64\\bin\\ace.exe"
            ))
            .as_deref(),
            Some("0.0.27")
        );
        assert_eq!(release_version(Path::new("/tmp/target/release/ace")), None);
    }
}
