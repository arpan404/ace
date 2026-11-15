// SPDX-License-Identifier: Apache-2.0
//! Each browser's private profile: `<root>/chrome-encoder-<owner pid>-<random>`, mode 0700.
//! A profile left behind by a process that died is reclaimed by the next start: it must carry
//! the prefix, be a real directory (never a link), belong to this user, be older than a minute,
//! and be unlocked (its owner process gone, and no live Chrome holding `SingletonLock`).

use crate::process::process_alive;
use media_codec::CodecError;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

pub const PREFIX: &str = "chrome-encoder-";
/// A profile younger than this is never reclaimed: its browser may still be starting.
pub const MIN_AGE: Duration = Duration::from_secs(60);

fn backend(error: impl std::fmt::Display) -> CodecError {
    CodecError::Backend(error.to_string())
}

/// Makes a new private profile directory under `root`.
pub fn create(root: &Path, owner: u32) -> Result<PathBuf, CodecError> {
    let mut random = [0u8; 8];
    getrandom::fill(&mut random).map_err(backend)?;
    let tag: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
    let path = root.join(format!("{PREFIX}{owner}-{tag}"));
    std::fs::create_dir_all(root).map_err(backend)?;
    #[cfg_attr(not(unix), allow(unused_mut))]
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    // Not recursive: the directory must be new, never one that already exists.
    builder.create(&path).map_err(backend)?;
    Ok(path)
}

/// Removes abandoned profiles under `root`; returns how many. `now` is the caller's clock.
pub fn reclaim(root: &Path, now: SystemTime) -> usize {
    let Ok(entries) = std::fs::read_dir(root) else {
        return 0;
    };
    entries
        .flatten()
        .filter(|entry| abandoned(&entry.path(), now))
        .filter(|entry| std::fs::remove_dir_all(entry.path()).is_ok())
        .count()
}

fn abandoned(path: &Path, now: SystemTime) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    let Some(rest) = name.strip_prefix(PREFIX) else {
        return false;
    };
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return false;
    };
    if !meta.is_dir() || !owned_by_me(&meta) {
        return false;
    }
    let old = meta
        .modified()
        .ok()
        .and_then(|modified| now.duration_since(modified).ok())
        .is_some_and(|age| age >= MIN_AGE);
    if !old {
        return false;
    }
    let owner = rest
        .split('-')
        .next()
        .and_then(|pid| pid.parse::<u32>().ok());
    if owner.is_none_or(process_alive) {
        return false;
    }
    !locked(path)
}

#[cfg(unix)]
fn owned_by_me(meta: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    meta.uid() == nix::unistd::getuid().as_raw()
}

#[cfg(not(unix))]
fn owned_by_me(_meta: &std::fs::Metadata) -> bool {
    // The root is inside this user's own data directory.
    true
}

/// Chrome's `SingletonLock` is a link to `<host>-<pid>` while that browser runs.
#[cfg(unix)]
fn locked(path: &Path) -> bool {
    let Ok(target) = std::fs::read_link(path.join("SingletonLock")) else {
        return false;
    };
    let target = target.to_string_lossy();
    target
        .rsplit('-')
        .next()
        .and_then(|pid| pid.parse::<u32>().ok())
        .is_none_or(process_alive)
}

/// On Windows a running Chrome holds `lockfile` open, so it can't be removed while it runs.
#[cfg(not(unix))]
fn locked(path: &Path) -> bool {
    let lock = path.join("lockfile");
    lock.exists() && std::fs::remove_file(&lock).is_err()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A pid no process has: above every system's maximum.
    #[cfg(unix)]
    const DEAD: u32 = 99_999_999;

    fn root(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "media-chrome-profiles-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn new_profiles_are_private_and_unique() -> Result<(), CodecError> {
        let root = root("create");
        let a = create(&root, 1)?;
        let b = create(&root, 1)?;
        assert_ne!(a, b);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&a).map_err(backend)?.permissions().mode();
            assert_eq!(mode & 0o777, 0o700);
        }
        let _ = std::fs::remove_dir_all(root);
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn only_old_unlocked_profiles_of_dead_owners_are_reclaimed() -> std::io::Result<()> {
        let root = root("reclaim");
        let me = std::process::id();
        let dead = root.join(format!("{PREFIX}{DEAD}-aa"));
        let live_owner = root.join(format!("{PREFIX}{me}-bb"));
        let locked_dir = root.join(format!("{PREFIX}{DEAD}-cc"));
        let unrelated = root.join("something-else");
        for dir in [&dead, &live_owner, &locked_dir, &unrelated] {
            std::fs::create_dir_all(dir)?;
        }
        std::os::unix::fs::symlink(format!("host-{me}"), locked_dir.join("SingletonLock"))?;
        // A link with the prefix is never followed or removed.
        let target = root.join("target");
        std::fs::create_dir_all(&target)?;
        let link = root.join(format!("{PREFIX}{DEAD}-dd"));
        std::os::unix::fs::symlink(&target, &link)?;

        // Just made: too young for anything to go.
        assert_eq!(reclaim(&root, SystemTime::now()), 0);
        let later = SystemTime::now() + MIN_AGE + Duration::from_secs(1);
        assert_eq!(reclaim(&root, later), 1);
        assert!(!dead.exists());
        for kept in [&live_owner, &locked_dir, &unrelated, &target, &link] {
            assert!(
                std::fs::symlink_metadata(kept).is_ok(),
                "{}",
                kept.display()
            );
        }
        // A stale lock (its browser gone) no longer protects the profile.
        std::fs::remove_file(locked_dir.join("SingletonLock"))?;
        std::os::unix::fs::symlink(format!("host-{DEAD}"), locked_dir.join("SingletonLock"))?;
        assert_eq!(reclaim(&root, later), 1);
        assert!(!locked_dir.exists());
        std::fs::remove_dir_all(root)
    }
}
