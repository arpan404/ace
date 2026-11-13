//! The folder a bot's command runs in, as the shell classifier asks about it (ADR 0144): real
//! paths with symlinks followed, containment in the bot's workspace, and the files it runs.

use std::io::Read;
use std::path::{Component, Path, PathBuf};

use spade_core::autonomy::shell::{Place, Unseen};

pub struct FsPlace {
    /// Where the command starts.
    cwd: PathBuf,
    /// The bot's workspace, with its own symlinks followed.
    root: PathBuf,
}

impl FsPlace {
    /// `None` when the workspace itself can't be resolved: then nothing can be said to be in it.
    pub fn new(cwd: PathBuf, workspace: &Path) -> Option<Self> {
        let root = std::fs::canonicalize(workspace).ok()?;
        Some(Self { cwd, root })
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
