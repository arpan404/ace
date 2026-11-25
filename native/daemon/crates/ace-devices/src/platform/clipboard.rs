// SPDX-License-Identifier: Apache-2.0
//! `clipboard.ts`: a device clipboard's text bounded to the budget both backends use, and the
//! refusal Android gives without ace's live view.

use serde::Serialize;

use crate::platform::{Error, Refusal};

/// Clipboard text read or written in one call, in UTF-16 units: the same budget as typed text.
pub const CLIPBOARD_LIMIT: usize = 4096;

/// What a clipboard read returns: the text, cut to the limit when the device held more.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ClipboardRead {
    pub text: String,
    pub truncated: bool,
}

/// Bounds device clipboard text to the limit, never splitting a surrogate pair.
pub fn bounded(raw: &str, cut: bool) -> ClipboardRead {
    let units: usize = raw.chars().map(char::len_utf16).sum();
    if units <= CLIPBOARD_LIMIT {
        return ClipboardRead {
            text: raw.to_string(),
            truncated: cut,
        };
    }
    let mut used = 0;
    let mut end = 0;
    for (index, character) in raw.char_indices() {
        let width = character.len_utf16();
        if used + width > CLIPBOARD_LIMIT {
            break;
        }
        used += width;
        end = index + character.len_utf8();
    }
    ClipboardRead {
        text: raw[..end].to_string(),
        truncated: true,
    }
}

/// How long one `simctl pbcopy|pbpaste` may run before it is stopped.
pub const PASTEBOARD_TIMEOUT_MS: u64 = 10_000;
/// UTF-8 bytes that always hold `CLIPBOARD_LIMIT` UTF-16 units; anything past it is cut.
pub const PASTEBOARD_READ_BYTES: usize = CLIPBOARD_LIMIT * 4 + 4;

/// `simctl pbcopy|pbpaste <udid>`: the Simulator's pasteboard, read or written whole.
pub fn pasteboard_args(verb: &str, udid: &str) -> Vec<String> {
    vec!["simctl".to_string(), verb.to_string(), udid.to_string()]
}

/// One pasteboard command's whole plan: what it runs, its byte cap and its deadline.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct PasteboardPlan {
    pub args: Vec<String>,
    #[serde(rename = "readBytes")]
    pub read_bytes: usize,
    #[serde(rename = "timeoutMs")]
    pub timeout_ms: u64,
}

/// The plan for `simctl <verb> <udid>`; `verb` is `pbcopy` or `pbpaste`.
pub fn pasteboard_plan(verb: &str, udid: &str) -> PasteboardPlan {
    PasteboardPlan {
        args: pasteboard_args(verb, udid),
        read_bytes: PASTEBOARD_READ_BYTES,
        timeout_ms: PASTEBOARD_TIMEOUT_MS,
    }
}

/// Android's clipboard is reachable only over the scrcpy control socket of the live view.
pub fn android_unavailable() -> Error {
    Refusal::word("androidClipboardLiveView").into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_clipboard_within_the_budget_is_kept_exactly() {
        assert_eq!(
            bounded("first line\nsecond 👋\n", false),
            ClipboardRead {
                text: "first line\nsecond 👋\n".into(),
                truncated: false,
            }
        );
        assert!(bounded("short", true).truncated);
    }

    #[test]
    fn text_past_the_budget_is_cut_on_a_character_boundary_and_marked() {
        let long = "👋".repeat(40_000);
        let read = bounded(&long, false);
        assert!(read.truncated);
        assert_eq!(read.text, "👋".repeat(2048));

        // A budget ending inside a pair drops the pair rather than half of it.
        let odd = format!("a{}", "👋".repeat(4000));
        let read = bounded(&odd, false);
        assert_eq!(read.text.chars().count(), 1 + 2047);
        assert_eq!(read.text.chars().map(char::len_utf16).sum::<usize>(), 4095);
    }

    #[test]
    fn android_without_a_live_view_refuses_with_a_fix() {
        assert_eq!(
            android_unavailable().to_string(),
            "not_supported: The Android clipboard needs ace's live view of the emulator"
        );
    }
}
