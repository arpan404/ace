// SPDX-License-Identifier: Apache-2.0
use crate::{Error, Group, Sample, boxes::Boxes};
pub(crate) fn validate(
    samples: &[Sample<'_>],
    end: u64,
    previous: Option<u64>,
) -> Result<usize, Error> {
    if samples
        .first()
        .is_some_and(|s| previous.is_some_and(|p| s.timestamp < p))
    {
        return Err(Error::InvalidTimestamp);
    }
    let mut size = 0_usize;
    for (i, s) in samples.iter().enumerate() {
        let next = samples.get(i + 1).map_or(end, |s| s.timestamp);
        let duration = next
            .checked_sub(s.timestamp)
            .ok_or(Error::InvalidTimestamp)?;
        if duration == 0 || duration > u64::from(u32::MAX) {
            return Err(Error::InvalidTimestamp);
        }
        if s.data.is_empty() || s.data.len() > u32::MAX as usize {
            return Err(Error::TooLarge);
        }
        size = size.checked_add(s.data.len()).ok_or(Error::TooLarge)?;
    }
    Ok(size)
}
pub(crate) fn size(g: &Group<'_>) -> Result<usize, Error> {
    // moof/mfhd + traf(tfhd/tfdt/trun) per track + mdat header.
    let mut n = 24_u64 + 8;
    for (track, samples) in [g.video, g.audio].into_iter().enumerate() {
        if !samples.is_empty() {
            n += 64 + samples.len() as u64 * 12;
            if track == 1 {
                n += 28;
            }
            for s in samples {
                n = n.checked_add(s.data.len() as u64).ok_or(Error::TooLarge)?;
            }
        }
    }
    if n > i32::MAX as u64 {
        return Err(Error::TooLarge);
    }
    Ok(n as usize)
}
pub(crate) fn write(
    g: &Group<'_>,
    sequence: u32,
    size: usize,
    vsize: usize,
    asize: usize,
) -> Vec<u8> {
    let mut b = Boxes::new(size);
    let mut patches = [0, 0];
    b.boxed(b"moof", |b| {
        b.full(b"mfhd", 0, 0, |b| b.u32(sequence));
        patches[0] = track(b, 1, g.video, g.video_end);
        if !g.audio.is_empty() {
            patches[1] = track(b, 2, g.audio, g.audio_end);
        }
    });
    let data = b.0.len() + 8;
    b.patch(patches[0], data as u32);
    if patches[1] != 0 {
        b.patch(patches[1], (data + vsize) as u32);
    }
    b.boxed(b"mdat", |b| {
        for samples in [g.video, g.audio] {
            for s in samples {
                b.bytes(s.data);
            }
        }
    });
    debug_assert_eq!(b.0.len(), size);
    debug_assert_eq!(b.0.len() - data, vsize + asize);
    b.0
}
fn track(b: &mut Boxes, id: u32, samples: &[Sample<'_>], end: u64) -> usize {
    let mut patch = 0;
    b.boxed(b"traf", |b| {
        b.full(b"tfhd", 0, 0x020000, |b| b.u32(id));
        b.full(b"tfdt", 1, 0, |b| b.u64(samples[0].timestamp));
        b.full(b"trun", 0, 0x701, |b| {
            b.u32(samples.len() as u32);
            patch = b.0.len();
            b.u32(0);
            for (i, s) in samples.iter().enumerate() {
                let next = samples.get(i + 1).map_or(end, |s| s.timestamp);
                b.u32((next - s.timestamp) as u32);
                b.u32(s.data.len() as u32);
                b.u32(if id == 2 || s.keyframe {
                    0x02000000
                } else {
                    0x01010000
                });
            }
        });
        if id == 2 {
            b.full(b"sbgp", 0, 0, |b| {
                b.bytes(b"roll");
                b.u32(1);
                b.u32(samples.len() as u32);
                b.u32(1);
            });
        }
    });
    patch
}
