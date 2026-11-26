// SPDX-License-Identifier: Apache-2.0
//! The cases `pdf-svg.test.ts` moved here, on the SVG the painter writes. The drawn pixels
//! stay ace-media's (ADR 0208) and are asserted by the TypeScript proof; what this crate
//! decides is the markup ace-media is given.

use super::{SvgArt, pdf_art, svg_document};
use crate::platform::test_pdf::tiny_pdf;

fn art(width: f64, height: f64, content: &str) -> SvgArt {
    pdf_art(&tiny_pdf(width, height, content, &[]), "a").expect("the drawing has art")
}

#[test]
fn a_filled_shape_lands_where_the_pdf_puts_it() {
    // A red bar along the bottom of a 100 × 50 page (PDF y counts up from the bottom).
    let drawn = art(100.0, 50.0, "1 0 0 rg 0 0 100 10 re f");
    assert_eq!([drawn.width, drawn.height], [100.0, 50.0]);
    assert_eq!(
        drawn.svg,
        "<g transform=\"matrix(1 0 0 -1 0 50)\"><path d=\"M0 0h100v10h-100Z\" \
         transform=\"matrix(1 0 0 1 0 0)\" fill=\"rgb(255,0,0)\"/></g>"
    );
}

#[test]
fn an_even_odd_clip_cuts_a_hole() {
    let ring = "0 0 100 100 re 25 25 50 50 re W* n 0 0 0 rg 0 0 100 100 re f";
    let drawn = art(100.0, 100.0, ring);
    assert_eq!(
        drawn.svg,
        "<defs><clipPath id=\"ac0\"><path d=\"M0 0h100v100h-100ZM25 25h50v50h-50Z\" \
         transform=\"matrix(1 0 0 1 0 0)\" clip-rule=\"evenodd\"/></clipPath></defs>\
         <g transform=\"matrix(1 0 0 -1 0 100)\"><g clip-path=\"url(#ac0)\">\
         <path d=\"M0 0h100v100h-100Z\" transform=\"matrix(1 0 0 1 0 0)\" fill=\"rgb(0,0,0)\"/>\
         </g></g>"
    );
}

#[test]
fn a_clip_ends_with_the_graphics_state_it_was_set_in() {
    let drawing = "q 0 0 10 10 re W n Q 0 0 1 rg 0 0 100 100 re f";
    let drawn = art(100.0, 100.0, drawing);
    // The clip's group is closed by `Q`, so the blue fill is not clipped.
    assert_eq!(
        drawn.svg,
        "<defs><clipPath id=\"ac0\"><path d=\"M0 0h10v10h-10Z\" transform=\"matrix(1 0 0 1 0 0)\" \
         clip-rule=\"nonzero\"/></clipPath></defs>\
         <g transform=\"matrix(1 0 0 -1 0 100)\"><g clip-path=\"url(#ac0)\"></g>\
         <path d=\"M0 0h100v100h-100Z\" transform=\"matrix(1 0 0 1 0 0)\" \
         fill=\"rgb(0,0,255)\"/></g>"
    );
}

#[test]
fn transparency_set_through_a_graphics_state_carries_into_the_fill() {
    let bytes = tiny_pdf(
        20.0,
        20.0,
        "/Half gs 0 0 0 rg 0 0 20 20 re f",
        &[("Half", "/Type /ExtGState /ca 0.5")],
    );
    let drawn = pdf_art(&bytes, "a").expect("the drawing has art");
    assert!(drawn.svg.contains("fill-opacity=\"0.5\""), "{}", drawn.svg);
}

#[test]
fn a_transform_moves_what_is_drawn_after_it() {
    let drawn = art(100.0, 100.0, "1 0 0 1 50 0 cm 0 1 0 rg 0 0 10 100 re f");
    assert!(
        drawn.svg.contains("transform=\"matrix(1 0 0 1 50 0)\""),
        "{}",
        drawn.svg
    );
}

#[test]
fn a_page_that_draws_nothing_has_no_art() {
    assert_eq!(pdf_art(&tiny_pdf(393.0, 47.0, "q Q", &[]), "a"), None);
}

#[test]
fn bytes_that_are_not_a_pdf_have_no_art_rather_than_throwing() {
    assert_eq!(pdf_art(b"not a pdf", "a"), None);
    assert_eq!(pdf_art(&[], "a"), None);
    assert_eq!(pdf_art(&[0xff, 0x00, b'o', b'b', b'j'], "a"), None);
}

#[test]
fn a_truncated_or_unknown_stream_leaves_the_page_without_art() {
    // A stream cut before `endstream`, and one flate cannot inflate.
    let cut = b"%PDF-1.3\n3 0 obj\n<< /Filter /FlateDecode >>\nstream\nx\x9c garbage";
    assert_eq!(pdf_art(cut, "a"), None);
    let filtered =
        b"%PDF-1.3\n1 0 obj\n<< /Type /Page /MediaBox [0 0 10 10] /Contents 3 0 R >>\nendobj\n\
        3 0 obj\n<< /Filter /DCTDecode >>\nstream\nabc\nendstream\nendobj\n";
    assert_eq!(pdf_art(filtered, "a"), None);
}

#[test]
fn the_document_draws_at_its_own_size() {
    let drawn = art(100.0, 50.0, "1 0 0 rg 0 0 100 10 re f");
    assert_eq!(
        svg_document(&drawn),
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 100 50\" width=\"100\" \
         height=\"50\"><g transform=\"matrix(1 0 0 -1 0 50)\"><path d=\"M0 0h100v10h-100Z\" \
         transform=\"matrix(1 0 0 1 0 0)\" fill=\"rgb(255,0,0)\"/></g></svg>"
    );
}

/// A one-page PDF whose page resources are `resources` and which carries `extra` objects, with
/// the drawing Flate-compressed as Apple's is.
fn page(width: f64, height: f64, content: &str, resources: &str, extra: &[(u32, &str)]) -> Vec<u8> {
    use std::io::Write;

    let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    encoder
        .write_all(content.as_bytes())
        .expect("the drawing compresses");
    let stream = encoder.finish().expect("the drawing compresses");
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
    bytes.extend_from_slice(format!("4 0 obj\n{resources}\nendobj\n").as_bytes());
    for (id, object) in extra {
        bytes.extend_from_slice(format!("{id} 0 obj\n{object}\nendobj\n").as_bytes());
    }
    bytes.extend_from_slice(
        format!(
            "2 0 obj\n<< /Type /Pages /MediaBox [0 0 {width} {height}] /Count 1 /Kids [ 1 0 R ] >>\nendobj\n"
        )
        .as_bytes(),
    );
    bytes
}

#[test]
fn a_line_cap_and_join_index_as_javascript_arrays_do() {
    let drawn = art(10.0, 10.0, "1.5 J 1.5 j 0 0 10 10 re S");
    assert!(
        drawn.svg.contains("stroke-linecap=\"butt\""),
        "{}",
        drawn.svg
    );
    assert!(
        drawn.svg.contains("stroke-linejoin=\"miter\""),
        "{}",
        drawn.svg
    );
    let rounded = art(10.0, 10.0, "1 J 2 j 0 0 10 10 re S");
    assert!(
        rounded.svg.contains("stroke-linecap=\"round\""),
        "{}",
        rounded.svg
    );
    assert!(
        rounded.svg.contains("stroke-linejoin=\"bevel\""),
        "{}",
        rounded.svg
    );
}

#[test]
fn a_colour_space_with_no_components_takes_the_whole_slice() {
    let resources = "<< /ColorSpace << /CS1 [ /ICCBased 5 0 R ] >> >>";
    let none = page(
        10.0,
        10.0,
        "/CS1 cs 0.5 0.2 sc 0 0 10 10 re f",
        resources,
        &[(5, "<< /N 0 /Alternate /DeviceRGB >>")],
    );
    // `values.slice(-0)` is the whole array: a grey from its first value.
    let drawn = pdf_art(&none, "a").expect("art");
    assert!(
        drawn.svg.contains("fill=\"rgb(128,128,128)\""),
        "{}",
        drawn.svg
    );
    // A negative count drops that many from the front: `slice(1)` is the last value.
    let negative = page(
        10.0,
        10.0,
        "/CS1 cs 0.5 0.2 sc 0 0 10 10 re f",
        resources,
        &[(5, "<< /N -1 /Alternate /DeviceRGB >>")],
    );
    let drawn = pdf_art(&negative, "a").expect("art");
    assert!(
        drawn.svg.contains("fill=\"rgb(51,51,51)\""),
        "{}",
        drawn.svg
    );
}
