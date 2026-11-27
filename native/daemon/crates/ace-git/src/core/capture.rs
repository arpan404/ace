// SPDX-License-Identifier: Apache-2.0
//! Turning captured Git bytes into the strings `cli.ts` returns: strict text,
//! streaming patches with an incomplete UTF-8 tail dropped, the 4 KiB output
//! tail diagnostics read, and concatenation (G2a).

use crate::core::error::{GitError, GitErrorCode};

/// Bytes of stdout tail fed to `diagnostics.accept_output`.
const OUTPUT_TAIL_LIMIT: usize = 4_096;

/// Exact UTF-8 scalar output (`textOutput` in `cli.ts`): strict UTF-8, strip one trailing `\n`.
pub fn text_output(stdout: &[u8]) -> Result<String, GitError> {
    let text = std::str::from_utf8(stdout)
        .map_err(|_| GitError::new(GitErrorCode::MalformedOutput, "Malformed Git UTF-8 scalar"))?;
    Ok(crate::core::paths::strip_terminator(text, false).to_owned())
}

/// Streaming patch output (`patchOutput` in `cli.ts`): omits incomplete trailing UTF-8 sequence when truncated.
pub fn patch_output(stdout: &[u8], truncated: bool) -> String {
    if !truncated {
        return String::from_utf8_lossy(stdout).into_owned();
    }
    let mut out = String::new();
    let mut slice = stdout;
    loop {
        match std::str::from_utf8(slice) {
            Ok(valid) => {
                out.push_str(valid);
                break;
            }
            Err(err) => {
                let up_to = err.valid_up_to();
                if up_to > 0
                    && let Ok(valid) = std::str::from_utf8(&slice[..up_to])
                {
                    out.push_str(valid);
                }
                slice = &slice[up_to..];
                if let Some(len) = err.error_len() {
                    out.push('\u{FFFD}');
                    slice = &slice[len..];
                } else {
                    // Truncated mid-codepoint: omit incomplete trailing bytes, matching StringDecoder.write.
                    break;
                }
            }
        }
    }
    out
}

pub(crate) fn concat_chunks(chunks: Vec<Vec<u8>>) -> Vec<u8> {
    let total: usize = chunks.iter().map(Vec::len).sum();
    let mut out = Vec::with_capacity(total);
    for chunk in chunks {
        out.extend_from_slice(&chunk);
    }
    out
}

pub(crate) fn output_tail(chunks: &[Vec<u8>]) -> String {
    let mut parts: Vec<&[u8]> = Vec::new();
    let mut bytes = 0usize;
    for chunk in chunks.iter().rev() {
        if bytes >= OUTPUT_TAIL_LIMIT {
            break;
        }
        let need = OUTPUT_TAIL_LIMIT - bytes;
        let slice = &chunk[chunk.len().saturating_sub(need)..];
        parts.push(slice);
        bytes += slice.len();
    }
    parts.reverse();
    let mut buf = Vec::with_capacity(bytes);
    for part in parts {
        buf.extend_from_slice(part);
    }
    String::from_utf8_lossy(&buf).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_output_rejects_invalid_utf8_and_strips_single_newline() {
        assert_eq!(text_output(b"abc\n").ok().as_deref(), Some("abc"));
        assert_eq!(text_output(b"abc\n\n").ok().as_deref(), Some("abc\n"));
        assert!(matches!(
            text_output(&[0xff, 0xfe]),
            Err(GitError {
                code: GitErrorCode::MalformedOutput,
                ..
            })
        ));
    }

    #[test]
    fn patch_output_drops_incomplete_utf8_only_when_truncated() {
        let bytes = [b'a', 0xe2, 0x82];
        assert_eq!(patch_output(&bytes, true), "a");
        assert_eq!(patch_output(&bytes, false), "a\u{FFFD}");
    }
}
