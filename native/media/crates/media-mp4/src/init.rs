// SPDX-License-Identifier: Apache-2.0
use crate::{OpusConfig, VideoCodec, VideoConfig, boxes::Boxes};

pub(crate) fn init(video: &VideoConfig, audio: Option<&OpusConfig>) -> Vec<u8> {
    let mut b = Boxes::new(2048 + video.description.len());
    b.boxed(b"ftyp", |b| {
        b.bytes(b"iso6");
        b.u32(0);
        b.bytes(b"iso6mp41");
    });
    b.boxed(b"moov", |b| {
        b.full(b"mvhd", 0, 0, |b| {
            b.zeros(8);
            b.u32(48000);
            b.u32(0);
            b.u32(0x10000);
            b.u16(0x100);
            b.zeros(10);
            b.matrix();
            b.zeros(24);
            b.u32(3);
        });
        track(b, video, None);
        if let Some(a) = audio {
            track(b, video, Some(a));
        }
        b.boxed(b"mvex", |b| {
            for id in 1..=if audio.is_some() { 2 } else { 1 } {
                b.full(b"trex", 0, 0, |b| {
                    b.u32(id);
                    b.u32(1);
                    b.zeros(12);
                });
            }
        });
    });
    b.0
}
fn track(b: &mut Boxes, v: &VideoConfig, a: Option<&OpusConfig>) {
    let id = if a.is_some() { 2 } else { 1 };
    b.boxed(b"trak", |b| {
        b.full(b"tkhd", 0, 7, |b| {
            b.zeros(8);
            b.u32(id);
            b.zeros(16);
            b.u16(0);
            b.u16(0);
            b.u16(if a.is_some() { 0x100 } else { 0 });
            b.u16(0);
            b.matrix();
            b.u32(if a.is_some() {
                0
            } else {
                u32::from(v.width) << 16
            });
            b.u32(if a.is_some() {
                0
            } else {
                u32::from(v.height) << 16
            });
        });
        if let Some(a) = a {
            // Opus §4.4: zero duration means the duration of the fragmented stream.
            b.boxed(b"edts", |b| {
                b.full(b"elst", 1, 0, |b| {
                    b.u32(1);
                    b.u64(0);
                    b.u64(u64::from(a.priming_samples));
                    b.u16(1);
                    b.u16(0);
                })
            });
        }
        b.boxed(b"mdia", |b| {
            b.full(b"mdhd", 0, 0, |b| {
                b.zeros(8);
                b.u32(if a.is_some() { 48000 } else { v.timescale });
                b.u32(0);
                b.u16(0x55c4);
                b.u16(0);
            });
            b.full(b"hdlr", 0, 0, |b| {
                b.u32(0);
                b.bytes(if a.is_some() { b"soun" } else { b"vide" });
                b.zeros(12);
                b.bytes(b"\0");
            });
            b.boxed(b"minf", |b| {
                if a.is_some() {
                    b.full(b"smhd", 0, 0, |b| b.zeros(4));
                } else {
                    b.full(b"vmhd", 0, 1, |b| b.zeros(8));
                }
                b.boxed(b"dinf", |b| {
                    b.full(b"dref", 0, 0, |b| {
                        b.u32(1);
                        b.full(b"url ", 0, 1, |_| {});
                    })
                });
                b.boxed(b"stbl", |b| {
                    b.full(b"stsd", 0, 0, |b| {
                        b.u32(1);
                        if let Some(a) = a {
                            opus(b, a);
                        } else {
                            visual(b, v);
                        }
                    });
                    for kind in [b"stts", b"stsc", b"stco"] {
                        b.full(kind, 0, 0, |b| b.u32(0));
                    }
                    b.full(b"stsz", 0, 0, |b| b.zeros(8));
                    if a.is_some() {
                        // Worst case 2.5 ms packets need 32 packets for 80 ms pre-roll.
                        b.full(b"sgpd", 1, 0, |b| {
                            b.bytes(b"roll");
                            b.u32(2);
                            b.u32(1);
                            b.u16((-32_i16) as u16);
                        });
                        b.full(b"sbgp", 0, 0, |b| {
                            b.bytes(b"roll");
                            b.u32(0);
                        });
                    }
                });
            });
        });
    });
}
fn visual(b: &mut Boxes, v: &VideoConfig) {
    let (entry, config) = match v.codec {
        VideoCodec::H264 => (b"avc1", b"avcC"),
        VideoCodec::Hevc => (b"hvc1", b"hvcC"),
    };
    b.boxed(entry, |b| {
        b.zeros(6);
        b.u16(1);
        b.zeros(16);
        b.u16(v.width);
        b.u16(v.height);
        b.u32(0x480000);
        b.u32(0x480000);
        b.u32(0);
        b.u16(1);
        b.zeros(32);
        b.u16(24);
        b.u16(0xffff);
        b.boxed(config, |b| b.bytes(&v.description));
    });
}
fn opus(b: &mut Boxes, a: &OpusConfig) {
    b.boxed(b"Opus", |b| {
        b.zeros(6);
        b.u16(1);
        b.zeros(8);
        b.u16(u16::from(a.channels));
        b.u16(16);
        b.zeros(4);
        b.u32(48000 << 16);
        b.boxed(b"dOps", |b| {
            b.bytes(&[0, a.channels]);
            b.u16(3840);
            b.u32(a.input_sample_rate);
            b.u16(a.output_gain as u16);
            b.bytes(&[0]);
        });
    });
}
