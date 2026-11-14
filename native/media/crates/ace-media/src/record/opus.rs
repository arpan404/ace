// SPDX-License-Identifier: Apache-2.0
//! What an Opus packet says about itself (RFC 6716 §3.1). Pure.

/// The packet's duration in 48 kHz samples, from its TOC byte and frame count; `None` for a
/// malformed packet. Recorded audio is timed by these, so a track never drifts from its
/// samples however its packets arrive.
pub fn samples(packet: &[u8]) -> Option<u32> {
    let toc = *packet.first()?;
    let config = toc >> 3;
    // Frame sizes in 48 kHz samples: SILK 10/20/40/60 ms, hybrid 10/20 ms, CELT 2.5/5/10/20 ms.
    let frame = match config {
        0..=11 => [480, 960, 1920, 2880][usize::from(config % 4)],
        12..=15 => [480, 960][usize::from(config % 2)],
        _ => [120, 240, 480, 960][usize::from(config % 4)],
    };
    let frames = match toc & 3 {
        0 => 1,
        1 | 2 => 2,
        _ => u32::from(*packet.get(1)? & 0x3f),
    };
    let total = frame * frames;
    // A packet holds at most 120 ms (§3.2.5).
    (frames > 0 && total <= 5_760).then_some(total)
}

/// The track configuration an Opus frame's description gives: `u32` input sample rate and
/// `u8` channel count (docs/media/plan.md, "Ingest framing").
pub fn config(description: &[u8]) -> Option<(u32, u8)> {
    let rate = u32::from_be_bytes(description.get(0..4)?.try_into().ok()?);
    let channels = *description.get(4)?;
    (rate > 0 && (1..=2).contains(&channels)).then_some((rate, channels))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn durations_follow_the_toc_byte_and_frame_count() {
        // CELT 20 ms, one frame: config 31, code 0.
        assert_eq!(samples(&[31 << 3, 0]), Some(960));
        // SILK 60 ms, two frames.
        assert_eq!(samples(&[(3 << 3) | 1]), Some(5_760));
        // CELT 2.5 ms, code 3 with four frames.
        assert_eq!(samples(&[(16 << 3) | 3, 4]), Some(480));
        // Code 3 claiming more than 120 ms, or no frames, is malformed.
        assert_eq!(samples(&[(31 << 3) | 3, 7]), None);
        assert_eq!(samples(&[(31 << 3) | 3, 0]), None);
        assert_eq!(samples(&[]), None);
    }

    #[test]
    fn the_description_gives_rate_and_channels() {
        assert_eq!(config(&[0, 0, 0xbb, 0x80, 2]), Some((48_000, 2)));
        assert_eq!(config(&[0, 0, 0xbb, 0x80, 3]), None);
        assert_eq!(config(&[0, 0, 0xbb]), None);
    }
}
