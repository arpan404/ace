// SPDX-License-Identifier: Apache-2.0
//! `seq_parameter_set_rbsp()` (H.264 §7.3.2.1.1).
use super::{Vui, has_chroma_info};
use crate::nal::h264::{SPS, header};
use crate::{BitReader, BitWriter, BitstreamError, nal_unit, rbsp_of};

/// The High-profile fields: chroma format, bit depths and transform bypass.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChromaInfo {
    pub chroma_format_idc: u32,
    pub separate_colour_plane: bool,
    pub bit_depth_luma_minus8: u32,
    pub bit_depth_chroma_minus8: u32,
    pub qpprime_y_zero_transform_bypass: bool,
}

impl ChromaInfo {
    pub const YUV420_8BIT: Self = Self {
        chroma_format_idc: 1,
        separate_colour_plane: false,
        bit_depth_luma_minus8: 0,
        bit_depth_chroma_minus8: 0,
        qpprime_y_zero_transform_bypass: false,
    };
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PocType {
    Zero {
        log2_max_pic_order_cnt_lsb_minus4: u32,
    },
    One {
        delta_pic_order_always_zero: bool,
        offset_for_non_ref_pic: i32,
        offset_for_top_to_bottom_field: i32,
        offset_for_ref_frame: Vec<i32>,
    },
    Two,
}

/// Frame cropping offsets, in crop units (2 luma samples each way for 4:2:0 frames).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Crop {
    pub left: u32,
    pub right: u32,
    pub top: u32,
    pub bottom: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Sps {
    pub profile_idc: u8,
    /// `constraint_set0_flag` … `constraint_set5_flag` and `reserved_zero_2bits`, as coded.
    pub constraint_flags: u8,
    pub level_idc: u8,
    pub id: u32,
    /// Present exactly when [`has_chroma_info`] holds for the profile.
    pub chroma: Option<ChromaInfo>,
    pub log2_max_frame_num_minus4: u32,
    pub poc: PocType,
    pub max_num_ref_frames: u32,
    pub gaps_in_frame_num_allowed: bool,
    pub pic_width_in_mbs_minus1: u32,
    pub pic_height_in_map_units_minus1: u32,
    pub frame_mbs_only: bool,
    pub mb_adaptive_frame_field: bool,
    pub direct_8x8_inference: bool,
    pub crop: Option<Crop>,
    pub vui: Option<Vui>,
}

impl Sps {
    /// A progressive 4:2:0 8-bit SPS for `width`×`height` (both even), with POC type 2 (no
    /// reordering), cropping to the exact size, and the given VUI.
    pub fn progressive(
        profile_idc: u8,
        constraint_flags: u8,
        level_idc: u8,
        width: u32,
        height: u32,
        max_num_ref_frames: u32,
        vui: Option<Vui>,
    ) -> Self {
        let mbs_w = width.div_ceil(16);
        let mbs_h = height.div_ceil(16);
        let crop = Crop {
            left: 0,
            right: (mbs_w * 16 - width) / 2,
            top: 0,
            bottom: (mbs_h * 16 - height) / 2,
        };
        Self {
            profile_idc,
            constraint_flags,
            level_idc,
            id: 0,
            chroma: has_chroma_info(profile_idc).then_some(ChromaInfo::YUV420_8BIT),
            log2_max_frame_num_minus4: 4,
            poc: PocType::Two,
            max_num_ref_frames,
            gaps_in_frame_num_allowed: false,
            pic_width_in_mbs_minus1: mbs_w - 1,
            pic_height_in_map_units_minus1: mbs_h - 1,
            frame_mbs_only: true,
            mb_adaptive_frame_field: false,
            direct_8x8_inference: true,
            crop: (crop != Crop::default()).then_some(crop),
            vui,
        }
    }

    pub fn chroma_format_idc(&self) -> u32 {
        self.chroma.map_or(1, |c| c.chroma_format_idc)
    }

    pub fn log2_max_frame_num(&self) -> u32 {
        self.log2_max_frame_num_minus4 + 4
    }

    /// The displayed size: macroblocks minus the cropping window (§7.4.2.1.1).
    pub fn frame_size(&self) -> (u32, u32) {
        let map_units = if self.frame_mbs_only { 1 } else { 2 };
        let w = (self.pic_width_in_mbs_minus1 + 1) * 16;
        let h = (self.pic_height_in_map_units_minus1 + 1) * 16 * map_units;
        let (sub_w, sub_h) = match self.chroma_format_idc() {
            1 => (2, 2),
            2 => (2, 1),
            _ => (1, 1),
        };
        let separate = self.chroma.is_some_and(|c| c.separate_colour_plane);
        let (unit_x, unit_y) = if self.chroma_format_idc() == 0 || separate {
            (1, 2 - u32::from(self.frame_mbs_only))
        } else {
            (sub_w, sub_h * (2 - u32::from(self.frame_mbs_only)))
        };
        let c = self.crop.unwrap_or_default();
        (
            w.saturating_sub(unit_x * (c.left + c.right)),
            h.saturating_sub(unit_y * (c.top + c.bottom)),
        )
    }

    /// Parses a whole SPS NAL unit (header byte included, no start code).
    pub fn parse(nal: &[u8]) -> Result<Self, BitstreamError> {
        if crate::nal::h264::unit_type(nal) != Some(SPS) {
            return Err(BitstreamError::Invalid("not an SPS"));
        }
        Self::read(&mut BitReader::new(&rbsp_of(nal, 1)?))
    }

    fn read(r: &mut BitReader<'_>) -> Result<Self, BitstreamError> {
        let profile_idc = r.u8(8)?;
        let constraint_flags = r.u8(8)?;
        let level_idc = r.u8(8)?;
        let id = r.ue_max(31, "seq_parameter_set_id")?;
        let chroma = if has_chroma_info(profile_idc) {
            let chroma_format_idc = r.ue_max(3, "chroma_format_idc")?;
            let separate_colour_plane = chroma_format_idc == 3 && r.flag()?;
            let info = ChromaInfo {
                chroma_format_idc,
                separate_colour_plane,
                bit_depth_luma_minus8: r.ue_max(6, "bit_depth_luma_minus8")?,
                bit_depth_chroma_minus8: r.ue_max(6, "bit_depth_chroma_minus8")?,
                qpprime_y_zero_transform_bypass: r.flag()?,
            };
            if r.flag()? {
                return Err(BitstreamError::Unsupported("SPS scaling matrices"));
            }
            Some(info)
        } else {
            None
        };
        let log2_max_frame_num_minus4 = r.ue_max(12, "log2_max_frame_num_minus4")?;
        let poc = match r.ue_max(2, "pic_order_cnt_type")? {
            0 => PocType::Zero {
                log2_max_pic_order_cnt_lsb_minus4: r.ue_max(12, "log2_max_poc_lsb")?,
            },
            1 => {
                let delta_pic_order_always_zero = r.flag()?;
                let offset_for_non_ref_pic = r.se()?;
                let offset_for_top_to_bottom_field = r.se()?;
                let count = r.ue_max(255, "num_ref_frames_in_pic_order_cnt_cycle")?;
                let offset_for_ref_frame = (0..count).map(|_| r.se()).collect::<Result<_, _>>()?;
                PocType::One {
                    delta_pic_order_always_zero,
                    offset_for_non_ref_pic,
                    offset_for_top_to_bottom_field,
                    offset_for_ref_frame,
                }
            }
            _ => PocType::Two,
        };
        let max_num_ref_frames = r.ue_max(16, "max_num_ref_frames")?;
        let gaps_in_frame_num_allowed = r.flag()?;
        let pic_width_in_mbs_minus1 = r.ue_max(1023, "pic_width_in_mbs_minus1")?;
        let pic_height_in_map_units_minus1 = r.ue_max(1023, "pic_height_in_map_units_minus1")?;
        let frame_mbs_only = r.flag()?;
        let mb_adaptive_frame_field = !frame_mbs_only && r.flag()?;
        let direct_8x8_inference = r.flag()?;
        let crop = if r.flag()? {
            Some(Crop {
                left: r.ue()?,
                right: r.ue()?,
                top: r.ue()?,
                bottom: r.ue()?,
            })
        } else {
            None
        };
        let vui = if r.flag()? { Some(Vui::read(r)?) } else { None };
        r.trailing()?;
        Ok(Self {
            profile_idc,
            constraint_flags,
            level_idc,
            id,
            chroma,
            log2_max_frame_num_minus4,
            poc,
            max_num_ref_frames,
            gaps_in_frame_num_allowed,
            pic_width_in_mbs_minus1,
            pic_height_in_map_units_minus1,
            frame_mbs_only,
            mb_adaptive_frame_field,
            direct_8x8_inference,
            crop,
            vui,
        })
    }

    pub fn rbsp(&self) -> Vec<u8> {
        let mut w = BitWriter::new();
        w.bits(u32::from(self.profile_idc), 8);
        w.bits(u32::from(self.constraint_flags), 8);
        w.bits(u32::from(self.level_idc), 8);
        w.ue(self.id);
        if has_chroma_info(self.profile_idc) {
            let c = self.chroma.unwrap_or(ChromaInfo::YUV420_8BIT);
            w.ue(c.chroma_format_idc);
            if c.chroma_format_idc == 3 {
                w.bit(c.separate_colour_plane);
            }
            w.ue(c.bit_depth_luma_minus8);
            w.ue(c.bit_depth_chroma_minus8);
            w.bit(c.qpprime_y_zero_transform_bypass);
            w.bit(false); // seq_scaling_matrix_present_flag
        }
        w.ue(self.log2_max_frame_num_minus4);
        match &self.poc {
            PocType::Zero {
                log2_max_pic_order_cnt_lsb_minus4,
            } => {
                w.ue(0);
                w.ue(*log2_max_pic_order_cnt_lsb_minus4);
            }
            PocType::One {
                delta_pic_order_always_zero,
                offset_for_non_ref_pic,
                offset_for_top_to_bottom_field,
                offset_for_ref_frame,
            } => {
                w.ue(1);
                w.bit(*delta_pic_order_always_zero);
                w.se(*offset_for_non_ref_pic);
                w.se(*offset_for_top_to_bottom_field);
                w.ue(offset_for_ref_frame.len() as u32);
                for offset in offset_for_ref_frame {
                    w.se(*offset);
                }
            }
            PocType::Two => w.ue(2),
        }
        w.ue(self.max_num_ref_frames);
        w.bit(self.gaps_in_frame_num_allowed);
        w.ue(self.pic_width_in_mbs_minus1);
        w.ue(self.pic_height_in_map_units_minus1);
        w.bit(self.frame_mbs_only);
        if !self.frame_mbs_only {
            w.bit(self.mb_adaptive_frame_field);
        }
        w.bit(self.direct_8x8_inference);
        w.bit(self.crop.is_some());
        if let Some(c) = self.crop {
            w.ue(c.left);
            w.ue(c.right);
            w.ue(c.top);
            w.ue(c.bottom);
        }
        w.bit(self.vui.is_some());
        if let Some(vui) = &self.vui {
            vui.write(&mut w);
        }
        w.trailing();
        w.into_bytes()
    }

    /// The NAL unit (no start code), `nal_ref_idc` 3.
    pub fn to_nal(&self) -> Vec<u8> {
        nal_unit(&[header(3, SPS)], &self.rbsp())
    }
}
