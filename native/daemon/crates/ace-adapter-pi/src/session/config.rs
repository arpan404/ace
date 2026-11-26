// SPDX-License-Identifier: Apache-2.0
//! The private MCP configuration file a Pi session hands its extension, ported from
//! `packages/mcp-server/src/private-config.ts` (the file `ACE_PI_SESSION_FILE` names,
//! `session.ts:107`–`:127`).
//!
//! The file holds the session's control secret and its lease bearer, so it is session-owned:
//! a fresh 0700 directory outside any workspace, a 0600 file created exactly once, and removal
//! that never throws. It is a minimal port; the MCP item (M1 and later) owns the full
//! `@ace/mcp-server/private-config` surface, including the bounded read.

use std::path::{Component, Path, PathBuf};

/// The content bound (`private-config.ts:12`).
pub const MAX_CONFIG_BYTES: usize = 256 * 1024;

/// Why a private configuration could not be made.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ConfigError {
    #[error("MCP configuration exceeds limit")]
    TooLarge,
    #[error("MCP credential directory must be outside the workspace")]
    InsideWorkspace,
    #[error("MCP configuration file: {0}")]
    Io(String),
}

/// One written file, removed as a whole directory when the session ends.
#[derive(Debug)]
pub struct PrivateMcpConfig {
    directory: PathBuf,
    pub path: PathBuf,
}

impl PrivateMcpConfig {
    /// `remove()`: a folder still held is retried briefly, then left to the temp directory,
    /// never thrown (`private-config.ts:39`–`:44`).
    pub fn remove(self) {
        for attempt in 0..3 {
            if std::fs::remove_dir_all(&self.directory).is_ok() {
                return;
            }
            if attempt < 2 {
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        }
    }
}

/// `privateMcpConfig(content, workspace)`: a new `ace-mcp-<nonce>` directory under `root`,
/// outside `workspace`, holding `config.json` with `content`.
pub fn write_private_config(
    root: &Path,
    nonce: &str,
    content: &str,
    workspace: Option<&Path>,
) -> Result<PrivateMcpConfig, ConfigError> {
    if content.len() > MAX_CONFIG_BYTES {
        return Err(ConfigError::TooLarge);
    }
    if let Some(workspace) = workspace
        && !is_outside(workspace, root)
    {
        return Err(ConfigError::InsideWorkspace);
    }
    let directory = root.join(format!("ace-mcp-{nonce}"));
    let path = directory.join("config.json");
    let fail = |error: std::io::Error| ConfigError::Io(error.to_string());
    std::fs::create_dir(&directory).map_err(fail)?;
    let result = (|| {
        set_directory_mode(&directory)?;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        set_file_mode(&mut options);
        use std::io::Write as _;
        let mut file = options.open(&path).map_err(fail)?;
        file.write_all(content.as_bytes()).map_err(fail)?;
        Ok(())
    })();
    if let Err(error) = result {
        let _ = std::fs::remove_dir_all(&directory);
        return Err(error);
    }
    Ok(PrivateMcpConfig { directory, path })
}

/// Whether `root` lies outside `workspace`: node's `path.relative` starts with `..` or is
/// absolute for an outside path, and is empty or a child path for one inside.
pub fn is_outside(workspace: &Path, root: &Path) -> bool {
    let workspace = absolute(workspace);
    let root = absolute(root);
    let workspace: Vec<Component<'_>> = workspace.components().collect();
    let root: Vec<Component<'_>> = root.components().collect();
    // node's `path.relative`: empty or a child path means inside, a `..` means outside.
    if root.len() < workspace.len() {
        return true;
    }
    if root[..workspace.len()] != workspace[..] {
        return true;
    }
    // The workspace is a prefix: `root` is it or a child of it.
    false
}

/// An absolute path with `.` and `..` resolved lexically, as node's `path.resolve` does (no
/// filesystem read, so a path that does not exist still compares).
fn absolute(path: &Path) -> PathBuf {
    let absolute = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::ParentDir => {
                normalized.pop();
            }
            Component::CurDir => {}
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized
}

#[cfg(unix)]
fn set_directory_mode(directory: &Path) -> Result<(), ConfigError> {
    use std::os::unix::fs::PermissionsExt as _;
    std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700))
        .map_err(|error| ConfigError::Io(error.to_string()))
}

#[cfg(not(unix))]
fn set_directory_mode(_directory: &Path) -> Result<(), ConfigError> {
    Ok(())
}

#[cfg(unix)]
fn set_file_mode(options: &mut std::fs::OpenOptions) {
    use std::os::unix::fs::OpenOptionsExt as _;
    options.mode(0o600);
}

#[cfg(not(unix))]
fn set_file_mode(_options: &mut std::fs::OpenOptions) {}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("ace-pi-config-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("scratch");
        root
    }

    #[test]
    fn a_written_config_is_private_and_removed_with_its_directory() {
        let root = scratch("write");
        let workspace =
            std::env::temp_dir().join(format!("ace-pi-workspace-{}", std::process::id()));
        std::fs::create_dir_all(&workspace).expect("workspace");
        let config = write_private_config(&root, "1", "{\"bearer\":\"x\"}", Some(&workspace))
            .expect("write");
        assert_eq!(
            std::fs::read_to_string(&config.path).expect("read"),
            "{\"bearer\":\"x\"}"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = std::fs::metadata(&config.path)
                .expect("stat")
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let directory = config.directory.clone();
        config.remove();
        assert!(!directory.exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_credential_directory_inside_the_workspace_and_an_oversized_content_are_refused() {
        let root = scratch("refuse");
        let workspace = root.join("work");
        std::fs::create_dir_all(&workspace).expect("workspace");
        assert_eq!(
            write_private_config(&workspace, "2", "{}", Some(&workspace)).unwrap_err(),
            ConfigError::InsideWorkspace
        );
        assert_eq!(
            write_private_config(&root, "3", &"x".repeat(MAX_CONFIG_BYTES + 1), None).unwrap_err(),
            ConfigError::TooLarge
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn only_a_directory_below_the_workspace_is_inside_it() {
        let temp = std::env::temp_dir();
        let workspace = temp.join("ace-pi-ws");
        assert!(is_outside(&workspace, &temp.join("ace-pi-other")));
        assert!(!is_outside(&workspace, &workspace.join("child")));
        assert!(!is_outside(&workspace, &workspace));
        // `..` is resolved before the comparison, as node's `path.relative` does.
        assert!(!is_outside(
            &workspace,
            &workspace.join("..").join("ace-pi-ws").join("creds")
        ));
        assert!(is_outside(
            &workspace,
            &workspace.join("..").join("ace-pi-other")
        ));
    }
}
