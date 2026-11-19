//! What one move may carry (ADR 0187): limits checked before anything is read, written or held,
//! on the machine it leaves (a preflight of the files' sizes) and on the one it goes to (what
//! the manifest declares, then each part, row and file against it as it comes, and the free disk
//! before staging starts). Past a limit the move is refused and what it left is removed.

use std::path::Path;

use serde_json::Value;

/// Parts one move may have.
pub(super) const MOST_PARTS: u64 = 100_000;
/// Bytes of one part's JSON; the daemons carry at most 512 KiB a request.
pub(super) const MOST_PART_BYTES: u64 = 448 * 1024;
/// Bytes of every part together.
pub(super) const MOST_MOVE_BYTES: u64 = 12 * 1024 * 1024 * 1024;
/// Files and images one move may name.
pub(super) const MOST_INVENTORY: u64 = 250_000;
/// Bytes of the files and images together.
pub(super) const MOST_FILE_BYTES: u64 = 8 * 1024 * 1024 * 1024;
/// Bytes of one row, joined from its pieces.
pub(super) const MOST_ROW_BYTES: usize = 64 * 1024 * 1024;
/// Room kept free beside a move's staging.
const SPARE: u64 = 256 * 1024 * 1024;

/// What a manifest says the move holds, checked against the limits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct Declared {
    pub parts: u64,
    pub bytes: u64,
    pub files: u64,
    pub file_bytes: u64,
}

/// What the manifest declares, or why it is more than a move may carry.
pub(super) fn declared(manifest: &Value) -> Result<Declared, String> {
    let number = |value: &Value, what: &str| {
        value
            .as_u64()
            .ok_or_else(|| format!("the move doesn't say its {what}"))
    };
    let declared = Declared {
        parts: number(&manifest["parts"], "parts")?,
        bytes: number(&manifest["bytes"], "size")?,
        files: number(&manifest["inventory"]["count"], "files")?,
        file_bytes: number(&manifest["inventory"]["bytes"], "files' size")?,
    };
    within(declared)?;
    Ok(declared)
}

/// Whether a move of this size may be carried at all.
pub(super) fn within(declared: Declared) -> Result<(), String> {
    if declared.parts > MOST_PARTS {
        return Err(format!("the move has more than {MOST_PARTS} parts"));
    }
    if declared.bytes > MOST_MOVE_BYTES {
        return Err("the move is larger than a move may be".to_owned());
    }
    if declared.files > MOST_INVENTORY {
        return Err(format!("the move names more than {MOST_INVENTORY} files"));
    }
    if declared.file_bytes > MOST_FILE_BYTES {
        return Err(format!(
            "its files hold more than {} GB, more than a move carries",
            MOST_FILE_BYTES / (1024 * 1024 * 1024)
        ));
    }
    Ok(())
}

/// The disk a move needs where it arrives: its parts, its files put together, a staging
/// database no larger than its parts, and some to spare.
pub(super) fn room_needed(declared: Declared) -> u64 {
    declared
        .bytes
        .saturating_mul(2)
        .saturating_add(declared.file_bytes)
        .saturating_add(SPARE)
}

/// The bytes free for this user where `path` is, when the system says.
pub(super) fn free_bytes(path: &Path) -> Option<u64> {
    #[cfg(unix)]
    {
        let stat = rustix::fs::statvfs(path).ok()?;
        Some(stat.f_bavail.saturating_mul(stat.f_frsize))
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        None
    }
}

/// The files' sizes before any is copied: refused when they are more than a move carries.
pub(super) fn preflight(sizes: impl IntoIterator<Item = u64>, most: u64) -> Result<u64, String> {
    let mut total: u64 = 0;
    for size in sizes {
        total = total.saturating_add(size);
        if total > most {
            return Err(format!(
                "its files hold more than {} GB, more than a move carries",
                most / (1024 * 1024 * 1024)
            ));
        }
    }
    Ok(total)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{Declared, MOST_PARTS, declared, preflight, room_needed, within};

    fn of(parts: u64, bytes: u64, files: u64, file_bytes: u64) -> Declared {
        Declared {
            parts,
            bytes,
            files,
            file_bytes,
        }
    }

    #[test]
    fn a_move_past_any_limit_is_refused_before_anything_is_staged() {
        assert!(within(of(10, 1_000, 3, 500)).is_ok());
        for too_much in [
            of(MOST_PARTS + 1, 1, 0, 0),
            of(1, 13 * 1024 * 1024 * 1024, 0, 0),
            of(1, 1, 250_001, 0),
            of(1, 1, 1, 9 * 1024 * 1024 * 1024),
        ] {
            assert!(within(too_much).is_err(), "{too_much:?}");
        }
        let missing = json!({ "parts": 1, "inventory": { "count": 0, "bytes": 0 } });
        assert!(
            declared(&missing).is_err(),
            "a move that doesn't say its size"
        );
    }

    #[test]
    fn the_room_a_move_needs_counts_its_parts_twice_and_its_files_once() {
        let need = room_needed(of(1, 100, 1, 50));
        assert_eq!(need, 250 + 256 * 1024 * 1024);
        assert_eq!(room_needed(of(1, u64::MAX, 1, u64::MAX)), u64::MAX);
    }

    #[test]
    fn files_larger_together_than_a_move_carries_are_refused_before_one_is_read() {
        assert_eq!(preflight([10, 20], 100), Ok(30));
        assert!(preflight([60, 50], 100).is_err());
    }
}
