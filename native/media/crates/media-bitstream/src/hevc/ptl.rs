// SPDX-License-Identifier: Apache-2.0
//! `profile_tier_level(1, maxNumSubLayersMinus1)` (H.265 §7.3.3).
use crate::{BitReader, BitWriter, BitstreamError};

/// A sub-layer's optional profile (the 88 profile bits, as coded) and level.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SubLayer {
    pub profile: Option<[u8; 11]>,
    pub level_idc: Option<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProfileTierLevel {
    pub profile_space: u8,
    pub tier: bool,
    pub profile_idc: u8,
    pub compatibility_flags: u32,
    /// progressive, interlaced, non-packed and frame-only flags, then the 44 constraint and
    /// reserved bits: 48 bits, as coded.
    pub constraint_flags: u64,
    pub level_idc: u8,
    pub sub_layers: Vec<SubLayer>,
}

impl ProfileTierLevel {
    /// Main tier, progressive frame-only content of `profile_idc`, `level_idc` = 30 × level.
    pub fn progressive(profile_idc: u8, level_idc: u8) -> Self {
        Self {
            profile_space: 0,
            tier: false,
            profile_idc,
            // A Main stream is also Main 10 compatible (A.3.2).
            compatibility_flags: (1 << (31 - profile_idc))
                | if profile_idc == 1 { 1 << 29 } else { 0 },
            // progressive_source, non_packed_constraint and frame_only_constraint flags.
            constraint_flags: (1 << 47) | (1 << 45) | (1 << 44),
            level_idc,
            sub_layers: Vec::new(),
        }
    }

    pub(crate) fn read(
        r: &mut BitReader<'_>,
        max_sub_layers_minus1: u8,
    ) -> Result<Self, BitstreamError> {
        let profile_space = r.u8(2)?;
        let tier = r.flag()?;
        let profile_idc = r.u8(5)?;
        let compatibility_flags = r.bits(32)?;
        let constraint_flags = (u64::from(r.bits(24)?) << 24) | u64::from(r.bits(24)?);
        let level_idc = r.u8(8)?;
        let mut present = Vec::new();
        for _ in 0..max_sub_layers_minus1 {
            present.push((r.flag()?, r.flag()?));
        }
        if max_sub_layers_minus1 > 0 {
            for _ in max_sub_layers_minus1..8 {
                r.bits(2)?; // reserved_zero_2bits
            }
        }
        let mut sub_layers = Vec::new();
        for (profile_present, level_present) in present {
            let mut layer = SubLayer::default();
            if profile_present {
                let mut bytes = [0u8; 11];
                for b in &mut bytes {
                    *b = r.u8(8)?;
                }
                layer.profile = Some(bytes);
            }
            if level_present {
                layer.level_idc = Some(r.u8(8)?);
            }
            sub_layers.push(layer);
        }
        Ok(Self {
            profile_space,
            tier,
            profile_idc,
            compatibility_flags,
            constraint_flags,
            level_idc,
            sub_layers,
        })
    }

    /// Writes with `sub_layers.len()` as maxNumSubLayersMinus1.
    pub(crate) fn write(&self, w: &mut BitWriter) {
        w.bits(u32::from(self.profile_space), 2);
        w.bit(self.tier);
        w.bits(u32::from(self.profile_idc), 5);
        w.bits(self.compatibility_flags, 32);
        w.bits((self.constraint_flags >> 24) as u32 & 0xff_ffff, 24);
        w.bits(self.constraint_flags as u32 & 0xff_ffff, 24);
        w.bits(u32::from(self.level_idc), 8);
        for layer in &self.sub_layers {
            w.bit(layer.profile.is_some());
            w.bit(layer.level_idc.is_some());
        }
        if !self.sub_layers.is_empty() {
            for _ in self.sub_layers.len()..8 {
                w.bits(0, 2);
            }
        }
        for layer in &self.sub_layers {
            if let Some(bytes) = layer.profile {
                for b in bytes {
                    w.bits(u32::from(b), 8);
                }
            }
            if let Some(level) = layer.level_idc {
                w.bits(u32::from(level), 8);
            }
        }
    }

    /// The 12 bytes `hvcC` repeats: space, tier, profile, compatibility, constraints, level.
    pub fn general_bytes(&self) -> [u8; 12] {
        let mut w = BitWriter::new();
        w.bits(u32::from(self.profile_space), 2);
        w.bit(self.tier);
        w.bits(u32::from(self.profile_idc), 5);
        w.bits(self.compatibility_flags, 32);
        w.bits((self.constraint_flags >> 24) as u32 & 0xff_ffff, 24);
        w.bits(self.constraint_flags as u32 & 0xff_ffff, 24);
        w.bits(u32::from(self.level_idc), 8);
        let bytes = w.into_bytes();
        let mut out = [0u8; 12];
        out.copy_from_slice(&bytes[..12]);
        out
    }
}
