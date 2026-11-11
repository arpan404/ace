//! Line boundaries in byte buffers.
//!
//! This is the first function behind ace's Rust add-on (ADR 0125), kept deliberately small so
//! the build, release and perf-gate path is proven before whole packages move. Provider
//! transcripts are JSONL, so readers that split a chunk into records can use it.

#![forbid(unsafe_code)]

use core::fmt;

/// A buffer is too long to address its lines with 32-bit offsets.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TooLong {
    /// The buffer's length in bytes.
    pub len: usize,
}

impl fmt::Display for TooLong {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "buffer of {} bytes exceeds the 4 GiB line-offset limit",
            self.len
        )
    }
}

impl core::error::Error for TooLong {}

/// The offset just past each `\n` in `bytes`, in order.
///
/// A final line without a newline has no entry, so a caller streaming chunks keeps the tail
/// after the last offset for the next chunk. Offsets are `u32` to halve the memory a large
/// chunk's index costs; buffers of 4 GiB or more are refused rather than truncated.
///
/// # Errors
///
/// [`TooLong`] when `bytes` is 4 GiB or longer.
pub fn line_ends(bytes: &[u8]) -> Result<Vec<u32>, TooLong> {
    let too_long = TooLong { len: bytes.len() };
    if u32::try_from(bytes.len()).is_err() {
        return Err(too_long);
    }
    // One pass to size the vector exactly, one to fill it: both are SIMD scans, and an exact
    // capacity avoids regrowing a large index.
    let mut ends = Vec::with_capacity(memchr::memchr_iter(b'\n', bytes).count());
    for index in memchr::memchr_iter(b'\n', bytes) {
        let end = index.checked_add(1).ok_or(too_long)?;
        ends.push(u32::try_from(end).map_err(|_| too_long)?);
    }
    Ok(ends)
}

#[cfg(test)]
mod tests {
    use super::line_ends;

    #[test]
    fn every_newline_ends_a_line() {
        assert_eq!(line_ends(b"a\nbc\n\nd").unwrap(), vec![2, 5, 6]);
    }

    #[test]
    fn a_buffer_without_newlines_has_no_complete_line() {
        assert_eq!(line_ends(b"partial record").unwrap(), Vec::<u32>::new());
        assert_eq!(line_ends(b"").unwrap(), Vec::<u32>::new());
    }

    #[test]
    fn carriage_returns_stay_inside_the_line() {
        assert_eq!(line_ends(b"a\r\nb\r\n").unwrap(), vec![3, 6]);
    }
}
