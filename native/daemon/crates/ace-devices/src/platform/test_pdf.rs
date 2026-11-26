// SPDX-License-Identifier: Apache-2.0
//! A one-page PDF for tests: the drawing operators Apple's device art uses, compressed as
//! Apple's is. A stand-in for the artwork Xcode ships, never a copy of it.

use std::io::Write;

use super::pdf_svg::{SvgArt, pdf_art};

/// A one-page PDF of `width` × `height` whose page draws `content` (PDF drawing operators),
/// with `graphics` naming ExtGState entries the drawing can select with `gs`.
pub fn tiny_pdf(width: f64, height: f64, content: &str, graphics: &[(&str, &str)]) -> Vec<u8> {
    let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    encoder
        .write_all(content.as_bytes())
        .expect("a test's drawing compresses");
    let stream = encoder.finish().expect("a test's drawing compresses");
    let states = graphics
        .iter()
        .map(|(name, dict)| format!("/{name} << {dict} >>"))
        .collect::<Vec<String>>()
        .join(" ");
    let mut bytes = Vec::new();
    bytes.extend_from_slice(b"%PDF-1.3\n");
    bytes.extend_from_slice(
        format!(
            "3 0 obj\n<< /Filter /FlateDecode /Length {} >>\nstream\n",
            stream.len()
        )
        .as_bytes(),
    );
    bytes.extend_from_slice(&stream);
    bytes.extend_from_slice(b"\nendstream\nendobj\n");
    bytes.extend_from_slice(
        b"1 0 obj\n<< /Type /Page /Parent 2 0 R /Resources 4 0 R /Contents 3 0 R >>\nendobj\n",
    );
    bytes.extend_from_slice(
        format!("4 0 obj\n<< /ExtGState << {states} >> >>\nendobj\n").as_bytes(),
    );
    bytes.extend_from_slice(
        format!(
            "2 0 obj\n<< /Type /Pages /MediaBox [0 0 {width} {height}] /Count 1 /Kids [ 1 0 R ] >>\nendobj\n"
        )
        .as_bytes(),
    );
    bytes.extend_from_slice(b"trailer\n<< /Root 5 0 R >>\n%%EOF\n");
    bytes
}

/// A filled black rectangle of `width` × `height`, as Apple draws a body piece.
pub fn black(width: f64, height: f64) -> Vec<u8> {
    tiny_pdf(
        width,
        height,
        &format!("0 0 0 rg 0 0 {width} {height} re f"),
        &[],
    )
}

/// The art of a filled rectangle, parsed as a chrome would read the PDF.
pub fn black_art(width: f64, height: f64, prefix: &str) -> SvgArt {
    pdf_art(&black(width, height), prefix).expect("a black rectangle is art")
}
