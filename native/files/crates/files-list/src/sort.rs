// SPDX-License-Identifier: Apache-2.0

//! Ordering names the way VS Code's explorer does.
//!
//! VS Code sorts with `Intl.Collator(undefined, { numeric: true, sensitivity: "base" })`. ace
//! reaches that order without carrying a collator's data: names are decomposed with NFD,
//! combining marks are removed and the rest lowercased, so `éa` sorts with `ea` and before `eb`;
//! runs of digits compare by value, so `file2` comes before `file10`; and punctuation, whitespace
//! included, sorts before digits and letters, so `~x` comes before `a` and `a b` before `ab`.
//! Characters inside a class compare by code point, and the caller breaks remaining ties by the
//! exact name.
//!
//! The ICU collator produces the same order, but carrying its data grew the test binary by 1.2 MB
//! and made a 100,000-file sort four times slower, which the explorer cannot afford.

use std::cmp::Ordering;

use unicode_normalization::UnicodeNormalization;
use unicode_normalization::char::is_combining_mark;

/// The name to sort by: decomposed, without combining marks, lowercased.
pub(crate) fn fold(name: &str) -> String {
    if name.is_ascii() {
        return name.to_ascii_lowercase();
    }
    let mut folded = String::with_capacity(name.len());
    for character in name.nfd() {
        if is_combining_mark(character) {
            continue;
        }
        for lower in character.to_lowercase() {
            folded.push(lower);
        }
    }
    folded
}

/// Compares two folded names, treating every character as significant.
pub(crate) fn compare(left: &str, right: &str) -> Ordering {
    let mut at_left = 0;
    let mut at_right = 0;
    while at_left < left.len() && at_right < right.len() {
        let (left_char, left_next) = next_char(left, at_left);
        let (right_char, right_next) = next_char(right, at_right);
        if left_char.is_ascii_digit() && right_char.is_ascii_digit() {
            let (left_run, left_end) = digits(left, at_left);
            let (right_run, right_end) = digits(right, at_right);
            match compare_runs(left_run, right_run) {
                Ordering::Equal => {}
                other => return other,
            }
            at_left = left_end;
            at_right = right_end;
            continue;
        }
        let ordered = class(left_char)
            .cmp(&class(right_char))
            .then_with(|| left_char.cmp(&right_char));
        match ordered {
            Ordering::Equal => {}
            other => return other,
        }
        at_left = left_next;
        at_right = right_next;
    }
    (left.len() - at_left).cmp(&(right.len() - at_right))
}

fn next_char(text: &str, at: usize) -> (char, usize) {
    let character = text[at..]
        .chars()
        .next()
        .unwrap_or(char::REPLACEMENT_CHARACTER);
    (character, at + character.len_utf8())
}

/// The run of ASCII digits starting at `at`, and where it ends.
fn digits(text: &str, at: usize) -> (&str, usize) {
    let rest = &text[at..];
    let end = rest
        .find(|character: char| !character.is_ascii_digit())
        .unwrap_or(rest.len());
    (&rest[..end], at + end)
}

/// Compares two digit runs by value: fewer significant digits is smaller, then lexicographically.
fn compare_runs(left: &str, right: &str) -> Ordering {
    let left = left.trim_start_matches('0');
    let right = right.trim_start_matches('0');
    left.len().cmp(&right.len()).then_with(|| left.cmp(right))
}

/// Punctuation, symbols and whitespace first, then digits, then letters.
fn class(character: char) -> u8 {
    if character.is_ascii_digit() {
        1
    } else if character.is_ascii_alphabetic() {
        2
    } else if character.is_ascii() {
        0
    } else if character.is_numeric() {
        1
    } else if character.is_alphabetic() {
        2
    } else {
        0
    }
}
