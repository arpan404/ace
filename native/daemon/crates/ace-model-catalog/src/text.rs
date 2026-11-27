// SPDX-License-Identifier: Apache-2.0
//! Cutting text in the unit the TypeScript cut it in.
//!
//! `String.prototype.slice` counts UTF-16 code units, so a character outside the basic
//! plane counts twice there and once in Rust. These helpers keep the TypeScript's
//! cut-off points, and never split a character to reach one.

/// The longest prefix of `text` that fits in `units` UTF-16 code units.
pub fn utf16_prefix(text: &str, units: usize) -> String {
    let mut used = 0;
    text.chars()
        .take_while(|character| {
            used += character.len_utf16();
            used <= units
        })
        .collect()
}

#[cfg(test)]
mod tests {
    //! The TypeScript measured these limits with `.length` and `.slice`, which count
    //! astral characters twice; `packages/models/src/resolve.test.ts` and
    //! `packages/provider-kit/src/cli-versions.ts` are the sources.

    use super::*;

    #[test]
    fn a_cut_counts_utf16_units_as_the_typescript_did() {
        assert_eq!(utf16_prefix("abcdef", 4), "abcd");
        // Two units each: 1 and 2 leave one whole astral character.
        assert_eq!(utf16_prefix("a🌍b", 2), "a");
        assert_eq!(utf16_prefix("a🌍b", 3), "a🌍");
        assert_eq!(utf16_prefix("🌍🌍", 4), "🌍🌍");
        assert_eq!(utf16_prefix("🌍", 1), "");
        assert_eq!(utf16_prefix("anything", 0), "");
        assert_eq!(utf16_prefix("short", 1024), "short");
    }
}
