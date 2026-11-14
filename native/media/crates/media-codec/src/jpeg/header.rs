// SPDX-License-Identifier: Apache-2.0
//! Marker parsing for baseline and extended-sequential Huffman JPEG. Tables
//! live in fixed arrays, so parsing allocates nothing. Anything else
//! (progressive, arithmetic, lossless, 12-bit, CMYK, multi-scan) is
//! `Unsupported`, which callers treat as "use the general decoder".
use crate::{CodecError, Size};
use libjpeg_turbo_rs::common::tables::ZIGZAG_ORDER;

const FAST: u32 = 9;

fn invalid(what: &str) -> CodecError {
    CodecError::InvalidInput(format!("JPEG {what}"))
}
fn unsupported(what: &str) -> CodecError {
    CodecError::Unsupported(format!("JPEG {what}"))
}

/// Canonical Huffman decode table with a 9-bit first-level lookup.
pub(crate) struct HuffDecode {
    /// `len << 8 | symbol`, or zero when the code is longer than FAST bits.
    pub(crate) fast: [u16; 1 << FAST],
    pub(crate) maxcode: [i32; 18],
    pub(crate) offset: [i32; 17],
    pub(crate) values: [u8; 256],
    pub(crate) defined: bool,
}
impl Default for HuffDecode {
    fn default() -> Self {
        Self {
            fast: [0; 1 << FAST],
            maxcode: [-1; 18],
            offset: [0; 17],
            values: [0; 256],
            defined: false,
        }
    }
}
impl HuffDecode {
    fn build(&mut self, counts: &[u8], values: &[u8]) -> Result<(), CodecError> {
        self.fast = [0; 1 << FAST];
        self.maxcode = [-1; 18];
        self.values[..values.len()].copy_from_slice(values);
        let mut code: i32 = 0;
        let mut k: usize = 0;
        for len in 1..=16_usize {
            let n = usize::from(counts[len - 1]);
            self.offset[len] = k as i32 - code;
            for _ in 0..n {
                if code >= 1 << len {
                    return Err(invalid("Huffman table oversubscribed"));
                }
                if len as u32 <= FAST {
                    let base = (code as usize) << (FAST as usize - len);
                    let entry = ((len as u16) << 8) | u16::from(values[k]);
                    for slot in &mut self.fast[base..base + (1 << (FAST as usize - len))] {
                        *slot = entry;
                    }
                }
                code += 1;
                k += 1;
            }
            if n > 0 {
                self.maxcode[len] = code - 1;
            }
            code <<= 1;
        }
        // A sentinel past 16 bits ends the slow search on corrupt data.
        self.maxcode[17] = i32::MAX;
        self.defined = true;
        Ok(())
    }
}

#[derive(Clone, Copy, Default)]
pub(crate) struct Component {
    pub id: u8,
    pub h: usize,
    pub v: usize,
    pub quant: usize,
    pub dc: usize,
    pub ac: usize,
}

pub(crate) struct Tables {
    pub quant: [[u16; 64]; 4],
    pub dc: [HuffDecode; 4],
    pub ac: [HuffDecode; 4],
}
impl Default for Tables {
    fn default() -> Self {
        Self {
            quant: [[1; 64]; 4],
            dc: Default::default(),
            ac: Default::default(),
        }
    }
}

#[derive(Clone, Copy)]
pub(crate) struct Frame {
    pub size: Size,
    /// Components in SOF order, which is also plane order.
    pub components: [Component; 3],
    /// Indices into `components` in SOS order: the order blocks arrive in.
    pub order: [usize; 3],
    pub count: usize,
    pub hmax: usize,
    pub vmax: usize,
    pub restart: usize,
    /// Byte offset of the first entropy-coded byte.
    pub scan: usize,
}

struct Reader<'a> {
    data: &'a [u8],
    pos: usize,
}
impl<'a> Reader<'a> {
    fn segment(&mut self) -> Result<&'a [u8], CodecError> {
        let len = self
            .data
            .get(self.pos..self.pos + 2)
            .map(|b| usize::from(u16::from_be_bytes([b[0], b[1]])))
            .ok_or_else(|| invalid("truncated segment"))?;
        let body = self
            .data
            .get(self.pos + 2..self.pos + len.max(2))
            .ok_or_else(|| invalid("truncated segment"))?;
        self.pos += len.max(2);
        Ok(body)
    }
}

/// Parse up to the first scan. Tables persist in `tables` across calls.
pub(crate) fn parse(jpeg: &[u8], tables: &mut Tables) -> Result<Frame, CodecError> {
    if jpeg.get(..2) != Some(&[0xFF, 0xD8]) {
        return Err(invalid("missing SOI"));
    }
    for t in tables.dc.iter_mut().chain(tables.ac.iter_mut()) {
        t.defined = false;
    }
    let mut quant_defined = [false; 4];
    let mut frame: Option<Frame> = None;
    let mut restart = 0;
    let mut r = Reader { data: jpeg, pos: 2 };
    loop {
        while jpeg.get(r.pos) == Some(&0xFF) && jpeg.get(r.pos + 1) == Some(&0xFF) {
            r.pos += 1;
        }
        let marker = match jpeg.get(r.pos..r.pos + 2) {
            Some([0xFF, m]) => *m,
            _ => return Err(invalid("marker expected")),
        };
        r.pos += 2;
        match marker {
            0xC0 | 0xC1 => frame = Some(sof(r.segment()?)?),
            0xC2 | 0xC3 | 0xC5..=0xC7 | 0xC9..=0xCB | 0xCD..=0xCF => {
                return Err(unsupported("coding process"));
            }
            0xC4 => dht(r.segment()?, tables)?,
            0xDB => dqt(r.segment()?, tables, &mut quant_defined)?,
            0xDD => {
                let s = r.segment()?;
                restart = usize::from(u16::from_be_bytes([
                    *s.first().ok_or_else(|| invalid("DRI"))?,
                    *s.get(1).ok_or_else(|| invalid("DRI"))?,
                ]));
            }
            0xDA => {
                let mut f = frame.ok_or_else(|| invalid("scan before frame"))?;
                sos(r.segment()?, &mut f, tables, &quant_defined)?;
                f.restart = restart;
                f.scan = r.pos;
                return Ok(f);
            }
            0xD9 => return Err(invalid("image has no scan")),
            0x01 | 0xD0..=0xD7 => {}
            _ => {
                r.segment()?;
            }
        }
    }
}

fn sof(s: &[u8]) -> Result<Frame, CodecError> {
    if s.len() < 6 {
        return Err(invalid("SOF"));
    }
    if s[0] != 8 {
        return Err(unsupported("sample precision"));
    }
    let height = u32::from(u16::from_be_bytes([s[1], s[2]]));
    let width = u32::from(u16::from_be_bytes([s[3], s[4]]));
    let count = usize::from(s[5]);
    if height == 0 {
        return Err(unsupported("height defined by DNL"));
    }
    if count != 1 && count != 3 {
        return Err(unsupported("component count"));
    }
    let size = Size { width, height };
    size.validate()?;
    let mut f = Frame {
        size,
        count,
        components: [Component::default(); 3],
        order: [0, 1, 2],
        hmax: 1,
        vmax: 1,
        restart: 0,
        scan: 0,
    };
    for (i, c) in s
        .get(6..6 + count * 3)
        .ok_or_else(|| invalid("SOF components"))?
        .chunks_exact(3)
        .enumerate()
    {
        let (h, v) = (usize::from(c[1] >> 4), usize::from(c[1] & 15));
        if !(1..=4).contains(&h) || !(1..=4).contains(&v) || c[2] > 3 {
            return Err(invalid("sampling factors"));
        }
        // A single-component scan is non-interleaved: sampling factors are moot.
        let (h, v) = if count == 1 { (1, 1) } else { (h, v) };
        f.components[i] = Component {
            id: c[0],
            h,
            v,
            quant: usize::from(c[2]),
            ..Component::default()
        };
        f.hmax = f.hmax.max(h);
        f.vmax = f.vmax.max(v);
    }
    for (i, c) in f.components[..count].iter().enumerate() {
        if f.components[..i].iter().any(|other| other.id == c.id) {
            return Err(invalid("duplicate component id"));
        }
        if !f.hmax.is_multiple_of(c.h) || !f.vmax.is_multiple_of(c.v) {
            return Err(unsupported("fractional sampling ratio"));
        }
    }
    Ok(f)
}

fn dqt(mut s: &[u8], t: &mut Tables, defined: &mut [bool; 4]) -> Result<(), CodecError> {
    while let Some((&pq_tq, rest)) = s.split_first() {
        let (precision, id) = (pq_tq >> 4, usize::from(pq_tq & 15));
        if id > 3 || precision > 1 {
            return Err(invalid("DQT"));
        }
        // 8-bit samples use 8-bit quantisers (T.81 B.2.4.1).
        if precision == 1 {
            return Err(unsupported("16-bit quantiser for 8-bit samples"));
        }
        let values = rest.get(..64).ok_or_else(|| invalid("DQT"))?;
        if values.contains(&0) {
            return Err(invalid("zero quantiser"));
        }
        for (v, natural) in values.iter().zip(ZIGZAG_ORDER.iter()) {
            t.quant[id][*natural] = u16::from(*v);
        }
        let bytes = 64;
        defined[id] = true;
        s = &rest[bytes..];
    }
    Ok(())
}

fn dht(mut s: &[u8], t: &mut Tables) -> Result<(), CodecError> {
    while s.len() >= 17 {
        let (class, id) = (s[0] >> 4, usize::from(s[0] & 15));
        let counts = &s[1..17];
        let total: usize = counts.iter().map(|c| usize::from(*c)).sum();
        if class > 1 || id > 3 || total > 256 || s.len() < 17 + total {
            return Err(invalid("DHT"));
        }
        let table = if class == 0 {
            &mut t.dc[id]
        } else {
            &mut t.ac[id]
        };
        table.build(counts, &s[17..17 + total])?;
        s = &s[17 + total..];
    }
    if s.is_empty() {
        Ok(())
    } else {
        Err(invalid("DHT"))
    }
}

fn sos(s: &[u8], f: &mut Frame, t: &Tables, quant: &[bool; 4]) -> Result<(), CodecError> {
    let n = usize::from(*s.first().ok_or_else(|| invalid("SOS"))?);
    if n != f.count {
        return Err(unsupported("multi-scan image"));
    }
    let body = s.get(1..1 + n * 2 + 3).ok_or_else(|| invalid("SOS"))?;
    let mut seen = [false; 3];
    for (slot, pair) in body[..n * 2].chunks_exact(2).enumerate() {
        let index = f.components[..f.count]
            .iter()
            .position(|c| c.id == pair[0])
            .ok_or_else(|| invalid("scan component"))?;
        if std::mem::replace(&mut seen[index], true) {
            return Err(invalid("component selected twice in scan"));
        }
        f.order[slot] = index;
        let c = &mut f.components[index];
        c.dc = usize::from(pair[1] >> 4);
        c.ac = usize::from(pair[1] & 15);
        if c.dc > 3 || c.ac > 3 {
            return Err(invalid("scan table id"));
        }
    }
    for c in &f.components[..f.count] {
        if !t.dc[c.dc].defined || !t.ac[c.ac].defined || !quant[c.quant] {
            return Err(invalid("missing table"));
        }
    }
    if body[n * 2..] != [0, 63, 0] {
        return Err(unsupported("spectral selection"));
    }
    Ok(())
}
