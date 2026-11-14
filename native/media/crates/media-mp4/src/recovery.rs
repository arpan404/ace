// SPDX-License-Identifier: Apache-2.0
use crate::Error;

/// Byte length to retain after an interrupted write of this writer's output.
/// Removes an incomplete final moof+mdat pair (and any clean-stop index). Some
/// players reject even earlier samples if a partial mdat remains attached.
/// The recorder truncates to this length before reopening a recovered part.
/// This scans top-level sizes only; it does not repair arbitrary file corruption.
pub fn recovery_prefix(bytes: &[u8]) -> Result<usize, Error> {
    fn end(bytes: &[u8], at: usize, kind: &[u8; 4]) -> Option<usize> {
        let h = bytes.get(at..at.checked_add(8)?)?;
        if &h[4..8] != kind {
            return None;
        }
        let n = u32::from_be_bytes([h[0], h[1], h[2], h[3]]) as usize;
        if n < 8 {
            return None;
        }
        let end = at.checked_add(n)?;
        (end <= bytes.len()).then_some(end)
    }
    let ftyp = end(bytes, 0, b"ftyp").ok_or(Error::InvalidFile)?;
    let mut committed = end(bytes, ftyp, b"moov").ok_or(Error::InvalidFile)?;
    while let Some(moof) = end(bytes, committed, b"moof") {
        let Some(mdat) = end(bytes, moof, b"mdat") else {
            break;
        };
        committed = mdat;
    }
    Ok(committed)
}
