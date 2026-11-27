// SPDX-License-Identifier: Apache-2.0
//! Incremental UTF-8 decoding matching Node's `StringDecoder("utf8")`: a sequence split across
//! two chunks is decoded once, and bytes that are not UTF-8 become U+FFFD instead of failing.

/// Carries incomplete UTF-8 sequences across streamed chunks.
#[derive(Default)]
pub(crate) struct Utf8StreamDecoder {
    pending: Vec<u8>,
}

impl Utf8StreamDecoder {
    /// The text this chunk completes; a trailing incomplete sequence waits for the next chunk.
    pub(crate) fn write(&mut self, input: &[u8]) -> String {
        self.pending.extend_from_slice(input);
        let mut out = String::new();
        let mut offset = 0usize;
        loop {
            match std::str::from_utf8(&self.pending[offset..]) {
                Ok(valid) => {
                    out.push_str(valid);
                    offset = self.pending.len();
                    break;
                }
                Err(error) => {
                    let valid_up_to = error.valid_up_to();
                    if valid_up_to > 0
                        && let Ok(valid) =
                            std::str::from_utf8(&self.pending[offset..offset + valid_up_to])
                    {
                        out.push_str(valid);
                    }
                    offset += valid_up_to;
                    match error.error_len() {
                        // Invalid bytes: one replacement, then past the sequence.
                        Some(invalid) => {
                            out.push('\u{FFFD}');
                            offset += invalid;
                        }
                        // An incomplete sequence: it belongs to the next chunk.
                        None => break,
                    }
                }
            }
        }
        self.pending.drain(..offset);
        out
    }

    /// The end of the stream: whatever was still pending is one incomplete sequence.
    pub(crate) fn end(&mut self) -> String {
        let text = String::from_utf8_lossy(&self.pending).into_owned();
        self.pending.clear();
        text
    }
}
