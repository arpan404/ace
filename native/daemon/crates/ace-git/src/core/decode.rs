// SPDX-License-Identifier: Apache-2.0
//! Strict decoding of Git's output (`packages/git/src/decode.ts`, G2c): the
//! path, ref, hash and mode schemas, NUL framing, record readers and the
//! counts. Git's output is never guessed at; a deviation is `malformed_output`.

use ace_json::Value;

use crate::core::error::{GitError, GitErrorCode};

/// A full SHA-1 or SHA-256 object id.
pub fn hash_schema(value: &str) -> Option<String> {
    if (value.len() == 40 || value.len() == 64)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Some(value.to_owned());
    }
    None
}

/// The modes Git prints in an index or tree record.
pub const MODE_SCHEMA: &[&str] = &["000000", "040000", "100644", "100755", "120000", "160000"];

/// A repository-relative path: non-empty, no NUL, no absolute path, and no
/// empty, `.`, `..` or `.git` component. A bound of 1 counts code points.
pub fn path_schema(value: &str) -> Option<String> {
    if value.is_empty() || value.contains('\0') || value.starts_with('/') {
        return None;
    }
    if cfg!(windows)
        && (value.starts_with('\\') || (value.len() > 1 && value.as_bytes()[1] == b':'))
    {
        return None;
    }
    let components_ok = value.split('/').all(|part| {
        !part.is_empty() && part != "." && part != ".." && !part.eq_ignore_ascii_case(".git")
    });
    components_ok.then(|| value.to_owned())
}

/// An absolute path with no NUL. The bound of 1 counts code points.
pub fn absolute_path_schema(value: &str) -> Option<String> {
    let absolute = std::path::Path::new(value).is_absolute();
    (absolute && !value.is_empty() && !value.contains('\0')).then(|| value.to_owned())
}

/// A ref name Git would accept: no control characters, no `~^:?*[\`, no `..`,
/// no `@{`, and no component that is empty, starts or ends with `.`, or ends
/// with `.lock`.
pub fn ref_schema(value: &str) -> Option<String> {
    if value.is_empty() {
        return None;
    }
    for character in value.chars() {
        let code = character as u32;
        if code <= 32 || code == 127 || "~^:?*[\\".contains(character) {
            return None;
        }
    }
    if value.contains("..") || value.contains("@{") {
        return None;
    }
    let parts_ok = value.split('/').all(|part| {
        !part.is_empty()
            && !part.starts_with('.')
            && !part.ends_with('.')
            && !part.ends_with(".lock")
    });
    parts_ok.then(|| value.to_owned())
}

/// The decode context's error.
pub fn malformed(context: &str) -> GitError {
    GitError::new(
        GitErrorCode::MalformedOutput,
        format!("Malformed Git {context}"),
    )
}

pub fn hash(value: &str) -> Result<String, GitError> {
    hash_schema(value).ok_or_else(|| malformed("object hash"))
}

/// A count Git printed: digits, then a safe nonnegative integer.
pub fn count(value: &str) -> Result<u64, GitError> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(malformed("count"));
    }
    let parsed: u64 = value.parse().map_err(|_| malformed("count"))?;
    // `Number.MAX_SAFE_INTEGER`
    if parsed > 9_007_199_254_740_991 {
        return Err(malformed("count"));
    }
    Ok(parsed)
}

/// Strict UTF-8 NUL framing: a final NUL is required when the buffer is not empty.
pub fn nul(bytes: &[u8]) -> Result<Vec<String>, GitError> {
    if bytes.is_empty() {
        return Ok(Vec::new());
    }
    if bytes.last() != Some(&0) {
        return Err(malformed("NUL framing"));
    }
    let text = std::str::from_utf8(bytes).map_err(|_| malformed("UTF-8 metadata"))?;
    let mut records: Vec<String> = text.split('\0').map(str::to_owned).collect();
    records.pop();
    Ok(records)
}

/// Reads records in order, refusing to run out.
#[derive(Default)]
pub struct Records {
    position: usize,
    records: Vec<String>,
}

impl Records {
    pub fn new(records: Vec<String>) -> Self {
        Self {
            position: 0,
            records,
        }
    }

    pub fn peek(&self) -> Option<&str> {
        self.records.get(self.position).map(String::as_str)
    }

    #[allow(clippy::should_implement_trait)]
    pub fn next(&mut self) -> Result<&str, GitError> {
        let record = self
            .records
            .get(self.position)
            .map(String::as_str)
            .ok_or_else(|| malformed("record arity"))?;
        self.position += 1;
        Ok(record)
    }

    pub fn done(&self) -> bool {
        self.position == self.records.len()
    }
}

/// Splits `fieldCount` space-separated fields off `record`; the rest is its path.
pub fn fields_and_path(
    record: &str,
    field_count: usize,
) -> Result<(Vec<String>, String), GitError> {
    let mut offset = 0usize;
    let mut fields = Vec::with_capacity(field_count);
    for _ in 0..field_count {
        let rest = &record[offset..];
        let space = rest.find(' ').ok_or_else(|| malformed("record arity"))?;
        fields.push(rest[..space].to_owned());
        offset += space + 1;
    }
    let path = path_schema(&record[offset..]).ok_or_else(|| malformed("path"))?;
    Ok((fields, path))
}

/// Every ancestor of `path`, the path included, in order.
pub fn path_ancestors(path: &str) -> Vec<String> {
    let parts: Vec<&str> = path.split('/').collect();
    (1..=parts.len())
        .map(|end| parts[..end].join("/"))
        .collect()
}

/// `git version M.m.p`'s major and minor, as every caller's parser asks (`verifyGit`).
pub fn decode_version(text: &str) -> Result<Option<(u64, u64)>, GitError> {
    let Some(rest) = text.strip_prefix("git version ") else {
        return Ok(None);
    };
    let mut parts = rest.split('.');
    let mut numbers = Vec::with_capacity(3);
    for _ in 0..3 {
        let Some(part) = parts.next() else {
            return Ok(None);
        };
        // The whole first component is digits; later ones end at the first non-digit, as the
        // regex's capture does.
        let digits: String = if numbers.is_empty() {
            part.to_owned()
        } else {
            part.chars()
                .take_while(|character| character.is_ascii_digit())
                .collect()
        };
        if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
            return Ok(None);
        }
        numbers.push(count(&digits)?);
    }
    Ok(Some((
        numbers.first().copied().unwrap_or(0),
        numbers.get(1).copied().unwrap_or(0),
    )))
}

/// A JSON-visible answer for the shell: `{ major, minor }` or `null`.
pub fn version_to_json(version: Option<(u64, u64)>) -> String {
    match version {
        Some((major, minor)) => format!("{{\"major\":{major},\"minor\":{minor}}}"),
        None => "null".to_owned(),
    }
}

/// One text value from a frame, as a JS string would arrive.
pub fn text_value(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.to_string_lossy().into_owned()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_are_relative_without_dot_or_git_components() {
        assert_eq!(path_schema("src/main.ts").as_deref(), Some("src/main.ts"));
        assert_eq!(path_schema("a/README.md").as_deref(), Some("a/README.md"));
        for bad in [
            "", "/abs", "a//b", "a/./b", "a/../b", "a/.git/b", "a/.GIT", "a\0b",
        ] {
            assert_eq!(path_schema(bad), None, "{bad}");
        }
    }

    #[test]
    fn a_path_of_one_emoji_is_valid_because_the_bound_counts_code_points() {
        // One emoji is one code point but two UTF-16 units: a `.length` bound of 1 would
        // accept it, and so does a code-point bound of 1. The whole path is kept byte for byte.
        assert_eq!(path_schema("\u{1F600}").as_deref(), Some("\u{1F600}"));
        assert_eq!(
            path_schema("docs/\u{1F600}.md").as_deref(),
            Some("docs/\u{1F600}.md")
        );
        // And a component that is `.git` with an emoji is not `.git`.
        assert!(path_schema("\u{1F600}/.git").is_none());
    }

    #[test]
    fn refs_refuse_control_characters_sequences_and_lock_components() {
        assert_eq!(
            ref_schema("refs/heads/main").as_deref(),
            Some("refs/heads/main")
        );
        assert_eq!(ref_schema("HEAD").as_deref(), Some("HEAD"));
        for bad in [
            "",
            "a b",
            "a~1",
            "a^",
            "a:b",
            "a?",
            "a*",
            "a[",
            "a\\b",
            "a..b",
            "a@{1}",
            "a//b",
            "a/.hidden",
            "a/b.",
            "refs/heads/x.lock",
        ] {
            assert_eq!(ref_schema(bad), None, "{bad}");
        }
        assert_eq!(
            ref_schema("refs/heads/\u{1F600}").as_deref(),
            Some("refs/heads/\u{1F600}")
        );
    }

    #[test]
    fn hashes_are_full_lowercase_sha1_or_sha256_ids() {
        assert!(hash_schema(&"a".repeat(40)).is_some());
        assert!(hash_schema(&"f".repeat(64)).is_some());
        for bad in [
            String::new(),
            "A".repeat(40),
            "a".repeat(39),
            "g".repeat(40),
        ] {
            assert_eq!(hash_schema(&bad), None, "{bad}");
        }
    }

    #[test]
    fn counts_are_digits_and_stay_safe() {
        assert_eq!(count("0").ok(), Some(0));
        assert_eq!(count("42").ok(), Some(42));
        assert_eq!(count("9007199254740991").ok(), Some(9_007_199_254_740_991));
        for bad in ["", "-1", "1e3", " 1", "9007199254740992"] {
            assert_eq!(
                count(bad).err().map(|error| error.code),
                Some(GitErrorCode::MalformedOutput),
                "{bad}"
            );
        }
    }

    #[test]
    fn nul_framing_requires_its_terminator_and_valid_utf8() {
        assert_eq!(nul(b"").ok(), Some(Vec::new()));
        assert_eq!(
            nul(b"a\0b\0").ok(),
            Some(vec!["a".to_owned(), "b".to_owned()])
        );
        assert_eq!(nul(b"").ok().map(|records| records.len()), Some(0));
        assert!(nul(b"a\0b").is_err());
        assert!(nul(&[0xff, 0x00]).is_err());
    }

    #[test]
    fn record_readers_refuse_short_records_and_find_the_path() {
        let mut records = Records::new(vec!["one".to_owned(), "two".to_owned()]);
        assert_eq!(records.peek(), Some("one"));
        assert_eq!(records.next().ok(), Some("one"));
        assert_eq!(records.next().ok(), Some("two"));
        assert!(records.done());
        assert!(records.next().is_err());
        let (fields, path) = fields_and_path("100644 blob abc123 src/main.ts", 3).expect("fields");
        assert_eq!(fields, vec!["100644", "blob", "abc123"]);
        assert_eq!(path, "src/main.ts");
        assert!(fields_and_path("only one", 3).is_err());
    }

    #[test]
    fn version_text_keeps_the_regex_capture_semantics() {
        assert_eq!(
            decode_version("git version 2.48.1 (Apple Git-155)").ok(),
            Some(Some((2, 48)))
        );
        assert_eq!(
            decode_version("git version 2.40.0").ok(),
            Some(Some((2, 40)))
        );
        for bad in ["", "git version", "git version two.1.0", "git version 2"] {
            assert_eq!(decode_version(bad).ok().flatten(), None, "{bad}");
        }
    }

    #[test]
    fn ancestors_include_the_path_itself() {
        assert_eq!(
            path_ancestors("a/b/c.txt"),
            vec!["a".to_owned(), "a/b".to_owned(), "a/b/c.txt".to_owned()]
        );
        assert_eq!(path_ancestors("x"), vec!["x".to_owned()]);
    }
}
