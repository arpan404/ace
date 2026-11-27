// SPDX-License-Identifier: Apache-2.0
//! JavaScript string slices, for the places an id or sort key is cut to a schema bound.

/// The first `limit` UTF-16 code units of `text`, as `String.prototype.slice(0, limit)`.
///
/// A surrogate pair is never split: JavaScript would keep a lone surrogate, which JSON
/// escapes and a Rust string cannot hold, so the pair is left out whole. The result is
/// therefore at most `limit` units and always a valid string.
pub fn slice_utf16(text: &str, limit: usize) -> String {
    if text.is_ascii() {
        return text.chars().take(limit).collect();
    }
    let mut units = 0;
    let mut out = String::new();
    for character in text.chars() {
        let width = character.len_utf16();
        if units + width > limit {
            break;
        }
        units += width;
        out.push(character);
    }
    out
}
