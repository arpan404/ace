// SPDX-License-Identifier: Apache-2.0
//! The parameter sets a session encodes with, built once from its [`EncodeSpec`]. The same
//! structs fill the VA sequence and picture buffers and are written as packed headers, so the
//! headers in the stream always describe what the driver coded.
use crate::levels::{h264_level, hevc_level};
use crate::select::{h264_profile_idc, profile};
use media_bitstream::{VideoSignal, h264, hevc};
use media_codec::{CodecError, EncodeSpec, RateControl};

/// Keyframes come at least this often (media-core's keyframe rule), which also keeps the
/// picture order count small.
pub const MAX_KEY_INTERVAL_SECONDS: u32 = 20;
/// The QP a bit-rate session starts from, before the driver's rate control moves it.
pub const DEFAULT_QP: u8 = 26;
/// HEVC coding tree blocks of 64 × 64 (2^6): what Intel's VDEnc and AMD's VCN encode.
pub const HEVC_LOG2_CTB: u32 = 6;
/// HEVC coded sizes are padded to this multiple, the minimum coding block of 8 doubled.
pub const HEVC_ALIGN: u32 = 16;

pub fn bits_per_second(spec: &EncodeSpec) -> u32 {
    match spec.rate {
        RateControl::Bitrate(b) => b,
        RateControl::Quantizer(_) => 0,
    }
}

pub fn initial_qp(spec: &EncodeSpec) -> u8 {
    match spec.rate {
        RateControl::Quantizer(q) => q,
        RateControl::Bitrate(_) => DEFAULT_QP,
    }
}

pub fn intra_period(spec: &EncodeSpec) -> u32 {
    spec.fps.saturating_mul(MAX_KEY_INTERVAL_SECONDS)
}

#[derive(Clone, Debug, PartialEq)]
pub struct H264Plan {
    pub sps: h264::Sps,
    pub pps: h264::Pps,
}

/// `max_dec_frame_buffering` 1 and no reordering: IPPP with one reference.
pub fn h264_plan(spec: &EncodeSpec, va_profile: i32) -> Result<H264Plan, CodecError> {
    spec.validate()?;
    let (profile_idc, constraints) = h264_profile_idc(va_profile);
    let high = va_profile == profile::H264_HIGH;
    let level = h264_level(
        spec.size.width,
        spec.size.height,
        spec.fps,
        bits_per_second(spec),
        high,
    )
    .ok_or_else(|| CodecError::Unsupported("size and rate past H.264 level 6.2".into()))?;
    let vui = h264::Vui {
        signal: Some(VideoSignal::bt709_limited()),
        timing: Some(h264::Timing {
            num_units_in_tick: 1,
            time_scale: spec.fps * 2,
            fixed_frame_rate: false,
        }),
        restriction: Some(h264::Restriction::low_delay(1)),
        ..Default::default()
    };
    let mut sps = h264::Sps::progressive(
        profile_idc,
        constraints,
        level,
        spec.size.width,
        spec.size.height,
        1,
        Some(vui),
    );
    // frame_num counts to 256 before wrapping.
    sps.log2_max_frame_num_minus4 = 4;
    let cabac = va_profile != profile::H264_CONSTRAINED_BASELINE;
    let pps = h264::Pps::simple(cabac, high, i32::from(initial_qp(spec)));
    Ok(H264Plan { sps, pps })
}

#[derive(Clone, Debug, PartialEq)]
pub struct HevcPlan {
    pub vps: hevc::Vps,
    pub sps: hevc::Sps,
    pub pps: hevc::Pps,
}

/// Main profile, CTB 64, one short-term set (the previous picture), no AMP, SAO or
/// temporal motion vector prediction, which every VA HEVC encoder accepts.
pub fn hevc_plan(spec: &EncodeSpec) -> Result<HevcPlan, CodecError> {
    spec.validate()?;
    let level = hevc_level(
        spec.size.width,
        spec.size.height,
        spec.fps,
        bits_per_second(spec),
    )
    .ok_or_else(|| CodecError::Unsupported("size and rate past HEVC level 6.2".into()))?;
    let ptl = hevc::ProfileTierLevel::progressive(hevc::profile::MAIN, level);
    let vui = hevc::Vui {
        signal: Some(VideoSignal::bt709_limited()),
        timing: Some(hevc::Timing {
            num_units_in_tick: 1,
            time_scale: spec.fps,
            num_ticks_poc_diff_one_minus1: None,
        }),
        ..Default::default()
    };
    let mut sps = hevc::Sps::progressive(
        ptl.clone(),
        spec.size.width,
        spec.size.height,
        HEVC_ALIGN,
        HEVC_LOG2_CTB,
        1,
        vec![hevc::ShortTermRps::previous_only()],
        Some(vui),
    );
    sps.amp_enabled = false;
    sps.sample_adaptive_offset_enabled = false;
    sps.strong_intra_smoothing_enabled = false;
    sps.max_transform_hierarchy_depth_inter = 2;
    sps.max_transform_hierarchy_depth_intra = 2;
    let mut pps = hevc::Pps::simple(i32::from(initial_qp(spec)));
    pps.loop_filter_across_slices_enabled = true;
    Ok(HevcPlan {
        vps: hevc::Vps::single_layer(ptl, 1),
        sps,
        pps,
    })
}

/// Where one picture sits in its group: frame counters for the headers and VA buffers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Frame {
    pub idr: bool,
    /// Pictures since the last IDR, which is 0: H.265's POC and half of H.264's.
    pub index: u32,
    pub frame_num: u32,
    pub idr_pic_id: u32,
}

/// IPPP sequencing: an IDR first, on request, and at least every `max_interval` pictures.
#[derive(Clone, Debug)]
pub struct Gop {
    max_interval: u32,
    max_frame_num: u32,
    next_index: Option<u32>,
    idr_count: u32,
}

impl Gop {
    pub fn new(max_interval: u32, log2_max_frame_num: u32) -> Self {
        Self {
            max_interval: max_interval.max(1),
            max_frame_num: 1 << log2_max_frame_num,
            next_index: None,
            idr_count: 0,
        }
    }

    /// The next picture's place; `force_key` makes it an IDR.
    pub fn next(&mut self, force_key: bool) -> Frame {
        let index = match self.next_index {
            Some(i) if !force_key && i < self.max_interval => i,
            _ => 0,
        };
        let idr = index == 0;
        if idr && self.next_index.is_some() {
            self.idr_count = self.idr_count.wrapping_add(1);
        }
        self.next_index = Some(index + 1);
        Frame {
            idr,
            index,
            frame_num: index % self.max_frame_num,
            idr_pic_id: self.idr_count % 65_536,
        }
    }

    /// The next picture must be an IDR (after a failed submission or a new stream).
    pub fn restart(&mut self) {
        self.next_index = None;
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use media_codec::{Codec, Size};

    fn spec(width: u32, height: u32, rate: RateControl) -> EncodeSpec {
        EncodeSpec {
            codec: Codec::H264,
            size: Size { width, height },
            fps: 60,
            rate,
        }
    }

    #[test]
    fn h264_headers_describe_the_exact_picture_and_low_delay_output() {
        let plan = h264_plan(
            &spec(1206, 2622, RateControl::Bitrate(8_000_000)),
            profile::H264_HIGH,
        )
        .unwrap();
        assert_eq!(plan.sps.frame_size(), (1206, 2622));
        assert_eq!((plan.sps.profile_idc, plan.sps.level_idc), (100, 51));
        let vui = plan.sps.vui.unwrap();
        assert_eq!(vui.restriction.unwrap().max_num_reorder_frames, 0);
        assert_eq!(vui.timing.unwrap().time_scale, 120);
        assert!(plan.pps.entropy_coding_mode);
        assert!(plan.pps.high.is_some());
    }

    #[test]
    fn baseline_uses_cavlc_and_a_quantizer_session_starts_at_its_qp() {
        let plan = h264_plan(
            &spec(1280, 720, RateControl::Quantizer(34)),
            profile::H264_CONSTRAINED_BASELINE,
        )
        .unwrap();
        assert_eq!(
            (plan.sps.profile_idc, plan.sps.constraint_flags),
            (66, 0xc0)
        );
        assert!(!plan.pps.entropy_coding_mode);
        assert_eq!(plan.pps.pic_init_qp_minus26, 8);
    }

    #[test]
    fn hevc_headers_pad_to_the_coding_block_and_crop_back() {
        let plan = hevc_plan(&spec(1206, 2622, RateControl::Bitrate(8_000_000))).unwrap();
        assert_eq!(plan.sps.frame_size(), (1206, 2622));
        assert_eq!(plan.sps.pic_width_in_luma_samples, 1216);
        assert_eq!(plan.sps.pic_height_in_luma_samples, 2624);
        assert_eq!(plan.sps.log2_ctb_size(), 6);
        assert_eq!(plan.sps.ptl.level_idc, 150);
    }

    #[test]
    fn invalid_specs_are_refused_before_any_driver_call() {
        assert!(
            h264_plan(
                &spec(1205, 720, RateControl::Bitrate(1)),
                profile::H264_HIGH
            )
            .is_err()
        );
        assert!(hevc_plan(&spec(1280, 720, RateControl::Quantizer(10))).is_err());
    }

    #[test]
    fn the_group_starts_with_an_idr_and_restarts_on_request() {
        let mut gop = Gop::new(1200, 8);
        let first = gop.next(false);
        assert!(first.idr);
        assert_eq!(first.idr_pic_id, 0);
        let p = gop.next(false);
        assert_eq!((p.idr, p.index, p.frame_num), (false, 1, 1));
        let key = gop.next(true);
        assert_eq!((key.idr, key.index, key.idr_pic_id), (true, 0, 1));
        gop.restart();
        assert!(gop.next(false).idr);
    }

    #[test]
    fn frame_num_wraps_and_a_long_group_ends_in_an_idr() {
        let mut gop = Gop::new(300, 8);
        let frames: Vec<Frame> = (0..301).map(|_| gop.next(false)).collect();
        assert_eq!(frames[256].frame_num, 0);
        assert!(!frames[256].idr);
        assert_eq!(frames[299].index, 299);
        assert!(frames[300].idr);
    }
}
