//! One `git diff --numstat -z` record (`packages/git/src/parse-numstat.ts`, G3a).
//!
//! Proof: the counts and paths `changed-files-regressions.process` and `diff-resources.process`
//! assert; `malformed-output.test.ts`'s diff cases land with G3b's `parseDiff`.

use crate::core::decode::{Records, count, malformed, path_schema};
use crate::core::error::GitError;

/// One file's line counts against HEAD.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NumstatRecord {
    pub path: String,
    /// A rename's old path, empty for everything else.
    pub old_path: String,
    pub additions: u64,
    pub deletions: u64,
    pub binary: bool,
}

/// A NUL-framed numstat record uses only its first two tabs as delimiters.
pub fn numstat_record(record: &str, records: &mut Records) -> Result<NumstatRecord, GitError> {
    let first = record
        .find('\t')
        .ok_or_else(|| malformed("numstat arity"))?;
    let second = record[first + 1..]
        .find('\t')
        .map(|index| index + first + 1)
        .ok_or_else(|| malformed("numstat arity"))?;
    let added = &record[..first];
    let removed = &record[first + 1..second];
    let mut path = record[second + 1..].to_owned();
    let mut old_path = String::new();
    if path.is_empty() {
        old_path = records
            .next()
            .map_err(|_| malformed("numstat source"))?
            .to_owned();
        path = records
            .next()
            .map_err(|_| malformed("numstat path"))?
            .to_owned();
    }
    let path = path_schema(&path).ok_or_else(|| malformed("numstat path"))?;
    let old_path = if old_path.is_empty() {
        String::new()
    } else {
        path_schema(&old_path).ok_or_else(|| malformed("numstat source"))?
    };
    let binary = added == "-" && removed == "-";
    Ok(NumstatRecord {
        path,
        old_path,
        additions: if binary { 0 } else { count(added)? },
        deletions: if binary { 0 } else { count(removed)? },
        binary,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::decode::nul;
    use crate::core::error::GitErrorCode;

    fn parse(output: &str) -> Result<NumstatRecord, GitError> {
        let mut records = Records::new(nul(output.as_bytes())?);
        let record = records.next()?.to_owned();
        numstat_record(&record, &mut records)
    }

    #[test]
    fn a_record_reads_its_counts_and_path_and_a_rename_reads_both_paths() {
        assert_eq!(
            parse("12\t3\tsrc/main.ts\0").expect("record"),
            NumstatRecord {
                path: "src/main.ts".to_owned(),
                old_path: String::new(),
                additions: 12,
                deletions: 3,
                binary: false,
            }
        );
        let mut records = Records::new(vec![
            "4\t2\t".to_owned(),
            "old name".to_owned(),
            "new name".to_owned(),
        ]);
        let record = records.next().expect("record").to_owned();
        assert_eq!(
            numstat_record(&record, &mut records).expect("rename"),
            NumstatRecord {
                path: "new name".to_owned(),
                old_path: "old name".to_owned(),
                additions: 4,
                deletions: 2,
                binary: false,
            }
        );
    }

    #[test]
    fn a_binary_record_has_no_counts_and_a_half_binary_record_is_malformed() {
        assert!(parse("-\t-\timage.png\0").expect("binary").binary);
        for output in ["-\t1\tfile\0", "-1\t0\tfile\0"] {
            let error = parse(output).expect_err(output);
            assert_eq!(error.code, GitErrorCode::MalformedOutput, "{output}");
        }
        assert!(parse("1\t0\t../file\0").is_err());
    }

    #[test]
    fn counts_keep_their_safe_integer_bound() {
        for output in [
            "9007199254740992\t0\tfile\0",
            "1\tInfinity\tfile\0",
            "NaN\t0\tfile\0",
        ] {
            let error = parse(output).expect_err(output);
            assert_eq!(error.code, GitErrorCode::MalformedOutput, "{output}");
        }
        assert_eq!(
            parse("9007199254740991\t0\tfile\0").expect("max").additions,
            9_007_199_254_740_991
        );
    }
}
