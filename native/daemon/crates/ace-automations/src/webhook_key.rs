// SPDX-License-Identifier: Apache-2.0
//! The automation webhook key file (`apps/daemon/src/automation-webhook-key.ts`, ADR 0173
//! decision 11): 32 random bytes in an owner-only file beside the stores. Opening a secret only
//! loads it (a missing file leaves secrets unreadable, never replaced); sealing a new one may
//! create it. A symlink, a FIFO, another user's file, group/other permissions or the wrong size
//! is refused with today's words and left as it is.

use std::path::Path;

use crate::error::{AutomationsError, Result};

pub const WEBHOOK_KEY_NAME: &str = "automation-webhooks.key";
const KEY_SIZE: usize = 32;

/// The key if the file exists, none when it doesn't.
#[cfg(unix)]
pub fn load_key(path: &Path) -> Result<Option<[u8; KEY_SIZE]>> {
    use rustix::fs::{CWD, Mode, OFlags, fstat, openat};
    use rustix::io::{Errno, read};

    let fd = match openat(
        CWD,
        path,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK,
        Mode::empty(),
    ) {
        Ok(fd) => fd,
        Err(Errno::NOENT) => return Ok(None),
        Err(error) => {
            return Err(AutomationsError::message(format!(
                "{WEBHOOK_KEY_NAME} can't be opened safely ({})",
                code(error)
            )));
        }
    };
    let stat = fstat(&fd).map_err(|error| {
        AutomationsError::message(format!(
            "{WEBHOOK_KEY_NAME} can't be opened safely ({})",
            code(error)
        ))
    })?;
    if !rustix::fs::FileType::from_raw_mode(stat.st_mode).is_file() {
        return Err(AutomationsError::message(format!(
            "{WEBHOOK_KEY_NAME} isn't a regular file"
        )));
    }
    if stat.st_mode & 0o077 != 0 {
        return Err(AutomationsError::message(format!(
            "{WEBHOOK_KEY_NAME} is readable by others; it must be mode 0600"
        )));
    }
    if u64::from(stat.st_uid) != u64::from(rustix::process::getuid().as_raw()) {
        return Err(AutomationsError::message(format!(
            "{WEBHOOK_KEY_NAME} belongs to another user"
        )));
    }
    if stat.st_size != KEY_SIZE as i64 {
        return Err(AutomationsError::message(format!(
            "{WEBHOOK_KEY_NAME} isn't a 32-byte key"
        )));
    }
    let mut key = [0u8; KEY_SIZE];
    let mut filled = 0;
    while filled < KEY_SIZE {
        match read(&fd, &mut key[filled..]) {
            Ok(0) => break,
            Ok(count) => filled += count,
            Err(error) => {
                return Err(AutomationsError::message(format!(
                    "{WEBHOOK_KEY_NAME} can't be opened safely ({})",
                    code(error)
                )));
            }
        }
    }
    if filled != KEY_SIZE {
        return Err(AutomationsError::message(format!(
            "{WEBHOOK_KEY_NAME} isn't a 32-byte key"
        )));
    }
    Ok(Some(key))
}

/// Create the key when there is none, or return the one the other store made first.
#[cfg(unix)]
pub fn ensure_key(path: &Path, key: [u8; KEY_SIZE]) -> Result<[u8; KEY_SIZE]> {
    use rustix::fs::{CWD, Mode, OFlags, fchmod, openat};
    use rustix::io::{Errno, write};

    let fd = match openat(
        CWD,
        path,
        OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW,
        Mode::from_bits_truncate(0o600),
    ) {
        Ok(fd) => fd,
        Err(Errno::EXIST) => {
            return load_key(path)?.ok_or_else(|| {
                AutomationsError::message(format!("{WEBHOOK_KEY_NAME} vanished while being made"))
            });
        }
        Err(error) => {
            return Err(AutomationsError::message(format!(
                "{WEBHOOK_KEY_NAME} can't be opened safely ({})",
                code(error)
            )));
        }
    };
    fchmod(&fd, Mode::from_bits_truncate(0o600))
        .map_err(|error| AutomationsError::message(format!("{WEBHOOK_KEY_NAME}: {error}")))?;
    let mut written = 0;
    while written < KEY_SIZE {
        match write(&fd, &key[written..]) {
            Ok(0) => break,
            Ok(count) => written += count,
            Err(error) => {
                return Err(AutomationsError::message(format!(
                    "{WEBHOOK_KEY_NAME}: {error}"
                )));
            }
        }
    }
    if written != KEY_SIZE {
        return Err(AutomationsError::message(format!(
            "{WEBHOOK_KEY_NAME} isn't a 32-byte key"
        )));
    }
    Ok(key)
}

#[cfg(unix)]
fn code(error: rustix::io::Errno) -> String {
    match error {
        rustix::io::Errno::LOOP => "ELOOP".to_owned(),
        rustix::io::Errno::NOENT => "ENOENT".to_owned(),
        rustix::io::Errno::EXIST => "EEXIST".to_owned(),
        other => format!("os error {}", other.raw_os_error()),
    }
}

#[cfg(not(unix))]
pub fn load_key(_path: &Path) -> Result<Option<[u8; KEY_SIZE]>> {
    Err(AutomationsError::message(
        "automation-webhooks.key isn't supported on this platform",
    ))
}

#[cfg(not(unix))]
pub fn ensure_key(_path: &Path, _key: [u8; KEY_SIZE]) -> Result<[u8; KEY_SIZE]> {
    Err(AutomationsError::message(
        "automation-webhooks.key isn't supported on this platform",
    ))
}
