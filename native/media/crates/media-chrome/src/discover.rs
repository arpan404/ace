// SPDX-License-Identifier: Apache-2.0
//! Finds a Chrome the way the daemon does (`packages/browser/src/discovery.ts`): an explicit
//! path, then `ACE_CHROMIUM_PATH`, then an installed Chrome or Chromium, then ace's own Chrome
//! for Testing in the data directory (`<dataDir>/chromium/<version>-<checksum>/`). The daemon
//! pins one version; here any verified download in that directory is taken, newest first, so
//! the version is not written down twice.

use std::path::{Path, PathBuf};

/// Where to look. Everything comes from the caller, so tests choose the environment.
#[derive(Clone, Debug, Default)]
pub struct ChromeSearch {
    pub explicit: Option<PathBuf>,
    /// `ACE_CHROMIUM_PATH`.
    pub env_path: Option<PathBuf>,
    /// `PATH`, split.
    pub path: Vec<PathBuf>,
    /// Windows: `PROGRAMFILES`, `PROGRAMFILES(X86)` and `LOCALAPPDATA`, where Chrome and Edge
    /// install.
    pub program_roots: Vec<PathBuf>,
    /// ace's data directory, holding `chromium/`.
    pub data_dir: Option<PathBuf>,
}

impl ChromeSearch {
    /// The search the process's own environment describes.
    pub fn from_env(data_dir: Option<PathBuf>) -> Self {
        Self {
            explicit: None,
            env_path: std::env::var_os("ACE_CHROMIUM_PATH").map(PathBuf::from),
            path: std::env::var_os("PATH")
                .map(|path| std::env::split_paths(&path).collect())
                .unwrap_or_default(),
            program_roots: ["PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"]
                .into_iter()
                .filter_map(std::env::var_os)
                .map(PathBuf::from)
                .collect(),
            data_dir,
        }
    }
}

/// The executable inside one Chrome for Testing download, for this platform.
fn testing_executable() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Some(
            "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        ),
        ("macos", "x86_64") => Some(
            "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        ),
        ("linux", "x86_64") => Some("chrome-linux64/chrome"),
        ("linux", "aarch64") => Some("chrome-linux-arm64/chrome"),
        ("windows", "x86_64") => Some("chrome-win64/chrome.exe"),
        _ => None,
    }
}

/// Candidates in the order they are tried. Pure apart from listing the data directory.
pub fn candidates(search: &ChromeSearch) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = [&search.explicit, &search.env_path]
        .into_iter()
        .flatten()
        .cloned()
        .collect();
    if cfg!(target_os = "macos") {
        out.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome".into());
        out.push("/Applications/Chromium.app/Contents/MacOS/Chromium".into());
    }
    if cfg!(windows) {
        for app in [
            "Google/Chrome/Application/chrome.exe",
            "Microsoft/Edge/Application/msedge.exe",
        ] {
            out.extend(search.program_roots.iter().map(|root| root.join(app)));
        }
    }
    let names: &[&str] = if cfg!(windows) {
        &["chrome.exe", "chromium.exe", "msedge.exe"]
    } else {
        &[
            "chromium",
            "chromium-browser",
            "google-chrome",
            "google-chrome-stable",
        ]
    };
    for root in &search.path {
        for name in names {
            out.push(root.join(name));
        }
    }
    if let (Some(data_dir), Some(executable)) = (&search.data_dir, testing_executable()) {
        out.extend(testing_downloads(&data_dir.join("chromium"), executable));
    }
    out
}

/// Verified downloads (`verified.json` present), newest version first.
fn testing_downloads(root: &Path, executable: &str) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut found: Vec<(Vec<u32>, PathBuf)> = entries
        .flatten()
        .filter(|entry| entry.path().join("verified.json").is_file())
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            let version = name.split('-').next()?;
            let parts = version
                .split('.')
                .map(str::parse)
                .collect::<Result<Vec<u32>, _>>()
                .ok()?;
            Some((parts, entry.path().join(executable)))
        })
        .collect();
    found.sort_by(|a, b| b.0.cmp(&a.0));
    found.into_iter().map(|(_, path)| path).collect()
}

fn runnable(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path)
            .is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
    }
    #[cfg(not(unix))]
    {
        path.is_file()
    }
}

/// The first runnable candidate.
pub fn find_chrome(search: &ChromeSearch) -> Option<PathBuf> {
    candidates(search).into_iter().find(|path| runnable(path))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "media-chrome-discover-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn explicit_and_env_paths_come_first_then_path_then_newest_verified_download()
    -> std::io::Result<()> {
        let Some(executable) = testing_executable() else {
            return Ok(());
        };
        let data = temp("order");
        for (name, verified) in [
            ("152.0.1.0-aa", true),
            ("153.0.8010.12-bb", true),
            ("154.0.0.0-cc", false),
        ] {
            let dir = data.join("chromium").join(name);
            std::fs::create_dir_all(&dir)?;
            if verified {
                std::fs::write(dir.join("verified.json"), "{}")?;
            }
        }
        let search = ChromeSearch {
            explicit: Some("/x/explicit".into()),
            env_path: Some("/x/env".into()),
            path: vec!["/x/bin".into()],
            program_roots: vec!["/x/programs".into()],
            data_dir: Some(data.clone()),
        };
        let found = candidates(&search);
        assert_eq!(found[0], PathBuf::from("/x/explicit"));
        assert_eq!(found[1], PathBuf::from("/x/env"));
        let downloads: Vec<_> = found
            .iter()
            .filter(|path| path.starts_with(&data))
            .cloned()
            .collect();
        assert_eq!(
            downloads,
            vec![
                data.join("chromium/153.0.8010.12-bb").join(executable),
                data.join("chromium/152.0.1.0-aa").join(executable),
            ]
        );
        let first_download = found.iter().position(|p| p.starts_with(&data));
        let first_path = found.iter().position(|p| p.starts_with("/x/bin"));
        let last_path = found.iter().rposition(|p| p.starts_with("/x/bin"));
        assert!(last_path < first_download);
        // Windows installs come before PATH, as in the daemon; elsewhere they aren't looked at.
        let installed = found.iter().rposition(|p| p.starts_with("/x/programs"));
        if cfg!(windows) {
            assert!(installed.is_some_and(|at| Some(at) < first_path));
        } else {
            assert!(installed.is_none());
        }
        std::fs::remove_dir_all(&data)
    }

    #[cfg(unix)]
    #[test]
    fn only_an_executable_file_is_taken() -> std::io::Result<()> {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp("exec");
        std::fs::create_dir_all(&dir)?;
        let plain = dir.join("chromium");
        std::fs::write(&plain, "")?;
        let search = ChromeSearch {
            path: vec![dir.clone()],
            ..ChromeSearch::default()
        };
        let found = find_chrome(&search);
        assert!(found.as_ref().is_none_or(|path| !path.starts_with(&dir)));
        std::fs::set_permissions(&plain, std::fs::Permissions::from_mode(0o755))?;
        let found = candidates(&search)
            .into_iter()
            .find(|p| p.starts_with(&dir) && runnable(p));
        assert_eq!(found, Some(plain));
        std::fs::remove_dir_all(&dir)
    }
}
