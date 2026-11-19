//! The folder a bot's command runs in, as the shell classifier asks about it (ADR 0144): real
//! paths with symlinks followed, containment in the bot's workspace, and the files it runs.

use std::io::Read;
use std::path::{Component, Path, PathBuf};

use spade_core::autonomy::shell::{Place, Program, Unseen, system_program};

pub struct FsPlace {
    /// Where the command starts.
    cwd: PathBuf,
    /// The bot's workspace, with its own symlinks followed.
    root: PathBuf,
    /// The `PATH` the command starts with; `None` finds no program.
    path: Option<String>,
}

impl FsPlace {
    /// `None` when the workspace itself can't be resolved: then nothing can be said to be in it.
    pub fn new(cwd: PathBuf, workspace: &Path) -> Option<Self> {
        let root = std::fs::canonicalize(workspace).ok()?;
        Some(Self {
            cwd,
            root,
            path: None,
        })
    }

    /// Finding bare program names on `path`, as the command's shell will.
    pub fn with_path(mut self, path: Option<String>) -> Self {
        self.path = path;
        self
    }
}

/// Whether `file` is a program the shell would start.
fn runnable(file: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(file) else {
        return false;
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.is_file() && meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        meta.is_file()
    }
}

/// The file names `name` may be found as: on Windows with each of `PATHEXT`'s endings too.
fn candidates(name: &str) -> Vec<String> {
    #[cfg(windows)]
    {
        let mut names = vec![name.to_owned()];
        for ext in [".exe", ".com", ".cmd", ".bat"] {
            names.push(format!("{name}{ext}"));
        }
        names
    }
    #[cfg(not(windows))]
    {
        vec![name.to_owned()]
    }
}

impl Place for FsPlace {
    fn resolve(&self, path: &str) -> Option<PathBuf> {
        let path = Path::new(path);
        let joined = if path.is_absolute() {
            path.to_path_buf()
        } else {
            self.cwd.join(path)
        };
        let parts: Vec<Component<'_>> = joined.components().collect();
        // The longest part that exists, with its links followed; the rest as written.
        for end in (1..=parts.len()).rev() {
            let prefix: PathBuf = parts[..end].iter().collect();
            if std::fs::symlink_metadata(&prefix).is_err() {
                continue;
            }
            // It exists but can't be followed (a broken link, no permission): unknown.
            let mut real = std::fs::canonicalize(&prefix).ok()?;
            for part in &parts[end..] {
                match part {
                    Component::ParentDir => {
                        real.pop();
                    }
                    Component::CurDir => {}
                    Component::Normal(name) => real.push(name),
                    Component::RootDir | Component::Prefix(_) => return None,
                }
            }
            return Some(real);
        }
        None
    }

    fn contains(&self, real: &Path) -> bool {
        real.starts_with(&self.root)
    }

    fn program(&self, name: &str) -> Program {
        let Some(path) = &self.path else {
            return Program::Missing;
        };
        for dir in std::env::split_paths(path) {
            // An empty or relative entry is looked up from wherever the shell is then: Spade
            // can't follow that.
            if dir.as_os_str().is_empty() || dir.is_relative() {
                return Program::Missing;
            }
            for file in candidates(name).iter().map(|n| dir.join(n)) {
                if !runnable(&file) {
                    continue;
                }
                let Ok(real) = std::fs::canonicalize(&file) else {
                    return Program::Missing;
                };
                if self.contains(&real) {
                    return Program::At(real);
                }
                if system_program(&format!("{}/", dir.display())) {
                    return Program::System;
                }
                return Program::At(real);
            }
        }
        Program::Missing
    }

    fn read(&self, real: &Path, longest: usize) -> Result<String, Unseen> {
        let file = std::fs::File::open(real).map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound => Unseen::Missing,
            _ => Unseen::Unreadable,
        })?;
        let mut bytes = Vec::new();
        file.take(longest as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| Unseen::Unreadable)?;
        if bytes.len() > longest {
            return Err(Unseen::TooLarge);
        }
        String::from_utf8(bytes).map_err(|_| Unseen::Unreadable)
    }

    fn list(&self, real: &Path) -> Result<Vec<String>, Unseen> {
        let entries = std::fs::read_dir(real).map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound => Unseen::Missing,
            _ => Unseen::Unreadable,
        })?;
        Ok(entries
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect())
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn a_link_inside_the_workspace_to_elsewhere_resolves_elsewhere() {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let workspace = dir.path().join("w");
        let other = dir.path().join("other");
        std::fs::create_dir_all(workspace.join("src")).unwrap_or_else(|e| panic!("{e}"));
        std::fs::create_dir_all(&other).unwrap_or_else(|e| panic!("{e}"));
        std::os::unix::fs::symlink(&other, workspace.join("out")).unwrap_or_else(|e| panic!("{e}"));
        std::os::unix::fs::symlink(dir.path().join("gone"), workspace.join("broken"))
            .unwrap_or_else(|e| panic!("{e}"));
        let place = FsPlace::new(workspace.join("src"), &workspace).unwrap_or_else(|| panic!());
        let inside = |path: &str| place.resolve(path).map(|real| place.contains(&real));
        assert_eq!(inside("new/file.txt"), Some(true));
        assert_eq!(inside("../out/file.txt"), Some(false));
        assert_eq!(inside("../../file.txt"), Some(false));
        assert_eq!(
            inside("../broken/file.txt"),
            None,
            "a broken link can't be followed"
        );
    }
}
