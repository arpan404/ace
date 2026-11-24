//! Small files Spade keeps whole: written through a temporary file beside them and renamed into
//! place, so a crash leaves the old file or the new one, never half of one.

use std::io::Write;
use std::path::Path;

use cap_fs_ext::{FollowSymlinks, OpenOptionsFollowExt};
use cap_std::fs::{Dir, OpenOptions};

pub(crate) fn write_whole(path: &Path, text: &str) -> std::io::Result<()> {
    let dir = path.parent().unwrap_or(Path::new("."));
    std::fs::create_dir_all(dir)?;
    let mut file = tempfile::NamedTempFile::new_in(dir)?;
    file.write_all(text.as_bytes())?;
    file.as_file().sync_all()?;
    file.persist(path).map_err(|e| e.error)?;
    Ok(())
}

/// Writes `text` atomically into `name` inside an already-opened capability directory handle
/// `dir`, using a temporary file beside `name` opened with `FollowSymlinks::No` and renamed into
/// place, so neither the directory nor the file can be redirected through a symlink.
pub(crate) fn write_whole_in(dir: &Dir, name: &str, text: &str) -> std::io::Result<()> {
    let temporary = format!(".{name}.spade-{}", uuid::Uuid::new_v4().simple());
    let mut options = OpenOptions::new();
    options
        .write(true)
        .create_new(true)
        .follow(FollowSymlinks::No);
    let written = dir.open_with(&temporary, &options).and_then(|mut file| {
        file.write_all(text.as_bytes())?;
        file.sync_all()
    });
    let renamed = written.and_then(|()| dir.rename(&temporary, dir, name));
    if let Err(error) = renamed {
        if let Err(unlink_error) = dir.remove_file(&temporary)
            && unlink_error.kind() != std::io::ErrorKind::NotFound
        {
            tracing::warn!(%unlink_error, %temporary, "temporary atomic file was not cleaned up");
        }
        return Err(error);
    }
    Ok(())
}

/// As [`write_whole`], but without waiting for the disk: a crash of Spade still leaves the old
/// file or the new one, while a power cut may lose the latest. For short-lived facts written
/// often (the person's recent file changes), where that loss is harmless.
pub(crate) fn replace_whole(path: &Path, text: &str) -> std::io::Result<()> {
    let dir = path.parent().unwrap_or(Path::new("."));
    std::fs::create_dir_all(dir)?;
    let mut file = tempfile::NamedTempFile::new_in(dir)?;
    std::io::Write::write_all(&mut file, text.as_bytes())?;
    file.persist(path).map_err(|e| e.error)?;
    Ok(())
}
