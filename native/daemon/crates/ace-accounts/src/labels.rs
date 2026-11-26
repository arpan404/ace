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

/// `AccountShortLabel`: a new badge input, or a stored badge of up to three characters.
/// Older stored three-letter badges remain readable; mutations use the badge input.
pub fn valid_short_label(value: &str) -> bool {
    valid_badge_input(value) || valid_stored_short_label(value)
}

/// The stored branch: `^\S{1,3}$`, counted in code points as the TypeScript's `u` flag does.
pub fn valid_stored_short_label(value: &str) -> bool {
    let count = value.chars().count();
    (1..=3).contains(&count) && !value.chars().any(char::is_whitespace)
}

/// `AccountBadgeInput`: one or two text graphemes, at most 64 UTF-16 units, no whitespace or
/// format characters, and no picture: emoji, regional indicators and keycaps are not badges.
pub fn valid_badge_input(value: &str) -> bool {
    if value.is_empty() || value.encode_utf16().count() > 64 {
        return false;
    }
    if value
        .chars()
        .any(|c| c.is_whitespace() || is_control(c) || is_format(c))
    {
        return false;
    }
    if value
        .chars()
        .any(|c| is_extended_pictographic(c) || is_regional_indicator(c) || c == '\u{20e3}')
    {
        return false;
    }
    UnicodeSegmentation::graphemes(value, true).count() <= 2
}

/// `\p{Cc}`.
fn is_control(character: char) -> bool {
    matches!(character, '\u{00}'..='\u{1f}' | '\u{7f}'..='\u{9f}')
}

/// `\p{Cf}`: format characters, the bidi marks and the invisible joiners they include.
fn is_format(character: char) -> bool {
    matches!(
        character,
        '\u{ad}'
            | '\u{600}'..='\u{605}'
            | '\u{61c}'
            | '\u{6dd}'
            | '\u{70f}'
            | '\u{180e}'
            | '\u{200b}'..='\u{200f}'
            | '\u{202a}'..='\u{202e}'
            | '\u{2060}'..='\u{2064}'
            | '\u{2066}'..='\u{206f}'
            | '\u{feff}'
            | '\u{fff9}'..='\u{fffb}'
    )
}

/// `\p{Extended_Pictographic}`: the emoji property's picture ranges, including ©, ® and ™.
fn is_extended_pictographic(character: char) -> bool {
    matches!(
        character,
        '\u{a9}'
            | '\u{ae}'
            | '\u{203c}'
            | '\u{2049}'
            | '\u{2122}'
            | '\u{2139}'
            | '\u{2194}'..='\u{2199}'
            | '\u{21a9}'..='\u{21aa}'
            | '\u{231a}'..='\u{231b}'
            | '\u{2328}'
            | '\u{23cf}'
            | '\u{23e9}'..='\u{23f3}'
            | '\u{23f8}'..='\u{23fa}'
            | '\u{24c2}'
            | '\u{25aa}'..='\u{25ab}'
            | '\u{25b6}'
            | '\u{25c0}'
            | '\u{25fb}'..='\u{25fe}'
            | '\u{2600}'..='\u{27bf}'
            | '\u{2934}'..='\u{2935}'
            | '\u{2b05}'..='\u{2b07}'
            | '\u{2b1b}'..='\u{2b1c}'
            | '\u{2b50}'
            | '\u{2b55}'
            | '\u{3030}'
            | '\u{303d}'
            | '\u{3297}'
            | '\u{3299}'
            | '\u{1f000}'..='\u{1faff}'
            | '\u{1fc00}'..='\u{1fffd}'
    )
}

/// `\p{Regional_Indicator}`.
fn is_regional_indicator(character: char) -> bool {
    matches!(character, '\u{1f1e6}'..='\u{1f1ff}')
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

    // packages/accounts/src/instances.process.test.ts
    // "stored three-character badges still read, and a new badge refuses pictures"
    #[test]
    fn stored_three_character_badges_still_read_and_a_new_badge_refuses_pictures() {
        // The stored branch is `^\S{1,3}$`: invisible format marks are not whitespace, so
        // they read back too.
        for stored in ["ABC", "WK", "W", "©", "Åb", "日本", "A\u{200b}"] {
            assert!(valid_short_label(stored), "{stored}");
        }
        for invalid in ["", "ABCD", "A B", "A\n"] {
            assert!(!valid_short_label(invalid), "{invalid:?}");
        }
        // A picture is not a badge: not © as an emoji property, nor a flag or a keycap.
        for picture in ["©", "®", "™", "😀", "🇬🇧", "1\u{20e3}", "👍🏽"] {
            assert!(!valid_badge_input(picture), "{picture}");
        }
        assert!(valid_badge_input("AB"));
        assert!(valid_badge_input("W"));
        assert!(valid_badge_input("e\u{0301}"));
        assert!(!valid_badge_input("ABC"));
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
