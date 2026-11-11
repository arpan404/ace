//! Pages in other character encodings read as the text they hold.

mod common;

use common::{Result, local, serve_bytes};
use spade_fetch::Page;
use spade_fetch::decode::{decode, header_charset};

#[tokio::test]
async fn an_iso_8859_1_page_declared_in_its_header_reads_correctly() -> Result {
    let addr = serve_bytes(
        "text/html; charset=iso-8859-1",
        b"<title>Caf\xe9</title><main><p>Caf\xe9 cr\xe8me br\xfbl\xe9e</p></main>",
    )
    .await?;
    let got = local()
        .fetch(&format!("http://{addr}/"), Page::default())
        .await?;
    assert_eq!(got.title.as_deref(), Some("Caf\u{e9}"));
    assert_eq!(got.text, "Caf\u{e9} cr\u{e8}me br\u{fb}l\u{e9}e");
    Ok(())
}

#[tokio::test]
async fn a_page_declaring_its_encoding_in_a_meta_tag_reads_correctly() -> Result {
    let addr = serve_bytes(
        "text/html",
        b"<html><head><meta charset=\"windows-1252\"><title>\x93Quoted\x94</title></head>\
          <body><p>\x80 5</p></body></html>",
    )
    .await?;
    let got = local()
        .fetch(&format!("http://{addr}/"), Page::default())
        .await?;
    assert_eq!(got.title.as_deref(), Some("\u{201c}Quoted\u{201d}"));
    assert_eq!(got.text, "\u{20ac} 5");
    Ok(())
}

#[tokio::test]
async fn plain_text_in_a_declared_encoding_reads_correctly() -> Result {
    let addr = serve_bytes("text/plain; charset=\"Shift_JIS\"", b"\x93\xfa\x96\x7b").await?;
    let got = local()
        .fetch(&format!("http://{addr}/"), Page::default())
        .await?;
    assert_eq!(got.text, "\u{65e5}\u{672c}");
    Ok(())
}

#[test]
fn the_encoding_comes_from_the_bom_then_the_header_then_a_meta_tag_then_utf8() {
    let meta = b"<meta http-equiv=\"Content-Type\" content=\"text/html; charset=iso-8859-1\">\xe9";
    assert_eq!(decode(meta, None, true).chars().last(), Some('\u{e9}'));
    // The header wins over a meta tag.
    assert_eq!(
        decode(meta, Some("utf-8"), true).chars().last(),
        Some('\u{fffd}')
    );
    // A byte order mark wins over the header, and is removed.
    assert_eq!(
        decode(b"\xef\xbb\xbfh\xc3\xa9", Some("iso-8859-1"), true),
        "h\u{e9}"
    );
    // Meta tags count only in HTML.
    let meta_utf8 = "<meta charset=iso-8859-1>\u{e9}".as_bytes();
    assert_eq!(
        decode(meta_utf8, None, false).chars().last(),
        Some('\u{e9}')
    );
    // An unknown label falls back to UTF-8.
    assert_eq!(
        decode("h\u{e9}".as_bytes(), Some("no-such-charset"), false),
        "h\u{e9}"
    );
    // A meta tag cannot switch to UTF-16.
    assert_eq!(
        decode(b"<meta charset=utf-16>ok", None, true),
        "<meta charset=utf-16>ok"
    );
}

#[test]
fn the_header_charset_is_read_from_its_parameters() {
    assert_eq!(
        header_charset("text/html; charset=ISO-8859-1").as_deref(),
        Some("ISO-8859-1")
    );
    assert_eq!(
        header_charset("text/plain;format=flowed; Charset=\"utf-8\"").as_deref(),
        Some("utf-8")
    );
    assert_eq!(header_charset("text/html"), None);
    assert_eq!(header_charset("text/html; charset="), None);
}

#[tokio::test]
async fn a_commented_out_meta_charset_is_ignored() -> Result {
    let addr = serve_bytes(
        "text/html",
        "<!--<meta charset=windows-1252>--><meta charset=utf-8><main>café</main>".as_bytes(),
    )
    .await?;
    let got = local()
        .fetch(&format!("http://{addr}/"), Page::default())
        .await?;
    assert_eq!(got.text, "café");
    Ok(())
}

fn last_char(bytes: &[u8]) -> Option<char> {
    decode(bytes, None, true).chars().last()
}

// The page ends in é as UTF-8 (C3 A9). Read as windows-1252 that is "Ã©", ending in ©.
const READ_AS_UTF8: char = '\u{e9}';
const READ_AS_1252: char = '\u{a9}';

#[test]
fn the_prescan_matches_whole_meta_declarations_only() {
    let cases: [(&[u8], char); 9] = [
        (b"<!--<meta charset=windows-1252>--><p>\xc3\xa9", READ_AS_UTF8),
        (b"<!--><meta charset=windows-1252><p>\xc3\xa9", READ_AS_1252),
        (b"<meta data-charset=windows-1252><p>\xc3\xa9", READ_AS_UTF8),
        (b"<meta content=\"text/html; charset=windows-1252\"><p>\xc3\xa9", READ_AS_UTF8),
        (
            b"<meta http-equiv=\"Content-Type\" content=\"text/html; charset=windows-1252\">\xc3\xa9",
            READ_AS_1252,
        ),
        (b"<div title=\"<meta charset=windows-1252>\"><p>\xc3\xa9", READ_AS_UTF8),
        (b"<META CHARSET='Windows-1252'><p>\xc3\xa9", READ_AS_1252),
        (b"<meta charset=x-user-defined><p>\xc3\xa9", READ_AS_1252),
        (b"<meta charset=windows-1252 charset=utf-8><p>\xc3\xa9", READ_AS_1252),
    ];
    for (bytes, expected) in cases {
        assert_eq!(
            last_char(bytes),
            Some(expected),
            "{}",
            String::from_utf8_lossy(bytes)
        );
    }
}

#[test]
fn a_page_with_no_declared_encoding_that_is_not_utf8_reads_as_windows_1252() {
    assert_eq!(
        decode(b"<p>Caf\xe9 \x93ok\x94", None, true),
        "<p>Caf\u{e9} \u{201c}ok\u{201d}"
    );
    assert_eq!(decode(b"Caf\xe9", None, false), "Caf\u{e9}");
    // Valid UTF-8 stays UTF-8, and a declared encoding is never second-guessed.
    assert_eq!(decode("Caf\u{e9}".as_bytes(), None, true), "Caf\u{e9}");
    assert_eq!(decode(b"Caf\xe9", Some("utf-8"), true), "Caf\u{fffd}");
}

#[test]
fn a_meta_charset_counts_only_when_it_ends_within_the_first_1024_bytes() {
    let meta = b"<meta charset=windows-1252>";
    let at = |pad: usize| {
        let mut page = vec![b' '; pad];
        page.extend_from_slice(meta);
        page.extend_from_slice(b"<p>\xc3\xa9");
        last_char(&page)
    };
    assert_eq!(
        at(1024 - meta.len()),
        Some(READ_AS_1252),
        "ends on byte 1024"
    );
    assert_eq!(
        at(1024 - meta.len() + 1),
        Some(READ_AS_UTF8),
        "ends past byte 1024"
    );
}

#[test]
fn one_stray_byte_does_not_turn_a_utf8_page_into_windows_1252() {
    let mut page = "<p>It\u{2019}s \u{201c}fine\u{201d} \u{2014} caf\u{e9} na\u{ef}ve</p>"
        .as_bytes()
        .to_vec();
    page.extend_from_slice(b"<p>stray \xff byte</p>");
    let text = decode(&page, None, true);
    assert!(
        text.contains("It\u{2019}s \u{201c}fine\u{201d} \u{2014} caf\u{e9} na\u{ef}ve"),
        "{text}"
    );
    assert!(text.contains("stray \u{fffd} byte"));
}

#[test]
fn a_page_mostly_in_windows_1252_reads_as_windows_1252() {
    let text = decode(
        b"<p>Caf\xe9 cr\xe8me, \x93quoted\x94 and na\xefve</p>",
        None,
        true,
    );
    assert_eq!(
        text,
        "<p>Caf\u{e9} cr\u{e8}me, \u{201c}quoted\u{201d} and na\u{ef}ve</p>"
    );
}
