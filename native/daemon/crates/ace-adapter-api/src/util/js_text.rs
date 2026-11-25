// SPDX-License-Identifier: Apache-2.0
//! JavaScript string predicates the input helpers share: `\s` in a regular expression and
//! `String.prototype.trimStart` (E5.4b). Rust's own `char::is_whitespace` differs at U+FEFF,
//! which JavaScript trims, so the set is spelled out once.

/// `\s`: WhiteSpace and LineTerminator, as a JavaScript regular expression matches them.
pub fn is_js_space(c: char) -> bool {
    matches!(
        c as u32,
        0x09..=0x0d
            | 0x20
            | 0xa0
            | 0x1680
            | 0x2000..=0x200a
            | 0x2028
            | 0x2029
            | 0x202f
            | 0x205f
            | 0x3000
            | 0xfeff
    )
}

#[cfg(test)]
mod tests {
    use super::is_js_space;

    #[test]
    fn the_set_is_javascripts_and_includes_the_byte_order_mark_rust_would_keep() {
        assert!(is_js_space('\u{feff}'));
        assert!(is_js_space('\u{a0}'));
        assert!(is_js_space('\n'));
        assert!(!is_js_space('\u{200b}'));
        assert!(!char::is_whitespace('\u{feff}'));
    }
}
