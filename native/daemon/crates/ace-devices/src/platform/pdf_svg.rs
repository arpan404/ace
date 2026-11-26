// SPDX-License-Identifier: Apache-2.0
//! `pdf-svg.ts`: a PDF page as an SVG drawing of its own size, and as a standalone document.
//! The painter is [`super::pdf_paint`]; this is what callers ask for.

use super::pdf_objects::first_page;
use super::pdf_paint::Painter;
use super::pdf_style::{initial_state, round};

/// A page drawn as SVG: its size in PDF units and the markup.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct SvgArt {
    pub width: f64,
    pub height: f64,
    pub svg: String,
}

/// A PDF's first page as SVG elements in a viewBox of its own size (y pointing down), or none
/// when it draws nothing ace can show. `prefix` keeps clip ids unique when several drawings
/// share one document.
pub fn pdf_art(bytes: &[u8], prefix: &str) -> Option<SvgArt> {
    let page = first_page(bytes)?;
    let mut painter = Painter::new(&page.objects, prefix);
    painter.run(&page.content, page.resources.as_ref(), &initial_state());
    let (elements, defs_drawn, painted) = painter.elements();
    if painted == 0 {
        return None;
    }
    let [x0, _, _, y1] = page.page_box;
    let width = page.page_box[2] - x0;
    let height = y1 - page.page_box[1];
    let defs = match defs_drawn.is_empty() {
        true => String::new(),
        false => format!("<defs>{}</defs>", defs_drawn.join("")),
    };
    let body = format!(
        "<g transform=\"matrix(1 0 0 -1 {} {})\">{}</g>",
        round(-x0),
        round(y1),
        elements.join("")
    );
    Some(SvgArt {
        width,
        height,
        svg: format!("{defs}{body}"),
    })
}

/// Base64 text as bytes, as a data URL or an answer carries them.
pub fn decode_base64(text: &str) -> Option<Vec<u8>> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.decode(text).ok()
}

/// Art as a standalone SVG document, drawn at its own size.
pub fn svg_document(art: &SvgArt) -> String {
    format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {} {}\" width=\"{}\" height=\"{}\">{}</svg>",
        round(art.width),
        round(art.height),
        round(art.width),
        round(art.height),
        art.svg
    )
}

#[cfg(test)]
mod tests;
