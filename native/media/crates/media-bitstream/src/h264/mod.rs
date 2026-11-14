// SPDX-License-Identifier: Apache-2.0
//! H.264 parameter sets (§7.3.2.1.1, §7.3.2.2), VUI (Annex E.1) and slice headers (§7.3.3).
mod pps;
mod slice;
mod sps;
mod vui;

pub use pps::{Pps, PpsHigh};
pub use slice::{MemoryOp, RefMarking, RefModification, SliceHeader, SliceType};
pub use sps::{ChromaInfo, Crop, PocType, Sps};
pub use vui::{Hrd, HrdCpb, Restriction, Timing, Vui};

/// `profile_idc` values (Annex A).
pub mod profile {
    pub const BASELINE: u8 = 66;
    pub const MAIN: u8 = 77;
    pub const HIGH: u8 = 100;
}

/// Profiles whose SPS carries `chroma_format_idc` and bit depths (§7.3.2.1.1).
pub fn has_chroma_info(profile_idc: u8) -> bool {
    matches!(
        profile_idc,
        100 | 110 | 122 | 244 | 44 | 83 | 86 | 118 | 128 | 138 | 139 | 134 | 135
    )
}
