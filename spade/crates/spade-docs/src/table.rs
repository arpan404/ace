//! CSV and TSV: one tab-separated line per record. A file the CSV reader cannot follow is read as
//! plain text instead.

use crate::{DocError, Extracted, Kind, Limits};

pub fn read(bytes: &[u8], kind: Kind, limits: &Limits) -> Result<Extracted, DocError> {
    let delimiter = if kind == Kind::Tsv { b'\t' } else { b',' };
    let mut reader = csv::ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .delimiter(delimiter)
        .from_reader(bytes);
    let mut out = String::new();
    let mut cells = 0usize;
    let mut cut = false;
    for record in reader.records() {
        let Ok(record) = record else {
            return Ok(crate::text::read_as(bytes, kind));
        };
        cells += record.len();
        if cells > limits.cells {
            return Err(DocError::TooManyCells(limits.cells));
        }
        let line: Vec<String> = record
            .iter()
            .map(|field| field.replace(['\t', '\n', '\r'], " "))
            .collect();
        out.push_str(line.join("\t").trim_end());
        out.push('\n');
        if out.len() > limits.text_bytes {
            cut = true;
            break;
        }
    }
    Ok(Extracted {
        kind,
        text: out,
        pages: None,
        sheets: None,
        cut,
    })
}
