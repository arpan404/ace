// SPDX-License-Identifier: Apache-2.0
use super::*;
use media_codec::fake::{EncodeStep, FakeEncoder};
use media_codec::{CpuJpegCodec, CpuPicture, JpegCodec, PixelFormat, Plane, StillCodec};

struct Fake {
    hardware: bool,
    backend: Backend,
    script: Vec<EncodeStep>,
    opened: usize,
}

impl Backends for Fake {
    fn encoder(&mut self, codec: Codec) -> Result<Chosen, CodecError> {
        if codec != Codec::H264 {
            return Err(CodecError::Unsupported("H.264 only".into()));
        }
        self.opened += 1;
        Ok(Chosen {
            encoder: Box::new(FakeEncoder::new(std::mem::take(&mut self.script))),
            backend: self.backend,
            hardware: self.hardware,
            takes_jpeg: None,
        })
    }
    fn decode(&mut self, jpeg: &[u8], size: Size, _: Backend) -> Result<Decoded, CodecError> {
        let picture =
            JpegCodec::decode(&mut CpuJpegCodec::default(), jpeg, size.width, size.height)?;
        Ok(Decoded {
            picture,
            backend: Backend::Cpu,
            hardware: false,
            uploads: 0,
        })
    }
    fn probed(&self) -> Vec<media_wire::capability::Capability> {
        Vec::new()
    }
}

fn fake(hardware: bool) -> Worker<Fake> {
    Worker::new(Fake {
        hardware,
        backend: if hardware {
            Backend::Vt
        } else {
            Backend::Chrome
        },
        script: Vec::new(),
        opened: 0,
    })
}

fn base64(bytes: &[u8]) -> Vec<u8> {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::new();
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = u32::from(b[0]) << 16 | u32::from(b[1]) << 8 | u32::from(b[2]);
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(ALPHABET[(n >> (18 - 6 * i) & 63) as usize]);
            } else {
                out.push(b'=');
            }
        }
    }
    out
}

fn jpeg(width: u32, height: u32) -> Vec<u8> {
    let size = Size { width, height };
    let picture = CpuPicture::new(
        size,
        PixelFormat::Rgb8,
        [Plane {
            data: vec![90; (width * height * 3) as usize],
            stride: (width * 3) as usize,
        }],
        0,
    );
    let Ok(picture) = picture else {
        panic!("picture");
    };
    match StillCodec::encode(&mut CpuJpegCodec::default(), &picture, 80) {
        Ok(jpeg) => base64(&jpeg),
        Err(error) => panic!("jpeg: {error}"),
    }
}

fn spec(id: u32, bitrate: u32) -> EncodeSpec {
    EncodeSpec {
        id,
        codec: "avc1.42E01F".into(),
        width: 64,
        height: 48,
        fps: 30,
        bitrate,
        quantizer: None,
    }
}

fn units(out: &[Output]) -> Vec<&MediaFrame> {
    out.iter()
        .filter_map(|o| match o {
            Output::Unit(frame) => Some(frame),
            _ => None,
        })
        .collect()
}

fn picture(epoch: u32) -> Command {
    Command::Picture {
        text: jpeg(64, 48),
        raw: false,
        epoch,
        age_us: 2_000,
    }
}

#[test]
fn the_first_unit_is_a_keyframe_with_its_description_stamped_with_its_pictures_epoch() {
    let mut worker = fake(true);
    let mut out = Vec::new();
    worker.command(
        Command::Configure(vec![spec(7, 1_000_000)]),
        10_000,
        &mut out,
    );
    worker.command(picture(3), 20_000, &mut out);
    worker.command(picture(4), 40_000, &mut out);
    let units = units(&out);
    assert_eq!(units.len(), 2);
    let (first, second) = (units[0], units[1]);
    assert_eq!((first.encode, first.epoch, first.flags & 1), (7, 3, 1));
    assert_eq!(first.description, b"ace-fake-v1");
    assert_eq!((first.width, first.height), (64, 48));
    assert_eq!(first.age_us, 2_000);
    assert_eq!((second.epoch, second.flags & 1), (4, 0));
    assert!(second.description.is_empty());
}

#[test]
fn a_keyframe_request_makes_the_next_unit_a_keyframe_and_a_rate_change_does_not() {
    let mut worker = fake(true);
    let mut out = Vec::new();
    worker.command(Command::Configure(vec![spec(1, 1_000_000)]), 0, &mut out);
    worker.command(picture(1), 1_000, &mut out);
    worker.command(Command::Configure(vec![spec(1, 500_000)]), 2_000, &mut out);
    worker.command(picture(1), 3_000, &mut out);
    worker.command(Command::Key(1), 4_000, &mut out);
    worker.command(picture(1), 5_000, &mut out);
    let keys: Vec<u32> = units(&out).iter().map(|u| u.flags & 1).collect();
    assert_eq!(keys, [1, 0, 1]);
    assert_eq!(worker.backends.opened, 1, "the rate changed in place");
}

#[test]
fn a_hardware_encode_reports_its_steps_once_and_is_not_degraded() {
    let mut worker = fake(true);
    let mut out = Vec::new();
    worker.command(Command::Configure(vec![spec(1, 1_000_000)]), 0, &mut out);
    worker.command(picture(1), 1_000, &mut out);
    worker.command(picture(1), 2_000, &mut out);
    let reports: Vec<&Acceleration> = out
        .iter()
        .filter_map(|o| match o {
            Output::Report(a) => Some(a),
            _ => None,
        })
        .collect();
    assert_eq!(reports.len(), 1);
    assert!(!reports[0].degraded);
    let encode = reports[0].steps.iter().find(|s| s.step == Step::Encode);
    assert_eq!(
        encode.map(|s| (s.backend, s.hardware, s.uploads)),
        Some((Backend::Vt, true, 1))
    );
}

#[test]
fn the_last_resort_encoder_is_reported_degraded_with_its_sentence() {
    let mut worker = fake(false);
    let mut out = Vec::new();
    worker.command(Command::Configure(vec![spec(1, 1_000_000)]), 0, &mut out);
    worker.command(picture(1), 1_000, &mut out);
    let report = out.iter().find_map(|o| match o {
        Output::Report(a) => Some(a),
        _ => None,
    });
    assert!(report.is_some_and(|a| a.degraded && a.reason.is_some()));
}

#[test]
fn pictures_that_are_not_base64_jpeg_are_skipped_without_ending_the_source() {
    let mut worker = fake(true);
    let mut out = Vec::new();
    worker.command(Command::Configure(vec![spec(1, 1_000_000)]), 0, &mut out);
    for text in [b"not base64!".to_vec(), base64(b"not a jpeg")] {
        worker.command(
            Command::Picture {
                text,
                raw: false,
                epoch: 1,
                age_us: 0,
            },
            1_000,
            &mut out,
        );
    }
    assert!(out.is_empty());
    worker.command(picture(1), 2_000, &mut out);
    assert_eq!(units(&out).len(), 1);
}

#[test]
fn an_encoder_error_ends_the_source_once_and_nothing_follows() {
    let mut worker = Worker::new(Fake {
        hardware: true,
        backend: Backend::Vt,
        script: vec![
            EncodeStep::Bytes(10),
            EncodeStep::Error(CodecError::Backend("gone".into())),
        ],
        opened: 0,
    });
    let mut out = Vec::new();
    worker.command(Command::Configure(vec![spec(1, 1_000_000)]), 0, &mut out);
    worker.command(picture(1), 1_000, &mut out);
    worker.command(picture(1), 2_000, &mut out);
    worker.command(picture(1), 3_000, &mut out);
    let failed: Vec<&Output> = out
        .iter()
        .filter(|o| matches!(o, Output::Failed(_)))
        .collect();
    assert_eq!(failed, [&Output::Failed("encoder-failed".into())]);
    assert_eq!(units(&out).len(), 1);
}

#[test]
fn a_codec_no_backend_encodes_ends_the_source_as_unavailable() {
    let mut worker = fake(true);
    let mut out = Vec::new();
    let mut hevc = spec(1, 1_000_000);
    hevc.codec = "hvc1.1.6.L93.B0".into();
    worker.command(Command::Configure(vec![hevc]), 0, &mut out);
    assert_eq!(out, [Output::Failed("encoder-unavailable".into())]);
}

#[test]
fn h264_units_name_the_profile_and_level_the_encoder_wrote() {
    assert_eq!(
        codec_string(
            Codec::H264,
            Some(&[1, 0x64, 0x00, 0x33, 0xff]),
            "avc1.42E01F"
        ),
        "avc1.640033"
    );
    assert_eq!(
        codec_string(Codec::Hevc, Some(&[1, 2, 3, 4]), "hvc1.1.6.L93.B0"),
        "hvc1.1.6.L93.B0"
    );
}

/// An encoder that keeps its output until it is flushed (as a hardware encoder's queue does),
/// or that can't be flushed at all.
struct Late {
    inner: FakeEncoder,
    held: Vec<EncodedUnit>,
    flushable: bool,
}

impl Encoder for Late {
    fn configure(&mut self, spec: &Spec) -> Result<(), CodecError> {
        self.inner.configure(spec)
    }
    fn encode(&mut self, picture: Picture, force_key: bool) -> Result<(), CodecError> {
        self.inner.encode(picture, force_key)?;
        while let Some(unit) = self.inner.poll() {
            self.held.push(unit);
        }
        Ok(())
    }
    fn poll(&mut self) -> Option<EncodedUnit> {
        None
    }
    fn caps(&self) -> media_codec::EncoderCaps {
        self.inner.caps()
    }
    fn flush(&mut self) -> Result<(), CodecError> {
        if !self.flushable {
            return Err(CodecError::Unsupported("no flush".into()));
        }
        Ok(())
    }
}

struct LateBackends {
    flushable: bool,
    released: std::sync::Arc<std::sync::Mutex<Vec<EncodedUnit>>>,
}

/// `Late` with its held units moved to a shared list on flush, which `poll_result` drains.
struct Flushed {
    late: Late,
    out: std::sync::Arc<std::sync::Mutex<Vec<EncodedUnit>>>,
}

impl Encoder for Flushed {
    fn configure(&mut self, spec: &Spec) -> Result<(), CodecError> {
        self.late.configure(spec)
    }
    fn encode(&mut self, picture: Picture, force_key: bool) -> Result<(), CodecError> {
        self.late.encode(picture, force_key)
    }
    fn poll(&mut self) -> Option<EncodedUnit> {
        self.out
            .lock()
            .ok()
            .and_then(|mut o| (!o.is_empty()).then(|| o.remove(0)))
    }
    fn caps(&self) -> media_codec::EncoderCaps {
        self.late.caps()
    }
    fn flush(&mut self) -> Result<(), CodecError> {
        self.late.flush()?;
        if let Ok(mut out) = self.out.lock() {
            out.append(&mut self.late.held);
        }
        Ok(())
    }
}

impl Backends for LateBackends {
    fn encoder(&mut self, _: Codec) -> Result<Chosen, CodecError> {
        Ok(Chosen {
            encoder: Box::new(Flushed {
                late: Late {
                    inner: FakeEncoder::new(Vec::new()),
                    held: Vec::new(),
                    flushable: self.flushable,
                },
                out: self.released.clone(),
            }),
            backend: Backend::Vt,
            hardware: true,
            takes_jpeg: None,
        })
    }
    fn decode(&mut self, jpeg: &[u8], size: Size, _: Backend) -> Result<Decoded, CodecError> {
        let picture =
            JpegCodec::decode(&mut CpuJpegCodec::default(), jpeg, size.width, size.height)?;
        Ok(Decoded {
            picture,
            backend: Backend::Cpu,
            hardware: false,
            uploads: 0,
        })
    }
    fn probed(&self) -> Vec<media_wire::capability::Capability> {
        Vec::new()
    }
}

fn late(flushable: bool) -> Worker<LateBackends> {
    Worker::new(LateBackends {
        flushable,
        released: std::sync::Arc::default(),
    })
}

#[test]
fn a_drain_hands_over_the_output_an_encoder_still_held_then_says_it_drained() {
    let mut worker = late(true);
    let mut out = Vec::new();
    worker.command(Command::Configure(vec![spec(1, 1_000_000)]), 0, &mut out);
    worker.command(picture(1), 1_000, &mut out);
    worker.command(picture(2), 2_000, &mut out);
    assert!(units(&out).is_empty(), "the encoder holds its output");
    out.clear();
    worker.command(Command::Drain, 3_000, &mut out);
    let epochs: Vec<u32> = units(&out).iter().map(|u| u.epoch).collect();
    assert_eq!(epochs, [1, 2]);
    assert_eq!(out.last(), Some(&Output::Drained));
}

#[test]
fn an_encoder_that_cannot_drain_says_so_rather_than_drained() {
    let mut worker = late(false);
    let mut out = Vec::new();
    worker.command(Command::Configure(vec![spec(1, 1_000_000)]), 0, &mut out);
    worker.command(picture(1), 1_000, &mut out);
    out.clear();
    worker.command(Command::Drain, 2_000, &mut out);
    assert_eq!(out, [Output::Failed("encoder-undrainable".into())]);
}

#[path = "worker_upgrade_tests.rs"]
mod upgrade;

#[path = "worker_switch_tests.rs"]
mod switch;
