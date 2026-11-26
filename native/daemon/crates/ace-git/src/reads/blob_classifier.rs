// SPDX-License-Identifier: Apache-2.0
//! The `cat-file --batch` binary classifier (`packages/git/src/blob-classifier.ts`, G3b):
//! a small header and one binary bit per blob, while arbitrarily large blobs drain.
//!
//! Proof: `malformed-output.test.ts`'s "blob stream" cases moved here, and the binary entries
//! `diff-resources.process`, `review-regressions.process` and `diff.process` assert.

use crate::core::decode::{count, hash, malformed};
use crate::core::error::GitError;

/// Retains only a small header and a binary bit while draining `cat-file --batch`.
#[derive(Debug)]
pub struct BlobClassifier {
    binary: Vec<String>,
    expected: Vec<String>,
    index: usize,
    header: Vec<u8>,
    remaining: Option<u64>,
    sha: Option<String>,
    has_nul: bool,
    separator: bool,
}

impl BlobClassifier {
    pub fn new(expected: Vec<String>) -> Self {
        Self {
            binary: Vec::new(),
            expected,
            index: 0,
            header: Vec::new(),
            remaining: None,
            sha: None,
            has_nul: false,
            separator: false,
        }
    }

    /// The blobs found to hold a NUL byte.
    pub fn binary(&self) -> &[String] {
        &self.binary
    }

    pub fn feed(&mut self, chunk: &[u8]) -> Result<(), GitError> {
        let mut offset = 0usize;
        while offset < chunk.len() {
            if self.separator {
                if chunk[offset] != 10 {
                    return Err(malformed("blob separator"));
                }
                offset += 1;
                let Some(sha) = self.sha.take() else {
                    return Err(malformed("blob separator"));
                };
                if self.has_nul {
                    self.binary.push(sha);
                }
                self.index += 1;
                self.has_nul = false;
                self.separator = false;
                continue;
            }
            if let Some(remaining) = self.remaining {
                let size = usize::try_from(remaining)
                    .unwrap_or(usize::MAX)
                    .min(chunk.len() - offset);
                if chunk[offset..offset + size].contains(&0) {
                    self.has_nul = true;
                }
                offset += size;
                self.remaining = Some(remaining - size as u64);
                if self.remaining == Some(0) {
                    self.remaining = None;
                    self.separator = true;
                }
                continue;
            }
            let newline = chunk[offset..]
                .iter()
                .position(|byte| *byte == 10)
                .map(|index| index + offset);
            let end = newline.unwrap_or(chunk.len());
            self.header.extend_from_slice(&chunk[offset..end]);
            if self.header.len() > 160 {
                return Err(malformed("blob header size"));
            }
            let Some(newline) = newline else {
                return Ok(());
            };
            offset = newline + 1;
            let header = String::from_utf8_lossy(&self.header).into_owned();
            let fields: Vec<&str> = header.split(' ').collect();
            let [sha, kind, bytes] = match fields.as_slice() {
                [sha, kind, bytes] => [*sha, *kind, *bytes],
                _ => return Err(malformed("blob header")),
            };
            if kind != "blob" {
                return Err(malformed("blob header"));
            }
            hash(sha)?;
            let expected = self
                .expected
                .get(self.index)
                .ok_or_else(|| malformed("blob correspondence"))?;
            if sha != expected {
                return Err(malformed("blob correspondence"));
            }
            if !bytes.bytes().all(|byte| byte.is_ascii_digit()) || bytes.is_empty() {
                return Err(malformed("blob header"));
            }
            self.sha = Some(sha.to_owned());
            self.remaining = Some(count(bytes)?);
            self.header.clear();
            if self.remaining == Some(0) {
                self.remaining = None;
                self.separator = true;
            }
        }
        Ok(())
    }

    pub fn finish(self) -> Result<Vec<String>, GitError> {
        if self.index != self.expected.len()
            || !self.header.is_empty()
            || self.remaining.is_some()
            || self.separator
        {
            return Err(malformed("incomplete blob stream"));
        }
        Ok(self.binary)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::error::GitErrorCode;

    const SHA: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn classifies(expected: &str, output: &str) -> Result<Vec<String>, GitError> {
        let mut classifier = BlobClassifier::new(vec![expected.to_owned()]);
        classifier.feed(output.as_bytes())?;
        classifier.finish()
    }

    // Every case of `malformed-output.test.ts`'s "blob stream" table.
    #[test]
    fn malformed_blob_streams_are_refused_with_a_typed_error() {
        for suffix in [
            "tree 0\n\n",
            "blob -1\n",
            "blob Infinity\n",
            "blob 10\nshort",
            "blob 0\nx",
        ] {
            let output = format!("{SHA} {suffix}");
            let error = classifies(SHA, &output).expect_err(&output);
            assert_eq!(error.code, GitErrorCode::MalformedOutput, "{output:?}");
        }
    }

    #[test]
    fn a_text_blob_and_a_binary_blob_are_told_apart_and_chunks_may_split_anywhere() {
        assert_eq!(
            classifies(SHA, &format!("{SHA} blob 5\nhello\n")).expect("text"),
            Vec::<String>::new()
        );
        assert_eq!(
            classifies(SHA, &format!("{SHA} blob 3\na\u{0}b\n")).expect("binary"),
            vec![SHA.to_owned()]
        );
        // The same stream, fed one byte at a time, reaches the same answer.
        let mut classifier = BlobClassifier::new(vec![SHA.to_owned()]);
        for byte in format!("{SHA} blob 3\na\u{0}b\n").bytes() {
            classifier.feed(&[byte]).expect("byte");
        }
        assert_eq!(classifier.finish().expect("binary"), vec![SHA.to_owned()]);
        // A blob larger than one chunk is drained, not buffered.
        let large = format!("{SHA} blob 8192\n{}\n", "x".repeat(8192));
        assert_eq!(
            classifies(SHA, &large).expect("large"),
            Vec::<String>::new()
        );
    }

    #[test]
    fn a_blob_out_of_order_or_a_stream_missing_its_separator_is_refused() {
        let other = "b".repeat(40);
        let error = classifies(SHA, &format!("{other} blob 0\n\n")).expect_err("order");
        assert_eq!(error.code, GitErrorCode::MalformedOutput);
        let error = classifies(SHA, &format!("{SHA} blob 0\n")).expect_err("separator");
        assert_eq!(error.code, GitErrorCode::MalformedOutput);
    }
}
