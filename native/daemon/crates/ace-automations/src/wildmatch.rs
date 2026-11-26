// SPDX-License-Identifier: Apache-2.0
//! `path.matchesGlob`'s subset that automation triggers use, checked against Node: `*` and `?`
//! never match a leading dot, `**` crosses separators but not into dot entries, and `{a,b}` and
//! the extglobs `@(a|b)`, `?(a|b)`, `+(a|b)` are supported.

/// Whether `path` matches `pattern` as Node's `path.matchesGlob` answers for these forms.
pub fn matches_glob(pattern: &str, path: &str) -> bool {
    let pattern: Vec<&str> = pattern.split('/').filter(|part| !part.is_empty()).collect();
    let path: Vec<&str> = path.split('/').filter(|part| !part.is_empty()).collect();
    match_segments(&pattern, &path)
}

fn match_segments(pattern: &[&str], path: &[&str]) -> bool {
    let Some((first, rest)) = pattern.split_first() else {
        return path.is_empty();
    };
    if *first == "**" {
        if rest.is_empty() {
            // A trailing `/**` needs at least one entry below it, as Node answers.
            return !path.is_empty() && path.iter().all(|segment| !segment.starts_with('.'));
        }
        if match_segments(rest, path) {
            return true;
        }
        for consumed in 1..=path.len() {
            if path[consumed - 1].starts_with('.') {
                break;
            }
            if match_segments(rest, &path[consumed..]) {
                return true;
            }
        }
        return false;
    }
    let Some((segment, remainder)) = path.split_first() else {
        return false;
    };
    segment_matches(first, segment) && match_segments(rest, remainder)
}

fn segment_matches(pattern: &str, name: &str) -> bool {
    let pattern: Vec<char> = pattern.chars().collect();
    let name: Vec<char> = name.chars().collect();
    glob(&pattern, &name, true)
}

fn glob(pattern: &[char], text: &[char], start: bool) -> bool {
    let Some((&first, rest)) = pattern.split_first() else {
        return text.is_empty();
    };
    if first == '*' && rest.first() == Some(&'(') {
        return extglob(pattern, text, start, ExtKind::Star);
    }
    if first == '@' && rest.first() == Some(&'(') {
        return extglob(pattern, text, start, ExtKind::At);
    }
    if first == '?' && rest.first() == Some(&'(') {
        return extglob(pattern, text, start, ExtKind::Optional);
    }
    if first == '+' && rest.first() == Some(&'(') {
        return extglob(pattern, text, start, ExtKind::Plus);
    }
    if first == '{' {
        return extglob(pattern, text, start, ExtKind::At);
    }
    match first {
        '*' => {
            if start && text.first() == Some(&'.') {
                return false;
            }
            for consumed in 0..=text.len() {
                if glob(rest, &text[consumed..], false) {
                    return true;
                }
            }
            false
        }
        '?' => {
            if start && text.first() == Some(&'.') {
                return false;
            }
            !text.is_empty() && glob(rest, &text[1..], false)
        }
        '[' => {
            let Some(close) = pattern.iter().position(|character| *character == ']') else {
                return false;
            };
            if close < 2 {
                return false;
            }
            let class = &pattern[1..close];
            let Some(&character) = text.first() else {
                return false;
            };
            let negated = class.first() == Some(&'!') || class.first() == Some(&'^');
            let class = if negated { &class[1..] } else { class };
            let mut matched = false;
            let mut index = 0;
            while index < class.len() {
                if index + 2 < class.len() && class[index + 1] == '-' {
                    if class[index] <= character && character <= class[index + 2] {
                        matched = true;
                    }
                    index += 3;
                } else {
                    if class[index] == character {
                        matched = true;
                    }
                    index += 1;
                }
            }
            (matched != negated) && glob(&pattern[close + 1..], &text[1..], false)
        }
        literal => !text.is_empty() && text[0] == literal && glob(rest, &text[1..], false),
    }
}

#[derive(Clone, Copy)]
enum ExtKind {
    At,
    Optional,
    Plus,
    Star,
}

fn extglob(pattern: &[char], text: &[char], start: bool, kind: ExtKind) -> bool {
    let brace = pattern[0] == '{';
    let open = usize::from(!brace);
    let close = match matching_close(pattern, open) {
        Some(close) => close,
        None => return false,
    };
    let separator = if brace { ',' } else { '|' };
    let body = &pattern[open + 1..close];
    let after = &pattern[close + 1..];
    let mut alternatives = Vec::new();
    let mut group = Vec::new();
    let mut depth = 0usize;
    for character in body {
        match character {
            '(' | '{' => {
                depth += 1;
                group.push(*character);
            }
            ')' | '}' if depth > 0 => {
                depth -= 1;
                group.push(*character);
            }
            character if *character == separator && depth == 0 => {
                alternatives.push(std::mem::take(&mut group));
            }
            character => group.push(*character),
        }
    }
    alternatives.push(group);
    let attempt = |alternative: &[char]| {
        let mut combined: Vec<char> = alternative.to_vec();
        combined.extend_from_slice(after);
        glob(&combined, text, start)
    };
    match kind {
        ExtKind::At => alternatives.iter().any(|alternative| attempt(alternative)),
        ExtKind::Optional => {
            if glob(after, text, start) {
                return true;
            }
            alternatives.iter().any(|alternative| attempt(alternative))
        }
        ExtKind::Plus => {
            let mut rest = text;
            loop {
                let before = rest.len();
                if !alternatives.iter().any(|alternative| {
                    let mut combined: Vec<char> = alternative.to_vec();
                    combined.extend_from_slice(after);
                    glob(&combined, rest, start)
                }) {
                    break;
                }
                // Consume the matched alternative and try again, bounded by the text length.
                let Some(consumed) = alternatives.iter().find_map(|alternative| {
                    (alternative.len() <= rest.len() && rest.starts_with(alternative))
                        .then_some(alternative.len())
                }) else {
                    break;
                };
                rest = &rest[consumed..];
                if rest.len() == before {
                    break;
                }
            }
            // At least one alternative, then the rest.
            alternatives.iter().any(|alternative| {
                alternative.len() <= text.len()
                    && text.starts_with(alternative)
                    && glob(after, &text[alternative.len()..], false)
            })
        }
        ExtKind::Star => {
            if glob(after, text, start) {
                return true;
            }
            alternatives.iter().any(|alternative| attempt(alternative))
        }
    }
}

fn matching_close(pattern: &[char], open: usize) -> Option<usize> {
    let opener = pattern[open];
    let closer = if opener == '(' { ')' } else { '}' };
    let mut depth = 0usize;
    for (index, character) in pattern.iter().enumerate().skip(open) {
        if *character == opener {
            depth += 1;
        } else if *character == closer {
            depth -= 1;
            if depth == 0 {
                return Some(index);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    // Answers taken from `node -e 'require("node:path").matchesGlob(path, pattern)'`.
    #[test]
    fn matches_the_node_table() {
        let table: &[(&str, &[&str])] = &[
            ("*", &["a.ts", "b.ts", "c.js"]),
            ("src/*", &["src/a.ts", "src/a.txt"]),
            ("**/*.ts", &["a.ts", "b.ts", "src/a.ts", "src/sub/a.ts"]),
            ("**/.env", &[".env", "src/.env"]),
            ("@(a|b).ts", &["a.ts", "b.ts"]),
            ("*.ts", &["a.ts", "b.ts"]),
            (
                "**",
                &[
                    "a.ts",
                    "b.ts",
                    "c.js",
                    "src/a.ts",
                    "src/sub/a.ts",
                    "src/a.txt",
                ],
            ),
            ("src/**", &["src/a.ts", "src/sub/a.ts", "src/a.txt"]),
            ("src/@(a|b).ts", &["src/a.ts"]),
            ("{a,b}.ts", &["a.ts", "b.ts"]),
            ("src/**/*.ts", &["src/a.ts", "src/sub/a.ts"]),
        ];
        let paths = [
            "a.ts",
            "b.ts",
            "c.js",
            ".env",
            "src/a.ts",
            "src/.env",
            "src/sub/a.ts",
            ".git/x",
            "src/a.txt",
        ];
        for (pattern, expected) in table {
            let matched: Vec<&str> = paths
                .iter()
                .copied()
                .filter(|path| matches_glob(pattern, path))
                .collect();
            assert_eq!(&matched, expected, "{pattern}");
        }
    }

    #[test]
    fn dot_and_glob_cases_from_the_review() {
        assert!(!matches_glob("*", ".env"));
        assert!(matches_glob("@(a|b).ts", "a.ts"));
        assert!(matches_glob("@(.env|a)", ".env"));
        assert!(matches_glob("[.]env", ".env"));
        assert!(!matches_glob("*.ts", "src/a.ts"));
        assert!(!matches_glob("src/**", "src"));
        assert!(matches_glob("**", "src/sub"));
        assert!(matches_glob("**", "src"));
    }
}
