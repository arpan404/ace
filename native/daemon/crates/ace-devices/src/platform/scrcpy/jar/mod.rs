// SPDX-License-Identifier: Apache-2.0
//! `scrcpy-jar.ts`: the upstream scrcpy server ace speaks to. Client and server must be the same
//! release, so the version, size and SHA-256 are pinned together. An explicit
//! `ACE_SCRCPY_SERVER` is used only when it matches; otherwise ace downloads the pinned server
//! once into its tools directory and reuses the verified copy. A download is verified before a
//! file is placed: nothing is written until the checksum matches, so a failed or cancelled
//! download leaves no file behind.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::platform::{Code, Error, Failure, words};

/// The upstream scrcpy server ace speaks to: client and server must be the same release, so
/// the version, size and SHA-256 are pinned together.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct ScrcpyRelease {
    pub version: String,
    pub bytes: u64,
    pub sha256: String,
    pub url: String,
}

/// The pinned scrcpy release.
pub fn scrcpy_release() -> ScrcpyRelease {
    ScrcpyRelease {
        version: "5.0.1".to_string(),
        bytes: 733_930,
        sha256: "764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536".to_string(),
        url: "https://github.com/Genymobile/scrcpy/releases/download/v5.0.1/scrcpy-server-v5.0.1"
            .to_string(),
    }
}

/// The server's file name in ace's tools directory.
pub fn server_name(release: &ScrcpyRelease) -> String {
    format!("scrcpy-server-v{}", release.version)
}

/// The SHA-256 of `bytes`, lowercase hex.
pub fn digest_sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Whether the file at `path` holds exactly the pinned bytes.
pub fn verified(path: &Path, sha256: &str) -> bool {
    fs::read(path)
        .map(|bytes| digest_sha256_hex(&bytes) == sha256)
        .unwrap_or(false)
}

/// The pinned server already in place (`ACE_SCRCPY_SERVER`, or ace's downloaded copy), verified
/// by checksum; `None` when it still has to be downloaded.
pub fn installed(
    directory: Option<&Path>,
    explicit: Option<&str>,
    release: &ScrcpyRelease,
) -> Result<Option<PathBuf>, Error> {
    if let Some(explicit) = explicit {
        let path = PathBuf::from(explicit);
        if verified(&path, &release.sha256) {
            return Ok(Some(path));
        }
        return Err(unavailable(format!(
            "ACE_SCRCPY_SERVER is not scrcpy-server v{}",
            release.version
        )));
    }
    let Some(directory) = directory else {
        return Ok(None);
    };
    let path = directory.join(server_name(release));
    Ok(verified(&path, &release.sha256).then_some(path))
}

/// A local copy of the pinned server, verified by checksum. `ACE_SCRCPY_SERVER` names one
/// explicitly; otherwise it is downloaded once into `directory` and reused. `fetch` is the
/// capture's HTTP: it is handed the release URL and the byte cap.
pub async fn server_jar<F, Fut>(
    directory: Option<&Path>,
    explicit: Option<&str>,
    id: &str,
    release: &ScrcpyRelease,
    fetch: F,
) -> Result<PathBuf, Error>
where
    F: FnOnce(&str, u64) -> Fut,
    Fut: std::future::Future<Output = Result<Vec<u8>, Error>>,
{
    if let Some(path) = installed(directory, explicit, release)? {
        return Ok(path);
    }
    let Some(directory) = directory else {
        return Err(unavailable(
            "No directory for the scrcpy server".to_string(),
        ));
    };
    create_tools_directory(directory)?;
    // The bytes are verified before anything is written: a failed or cancelled download, and a
    // checksum mismatch, leave the directory as it was.
    let bytes = fetch(&release.url, release.bytes).await?;
    if bytes.len() as u64 > release.bytes {
        return Err(unavailable(
            "scrcpy-server download is too large".to_string(),
        ));
    }
    if digest_sha256_hex(&bytes) != release.sha256 {
        return Err(unavailable(
            "scrcpy-server download failed its checksum".to_string(),
        ));
    }
    let path = directory.join(server_name(release));
    // Concurrent first uses each write their own file; the last rename wins with identical
    // bytes.
    let partial = directory.join(format!("{}.{id}.partial", server_name(release)));
    let written = write_private(&partial, &bytes).and_then(|()| {
        fs::rename(&partial, &path)
            .map_err(|error| unavailable(format!("scrcpy-server download failed: {error}")))
    });
    // A write or rename that failed never leaves its partial file behind.
    if written.is_err() {
        let _ = fs::remove_file(&partial);
    }
    written?;
    Ok(path)
}

fn create_tools_directory(directory: &Path) -> Result<(), Error> {
    fs::create_dir_all(directory)
        .map_err(|error| unavailable(format!("scrcpy-server download failed: {error}")))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(directory, fs::Permissions::from_mode(0o700));
    }
    Ok(())
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<(), Error> {
    let mut file = fs::File::create(path)
        .map_err(|error| unavailable(format!("scrcpy-server download failed: {error}")))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = file.set_permissions(fs::Permissions::from_mode(0o600));
    }
    file.write_all(bytes)
        .map_err(|error| unavailable(format!("scrcpy-server download failed: {error}")))
}

/// Today's `DeviceError`: `tool_missing`, the catalog's scrcpy hint, and a message that names
/// what went wrong.
fn unavailable(message: String) -> Error {
    Error::Failed(Failure {
        code: Code::ToolMissing,
        message,
        hint: words::tool_hint("scrcpyHint").to_string(),
    })
}

#[cfg(test)]
mod tests;
