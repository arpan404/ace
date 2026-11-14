// SPDX-License-Identifier: Apache-2.0
//! Baseline JPEG headers (ITU-T T.81): the reader that fills VA-API's JPEG decode buffers,
//! and the Annex K tables and header writer the VA JPEG encoder is given.
use media_codec::CodecError;
use std::ops::Range;

/// Zig-zag position → natural (row-major) index, T.81 Figure A.6.
pub const ZIGZAG: [usize; 64] = [
    0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20,
    13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59,
    52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];

/// Table K.1, natural order.
pub const LUMA_QUANT: [u8; 64] = [
    16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56,
    14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113,
    92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];

/// Table K.2, natural order.
pub const CHROMA_QUANT: [u8; 64] = {
    let mut t = [99u8; 64];
    let head: [[u8; 4]; 4] = [
        [17, 18, 24, 47],
        [18, 21, 26, 66],
        [24, 26, 56, 99],
        [47, 66, 99, 99],
    ];
    let mut r = 0;
    while r < 4 {
        let mut c = 0;
        while c < 4 {
            t[r * 8 + c] = head[r][c];
            c += 1;
        }
        r += 1;
    }
    t
};

/// A Huffman table as coded in DHT: code counts per length 1–16, then the symbols.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Huffman {
    pub counts: [u8; 16],
    pub symbols: Vec<u8>,
}

fn table(counts: [u8; 16], symbols: &[u8]) -> Huffman {
    Huffman {
        counts,
        symbols: symbols.to_vec(),
    }
}

const DC_SYMBOLS: [u8; 12] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const AC_LUMA_SYMBOLS: [u8; 162] = [
    0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
    0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
    0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
    0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
    0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
    0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
    0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
    0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
    0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
    0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
    0xf9, 0xfa,
];
const AC_CHROMA_SYMBOLS: [u8; 162] = [
    0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71,
    0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0,
    0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
    0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48,
    0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68,
    0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
    0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5,
    0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3,
    0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
    0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
    0xf9, 0xfa,
];

/// Table K.3: luminance DC.
pub fn dc_luma() -> Huffman {
    table(
        [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0],
        &DC_SYMBOLS,
    )
}
/// Table K.4: chrominance DC.
pub fn dc_chroma() -> Huffman {
    table(
        [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0],
        &DC_SYMBOLS,
    )
}
/// Table K.5: luminance AC.
pub fn ac_luma() -> Huffman {
    table(
        [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d],
        &AC_LUMA_SYMBOLS,
    )
}
/// Table K.6: chrominance AC.
pub fn ac_chroma() -> Huffman {
    table(
        [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77],
        &AC_CHROMA_SYMBOLS,
    )
}

/// An Annex K table scaled to `quality` (1–100, 50 is the table itself), zig-zag order.
pub fn scaled_quant(base: &[u8; 64], quality: u8) -> [u8; 64] {
    let q = u32::from(quality.clamp(1, 100));
    let scale = if q < 50 { 5000 / q } else { 200 - 2 * q };
    let mut out = [0u8; 64];
    for (pos, natural) in ZIGZAG.iter().enumerate() {
        out[pos] = ((u32::from(base[*natural]) * scale + 50) / 100).clamp(1, 255) as u8;
    }
    out
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Component {
    pub id: u8,
    pub h: u8,
    pub v: u8,
    pub quant: u8,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ScanComponent {
    pub selector: u8,
    pub dc: u8,
    pub ac: u8,
}

/// What a VA JPEG decode needs from one baseline, single-scan JPEG.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Header {
    pub width: u16,
    pub height: u16,
    pub components: Vec<Component>,
    /// Zig-zag order, as coded.
    pub quant: [Option<[u8; 64]>; 4],
    /// Tables 0 and 1; the Annex K tables stand in where the stream has none (MJPEG).
    pub dc: [Huffman; 2],
    pub ac: [Huffman; 2],
    pub restart_interval: u16,
    pub scan: Vec<ScanComponent>,
    /// The entropy-coded data, restart markers included, up to the EOI.
    pub scan_data: Range<usize>,
}

impl Header {
    /// `VA_RT_FORMAT_*` for the sampling, or `None` for layouts VA decoders don't take.
    pub fn rt_format(&self) -> Option<u32> {
        use crate::formats::*;
        match self.components.as_slice() {
            [y] if y.h == y.v => Some(VA_RT_FORMAT_YUV400),
            [y, cb, cr] if cb.h == 1 && cb.v == 1 && cr.h == 1 && cr.v == 1 => match (y.h, y.v) {
                (2, 2) => Some(VA_RT_FORMAT_YUV420),
                (2, 1) => Some(VA_RT_FORMAT_YUV422),
                (1, 1) => Some(VA_RT_FORMAT_YUV444),
                _ => None,
            },
            _ => None,
        }
    }

    /// Minimum coded units in the scan.
    pub fn mcu_count(&self) -> u32 {
        let h = self
            .components
            .iter()
            .map(|c| c.h)
            .max()
            .unwrap_or(1)
            .max(1);
        let v = self
            .components
            .iter()
            .map(|c| c.v)
            .max()
            .unwrap_or(1)
            .max(1);
        let (mw, mh) = if self.scan.len() == 1 {
            (8, 8)
        } else {
            (8 * u32::from(h), 8 * u32::from(v))
        };
        u32::from(self.width).div_ceil(mw) * u32::from(self.height).div_ceil(mh)
    }
}

fn bad(what: &str) -> CodecError {
    CodecError::InvalidInput(format!("JPEG: {what}"))
}

fn unsupported(what: &str) -> CodecError {
    CodecError::Unsupported(format!("JPEG for VA decode: {what}"))
}

/// Reads the headers of a baseline JPEG up to its first scan, and finds the scan's end.
pub fn parse(jpeg: &[u8]) -> Result<Header, CodecError> {
    if jpeg.get(..2) != Some(&[0xff, 0xd8]) {
        return Err(bad("no SOI"));
    }
    let mut pos = 2;
    let mut frame: Option<(u16, u16, Vec<Component>)> = None;
    let mut quant = [None; 4];
    let mut dc = [dc_luma(), dc_chroma()];
    let mut ac = [ac_luma(), ac_chroma()];
    let mut restart_interval = 0;
    loop {
        while jpeg.get(pos) == Some(&0xff) && jpeg.get(pos + 1) == Some(&0xff) {
            pos += 1; // fill bytes
        }
        let marker = match jpeg.get(pos..pos + 2) {
            Some([0xff, m]) => *m,
            _ => return Err(bad("expected a marker")),
        };
        let len = jpeg
            .get(pos + 2..pos + 4)
            .map(|b| usize::from(u16::from_be_bytes([b[0], b[1]])))
            .ok_or_else(|| bad("truncated segment"))?;
        let body = jpeg
            .get(pos + 4..pos + 2 + len)
            .filter(|_| len >= 2)
            .ok_or_else(|| bad("truncated segment"))?;
        pos += 2 + len;
        match marker {
            0xc0 | 0xc1 => {
                let (&precision, rest) = body.split_first().ok_or_else(|| bad("short SOF"))?;
                if precision != 8 || rest.len() < 5 {
                    return Err(unsupported("sample precision other than 8"));
                }
                let height = u16::from_be_bytes([rest[0], rest[1]]);
                let width = u16::from_be_bytes([rest[2], rest[3]]);
                let count = usize::from(rest[4]);
                let comps = rest.get(5..5 + 3 * count).ok_or_else(|| bad("short SOF"))?;
                let components = comps
                    .chunks_exact(3)
                    .map(|c| Component {
                        id: c[0],
                        h: c[1] >> 4,
                        v: c[1] & 15,
                        quant: c[2] & 3,
                    })
                    .collect();
                if width == 0 || height == 0 {
                    return Err(unsupported("height defined by DNL"));
                }
                frame = Some((width, height, components));
            }
            0xc2..=0xcf if marker != 0xc4 && marker != 0xc8 && marker != 0xcc => {
                return Err(unsupported("progressive, lossless or arithmetic coding"));
            }
            0xdb => {
                let mut rest = body;
                while let Some((&pq_tq, tail)) = rest.split_first() {
                    if pq_tq >> 4 != 0 {
                        return Err(unsupported("16-bit quantization tables"));
                    }
                    let values = tail.get(..64).ok_or_else(|| bad("short DQT"))?;
                    let mut t = [0u8; 64];
                    t.copy_from_slice(values);
                    quant[usize::from(pq_tq & 3)] = Some(t);
                    rest = &tail[64..];
                }
            }
            0xc4 => {
                let mut rest = body;
                while let Some((&tc_th, tail)) = rest.split_first() {
                    let counts_bytes = tail.get(..16).ok_or_else(|| bad("short DHT"))?;
                    let mut counts = [0u8; 16];
                    counts.copy_from_slice(counts_bytes);
                    let n: usize = counts.iter().map(|c| usize::from(*c)).sum();
                    let symbols = tail.get(16..16 + n).ok_or_else(|| bad("short DHT"))?;
                    let (class, id) = (tc_th >> 4, usize::from(tc_th & 15));
                    if id > 1 || class > 1 || (class == 0 && n > 12) || n > 162 {
                        return Err(unsupported("Huffman table outside baseline limits"));
                    }
                    let t = table(counts, symbols);
                    if class == 0 {
                        dc[id] = t;
                    } else {
                        ac[id] = t;
                    }
                    rest = &tail[16 + n..];
                }
            }
            0xdd => {
                restart_interval = body
                    .get(..2)
                    .map(|b| u16::from_be_bytes([b[0], b[1]]))
                    .ok_or_else(|| bad("short DRI"))?;
            }
            0xda => {
                let (width, height, components) = frame.ok_or_else(|| bad("SOS before SOF"))?;
                let (&count, rest) = body.split_first().ok_or_else(|| bad("short SOS"))?;
                let scan = rest
                    .get(..2 * usize::from(count))
                    .ok_or_else(|| bad("short SOS"))?
                    .chunks_exact(2)
                    .map(|c| ScanComponent {
                        selector: c[0],
                        dc: c[1] >> 4,
                        ac: c[1] & 15,
                    })
                    .collect::<Vec<_>>();
                if scan.len() != components.len() {
                    return Err(unsupported("more than one scan"));
                }
                let end = scan_end(jpeg, pos);
                return Ok(Header {
                    width,
                    height,
                    components,
                    quant,
                    dc,
                    ac,
                    restart_interval,
                    scan,
                    scan_data: pos..end,
                });
            }
            0xd9 => return Err(bad("EOI before a scan")),
            _ => {} // APPn, COM and others carry nothing VA needs.
        }
    }
}

/// The first marker after `from` that isn't stuffing or a restart marker.
fn scan_end(jpeg: &[u8], from: usize) -> usize {
    let mut i = from;
    while i + 1 < jpeg.len() {
        if jpeg[i] == 0xff && jpeg[i + 1] != 0 && !(0xd0..=0xd7).contains(&jpeg[i + 1]) {
            return i;
        }
        i += 1;
    }
    jpeg.len()
}

fn segment(out: &mut Vec<u8>, marker: u8, body: &[u8]) {
    out.extend_from_slice(&[0xff, marker]);
    out.extend_from_slice(&((body.len() + 2) as u16).to_be_bytes());
    out.extend_from_slice(body);
}

/// SOI, DQT, SOF0, DHT and SOS of a 4:2:0 baseline JPEG with the Annex K tables at
/// `quality`: what precedes the entropy-coded data a VA JPEG encoder produces.
pub fn write_headers(width: u16, height: u16, quality: u8, out: &mut Vec<u8>) {
    out.extend_from_slice(&[0xff, 0xd8]);
    let mut dqt = Vec::with_capacity(130);
    for (id, base) in [&LUMA_QUANT, &CHROMA_QUANT].into_iter().enumerate() {
        dqt.push(id as u8);
        dqt.extend_from_slice(&scaled_quant(base, quality));
    }
    segment(out, 0xdb, &dqt);
    let [hh, hl] = height.to_be_bytes();
    let [wh, wl] = width.to_be_bytes();
    segment(
        out,
        0xc0,
        &[8, hh, hl, wh, wl, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1],
    );
    let mut dht = Vec::with_capacity(432);
    for (class_id, t) in [
        (0x00, dc_luma()),
        (0x10, ac_luma()),
        (0x01, dc_chroma()),
        (0x11, ac_chroma()),
    ] {
        dht.push(class_id);
        dht.extend_from_slice(&t.counts);
        dht.extend_from_slice(&t.symbols);
    }
    segment(out, 0xc4, &dht);
    segment(out, 0xda, &[3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0]);
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use media_codec::{CpuJpegCodec, CpuPicture, PixelFormat, Plane, Size, StillCodec};

    fn cpu_jpeg(width: u32, height: u32) -> Vec<u8> {
        let picture = CpuPicture::new(
            Size { width, height },
            PixelFormat::Rgb8,
            [Plane {
                data: (0..width * height * 3).map(|i| (i % 251) as u8).collect(),
                stride: width as usize * 3,
            }],
            0,
        )
        .unwrap();
        StillCodec::encode(&mut CpuJpegCodec::default(), &picture, 80).unwrap()
    }

    #[test]
    fn the_annex_k_huffman_tables_have_their_symbol_counts() {
        for t in [dc_luma(), dc_chroma(), ac_luma(), ac_chroma()] {
            let n: usize = t.counts.iter().map(|c| usize::from(*c)).sum();
            assert_eq!(n, t.symbols.len());
        }
    }

    #[test]
    fn quality_scales_the_annex_k_tables() {
        let at50 = scaled_quant(&LUMA_QUANT, 50);
        assert_eq!(at50[..3], [16, 11, 12]);
        assert!(scaled_quant(&LUMA_QUANT, 100).iter().all(|q| *q == 1));
        assert_eq!(scaled_quant(&CHROMA_QUANT, 1)[63], 255);
    }

    #[test]
    fn a_cpu_encoded_jpeg_yields_its_frame_tables_and_scan() {
        let jpeg = cpu_jpeg(70, 34);
        let h = parse(&jpeg).unwrap();
        assert_eq!((h.width, h.height), (70, 34));
        assert_eq!(h.rt_format(), Some(crate::formats::VA_RT_FORMAT_YUV420));
        assert_eq!(h.scan.len(), 3);
        assert!(h.quant[0].is_some());
        assert_eq!(&jpeg[h.scan_data.end..], [0xff, 0xd9]);
        // 4:2:0 MCUs of 16 × 16.
        assert_eq!(h.mcu_count(), 5 * 3);
    }

    #[test]
    fn written_headers_parse_back() {
        let mut out = Vec::new();
        write_headers(1568, 720, 80, &mut out);
        out.extend_from_slice(&[0x12, 0x34, 0xff, 0x00, 0xff, 0xd0, 0x56, 0xff, 0xd9]);
        let h = parse(&out).unwrap();
        assert_eq!((h.width, h.height), (1568, 720));
        assert_eq!(h.quant[1], Some(scaled_quant(&CHROMA_QUANT, 80)));
        assert_eq!(h.ac[1], ac_chroma());
        assert_eq!(out.len() - h.scan_data.end, 2);
        assert_eq!(h.scan_data.len(), 7);
    }

    #[test]
    fn progressive_and_truncated_jpegs_are_refused() {
        let mut progressive = cpu_jpeg(16, 16);
        let sof = progressive
            .windows(2)
            .position(|w| w == [0xff, 0xc0])
            .unwrap();
        progressive[sof + 1] = 0xc2;
        assert!(matches!(
            parse(&progressive),
            Err(CodecError::Unsupported(_))
        ));
        let whole = cpu_jpeg(16, 16);
        assert!(parse(&whole[..20]).is_err());
        assert!(parse(&[0xff, 0xd8, 0xff]).is_err());
    }
}
