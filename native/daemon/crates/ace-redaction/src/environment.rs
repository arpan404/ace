// SPDX-License-Identifier: Apache-2.0
//! Exact configured values and their JSON-escaped spellings (`environment.ts`): an
//! Aho–Corasick over the values, so a credential a CLI echoes as a bare value is found
//! whatever surrounds it. A scan is linear in the text's length and the merged spans it
//! returns cover the union of overlapping values.
//!
//! Offsets are byte offsets (the TypeScript's are UTF-16 code units); a well-formed string's
//! UTF-8 is self-synchronising, so a value's bytes match exactly where its units would.

use std::collections::{HashMap, HashSet};

/// One sensitive span, as byte offsets in the scanned text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EnvironmentSpan {
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone, Default)]
struct State {
    next: HashMap<u8, usize>,
    fail: usize,
    /// The longest spelling ending here, in bytes (0: no spelling).
    longest: usize,
}

/// The matcher over one request's configured values. Built once and reused; the values are
/// never written anywhere.
#[derive(Debug, Clone, Default)]
pub struct EnvironmentMatcher {
    values: HashSet<String>,
    states: Vec<State>,
}

impl EnvironmentMatcher {
    /// A matcher over `values`, each also in its JSON-escaped spelling (`JSON.stringify`
    /// then the surrounding quotes removed), as `createEnvironmentMatcher` does.
    pub fn new<S: AsRef<str>>(values: &[S]) -> EnvironmentMatcher {
        let mut spellings: Vec<String> = Vec::with_capacity(values.len() * 2);
        let mut seen: HashSet<String> = HashSet::new();
        for value in values {
            let value = value.as_ref();
            let escaped = json_escape(value);
            for spelling in [value.to_owned(), escaped] {
                if !spelling.is_empty() && seen.insert(spelling.clone()) {
                    spellings.push(spelling);
                }
            }
        }
        let mut states = vec![State::default()];
        for spelling in &spellings {
            let mut node = 0;
            for byte in spelling.as_bytes() {
                node = match states[node].next.get(byte) {
                    Some(child) => *child,
                    None => {
                        states.push(State::default());
                        let child = states.len() - 1;
                        states[node].next.insert(*byte, child);
                        child
                    }
                };
            }
            states[node].longest = states[node].longest.max(spelling.len());
        }
        // Failure links breadth-first, as the TypeScript builds them: the root's children fail
        // to the root, and each deeper child inherits its failure's longest match.
        let mut queue: Vec<usize> = states[0].next.values().copied().collect();
        for child in &queue {
            states[*child].fail = 0;
        }
        let mut index = 0;
        while index < queue.len() {
            let node = queue[index];
            index += 1;
            let transitions: Vec<(u8, usize)> = states[node]
                .next
                .iter()
                .map(|(byte, child)| (*byte, *child))
                .collect();
            for (byte, child) in transitions {
                let mut fallback = states[node].fail;
                while fallback != 0 && !states[fallback].next.contains_key(&byte) {
                    fallback = states[fallback].fail;
                }
                let target = states[fallback].next.get(&byte).copied().unwrap_or(0);
                states[child].fail = target;
                let inherited = states[target].longest;
                states[child].longest = states[child].longest.max(inherited);
                queue.push(child);
            }
        }
        EnvironmentMatcher {
            values: values
                .iter()
                .map(|value| value.as_ref().to_owned())
                .collect(),
            states,
        }
    }

    /// The exact configured values, for a caller deciding whether a decoded value is one.
    pub fn values(&self) -> &HashSet<String> {
        &self.values
    }

    /// Whether there is anything to find.
    pub fn is_empty(&self) -> bool {
        self.values.is_empty()
    }

    /// The merged spans of every value occurrence. Matches arrive in end order; each
    /// interval is pushed and popped at most once, so the scan is linear.
    pub fn spans(&self, text: &str) -> Vec<EnvironmentSpan> {
        if self.states[0].next.is_empty() {
            return Vec::new();
        }
        let mut spans: Vec<EnvironmentSpan> = Vec::new();
        let mut node = 0;
        for (index, byte) in text.as_bytes().iter().enumerate() {
            while node != 0 && !self.states[node].next.contains_key(byte) {
                node = self.states[node].fail;
            }
            node = self.states[node].next.get(byte).copied().unwrap_or(0);
            let longest = self.states[node].longest;
            if longest == 0 {
                continue;
            }
            let mut start = index + 1 - longest;
            while let Some(previous) = spans.last() {
                if previous.end <= start {
                    break;
                }
                start = start.min(previous.start);
                spans.pop();
            }
            spans.push(EnvironmentSpan {
                start,
                end: index + 1,
            });
        }
        spans
    }
}

/// `JSON.stringify(value)` without its surrounding quotes.
fn json_escape(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len() + 2);
    ace_json::write_js_string(&mut escaped, &ace_json::JsString::from(value));
    if escaped.len() >= 2 {
        escaped[1..escaped.len() - 1].to_owned()
    } else {
        String::new()
    }
}

#[cfg(test)]
mod tests {
    use super::EnvironmentMatcher;

    fn spans(matcher: &EnvironmentMatcher, text: &str) -> Vec<(usize, usize)> {
        matcher
            .spans(text)
            .into_iter()
            .map(|span| (span.start, span.end))
            .collect()
    }

    #[test]
    fn an_exact_value_is_found_wherever_it_appears() {
        let matcher = EnvironmentMatcher::new(&["opaque-key-value"]);
        assert_eq!(
            spans(&matcher, "reason: opaque-key-value here"),
            vec![(8, 24)]
        );
        assert!(matcher.spans("nothing here").is_empty());
    }

    #[test]
    fn an_overlap_merges_into_one_span() {
        let matcher = EnvironmentMatcher::new(&["left{", "left{ right"]);
        assert_eq!(spans(&matcher, "a left{ right b"), vec![(2, 13)]);
    }

    #[test]
    fn a_json_escaped_spelling_is_found_too() {
        let matcher = EnvironmentMatcher::new(&["quote\"inside"]);
        assert_eq!(spans(&matcher, r#"{"v":"quote\"inside"}"#), vec![(6, 19)]);
    }

    #[test]
    fn overlapping_values_keep_the_trailing_credential_private() {
        let first = "A".repeat(129);
        let mut second = "A".repeat(128);
        second.push('B');
        let matcher = EnvironmentMatcher::new(&[first, second]);
        let text = format!("{}B after", "A".repeat(5_000));
        assert_eq!(spans(&matcher, &text), vec![(0, 5_001)]);
    }

    #[test]
    fn empty_values_are_ignored_and_the_value_set_is_kept() {
        let matcher = EnvironmentMatcher::new(&["", "value"]);
        assert!(matcher.spans("a value b").len() == 1);
        assert_eq!(matcher.values().len(), 2);
    }
}
