// SPDX-License-Identifier: Apache-2.0

//! The records `ReadDirectoryChangesW` writes into its buffer: each action and its UTF-16 name.
//!
//! A record is three little-endian `u32`s — the distance to the next record, the action, and
//! the name's length in bytes — followed by the name, padded to a four-byte boundary. The
//! buffer comes from the kernel, so every read is bounds-checked.
//!
//! A name that is not valid UTF-16 (an unpaired surrogate is a name Windows can store) is
//! skipped by its own validated offset, because the records after it are still good. A chain
//! that is cut short or points outside the buffer is different: everything after it is lost,
//! and [`Parsed::whole`] tells the caller to ask for a rescan.

use std::ffi::OsString;
use std::os::windows::ffi::OsStringExt;

use notify::event::{CreateKind, EventKind, ModifyKind, RemoveKind};
use windows_sys::Win32::Storage::FileSystem::{
    FILE_ACTION_ADDED, FILE_ACTION_MODIFIED, FILE_ACTION_REMOVED,
};

/// The three `u32`s at the start of every record.
const HEADER: usize = 12;

/// The records one buffer holds, and whether the chain was whole.
pub(crate) struct Parsed {
    /// Every record and its raw name, in the order the kernel wrote them. Windows can store a
    /// name with an unpaired surrogate, which has no UTF-8 spelling but is still a name; keeping
    /// it lets a rename pair see that a record sits between its halves.
    pub(crate) records: Vec<(u32, OsString)>,
    /// False when a record was cut short or pointed outside the buffer: the rest of the buffer
    /// is lost.
    pub(crate) whole: bool,
}

/// The action and name of every record in a buffer that can be read.
pub(crate) fn parse(bytes: &[u8]) -> Parsed {
    let mut records = Vec::new();
    let mut offset = 0usize;
    loop {
        let Some((action, next, name)) = step(bytes, offset) else {
            return Parsed {
                records,
                whole: false,
            };
        };
        records.push((action, name));
        if next == 0 {
            return Parsed {
                records,
                whole: true,
            };
        }
        // A next offset inside this record's own header would loop forever.
        if next < HEADER as u32 {
            return Parsed {
                records,
                whole: false,
            };
        }
        match offset.checked_add(next as usize) {
            Some(following) => offset = following,
            None => {
                return Parsed {
                    records,
                    whole: false,
                };
            }
        }
    }
}

/// The notify event one record's action stands for. Rename halves are paired by the caller.
pub(crate) fn kind(action: u32) -> Option<EventKind> {
    let kind = match action {
        FILE_ACTION_ADDED => EventKind::Create(CreateKind::Any),
        FILE_ACTION_REMOVED => EventKind::Remove(RemoveKind::Any),
        FILE_ACTION_MODIFIED => EventKind::Modify(ModifyKind::Any),
        _ => return None,
    };
    Some(kind)
}

/// One record's action, distance to the next, and raw name.
fn step(bytes: &[u8], offset: usize) -> Option<(u32, u32, OsString)> {
    let start = offset.checked_add(HEADER)?;
    let header = bytes.get(offset..start)?;
    let next = u32::from_le_bytes(header[0..4].try_into().ok()?);
    let action = u32::from_le_bytes(header[4..8].try_into().ok()?);
    let length = u32::from_le_bytes(header[8..12].try_into().ok()?) as usize;
    let end = start.checked_add(length)?;
    let name = bytes.get(start..end)?;
    let units: Vec<u16> = name
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    // The raw UTF-16 name keeps even an unpaired surrogate: it is a name Windows can store, and
    // a record that sits between two rename halves must still be seen as one.
    Some((action, next, OsString::from_wide(&units)))
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;

    use notify::event::{CreateKind, EventKind, ModifyKind, RenameMode};
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_ACTION_RENAMED_NEW_NAME, FILE_ACTION_RENAMED_OLD_NAME,
    };

    use super::{FILE_ACTION_ADDED, FILE_ACTION_REMOVED, parse};
    use super::{HEADER, Parsed};
    use crate::windows::Rename;

    /// One record with its name as raw UTF-16 units, so a test can write a surrogate.
    fn raw(action: u32, units: &[u16]) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&0u32.to_le_bytes());
        bytes.extend_from_slice(&action.to_le_bytes());
        bytes.extend_from_slice(&(units.len() as u32 * 2).to_le_bytes());
        for unit in units {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        while bytes.len() % 4 != 0 {
            bytes.push(0);
        }
        bytes
    }

    /// One record as the kernel lays it out for an ordinary name.
    fn record(action: u32, name: &str) -> Vec<u8> {
        raw(action, &name.encode_utf16().collect::<Vec<_>>())
    }

    /// Records laid end to end, each naming the distance to the next one, as the kernel does.
    fn chain(records: &[(u32, &str)]) -> Vec<u8> {
        let mut buffer = Vec::new();
        let mut starts = Vec::new();
        for (action, name) in records {
            starts.push(buffer.len());
            buffer.extend(record(*action, name));
        }
        for pair in starts.windows(2) {
            let next = (pair[1] - pair[0]) as u32;
            buffer[pair[0]..pair[0] + 4].copy_from_slice(&next.to_le_bytes());
        }
        buffer
    }

    /// The same, for records whose names are raw units.
    fn chain_raw(records: &[(u32, &[u16])]) -> Vec<u8> {
        let mut buffer = Vec::new();
        let mut starts = Vec::new();
        for (action, units) in records {
            starts.push(buffer.len());
            buffer.extend(raw(*action, units));
        }
        for pair in starts.windows(2) {
            let next = (pair[1] - pair[0]) as u32;
            buffer[pair[0]..pair[0] + 4].copy_from_slice(&next.to_le_bytes());
        }
        buffer
    }

    #[test]
    fn records_are_read_in_order_with_their_paths() {
        let buffer = chain(&[
            (FILE_ACTION_ADDED, "src/main.rs"),
            (FILE_ACTION_REMOVED, "old.txt"),
        ]);
        let parsed = parse(&buffer);
        assert!(parsed.whole);
        assert_eq!(
            parsed.records,
            [
                (FILE_ACTION_ADDED, OsString::from("src/main.rs")),
                (FILE_ACTION_REMOVED, OsString::from("old.txt")),
            ]
        );
    }

    #[test]
    fn a_name_with_an_unpaired_surrogate_is_kept_raw_and_the_next_record_arrives() {
        // Windows can store a name with a lone surrogate. It has no UTF-8 spelling, but it is a
        // record, so a rename pair must see it sit between its halves.
        let buffer = chain_raw(&[
            (FILE_ACTION_ADDED, &[0xD800]),
            (
                FILE_ACTION_ADDED,
                &"after.txt".encode_utf16().collect::<Vec<_>>(),
            ),
        ]);
        let parsed = parse(&buffer);
        assert!(parsed.whole, "the chain itself is intact");
        assert_eq!(
            parsed.records,
            [
                (FILE_ACTION_ADDED, OsString::from_wide(&[0xD800])),
                (FILE_ACTION_ADDED, OsString::from("after.txt")),
            ]
        );
    }

    #[test]
    fn a_raw_record_between_rename_halves_stops_them_pairing() {
        // The old half, a record whose name has no UTF-8 spelling, then the new half: the middle
        // record ends the pair, so the new name is a creation of its own.
        let buffer = chain_raw(&[
            (
                FILE_ACTION_RENAMED_OLD_NAME,
                &"foo.txt".encode_utf16().collect::<Vec<_>>(),
            ),
            (FILE_ACTION_ADDED, &[0xD800]),
            (
                FILE_ACTION_RENAMED_NEW_NAME,
                &"bar.txt".encode_utf16().collect::<Vec<_>>(),
            ),
        ]);
        let parsed = parse(&buffer);
        assert!(parsed.whole);
        let mut renames = Rename::default();
        let mut out = Vec::new();
        renames.events(std::path::Path::new("root"), &parsed.records, &mut out);
        assert_eq!(out.len(), 3);
        assert_eq!(
            out[0].kind,
            EventKind::Modify(ModifyKind::Name(RenameMode::From)),
            "the lone old half is a deletion"
        );
        assert_eq!(out[1].kind, EventKind::Create(CreateKind::Any));
        assert_eq!(
            out[2].kind,
            EventKind::Modify(ModifyKind::Name(RenameMode::To)),
            "the new half must not pair with the old one across another record"
        );
    }

    #[test]
    fn a_truncated_name_is_not_whole() {
        let mut buffer = record(FILE_ACTION_ADDED, "src/main.rs");
        buffer.truncate(buffer.len() - 4);
        assert_eq!(parse(&buffer).records, Vec::new());
        assert!(!parse(&buffer).whole);
    }

    #[test]
    fn a_next_offset_inside_its_own_header_is_not_whole() {
        let mut buffer = record(FILE_ACTION_ADDED, "src/main.rs");
        buffer[0..4].copy_from_slice(&(HEADER as u32 - 1).to_le_bytes());
        let parsed: Parsed = parse(&buffer);
        assert_eq!(parsed.records.len(), 1, "the record itself decoded");
        assert!(!parsed.whole);
    }
}
