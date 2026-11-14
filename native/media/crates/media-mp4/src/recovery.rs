// SPDX-License-Identifier: Apache-2.0
use crate::Error;

/// Byte length to retain after an interrupted write of this writer's output.
/// Removes an incomplete final moof+mdat pair (and any clean-stop index). Some
/// players reject even earlier samples if a partial mdat remains attached.
/// The recorder truncates to this length before reopening a recovered part.
/// This scans top-level sizes only; it does not repair arbitrary file corruption.
pub fn recovery_prefix(bytes: &[u8]) -> Result<usize, Error> {
    let header = |at: u64| {
        let at = usize::try_from(at).ok()?;
        bytes.get(at..at.checked_add(8)?)?.try_into().ok()
    };
    let prefix = recovery_prefix_by(bytes.len() as u64, header)?;
    Ok(prefix.length as usize)
}

/// What [`recovery_prefix_by`] found.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Prefix {
    /// Bytes to keep.
    pub length: u64,
    /// Complete moof+mdat pairs inside them.
    pub fragments: u32,
    /// Where the last complete fragment's moof starts, and its size.
    pub last_moof: Option<(u64, u32)>,
    /// The file ends with this writer's clean-stop index right after its last fragment.
    pub finished: bool,
}

/// [`recovery_prefix`] for a file of `length` bytes read through `header`, which returns the
/// 8 bytes at an offset (or `None` past the end). Only box headers are read, so recovering a
/// large part costs a few reads per fragment.
pub fn recovery_prefix_by(
    length: u64,
    mut header: impl FnMut(u64) -> Option<[u8; 8]>,
) -> Result<Prefix, Error> {
    let mut end = |at: u64, kind: &[u8; 4]| -> Option<u64> {
        let h = header(at)?;
        if &h[4..8] != kind {
            return None;
        }
        let n = u64::from(u32::from_be_bytes([h[0], h[1], h[2], h[3]]));
        if n < 8 {
            return None;
        }
        let end = at.checked_add(n)?;
        (end <= length).then_some(end)
    };
    let ftyp = end(0, b"ftyp").ok_or(Error::InvalidFile)?;
    let mut prefix = Prefix {
        length: end(ftyp, b"moov").ok_or(Error::InvalidFile)?,
        fragments: 0,
        last_moof: None,
        finished: false,
    };
    while let Some(moof) = end(prefix.length, b"moof") {
        let Some(mdat) = end(moof, b"mdat") else {
            break;
        };
        prefix.last_moof = Some((prefix.length, (moof - prefix.length) as u32));
        prefix.fragments += 1;
        prefix.length = mdat;
    }
    prefix.finished = end(prefix.length, b"mfra") == Some(length);
    Ok(prefix)
}

/// The decode time where `track` ends in a moof this writer wrote: its `tfdt` plus the
/// durations in its `trun`, in the track's timescale.
pub fn fragment_end(moof: &[u8], track: u32) -> Option<u64> {
    fn boxes(b: &[u8]) -> Vec<([u8; 4], &[u8])> {
        let mut out = Vec::new();
        let mut at = 0usize;
        while let Some(h) = b.get(at..at + 8) {
            let n = u32::from_be_bytes([h[0], h[1], h[2], h[3]]) as usize;
            if n < 8 {
                break;
            }
            let Some(body) = b.get(at + 8..at + n) else {
                break;
            };
            let kind: [u8; 4] = [h[4], h[5], h[6], h[7]];
            out.push((kind, body));
            at += n;
        }
        out
    }
    let u32at = |b: &[u8], at: usize| Some(u32::from_be_bytes(b.get(at..at + 4)?.try_into().ok()?));
    let (_, body) = boxes(moof).into_iter().find(|(k, _)| k == b"moof")?;
    for (kind, traf) in boxes(body) {
        if &kind != b"traf" {
            continue;
        }
        let children = boxes(traf);
        let find = |k: &[u8; 4]| children.iter().find(|(c, _)| c == k).map(|(_, b)| *b);
        if u32at(find(b"tfhd")?, 4)? != track {
            continue;
        }
        let tfdt = find(b"tfdt")?;
        let base = u64::from_be_bytes(tfdt.get(4..12)?.try_into().ok()?);
        let trun = find(b"trun")?;
        // Flags 0x701: data offset, then per sample duration, size and flags.
        if u32at(trun, 0)? & 0xffffff != 0x701 {
            return None;
        }
        let count = u32at(trun, 4)? as usize;
        let mut total = 0u64;
        for i in 0..count {
            total += u64::from(u32at(trun, 12 + i * 12)?);
        }
        return base.checked_add(total);
    }
    None
}
