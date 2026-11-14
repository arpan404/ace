// SPDX-License-Identifier: Apache-2.0
//! Pure fragmented MP4 output, from ISO/IEC 14496-12/-15 and Opus-in-ISOBMFF.
//! No clocks, files, codec conversion, or background work. All timestamps are decode
//! timestamps in the configured track's ticks; this low-delay profile has no B pictures.
//! Pointer/lease JSONL is owned by the recorder, beside the MP4 in the same time base.
mod boxes;
mod fragment;
mod init;
mod recovery;
use boxes::Boxes;
pub use recovery::recovery_prefix;

/// Maximum complete part size, including its final random-access index.
pub const PART_LIMIT: u64 = 512 * 1024 * 1024;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VideoCodec {
    H264,
    Hevc,
}
#[derive(Clone, Debug)]
pub struct VideoConfig {
    pub codec: VideoCodec,
    pub width: u16,
    pub height: u16,
    pub timescale: u32,
    /// Complete avcC/hvcC payload from the encoder, without a box header.
    pub description: Vec<u8>,
}
/// Mapping family zero (mono or stereo). Packets must be at least 2.5 ms long.
#[derive(Clone, Debug)]
pub struct OpusConfig {
    pub channels: u8,
    pub input_sample_rate: u32,
    pub priming_samples: u32,
    pub output_gain: i16,
}
#[derive(Clone, Copy, Debug)]
pub struct Sample<'a> {
    pub timestamp: u64,
    /// Length-prefixed NAL units for video; one encoded Opus packet for audio.
    pub data: &'a [u8],
    pub keyframe: bool,
}
/// One complete GOP. Ends are exclusive timestamps, not guessed frame rates.
/// The recorder seals a GOP when the next keyframe arrives, or supplies the final
/// presentation endpoint on a cut/stop. Audio uses 48,000 ticks per second.
pub struct Group<'a> {
    pub video: &'a [Sample<'a>],
    pub video_end: u64,
    pub audio: &'a [Sample<'a>],
    pub audio_end: u64,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    InvalidFile,
    InvalidConfig,
    InvalidGroup,
    InvalidTimestamp,
    TooLarge,
    PartFull,
    Finished,
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for Error {}

/// One MP4 part. Write `init_segment()` once, then each returned fragment with
/// one write and flush. A crash during a write leaves all earlier fragments intact.
/// On `PartFull`, start a new muxer and retry this keyframe-first group.
pub struct Muxer {
    init: Vec<u8>,
    audio: bool,
    offset: u64,
    index: Vec<(u64, u64)>,
    video_end: Option<u64>,
    audio_end: Option<u64>,
    sealed: bool,
    finished: bool,
}
impl Muxer {
    pub fn new(video: VideoConfig, audio: Option<OpusConfig>) -> Result<Self, Error> {
        if video.width == 0
            || video.height == 0
            || video.timescale == 0
            || video.description.len() > 1024 * 1024
            || video.description.first() != Some(&1)
            || video.description.len()
                < match video.codec {
                    VideoCodec::H264 => 7,
                    VideoCodec::Hevc => 23,
                }
            || audio
                .as_ref()
                .is_some_and(|a| !(1..=2).contains(&a.channels) || a.input_sample_rate == 0)
        {
            return Err(Error::InvalidConfig);
        }
        let init = init::init(&video, audio.as_ref());
        Ok(Self {
            offset: init.len() as u64,
            init,
            audio: audio.is_some(),
            index: Vec::new(),
            video_end: None,
            audio_end: None,
            sealed: false,
            finished: false,
        })
    }
    pub fn init_segment(&self) -> &[u8] {
        &self.init
    }
    /// Rejects empty GOPs, a delta at a part/gap boundary, and any keyframe inside
    /// a GOP. Split there and call again, so every keyframe begins a fragment.
    /// Validation errors leave the part unchanged. Buffers borrow encoded payloads
    /// until the one contiguous output allocation is built.
    pub fn fragment(&mut self, group: Group<'_>) -> Result<Vec<u8>, Error> {
        if self.finished || self.sealed {
            return Err(Error::Finished);
        }
        if group.audio.last().is_some_and(|s| {
            group
                .audio_end
                .checked_sub(s.timestamp)
                .is_some_and(|d| d < 120)
        }) {
            return Err(Error::InvalidTimestamp);
        }
        self.write_group(group)
    }
    /// Write the last GOP of a part, allowing the final Opus packet's duration
    /// to contain only its positive number of valid PCM samples (Opus §4.3.4).
    /// Earlier audio samples retain the ordinary minimum of 120 ticks. Success
    /// seals the part against further GOPs; call `finish` for its index.
    /// Errors leave it open, including `PartFull` so the GOP can move to a new part.
    pub fn final_fragment(&mut self, group: Group<'_>) -> Result<Vec<u8>, Error> {
        let output = self.write_group(group)?;
        self.sealed = true;
        Ok(output)
    }
    fn write_group(&mut self, group: Group<'_>) -> Result<Vec<u8>, Error> {
        if self.finished || self.sealed {
            return Err(Error::Finished);
        }
        if group.video.first().is_none_or(|s| !s.keyframe)
            || group.video.iter().skip(1).any(|s| s.keyframe)
            || (!self.audio && !group.audio.is_empty())
        {
            return Err(Error::InvalidGroup);
        }
        let vsize = fragment::validate(group.video, group.video_end, self.video_end)?;
        let asize = fragment::validate(group.audio, group.audio_end, self.audio_end)?;
        if group
            .audio
            .windows(2)
            .any(|w| w[1].timestamp - w[0].timestamp < 120)
        {
            return Err(Error::InvalidTimestamp);
        }
        let sequence = u32::try_from(self.index.len() + 1).map_err(|_| Error::TooLarge)?;
        let size = fragment::size(&group)?;
        let index_size = 48 + (self.index.len() as u64 + 1) * 19;
        if self.offset + size as u64 + index_size > PART_LIMIT {
            return Err(Error::PartFull);
        }
        let out = fragment::write(&group, sequence, size, vsize, asize);
        self.index.push((group.video[0].timestamp, self.offset));
        self.offset += out.len() as u64;
        self.video_end = Some(group.video_end);
        if !group.audio.is_empty() {
            self.audio_end = Some(group.audio_end);
        }
        Ok(out)
    }
    /// End a part without rewriting its init segment. tfra indexes video sync
    /// samples by their absolute file offsets; mfro allows discovery from EOF.
    pub fn finish(&mut self) -> Result<Vec<u8>, Error> {
        if self.finished {
            return Err(Error::Finished);
        }
        let size = 48 + self.index.len() * 19;
        let mut b = Boxes::new(size);
        b.boxed(b"mfra", |b| {
            b.full(b"tfra", 1, 0, |b| {
                b.u32(1);
                b.u32(0);
                b.u32(self.index.len() as u32);
                for &(time, offset) in &self.index {
                    b.u64(time);
                    b.u64(offset);
                    b.bytes(&[1, 1, 1]);
                }
            });
            b.full(b"mfro", 0, 0, |b| b.u32(size as u32));
        });
        self.finished = true;
        Ok(b.0)
    }
}
