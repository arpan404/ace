//! Names that become paths in a move (ADR 0187): a move's id and a bot's id name folders under
//! Spade's data folder, so each is parsed where it arrives as one plain path component, and every
//! folder a move writes in or removes is checked to be where it should be, never through a link.

use std::path::{Component, Path, PathBuf};

/// Longest id a move takes.
const ID_CHARS: usize = 80;

/// Whether `id` is a plain id: 1 to 80 of `a-z 0-9 _ -`, starting with a letter or digit. No
/// dot, slash, backslash, NUL, upper case or anything outside ASCII, so it is always one normal
/// path component and never `.` or `..`.
pub(super) fn plain_id(id: &str) -> bool {
    let mut chars = id.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && id.len() <= ID_CHARS
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '_' | '-'))
}

/// Whether the thing at `path` is a real folder, not a link to one.
fn real_dir(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|m| m.is_dir() && !m.file_type().is_symlink())
}

/// `root/name` for a plain `name`: `root` is made if missing and must then be a real folder,
/// the child is not a link when it exists, and its parent is `root` itself once links in the
/// path above are resolved.
pub(super) fn child(root: &Path, name: &str) -> Result<PathBuf, String> {
    if !plain_id(name) {
        return Err(format!("{name:?} is not a name Spade takes"));
    }
    if !root.exists() {
        std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
    }
    if !real_dir(root) {
        return Err(format!("{} is not a folder", root.display()));
    }
    let path = root.join(name);
    if std::fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(format!("{} is a link", path.display()));
    }
    let parent = path.parent().ok_or("no parent")?;
    let same = std::fs::canonicalize(parent).map_err(|e| e.to_string())?
        == std::fs::canonicalize(root).map_err(|e| e.to_string())?;
    if !same {
        return Err(format!("{} is outside {}", path.display(), root.display()));
    }
    Ok(path)
}

/// Removes the folder `root/name` (checked as `child` does); nothing there is fine. The
/// removal never follows a link inside it.
pub(super) fn remove_child(root: &Path, name: &str) -> Result<(), String> {
    let path = child(root, name)?;
    match std::fs::symlink_metadata(&path) {
        Ok(meta) if meta.is_dir() => std::fs::remove_dir_all(&path).map_err(|e| e.to_string()),
        Ok(_) => std::fs::remove_file(&path).map_err(|e| e.to_string()),
        Err(_) => Ok(()),
    }
}

/// `path` (relative, `/`-separated, as a part names it) under `root`, or `None` when it could
/// leave it: absolute, `..`, `.`, an empty or odd component, or a link on the way that is
/// already there.
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
        if std::fs::symlink_metadata(&full).is_ok_and(|m| m.file_type().is_symlink()) {
            return None;
        }
    }
    Some(full)
}

/// Flushes a folder's entries to disk, so a rename into it survives a crash.
pub(super) fn sync_dir(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        std::fs::File::open(path)
            .and_then(|dir| dir.sync_all())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{child, plain_id, remove_child, under};

    #[test]
    fn only_a_plain_lowercase_id_names_a_folder() {
        for good in ["mv_0190ab", "a_1", "a-b", "7"] {
            assert!(plain_id(good), "{good}");
        }
        for bad in [
            "",
            ".",
            "..",
            "../x",
            "a/b",
            "/abs",
            "a\\b",
            "a\0b",
            "Mv_1",
            "_a",
            "-a",
            "mv.1",
            "ａ",
            "a\u{202e}b",
            "a b",
            &"a".repeat(81),
        ] {
            assert!(!plain_id(bad), "{bad:?}");
        }
    }

    #[test]
    fn a_path_that_could_leave_the_folder_is_refused() {
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
            "a\0b",
        ] {
            assert_eq!(under(root, bad), None, "{bad}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_folder_reached_through_a_link_is_never_written_or_removed() -> std::io::Result<()> {
        let dir = tempfile::tempdir()?;
        let outside = dir.path().join("outside");
        std::fs::create_dir_all(outside.join("keep"))?;
        let root = dir.path().join("moves");
        std::fs::create_dir_all(&root)?;
        std::os::unix::fs::symlink(&outside, root.join("mv_1"))?;
        assert!(child(&root, "mv_1").is_err());
        assert!(remove_child(&root, "mv_1").is_err());
        assert!(
            outside.join("keep").exists(),
            "nothing behind the link went"
        );
        // A root that is itself a link isn't used either.
        let linked = dir.path().join("linked");
        std::os::unix::fs::symlink(&outside, &linked)?;
        assert!(child(&linked, "keep").is_err());
        // Nor a file path through a link already there.
        std::os::unix::fs::symlink(&outside, root.join("files"))?;
        assert_eq!(under(&root, "files/keep/x"), None);
        Ok(())
    }

    #[test]
    fn dot_names_never_remove_the_data_folder() -> std::io::Result<()> {
        let dir = tempfile::tempdir()?;
        let root = dir.path().join("moves");
        std::fs::create_dir_all(&root)?;
        std::fs::write(dir.path().join("spade.sqlite"), "data")?;
        for name in [".", "..", "../..", "/", ""] {
            assert!(remove_child(&root, name).is_err(), "{name:?}");
        }
        assert!(dir.path().join("spade.sqlite").exists());
        Ok(())
    }
}
