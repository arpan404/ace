// SPDX-License-Identifier: Apache-2.0
//! A recording's parts, decided with no I/O (docs/media/plan.md, "media-mp4"). Frames the
//! barrier released go in; the bytes to append to which part come out as [`Out`]s, in order.
//!
//! - **Fragments.** Each keyframe starts a group of pictures. A group is written, as one
//!   `moof`+`mdat`, when the next keyframe seals it, so a crash loses at most the open group.
//! - **Parts.** A part is one playable MP4 starting at zero. A new part starts at a keyframe
//!   when the size bound would be passed, on `record.cut`, when the picture's configuration
//!   changes (size or codec), and when audio first appears in a part that has none.
//! - **Time.** Samples are timed by when they were captured, on ace-media's clock. Video uses
//!   90 kHz and never goes backwards; audio is timed by its packets' own durations from where
//!   it starts, so it never drifts, and re-anchors after a gap.
//! - **Gaps.** A gap seals the open group, and nothing is written until the next keyframe.
use super::opus;
use super::video::{self, Refused};
use media_mp4::{Error, Group, Muxer, OpusConfig, PART_LIMIT, Sample, VideoCodec, VideoConfig};
use media_wire::frame::MediaFrame;

const VIDEO_HZ: u64 = 90_000;
const AUDIO_HZ: u64 = 48_000;
/// A last picture's duration when nothing follows it: one frame at 30 fps.
const LAST_FRAME_TICKS: u64 = 3_000;
/// Audio whose capture time strays this far past where its packets put it starts again there
/// (the source was silent, or packets were lost).
const AUDIO_SLIP_TICKS: u64 = 9_600;
/// The least a part may be bounded to, so it always has room for a fragment and its index.
pub const MIN_PART_BYTES: u64 = 64 * 1024;
/// Pointer and lease lines kept while no part is open.
const MAX_WAITING_LINES: usize = 1_024;
const KIND_AUDIO: u8 = 2;
const FLAG_KEYFRAME: u32 = 1;
const CODEC_OPUS: u8 = 9;

#[derive(Debug, PartialEq, Eq)]
pub enum Out {
    /// Start part `index`; the bytes that follow belong to it.
    Open { index: u32 },
    /// Append to the open part, as one write.
    Bytes(Vec<u8>),
    /// Append one line to the open part's pointer track.
    Line(String),
    /// The open part got no fragment: remove it (its number is used again).
    Discard { index: u32 },
    /// The open part is complete.
    Close(Closed),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Closed {
    pub index: u32,
    pub bytes: u64,
    pub duration_ms: u64,
    pub gaps: u32,
}

#[derive(Clone, PartialEq, Eq)]
struct Config {
    codec: VideoCodec,
    width: u16,
    height: u16,
    description: Vec<u8>,
}

struct Picture {
    captured_us: u64,
    data: Vec<u8>,
}

struct Sound {
    captured_us: u64,
    samples: u32,
    data: Vec<u8>,
}

struct Gop {
    config: Config,
    pictures: Vec<Picture>,
    sounds: Vec<Sound>,
    /// Begins a new part (it started after a `record.cut`).
    cut: bool,
}

struct Part {
    index: u32,
    muxer: Muxer,
    config: Config,
    audio: bool,
    origin_us: u64,
    bytes: u64,
    fragments: u32,
    gaps: u32,
    video_end: u64,
    /// Where the next audio packet goes; `None` re-anchors it to its capture time.
    audio_next: Option<u64>,
    /// The end of the last audio written: audio never goes back before it.
    audio_end: u64,
}

pub struct Assembler {
    limit: u64,
    pointer: bool,
    next_index: u32,
    part: Option<Part>,
    gop: Option<Gop>,
    /// Nothing is written until a keyframe (start, and after every gap).
    awaiting_key: bool,
    cut: bool,
    opus: Option<OpusConfig>,
    waiting: Vec<(u64, u32, serde_json::Value)>,
    /// A gap to count in the next part, for losses while none was open.
    gaps_ahead: u32,
}

impl Assembler {
    /// Parts start at `first_index` and hold at most `max_bytes`, kept between 64 KiB and
    /// 512 MiB. A group larger than the bound still gets a part of its own.
    pub fn new(first_index: u32, max_bytes: u64, pointer: bool) -> Self {
        Self {
            limit: max_bytes.clamp(MIN_PART_BYTES, PART_LIMIT),
            pointer,
            next_index: first_index,
            part: None,
            gop: None,
            awaiting_key: true,
            cut: false,
            opus: None,
            waiting: Vec::new(),
            gaps_ahead: 0,
        }
    }

    /// One released frame. A unit MP4 can't hold (a JPEG or VP8 picture) is an error: the
    /// recording can't continue in this format.
    pub fn frame(
        &mut self,
        frame: &MediaFrame,
        captured_us: u64,
        out: &mut Vec<Out>,
    ) -> Result<(), &'static str> {
        if frame.kind == KIND_AUDIO {
            self.sound(frame, captured_us);
            return Ok(());
        }
        let unit = match video::unit(frame) {
            Ok(unit) => unit,
            Err(Refused::Codec) => return Err("unsupported-codec"),
            Err(Refused::Empty) => return Ok(()),
        };
        let key = frame.flags & FLAG_KEYFRAME != 0;
        if !key {
            match &mut self.gop {
                Some(gop) if !self.awaiting_key => gop.pictures.push(Picture {
                    captured_us,
                    data: unit.data,
                }),
                _ => {}
            }
            return Ok(());
        }
        let config = match (unit.description, &self.gop, &self.part) {
            (Some(description), ..) => Config {
                codec: unit.codec,
                width: frame.width,
                height: frame.height,
                description,
            },
            // A keyframe without parameter sets continues the configuration in use.
            (None, Some(gop), _) if gop.config.codec == unit.codec => gop.config.clone(),
            (None, None, Some(part)) if part.config.codec == unit.codec => part.config.clone(),
            (None, ..) => {
                self.gap(out);
                return Ok(());
            }
        };
        if let Some(gop) = self.gop.take() {
            self.write(gop, Some(captured_us), false, out);
        }
        self.awaiting_key = false;
        self.gop = Some(Gop {
            config,
            pictures: vec![Picture {
                captured_us,
                data: unit.data,
            }],
            sounds: Vec::new(),
            cut: std::mem::take(&mut self.cut),
        });
        Ok(())
    }

    fn sound(&mut self, frame: &MediaFrame, captured_us: u64) {
        if frame.codec != CODEC_OPUS {
            return;
        }
        if let Some((rate, channels)) = opus::config(&frame.description) {
            self.opus = Some(OpusConfig {
                channels,
                input_sample_rate: rate,
                priming_samples: 0,
                output_gain: 0,
            });
        }
        let (Some(samples), Some(gop)) = (opus::samples(&frame.payload), &mut self.gop) else {
            return;
        };
        if self.opus.is_none() || self.awaiting_key {
            return;
        }
        gop.sounds.push(Sound {
            captured_us,
            samples,
            data: frame.payload.clone(),
        });
    }

    /// Frames were lost: the open group ends where it got to, and the next starts at a keyframe.
    pub fn gap(&mut self, out: &mut Vec<Out>) {
        if let Some(gop) = self.gop.take() {
            self.write(gop, None, false, out);
        }
        self.awaiting_key = true;
        match &mut self.part {
            Some(part) => {
                part.gaps += 1;
                part.audio_next = None;
            }
            None => self.gaps_ahead += 1,
        }
    }

    /// `record.cut`: the next keyframe starts a new part.
    pub fn cut(&mut self) {
        self.cut = true;
    }

    /// A pointer or lease change in a clear epoch, for the pointer track.
    pub fn meta(&mut self, at_us: u64, epoch: u32, data: &serde_json::Value, out: &mut Vec<Out>) {
        if !self.pointer {
            return;
        }
        match &self.part {
            Some(part) => out.push(Out::Line(line(part.origin_us, at_us, epoch, data))),
            None if self.waiting.len() < MAX_WAITING_LINES => {
                self.waiting.push((at_us, epoch, data.clone()));
            }
            None => {}
        }
    }

    /// Stop: the open group is written with its last picture's duration, and the part closes
    /// with its index.
    pub fn finish(&mut self, out: &mut Vec<Out>) {
        if let Some(gop) = self.gop.take() {
            self.write(gop, None, true, out);
        }
        self.close(out);
    }

    fn close(&mut self, out: &mut Vec<Out>) {
        let Some(mut part) = self.part.take() else {
            return;
        };
        if part.fragments == 0 {
            self.next_index = part.index;
            self.gaps_ahead += part.gaps;
            out.push(Out::Discard { index: part.index });
            return;
        }
        if let Ok(index) = part.muxer.finish() {
            part.bytes += index.len() as u64;
            out.push(Out::Bytes(index));
        }
        out.push(Out::Close(Closed {
            index: part.index,
            bytes: part.bytes,
            duration_ms: part.video_end * 1_000 / VIDEO_HZ,
            gaps: part.gaps,
        }));
    }

    fn open(&mut self, gop: &Gop, out: &mut Vec<Out>) -> bool {
        let audio = if gop.sounds.is_empty() {
            None
        } else {
            self.opus.clone()
        };
        let muxer = Muxer::new(
            VideoConfig {
                codec: gop.config.codec,
                width: gop.config.width,
                height: gop.config.height,
                timescale: VIDEO_HZ as u32,
                description: gop.config.description.clone(),
            },
            audio.clone(),
        );
        let Ok(muxer) = muxer else {
            return false;
        };
        let index = self.next_index;
        self.next_index += 1;
        let init = muxer.init_segment().to_vec();
        let origin_us = gop.pictures.first().map_or(0, |p| p.captured_us);
        out.push(Out::Open { index });
        let part = Part {
            index,
            muxer,
            config: gop.config.clone(),
            audio: audio.is_some(),
            origin_us,
            bytes: init.len() as u64,
            fragments: 0,
            gaps: std::mem::take(&mut self.gaps_ahead),
            video_end: 0,
            audio_next: None,
            audio_end: 0,
        };
        out.push(Out::Bytes(init));
        for (at, epoch, data) in std::mem::take(&mut self.waiting) {
            out.push(Out::Line(line(origin_us, at, epoch, &data)));
        }
        self.part = Some(part);
        true
    }

    /// Writes one group into the open part, or a new one when it must start there. `end_us`
    /// is when the next keyframe was captured; without it the last picture gets the group's
    /// typical duration. A group the muxer refuses is lost as a gap.
    fn write(&mut self, gop: Gop, end_us: Option<u64>, last: bool, out: &mut Vec<Out>) {
        let needs_new = match &self.part {
            None => true,
            Some(part) => {
                gop.cut
                    || part.config != gop.config
                    || (!part.audio && !gop.sounds.is_empty() && self.opus.is_some())
                    || (part.fragments > 0
                        && part.bytes + estimate(&gop) + index_bytes(part.fragments + 1)
                            > self.limit)
            }
        };
        if needs_new {
            self.close(out);
            if !self.open(&gop, out) {
                self.gaps_ahead += 1;
                return;
            }
        }
        let Some(part) = &mut self.part else {
            return;
        };
        match mux(part, &gop, end_us, last) {
            Ok(bytes) => {
                part.bytes += bytes.len() as u64;
                part.fragments += 1;
                out.push(Out::Bytes(bytes));
            }
            Err(Error::PartFull) if part.fragments > 0 => {
                self.close(out);
                if self.open(&gop, out)
                    && let Some(part) = &mut self.part
                    && let Ok(bytes) = mux(part, &gop, end_us, last)
                {
                    part.bytes += bytes.len() as u64;
                    part.fragments += 1;
                    out.push(Out::Bytes(bytes));
                } else if let Some(part) = &mut self.part {
                    part.gaps += 1;
                }
            }
            Err(_) => part.gaps += 1,
        }
    }
}

/// Times a group against its part and muxes it.
fn mux(part: &mut Part, gop: &Gop, end_us: Option<u64>, last: bool) -> Result<Vec<u8>, Error> {
    let ticks = |us: u64, hz: u64| us.saturating_sub(part.origin_us) * hz / 1_000_000;
    let mut times = Vec::with_capacity(gop.pictures.len());
    let mut previous = (part.fragments > 0).then_some(part.video_end);
    for picture in &gop.pictures {
        let t = ticks(picture.captured_us, VIDEO_HZ);
        let t = match previous {
            Some(p) if part.fragments > 0 && times.is_empty() => t.max(p),
            Some(p) => t.max(p + 1),
            None => t,
        };
        times.push(t);
        previous = Some(t);
    }
    let first = times.first().copied().unwrap_or(0);
    let last_time = times.last().copied().unwrap_or(0);
    let typical = if times.len() > 1 {
        ((last_time - first) / (times.len() as u64 - 1)).max(1)
    } else {
        LAST_FRAME_TICKS
    };
    let video_end = end_us
        .map(|us| ticks(us, VIDEO_HZ))
        .filter(|&e| e > last_time)
        .unwrap_or(last_time + typical);
    let video: Vec<Sample<'_>> = gop
        .pictures
        .iter()
        .zip(&times)
        .enumerate()
        .map(|(i, (p, &t))| Sample {
            timestamp: t,
            data: &p.data,
            keyframe: i == 0,
        })
        .collect();

    let mut audio_next = part.audio_next;
    let mut audio = Vec::with_capacity(gop.sounds.len());
    if part.audio {
        for sound in &gop.sounds {
            if sound.captured_us < part.origin_us {
                continue;
            }
            let heard = ticks(sound.captured_us, AUDIO_HZ);
            let t = match audio_next {
                Some(next) if heard <= next + AUDIO_SLIP_TICKS => next,
                Some(next) => heard.max(next),
                None => heard.max(part.audio_end),
            };
            audio.push(Sample {
                timestamp: t,
                data: &sound.data,
                keyframe: true,
            });
            audio_next = Some(t + u64::from(sound.samples));
        }
    }
    let group = Group {
        video: &video,
        video_end,
        audio: &audio,
        audio_end: audio_next.unwrap_or(0),
    };
    let bytes = if last {
        part.muxer.final_fragment(group)?
    } else {
        part.muxer.fragment(group)?
    };
    part.video_end = video_end;
    part.audio_next = audio_next;
    part.audio_end = audio_next.unwrap_or(part.audio_end);
    Ok(bytes)
}

/// At least what a group's fragment takes: its data and per-sample rows, and the boxes.
fn estimate(gop: &Gop) -> u64 {
    let pictures: u64 = gop.pictures.iter().map(|p| p.data.len() as u64 + 12).sum();
    let sounds: u64 = gop.sounds.iter().map(|s| s.data.len() as u64 + 12).sum();
    pictures + sounds + 256
}

/// The clean-stop index of a part with `fragments` fragments.
fn index_bytes(fragments: u32) -> u64 {
    48 + u64::from(fragments) * 19
}

fn line(origin_us: u64, at_us: u64, epoch: u32, data: &serde_json::Value) -> String {
    let ms = at_us.saturating_sub(origin_us) / 1_000;
    serde_json::json!({ "t": ms, "epoch": epoch, "data": data }).to_string()
}

#[cfg(test)]
#[path = "assemble_tests.rs"]
mod tests;
