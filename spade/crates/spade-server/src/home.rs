//! Spade's data folder: the single-instance lock, the API token and `server.json`, as
//! `docs/ace-integration.md` specifies. Only Spade writes here.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};

/// Spade's HTTP API version, in `server.json` and `/health`. Clients accept this one and the one
/// before it (docs/ace-integration.md).
pub const API_VERSION: u32 = 1;

/// The model catalogue and search settings Spade starts with when the data folder has none.
pub const DEFAULT_MODELS: &str = include_str!("../../../config/models.json");
pub const DEFAULT_SEARCH: &str = include_str!("../../../config/search.json");

#[derive(Debug, thiserror::Error)]
pub enum HomeError {
    #[error("another Spade is already running with {0}")]
    Busy(PathBuf),
    #[error("{path}: {error}")]
    Io {
        path: PathBuf,
        error: std::io::Error,
    },
}

/// Holds the data folder's lock for as long as it lives (the OS releases it if Spade dies).
pub struct Home {
    pub dir: PathBuf,
    _lock: File,
}

fn io(path: &Path) -> impl Fn(std::io::Error) -> HomeError + '_ {
    move |error| HomeError::Io {
        path: path.to_path_buf(),
        error,
    }
}

impl Home {
    /// Creates the folder if needed and takes its lock; fails if another Spade holds it.
    pub fn open(dir: &Path) -> Result<Self, HomeError> {
        fs::create_dir_all(dir).map_err(io(dir))?;
        let lock_path = dir.join("lock");
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(&lock_path)
            .map_err(io(&lock_path))?;
        match lock.try_lock() {
            Ok(()) => Ok(Self {
                dir: dir.to_path_buf(),
                _lock: lock,
            }),
            Err(std::fs::TryLockError::WouldBlock) => Err(HomeError::Busy(dir.to_path_buf())),
            Err(std::fs::TryLockError::Error(error)) => Err(io(&lock_path)(error)),
        }
    }

    /// Where attached images are kept, by hash.
    pub fn images(&self) -> PathBuf {
        self.dir.join("images")
    }

    pub fn database(&self) -> PathBuf {
        self.dir.join("spade.sqlite")
    }

    /// The file at `name`, written from `default` first if it does not exist.
    pub fn file_or_default(&self, name: &str, default: &str) -> Result<PathBuf, HomeError> {
        let path = self.dir.join(name);
        if !path.exists() {
            write_atomic(&path, default.as_bytes(), false)?;
        }
        Ok(path)
    }

    /// Writes the API token, readable only by this user.
    pub fn write_token(&self, token: &str) -> Result<(), HomeError> {
        write_atomic(&self.dir.join("token"), token.as_bytes(), true)
    }

    /// Announces readiness: `{address, pid, version, api}`.
    pub fn write_server_json(&self, address: SocketAddr, pid: u32) -> Result<(), HomeError> {
        let body = serde_json::json!({
            "address": address.to_string(),
            "pid": pid,
            "version": env!("CARGO_PKG_VERSION"),
            "api": API_VERSION,
        });
        write_atomic(
            &self.dir.join("server.json"),
            body.to_string().as_bytes(),
            false,
        )
    }

    /// Removes `server.json` on a clean stop, so nothing reads a dead address.
    pub fn clear_server_json(&self) {
        let _ = fs::remove_file(self.dir.join("server.json"));
    }
}

/// Writes to a temporary file and renames it into place, so readers never see half a file.
fn write_atomic(path: &Path, bytes: &[u8], private: bool) -> Result<(), HomeError> {
    let temporary = path.with_extension("partial");
    let mut options = OpenOptions::new();
    options.create(true).write(true).truncate(true);
    #[cfg(unix)]
    if private {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    #[cfg(not(unix))]
    let _ = private;
    let mut file = options.open(&temporary).map_err(io(&temporary))?;
    file.write_all(bytes).map_err(io(&temporary))?;
    file.sync_all().map_err(io(&temporary))?;
    fs::rename(&temporary, path).map_err(io(path))
}

/// A new random API token.
pub fn new_token() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_json_names_the_address_pid_version_and_api() -> Result<(), Box<dyn std::error::Error>>
    {
        let dir = tempfile::tempdir()?;
        let home = Home::open(dir.path())?;
        home.write_server_json("127.0.0.1:4567".parse()?, 42)?;
        let written: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.path().join("server.json"))?)?;
        assert_eq!(
            written,
            serde_json::json!({
                "address": "127.0.0.1:4567",
                "pid": 42,
                "version": env!("CARGO_PKG_VERSION"),
                "api": 1,
            })
        );
        Ok(())
    }

    #[test]
    fn a_second_spade_on_the_same_folder_is_refused() -> Result<(), Box<dyn std::error::Error>> {
        let dir = tempfile::tempdir()?;
        let _first = Home::open(dir.path())?;
        assert!(matches!(Home::open(dir.path()), Err(HomeError::Busy(_))));
        Ok(())
    }
}
