// SPDX-License-Identifier: Apache-2.0
//! Longest prefix of buffered deltas present at the end of a full text snapshot
//! (`packages/adapter-opencode/src/text-coverage.ts`). Linear in the snapshot's
//! units plus the changed text, with no history scan per delta.
//!
//! Rule 17: the TypeScript indexes the strings, so lengths are UTF-16 units,
//! not code points or bytes.

/// The number of UTF-16 units of `deltas` that the end of `snapshot` holds.
pub fn covered_prefix(snapshot: &str, deltas: &str) -> usize {
    let snapshot: Vec<u16> = snapshot.encode_utf16().collect();
    let deltas: Vec<u16> = deltas.encode_utf16().collect();
    if deltas.is_empty() || snapshot.is_empty() {
        return 0;
    }
    let limit = deltas.len().min(snapshot.len());
    // The deltas' own prefix table, one entry per unit the snapshot can match.
    let mut prefix = vec![0usize; limit];
    let mut matched = 0usize;
    for index in 1..limit {
        while matched > 0 && deltas[index] != deltas[matched] {
            matched = prefix[matched - 1];
        }
        if deltas[index] == deltas[matched] {
            matched += 1;
        }
        prefix[index] = matched;
    }
    matched = 0;
    for &unit in &snapshot {
        while matched > 0 && (matched == limit || unit != deltas[matched]) {
            matched = prefix[matched - 1];
        }
        if matched < limit && unit == deltas[matched] {
            matched += 1;
        }
    }
    matched
}

#[cfg(test)]
mod tests {
    use super::covered_prefix;

    #[test]
    fn an_empty_side_covers_nothing() {
        assert_eq!(covered_prefix("", "abc"), 0);
        assert_eq!(covered_prefix("abc", ""), 0);
        assert_eq!(covered_prefix("", ""), 0);
    }

    #[test]
    fn the_snapshots_tail_is_what_matches() {
        assert_eq!(covered_prefix("abc", "abc"), 3);
        assert_eq!(covered_prefix("xxabc", "abc"), 3);
        assert_eq!(covered_prefix("ab", "abc"), 2, "the snapshot is shorter");
        assert_eq!(covered_prefix("abcd", "bc"), 0, "not at the end");
        assert_eq!(
            covered_prefix("xxabc", "abcabc"),
            3,
            "no cycle past the end"
        );
        assert_eq!(covered_prefix("ababab", "abab"), 4);
        assert_eq!(covered_prefix("a", "aa"), 1);
    }

    #[test]
    fn lengths_are_utf16_units() {
        // An emoji is two units: the answer counts units, as `String.length` does.
        assert_eq!(covered_prefix("xx😀a", "😀a"), 3);
        assert_eq!("😀a".encode_utf16().count(), 3);
        assert_eq!(
            covered_prefix("ab😀", "ab😀"),
            4,
            "three characters, four units"
        );
        assert_eq!(covered_prefix("x😀", "😀"), 2);
        // The tail match counts units even where a code-point index would cut.
        assert_eq!(covered_prefix("x😀", "😀x"), 2);
    }
}
