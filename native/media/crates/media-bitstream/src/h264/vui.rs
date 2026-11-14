// SPDX-License-Identifier: Apache-2.0
//! H.264 VUI parameters (E.1.1) and HRD parameters (E.1.2).
use crate::vui::{
    read_aspect, read_optional_flag, read_pair, read_signal, write_aspect, write_optional_flag,
    write_pair, write_signal,
};
use crate::{AspectRatio, BitReader, BitWriter, BitstreamError, VideoSignal};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Timing {
    pub num_units_in_tick: u32,
    pub time_scale: u32,
    pub fixed_frame_rate: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HrdCpb {
    pub bit_rate_value_minus1: u32,
    pub cpb_size_value_minus1: u32,
    pub cbr: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Hrd {
    pub bit_rate_scale: u8,
    pub cpb_size_scale: u8,
    pub cpbs: Vec<HrdCpb>,
    pub initial_cpb_removal_delay_length_minus1: u8,
    pub cpb_removal_delay_length_minus1: u8,
    pub dpb_output_delay_length_minus1: u8,
    pub time_offset_length: u8,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Restriction {
    pub motion_vectors_over_pic_boundaries: bool,
    pub max_bytes_per_pic_denom: u32,
    pub max_bits_per_mb_denom: u32,
    pub log2_max_mv_length_horizontal: u32,
    pub log2_max_mv_length_vertical: u32,
    pub max_num_reorder_frames: u32,
    pub max_dec_frame_buffering: u32,
}

impl Restriction {
    /// No reordering and the given decoded picture buffer: lets decoders output at once.
    pub fn low_delay(max_dec_frame_buffering: u32) -> Self {
        Self {
            motion_vectors_over_pic_boundaries: true,
            max_bytes_per_pic_denom: 2,
            max_bits_per_mb_denom: 1,
            log2_max_mv_length_horizontal: 16,
            log2_max_mv_length_vertical: 16,
            max_num_reorder_frames: 0,
            max_dec_frame_buffering,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Vui {
    pub aspect_ratio: Option<AspectRatio>,
    pub overscan_appropriate: Option<bool>,
    pub signal: Option<VideoSignal>,
    pub chroma_loc: Option<(u32, u32)>,
    pub timing: Option<Timing>,
    pub nal_hrd: Option<Hrd>,
    pub vcl_hrd: Option<Hrd>,
    /// Coded only when either HRD is present.
    pub low_delay_hrd: bool,
    pub pic_struct_present: bool,
    pub restriction: Option<Restriction>,
}

fn read_hrd(r: &mut BitReader<'_>) -> Result<Hrd, BitstreamError> {
    let count = r.ue_max(31, "cpb_cnt_minus1")? + 1;
    let bit_rate_scale = r.u8(4)?;
    let cpb_size_scale = r.u8(4)?;
    let mut cpbs = Vec::with_capacity(count as usize);
    for _ in 0..count {
        cpbs.push(HrdCpb {
            bit_rate_value_minus1: r.ue()?,
            cpb_size_value_minus1: r.ue()?,
            cbr: r.flag()?,
        });
    }
    Ok(Hrd {
        bit_rate_scale,
        cpb_size_scale,
        cpbs,
        initial_cpb_removal_delay_length_minus1: r.u8(5)?,
        cpb_removal_delay_length_minus1: r.u8(5)?,
        dpb_output_delay_length_minus1: r.u8(5)?,
        time_offset_length: r.u8(5)?,
    })
}

fn write_hrd(w: &mut BitWriter, hrd: &Hrd) {
    w.ue(hrd.cpbs.len().saturating_sub(1) as u32);
    w.bits(u32::from(hrd.bit_rate_scale), 4);
    w.bits(u32::from(hrd.cpb_size_scale), 4);
    for cpb in &hrd.cpbs {
        w.ue(cpb.bit_rate_value_minus1);
        w.ue(cpb.cpb_size_value_minus1);
        w.bit(cpb.cbr);
    }
    w.bits(u32::from(hrd.initial_cpb_removal_delay_length_minus1), 5);
    w.bits(u32::from(hrd.cpb_removal_delay_length_minus1), 5);
    w.bits(u32::from(hrd.dpb_output_delay_length_minus1), 5);
    w.bits(u32::from(hrd.time_offset_length), 5);
}

fn read_optional_hrd(r: &mut BitReader<'_>) -> Result<Option<Hrd>, BitstreamError> {
    Ok(if r.flag()? { Some(read_hrd(r)?) } else { None })
}

fn write_optional_hrd(w: &mut BitWriter, hrd: Option<&Hrd>) {
    w.bit(hrd.is_some());
    if let Some(h) = hrd {
        write_hrd(w, h);
    }
}

impl Vui {
    pub(crate) fn read(r: &mut BitReader<'_>) -> Result<Self, BitstreamError> {
        let aspect_ratio = read_aspect(r)?;
        let overscan_appropriate = read_optional_flag(r)?;
        let signal = read_signal(r)?;
        let chroma_loc = read_pair(r)?;
        let timing = if r.flag()? {
            Some(Timing {
                num_units_in_tick: r.bits(32)?,
                time_scale: r.bits(32)?,
                fixed_frame_rate: r.flag()?,
            })
        } else {
            None
        };
        let nal_hrd = read_optional_hrd(r)?;
        let vcl_hrd = read_optional_hrd(r)?;
        let low_delay_hrd = if nal_hrd.is_some() || vcl_hrd.is_some() {
            r.flag()?
        } else {
            false
        };
        let pic_struct_present = r.flag()?;
        let restriction = if r.flag()? {
            Some(Restriction {
                motion_vectors_over_pic_boundaries: r.flag()?,
                max_bytes_per_pic_denom: r.ue()?,
                max_bits_per_mb_denom: r.ue()?,
                log2_max_mv_length_horizontal: r.ue()?,
                log2_max_mv_length_vertical: r.ue()?,
                max_num_reorder_frames: r.ue()?,
                max_dec_frame_buffering: r.ue()?,
            })
        } else {
            None
        };
        Ok(Self {
            aspect_ratio,
            overscan_appropriate,
            signal,
            chroma_loc,
            timing,
            nal_hrd,
            vcl_hrd,
            low_delay_hrd,
            pic_struct_present,
            restriction,
        })
    }

    pub(crate) fn write(&self, w: &mut BitWriter) {
        write_aspect(w, self.aspect_ratio);
        write_optional_flag(w, self.overscan_appropriate);
        write_signal(w, self.signal);
        write_pair(w, self.chroma_loc);
        w.bit(self.timing.is_some());
        if let Some(t) = self.timing {
            w.bits(t.num_units_in_tick, 32);
            w.bits(t.time_scale, 32);
            w.bit(t.fixed_frame_rate);
        }
        write_optional_hrd(w, self.nal_hrd.as_ref());
        write_optional_hrd(w, self.vcl_hrd.as_ref());
        if self.nal_hrd.is_some() || self.vcl_hrd.is_some() {
            w.bit(self.low_delay_hrd);
        }
        w.bit(self.pic_struct_present);
        w.bit(self.restriction.is_some());
        if let Some(b) = self.restriction {
            w.bit(b.motion_vectors_over_pic_boundaries);
            w.ue(b.max_bytes_per_pic_denom);
            w.ue(b.max_bits_per_mb_denom);
            w.ue(b.log2_max_mv_length_horizontal);
            w.ue(b.log2_max_mv_length_vertical);
            w.ue(b.max_num_reorder_frames);
            w.ue(b.max_dec_frame_buffering);
        }
    }
}
