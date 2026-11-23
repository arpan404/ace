// SPDX-License-Identifier: Apache-2.0
use super::chunks::chunk_append;
use super::fetch::Candidate;
use super::json::{J, encode_units, is_high, is_low, lossy, write_json};
use super::paging::{materialize_map, step_item};
use super::parse::parse_json;
use super::{ReadError, Result, Trust};
use crate::Connection;
use std::collections::HashMap;
use std::sync::Arc;

/// Decoded string units back to text: surrogate pairs become their character, and a lone
/// surrogate goes back to its `\uXXXX` escape, so the text stays valid UTF-8 and re-parses to
/// the same units. Structural characters pass through untouched.
pub(crate) fn units_to_text(units: &[u16]) -> String {
    let mut out = String::new();
    let mut index = 0;
    while let Some(unit) = units.get(index) {
        let unit = *unit;
        if is_high(unit) && matches!(units.get(index + 1), Some(next) if is_low(*next)) {
            let high = u32::from(unit - 0xd800);
            let low = u32::from(units[index + 1] - 0xdc00);
            if let Some(c) = char::from_u32(0x10000 + high * 0x400 + low) {
                out.push(c);
                index += 2;
                continue;
            }
        }
        if is_high(unit) || is_low(unit) {
            out.push_str(&format!("\\u{unit:04x}"));
        } else if let Some(c) = char::from_u32(u32::from(unit)) {
            out.push(c);
        } else {
            out.push(char::REPLACEMENT_CHARACTER);
        }
        index += 1;
    }
    out
}

/// A tail page from kept entries: whole items, oldest first, with the trust marks for the shell.
pub(crate) fn emit_tail(
    thread_id: &str,
    items: Vec<J>,
    seqs: Vec<(String, i64)>,
    before: Option<i64>,
    previewed: Option<String>,
    untrusted: &[String],
) -> String {
    let mut out = J::Obj(vec![
        (encode_units("threadId"), J::Str(encode_units(thread_id))),
        (encode_units("items"), J::Arr(items)),
        (
            encode_units("itemSeqs"),
            J::Obj(
                seqs.into_iter()
                    .map(|(id, seq)| (encode_units(&id), J::Num(seq.to_string())))
                    .collect(),
            ),
        ),
        (
            encode_units("itemsBefore"),
            before.map_or(J::Null, |seq| J::Num(seq.to_string())),
        ),
    ]);
    if let J::Obj(entries) = &mut out {
        if let Some(id) = previewed {
            entries.push((
                encode_units("previewed"),
                J::Arr(vec![J::Str(encode_units(&id))]),
            ));
        }
        entries.push((
            encode_units("untrusted"),
            J::Arr(
                untrusted
                    .iter()
                    .map(|id| J::Str(encode_units(id)))
                    .collect(),
            ),
        ));
    }
    let mut text = String::new();
    write_json(&mut text, &out);
    text
}

/// The union rows the shell read through the store's statements, as candidates.
pub(crate) fn parse_candidates(rows: &J) -> Result<HashMap<String, Candidate>> {
    let J::Arr(rows) = rows else {
        return Err(ReadError::Row("Invalid stored item"));
    };
    let mut out: HashMap<String, Candidate> = HashMap::new();
    for row in rows {
        let id = match row.get("id") {
            Some(J::Str(units)) => lossy(units),
            _ => return Err(ReadError::Row("Invalid stored item")),
        };
        let entry = out.entry(id).or_insert(Candidate {
            body: None,
            chunks: Vec::new(),
        });
        match row.get("kind").and_then(|kind| kind.as_int().ok()) {
            Some(0) => {
                let body = match row.get("item") {
                    Some(J::Str(units)) => units_to_text(units),
                    _ => return Err(ReadError::Row("Invalid stored item")),
                };
                let created = row
                    .get("created_seq")
                    .and_then(|created| created.as_int().ok())
                    .ok_or(ReadError::Row("Invalid stored item"))?;
                entry.body = Some((body, created));
            }
            Some(1) => {
                let seq = row
                    .get("seq")
                    .and_then(|seq| seq.as_int().ok())
                    .ok_or(ReadError::Row("Invalid stored item"))?;
                let field = match row.get("field") {
                    Some(J::Str(units)) => lossy(units),
                    _ => return Err(ReadError::Row("Invalid stored item")),
                };
                let append = match row.get("append") {
                    Some(J::Str(units)) => chunk_append(&units_to_text(units))?,
                    _ => return Err(ReadError::Row("Invalid stored item")),
                };
                entry.chunks.push((seq, field, append));
            }
            _ => return Err(ReadError::Row("Invalid stored item")),
        }
    }
    Ok(out)
}

/// A snapshot's transcript tail from rows the shell read on the store's connection: the whole
/// kept items, oldest first. The bodies and their chunks come from one statement, so the
/// shell's iteration sees a completion committed meanwhile whole or not at all.
pub fn tail_rows(
    conn: &Arc<Connection>,
    thread_id: &str,
    kept: &[(String, i64)],
    before: Option<i64>,
    preview: bool,
    rows: &str,
    trust: Trust,
) -> Result<String> {
    let mut untrusted = Vec::new();
    let kept_ids: Vec<String> = kept.iter().map(|(id, _)| id.clone()).collect();
    let mut items = Vec::new();
    let mut seqs = Vec::new();
    if preview {
        for (id, seq) in kept {
            if let Some(item) = step_item(conn, thread_id, id, trust, &mut untrusted)? {
                seqs.push((id.clone(), *seq));
                items.push(item);
            }
        }
    } else {
        let bodies = parse_candidates(&parse_json(rows)?)?;
        for (id, item) in materialize_map(&kept_ids, &bodies, trust, &mut untrusted)? {
            if let Some((_, seq)) = kept.iter().find(|(held, _)| held == &id) {
                seqs.push((id, *seq));
                items.push(item);
            }
        }
    }
    let previewed: Option<String> = if preview {
        items
            .first()
            .and_then(|item| item.get("id"))
            .and_then(|id| match id {
                J::Str(units) => Some(lossy(units)),
                _ => None,
            })
    } else {
        None
    };
    Ok(emit_tail(
        thread_id, items, seqs, before, previewed, &untrusted,
    ))
}
