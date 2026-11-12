use std::io::{Cursor, Write};

use pdf_extract::content::{Content, Operation};
use pdf_extract::{Document, Object, Stream, dictionary};

use super::*;

type Result<T = ()> = std::result::Result<T, Box<dyn std::error::Error>>;

/// A PDF with one line of text on each page, plus `extra` streams nothing shows.
fn pdf(pages: &[&str], extra: Vec<Stream>) -> Result<Vec<u8>> {
    let mut doc = Document::with_version("1.5");
    let pages_id = doc.new_object_id();
    let font = doc.add_object(dictionary! {
        "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Courier",
    });
    let resources = doc.add_object(dictionary! { "Font" => dictionary! { "F1" => font } });
    let mut kids: Vec<Object> = Vec::new();
    for text in pages {
        let content = Content {
            operations: vec![
                Operation::new("BT", vec![]),
                Operation::new("Tf", vec!["F1".into(), 12.into()]),
                Operation::new("Td", vec![72.into(), 720.into()]),
                Operation::new("Tj", vec![Object::string_literal(*text)]),
                Operation::new("ET", vec![]),
            ],
        };
        let contents = doc.add_object(Stream::new(dictionary! {}, content.encode()?));
        let page = doc.add_object(dictionary! {
            "Type" => "Page", "Parent" => pages_id, "Contents" => contents,
        });
        kids.push(page.into());
    }
    for stream in extra {
        doc.add_object(stream);
    }
    let count = i64::try_from(kids.len())?;
    doc.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! {
            "Type" => "Pages", "Kids" => kids, "Count" => count, "Resources" => resources,
            "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
        }),
    );
    let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
    doc.trailer.set("Root", catalog);
    let mut out = Vec::new();
    doc.save_to(&mut out)?;
    Ok(out)
}

fn zlib(bytes: &[u8]) -> Result<Vec<u8>> {
    let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::best());
    encoder.write_all(bytes)?;
    Ok(encoder.finish()?)
}

fn ascii85(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    for chunk in bytes.chunks(4) {
        let mut word = [0u8; 4];
        word[..chunk.len()].copy_from_slice(chunk);
        let mut value = u32::from_be_bytes(word);
        if chunk.len() == 4 && value == 0 {
            out.push(b'z');
            continue;
        }
        let mut digits = [0u8; 5];
        for digit in digits.iter_mut().rev() {
            *digit = u8::try_from(value % 85).unwrap_or(0) + b'!';
            value /= 85;
        }
        out.extend_from_slice(&digits[..chunk.len() + 1]);
    }
    out.extend_from_slice(b"~>");
    out
}

/// A ZIP holding `parts`, deflated.
fn zip(parts: &[(&str, &[u8])]) -> Result<Vec<u8>> {
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .large_file(false);
    for (name, bytes) in parts {
        writer.start_file(*name, options)?;
        writer.write_all(bytes)?;
    }
    Ok(writer.finish()?.into_inner())
}

fn docx(body: &str) -> Result<Vec<u8>> {
    let xml = format!(
        r#"<?xml version="1.0"?><w:document xmlns:w="w"><w:body>{body}</w:body></w:document>"#
    );
    zip(&[("word/document.xml", xml.as_bytes())])
}

const WORKBOOK: &str = r#"<workbook xmlns:r="r"><sheets>
<sheet name="Costs" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="2" r:id="rId2"/>
</sheets></workbook>"#;
const RELS: &str = r#"<Relationships>
<Relationship Id="rId1" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/>
</Relationships>"#;

fn xlsx(sheet1: &str, sheet2: &str) -> Result<Vec<u8>> {
    let shared = r#"<sst><si><t>Item</t></si><si><r><t>Ca</t></r><r><t>ble</t></r><rPh><t>x</t></rPh></si></sst>"#;
    zip(&[
        ("xl/workbook.xml", WORKBOOK.as_bytes()),
        ("xl/_rels/workbook.xml.rels", RELS.as_bytes()),
        ("xl/sharedStrings.xml", shared.as_bytes()),
        ("xl/worksheets/sheet1.xml", sheet1.as_bytes()),
        ("xl/worksheets/sheet2.xml", sheet2.as_bytes()),
    ])
}

fn read(bytes: &[u8], name: &str) -> std::result::Result<Extracted, DocError> {
    extract(bytes, name, &Limits::default())
}

#[test]
fn a_pdf_is_read_page_by_page_with_its_page_count() -> Result {
    let doc = read(
        &pdf(&["Quarterly revenue rose", "Costs fell sharply"], vec![])?,
        "q.pdf",
    )?;
    assert_eq!(doc.kind, Kind::Pdf);
    assert_eq!(doc.pages, Some(2));
    let first = doc
        .text
        .find("Quarterly revenue rose")
        .ok_or("page one missing")?;
    let second = doc
        .text
        .find("Costs fell sharply")
        .ok_or("page two missing")?;
    assert!(first < second, "{}", doc.text);
    assert!(!doc.cut);
    Ok(())
}

#[test]
fn a_pdf_with_more_pages_than_allowed_is_refused() -> Result {
    let bytes = pdf(&["a", "b", "c", "d"], vec![])?;
    let limits = Limits {
        pages: 3,
        ..Limits::default()
    };
    assert_eq!(
        extract(&bytes, "big.pdf", &limits),
        Err(DocError::TooManyPages(3))
    );
    Ok(())
}

#[test]
fn a_pdf_stream_that_inflates_too_far_is_refused_before_parsing() -> Result {
    let bomb = Stream::new(
        dictionary! { "Filter" => "FlateDecode" },
        zlib(&vec![0u8; 8 * 1024 * 1024])?,
    );
    assert_eq!(
        read(&pdf(&["hello"], vec![bomb])?, "bomb.pdf"),
        Err(DocError::Expands)
    );
    // The same bomb wrapped in ASCII85 first: the chain is followed.
    let wrapped = Stream::new(
        dictionary! { "Filter" => vec!["ASCII85Decode".into(), "FlateDecode".into()] },
        ascii85(&zlib(&vec![0u8; 8 * 1024 * 1024])?),
    );
    assert_eq!(
        read(&pdf(&["hello"], vec![wrapped])?, "wrapped.pdf"),
        Err(DocError::Expands)
    );
    // An ordinary compressed stream is fine.
    let normal = Stream::new(
        dictionary! { "Filter" => "FlateDecode" },
        zlib(b"BT /F1 12 Tf (fine) Tj ET")?,
    );
    assert!(read(&pdf(&["hello"], vec![normal])?, "ok.pdf").is_ok());
    Ok(())
}

#[test]
fn a_word_document_gives_its_paragraphs_tabs_and_tables() -> Result {
    let body = r#"<w:p><w:r><w:t>Terms &amp; conditions</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">Name:</w:t><w:tab/><w:t>Ada</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Qty</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Price</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<w:p><w:r><w:instrText>PAGE</w:instrText><w:t>End</w:t></w:r></w:p>"#;
    let doc = read(&docx(body)?, "terms.docx")?;
    assert_eq!(doc.kind, Kind::Docx);
    assert!(
        doc.text.starts_with("Terms & conditions\nName:\tAda\n"),
        "{:?}",
        doc.text
    );
    assert!(doc.text.contains("Qty"), "{:?}", doc.text);
    assert!(doc.text.contains("Price"), "{:?}", doc.text);
    assert!(doc.text.ends_with("End"), "{:?}", doc.text);
    assert!(
        !doc.text.contains("PAGE"),
        "field codes are not words: {:?}",
        doc.text
    );
    Ok(())
}

#[test]
fn a_spreadsheet_gives_each_sheet_as_tab_separated_rows() -> Result {
    let sheet1 = r#"<worksheet><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="inlineStr"><is><t>Total</t></is></c></row>
<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>12.5</v></c><c r="C2" t="b"><v>1</v></c></row>
</sheetData></worksheet>"#;
    let sheet2 = r#"<worksheet><sheetData><row r="1"><c r="B1" t="str"><f>A1</f><v>see costs</v></c></row></sheetData></worksheet>"#;
    let doc = read(&xlsx(sheet1, sheet2)?, "book.xlsx")?;
    assert_eq!(doc.kind, Kind::Xlsx);
    assert_eq!(doc.sheets, Some(2));
    assert_eq!(
        doc.text,
        "## Costs\nItem\t\tTotal\nCable\t12.5\tTRUE\n\n## Notes\n\tsee costs"
    );
    Ok(())
}

#[test]
fn a_spreadsheet_with_more_cells_than_allowed_is_refused() -> Result {
    let row: String = (0..30)
        .map(|i| format!("<c r=\"A{i}\"><v>{i}</v></c>"))
        .collect();
    let sheet = format!("<worksheet><sheetData><row>{row}</row></sheetData></worksheet>");
    let limits = Limits {
        cells: 20,
        ..Limits::default()
    };
    assert_eq!(
        extract(&xlsx(&sheet, "<worksheet/>")?, "big.xlsx", &limits),
        Err(DocError::TooManyCells(20))
    );
    Ok(())
}

#[test]
fn a_zip_bomb_is_refused_however_its_header_describes_it() -> Result {
    let mut bomb = String::from("<w:document><w:body><w:p><w:r><w:t>");
    bomb.push_str(&" ".repeat(8 * 1024 * 1024));
    bomb.push_str("</w:t></w:r></w:p></w:body></w:document>");
    let bytes = zip(&[("word/document.xml", bomb.as_bytes())])?;
    assert_eq!(read(&bytes, "bomb.docx"), Err(DocError::Expands));

    // The same file with both headers claiming the part is 100 bytes: still never read whole.
    let mut lying = bytes.clone();
    let size = u32::try_from(bomb.len())?.to_le_bytes();
    let mut at = 0;
    while let Some(found) = lying[at..].windows(4).position(|w| w == size) {
        lying[at + found..at + found + 4].copy_from_slice(&100u32.to_le_bytes());
        at += found + 4;
    }
    assert!(read(&lying, "lying.docx").is_err());
    Ok(())
}

#[test]
fn a_zip_with_too_many_entries_is_refused() -> Result {
    let names: Vec<String> = (0..12).map(|i| format!("f{i}.xml")).collect();
    let mut parts: Vec<(&str, &[u8])> = names.iter().map(|n| (n.as_str(), &b"x"[..])).collect();
    parts.push(("word/document.xml", b"<w:document/>"));
    let limits = Limits {
        zip_entries: 10,
        ..Limits::default()
    };
    assert_eq!(
        extract(&zip(&parts)?, "many.docx", &limits),
        Err(DocError::TooManyEntries(10))
    );
    Ok(())
}

#[test]
fn csv_and_tsv_become_tab_separated_lines_and_other_text_stays_as_written() -> Result {
    let csv = read(b"name,notes\nAda,\"likes, commas\"\n", "people.csv")?;
    assert_eq!(csv.kind, Kind::Csv);
    assert_eq!(csv.text, "name\tnotes\nAda\tlikes, commas");
    let tsv = read(b"a\tb\n1\t2\n", "t.tsv")?;
    assert_eq!(tsv.text, "a\tb\n1\t2");
    let code = read(
        b"\xEF\xBB\xBFfn main() {\r\n    println!(\"hi\");   \r\n}\n",
        "main.rs",
    )?;
    assert_eq!(code.kind, Kind::Text);
    assert_eq!(code.text, "fn main() {\n    println!(\"hi\");\n}");
    Ok(())
}

#[test]
fn files_spade_does_not_read_are_refused() -> Result {
    // A legacy Word file, raw binary, and a ZIP that is neither DOCX nor XLSX.
    assert_eq!(
        read(b"\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1\x00\x00", "old.doc"),
        Err(DocError::Unsupported)
    );
    assert_eq!(
        read(&[0, 159, 146, 150], "x.bin"),
        Err(DocError::Unsupported)
    );
    let other = zip(&[("ppt/presentation.xml", b"<p/>")])?;
    assert_eq!(read(&other, "deck.pptx"), Err(DocError::Unsupported));
    assert_eq!(
        extract(
            &vec![b'a'; 2048],
            "big.txt",
            &Limits {
                file_bytes: 1024,
                ..Limits::default()
            }
        ),
        Err(DocError::TooLarge(0))
    );
    Ok(())
}

#[test]
fn text_past_the_cap_is_cut_and_marked() -> Result {
    let long = "word ".repeat(100);
    let limits = Limits {
        chars: 50,
        ..Limits::default()
    };
    let doc = extract(long.as_bytes(), "long.txt", &limits)?;
    assert!(doc.cut);
    assert!(doc.chars() <= 50, "{}", doc.chars());
    assert!(doc.text.starts_with("word word"));
    let short = extract(b"short", "s.txt", &limits)?;
    assert!(!short.cut);
    Ok(())
}

#[test]
fn the_child_side_answers_what_in_process_reading_gives() -> Result {
    let bytes = docx("<w:p><w:r><w:t>From the child</w:t></w:r></w:p>")?;
    let mut answer = Vec::new();
    assert_eq!(serve_child("a.docx", &mut bytes.as_slice(), &mut answer), 0);
    let value: serde_json::Value = serde_json::from_slice(&answer)?;
    assert_eq!(value["ok"]["text"], "From the child");
    assert_eq!(value["ok"]["kind"], "docx");

    let mut refused = Vec::new();
    serve_child("x.bin", &mut &[0u8, 1, 2][..], &mut refused);
    let value: serde_json::Value = serde_json::from_slice(&refused)?;
    assert_eq!(value["error"], "Unsupported");
    Ok(())
}

#[tokio::test]
async fn a_child_that_hangs_is_given_up_on_at_its_deadline() -> Result {
    // `sh -c 'sleep 30'` ignores its input and never answers.
    let reader = Extractor::child("/bin/sh".into(), vec!["-c".into(), "sleep 30".into()])
        .with_deadline(std::time::Duration::from_millis(500));
    let started = std::time::Instant::now();
    let result = reader.read(b"hello".to_vec(), "a.txt").await;
    assert_eq!(result, Err(DocError::TimedOut(1)));
    assert!(started.elapsed() < std::time::Duration::from_secs(5));
    Ok(())
}

#[tokio::test]
async fn in_process_reading_gives_the_same_text() -> Result {
    let doc = Extractor::in_process()
        .read(b"plain words".to_vec(), "a.md")
        .await?;
    assert_eq!(doc.text, "plain words");
    Ok(())
}
