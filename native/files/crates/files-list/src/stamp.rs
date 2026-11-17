// SPDX-License-Identifier: Apache-2.0

//! A folder's identity and change times: what has to hold for a cached listing, or a cursor, to
//! still describe the folder.
//!
//! File systems record change times at coarser granularity than the changes among them, so a
//! folder that changed within the last two seconds can change again without its stamp moving. Git
//! applies the same rule to its index, and ace treats such a folder as unsettled: it is never
//! cached and its cursors are refused until it settles.

use std::fs::Metadata;
use std::time::{SystemTime, UNIX_EPOCH};

/// How recently a folder may have changed before its stamp counts as proof of no change.
pub(crate) const RACY_WINDOW_NANOS: u128 = 2_000_000_000;

/// A folder's modification time, change time and inode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Stamp {
    pub(crate) mtime_ns: u128,
    pub(crate) ctime_ns: u128,
    pub(crate) inode: u64,
}

impl Stamp {
    pub(crate) fn of(metadata: &Metadata) -> Stamp {
        Stamp {
            mtime_ns: metadata.modified().ok().map_or(0, nanos_since_epoch),
            ctime_ns: ctime_ns(metadata),
            inode: inode(metadata),
        }
    }

    /// Whether the folder changed too recently for this stamp to prove it is unchanged.
    pub(crate) fn is_racy(&self, now: SystemTime) -> bool {
        let newest = self.mtime_ns.max(self.ctime_ns);
        nanos_since_epoch(now).saturating_sub(newest) < RACY_WINDOW_NANOS
    }
}

pub(crate) fn nanos_since_epoch(time: SystemTime) -> u128 {
    time.duration_since(UNIX_EPOCH)
        .map_or(0, |age| age.as_nanos())
}

#[cfg(unix)]
fn inode(metadata: &Metadata) -> u64 {
    std::os::unix::fs::MetadataExt::ino(metadata)
}

#[cfg(not(unix))]
fn inode(_metadata: &Metadata) -> u64 {
    0
}

#[cfg(unix)]
fn ctime_ns(metadata: &Metadata) -> u128 {
    use std::os::unix::fs::MetadataExt;
    let seconds = metadata.ctime();
    if seconds < 0 {
        return 0;
    }
    let nanos = u128::try_from(metadata.ctime_nsec()).unwrap_or(0);
    (seconds as u128) * 1_000_000_000 + nanos
}

#[cfg(not(unix))]
fn ctime_ns(metadata: &Metadata) -> u128 {
    metadata.created().ok().map_or(0, nanos_since_epoch)
}
