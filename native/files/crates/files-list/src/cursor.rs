// SPDX-License-Identifier: Apache-2.0

//! The opaque paging cursor.
//!
//! It carries the folder's stamp and how many entries it held when the page was handed out, so a
//! cursor that outlived a change to the folder can be refused instead of silently skipping or
//! repeating entries. The caller never looks inside; only this module formats and parses it.

use crate::stamp::Stamp;

/// Where to resume a listing, and which version of the folder it was taken from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Cursor {
    /// The folder's stamp: modification time, change time and inode.
    pub(crate) stamp: Stamp,
    /// How many entries the folder held when the cursor was handed out.
    pub(crate) count: u64,
    /// How many entries had been read.
    pub(crate) offset: u64,
}

impl Cursor {
    /// A short, URL-safe token. The leading version keeps old cursors from being misread.
    pub(crate) fn encode(self) -> String {
        format!(
            "v2.{:x}.{:x}.{:x}.{:x}.{:x}",
            self.stamp.mtime_ns, self.stamp.ctime_ns, self.stamp.inode, self.count, self.offset
        )
    }

    /// `None` for anything this module did not write.
    pub(crate) fn decode(text: &str) -> Option<Cursor> {
        let rest = text.strip_prefix("v2.")?;
        let mut parts = rest.split('.');
        let stamp = Stamp {
            mtime_ns: u128::from_str_radix(parts.next()?, 16).ok()?,
            ctime_ns: u128::from_str_radix(parts.next()?, 16).ok()?,
            inode: u64::from_str_radix(parts.next()?, 16).ok()?,
        };
        let count = u64::from_str_radix(parts.next()?, 16).ok()?;
        let offset = u64::from_str_radix(parts.next()?, 16).ok()?;
        if parts.next().is_some() {
            return None;
        }
        Some(Cursor {
            stamp,
            count,
            offset,
        })
    }
}
