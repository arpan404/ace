// SPDX-License-Identifier: Apache-2.0

//! The spelling a folder actually stores for a name.
//!
//! On a case-insensitive volume `.GIT` finds `.git`, and the walk must report what is on disk
//! rather than what was asked for: name-based policies (is this `.git`? an upload temporary?)
//! only work on the stored spelling. On a case-sensitive volume the request is already the stored
//! spelling, and a probe tells us so without listing the folder.

use std::ffi::{OsStr, OsString};

use cap_std::fs::Dir;

/// The name `dir` stores for `name`, or `name` itself when the volume can tell case apart, when
/// `name` has no case, or when the folder cannot be listed.
pub(crate) fn stored_name(dir: &Dir, name: &OsStr) -> OsString {
    let Some(flipped) = flipped_case(name) else {
        return name.to_os_string();
    };
    // A volume that answers to the other case cannot tell the two spellings apart; one that does
    // not answer stores this name exactly as asked.
    if dir.symlink_metadata(&flipped).is_err() {
        return name.to_os_string();
    }
    let Ok(entries) = dir.entries() else {
        return name.to_os_string();
    };
    let mut folded = None;
    for entry in entries.flatten() {
        let found = entry.file_name();
        if found == name {
            return found;
        }
        if folded.is_none() && folds_together(&found, name) {
            folded = Some(found);
        }
    }
    folded.unwrap_or_else(|| name.to_os_string())
}

/// `name` with the case of its first cased character swapped, or `None` when it has none.
fn flipped_case(name: &OsStr) -> Option<OsString> {
    let text = name.to_str()?;
    let mut flipped = String::with_capacity(text.len());
    let mut flipped_one = false;
    for character in text.chars() {
        if !flipped_one && character.is_lowercase() {
            flipped.extend(character.to_uppercase());
            flipped_one = true;
        } else if !flipped_one && character.is_uppercase() {
            flipped.extend(character.to_lowercase());
            flipped_one = true;
        } else {
            flipped.push(character);
        }
    }
    flipped_one.then(|| OsString::from(flipped))
}

/// Whether two names are the same entry on a volume that ignores case.
fn folds_together(found: &OsStr, name: &OsStr) -> bool {
    let found = found.to_string_lossy().to_lowercase();
    let name = name.to_string_lossy().to_lowercase();
    found.trim_end_matches(' ') == name.trim_end_matches(' ')
}

#[cfg(test)]
mod tests {
    use std::ffi::{OsStr, OsString};

    use super::flipped_case;

    #[test]
    fn flips_the_first_cased_character() {
        assert_eq!(
            flipped_case(OsStr::new(".private")).map(OsString::into_string),
            Some(Ok(".Private".to_owned()))
        );
        assert_eq!(
            flipped_case(OsStr::new("README.md")).map(OsString::into_string),
            Some(Ok("rEADME.md".to_owned()))
        );
    }

    #[test]
    fn has_nothing_to_flip_without_case() {
        assert!(flipped_case(OsStr::new("123.456")).is_none());
        assert!(flipped_case(OsStr::new("---")).is_none());
    }
}
