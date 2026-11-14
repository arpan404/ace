// SPDX-License-Identifier: Apache-2.0
//! H.265 parameter sets (§7.3.2.1–§7.3.2.3), profile/tier/level (§7.3.3), VUI (Annex E.2)
//! and slice segment headers (§7.3.6.1).
mod pps;
mod ptl;
mod slice;
mod sps;
mod vps;
mod vui;

pub use pps::Pps;
pub use ptl::{ProfileTierLevel, SubLayer};
pub use slice::{RpsChoice, SliceSegmentHeader, SliceType};
pub use sps::{Conformance, ShortTermRps, Sps};
pub use vps::Vps;
pub use vui::{Restriction, Timing, Vui};

/// `max_dec_pic_buffering_minus1`, `max_num_reorder_pics`, `max_latency_increase_plus1`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SubLayerOrdering {
    pub max_dec_pic_buffering_minus1: u32,
    pub max_num_reorder_pics: u32,
    pub max_latency_increase_plus1: u32,
}

pub(crate) fn read_ordering(
    r: &mut crate::BitReader<'_>,
    max_sub_layers_minus1: u8,
) -> Result<(bool, Vec<SubLayerOrdering>), crate::BitstreamError> {
    let present = r.flag()?;
    let count = if present {
        max_sub_layers_minus1 + 1
    } else {
        1
    };
    let mut list = Vec::with_capacity(usize::from(count));
    for _ in 0..count {
        list.push(SubLayerOrdering {
            max_dec_pic_buffering_minus1: r.ue_max(15, "max_dec_pic_buffering_minus1")?,
            max_num_reorder_pics: r.ue_max(15, "max_num_reorder_pics")?,
            max_latency_increase_plus1: r.ue()?,
        });
    }
    Ok((present, list))
}

pub(crate) fn write_ordering(w: &mut crate::BitWriter, present: bool, list: &[SubLayerOrdering]) {
    w.bit(present);
    let count = if present {
        list.len()
    } else {
        list.len().min(1)
    };
    for o in &list[..count] {
        w.ue(o.max_dec_pic_buffering_minus1);
        w.ue(o.max_num_reorder_pics);
        w.ue(o.max_latency_increase_plus1);
    }
}

/// `general_profile_idc` values (Annex A).
pub mod profile {
    pub const MAIN: u8 = 1;
    pub const MAIN_10: u8 = 2;
}
