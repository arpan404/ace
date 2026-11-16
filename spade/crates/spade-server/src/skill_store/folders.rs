//! The store's folders on disk: `<skills>/<id>/` with `SKILL.md` and the skill's other files.
//! A folder is always replaced whole: written beside the old one (`.stage-<id>-<random>`), the
//! old one moved aside (`.old-<id>-<random>`), the new one renamed into place, the old one
//! removed. [`recover`] tidies what a crash left: a moved-aside folder whose skill has no folder
//! goes back, everything else staged or aside is removed.

use std::io::Write;
use std::path::{Component, Path, PathBuf};

/// A file to write into a skill's folder.
pub(super) struct FileOut<'a> {
    pub path: &'a str,
    pub bytes: &'a [u8],
    pub executable: bool,
}

/// `relative` as plain folder names inside a skill's folder, or `None` when it would leave it,
/// is hidden or names SKILL.md at the top.
pub(super) fn inside(relative: &str) -> Option<PathBuf> {
    let path = Path::new(relative);
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) if !part.to_string_lossy().starts_with('.') => out.push(part),
            _ => return None,
        }
    }
    (!out.as_os_str().is_empty() && out != Path::new("SKILL.md")).then_some(out)
}

/// Whether `id` can name a folder: letters, digits, `_` and `-`.
pub(super) fn usable_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Replaces `<root>/<id>` with a folder holding `skill_md` and `files`.
pub(super) fn replace(
    root: &Path,
    id: &str,
    skill_md: &str,
    files: &[FileOut<'_>],
) -> std::io::Result<()> {
    if !usable_id(id) {
        return Err(std::io::Error::other(format!("{id} is not a skill id")));
    }
    std::fs::create_dir_all(root)?;
    let random = uuid::Uuid::new_v4().simple().to_string();
    let stage = root.join(format!(".stage-{id}-{random}"));
    let written = write_folder(&stage, skill_md, files);
    if let Err(error) = written {
        let _ = std::fs::remove_dir_all(&stage);
        return Err(error);
    }
    let target = root.join(id);
    let aside = root.join(format!(".old-{id}-{random}"));
    let moved = match std::fs::rename(&target, &aside) {
        Ok(()) => true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => {
            let _ = std::fs::remove_dir_all(&stage);
            return Err(error);
        }
    };
    if let Err(error) = std::fs::rename(&stage, &target) {
        if moved {
            let _ = std::fs::rename(&aside, &target);
        }
        let _ = std::fs::remove_dir_all(&stage);
        return Err(error);
    }
    if moved {
        let _ = std::fs::remove_dir_all(&aside);
    }
    Ok(())
}

fn write_folder(stage: &Path, skill_md: &str, files: &[FileOut<'_>]) -> std::io::Result<()> {
    std::fs::create_dir(stage)?;
    write_file(&stage.join("SKILL.md"), skill_md.as_bytes(), false)?;
    for file in files {
        let Some(relative) = inside(file.path) else {
            return Err(std::io::Error::other(format!(
                "{} is not a path inside a skill",
                file.path
            )));
        };
        let path = stage.join(relative);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        write_file(&path, file.bytes, file.executable)?;
    }
    sync_dir(stage);
    Ok(())
}

fn write_file(path: &Path, bytes: &[u8], executable: bool) -> std::io::Result<()> {
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = if executable { 0o755 } else { 0o644 };
        file.set_permissions(std::fs::Permissions::from_mode(mode))?;
    }
    #[cfg(not(unix))]
    let _ = executable;
    Ok(())
}

#[cfg(unix)]
fn sync_dir(path: &Path) {
    if let Ok(dir) = std::fs::File::open(path) {
        let _ = dir.sync_all();
    }
}

#[cfg(not(unix))]
fn sync_dir(_path: &Path) {}

/// Removes `<root>/<id>`; nothing there is fine.
pub(super) fn remove(root: &Path, id: &str) -> std::io::Result<()> {
    if !usable_id(id) {
        return Ok(());
    }
    match std::fs::remove_dir_all(root.join(id)) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

/// `SKILL.md` of `<root>/<id>`.
pub(super) fn read_skill(root: &Path, id: &str) -> std::io::Result<String> {
    if !usable_id(id) {
        return Err(std::io::Error::other(format!("{id} is not a skill id")));
    }
    std::fs::read_to_string(root.join(id).join("SKILL.md"))
}

/// One of `<root>/<id>`'s files, refused past `largest` bytes, never through a link.
pub(super) fn read_file(
    root: &Path,
    id: &str,
    relative: &str,
    largest: u64,
) -> std::io::Result<Vec<u8>> {
    let Some(inner) = inside(relative).filter(|_| usable_id(id)) else {
        return Err(std::io::Error::other(format!(
            "{relative} is not in the skill"
        )));
    };
    let path = root.join(id).join(inner);
    let meta = std::fs::symlink_metadata(&path)?;
    if !meta.is_file() || meta.len() > largest {
        return Err(std::io::Error::other(format!(
            "{relative} is not a file Spade keeps"
        )));
    }
    std::fs::read(path)
}

/// After a crash mid-replace: a folder moved aside whose skill has no folder goes back; every
/// other staged or moved-aside folder is removed.
pub(super) fn recover(root: &Path) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.filter_map(Result::ok) {
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = entry.path();
        if let Some(rest) = name.strip_prefix(".old-") {
            // `.old-<id>-<32 hex>`: the id is everything before the last `-`.
            let id = rest.rsplit_once('-').map_or(rest, |(id, _)| id);
            let target = root.join(id);
            if usable_id(id) && !target.exists() && std::fs::rename(&path, &target).is_ok() {
                continue;
            }
            let _ = std::fs::remove_dir_all(&path);
        } else if name.starts_with(".stage-") {
            let _ = std::fs::remove_dir_all(&path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_that_leave_the_folder_or_hide_are_refused() {
        for bad in [
            "../x",
            "/etc/hosts",
            "a/../../b",
            ".git/config",
            "a/.hidden",
            "SKILL.md",
            "",
        ] {
            assert!(inside(bad).is_none(), "{bad}");
        }
        assert_eq!(
            inside("scripts/run.sh"),
            Some(PathBuf::from("scripts/run.sh"))
        );
        assert_eq!(
            inside("docs/SKILL.md"),
            Some(PathBuf::from("docs/SKILL.md"))
        );
    }

    #[test]
    fn a_replaced_folder_holds_only_the_new_files_and_a_crash_is_tidied()
    -> Result<(), Box<dyn std::error::Error>> {
        let dir = tempfile::tempdir()?;
        let root = dir.path();
        let file = |path, bytes| FileOut {
            path,
            bytes,
            executable: false,
        };
        replace(root, "skl_a", "one", &[file("old.md", b"old")])?;
        replace(root, "skl_a", "two", &[file("new/one.md", b"new")])?;
        assert_eq!(read_skill(root, "skl_a")?, "two");
        assert!(!root.join("skl_a/old.md").exists());
        assert_eq!(read_file(root, "skl_a", "new/one.md", 10)?, b"new");

        // A crash after moving the old folder aside, before the new one was in place.
        std::fs::rename(root.join("skl_a"), root.join(".old-skl_a-0123"))?;
        std::fs::create_dir(root.join(".stage-skl_b-0456"))?;
        recover(root);
        assert_eq!(
            read_skill(root, "skl_a")?,
            "two",
            "the old folder came back"
        );
        let left: Vec<String> = std::fs::read_dir(root)?
            .filter_map(Result::ok)
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(left, ["skl_a"]);
        Ok(())
    }
}
