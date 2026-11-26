// SPDX-License-Identifier: Apache-2.0
//! JavaScript's string arithmetic, where the engine's bounds are plain `.length`, `.slice()` or
//! `.substring()` (the porting guide's rule 17): those count UTF-16 units, so a bound can fall
//! inside a surrogate pair. Rust strings cannot hold a lone surrogate, so the prefix keeps the
//! whole scalar and is therefore at most one unit short there.

/// `text.slice(0, max)` as far as a Rust `String` can carry it: whole scalars while their UTF-16
/// width fits under `max`. A JavaScript slice that ends inside a pair yields one unit fewer here.
pub(crate) fn utf16_prefix(text: &str, max: usize) -> &str {
    let mut units = 0usize;
    for (index, character) in text.char_indices() {
        let width = character.len_utf16();
        if units + width > max {
            return &text[..index];
        }
        units += width;
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_utf16_bound_keeps_whole_scalars_and_counts_units_not_characters() {
        let text = "😀".repeat(150);
        assert_eq!(utf16_prefix(&text, 200).encode_utf16().count(), 200);
        assert_eq!(utf16_prefix(&text, 200).chars().count(), 100);
        // JavaScript would keep the high surrogate here; a Rust string cannot.
        assert_eq!(utf16_prefix(&format!("a{}", "😀".repeat(150)), 2), "a");
        assert_eq!(utf16_prefix("short", 200), "short");
    }
}
