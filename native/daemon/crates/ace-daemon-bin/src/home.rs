// SPDX-License-Identifier: Apache-2.0
//! The ace data home: its private directory, its format marker and its fresh
//! start.
//!
//! Ported from `apps/daemon/src/local-files.ts`'s `secureDataDir` and
//! `@ace/service`'s `home-fresh-start.ts` / `home-format.ts`. The TypeScript cases
//! that pin this are `packages/service/src/home-fresh-start.process.test.ts`
//! ("a legacy unversioned ~/.ace is renamed to ~/.ace-v0 and a fresh v1 home is
//! created", "an existing ~/.ace-v0 backup is never overwritten", "a
//! current-format home is reused untouched", "the format bump from v1 to v2 backs
//! up to ~/.ace-v1", "an explicit ACE_HOME gets the same versioning, with its
//! backup beside it", "a home containing only features.json keeps its flags on
//! first start") and `apps/daemon/src/local-files.test.ts` ("an existing data
//! directory other users can enter is restricted to its owner before locking",
//! "a symlinked data directory is refused").

use std::fs::{self, DirBuilder, OpenOptions};

use facts::read_facts;
use std::io::{self, Write};
#[cfg(unix)]
use std::os::unix::fs::DirBuilderExt;
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

mod claim;
mod facts;
mod files;
mod marker;
mod release;
#[cfg(test)]
mod tests;

pub use files::now_ms;
pub(crate) use files::{create_private, write_private};
pub use marker::{backup_name, iso8601};

/// `HOME_FORMAT_VERSION`: bump beside any change an older build can't read.
pub const HOME_FORMAT_VERSION: u32 = 1;

/// `<home>/ace-format.json`.
pub const HOME_FORMAT_FILE: &str = "ace-format.json";

/// `formatName`: version 1 is `ace-v1`.
pub fn format_name(version: u32) -> String {
    format!("ace-v{version}")
}

/// `renderMarker`: `{"format":"ace-vN","createdAt":"<ISO time>"}\n`.
pub fn render_marker(version: u32, created_at_ms: u64) -> String {
    format!(
        "{{\"format\":\"{}\",\"createdAt\":\"{}\"}}\n",
        format_name(version),
        iso8601(created_at_ms)
    )
}

/// The version a marker records, or none when the text is not one ace can read.
pub fn marker_version(text: &str) -> Option<u32> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    let format = value.get("format")?.as_str()?;
    // `^ace-v(?:0|[1-9]\d{0,8})$`
    let digits = format.strip_prefix("ace-v")?;
    if digits.is_empty() || digits.len() > 9 || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    if digits.len() > 1 && digits.starts_with('0') {
        return None;
    }
    // `createdAt` is read by the schema too; a marker without one is unreadable.
    value.get("createdAt")?.as_str()?;
    digits.parse().ok()
}

/// What is at the home path, with no filesystem calls of its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Facts {
    Missing,
    /// A fresh `ACE_HOME` holding nothing (or only `features.json`).
    Empty,
    /// Data without a readable marker: an earlier ace, or anything else. Version 0.
    Unversioned,
    Versioned(u32),
}

/// What `prepare` will do with it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Plan {
    Create,
    Adopt,
    Reuse,
    BackUp { from: u32 },
    RefuseNewer { stored: u32 },
}

/// `planHome`: pure, so every case is one table.
pub fn plan(facts: Facts, current: u32) -> Plan {
    match facts {
        Facts::Missing => Plan::Create,
        Facts::Empty => Plan::Adopt,
        Facts::Versioned(version) if version == current => Plan::Reuse,
        Facts::Versioned(version) if version > current => Plan::RefuseNewer { stored: version },
        Facts::Versioned(version) => Plan::BackUp { from: version },
        Facts::Unversioned => Plan::BackUp { from: 0 },
    }
}

/// A home's state after `prepare`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum State {
    Created,
    Reused,
    /// The old home was renamed to `backup`; `root` is a fresh, empty home, with
    /// an installed release carried back into it when the backup held one.
    Fresh {
        backup: PathBuf,
        previous_format: String,
        release: Option<String>,
    },
}

/// Why a home could not be opened.
#[derive(Debug)]
pub enum HomeError {
    /// The home holds data from a newer ace build; nothing was moved or written.
    NewerData {
        home: PathBuf,
        stored: String,
        supported: String,
        message: String,
    },
    /// A daemon still holds the old home: nothing was moved (`LiveHomeError`).
    Live {
        home: PathBuf,
        pid: Option<i64>,
        message: String,
    },
    Io {
        action: String,
        source: io::Error,
    },
}

impl std::fmt::Display for HomeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NewerData { message, .. } | Self::Live { message, .. } => {
                formatter.write_str(message)
            }
            Self::Io { action, source } => write!(formatter, "{action}: {source}"),
        }
    }
}

impl std::error::Error for HomeError {}

impl HomeError {
    /// The message `NewerDataError` gives, word for word.
    pub fn newer_data(home: &Path, stored: u32, supported: u32) -> Self {
        let message = format!(
            "This ace build is older than the data in {}: data format {}, build supports {}. Open the newest ace or update this one.",
            home.display(),
            format_name(stored),
            format_name(supported)
        );
        Self::NewerData {
            home: home.to_path_buf(),
            stored: format_name(stored),
            supported: format_name(supported),
            message,
        }
    }

    /// This home's format was written by a newer build: the one refusal that is
    /// logged into the home (the startup refusal line names both formats).
    pub fn is_newer_data(&self) -> bool {
        matches!(self, Self::NewerData { .. })
    }

    /// A daemon still holds the old home; nothing was moved.
    pub fn live(home: &Path, pid: Option<i64>) -> Self {
        Self::Live {
            home: home.to_path_buf(),
            pid,
            message: claim::live_message(home, pid),
        }
    }
}

pub(super) fn io_error(action: impl Into<String>, source: io::Error) -> HomeError {
    HomeError::Io {
        action: action.into(),
        source,
    }
}

/// `prepareDaemonHome`: make `root` a home in this build's format before
/// anything else touches it. A missing home is created; one in the current
/// format is used as is; one without a marker or in an older format is renamed
/// aside, in one rename, and replaced by a fresh home. A newer format is refused
/// and nothing is moved.
pub fn prepare(root: &Path, version: u32, now_ms: u64) -> Result<State, HomeError> {
    let root = crate::config::resolve(root);
    // Another start can win any step; each retry sees what it left.
    for _ in 0..4 {
        match plan(read_facts(&root)?, version) {
            Plan::Reuse => return Ok(State::Reused),
            Plan::RefuseNewer { stored } => {
                return Err(HomeError::newer_data(&root, stored, version));
            }
            Plan::Create => {
                if create(&root, version, now_ms)? {
                    return Ok(State::Created);
                }
            }
            Plan::Adopt => {
                if write_marker(&root, version, now_ms)? {
                    return Ok(State::Created);
                }
            }
            Plan::BackUp { from } => {
                // Claim the old home first: a daemon still using it is refused and
                // nothing moves (`home-fresh-start.ts:207`).
                let claim = claim::claim(&root)?;
                let moved = rename_aside(&root, from);
                claim.release();
                let backup = moved?;
                create(&root, version, now_ms)?;
                // An install.sh release is the program, not data: it keeps running
                // from the fresh home (`carryRelease`).
                let release = crate::home::release::carry(&backup, &root);
                return Ok(State::Fresh {
                    backup: backup.clone(),
                    previous_format: format_name(from),
                    release,
                });
            }
        }
    }
    Err(io_error(
        format!(
            "The ace data home {} kept changing while ace started",
            root.display()
        ),
        io::Error::other("open ace again"),
    ))
}

/// `secureDataDir`: only the owner may enter the data directory, before any
/// store opens.
pub fn secure_data_dir(data_dir: &Path) -> Result<(), HomeError> {
    DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(data_dir)
        .map_err(|error| io_error(format!("Cannot create {}", data_dir.display()), error))?;
    let metadata = fs::symlink_metadata(data_dir)
        .map_err(|error| io_error(format!("Cannot read {}", data_dir.display()), error))?;
    if metadata.file_type().is_symlink() {
        return Err(io_error(
            format!("Refusing data directory {}", data_dir.display()),
            io::Error::other("it is a symbolic link"),
        ));
    }
    if !metadata.is_dir() {
        return Err(io_error(
            format!("Refusing data directory {}", data_dir.display()),
            io::Error::other("not a directory"),
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        // Windows has no POSIX owner or mode bits; its profile ACLs protect it.
        if metadata.uid() != rustix::process::getuid().as_raw() {
            return Err(io_error(
                format!("Refusing data directory {}", data_dir.display()),
                io::Error::other("it is owned by another user"),
            ));
        }
        if metadata.mode() & 0o077 != 0 {
            fs::set_permissions(data_dir, fs::Permissions::from_mode(0o700)).map_err(|error| {
                io_error(format!("Cannot restrict {}", data_dir.display()), error)
            })?;
        }
    }
    Ok(())
}

/// Publishes the marker whole or not at all; a home that already has one keeps it.
fn write_marker(root: &Path, version: u32, now_ms: u64) -> Result<bool, HomeError> {
    let marker = root.join(HOME_FORMAT_FILE);
    let pending = root.join(format!("{HOME_FORMAT_FILE}.{}.tmp", std::process::id()));
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&pending)
        .map_err(|error| io_error("Cannot write the format marker", error))?;
    file.write_all(render_marker(version, now_ms).as_bytes())
        .map_err(|error| io_error("Cannot write the format marker", error))?;
    let linked = match fs::hard_link(&pending, &marker) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Ok(false),
        Err(error) => Err(io_error("Cannot publish the format marker", error)),
    };
    let _ = fs::remove_file(&pending);
    linked
}

/// Makes the home directory (private) and its marker. False when another start
/// raced us to it.
fn create(root: &Path, version: u32, now_ms: u64) -> Result<bool, HomeError> {
    if let Some(parent) = root.parent() {
        DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(parent)
            .map_err(|error| io_error("Cannot create the home's parent", error))?;
    }
    match DirBuilder::new().mode(0o700).create(root) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => return Ok(false),
        Err(error) => return Err(io_error(format!("Cannot create {}", root.display()), error)),
    }
    write_marker(root, version, now_ms)
}

/// `renameAside`: one rename(2) beside the home, so the backup is on one filesystem.
fn rename_aside(root: &Path, from: u32) -> Result<PathBuf, HomeError> {
    let parent = root.parent().unwrap_or_else(|| Path::new("."));
    let base = root
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| ".ace".to_owned());
    let name =
        backup_name(&base, from, |candidate| parent.join(candidate).exists()).ok_or_else(|| {
            io_error(
                format!("Too many ace data backups named {base}-v{from}"),
                io::Error::other("remove the ones you no longer need"),
            )
        })?;
    let backup = parent.join(name);
    match fs::rename(root, &backup) {
        Ok(()) => Ok(backup),
        Err(error) if error.kind() == io::ErrorKind::CrossesDevices => Err(io_error(
            format!("Cannot set aside the ace data in {}", root.display()),
            io::Error::other(format!(
                "{} is on another filesystem. Move {} yourself, then open ace again.",
                backup.display(),
                root.display()
            )),
        )),
        Err(error) => Err(io_error(
            format!("Cannot set aside the ace data in {}", root.display()),
            error,
        )),
    }
}
