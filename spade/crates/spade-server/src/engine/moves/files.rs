//! A bot's workspace folder as a move carries it (ADR 0187): its regular files, found without
//! following links, and the relative paths the other machine accepts.

use std::path::{Component, Path, PathBuf};

/// Most files and bytes one move carries.
pub(super) const MOST_FILES: usize = 200_000;
pub(super) const MOST_BYTES: u64 = 8 * 1024 * 1024 * 1024;

/// A regular file in a workspace.
pub(super) struct Found {
    /// Relative to the workspace, with `/`.
    pub path: String,
    pub full: PathBuf,
}

/// What a walk found: the regular files, and what it left (links, special files) by path.
#[derive(Default)]
pub(super) struct Walked {
    pub files: Vec<Found>,
    pub left: Vec<String>,
}

/// The regular files under `root`, folders first by name; links are never followed.
pub(super) fn walk(root: &Path) -> std::io::Result<Walked> {
    let mut walked = Walked::default();
    if !std::fs::symlink_metadata(root).is_ok_and(|m| m.is_dir()) {
        return Ok(walked);
    }
    let mut folders = vec![(root.to_path_buf(), String::new())];
    while let Some((folder, prefix)) = folders.pop() {
        let mut entries: Vec<_> = std::fs::read_dir(&folder)?.collect::<Result<_, _>>()?;
        entries.sort_by_key(std::fs::DirEntry::file_name);
        for entry in entries {
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                walked
                    .left
                    .push(format!("{prefix}{}", entry.file_name().to_string_lossy()));
                continue;
            };
            let path = format!("{prefix}{name}");
            let kind = entry.file_type()?;
            if kind.is_dir() {
                folders.push((entry.path(), format!("{path}/")));
            } else if kind.is_file() {
                if walked.files.len() >= MOST_FILES {
                    walked.left.push(path);
                } else {
                    walked.files.push(Found {
                        path,
                        full: entry.path(),
                    });
                }
            } else {
                walked.left.push(path);
            }
        }
    }
    Ok(walked)
}

/// `path` (relative, `/`-separated, as a part names it) under `root`, or `None` when it could
/// leave it: absolute, `..`, `.`, an empty or odd component.
pub(super) fn under(root: &Path, path: &str) -> Option<PathBuf> {
    if path.is_empty() || path.len() > 4096 || path.contains(['\\', '\0']) {
        return None;
    }
    let mut full = root.to_path_buf();
    for part in path.split('/') {
        let mut components = Path::new(part).components();
        match (components.next(), components.next()) {
            (Some(Component::Normal(name)), None) if name == part => full.push(name),
            _ => return None,
        }
    }
    Some(full)
}

/// Whether `text` is a SHA-256 in lowercase hex.
pub(super) fn is_sha256(text: &str) -> bool {
    text.len() == 64 && text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Every image hash a stored event or avatar names (`"sha256":"…"`).
pub(super) fn image_refs(text: &str, into: &mut Vec<String>) {
    const KEY: &str = "\"sha256\":\"";
    let mut rest = text;
    while let Some(at) = rest.find(KEY) {
        rest = &rest[at + KEY.len()..];
        if let Some(hash) = rest.get(..64)
            && is_sha256(hash)
            && !into.iter().any(|known| known == hash)
        {
            into.push(hash.to_owned());
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{image_refs, under, walk};

    #[test]
    fn a_path_that_could_leave_the_workspace_is_refused() {
        let root = Path::new("/w");
        assert_eq!(
            under(root, "a/b.txt"),
            Some(Path::new("/w/a/b.txt").to_path_buf())
        );
        for bad in [
            "",
            "/etc/passwd",
            "../x",
            "a/../b",
            "a//b",
            "./a",
            "a\\b",
            "a/",
        ] {
            assert_eq!(under(root, bad), None, "{bad}");
        }
    }

    #[test]
    fn image_hashes_are_found_once_each() {
        let hash = "a".repeat(64);
        let text = format!(
            r#"{{"images":[{{"sha256":"{hash}"}},{{"sha256":"{hash}"}},{{"sha256":"short"}}]}}"#
        );
        let mut found = Vec::new();
        image_refs(&text, &mut found);
        assert_eq!(found, vec![hash]);
    }

    #[cfg(unix)]
    #[test]
    fn a_walk_takes_files_and_leaves_links() -> std::io::Result<()> {
        let dir = tempfile::tempdir()?;
        std::fs::create_dir_all(dir.path().join("notes"))?;
        std::fs::write(dir.path().join("notes/a.md"), "a")?;
        std::fs::write(dir.path().join("b.txt"), "b")?;
        std::os::unix::fs::symlink("/etc/hosts", dir.path().join("hosts"))?;
        let walked = walk(dir.path())?;
        let mut paths: Vec<_> = walked.files.iter().map(|f| f.path.clone()).collect();
        paths.sort();
        assert_eq!(paths, ["b.txt", "notes/a.md"]);
        assert_eq!(walked.left, ["hosts"]);
        Ok(())
    }
}
