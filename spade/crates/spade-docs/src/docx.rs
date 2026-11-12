//! Word (DOCX): the body's paragraphs in order, with tabs, breaks and table cells. Headers,
//! footers, comments and images are left out.

use quick_xml::events::Event;

use crate::xml::{damaged, reader, text};
use crate::zipped::Parts;
use crate::{DocError, Extracted, Kind, Limits};

pub fn read(bytes: &[u8], limits: &Limits) -> Result<Extracted, DocError> {
    let mut parts = Parts::open(bytes, limits)?;
    let xml = parts.text("word/document.xml")?;
    let mut out = String::new();
    let mut reader = reader(&xml);
    // Inside `w:t`: only its text is the document's words (field codes and the like are not).
    let mut in_text = false;
    let mut cut = false;
    loop {
        let event = reader.read_event().map_err(|e| damaged(&e))?;
        match &event {
            Event::Eof => break,
            Event::Start(start) => match start.local_name().into_inner() {
                "t" => in_text = true,
                "tab" => out.push('\t'),
                "br" | "cr" => out.push('\n'),
                _ => {}
            },
            Event::Empty(empty) => match empty.local_name().into_inner() {
                "tab" => out.push('\t'),
                "br" | "cr" => out.push('\n'),
                _ => {}
            },
            Event::End(end) => match end.local_name().into_inner() {
                "t" => in_text = false,
                "p" | "tr" => out.push('\n'),
                "tc" => out.push('\t'),
                _ => {}
            },
            _ if in_text => {
                if let Some(words) = text(&event) {
                    out.push_str(&words);
                }
            }
            _ => {}
        }
        if out.len() > limits.text_bytes {
            cut = true;
            break;
        }
    }
    Ok(Extracted {
        kind: Kind::Docx,
        text: out,
        pages: None,
        sheets: None,
        cut,
    })
}
