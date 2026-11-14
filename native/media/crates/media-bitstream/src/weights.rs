// SPDX-License-Identifier: Apache-2.0
//! `pred_weight_table()`: H.264 §7.3.3.2 and H.265 §7.3.6.3.
use crate::{BitReader, BitWriter, BitstreamError};

/// One reference's explicit weights: `(weight, offset)` for luma and for Cb and Cr, as coded
/// (H.265 codes chroma offsets and all weights as deltas).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Weight {
    pub luma: Option<(i32, i32)>,
    pub chroma: Option<[(i32, i32); 2]>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PredWeightTable {
    pub luma_log2_weight_denom: u32,
    /// H.264 `chroma_log2_weight_denom`, H.265 `delta_chroma_log2_weight_denom`.
    pub chroma_denom: i32,
    pub l0: Vec<Weight>,
    pub l1: Vec<Weight>,
}

fn read_pair(r: &mut BitReader<'_>) -> Result<(i32, i32), BitstreamError> {
    Ok((r.se()?, r.se()?))
}

fn write_pair(w: &mut BitWriter, (a, b): (i32, i32)) {
    w.se(a);
    w.se(b);
}

impl PredWeightTable {
    /// H.264: flags and values interleaved per reference.
    pub(crate) fn read_h264(
        r: &mut BitReader<'_>,
        chroma: bool,
        l0_count: u32,
        l1_count: u32,
    ) -> Result<Self, BitstreamError> {
        let luma_log2_weight_denom = r.ue_max(7, "luma_log2_weight_denom")?;
        let chroma_denom = if chroma {
            r.ue_max(7, "chroma_log2_weight_denom")? as i32
        } else {
            0
        };
        let mut list = |count: u32| -> Result<Vec<Weight>, BitstreamError> {
            (0..count)
                .map(|_| {
                    let luma = if r.flag()? { Some(read_pair(r)?) } else { None };
                    let chroma = if chroma && r.flag()? {
                        Some([read_pair(r)?, read_pair(r)?])
                    } else {
                        None
                    };
                    Ok(Weight { luma, chroma })
                })
                .collect()
        };
        let l0 = list(l0_count)?;
        let l1 = list(l1_count)?;
        Ok(Self {
            luma_log2_weight_denom,
            chroma_denom,
            l0,
            l1,
        })
    }

    pub(crate) fn write_h264(&self, w: &mut BitWriter, chroma: bool) {
        w.ue(self.luma_log2_weight_denom);
        if chroma {
            w.ue(self.chroma_denom.max(0) as u32);
        }
        for entry in self.l0.iter().chain(&self.l1) {
            w.bit(entry.luma.is_some());
            if let Some(p) = entry.luma {
                write_pair(w, p);
            }
            if chroma {
                w.bit(entry.chroma.is_some());
                if let Some([cb, cr]) = entry.chroma {
                    write_pair(w, cb);
                    write_pair(w, cr);
                }
            }
        }
    }

    /// H.265: every luma flag, then every chroma flag, then the values, per list. Every
    /// reference of a single-layer stream has a POC other than the current picture's, so
    /// each flag is coded.
    pub(crate) fn read_hevc(
        r: &mut BitReader<'_>,
        chroma: bool,
        l0_count: u32,
        l1_count: u32,
    ) -> Result<Self, BitstreamError> {
        let luma_log2_weight_denom = r.ue_max(7, "luma_log2_weight_denom")?;
        let chroma_denom = if chroma { r.se()? } else { 0 };
        let mut list = |count: u32| -> Result<Vec<Weight>, BitstreamError> {
            let luma_flags = (0..count)
                .map(|_| r.flag())
                .collect::<Result<Vec<_>, _>>()?;
            let chroma_flags = if chroma {
                (0..count)
                    .map(|_| r.flag())
                    .collect::<Result<Vec<_>, _>>()?
            } else {
                vec![false; count as usize]
            };
            let mut out = Vec::with_capacity(count as usize);
            for (l, c) in luma_flags.into_iter().zip(chroma_flags) {
                let luma = if l { Some(read_pair(r)?) } else { None };
                let chroma = if c {
                    Some([read_pair(r)?, read_pair(r)?])
                } else {
                    None
                };
                out.push(Weight { luma, chroma });
            }
            Ok(out)
        };
        let l0 = list(l0_count)?;
        let l1 = list(l1_count)?;
        Ok(Self {
            luma_log2_weight_denom,
            chroma_denom,
            l0,
            l1,
        })
    }

    pub(crate) fn write_hevc(&self, w: &mut BitWriter, chroma: bool) {
        w.ue(self.luma_log2_weight_denom);
        if chroma {
            w.se(self.chroma_denom);
        }
        for list in [&self.l0, &self.l1] {
            for entry in list {
                w.bit(entry.luma.is_some());
            }
            if chroma {
                for entry in list {
                    w.bit(entry.chroma.is_some());
                }
            }
            for entry in list {
                if let Some(p) = entry.luma {
                    write_pair(w, p);
                }
                if let Some([cb, cr]) = entry.chroma.filter(|_| chroma) {
                    write_pair(w, cb);
                    write_pair(w, cr);
                }
            }
        }
    }
}
