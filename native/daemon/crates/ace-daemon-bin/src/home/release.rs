// SPDX-License-Identifier: Apache-2.0
//! Carrying an `install.sh` release across a fresh start
//! (`packages/service/src/home-release.ts`): the program is not data, so it moves
//! back into the fresh home and keeps running, while the old data stays in the
//! backup. Nothing is executed; the pointers and metadata are only read.
//!
//! The launcher must be byte for byte what `renderLauncher(home)` writes: it names
//! the home it was installed for, so it is correct again once moved back, and a
//! launcher written for another home (or by another install shape) is left alone.
//! On Windows the launcher is `ace.cmd`, the same file for every home, and
//! `current` is a pointer file rather than a symlink (ADR 0095).
//!
//! TypeScript cases ported: `packages/service/src/home-release.process.test.ts`
//! ("a fresh start keeps the installed release", "a half-applied update is not
//! carried", "a launcher installed for another home is not carried").

use std::path::Path;

/// The installation entries an `install.sh` home keeps beside its data.
const INSTALLATION: [&str; 4] = ["releases", "current", "previous", "bin"];

/// The launcher's host, so both shapes are testable anywhere.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    /// `bin/ace`, a `/bin/sh` script whose `ACE_HOME` names the home.
    Unix,
    /// `bin\ace.cmd`, which finds the home above itself.
    Windows,
}

impl Platform {
    pub fn current() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else {
            Self::Unix
        }
    }
}

/// `ReleaseTarget`.
const TARGETS: [&str; 6] = [
    "darwin-arm64",
    "darwin-x64",
    "linux-arm64",
    "linux-x64",
    "win32-x64",
    "win32-arm64",
];

/// `carryRelease`: moves the release from `backup` into `home`, returning its
/// version, or none when the backup holds no release this build would run.
pub fn carry(backup: &Path, home: &Path) -> Option<String> {
    let version = carried_version(backup, home, Platform::current())?;
    for name in INSTALLATION {
        if present(&backup.join(name)) && !present(&home.join(name)) {
            let _ = std::fs::rename(backup.join(name), home.join(name));
        }
    }
    Some(version)
}

/// `carriedVersion`: the release's version when its pointer, release metadata and
/// launcher are exactly what the installer writes for `home`, and no update is
/// half applied.
pub fn carried_version(backup: &Path, home: &Path, platform: Platform) -> Option<String> {
    if present(&backup.join("update.json")) {
        return None;
    }
    let target = release_target(backup, platform)?;
    let metadata = std::fs::read(backup.join(&target).join("release.json")).ok()?;
    let metadata = &metadata[..metadata.len().min(16 * 1024)];
    let release: serde_json::Value = serde_json::from_slice(metadata).ok()?;
    // `InstalledRelease.parse`: the version, channel and target a release manifest needs.
    let version = release.get("version")?.as_str()?;
    let channel = release.get("channel")?.as_str()?;
    let name = release.get("target")?.as_str()?;
    if !release_version(version)
        || !matches!(channel, "stable" | "preview")
        || !TARGETS.contains(&name)
    {
        return None;
    }
    if target != format!("releases/{version}-{name}") {
        return None;
    }
    let launcher =
        std::fs::read_to_string(backup.join("bin").join(launcher_name(platform))).ok()?;
    // `slice(0, 8192)` compared with the rendered launcher: exact bytes, never a
    // substring, so `~/.ace2`'s launcher (or an older script) is not carried.
    let head = &launcher.as_bytes()[..launcher.len().min(8192)];
    if head != render_launcher(home, platform)?.as_bytes() {
        return None;
    }
    Some(version.to_owned())
}

/// `renderLauncher`: the launcher `install.sh` writes for `home`. `None` when the
/// home cannot be written into a launcher (`renderLauncher` throws).
pub fn render_launcher(home: &Path, platform: Platform) -> Option<String> {
    match platform {
        Platform::Windows => Some(cmd_launcher()),
        Platform::Unix => {
            let home = home.to_string_lossy();
            if home.contains(['\r', '\n', '\0']) {
                return None;
            }
            // `shell()`: single quotes around the path, a quote escaped as `'\''`.
            let quoted = format!("'{}'", home.replace('\'', "'\\''"));
            Some(format!(
                "#!/bin/sh\nACE_HOME={quoted}\nexport ACE_HOME\ntarget=$(readlink \"$ACE_HOME/current\")\ncase \"$target\" in releases/*) ;; *) exit 1;; esac\nartifact=\"$ACE_HOME/$target\"\nexec \"$artifact/bin/node\" \"$artifact/ace.mjs\" \"$@\"\n"
            ))
        }
    }
}

/// The launcher's name inside the home's `bin` directory.
fn launcher_name(platform: Platform) -> &'static str {
    match platform {
        Platform::Unix => "ace",
        Platform::Windows => "ace.cmd",
    }
}

/// `renderCmdLauncher`: Windows' launcher, the same file for every home. cmd.exe
/// reads batch files in the OEM code page, so the home comes from the script's own
/// folder instead of being written into the file.
fn cmd_launcher() -> String {
    [
        "@echo off",
        "setlocal DisableDelayedExpansion",
        "for %%I in (\"%~dp0..\") do set \"ACE_HOME=%%~fI\"",
        "findstr /r /x /c:\"releases/[0123456789abcdefghijklmnopqrstuvwxyz.-]*\" <\"%ACE_HOME%\\current\" >nul 2>nul || exit /b 1",
        "findstr /r /x /v /c:\"releases/[0123456789abcdefghijklmnopqrstuvwxyz.-]*\" <\"%ACE_HOME%\\current\" >nul 2>nul && exit /b 1",
        "findstr /l /c:\"..\" <\"%ACE_HOME%\\current\" >nul 2>nul && exit /b 1",
        "set \"ACE_RELEASE_DIR=\"",
        "set /p ACE_RELEASE_DIR=<\"%ACE_HOME%\\current\"",
        "set \"ACE_RELEASE_DIR=%ACE_HOME%\\%ACE_RELEASE_DIR:/=\\%\"",
        "\"%ACE_RELEASE_DIR%\\bin\\node.exe\" \"%ACE_RELEASE_DIR%\\ace.mjs\" %*",
        "exit /b %ERRORLEVEL%",
        "",
    ]
    .join("\r\n")
}

/// The `releases/<version>-<target>` a `current` pointer names: a symlink on
/// macOS and Linux, a pointer file on Windows.
fn release_target(backup: &Path, platform: Platform) -> Option<String> {
    let current = backup.join("current");
    let text = match platform {
        Platform::Unix => {
            let metadata = std::fs::symlink_metadata(&current).ok()?;
            if !metadata.file_type().is_symlink() {
                return None;
            }
            std::fs::read_link(&current)
                .ok()?
                .to_string_lossy()
                .into_owned()
        }
        Platform::Windows => {
            let text = std::fs::read_to_string(&current).ok()?;
            // `pointerText(slice(0, 256))`: one trailing CRLF is the terminator.
            let head = &text[..text.len().min(256)];
            head.strip_suffix("\r\n").unwrap_or(head).to_owned()
        }
    };
    // `ReleaseDirectory.parse`: `releases/` then a version then `-` then a target.
    let rest = text.strip_prefix("releases/")?;
    TARGETS
        .iter()
        .any(|name| {
            rest.strip_suffix(&format!("-{name}"))
                .is_some_and(release_version)
        })
        .then_some(text)
}

/// `ReleaseVersion`: `\d+\.\d+\.\d+(?:-[a-z0-9.]+)?`, at most 80 characters.
fn release_version(version: &str) -> bool {
    if version.is_empty() || version.len() > 80 {
        return false;
    }
    let (core, suffix) = match version.split_once('-') {
        Some((core, suffix)) => (core, Some(suffix)),
        None => (version, None),
    };
    let parts: Vec<&str> = core.split('.').collect();
    if parts.len() != 3
        || !parts
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
    {
        return false;
    }
    suffix.is_none_or(|suffix| {
        !suffix.is_empty()
            && suffix
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'.')
    })
}

/// `present`: anything at the path, a dangling pointer included.
fn present(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok()
}

#[cfg(test)]
mod tests {
    use super::{Platform, release_version, render_launcher};

    /// `ReleaseVersion`'s pattern and length.
    #[test]
    fn a_release_version_is_three_numbers_and_an_optional_tag() {
        for good in ["1.2.3", "0.0.24", "1.2.3-rc.1", "12.34.56-beta"] {
            assert!(release_version(good), "{good}");
        }
        for bad in [
            "", "1.2", "1.2.3.4", "v1.2.3", "1.2.3-RC", "1.2.3-", "a.b.c",
        ] {
            assert!(!release_version(bad), "{bad}");
        }
        assert!(!release_version(&format!("1.2.3-{}", "a".repeat(80))));
    }

    /// `renderLauncher` (POSIX): the script's exact bytes, a quote escaped as `'\''`.
    #[test]
    fn the_unix_launcher_is_the_typescripts_exact_script() {
        let home = std::path::Path::new("/Users/me/it's/.ace");
        assert_eq!(
            render_launcher(home, Platform::Unix).as_deref(),
            Some(
                "#!/bin/sh\nACE_HOME='/Users/me/it'\\''s/.ace'\nexport ACE_HOME\ntarget=$(readlink \"$ACE_HOME/current\")\ncase \"$target\" in releases/*) ;; *) exit 1;; esac\nartifact=\"$ACE_HOME/$target\"\nexec \"$artifact/bin/node\" \"$artifact/ace.mjs\" \"$@\"\n"
            )
        );
    }

    /// `renderCmdLauncher`: the batch file's exact bytes, the same for every home.
    #[test]
    fn the_windows_launcher_is_the_typescripts_exact_script() {
        assert_eq!(
            render_launcher(
                std::path::Path::new("C:\\Users\\me\\.ace"),
                Platform::Windows
            )
            .as_deref(),
            Some(
                "@echo off\r\nsetlocal DisableDelayedExpansion\r\nfor %%I in (\"%~dp0..\") do set \"ACE_HOME=%%~fI\"\r\nfindstr /r /x /c:\"releases/[0123456789abcdefghijklmnopqrstuvwxyz.-]*\" <\"%ACE_HOME%\\current\" >nul 2>nul || exit /b 1\r\nfindstr /r /x /v /c:\"releases/[0123456789abcdefghijklmnopqrstuvwxyz.-]*\" <\"%ACE_HOME%\\current\" >nul 2>nul && exit /b 1\r\nfindstr /l /c:\"..\" <\"%ACE_HOME%\\current\" >nul 2>nul && exit /b 1\r\nset \"ACE_RELEASE_DIR=\"\r\nset /p ACE_RELEASE_DIR=<\"%ACE_HOME%\\current\"\r\nset \"ACE_RELEASE_DIR=%ACE_HOME%\\%ACE_RELEASE_DIR:/=\\%\"\r\n\"%ACE_RELEASE_DIR%\\bin\\node.exe\" \"%ACE_RELEASE_DIR%\\ace.mjs\" %*\r\nexit /b %ERRORLEVEL%\r\n"
            )
        );
    }
}
