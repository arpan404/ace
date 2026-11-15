//! The encoder's units as Annex B H.264 for both paths. Media Foundation units arrive as
//! length-prefixed NAL units with an `avcC` record on keyframes (media-mf); WebCodecs and the
//! daemon's viewers take Annex B, so the parameter sets go before every IDR.
use media_codec::{BitstreamFormat, Codec, EncodedUnit};
use media_mf::nal::{
    annexb_with_sets, codec_string, sample_to_annexb, sets_from_record, ParameterSets,
};

#[derive(Default)]
pub struct AnnexB {
    sets: ParameterSets,
    codec: Option<String>,
}

#[derive(Debug, PartialEq)]
pub struct Converted {
    pub payload: Vec<u8>,
    pub key: bool,
    /// The WebCodecs codec string of the current parameter sets.
    pub codec: Option<String>,
}

impl AnnexB {
    /// Forgets the parameter sets: a new encoder session sends its own.
    pub fn reset(&mut self) {
        *self = Self::default();
    }

    /// One unit as Annex B. `None` for a malformed unit, a codec other than H.264, or a
    /// keyframe with no parameter sets known (a decoder could not start there).
    pub fn convert(&mut self, unit: &EncodedUnit) -> Option<Converted> {
        if unit.codec != Codec::H264 {
            return None;
        }
        if let Some(record) = unit.description.as_deref() {
            self.sets = sets_from_record(Codec::H264, record)?;
            self.codec = codec_string(Codec::H264, record);
        }
        let mut payload = Vec::with_capacity(unit.data.len() + 64);
        match unit.format {
            BitstreamFormat::Avcc => {
                sample_to_annexb(&unit.data, unit.key.then_some(&self.sets), &mut payload)?
            }
            BitstreamFormat::AnnexB => {
                if unit.key && !self.sets.complete(Codec::H264) {
                    self.sets.absorb(Codec::H264, &unit.data);
                }
                annexb_with_sets(Codec::H264, &unit.data, &self.sets, unit.key, &mut payload)
            }
            _ => return None,
        }
        if unit.key && !self.sets.complete(Codec::H264) {
            return None;
        }
        Some(Converted {
            payload,
            key: unit.key,
            codec: self.codec.clone(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use media_codec::Size;
    use media_mf::nal::annexb_units;

    // Baseline profile 66, level 31 (avc1.42001F).
    const SPS: &[u8] = &[0x67, 0x42, 0x00, 0x1f, 0xe9, 0x02, 0x80, 0xf6, 0x40];
    const PPS: &[u8] = &[0x68, 0xce, 0x38, 0x80];
    const IDR: &[u8] = &[0x65, 0x88, 0x84, 0x21];
    const DELTA: &[u8] = &[0x41, 0x9a, 0x22];

    fn record() -> Vec<u8> {
        let mut sets = ParameterSets::default();
        let mut annexb = vec![0, 0, 0, 1];
        annexb.extend_from_slice(SPS);
        annexb.extend_from_slice(&[0, 0, 0, 1]);
        annexb.extend_from_slice(PPS);
        sets.absorb(Codec::H264, &annexb);
        sets.record(Codec::H264).unwrap()
    }

    fn avcc(nal: &[u8], key: bool) -> EncodedUnit {
        let mut data = (nal.len() as u32).to_be_bytes().to_vec();
        data.extend_from_slice(nal);
        EncodedUnit {
            codec: Codec::H264,
            size: Size {
                width: 640,
                height: 360,
            },
            format: BitstreamFormat::Avcc,
            data,
            key,
            description: key.then(record),
            pts_us: 0,
            duration_us: 16_666,
        }
    }

    #[test]
    fn every_idr_carries_its_parameter_sets_and_deltas_carry_none() {
        let mut annexb = AnnexB::default();
        for _ in 0..2 {
            let key = annexb.convert(&avcc(IDR, true)).unwrap();
            assert_eq!(
                annexb_units(&key.payload).collect::<Vec<_>>(),
                vec![SPS, PPS, IDR]
            );
            assert_eq!(key.codec.as_deref(), Some("avc1.42001F"));
            let delta = annexb.convert(&avcc(DELTA, false)).unwrap();
            assert_eq!(
                annexb_units(&delta.payload).collect::<Vec<_>>(),
                vec![DELTA]
            );
            assert!(!delta.key);
        }
    }

    #[test]
    fn a_keyframe_without_parameter_sets_is_not_handed_on() {
        let mut annexb = AnnexB::default();
        let mut unit = avcc(IDR, true);
        unit.description = None;
        assert_eq!(annexb.convert(&unit), None);
    }

    #[test]
    fn a_truncated_unit_is_refused() {
        let mut unit = avcc(DELTA, false);
        unit.data.truncate(5);
        assert_eq!(AnnexB::default().convert(&unit), None);
    }
}
