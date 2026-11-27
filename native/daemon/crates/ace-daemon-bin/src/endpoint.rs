// SPDX-License-Identifier: Apache-2.0
//! The endpoint file: `<home>/daemon-endpoint` holds the daemon's HTTP URL, so
//! the CLI and the desktop app find it (`index.ts:822`–`:824`). It is written
//! with mode `0600` once the listener is bound and removed as the last step of
//! an orderly shutdown.
//!
//! TypeScript cases ported: the endpoint's path and format are pinned by
//! `apps/daemon/src/cli/daemon-endpoint.ts` ("Where this machine's daemon listens
//! and whether anything does"), whose reader parses exactly `http://127.0.0.1:`
//! with no path, credentials, query or fragment.

use std::io;
use std::path::{Path, PathBuf};

/// The file's name in the home.
pub const ENDPOINT_FILE: &str = "daemon-endpoint";

/// Write the endpoint the HTTP listener answers on.
pub fn write(data_dir: &Path, http_url: &str) -> Result<PathBuf, io::Error> {
    let path = data_dir.join(ENDPOINT_FILE);
    crate::home::write_private(&path, http_url.as_bytes())?;
    Ok(path)
}

/// Remove the endpoint, best effort: a daemon that stopped leaves no address.
pub fn retire(path: Option<&Path>) {
    if let Some(path) = path {
        let _ = std::fs::remove_file(path);
    }
}

/// The endpoint a home names, or none before the daemon has ever started.
#[cfg(test)]
pub fn read(data_dir: &Path) -> Option<String> {
    std::fs::read_to_string(data_dir.join(ENDPOINT_FILE)).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    /// `cli/daemon-endpoint.ts` reads exactly this file: the HTTP URL, and nothing
    /// after the port.
    #[test]
    fn the_endpoint_file_holds_the_http_url_and_is_private() {
        let home = TempDir::new("ace-endpoint");
        let written = write(home.path(), "http://127.0.0.1:4242");
        assert!(written.is_ok(), "the endpoint is written");
        assert_eq!(read(home.path()).as_deref(), Some("http://127.0.0.1:4242"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(home.path().join(ENDPOINT_FILE))
                .map(|m| m.permissions().mode())
                .unwrap_or(0);
            assert_eq!(mode & 0o777, 0o600);
        }
        retire(Some(&home.path().join(ENDPOINT_FILE)));
        assert_eq!(read(home.path()), None);
    }
}
