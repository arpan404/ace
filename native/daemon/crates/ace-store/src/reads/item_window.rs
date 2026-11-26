// SPDX-License-Identifier: Apache-2.0
//! `items.window` (T4): one contiguous window of a thread's items around a target, the read a
//! long transcript's jump lands with. Ports `ItemStore.window` and
//! `LongThreadQueries.itemsWindow`/`wholeTurns`.
//!
//! The window reads the target first, so a byte-limited one always includes the jump point, then
//! alternates older and newer neighbours until the budget is reached. A neighbour that fits a
//! window of its own waits for the next one; an item larger than any window comes reduced to an
//! eighth of one, so a window that starts at it still reaches older items; when even that cannot
//! be shown as the target, the read fails. `itemsBefore`/`itemsAfter` say whether the next page
//! exists, and `omitted` lists the items shown reduced, by sequence.

use std::sync::Arc;

use ace_json::{JsString, Map, Number, Value as Json};

use crate::reads::item_page_sql::SqlItemPage;
use crate::reads::items::{ItemPageSource, PageError, bounded_item_page, json_bytes};
use crate::reads::stored::Trust;
use crate::{Connection, Value as SqlValue};

/// The window's budget: one megabyte, as the daemon asks for.
pub const WINDOW_BYTES: usize = 1024 * 1024;

/// Where the window goes: one target, as the request's three optional fields allow.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WindowTarget {
    /// `aroundSeq`: the first item at or after it, else the newest.
    Around(u64),
    /// `itemId`: that item's creation sequence; a missing item gives an empty window.
    Item(String),
    /// `turnOrdinal`: the first item of that turn in the long-thread index.
    Turn(u64),
}

/// One window request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ItemWindowRequest {
    pub thread_id: String,
    pub target: WindowTarget,
    pub before: usize,
    pub after: usize,
    pub byte_limit: usize,
    pub whole_turns: bool,
}

/// Why a window could not be read. The socket answers the read's failure; these name what the
/// TypeScript throws (`turn_target_unavailable`, `Item detail exceeds window capacity`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WindowError {
    TurnUnavailable,
    ItemTooLarge,
    Store(String),
}

impl From<PageError> for WindowError {
    fn from(error: PageError) -> WindowError {
        match error {
            PageError::Store(message) => WindowError::Store(message),
            PageError::MissingItem => WindowError::Store("missing item".to_owned()),
            PageError::Capacity => WindowError::ItemTooLarge,
        }
    }
}

/// One page of a window, as the wire carries it without `type`, `requestId` and `seq`.
#[derive(Debug, Clone, PartialEq)]
pub struct ItemWindow {
    pub target_seq: Option<u64>,
    pub items: Vec<Json>,
    pub item_seqs: Map,
    pub items_before: Option<u64>,
    pub items_after: Option<u64>,
    pub omitted: Vec<Json>,
}

impl ItemWindow {
    /// The response object, in the schema's order, for a caller to add `type`, `requestId`, `seq`.
    pub fn to_value(&self, thread_id: &str) -> Json {
        let mut out = Map::with_capacity(7);
        out.insert("threadId", Json::String(JsString::from(thread_id)));
        out.insert(
            "targetSeq",
            match self.target_seq {
                Some(seq) => Json::Number(Number::from(seq)),
                None => Json::Null,
            },
        );
        out.insert("items", Json::Array(self.items.clone().into()));
        out.insert("itemSeqs", Json::Object(self.item_seqs.clone()));
        out.insert(
            "itemsBefore",
            match self.items_before {
                Some(seq) => Json::Number(Number::from(seq)),
                None => Json::Null,
            },
        );
        out.insert(
            "itemsAfter",
            match self.items_after {
                Some(seq) => Json::Number(Number::from(seq)),
                None => Json::Null,
            },
        );
        if !self.omitted.is_empty() {
            out.insert("omitted", Json::Array(self.omitted.clone().into()));
        }
        Json::Object(out)
    }

    fn empty() -> ItemWindow {
        ItemWindow {
            target_seq: None,
            items: Vec::new(),
            item_seqs: Map::new(),
            items_before: None,
            items_after: None,
            omitted: Vec::new(),
        }
    }
}

/// Reads one window from the store.
pub fn items_window(
    conn: Arc<Connection>,
    request: &ItemWindowRequest,
    trust: &Trust,
) -> Result<ItemWindow, WindowError> {
    let page = SqlItemPage::new(conn.clone(), &request.thread_id, trust.clone());
    let target = match &request.target {
        WindowTarget::Around(around) => target_around(&page, *around)?,
        WindowTarget::Item(item) => target_item(&page, item)?,
        WindowTarget::Turn(ordinal) => target_turn(&page, *ordinal)?,
    };
    let Some(target_seq) = target else {
        return Ok(ItemWindow::empty());
    };
    let older = head_seqs(
        &page,
        "SELECT created_seq FROM item_heads WHERE thread_id=? AND created_seq<? ORDER BY created_seq DESC LIMIT ?",
        target_seq,
        request.before,
    )?;
    let newer = head_seqs(
        &page,
        "SELECT created_seq FROM item_heads WHERE thread_id=? AND created_seq>? ORDER BY created_seq LIMIT ?",
        target_seq,
        request.after,
    )?;
    let mut bytes = 512_usize;
    let mut selected: Vec<(u64, Json)> = Vec::new();
    let mut omitted: Vec<Json> = Vec::new();
    let mut add = |seq: u64| -> Result<bool, WindowError> {
        let fits = match page.page(
            seq + 1,
            1,
            (request.byte_limit as isize - bytes as isize + 512).max(0) as usize,
        ) {
            Ok(rows) => rows,
            Err(PageError::Capacity) => {
                // A neighbour that fits a window of its own waits for the next window.
                if seq != target_seq && fits_alone(&page, seq, request.byte_limit)? {
                    return Ok(false);
                }
                // Larger than any window: an eighth of one, leaving room for its neighbours.
                let reduced_budget = (request.byte_limit as isize - bytes as isize)
                    .min((request.byte_limit / 8) as isize)
                    + 512;
                let reduced = bounded_item_page(
                    &page,
                    &request.thread_id,
                    seq + 1,
                    1,
                    reduced_budget.max(0) as usize,
                )?;
                let items = match reduced.get("items") {
                    Some(Json::Array(items)) => items.to_vec(),
                    _ => Vec::new(),
                };
                let marks = match reduced.get("omitted") {
                    Some(Json::Array(marks)) => marks.to_vec(),
                    _ => Vec::new(),
                };
                let Some(item) = items.into_iter().next() else {
                    if seq == target_seq {
                        return Err(WindowError::ItemTooLarge);
                    }
                    return Ok(false);
                };
                for mark in &marks {
                    omitted.push(mark.clone());
                }
                bytes += size_of(&item, &marks);
                selected.push((seq, item));
                return Ok(true);
            }
            Err(error) => return Err(error.into()),
        };
        let Some(item) = fits.items.into_iter().next() else {
            return Ok(false);
        };
        let marks: Vec<Json> = Vec::new();
        bytes += size_of(&item, &marks);
        selected.push((seq, item));
        Ok(true)
    };
    if !add(target_seq)? {
        return Err(WindowError::ItemTooLarge);
    }
    let mut left = 0;
    let mut right = 0;
    while left < older.len() || right < newer.len() {
        if let Some(seq) = older.get(left).copied() {
            if !add(seq)? {
                break;
            }
            left += 1;
        }
        if let Some(seq) = newer.get(right).copied() {
            if !add(seq)? {
                break;
            }
            right += 1;
        }
    }
    selected.sort_by_key(|(seq, _)| *seq);
    let first = selected.first().map(|(seq, _)| *seq).unwrap_or(target_seq);
    let last = selected.last().map(|(seq, _)| *seq).unwrap_or(target_seq);
    let items_before = head_exists(&page, first, true)?.then_some(first);
    let items_after = head_exists(&page, last, false)?.then_some(last);
    let mut item_seqs = Map::with_capacity(selected.len());
    let mut items: Vec<Json> = Vec::with_capacity(selected.len());
    for (seq, item) in &selected {
        if let Some(Json::String(id)) = item.get("id") {
            item_seqs.insert(id.clone(), Json::Number(Number::from(*seq)));
        }
        // `ItemsWindowResponse.parse` walks every item through the schema, so a trusted row's
        // stored order and extras read as a validated item here too.
        let shaped = crate::reads::stored::decode_item(item)
            .map_err(|_| WindowError::Store("invalid window item".to_owned()))?;
        items.push(shaped);
    }
    omitted.sort_by_key(|mark| {
        mark.get("seq")
            .and_then(|seq| match seq {
                Json::Number(seen) => Some(seen.value() as u64),
                _ => None,
            })
            .unwrap_or(0)
    });
    let mut window = ItemWindow {
        target_seq: Some(target_seq),
        items,
        item_seqs,
        items_before,
        items_after,
        omitted,
    };
    if request.whole_turns {
        window = whole_turns(&page, window)?;
    }
    Ok(window)
}

fn size_of(item: &Json, marks: &[Json]) -> usize {
    let id = match item.get("id") {
        Some(id) => id.clone(),
        None => Json::Null,
    };
    json_bytes(item)
        + json_bytes(&id)
        + 64
        + if marks.is_empty() {
            0
        } else {
            json_bytes(&Json::Array(marks.to_vec().into()))
        }
}

fn target_around(page: &SqlItemPage, around: u64) -> Result<Option<u64>, WindowError> {
    let rows = page.query_thread(
        "SELECT created_seq FROM item_heads WHERE thread_id=? AND created_seq>=? ORDER BY created_seq LIMIT 1",
        &[SqlValue::Integer(around as i64)],
    )?;
    if let Some(seq) = rows.first().and_then(|row| int_cell(row, 0)) {
        return Ok(Some(seq));
    }
    let newest = page.query_thread(
        "SELECT created_seq FROM item_heads WHERE thread_id=? ORDER BY created_seq DESC LIMIT 1",
        &[],
    )?;
    Ok(newest.first().and_then(|row| int_cell(row, 0)))
}

fn target_item(page: &SqlItemPage, item: &str) -> Result<Option<u64>, WindowError> {
    let rows = page.query_thread(
        "SELECT created_seq FROM item_heads WHERE thread_id=? AND id=?",
        &[SqlValue::Text(item.to_owned())],
    )?;
    Ok(rows.first().and_then(|row| int_cell(row, 0)))
}

fn target_turn(page: &SqlItemPage, ordinal: u64) -> Result<Option<u64>, WindowError> {
    let rows = page.query_thread(
        "SELECT MIN(i.created_seq) FROM long_items i JOIN item_heads h ON h.id=i.item_id AND h.thread_id=i.thread_id WHERE i.thread_id=? AND i.ordinal=?",
        &[SqlValue::Integer(ordinal as i64)],
    )?;
    match rows.first().and_then(|row| int_cell(row, 0)) {
        Some(seq) => Ok(Some(seq)),
        None => Err(WindowError::TurnUnavailable),
    }
}

fn head_seqs(
    page: &SqlItemPage,
    sql: &str,
    around: u64,
    limit: usize,
) -> Result<Vec<u64>, WindowError> {
    let rows = page.query_thread(
        sql,
        &[
            SqlValue::Integer(around as i64),
            SqlValue::Integer(limit as i64),
        ],
    )?;
    Ok(rows.iter().filter_map(|row| int_cell(row, 0)).collect())
}

fn head_exists(page: &SqlItemPage, at: u64, older: bool) -> Result<bool, WindowError> {
    let sql = if older {
        "SELECT 1 FROM item_heads WHERE thread_id=? AND created_seq<? LIMIT 1"
    } else {
        "SELECT 1 FROM item_heads WHERE thread_id=? AND created_seq>? LIMIT 1"
    };
    let rows = page.query_thread(sql, &[SqlValue::Integer(at as i64)])?;
    Ok(!rows.is_empty())
}

fn fits_alone(page: &SqlItemPage, seq: u64, byte_limit: usize) -> Result<bool, WindowError> {
    match page.page(seq + 1, 1, byte_limit) {
        Ok(_) => Ok(true),
        Err(PageError::Capacity) => Ok(false),
        Err(error) => Err(error.into()),
    }
}

/// `wholeTurns`: the window's older edge moved to where the oldest turn that starts inside it
/// starts, so no turn is split; at least one older item stays, so paging older always moves.
fn whole_turns(page: &SqlItemPage, window: ItemWindow) -> Result<ItemWindow, WindowError> {
    let Some(first) = window.items.first() else {
        return Ok(window);
    };
    let Some(Json::String(first_id)) = first.get("id") else {
        return Ok(window);
    };
    let Some(first_seq) = window
        .item_seqs
        .get(first_id.as_str())
        .and_then(|seq| match seq {
            Json::Number(seen) => Some(seen.value() as u64),
            _ => None,
        })
    else {
        return Ok(window);
    };
    let Some(target_seq) = window.target_seq else {
        return Ok(window);
    };
    if window.items_before.is_none() {
        return Ok(window);
    }
    let own = page.query_thread(
        "SELECT start_seq FROM long_turns WHERE thread_id=? AND start_seq<=? ORDER BY start_seq DESC LIMIT 1",
        &[SqlValue::Integer(first_seq as i64)],
    )?;
    let previous = page.query_thread(
        "SELECT created_seq FROM item_heads WHERE thread_id=? AND created_seq<? ORDER BY created_seq DESC LIMIT 1",
        &[SqlValue::Integer(first_seq as i64)],
    )?;
    let own_start = own.first().and_then(|row| int_cell(row, 0));
    let previous_seq = previous
        .first()
        .and_then(|row| int_cell(row, 0))
        .unwrap_or(0);
    if own_start.is_some_and(|start| start > previous_seq) {
        return Ok(window);
    }
    let mut newest_older: Option<u64> = None;
    for item in &window.items {
        let Some(Json::String(id)) = item.get("id") else {
            continue;
        };
        if let Some(seq) = window.item_seqs.get(id.as_str()).and_then(|seq| match seq {
            Json::Number(seen) => Some(seen.value() as u64),
            _ => None,
        }) && seq < target_seq
        {
            newest_older = Some(seq);
        }
    }
    let Some(newest_older) = newest_older else {
        return Ok(window);
    };
    let row = page.query_thread(
        "SELECT start_seq FROM long_turns WHERE thread_id=? AND start_seq>? AND start_seq<=? ORDER BY start_seq LIMIT 1",
        &[
            SqlValue::Integer(first_seq as i64),
            SqlValue::Integer(newest_older as i64),
        ],
    )?;
    let Some(start) = row.first().and_then(|row| int_cell(row, 0)) else {
        return Ok(window);
    };
    let kept: Vec<Json> = window
        .items
        .iter()
        .filter(|item| {
            let Some(Json::String(id)) = item.get("id") else {
                return false;
            };
            window
                .item_seqs
                .get(id.as_str())
                .and_then(|seq| match seq {
                    Json::Number(seen) => Some(seen.value() as u64),
                    _ => None,
                })
                .unwrap_or(0)
                >= start
        })
        .cloned()
        .collect();
    let mut item_seqs = Map::with_capacity(kept.len());
    for item in &kept {
        if let Some(Json::String(id)) = item.get("id")
            && let Some(seq) = window.item_seqs.get(id.as_str())
        {
            item_seqs.insert(id.clone(), seq.clone());
        }
    }
    let items_before = match kept.first() {
        Some(first) => {
            let seq = match first.get("id") {
                Some(Json::String(id)) => {
                    window.item_seqs.get(id.as_str()).and_then(|seq| match seq {
                        Json::Number(seen) => Some(seen.value() as u64),
                        _ => None,
                    })
                }
                _ => None,
            };
            Some(seq.unwrap_or(start))
        }
        None => Some(start),
    };
    let omitted = window
        .omitted
        .into_iter()
        .filter(|mark| {
            mark.get("seq")
                .and_then(|seq| match seq {
                    Json::Number(seen) => Some(seen.value() as u64),
                    _ => None,
                })
                .unwrap_or(0)
                >= start
        })
        .collect();
    Ok(ItemWindow {
        target_seq: window.target_seq,
        items: kept,
        item_seqs,
        items_before,
        items_after: window.items_after,
        omitted,
    })
}

fn int_cell(row: &[SqlValue], index: usize) -> Option<u64> {
    match row.get(index) {
        Some(SqlValue::Integer(value)) => Some(*value as u64),
        Some(SqlValue::Real(value)) => Some(*value as u64),
        _ => None,
    }
}
