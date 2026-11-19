//! Inflation that counts: every byte a ZIP entry or PDF stream expands to is counted against one
//! part's cap, a ratio to its compressed size, and the file's total, and reading stops the moment
//! one is passed. A header that lies about sizes gains nothing: what is counted is what came out.

use std::io::Read;

use crate::{DocError, Limits};

/// Below this, a part may grow by any ratio: small XML parts compress very well.
const RATIO_FLOOR: usize = 1024 * 1024;

/// What one file has inflated so far.
#[derive(Debug)]
pub struct Budget {
    limits: Limits,
    used: usize,
}

impl Budget {
    pub fn new(limits: &Limits) -> Self {
        Self {
            limits: *limits,
            used: 0,
        }
    }

    /// Reads `reader` to its end, refusing past the caps for a part whose compressed size is
    /// `compressed`.
    pub fn read_all(
        &mut self,
        reader: &mut dyn Read,
        compressed: usize,
    ) -> Result<Vec<u8>, DocError> {
        let mut out = Vec::new();
        let mut chunk = vec![0u8; 64 * 1024];
        loop {
            let n = match reader.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => n,
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(DocError::Damaged(short(&error.to_string()))),
            };
            self.count(out.len() + n, compressed, n)?;
            out.extend_from_slice(&chunk[..n]);
        }
        Ok(out)
    }

    /// Like [`Budget::read_all`], but a read error ends the part instead of failing it: what
    /// came out before is kept. For trial decoding, where an error only means "not this filter".
    pub fn read_lenient(
        &mut self,
        reader: &mut dyn Read,
        compressed: usize,
    ) -> Result<Vec<u8>, DocError> {
        let mut out = Vec::new();
        let mut chunk = vec![0u8; 64 * 1024];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    self.count(out.len() + n, compressed, n)?;
                    out.extend_from_slice(&chunk[..n]);
                }
            }
        }
        Ok(out)
    }

    /// Counts `added` more bytes for a part now `part` long, from `compressed` bytes.
    pub fn count(&mut self, part: usize, compressed: usize, added: usize) -> Result<(), DocError> {
        self.used = self.used.saturating_add(added);
        let ratio_passed =
            part > RATIO_FLOOR && part / compressed.max(1) > self.limits.ratio.max(1);
        if part > self.limits.inflated_part
            || self.used > self.limits.inflated_total
            || ratio_passed
        {
            return Err(DocError::Expands);
        }
        Ok(())
    }
}

/// An error's words, kept short and on one line.
pub fn short(text: &str) -> String {
    let line = text.lines().next().unwrap_or_default();
    line.chars().take(120).collect()
}
