// SPDX-License-Identifier: Apache-2.0

//! The records `ReadDirectoryChangesW` writes into its buffer: each action and its UTF-16 name.
//!
//! A record is three little-endian `u32`s — the distance to the next record, the action, and
//! the name's length in bytes — followed by the name, padded to a four-byte boundary. The
//! buffer comes from the kernel, so every read is bounds-checked and a truncated or malformed
//! record ends the scan instead of panicking.

use notify::event::{CreateKind, EventKind, ModifyKind, RemoveKind, RenameMode};
use windows_sys::Win32::Storage::FileSystem::{
    FILE_ACTION_ADDED, FILE_ACTION_MODIFIED, FILE_ACTION_REMOVED, FILE_ACTION_RENAMED_NEW_NAME,
    FILE_ACTION_RENAMED_OLD_NAME,
};

/// The three `u32`s at the start of every record.
const HEADER: usize = 12;

/// The action and name of every record in a buffer, stopping at a truncated one.
pub(crate) fn parse(bytes: &[u8]) -> Vec<(u32, String)> {
    let mut records = Vec::new();
    let mut offset = 0usize;
    while let Some((action, next, name)) = record(bytes, offset) {
        records.push((action, name));
        if next == 0 {
            break;
        }
        // A next offset inside this record's own header would loop forever.
        if next < HEADER as u32 {
            break;
        }
        match offset.checked_add(next as usize) {
            Some(following) => offset = following,
            None => break,
        }
    }
    records
}

/// The notify event one record's action stands for.
pub(crate) fn kind(action: u32) -> Option<EventKind> {
    let kind = match action {
        FILE_ACTION_ADDED => EventKind::Create(CreateKind::Any),
        FILE_ACTION_REMOVED => EventKind::Remove(RemoveKind::Any),
        FILE_ACTION_MODIFIED => EventKind::Modify(ModifyKind::Any),
        // The kernel names the old path and the new one in separate records; translation
        // reads them as the deletion and the creation a rename is.
        FILE_ACTION_RENAMED_OLD_NAME => EventKind::Modify(ModifyKind::Name(RenameMode::From)),
        FILE_ACTION_RENAMED_NEW_NAME => EventKind::Modify(ModifyKind::Name(RenameMode::To)),
        _ => return None,
    };
    Some(kind)
}

/// One record: its action, its distance to the next record, and its relative name.
fn record(bytes: &[u8], offset: usize) -> Option<(u32, u32, String)> {
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
    // A name that is not valid UTF-16 cannot be reported as the path the disk stores.
    let name = String::from_utf16(&units).ok()?;
    Some((action, next, name))
}

#[cfg(test)]
mod tests {
    use super::{
        FILE_ACTION_ADDED, FILE_ACTION_REMOVED, FILE_ACTION_RENAMED_NEW_NAME, kind, parse,
    };
    use notify::event::{EventKind, ModifyKind, RenameMode};

    /// One record as the kernel lays it out: header, name, padding to a four-byte boundary.
    fn record(action: u32, name: &str, next: u32) -> Vec<u8> {
        let name: Vec<u16> = name.encode_utf16().collect();
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&next.to_le_bytes());
        bytes.extend_from_slice(&action.to_le_bytes());
        bytes.extend_from_slice(&(name.len() as u32 * 2).to_le_bytes());
        for unit in name {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        while bytes.len() % 4 != 0 {
            bytes.push(0);
        }
        bytes
    }

    #[test]
    fn records_are_read_in_order_with_their_paths() {
        let mut buffer = record(FILE_ACTION_ADDED, "src/main.rs", 28);
        buffer.extend(record(FILE_ACTION_REMOVED, "old.txt", 0));
        assert_eq!(
            parse(&buffer),
            [
                (FILE_ACTION_ADDED, "src/main.rs".to_owned()),
                (FILE_ACTION_REMOVED, "old.txt".to_owned()),
            ]
        );
    }

    #[test]
    fn a_truncated_name_ends_the_scan_instead_of_panicking() {
        let mut buffer = record(FILE_ACTION_ADDED, "src/main.rs", 28);
        buffer.truncate(buffer.len() - 4);
        assert!(parse(&buffer).is_empty());
    }

    #[test]
    fn a_new_name_is_the_creation_half_of_a_rename() {
        assert_eq!(
            kind(FILE_ACTION_RENAMED_NEW_NAME),
            Some(EventKind::Modify(ModifyKind::Name(RenameMode::To)))
        );
    }
}
