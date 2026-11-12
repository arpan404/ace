//! What every Office XML reader shares: a reader that keeps no DTD and text from text events.

use quick_xml::Reader;
use quick_xml::events::Event;

use crate::DocError;
use crate::bounded::short;

/// A reader over `xml` that leaves text as it is (whitespace in `w:t` matters).
pub fn reader(xml: &str) -> Reader<&[u8]> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);
    reader
}

/// The text an event carries: character data, CDATA, or one entity or character reference.
/// Only XML's five predefined entities are known; no DTD is read, so none can be defined.
pub fn text(event: &Event<'_>) -> Option<String> {
    match event {
        Event::Text(text) => Some(text.xml10_content().into_owned()),
        Event::CData(data) => Some(data.xml10_content().into_owned()),
        Event::GeneralRef(reference) => {
            if let Ok(Some(c)) = reference.resolve_char_ref() {
                return Some(c.to_string());
            }
            let name = reference.xml10_content();
            Some(
                match name.as_ref() {
                    "amp" => "&",
                    "lt" => "<",
                    "gt" => ">",
                    "quot" => "\"",
                    "apos" => "'",
                    _ => "",
                }
                .to_owned(),
            )
        }
        _ => None,
    }
}

pub fn damaged(error: &quick_xml::Error) -> DocError {
    DocError::Damaged(short(&error.to_string()))
}

/// An attribute's value by local name.
pub fn attribute(start: &quick_xml::events::BytesStart<'_>, local: &str) -> Option<String> {
    start
        .attributes()
        .flatten()
        .find(|a| a.key.local_name().into_inner() == local)
        .and_then(|a| {
            a.normalized_value(quick_xml::XmlVersion::Implicit1_0)
                .ok()
                .map(|v| v.into_owned())
        })
}
