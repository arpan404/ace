//! A spreadsheet that repeats one long shared string in many cells never builds rows past the
//! text cap: this test binary counts every allocation and caps them, so copying the string into
//! each cell before charging it would fail the allocation and abort.

use std::io::{Cursor, Write};

use spade_docs::{Limits, extract};

#[global_allocator]
static ALLOCATOR: cap::Cap<std::alloc::System> = cap::Cap::new(std::alloc::System, usize::MAX);

type Result<T = ()> = std::result::Result<T, Box<dyn std::error::Error>>;

fn zip(parts: &[(&str, &[u8])]) -> Result<Vec<u8>> {
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    for (name, bytes) in parts {
        writer.start_file(*name, options)?;
        writer.write_all(bytes)?;
    }
    Ok(writer.finish()?.into_inner())
}

#[test]
fn a_shared_string_repeated_in_every_cell_is_charged_before_it_is_copied() -> Result {
    // One 2 MB shared string, used by 1,000 cells of one row: 2 GB if each were copied in.
    // Letters from a fixed sequence, so it barely compresses and stays within the ratio cap.
    let mut state = 7u32;
    let long: String = (0..2 * 1024 * 1024)
        .map(|_| {
            state = state.wrapping_mul(1_103_515_245).wrapping_add(12_345);
            char::from(b'a' + u8::try_from((state >> 16) % 26).unwrap_or(0))
        })
        .collect();
    let shared = format!("<sst><si><t>{long}</t></si></sst>");
    let cells: String = (0..1_000).map(|_| "<c t=\"s\"><v>0</v></c>").collect();
    let sheet = format!("<worksheet><sheetData><row>{cells}</row></sheetData></worksheet>");
    let bytes = zip(&[
        (
            "xl/workbook.xml",
            br#"<workbook><sheets><sheet name="S" r:id="rId1"/></sheets></workbook>"#,
        ),
        (
            "xl/_rels/workbook.xml.rels",
            br#"<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>"#,
        ),
        ("xl/sharedStrings.xml", shared.as_bytes()),
        ("xl/worksheets/sheet1.xml", sheet.as_bytes()),
    ])?;
    let _ = ALLOCATOR.set_limit(ALLOCATOR.allocated() + 256 * 1024 * 1024);
    let doc = extract(&bytes, "wide.xlsx", &Limits::default())?;
    assert!(doc.cut);
    assert!(
        doc.text.len() <= Limits::default().text_bytes,
        "{}",
        doc.text.len()
    );
    Ok(())
}
