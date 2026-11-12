//! Windows over extracted text, and which content types are read.

use spade_fetch::Page;
use spade_fetch::page::{Reading, media_type, reading, window};

#[test]
fn windows_walk_the_whole_text_without_gaps_or_overlap() {
    let text = "héllo wörld, ünïcode counts characters not bytes";
    let mut offset = 0;
    let mut joined = String::new();
    let mut pages = 0;
    loop {
        let w = window(
            text,
            Page {
                offset,
                max_chars: 7,
            },
        );
        assert_eq!(w.total_chars, text.chars().count());
        assert!(w.text.chars().count() <= 7);
        joined.push_str(&w.text);
        pages += 1;
        match w.next_offset {
            Some(next) => offset = next,
            None => break,
        }
    }
    assert_eq!(joined, text);
    assert_eq!(pages, text.chars().count().div_ceil(7));
}

#[test]
fn a_window_that_reaches_the_end_has_no_next_offset() {
    let w = window(
        "abcdef",
        Page {
            offset: 2,
            max_chars: 4,
        },
    );
    assert_eq!(w.text, "cdef");
    assert_eq!(w.next_offset, None);
}

#[test]
fn an_offset_past_the_end_gives_empty_text() {
    let w = window(
        "abc",
        Page {
            offset: 10,
            max_chars: 5,
        },
    );
    assert_eq!(w.text, "");
    assert_eq!(w.total_chars, 3);
    assert_eq!(w.next_offset, None);
}

#[test]
fn a_zero_size_window_still_moves_forward() {
    let w = window(
        "abc",
        Page {
            offset: 0,
            max_chars: 0,
        },
    );
    assert_eq!(w.text, "a");
    assert_eq!(w.next_offset, Some(1));
}

#[test]
fn html_text_json_xml_and_pdf_are_read_and_others_are_not() {
    let cases = [
        ("text/html; charset=utf-8", Some(Reading::Html)),
        ("Application/XHTML+XML", Some(Reading::Html)),
        ("text/plain", Some(Reading::Text)),
        ("text/markdown", Some(Reading::Text)),
        ("application/json", Some(Reading::Text)),
        ("application/ld+json", Some(Reading::Text)),
        ("application/xml", Some(Reading::Text)),
        ("application/atom+xml", Some(Reading::Text)),
        ("application/pdf", Some(Reading::Pdf)),
        // Generic binary may be a PDF; its bytes decide.
        ("application/octet-stream", Some(Reading::Pdf)),
        ("image/png", None),
        ("application/zip", None),
    ];
    for (header, expected) in cases {
        assert_eq!(reading(&media_type(header)), expected, "{header}");
    }
}
