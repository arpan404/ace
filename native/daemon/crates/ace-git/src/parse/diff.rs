// SPDX-License-Identifier: Apache-2.0
//! Strict `git diff --raw --numstat -z` parsing (`packages/git/src/parse-diff.ts`, G3b).
//!
//! Proof: `malformed-output.test.ts`'s "diff" cases (moved here), and the commit-side results
//! `diff.process`, `diff-resources.process` and `review-regressions.process` assert.

use serde::Serialize;

use crate::core::decode::{MODE_SCHEMA, Records, count, hash, malformed, nul, path_schema};
use crate::core::error::GitError;
use crate::parse::numstat::numstat_record;

/// One changed file as the diff result reports it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffEntry {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    pub status: String,
    pub additions: u64,
    pub deletions: u64,
    pub binary: bool,
}

/// One raw record's object facts, beside its result entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffFile {
    pub entry: DiffEntry,
    pub old_sha: String,
    pub new_sha: String,
    pub old_mode: String,
    pub new_mode: String,
}

fn mode_schema(value: &str) -> bool {
    MODE_SCHEMA.contains(&value)
}

fn status_schema(value: &str) -> bool {
    matches!(value, "A" | "M" | "D" | "R" | "C" | "T")
}

fn diff_status_code(code: &str) -> Result<String, GitError> {
    match code.chars().next() {
        Some('R' | 'C') => {
            if code.len() < 2 || !code[1..].bytes().all(|byte| byte.is_ascii_digit()) {
                return Err(malformed("raw diff"));
            }
            if count(&code[1..])? > 100 {
                return Err(malformed("similarity score"));
            }
            Ok(code[..1].to_owned())
        }
        Some(first @ ('A' | 'M' | 'D' | 'T')) if code.len() == 1 => Ok(first.to_string()),
        Some('Z') => Err(malformed("diff status")),
        _ => Err(malformed("raw diff")),
    }
}

/// Parses the raw records, then the numstat records that must correspond to them.
pub fn parse_diff(bytes: &[u8]) -> Result<Vec<DiffFile>, GitError> {
    let mut records = Records::new(nul(bytes)?);
    let mut files: Vec<DiffFile> = Vec::new();
    let mut by_path: Vec<((String, String), usize)> = Vec::new();
    while records.peek().is_some_and(|record| record.starts_with(':')) {
        let record = records.next()?.to_owned();
        let fields: Vec<&str> = record[1..].split(' ').collect();
        let [old_mode, new_mode, old_sha, new_sha, code] = match fields.as_slice() {
            [old_mode, new_mode, old_sha, new_sha, code] => {
                [*old_mode, *new_mode, *old_sha, *new_sha, *code]
            }
            _ => return Err(malformed("raw diff")),
        };
        if !mode_schema(old_mode) || !mode_schema(new_mode) {
            return Err(malformed("raw diff"));
        }
        hash(old_sha)?;
        hash(new_sha)?;
        let status = diff_status_code(code)?;
        if !status_schema(&status) {
            return Err(malformed("diff status"));
        }
        let first_path = path_schema(records.next()?).ok_or_else(|| malformed("diff path"))?;
        let renamed = status == "R" || status == "C";
        let path = if renamed {
            path_schema(records.next()?).ok_or_else(|| malformed("rename destination"))?
        } else {
            first_path.clone()
        };
        let entry = DiffEntry {
            path,
            old_path: if renamed { Some(first_path) } else { None },
            status,
            additions: 0,
            deletions: 0,
            binary: false,
        };
        let key = (
            entry.old_path.clone().unwrap_or_default(),
            entry.path.clone(),
        );
        if by_path.iter().any(|(known, _)| known == &key) {
            return Err(malformed("duplicate diff path"));
        }
        by_path.push((key, files.len()));
        files.push(DiffFile {
            entry,
            old_sha: old_sha.to_owned(),
            new_sha: new_sha.to_owned(),
            old_mode: old_mode.to_owned(),
            new_mode: new_mode.to_owned(),
        });
    }
    let mut counted: Vec<(String, String)> = Vec::new();
    while !records.done() {
        let record = records.next()?.to_owned();
        let numstat = numstat_record(&record, &mut records)?;
        let key = (numstat.old_path, numstat.path);
        if counted.contains(&key) {
            return Err(malformed("numstat path correspondence"));
        }
        let Some((_, index)) = by_path.iter().find(|(known, _)| known == &key) else {
            return Err(malformed("numstat path correspondence"));
        };
        counted.push(key);
        let file = &mut files[*index];
        file.entry.binary = numstat.binary;
        file.entry.additions = numstat.additions;
        file.entry.deletions = numstat.deletions;
    }
    if counted.len() != files.len() {
        return Err(malformed("missing numstat records"));
    }
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::error::GitErrorCode;

    const SHA: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn rejects(output: &[u8]) {
        let error = parse_diff(output).expect_err("malformed");
        assert_eq!(error.code, GitErrorCode::MalformedOutput);
    }

    // Every case of `malformed-output.test.ts`'s "diff" table.
    #[test]
    fn malformed_diff_records_are_refused_with_a_typed_error() {
        enum Suffix<'a> {
            Alone,
            AfterRaw,
            AfterRawNumstat(&'a str),
        }
        let raw = format!(":100644 100644 {SHA} {SHA} M\0file\0");
        for (record, suffix) in [
            (format!(":100644 100644 {SHA} M\0file\0"), Suffix::Alone),
            (
                format!(":100644 100644 {SHA} {SHA} Z\0file\0"),
                Suffix::Alone,
            ),
            (format!(":100644 100644 abc {SHA} M\0file\0"), Suffix::Alone),
            (
                format!(":100644 100644 {SHA} {SHA} R100\0file\0"),
                Suffix::Alone,
            ),
            ("-1\t0\tfile\0".to_owned(), Suffix::AfterRaw),
            ("NaN\t0\tfile\0".to_owned(), Suffix::AfterRaw),
            ("1\tInfinity\tfile\0".to_owned(), Suffix::AfterRaw),
            ("9007199254740992\t0\tfile\0".to_owned(), Suffix::AfterRaw),
            ("-\t1\tfile\0".to_owned(), Suffix::AfterRaw),
            ("1\t0\tfile\textra\0".to_owned(), Suffix::AfterRaw),
            (String::new(), Suffix::AfterRaw),
            ("1\t0\tother\0".to_owned(), Suffix::AfterRaw),
            (
                format!(":100644 100644 {SHA} {SHA} M50\0file\0"),
                Suffix::AfterRawNumstat("1\t0\tfile\0"),
            ),
            (
                format!(":100644 100644 {SHA} {SHA} Ax\0file\0"),
                Suffix::AfterRawNumstat("1\t0\tfile\0"),
            ),
            (
                format!(":100644 100644 {SHA} {SHA} R\0old\0new\0"),
                Suffix::Alone,
            ),
        ] {
            let mut output = Vec::new();
            match suffix {
                Suffix::Alone => output.extend_from_slice(record.as_bytes()),
                Suffix::AfterRaw => {
                    output.extend_from_slice(raw.as_bytes());
                    output.extend_from_slice(record.as_bytes());
                }
                Suffix::AfterRawNumstat(numstat) => {
                    output.extend_from_slice(raw.as_bytes());
                    output.extend_from_slice(record.as_bytes());
                    output.extend_from_slice(numstat.as_bytes());
                }
            }
            let error = parse_diff(&output).expect_err("malformed");
            assert_eq!(error.code, GitErrorCode::MalformedOutput, "{record}");
            if record.contains("M50") || record.contains(" Ax") {
                assert_eq!(error.message, "Malformed Git raw diff");
            }
        }
    }

    #[test]
    fn a_raw_and_numstat_pair_reads_status_hashes_counts_and_a_rename_source() {
        let raw = format!(
            ":100644 100644 {SHA} {SHA} M\0with\ttab.txt\0\
             :100644 100644 {SHA} {SHA} R087\0old\0new\0\
             :000000 100644 {} {SHA} A\0added.txt\0",
            "0".repeat(40)
        );
        let numstat = concat!(
            "1\t0\twith\ttab.txt\0",
            "2\t1\t\0old\0new\0",
            "1\t0\tadded.txt\0"
        );
        let files = parse_diff(format!("{raw}{numstat}").as_bytes()).expect("diff");
        assert_eq!(files.len(), 3);
        assert_eq!(files[0].entry.path, "with\ttab.txt");
        assert_eq!(files[0].entry.additions, 1);
        assert_eq!(files[1].entry.old_path.as_deref(), Some("old"));
        assert_eq!(files[1].entry.path, "new");
        assert_eq!(files[1].entry.additions, 2);
        assert_eq!(files[1].entry.deletions, 1);
        assert_eq!(files[2].entry.status, "A");
        assert_eq!(files[2].old_mode, "000000");
        assert_eq!(files[2].entry.path, "added.txt");
    }

    #[test]
    fn a_similarity_above_100_and_a_missing_numstat_are_refused() {
        rejects(format!(":100644 100644 {SHA} {SHA} R101\0old\0new\0").as_bytes());
        rejects(format!(":100644 100644 {SHA} {SHA} M\0file\0").as_bytes());
        rejects(
            format!(":100644 100644 {SHA} {SHA} M\0file\0:100644 100644 {SHA} {SHA} M\0file\0")
                .as_bytes(),
        );
    }
}
