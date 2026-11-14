// SPDX-License-Identifier: Apache-2.0
//! VUI fields shared by H.264 Annex E.1.1 and H.265 Annex E.2.1.
use crate::{BitReader, BitWriter, BitstreamError};

/// `aspect_ratio_idc`, with the sample aspect ratio when it is 255 (`Extended_SAR`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AspectRatio {
    pub idc: u8,
    pub sar: Option<(u16, u16)>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Colour {
    pub primaries: u8,
    pub transfer: u8,
    pub matrix: u8,
}

/// `video_signal_type`: format, range and the optional colour description.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct VideoSignal {
    pub format: u8,
    pub full_range: bool,
    pub colour: Option<Colour>,
}

impl VideoSignal {
    /// Rec. 709 primaries, transfer and matrix, limited range: what ace's encoders emit.
    pub fn bt709_limited() -> Self {
        Self {
            format: 5,
            full_range: false,
            colour: Some(Colour {
                primaries: 1,
                transfer: 1,
                matrix: 1,
            }),
        }
    }
}

const EXTENDED_SAR: u8 = 255;

pub(crate) fn read_aspect(r: &mut BitReader<'_>) -> Result<Option<AspectRatio>, BitstreamError> {
    if !r.flag()? {
        return Ok(None);
    }
    let idc = r.u8(8)?;
    let sar = if idc == EXTENDED_SAR {
        Some((r.bits(16)? as u16, r.bits(16)? as u16))
    } else {
        None
    };
    Ok(Some(AspectRatio { idc, sar }))
}

pub(crate) fn write_aspect(w: &mut BitWriter, aspect: Option<AspectRatio>) {
    w.bit(aspect.is_some());
    if let Some(a) = aspect {
        w.bits(u32::from(a.idc), 8);
        if a.idc == EXTENDED_SAR {
            let (sw, sh) = a.sar.unwrap_or((1, 1));
            w.bits(u32::from(sw), 16);
            w.bits(u32::from(sh), 16);
        }
    }
}

pub(crate) fn read_optional_flag(r: &mut BitReader<'_>) -> Result<Option<bool>, BitstreamError> {
    Ok(if r.flag()? { Some(r.flag()?) } else { None })
}

pub(crate) fn write_optional_flag(w: &mut BitWriter, value: Option<bool>) {
    w.bit(value.is_some());
    if let Some(v) = value {
        w.bit(v);
    }
}

pub(crate) fn read_signal(r: &mut BitReader<'_>) -> Result<Option<VideoSignal>, BitstreamError> {
    if !r.flag()? {
        return Ok(None);
    }
    let format = r.u8(3)?;
    let full_range = r.flag()?;
    let colour = if r.flag()? {
        Some(Colour {
            primaries: r.u8(8)?,
            transfer: r.u8(8)?,
            matrix: r.u8(8)?,
        })
    } else {
        None
    };
    Ok(Some(VideoSignal {
        format,
        full_range,
        colour,
    }))
}

pub(crate) fn write_signal(w: &mut BitWriter, signal: Option<VideoSignal>) {
    w.bit(signal.is_some());
    if let Some(s) = signal {
        w.bits(u32::from(s.format), 3);
        w.bit(s.full_range);
        w.bit(s.colour.is_some());
        if let Some(c) = s.colour {
            w.bits(u32::from(c.primaries), 8);
            w.bits(u32::from(c.transfer), 8);
            w.bits(u32::from(c.matrix), 8);
        }
    }
}

pub(crate) fn read_pair(r: &mut BitReader<'_>) -> Result<Option<(u32, u32)>, BitstreamError> {
    Ok(if r.flag()? {
        Some((r.ue()?, r.ue()?))
    } else {
        None
    })
}

pub(crate) fn write_pair(w: &mut BitWriter, pair: Option<(u32, u32)>) {
    w.bit(pair.is_some());
    if let Some((a, b)) = pair {
        w.ue(a);
        w.ue(b);
    }
}
