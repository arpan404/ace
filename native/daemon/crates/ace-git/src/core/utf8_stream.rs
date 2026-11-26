// SPDX-License-Identifier: Apache-2.0
//! Incremental UTF-8 decoding matching Node's `StringDecoder("utf8")`.

/// Carries incomplete UTF-8 sequences across streamed chunks.
#[derive(Default)]
pub(crate) struct Utf8StreamDecoder {
    pending: [u8; 4],
    pending_len: usize,
}

impl Utf8StreamDecoder {
    pub(crate) fn write(&mut self, input: &[u8]) -> String {
        let mut out = String::new();
        let mut slice = input;
        if self.pending_len > 0 {
            let mut combined = [0u8; 8];
            combined[..self.pending_len].copy_from_slice(&self.pending[..self.pending_len]);
            let take = slice.len().min(4);
            combined[self.pending_len..self.pending_len + take].copy_from_slice(&slice[..take]);
            let total = self.pending_len + take;
            match std::str::from_utf8(&combined[..total]) {
                Ok(valid) => {
                    out.push_str(valid);
                    self.pending_len = 0;
                    slice = &slice[take..];
                }
                Err(err) => {
                    let valid_up_to = err.valid_up_to();
                    if valid_up_to > 0 {
                        if let Ok(valid) = std::str::from_utf8(&combined[..valid_up_to]) {
                            out.push_str(valid);
                        }
                        if valid_up_to >= self.pending_len {
                            let consumed_from_input = valid_up_to - self.pending_len;
                            self.pending_len = 0;
                            slice = &slice[consumed_from_input..];
                        } else {
                            let remain = self.pending_len - valid_up_to;
                            self.pending.copy_within(valid_up_to..self.pending_len, 0);
                            self.pending_len = remain;
                        }
                    }
                    if let Some(error_len) = err.error_len() {
                        out.push('\u{FFFD}');
                        let skip = valid_up_to + error_len;
                        if skip >= self.pending_len {
                            let consumed_from_input = skip - self.pending_len;
                            self.pending_len = 0;
                            slice = &slice[consumed_from_input.min(slice.len())..];
                        } else {
                            let remain = self.pending_len - skip;
                            self.pending.copy_within(skip..self.pending_len, 0);
                            self.pending_len = remain;
                        }
                    } else if valid_up_to == 0 {
                        self.pending[..total].copy_from_slice(&combined[..total]);
                        self.pending_len = total;
                        return out;
                    }
                }
            }
        }
        loop {
            match std::str::from_utf8(slice) {
                Ok(valid) => {
                    out.push_str(valid);
                    break;
                }
                Err(err) => {
                    let valid_up_to = err.valid_up_to();
                    if valid_up_to > 0
                        && let Ok(valid) = std::str::from_utf8(&slice[..valid_up_to])
                    {
                        out.push_str(valid);
                    }
                    slice = &slice[valid_up_to..];
                    if let Some(error_len) = err.error_len() {
                        out.push('\u{FFFD}');
                        slice = &slice[error_len..];
                    } else {
                        let len = slice.len().min(4);
                        self.pending[..len].copy_from_slice(&slice[..len]);
                        self.pending_len = len;
                        break;
                    }
                }
            }
        }
        out
    }

    pub(crate) fn end(&mut self) -> String {
        if self.pending_len == 0 {
            return String::new();
        }
        let s = String::from_utf8_lossy(&self.pending[..self.pending_len]).into_owned();
        self.pending_len = 0;
        s
    }
}
