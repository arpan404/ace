// SPDX-License-Identifier: Apache-2.0
//! Account badge labels and colours, from `packages/accounts/src/labels.ts`.

use unicode_segmentation::UnicodeSegmentation;

/// The badge's letter: the person's own short label, else the label's first grapheme, uppercased.
pub fn account_short_label(label: &str, short_label: Option<&str>) -> Option<String> {
    if let Some(short) = short_label {
        return Some(short.to_string());
    }
    label
        .trim()
        .graphemes(true)
        .next()
        .map(|first| first.to_uppercase())
}

/// Stable palette choice; UI tokens supply the matching ink for each theme.
pub fn default_account_badge_color(id: &str) -> &'static str {
    const PALETTE: [&str; 5] = ["blue", "violet", "amber", "rose", "green"];
    let mut hash: u32 = 2_166_136_261;
    for character in id.chars() {
        // `charCodeAt(0)`: the first UTF-16 unit, as JavaScript hashes an astral character.
        let mut units = [0u16; 2];
        let unit = character
            .encode_utf16(&mut units)
            .first()
            .copied()
            .unwrap_or(0);
        hash = (hash ^ u32::from(unit)).wrapping_mul(16_777_619);
    }
    PALETTE[(hash % PALETTE.len() as u32) as usize]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_badge_is_the_explicit_short_label_else_the_labels_first_grapheme() {
        assert_eq!(account_short_label("  Work ", None), Some("W".into()));
        assert_eq!(account_short_label("émile", None), Some("É".into()));
        // A combining mark belongs to the first grapheme, not a letter of its own.
        assert_eq!(
            account_short_label("e\u{0301}mile", None),
            Some("E\u{0301}".into())
        );
        assert_eq!(account_short_label("Work", Some("WK")), Some("WK".into()));
        assert_eq!(account_short_label("   ", None), None);
    }

    #[test]
    fn the_badge_colour_is_stable_for_an_id_and_stays_in_the_palette() {
        let first = default_account_badge_color("account-1");
        assert_eq!(first, default_account_badge_color("account-1"));
        for id in ["a", "codex", "account-346", "😀"] {
            assert!(
                ["blue", "violet", "amber", "rose", "green"]
                    .contains(&default_account_badge_color(id))
            );
        }
    }
}
