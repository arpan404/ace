//! Small files Spade keeps whole: written through a temporary file beside them and renamed into
//! place, so a crash leaves the old file or the new one, never half of one.

use std::path::Path;

pub(crate) fn write_whole(path: &Path, text: &str) -> std::io::Result<()> {
    let dir = path.parent().unwrap_or(Path::new("."));
    std::fs::create_dir_all(dir)?;
    let mut file = tempfile::NamedTempFile::new_in(dir)?;
    std::io::Write::write_all(&mut file, text.as_bytes())?;
    file.as_file().sync_all()?;
    file.persist(path).map_err(|e| e.error)?;
    Ok(())
}
