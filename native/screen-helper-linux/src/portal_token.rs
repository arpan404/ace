use crate::protocol::{Fault, Result, internal};
use std::{
    io::Write,
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::Path,
};
pub fn read_token(path: &Path) -> Result<Option<String>> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(internal(e)),
    };
    if !metadata.is_file() || metadata.permissions().mode() & 0o077 != 0 || metadata.len() > 4096
        || metadata.uid() != unsafe { libc::geteuid() } {
        return Err(Fault::new(
            "permission_denied",
            "Restore token must be a private regular file <=4096 bytes",
        ));
    }
    let token = std::fs::read_to_string(path).map_err(internal)?;
    Ok((!token.is_empty()).then_some(token))
}
pub fn save_token(path: &Path, token: &str) -> Result<()> {
    if token.len() > 4096 {
        return Err(Fault::new("bounds", "Restore token exceeds limit"));
    }
    let parent = path
        .parent()
        .ok_or_else(|| internal("Missing token directory"))?;
    std::fs::create_dir_all(parent).map_err(internal)?;
    let directory = std::fs::symlink_metadata(parent).map_err(internal)?;
    if !directory.is_dir() || directory.uid() != unsafe { libc::geteuid() } {
        return Err(Fault::new(
            "permission_denied",
            "Token directory cannot be a symlink",
        ));
    }
    std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700)).map_err(internal)?;
    let staging = path.with_extension("new");
    // A crash before rename may leave staging behind. The single host owner can recover it.
    match std::fs::symlink_metadata(&staging) {
        Ok(metadata) if metadata.is_file() && metadata.uid() == unsafe { libc::geteuid() }
            && metadata.permissions().mode() & 0o077 == 0 => {
            std::fs::remove_file(&staging).map_err(internal)?;
        }
        Ok(_) => return Err(Fault::new("permission_denied", "Restore staging must be a private owner file")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {},
        Err(e) => return Err(internal(e)),
    }
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&staging)
        .map_err(internal)?;
    let result = (|| {
        f.write_all(token.as_bytes()).map_err(internal)?;
        f.sync_all().map_err(internal)?;
        std::fs::rename(&staging, path).map_err(internal)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(staging);
    }
    result
}
