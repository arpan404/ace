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

use notify::event::{CreateKind, EventKind, ModifyKind, RemoveKind};
use windows_sys::Win32::Storage::FileSystem::{
    FILE_ACTION_ADDED, FILE_ACTION_MODIFIED, FILE_ACTION_REMOVED,
};

/// The three `u32`s at the start of every record.
const HEADER: usize = 12;

/// The records one buffer holds, and whether the chain was whole.
pub(crate) struct Parsed {
    /// Every record whose name decoded, in the order the kernel wrote them.
    pub(crate) records: Vec<(u32, String)>,
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
        if let Some(name) = name {
            records.push((action, name));
        }
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

/// One record's action and distance to the next, and its name when the name is valid UTF-16.
fn step(bytes: &[u8], offset: usize) -> Option<(u32, u32, Option<String>)> {
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
    // A name that is not valid UTF-16 cannot be reported as the path the disk stores, but its
    // offsets were checked above, so the caller can move on to the record after it.
    Some((action, next, String::from_utf16(&units).ok()))
}

#[cfg(test)]
mod tests {
    use super::{FILE_ACTION_ADDED, FILE_ACTION_REMOVED, parse};
    use super::{HEADER, Parsed};

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
                (FILE_ACTION_ADDED, "src/main.rs".to_owned()),
                (FILE_ACTION_REMOVED, "old.txt".to_owned()),
            ]
        );
    }

    #[test]
    fn a_name_with_an_unpaired_surrogate_is_skipped_and_the_next_record_arrives() {
        // Windows can store a name with a lone surrogate. It has no UTF-8 spelling, but the
        // record after it is still good and must not be lost with it.
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
            [(FILE_ACTION_ADDED, "after.txt".to_owned())],
            "the unreadable name is skipped, not the record after it"
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
