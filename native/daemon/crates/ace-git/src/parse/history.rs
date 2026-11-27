// SPDX-License-Identifier: Apache-2.0
//! Strict `git log --follow --name-status -z` parsing (`packages/git/src/parse-history.ts`,
//! G3c).
//!
//! Proof: `history.process`'s file-log cases (entries, renames, caps). A cut record ends the
//! list, never an error, because the daemon's byte cap may stop Git mid-record.

use serde::Serialize;

use crate::core::decode::hash_schema;

/// The `--format` this parser reads: five NUL-ended fields per commit.
pub const LOG_FORMAT: &str = "tformat:%H%x00%an%x00%ae%x00%at%x00%s%x00";

/// One file-log entry, in `GitLogEntry`'s field order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLogEntry {
    pub sha: String,
    pub short_sha: String,
    pub subject: String,
    pub author_name: String,
    pub author_email: String,
    pub authored_at: i64,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_path: Option<String>,
}

/// The entries read before the input ended, and whether it ended mid-record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedFileLog {
    pub entries: Vec<GitLogEntry>,
    pub incomplete: bool,
}

fn strip_newline(token: &str) -> &str {
    token
        .strip_prefix("\r\n")
        .or_else(|| token.strip_prefix('\n'))
        .unwrap_or(token)
}

/// A name-status code: one letter, a similarity score for renames and copies.
fn status_code(value: &str) -> bool {
    let mut characters = value.chars();
    matches!(characters.next(), Some(letter) if letter.is_ascii_uppercase())
        && characters.as_str().len() <= 3
        && characters
            .as_str()
            .bytes()
            .all(|byte| byte.is_ascii_digit())
}

/// JavaScript's `.slice(0, max)`: UTF-16 units, never past a code point this string can hold.
fn clamp_utf16(text: &str, max: usize) -> String {
    let mut units = 0usize;
    let mut end = 0usize;
    for (index, character) in text.char_indices() {
        let width = character.len_utf16();
        if units + width > max {
            break;
        }
        units += width;
        end = index + character.len_utf8();
    }
    text[..end].to_owned()
}

fn seconds(value: &str) -> Option<f64> {
    if value.is_empty() {
        return Some(0.0);
    }
    let parsed: f64 = value.parse().ok()?;
    parsed.is_finite().then_some(parsed)
}

/// Parses one file-log walk. `initial_path` is the path asked for: a commit with no status
/// keeps the path it had.
pub fn parse_file_log(stdout: &[u8], initial_path: &str, truncated: bool) -> ParsedFileLog {
    if stdout.is_empty() {
        return ParsedFileLog {
            entries: Vec::new(),
            incomplete: truncated,
        };
    }
    let text = String::from_utf8_lossy(stdout);
    let mut tokens: Vec<&str> = text.split('\0').collect();
    // The last token is what followed the last NUL: empty when whole, possibly cut when capped.
    tokens.pop();
    let mut entries = Vec::new();
    let mut path = initial_path.to_owned();
    let mut at = 0usize;
    while at < tokens.len() {
        let sha = strip_newline(tokens[at]);
        if hash_schema(sha).is_none() {
            return ParsedFileLog {
                entries,
                incomplete: true,
            };
        }
        let fields = &tokens[at + 1..tokens.len().min(at + 6)];
        if fields.len() < 5 || !fields[4].is_empty() {
            return ParsedFileLog {
                entries,
                incomplete: true,
            };
        }
        let author_name = fields[0];
        let author_email = fields[1];
        let Some(time) = seconds(fields[2]) else {
            return ParsedFileLog {
                entries,
                incomplete: true,
            };
        };
        if time < 0.0 {
            return ParsedFileLog {
                entries,
                incomplete: true,
            };
        }
        let subject = fields[3];
        let mut next = at + 6;
        let mut previous_path: Option<String> = None;
        let mut next_path = path.clone();
        let status = tokens.get(next).copied();
        if status.is_some_and(|status| status_code(strip_newline(status))) {
            let code = strip_newline(status.unwrap_or_default()).to_owned();
            let two = code.starts_with('R') || code.starts_with('C');
            let names = &tokens[next + 1..tokens.len().min(next + if two { 3 } else { 2 })];
            if names.len() < if two { 2 } else { 1 } {
                return ParsedFileLog {
                    entries,
                    incomplete: true,
                };
            }
            if two {
                previous_path = Some(names[0].to_owned());
                path = names.get(1).map(|name| (*name).to_owned()).unwrap_or(path);
                next_path = names[0].to_owned();
            } else {
                path = names[0].to_owned();
                next_path = path.clone();
            }
            next += if two { 3 } else { 2 };
        } else if status.is_none() && truncated {
            // Cut right after the header: the status that may follow is unknown.
            return ParsedFileLog {
                entries,
                incomplete: true,
            };
        }
        entries.push(GitLogEntry {
            sha: sha.to_owned(),
            short_sha: sha.chars().take(7).collect(),
            subject: clamp_utf16(subject, 4096),
            author_name: clamp_utf16(author_name, 512),
            author_email: clamp_utf16(author_email, 512),
            authored_at: (time.trunc() as i64) * 1000,
            path: path.clone(),
            previous_path,
        });
        path = next_path;
        at = next;
    }
    ParsedFileLog {
        entries,
        incomplete: truncated,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHA: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn record(subject: &str, status: Option<&str>) -> String {
        let mut text = format!("{SHA}\0Ana\0ana@example.invalid\01700000000\0{subject}\0\0");
        if let Some(status) = status {
            text.push_str(status);
            text.push('\0');
            text.push_str("file.txt\0");
        }
        text
    }

    #[test]
    fn a_record_reads_its_fields_and_the_path_it_had_before_a_rename() {
        let parsed = parse_file_log(record("first", None).as_bytes(), "file.txt", false);
        assert_eq!(
            parsed,
            ParsedFileLog {
                entries: vec![GitLogEntry {
                    sha: SHA.to_owned(),
                    short_sha: SHA[..7].to_owned(),
                    subject: "first".to_owned(),
                    author_name: "Ana".to_owned(),
                    author_email: "ana@example.invalid".to_owned(),
                    authored_at: 1_700_000_000_000,
                    path: "file.txt".to_owned(),
                    previous_path: None,
                }],
                incomplete: false,
            }
        );
        // `-z` puts a newline before each status field; a rename reports both names.
        let renamed = format!(
            "{SHA}\0Ana\0ana@example.invalid\01700000000\0rename\0\0\nR087\0old.txt\0new.txt\0"
        );
        let parsed = parse_file_log(renamed.as_bytes(), "new.txt", false);
        assert_eq!(parsed.entries.len(), 1);
        assert_eq!(parsed.entries[0].path, "new.txt");
        assert_eq!(parsed.entries[0].previous_path.as_deref(), Some("old.txt"));
    }

    #[test]
    fn a_cut_record_ends_the_list_without_an_error_and_keeps_the_complete_entries() {
        let whole = record("one", None);
        let cut = format!("{whole}{SHA}\0Ana");
        let parsed = parse_file_log(cut.as_bytes(), "file.txt", true);
        assert_eq!(parsed.entries.len(), 1);
        assert!(parsed.incomplete);
        // Truncated right after a header leaves the following status unknown.
        let header = format!("{SHA}\0Ana\0ana@example.invalid\01700000000\0two\0\0");
        let parsed = parse_file_log(header.as_bytes(), "file.txt", true);
        assert!(parsed.entries.is_empty());
        assert!(parsed.incomplete);
        // The same bytes whole are one entry with no status.
        let parsed = parse_file_log(header.as_bytes(), "file.txt", false);
        assert_eq!(parsed.entries.len(), 1);
        assert!(!parsed.incomplete);
    }

    #[test]
    fn a_non_commit_token_and_a_bad_time_end_the_list() {
        for text in [
            concat!("not-a-hash\0Ana\0a@b\0", "1700000000\0s\0\0").to_owned(),
            format!("{SHA}\0Ana\0a@b\0not-a-time\0s\0\0"),
            format!("{SHA}\0Ana\0a@b\0-1\0s\0\0"),
        ] {
            let parsed = parse_file_log(text.as_bytes(), "file.txt", false);
            assert!(parsed.entries.is_empty(), "{text}");
            assert!(parsed.incomplete, "{text}");
        }
    }

    #[test]
    fn the_subject_and_author_bounds_count_utf16_units_as_the_type_script_slices_do() {
        // 2,048 emoji are 4,096 UTF-16 units: they fit exactly.
        let subject: String = "\u{1F600}".repeat(2_048);
        let text = format!("{SHA}\0Ana\0a@b\01700000000\0{subject}\0\0");
        let parsed = parse_file_log(text.as_bytes(), "file.txt", false);
        assert_eq!(parsed.entries[0].subject, subject);
        // One more emoji would exceed the bound; it is dropped whole.
        let subject: String = "\u{1F600}".repeat(2_049);
        let text = format!("{SHA}\0Ana\0a@b\01700000000\0{subject}\0\0");
        let parsed = parse_file_log(text.as_bytes(), "file.txt", false);
        assert_eq!(parsed.entries[0].subject, "\u{1F600}".repeat(2_048));
        let name: String = "\u{1F600}".repeat(300);
        let text = format!("{SHA}\0{name}\0a@b\01700000000\0s\0\0");
        let parsed = parse_file_log(text.as_bytes(), "file.txt", false);
        assert_eq!(parsed.entries[0].author_name, "\u{1F600}".repeat(256));
    }
}
