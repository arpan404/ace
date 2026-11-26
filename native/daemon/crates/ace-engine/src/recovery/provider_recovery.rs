// SPDX-License-Identifier: Apache-2.0
//! A Cursor thread's committed frames and the attempt record beside them
//! (`provider-recovery.ts`, ADR 0043 and its 2026-11-22 amendment). Canonical facts already
//! committed are never reapplied: this is what a reopened host reads back, how a fresh session
//! sets the old frames aside, and how the idle sweep deletes them a bounded batch at a time
//! (ADR 0170).

use ace_json::Value;
use ace_store::{Value as Cell, stmt_cache};
use std::sync::Arc;

use super::attempt::{AttemptRecord, note_attempt};
use crate::repository::residency::cell_text;
use crate::{Core, EngineError};

/// How many of an earlier build's newest frames its first reopen reads (`provider-recovery.ts:37`).
pub const LEGACY_WINDOW: i64 = 4096;
/// The most frames one trim step deletes (`:359`).
pub const TRIM_BATCH: i64 = 256;

const READ_RECORD: &str = "SELECT value FROM engine_state_records WHERE thread_id=? AND section='cursorAttempt' AND key='latest'";
const WRITE_RECORD: &str = "INSERT INTO engine_state_records VALUES (?,'cursorAttempt','latest',?) ON CONFLICT(thread_id,section,key) DO UPDATE SET value=excluded.value";
const READ_FRAMES_RECORD: &str = "SELECT value FROM engine_state_records WHERE thread_id=? AND section='cursorFrames' AND key='root'";
const WRITE_FRAMES_RECORD: &str = "INSERT INTO engine_state_records VALUES (?,'cursorFrames','root',?) ON CONFLICT(thread_id,section,key) DO UPDATE SET value=excluded.value";
const READ_RETIRED: &str = "SELECT value FROM engine_state_records WHERE thread_id=? AND section='cursorRetired' AND key='root'";
const WRITE_RETIRED: &str = "INSERT INTO engine_state_records VALUES (?,'cursorRetired','root',?) ON CONFLICT(thread_id,section,key) DO UPDATE SET value=excluded.value";
const MARK_PRUNE: &str = "INSERT OR IGNORE INTO engine_cursor_prune VALUES (?)";
const CLEAR_PRUNE: &str = "DELETE FROM engine_cursor_prune WHERE thread_id=?";
const UNTRIMMED: &str = "SELECT thread_id FROM engine_cursor_prune LIMIT ?";
const READ_FRAME: &str =
    "SELECT rowid,frame FROM engine_provider_frames WHERE thread_id=? AND rowid=?";
const READ_FRAMES: &str = "SELECT rowid,frame FROM engine_provider_frames WHERE thread_id=? AND rowid>? ORDER BY rowid LIMIT 8";
const LAST_FRAME: &str = "SELECT MAX(rowid) AS last FROM engine_provider_frames WHERE thread_id=?";
const RECENT_KINDS: &str = "SELECT rowid, json_extract(frame,'$.data.kind') AS kind, json_extract(frame,'$.data.operationId') AS operationId, json_extract(frame,'$.data.commandId') AS commandId, json_extract(frame,'$.data.body.admitted') AS admitted, json_extract(frame,'$.data.body.commandId') AS admittedCommand FROM engine_provider_frames WHERE thread_id=? ORDER BY rowid DESC LIMIT 4097";
const TRIM_FRAMES: &str = "DELETE FROM engine_provider_frames WHERE rowid IN (SELECT rowid FROM engine_provider_frames WHERE thread_id=? AND rowid<? AND rowid<>? ORDER BY rowid LIMIT 256)";

/// Where a thread's frames stand (`FramesRecord`): the latest session's open frame, the open
/// turn's start, and whether the sweep still has frames to delete.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct FramesRecord {
    pub open: Option<i64>,
    pub below: Option<i64>,
    pub trimmed: Option<bool>,
}

/// One stored captured frame, as the daemon committed it (`CapturedFrame`).
#[derive(Debug, Clone, PartialEq)]
pub struct CapturedFrame {
    pub seq: i64,
    pub t: i64,
    pub dir: String,
    pub data: Value,
}

/// True for an error body whose saved session can never be opened again (`store-fence.ts`): a
/// checkpoint over its budget, or the translator's own fence.
fn unusable_store(message: Option<&str>) -> bool {
    let Some(message) = message else {
        return false;
    };
    let lower = message.to_lowercase();
    lower.contains("use explicit") && lower.contains("context handoff")
        || lower.contains("use bounded") && lower.contains("context handoff")
        || lower.contains("use portable") && lower.contains("context handoff")
        || lower.contains("use context handoff")
        || lower.contains("sdk checkpoint exceeds")
        || lower.contains("sdk jsonl checkpoint exceeds")
        || lower.contains("inventory exceeds budget")
        || lower.contains("sdk recovery metadata exceeds budget")
        || lower.contains("sdk translation provenance is fenced")
}

/// Reads one state record's value.
fn read_value(
    conn: &Arc<ace_store::Connection>,
    sql: &'static str,
    thread: &str,
) -> Result<Option<String>, EngineError> {
    let row = stmt_cache::get_row(conn, sql, vec![Cell::Text(thread.to_owned())])?;
    Ok(row.and_then(|row| row.get("value").and_then(cell_text).map(str::to_owned)))
}

/// Writes one state record's value.
fn write_value(
    conn: &Arc<ace_store::Connection>,
    sql: &'static str,
    thread: &str,
    value: &str,
) -> Result<(), EngineError> {
    stmt_cache::run(
        conn,
        sql,
        vec![Cell::Text(thread.to_owned()), Cell::Text(value.to_owned())],
    )?;
    Ok(())
}

/// The latest attempt's record, kept as frames commit (`record`). Undefined for frames an earlier
/// build stored.
pub fn record(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
) -> Result<Option<AttemptRecord>, EngineError> {
    let Some(text) = read_value(conn, READ_RECORD, thread)? else {
        return Ok(None);
    };
    Ok(ace_json::from_value(
        &ace_json::parse(&text).map_err(|error| EngineError::Records(error.to_string()))?,
    )
    .ok())
}

fn write_record(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
    record: &AttemptRecord,
) -> Result<(), EngineError> {
    let mut value = ace_json::Map::new();
    value.insert("commandId", Value::from(record.command_id.as_str()));
    value.insert("operationId", Value::from(record.operation_id.as_str()));
    value.insert("evidence", Value::Bool(record.evidence));
    if let Some(admitted) = record.admitted {
        value.insert("admitted", Value::Bool(admitted));
    }
    if record.older {
        value.insert("older", Value::Bool(true));
    }
    write_value(
        conn,
        WRITE_RECORD,
        thread,
        &ace_json::to_string(&Value::Object(value)),
    )
}

/// Where the thread's frames stand (`frames`).
pub fn frames(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
) -> Result<FramesRecord, EngineError> {
    let Some(text) = read_value(conn, READ_FRAMES_RECORD, thread)? else {
        return Ok(FramesRecord::default());
    };
    let value = ace_json::parse(&text).map_err(|error| EngineError::Records(error.to_string()))?;
    Ok(FramesRecord {
        open: value.get("open").and_then(Value::as_i64),
        below: value.get("below").and_then(Value::as_i64),
        trimmed: value.get("trimmed").and_then(Value::as_bool),
    })
}

/// Writes where the thread's frames stand, and whether the sweep still has frames to delete.
fn write_frames(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
    record: FramesRecord,
) -> Result<(), EngineError> {
    let mut value = ace_json::Map::new();
    if let Some(open) = record.open {
        value.insert("open", Value::from(open));
    }
    if let Some(below) = record.below {
        value.insert("below", Value::from(below));
    }
    if let Some(trimmed) = record.trimmed {
        value.insert("trimmed", Value::Bool(trimmed));
    }
    write_value(
        conn,
        WRITE_FRAMES_RECORD,
        thread,
        &ace_json::to_string(&Value::Object(value)),
    )?;
    match record.trimmed {
        Some(false) => mark_prune(conn, thread),
        Some(true) => clear_prune(conn, thread),
        None => Ok(()),
    }
}

fn mark_prune(conn: &Arc<ace_store::Connection>, thread: &str) -> Result<(), EngineError> {
    stmt_cache::run(conn, MARK_PRUNE, vec![Cell::Text(thread.to_owned())])?;
    Ok(())
}

fn clear_prune(conn: &Arc<ace_store::Connection>, thread: &str) -> Result<(), EngineError> {
    stmt_cache::run(conn, CLEAR_PRUNE, vec![Cell::Text(thread.to_owned())])?;
    Ok(())
}

/// Sends of retired sessions, with their delivery evidence (`retired`).
pub fn retired(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
) -> Result<Vec<AttemptRecord>, EngineError> {
    let Some(text) = read_value(conn, READ_RETIRED, thread)? else {
        return Ok(Vec::new());
    };
    let value = ace_json::parse(&text).map_err(|error| EngineError::Records(error.to_string()))?;
    let Some(items) = value.as_array() else {
        return Ok(Vec::new());
    };
    Ok(items
        .iter()
        .filter_map(|item| ace_json::from_value::<AttemptRecord>(item).ok())
        .collect())
}

/// Frames an earlier build stored, with none of this build's records: only then are they searched
/// (`legacy`).
pub fn legacy(conn: &Arc<ace_store::Connection>, thread: &str) -> Result<bool, EngineError> {
    Ok(record(conn, thread)?.is_none()
        && frames(conn, thread)?.below.is_none()
        && retired(conn, thread)?.is_empty())
}

/// The attempt record, an earlier build's thread's first rebuilt from its newest frames
/// (`current`).
pub fn current(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
) -> Result<Option<AttemptRecord>, EngineError> {
    let stored = record(conn, thread)?;
    if !legacy(conn, thread)? {
        return Ok(stored);
    }
    migrate(conn, thread)?;
    record(conn, thread)
}

/// The latest attempt's record, or, once a fresh-session handoff retired it, the newest retired
/// one: a send held in doubt keeps its evidence across the handoff (`latest`).
fn latest(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
) -> Result<Option<AttemptRecord>, EngineError> {
    let current = current(conn, thread)?;
    Ok(current.or_else(|| {
        retired(conn, thread)
            .ok()
            .and_then(|retired| retired.last().cloned())
    }))
}

/// True when the host stored its attempt to send `command_id` (`attempted`). The host calls Cursor
/// only once that attempt is committed, so without it the input never reached Cursor.
pub fn attempted(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
    command_id: &str,
) -> Result<bool, EngineError> {
    let record = current(conn, thread)?;
    if record
        .as_ref()
        .is_some_and(|record| record.command_id == command_id)
    {
        return Ok(true);
    }
    if retired(conn, thread)?
        .iter()
        .any(|kept| kept.command_id == command_id)
    {
        return Ok(true);
    }
    // An earlier build's send past the frames it kept can't be ruled out.
    Ok(record.is_some_and(|record| record.older))
}

/// The newest admission a reopened host read back, if any (`lastAdmission`).
pub fn last_admission(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
) -> Result<Option<(Option<String>, bool)>, EngineError> {
    let record = current(conn, thread)?;
    Ok(record.and_then(|record| {
        record
            .admitted
            .map(|admitted| (Some(record.command_id), admitted))
    }))
}

/// True when an earlier build's send can't be ruled out, but which one is unknown
/// (`unknownAttempt`).
pub fn unknown_attempt(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
) -> Result<bool, EngineError> {
    Ok(latest(conn, thread)?.is_some_and(|record| record.older))
}

/// The command of the latest send the host attempted, if one is on record (`attemptedCommand`).
pub fn attempted_command(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
) -> Result<Option<String>, EngineError> {
    Ok(latest(conn, thread)?
        .and_then(|record| (!record.command_id.is_empty()).then_some(record.command_id)))
}

/// True when anything of `command_id`'s send beyond the attempt itself was recorded
/// (`admissionRecorded`).
pub fn admission_recorded(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
    command_id: &str,
) -> Result<bool, EngineError> {
    let record = current(conn, thread)?;
    if let Some(record) = &record
        && record.command_id == command_id
    {
        return Ok(record.evidence);
    }
    // A retired session's send: only it could have had it, and it is gone. Never re-sent.
    if retired(conn, thread)?
        .iter()
        .any(|kept| kept.command_id == command_id)
    {
        return Ok(true);
    }
    Ok(record.is_some_and(|record| record.older))
}

/// Folds one committed Cursor frame into the attempt record, in the commit's transaction (`note`).
pub fn note(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
    data: &Value,
) -> Result<(), EngineError> {
    let before = record(conn, thread)?;
    let after = note_attempt(before.clone(), data);
    if let Some(after) = after
        && Some(&after) != before.as_ref()
    {
        write_record(conn, thread, &after)?;
    }
    Ok(())
}

/// Forgets a session's frames (and an earlier build's boundary cursor): the thread's next session
/// starts fresh (`reset`). Frames are set aside at once and deleted a bounded batch per commit.
pub fn reset(conn: &Arc<ace_store::Connection>, thread: &str) -> Result<(), EngineError> {
    let kept_record = record(conn, thread)?;
    if let Some(record) = &kept_record {
        let mut kept = retired(conn, thread)?;
        kept.push(record.clone());
        let start = kept.len().saturating_sub(16);
        let kept = &kept[start..];
        let value = ace_json::to_string(&Value::Array(
            kept.iter()
                .map(|record| {
                    let mut map = ace_json::Map::new();
                    map.insert("commandId", Value::from(record.command_id.as_str()));
                    map.insert("operationId", Value::from(record.operation_id.as_str()));
                    map.insert("evidence", Value::Bool(record.evidence));
                    if let Some(admitted) = record.admitted {
                        map.insert("admitted", Value::Bool(admitted));
                    }
                    if record.older {
                        map.insert("older", Value::Bool(true));
                    }
                    Value::Object(map)
                })
                .collect::<Vec<_>>()
                .into(),
        ));
        write_value(conn, WRITE_RETIRED, thread, &value)?;
    }
    let row = stmt_cache::get_row(conn, LAST_FRAME, vec![Cell::Text(thread.to_owned())])?;
    let last = row
        .and_then(|row| {
            row.get("last")
                .and_then(crate::repository::residency::cell_int)
        })
        .unwrap_or(0);
    write_frames(
        conn,
        thread,
        FramesRecord {
            open: None,
            below: Some(last + 1),
            trimmed: Some(false),
        },
    )?;
    stmt_cache::run(
        conn,
        "DELETE FROM engine_provider_cursors WHERE thread_id=?",
        vec![Cell::Text(thread.to_owned())],
    )?;
    stmt_cache::run(
        conn,
        "DELETE FROM engine_state_records WHERE thread_id=? AND section='cursorAttempt'",
        vec![Cell::Text(thread.to_owned())],
    )?;
    Ok(())
}

/// A frame this commit stored at `row`: the latest session's open frame, or the send that starts a
/// turn on a settled thread (`captured`).
pub fn captured(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
    kind: Option<&str>,
    row: Option<i64>,
    begins_turn: bool,
) -> Result<(), EngineError> {
    let Some(row) = row else {
        return Ok(());
    };
    if kind != Some("open") && !begins_turn {
        return Ok(());
    }
    let record = frames(conn, thread)?;
    let next = if kind == Some("open") {
        FramesRecord {
            open: Some(row),
            ..record
        }
    } else {
        FramesRecord {
            below: Some(row),
            trimmed: Some(false),
            ..record
        }
    };
    write_frames(conn, thread, next)
}

/// One bounded step of the idle sweep: a batch of settled frames for each of a few threads
/// (`pruneIdle`).
pub fn prune_idle(conn: &Arc<ace_store::Connection>, threads: usize) -> Result<(), EngineError> {
    let rows = stmt_cache::all_rows(conn, UNTRIMMED, vec![Cell::Integer(threads as i64)])?;
    for thread in rows
        .iter()
        .filter_map(|row| row.get("thread_id").and_then(cell_text).map(str::to_owned))
    {
        trim_step(conn, &thread)?;
    }
    Ok(())
}

/// Deletes up to 256 frames of settled turns (`trimStep`): a bounded step, in the commit it rides
/// on.
pub fn trim_step(conn: &Arc<ace_store::Connection>, thread: &str) -> Result<(), EngineError> {
    let record = frames(conn, thread)?;
    let (Some(below), trimmed) = (record.below, record.trimmed) else {
        clear_prune(conn, thread)?;
        return Ok(());
    };
    if trimmed == Some(true) {
        clear_prune(conn, thread)?;
        return Ok(());
    }
    let (changes, _) = stmt_cache::run(
        conn,
        TRIM_FRAMES,
        vec![
            Cell::Text(thread.to_owned()),
            Cell::Integer(below),
            Cell::Integer(record.open.unwrap_or(0)),
        ],
    )?;
    if changes < TRIM_BATCH {
        write_frames(
            conn,
            thread,
            FramesRecord {
                trimmed: Some(true),
                ..record
            },
        )?;
    }
    Ok(())
}

/// The threads the sweep visits, a few at a time (`idleSweepQuery`).
pub const IDLE_SWEEP_QUERY: &str = UNTRIMMED;

/// `migrate` (`provider-recovery.ts:209`): an earlier build's thread's first reopen finds where its
/// open turn starts among the newest frames, and its attempt record from the same rows.
pub fn migrate(conn: &Arc<ace_store::Connection>, thread: &str) -> Result<(), EngineError> {
    struct Row {
        rowid: i64,
        kind: Option<String>,
        operation_id: Option<String>,
        command_id: Option<String>,
        admitted: bool,
        admitted_command: Option<String>,
    }
    let rows = stmt_cache::all_rows(conn, RECENT_KINDS, vec![Cell::Text(thread.to_owned())])?;
    let all: Vec<Row> = rows
        .iter()
        .map(|row| Row {
            rowid: row
                .get("rowid")
                .and_then(crate::repository::residency::cell_int)
                .unwrap_or(0),
            kind: row.get("kind").and_then(cell_text).map(str::to_owned),
            operation_id: row
                .get("operationId")
                .and_then(cell_text)
                .map(str::to_owned),
            command_id: row.get("commandId").and_then(cell_text).map(str::to_owned),
            admitted: row
                .get("admitted")
                .and_then(crate::repository::residency::cell_int)
                == Some(1),
            admitted_command: row
                .get("admittedCommand")
                .and_then(cell_text)
                .map(str::to_owned),
        })
        .collect();
    let older = all.len() > LEGACY_WINDOW as usize;
    let recent = &all[..all.len().min(LEGACY_WINDOW as usize)];
    let sent = recent
        .iter()
        .position(|row| row.kind.as_deref() == Some("send"));
    let opened = sent.and_then(|sent| {
        recent
            .iter()
            .enumerate()
            .position(|(index, row)| index > sent && row.kind.as_deref() == Some("open"))
    });
    let start = sent.unwrap_or(recent.len().saturating_sub(1));
    let mut record = if older && sent.is_none() {
        Some(AttemptRecord::older())
    } else {
        None
    };
    for row in recent[..sent.map_or(0, |sent| sent + 1)].iter().rev() {
        let mut data = ace_json::Map::new();
        data.insert("kind", row.kind.as_deref().map_or(Value::Null, Value::from));
        data.insert(
            "operationId",
            row.operation_id.as_deref().map_or(Value::Null, Value::from),
        );
        if let Some(command_id) = &row.command_id {
            data.insert("commandId", Value::from(command_id.as_str()));
        }
        let mut body = ace_json::Map::new();
        body.insert("admitted", Value::Bool(row.admitted));
        if let Some(command_id) = &row.admitted_command {
            body.insert("commandId", Value::from(command_id.as_str()));
        }
        data.insert("body", Value::Object(body));
        record = note_attempt(record, &Value::Object(data));
    }
    let Some(first) = recent.get(start) else {
        return Ok(());
    };
    let below = first.rowid;
    let open = sent.and_then(|_| {
        opened
            .and_then(|index| recent.get(index))
            .map(|row| row.rowid)
    });
    if let Some(record) = &record {
        write_record(conn, thread, record)?;
    }
    write_frames(
        conn,
        thread,
        FramesRecord {
            open,
            below: Some(below),
            trimmed: Some(false),
        },
    )
}

/// Reads one captured frame, or none.
fn read_frame(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
    rowid: i64,
) -> Result<Option<(i64, CapturedFrame)>, EngineError> {
    let row = stmt_cache::get_row(
        conn,
        READ_FRAME,
        vec![Cell::Text(thread.to_owned()), Cell::Integer(rowid)],
    )?;
    row.map(|row| decode_frame(&row)).transpose()
}

/// One page of the open turn's frames, from `after` on.
fn read_frames(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
    after: i64,
) -> Result<Vec<(i64, CapturedFrame)>, EngineError> {
    let rows = stmt_cache::all_rows(
        conn,
        READ_FRAMES,
        vec![Cell::Text(thread.to_owned()), Cell::Integer(after)],
    )?;
    rows.iter().map(decode_frame).collect()
}

fn decode_frame(row: &ace_store::stmt_cache::Row) -> Result<(i64, CapturedFrame), EngineError> {
    let rowid = row
        .get("rowid")
        .and_then(crate::repository::residency::cell_int)
        .ok_or(EngineError::InvalidRecord)?;
    let text = row
        .get("frame")
        .and_then(cell_text)
        .ok_or(EngineError::InvalidRecord)?;
    let value = ace_json::parse(text).map_err(|_| EngineError::InvalidRecord)?;
    let seq = value
        .get("seq")
        .and_then(Value::as_i64)
        .filter(|seq| *seq >= 0)
        .ok_or(EngineError::InvalidRecord)?;
    let t = value
        .get("t")
        .and_then(Value::as_i64)
        .filter(|t| *t >= 0)
        .ok_or(EngineError::InvalidRecord)?;
    let dir = value
        .get("dir")
        .and_then(Value::as_str)
        .filter(|dir| matches!(*dir, "send" | "recv" | "stderr" | "note"))
        .ok_or(EngineError::InvalidRecord)?;
    if value.get("channel").and_then(Value::as_str) != Some("sdk") {
        return Err(EngineError::InvalidRecord);
    }
    let data = value
        .get("data")
        .cloned()
        .ok_or(EngineError::InvalidRecord)?;
    Ok((
        rowid,
        CapturedFrame {
            seq,
            t,
            dir: dir.to_owned(),
            data,
        },
    ))
}

/// One reopened host's read-back (`restore`): every committed frame of the open turn, folded
/// through the translator, and what of the turn the frames lack. `translate` is the adapter's
/// translation of one frame (data, t) to its facts.
pub type Translate<'a> = dyn FnMut(&Value, i64) -> Result<Vec<Value>, EngineError> + 'a;

pub async fn restore(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
    translate: &mut Translate<'_>,
) -> Result<super::attempt::Unsettled, EngineError> {
    let mut unsettled = super::attempt::UnsettledRuns::new();
    // An earlier build's thread has no records yet: its first reopen finds where its open turn
    // starts among the newest frames, and from then on it is this build's.
    if legacy(conn, thread)? {
        migrate(conn, thread)?;
    }
    let record = frames(conn, thread)?;
    let below = record.below.unwrap_or(0);
    let opened = match record.open {
        Some(open) if open < below => read_frame(conn, thread, open)?.map(|(_, frame)| frame),
        _ => None,
    };
    let mut rowid = (below - 1).max(0);
    let mut first = opened;
    loop {
        let rows = match first.take() {
            Some(frame) => vec![(rowid, frame)],
            None => read_frames(conn, thread, rowid)?,
        };
        if rows.is_empty() {
            return Ok(unsettled.result());
        }
        for (row, frame) in rows {
            let facts = translate(&frame.data, frame.t)?;
            unsettled.add(&frame.data);
            let fence = fence_of(&frame.data);
            if facts
                .iter()
                .any(|fact| fact.get("type").and_then(Value::as_str) == Some("process.exited"))
                && fence.is_none()
            {
                return Err(EngineError::Records(
                    "SDK translation provenance is fenced by its budget; use bounded context handoff"
                        .to_owned(),
                ));
            }
            if let Some((code, message)) = fence
                && code == "checkpoint_budget"
                && unusable_store(message.as_deref())
            {
                return Err(EngineError::Records(message.unwrap_or_else(|| {
                    "Cursor's checkpoint exceeds its budget".to_owned()
                })));
            }
            rowid = row;
        }
        // After the open frame, on from the open turn's first frame.
        rowid = rowid.max(below - 1);
        crate::actor::yield_once().await;
    }
}

/// The emergency fence a previous host stored, if this frame is one (`HostFence`).
fn fence_of(data: &Value) -> Option<(String, Option<String>)> {
    if data.get("kind").and_then(Value::as_str) != Some("error") {
        return None;
    }
    let body = data.get("body")?;
    let code = body.get("code").and_then(Value::as_str)?;
    if !matches!(code, "boundary_overflow" | "checkpoint_budget") {
        return None;
    }
    let message = body
        .get("message")
        .and_then(Value::as_str)
        .filter(|message| message.len() <= 4096)
        .map(str::to_owned);
    Some((code.to_owned(), message))
}

/// The engine's idle sweep (`index.ts:147`): `repo.recovery.pruneIdle()`, four threads a step.
pub fn sweep(core: &Core) -> Result<(), EngineError> {
    prune_idle(core.store.conn(), 4)
}

#[cfg(test)]
mod tests;
