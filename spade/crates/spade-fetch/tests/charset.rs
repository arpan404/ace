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
    assert_eq!(decode(meta, None, false).chars().last(), Some('\u{fffd}'));
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

#[test]
fn the_prescan_matches_whole_meta_declarations_only() {
    // é in windows-1252 is the single byte E9; in UTF-8 that byte is invalid.
    let cases: [(&[u8], char); 9] = [
        (b"<!--<meta charset=windows-1252>--><p>\xe9", '\u{fffd}'),
        (b"<!--><meta charset=windows-1252><p>\xe9", '\u{e9}'),
        (b"<meta data-charset=windows-1252><p>\xe9", '\u{fffd}'),
        (
            b"<meta content=\"text/html; charset=windows-1252\"><p>\xe9",
            '\u{fffd}',
        ),
        (
            b"<meta http-equiv=\"Content-Type\" content=\"text/html; charset=windows-1252\">\xe9",
            '\u{e9}',
        ),
        (
            b"<div title=\"<meta charset=windows-1252>\"><p>\xe9",
            '\u{fffd}',
        ),
        (b"<META CHARSET='Windows-1252'><p>\xe9", '\u{e9}'),
        (b"<meta charset=x-user-defined><p>\xe9", '\u{e9}'),
        (
            b"<meta charset=windows-1252 charset=utf-8><p>\xe9",
            '\u{e9}',
        ),
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
fn a_meta_charset_counts_only_when_it_ends_within_the_first_1024_bytes() {
    let meta = b"<meta charset=windows-1252>";
    let at = |pad: usize| {
        let mut page = vec![b' '; pad];
        page.extend_from_slice(meta);
        page.extend_from_slice(b"<p>\xe9");
        last_char(&page)
    };
    assert_eq!(at(1024 - meta.len()), Some('\u{e9}'), "ends on byte 1024");
    assert_eq!(
        at(1024 - meta.len() + 1),
        Some('\u{fffd}'),
        "ends past byte 1024"
    );
}
