//! Documents and voice in the prompt (ADR 0134).

use spade_models::{Image, Message};

use super::*;
use crate::event::{DocumentRef, Event, ImageRef, Known, VoiceRef};
use crate::tools::Registry;

fn document(chars: u64, view: &str) -> DocumentRef {
    DocumentRef {
        sha256: "ab12cd34ef56".repeat(5) + "abcd",
        name: "contract \"final\".pdf".into(),
        media_type: "application/pdf".into(),
        bytes: 48_000,
        pages: Some(12),
        sheets: None,
        chars,
        cut: false,
        view: view.into(),
        reader: "pdf-v1".into(),
    }
}

fn message(text: &str, documents: Vec<DocumentRef>, voice: Option<VoiceRef>) -> Event {
    Event::Known(Known::UserMessage {
        text: text.into(),
        context: None,
        images: Vec::new(),
        documents,
        voice,
        from_agent: None,
        from_routine: None,
    })
}

fn person_text(messages: &[Message]) -> (&str, usize) {
    match messages.first() {
        Some(Message::Person { text, images }) => (text.as_str(), images.len()),
        other => panic!("expected the person's message, got {other:?}"),
    }
}

#[test]
fn a_document_shows_its_view_and_how_to_read_on() {
    let messages = messages(&[message(
        "What does it say?",
        vec![document(10_000, "Section 1. Terms")],
        None,
    )]);
    let (text, images) = person_text(&messages);
    assert_eq!(images, 0);
    assert!(text.starts_with("What does it say?\n\n<document name=\"contract final.pdf\" id=\"ab12cd34ef56-pdf-v1\" pages=\"12\" chars=\"10000\">\nSection 1. Terms\n</document>"), "{text}");
    assert!(
        text.ends_with(
            "[9984 more characters; read on with document_read id=\"ab12cd34ef56-pdf-v1\" offset=16]"
        ),
        "{text}"
    );
}

#[test]
fn a_short_document_shows_whole_without_a_read_on_note() {
    let messages = messages(&[message("", vec![document(5, "hello")], None)]);
    let (text, _) = person_text(&messages);
    assert!(text.ends_with("hello\n</document>"), "{text}");
}

struct NativePdfs;

impl Images for NativePdfs {
    fn get(&self, _image: &ImageRef) -> Result<Image, String> {
        Err("no".into())
    }

    fn document(&self, document: &DocumentRef) -> Option<Image> {
        (document.media_type == "application/pdf").then(|| Image {
            media_type: "application/pdf".into(),
            data: "JVBERi0=".into(),
        })
    }
}

#[test]
fn a_model_that_reads_the_pdf_natively_gets_the_file_instead_of_the_view() {
    let events = [message("Summarise", vec![document(40, "scan")], None)];
    let messages = messages_with(&events, &NativePdfs);
    let (text, attached) = person_text(&messages);
    assert_eq!(attached, 1);
    assert!(
        text.contains("[The file itself is attached below.]"),
        "{text}"
    );
    assert!(!text.contains("scan\n</document>"), "{text}");
}

#[test]
fn a_spoken_message_reads_as_its_transcript_marked_as_spoken() {
    let voice = VoiceRef {
        sha256: "f".repeat(64),
        media_type: "audio/webm".into(),
        bytes: 900,
    };
    let messages = messages(&[message("turn the lights off", Vec::new(), Some(voice))]);
    let (text, _) = person_text(&messages);
    assert_eq!(text, "[Spoken; transcribed] turn the lights off");
}

#[test]
fn a_turn_whose_message_carries_a_document_is_untrusted_and_names_the_file() {
    let registry = Registry::new([]);
    let clean = [
        message("hi", Vec::new(), None),
        Event::reply_started("r1", "m"),
    ];
    assert!(!untrusted_turn(&clean, &registry));
    let with_file = [
        message("read this", vec![document(5, "hello")], None),
        Event::reply_started("r1", "m"),
    ];
    assert_eq!(
        untrusted_sources(&with_file, &registry),
        vec!["the attached file contract \"final\".pdf".to_owned()]
    );
}
