use super::*;
use media_codec::{
    BitstreamFormat, Codec, CpuPicture, EncodeSpec, EncodedUnit, EncoderCaps, PixelFormat, Plane,
    Size,
};
use media_mf::nal::ParameterSets;

/// An encoder like a hardware MFT: a picture's unit comes out only when it is serviced
/// `delay` times after going in.
struct Late {
    delay: u32,
    waiting: VecDeque<(u64, bool, u32)>,
    ready: VecDeque<EncodedUnit>,
    serviced: u32,
}

fn record() -> Vec<u8> {
    let mut sets = ParameterSets::default();
    sets.absorb(
        Codec::H264,
        &[
            0, 0, 0, 1, 0x67, 0x42, 0, 0x1f, 0xe9, 0, 0, 0, 1, 0x68, 0xce, 0x38, 0x80,
        ],
    );
    sets.record(Codec::H264).unwrap()
}

impl Encoder for Late {
    fn configure(&mut self, _: &EncodeSpec) -> Result<(), CodecError> {
        Ok(())
    }
    fn encode(&mut self, picture: Picture, key: bool) -> Result<(), CodecError> {
        self.waiting.push_back((picture.pts_us(), key, self.delay));
        Ok(())
    }
    fn poll(&mut self) -> Option<EncodedUnit> {
        self.ready.pop_front()
    }
    fn caps(&self) -> EncoderCaps {
        EncoderCaps {
            hardware: true,
            codecs: vec![Codec::H264],
            max_size: Size {
                width: 64,
                height: 64,
            },
            quantizer: false,
        }
    }
}
impl Live for Late {
    fn service(&mut self) -> Result<(), CodecError> {
        self.serviced += 1;
        for entry in &mut self.waiting {
            entry.2 = entry.2.saturating_sub(1);
        }
        while self.waiting.front().is_some_and(|w| w.2 == 0) {
            let Some((pts, key, _)) = self.waiting.pop_front() else {
                break;
            };
            let nal: &[u8] = if key {
                &[0x65, 0x88, 0x84, 0x21]
            } else {
                &[0x41, 0x9a, 0x22]
            };
            let mut data = (nal.len() as u32).to_be_bytes().to_vec();
            data.extend_from_slice(nal);
            self.ready.push_back(EncodedUnit {
                codec: Codec::H264,
                size: Size {
                    width: 64,
                    height: 64,
                },
                format: BitstreamFormat::Avcc,
                data,
                key,
                description: key.then(record),
                pts_us: pts,
                duration_us: 16_666,
            });
        }
        Ok(())
    }
}

fn picture(pts: u64) -> Picture {
    Picture::Cpu(
        CpuPicture::new(
            Size {
                width: 64,
                height: 64,
            },
            PixelFormat::Nv12,
            [
                Plane {
                    data: vec![0; 64 * 64],
                    stride: 64,
                },
                Plane {
                    data: vec![0; 64 * 32],
                    stride: 64,
                },
            ],
            pts,
        )
        .unwrap(),
    )
}

fn captured(epoch: u32) -> Captured {
    Captured {
        captured_us: 1_000,
        timestamp_ms: 1_700_000_000_000.0 + epoch as f64,
        scale: 1.5,
        epoch,
    }
}

#[test]
fn a_keyframe_the_encoder_hands_back_late_comes_out_on_service_with_its_capture_metadata() {
    let mut pump = Pump::new(Late {
        delay: 2,
        waiting: VecDeque::new(),
        ready: VecDeque::new(),
        serviced: 0,
    });
    let pts = pump.next_pts(1_000);
    // Nothing comes out with the picture, and no other picture follows (an unchanged desktop).
    assert!(pump
        .submit(picture(pts), captured(7), true)
        .unwrap()
        .is_empty());
    assert!(pump.owed());
    assert!(pump.service().unwrap().is_empty());
    let units = pump.service().unwrap();
    assert_eq!(units.len(), 1);
    let unit = &units[0];
    assert!(unit.key);
    assert_eq!(
        (unit.epoch, unit.scale, unit.timestamp_ms),
        (7, 1.5, 1_700_000_000_007.0)
    );
    assert!(!pump.owed());
    // With nothing owed, service leaves the encoder alone.
    let serviced = pump.encoder().serviced;
    assert!(pump.service().unwrap().is_empty());
    assert_eq!(pump.encoder().serviced, serviced);
}

#[test]
fn each_late_unit_keeps_its_own_picture_metadata() {
    let mut pump = Pump::new(Late {
        delay: 1,
        waiting: VecDeque::new(),
        ready: VecDeque::new(),
        serviced: 0,
    });
    let first = pump.next_pts(1_000);
    pump.submit(picture(first), captured(1), true).unwrap();
    let second = pump.next_pts(1_000);
    assert!(second > first);
    pump.submit(picture(second), captured(2), false).unwrap();
    let units = pump.service().unwrap();
    assert_eq!(
        units.iter().map(|u| u.epoch).collect::<Vec<_>>(),
        vec![1, 2]
    );
}
