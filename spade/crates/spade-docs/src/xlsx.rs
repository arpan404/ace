//! Excel (XLSX): each sheet under `## <name>`, one tab-separated line per row. Shared and inline
//! strings are resolved; numbers come as written and formulas as their cached values.

use quick_xml::events::Event;

use crate::xml::{attribute, damaged, reader, text};
use crate::zipped::Parts;
use crate::{DocError, Extracted, Kind, Limits};

/// The widest row kept; cells past this column are left out.
const MOST_COLUMNS: usize = 1_000;

pub fn read(bytes: &[u8], limits: &Limits) -> Result<Extracted, DocError> {
    let mut parts = Parts::open(bytes, limits)?;
    let sheets = sheets(&parts.text("xl/workbook.xml")?)?;
    let targets = match parts.read("xl/_rels/workbook.xml.rels")? {
        Some(rels) => relationships(&String::from_utf8_lossy(&rels))?,
        None => Vec::new(),
    };
    let shared = match parts.read("xl/sharedStrings.xml")? {
        Some(xml) => shared_strings(&String::from_utf8_lossy(&xml), limits)?,
        None => Vec::new(),
    };
    let mut out = String::new();
    let mut cells = 0usize;
    let mut cut = false;
    for (name, id) in &sheets {
        let Some(target) = targets.iter().find(|(rel, _)| rel == id).map(|(_, t)| t) else {
            continue;
        };
        let path = part_path(target);
        let Some(xml) = parts.read(&path)? else {
            continue;
        };
        out.push_str(&format!("## {name}\n"));
        cut |= sheet(
            &String::from_utf8_lossy(&xml),
            &shared,
            &mut cells,
            &mut out,
            limits,
        )?;
        out.push('\n');
        if cut {
            break;
        }
    }
    Ok(Extracted {
        kind: Kind::Xlsx,
        text: out,
        pages: None,
        sheets: u32::try_from(sheets.len()).ok(),
        cut,
    })
}

/// A relationship target as a path inside the ZIP.
fn part_path(target: &str) -> String {
    match target.strip_prefix('/') {
        Some(absolute) => absolute.to_owned(),
        None => format!("xl/{target}"),
    }
}

/// Each sheet's name and relationship id, in the workbook's order.
fn sheets(xml: &str) -> Result<Vec<(String, String)>, DocError> {
    let mut reader = reader(xml);
    let mut out = Vec::new();
    loop {
        match reader.read_event().map_err(|e| damaged(&e))? {
            Event::Eof => break,
            Event::Start(e) | Event::Empty(e) if e.local_name().into_inner() == "sheet" => {
                if let (Some(name), Some(id)) = (attribute(&e, "name"), attribute(&e, "id")) {
                    out.push((name, id));
                }
            }
            _ => {}
        }
    }
    Ok(out)
}

fn relationships(xml: &str) -> Result<Vec<(String, String)>, DocError> {
    let mut reader = reader(xml);
    let mut out = Vec::new();
    loop {
        match reader.read_event().map_err(|e| damaged(&e))? {
            Event::Eof => break,
            Event::Start(e) | Event::Empty(e) if e.local_name().into_inner() == "Relationship" => {
                if let (Some(id), Some(target)) = (attribute(&e, "Id"), attribute(&e, "Target")) {
                    out.push((id, target));
                }
            }
            _ => {}
        }
    }
    Ok(out)
}

/// The shared strings, each `si`'s text runs joined; phonetic runs (`rPh`) left out.
fn shared_strings(xml: &str, limits: &Limits) -> Result<Vec<String>, DocError> {
    let mut reader = reader(xml);
    let mut out = Vec::new();
    let mut current = String::new();
    let mut in_text = false;
    let mut phonetic = 0usize;
    loop {
        let event = reader.read_event().map_err(|e| damaged(&e))?;
        match &event {
            Event::Eof => break,
            Event::Start(e) => match e.local_name().into_inner() {
                "t" => in_text = true,
                "rPh" => phonetic += 1,
                _ => {}
            },
            Event::End(e) => match e.local_name().into_inner() {
                "t" => in_text = false,
                "rPh" => phonetic = phonetic.saturating_sub(1),
                "si" => {
                    out.push(std::mem::take(&mut current));
                    if out.len() > limits.cells {
                        return Err(DocError::TooManyCells(limits.cells));
                    }
                }
                _ => {}
            },
            Event::Empty(e) if e.local_name().into_inner() == "si" => out.push(String::new()),
            _ if in_text && phonetic == 0 => {
                if let Some(words) = text(&event) {
                    current.push_str(&words);
                }
            }
            _ => {}
        }
    }
    Ok(out)
}

/// The zero-based column of a cell reference such as `C7`.
fn column(reference: &str) -> Option<usize> {
    let letters: Vec<u8> = reference
        .bytes()
        .take_while(u8::is_ascii_alphabetic)
        .collect();
    if letters.is_empty() || letters.len() > 3 {
        return None;
    }
    let mut n = 0usize;
    for letter in letters {
        n = n * 26 + usize::from(letter.to_ascii_uppercase() - b'A') + 1;
    }
    Some(n - 1)
}

/// One cell being read: its column, type and value so far.
#[derive(Default)]
struct Cell {
    column: usize,
    kind: String,
    value: String,
}

/// Appends one sheet's rows to `out`. Answers whether the text reached its cap.
fn sheet(
    xml: &str,
    shared: &[String],
    cells: &mut usize,
    out: &mut String,
    limits: &Limits,
) -> Result<bool, DocError> {
    let mut reader = reader(xml);
    let mut row: Vec<String> = Vec::new();
    let mut cell: Option<Cell> = None;
    let mut in_value = false;
    // Bytes the row holds so far: every value is charged before it is copied in, so neither a
    // shared string repeated in many cells nor a long inline value can build a row past the cap.
    let mut row_bytes = 0usize;
    loop {
        let room = limits
            .text_bytes
            .saturating_sub(out.len())
            .saturating_sub(row_bytes);
        let event = reader.read_event().map_err(|e| damaged(&e))?;
        match &event {
            Event::Eof => break,
            Event::Start(e) => match e.local_name().into_inner() {
                "c" => {
                    let column = attribute(e, "r")
                        .and_then(|r| column(&r))
                        .unwrap_or(row.len());
                    cell = Some(Cell {
                        column,
                        kind: attribute(e, "t").unwrap_or_default(),
                        value: String::new(),
                    });
                }
                "v" | "t" => in_value = true,
                _ => {}
            },
            Event::End(e) => match e.local_name().into_inner() {
                "v" | "t" => in_value = false,
                "c" => {
                    if let Some(done) = cell.take() {
                        *cells += 1;
                        if *cells > limits.cells {
                            return Err(DocError::TooManyCells(limits.cells));
                        }
                        let (added, full) = place(&mut row, done, shared, room);
                        row_bytes += added;
                        if full {
                            out.push_str(row.join("\t").trim_end());
                            return Ok(true);
                        }
                    }
                }
                "row" => {
                    out.push_str(row.join("\t").trim_end());
                    out.push('\n');
                    row.clear();
                    row_bytes = 0;
                    if out.len() >= limits.text_bytes {
                        return Ok(true);
                    }
                }
                _ => {}
            },
            _ if in_value => {
                if let (Some(cell), Some(words)) = (cell.as_mut(), text(&event)) {
                    // An inline value never grows past what the text still has room for.
                    let left = room.saturating_sub(cell.value.len());
                    cell.value.push_str(prefix(&words, left));
                }
            }
            _ => {}
        }
    }
    Ok(false)
}

/// The longest start of `text` that fits in `room` bytes, on a character boundary.
fn prefix(text: &str, room: usize) -> &str {
    if text.len() <= room {
        return text;
    }
    let mut end = room;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// Puts a finished cell's shown value in its column, copying at most `room` bytes of it. Answers
/// the bytes the row grew by (the value and the tabs before it) and whether the text is full.
fn place(row: &mut Vec<String>, cell: Cell, shared: &[String], room: usize) -> (usize, bool) {
    if cell.column >= MOST_COLUMNS {
        return (0, false);
    }
    let value: &str = match cell.kind.as_str() {
        "s" => cell
            .value
            .trim()
            .parse::<usize>()
            .ok()
            .and_then(|i| shared.get(i))
            .map_or("", String::as_str),
        "b" if cell.value.trim() == "1" => "TRUE",
        "b" => "FALSE",
        _ => cell.value.as_str(),
    };
    // The tabs that pad the row out to this column count too.
    let padding = cell.column.saturating_sub(row.len()) + 1;
    let room = room.saturating_sub(padding);
    let kept = prefix(value, room);
    let full = kept.len() < value.len() || room == 0;
    // Tabs and line breaks inside a cell would break the row apart.
    let kept = kept.replace(['\t', '\n', '\r'], " ");
    let added = kept.len() + padding;
    if row.len() <= cell.column {
        row.resize(cell.column + 1, String::new());
    }
    row[cell.column] = kept;
    (added, full)
}
