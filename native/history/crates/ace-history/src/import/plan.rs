// SPDX-License-Identifier: Apache-2.0

//! The import plan (`history-plan.ts`): a first pass that puts ancestry, tool results and
//! compaction summaries in a private SQLite file, so the second pass holds one record in memory.

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

use super::source::records;
use super::tools::{Completion, native_completions};
use crate::cancel::Cancel;
use crate::error::{Error, Result};
use crate::fsread::RecordKind;
use crate::json::{field, has, is_true, object, string};
use crate::options::{Home, Provider};
use crate::session::Source;
use crate::snapshot::{SnapshotScratch, WorkDir};

/// Records up to this size travel inline as raw data; larger ones go to blobs.
pub const INLINE_RAW_BYTES: u64 = 60 * 1024;

/// A compaction summary: its text and, when small enough, its record.
pub struct CompactSummary {
    pub text: String,
    pub data: Option<Value>,
}

/// `compactSummaryOf`: the boundary a Claude compaction summary continues, and its text.
pub fn compact_summary_of(value: &Value) -> Option<(String, String)> {
    let r = object(value);
    if string(r, "type") != Some("user") || !is_true(r, "isCompactSummary") {
        return None;
    }
    let boundary = string(r, "parentUuid")?.to_owned();
    let text = match field(object(field(r, "message")), "content") {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .map(object)
            .filter(|b| string(b, "type") == Some("text"))
            .map(|b| string(b, "text").unwrap_or(""))
            .collect(),
        _ => String::new(),
    };
    (!boundary.is_empty() && !text.is_empty()).then_some((boundary, text))
}

pub struct Plan {
    db: Option<Connection>,
    _dir: Option<WorkDir>,
    has_ancestry: bool,
}

impl Plan {
    pub fn includes(&self, position: i64) -> Result<bool> {
        let Some(db) = &self.db else { return Ok(true) };
        if !self.has_ancestry {
            return Ok(true);
        }
        let selected: Option<i64> = db
            .prepare_cached("SELECT selected FROM ancestry WHERE ordinal=?1")?
            .query_row([position], |r| r.get(0))
            .optional()?;
        Ok(selected.unwrap_or(1) == 1)
    }

    pub fn record_call(&self, native: &str, item: &str) -> Result<()> {
        if let Some(db) = &self.db {
            db.prepare_cached(
                "INSERT INTO calls VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET item=excluded.item",
            )?
            .execute(params![native, item])?;
        }
        Ok(())
    }

    pub fn call_item(&self, native: &str) -> Result<Option<String>> {
        let Some(db) = &self.db else { return Ok(None) };
        Ok(db
            .prepare_cached("SELECT item FROM calls WHERE id=?1")?
            .query_row([native], |r| r.get(0))
            .optional()?)
    }

    pub fn completion(&self, native: &str) -> Result<Option<Completion>> {
        let Some(db) = &self.db else { return Ok(None) };
        let data: Option<String> = db
            .prepare_cached("SELECT data FROM results WHERE id=?1 ORDER BY ordinal DESC LIMIT 1")?
            .query_row([native], |r| r.get(0))
            .optional()?;
        data.map(|d| serde_json::from_str(&d).map_err(|e| Error::message(e.to_string())))
            .transpose()
    }

    /// The summary that continues a compaction boundary, found ahead of it.
    pub fn compact_summary(&self, boundary: &str) -> Result<Option<CompactSummary>> {
        let Some(db) = &self.db else { return Ok(None) };
        let row: Option<(Option<String>, Option<String>)> = db
            .prepare_cached("SELECT text,data FROM summaries WHERE boundary=?1")?
            .query_row([boundary], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()?;
        let Some((Some(text), data)) = row else {
            return Ok(None);
        };
        if text.is_empty() {
            return Ok(None);
        }
        let data = data
            .map(|d| serde_json::from_str(&d).map_err(|e| Error::message(e.to_string())))
            .transpose()?;
        Ok(Some(CompactSummary { text, data }))
    }

    /// Whether this summary record's raw already travels on its boundary's compaction.
    pub fn folds_summary(&self, uuid: &str) -> Result<bool> {
        let Some(db) = &self.db else { return Ok(false) };
        Ok(db
            .prepare_cached("SELECT 1 FROM summaries s JOIN boundaries b ON b.uuid=s.boundary WHERE s.uuid=?1 AND s.data IS NOT NULL")?
            .query_row([uuid], |_| Ok(()))
            .optional()?
            .is_some())
    }
}

/// Build the plan for one source. OpenCode needs none.
pub fn prepare(
    home: &Home,
    source: &Source,
    scratch: &SnapshotScratch,
    cancel: &Cancel,
) -> Result<Plan> {
    if home.provider == Provider::Opencode {
        return Ok(Plan {
            db: None,
            _dir: None,
            has_ancestry: false,
        });
    }
    let dir = scratch.work_dir("history-plan")?;
    let db = Connection::open(dir.path().join("plan.sqlite"))?;
    db.execute_batch(
        "PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; CREATE TABLE ancestry(ordinal INTEGER PRIMARY KEY,uuid TEXT UNIQUE,parent TEXT,selected INTEGER); CREATE TABLE results(id TEXT,ordinal INTEGER,data TEXT,PRIMARY KEY(id,ordinal)); CREATE TABLE calls(id TEXT PRIMARY KEY,item TEXT); CREATE TABLE boundaries(uuid TEXT PRIMARY KEY); CREATE TABLE summaries(boundary TEXT PRIMARY KEY,uuid TEXT,ordinal INTEGER,text TEXT NOT NULL,data TEXT); BEGIN",
    )?;
    let mut ordinal = 0i64;
    let mut leaf: Option<String> = None;
    {
        let mut node = db.prepare("INSERT INTO ancestry VALUES(?1,?2,?3,0) ON CONFLICT(uuid) DO UPDATE SET ordinal=excluded.ordinal,parent=excluded.parent")?;
        let mut result = db.prepare("INSERT OR REPLACE INTO results VALUES(?1,?2,?3)")?;
        let mut boundary = db.prepare("INSERT OR IGNORE INTO boundaries VALUES(?1)")?;
        let mut summary = db.prepare("INSERT OR REPLACE INTO summaries VALUES(?1,?2,?3,?4,?5)")?;
        for record in records(home, source, cancel)? {
            let record = record?;
            ordinal += 1;
            cancel.check()?;
            let RecordKind::Value(value) = &record.kind else {
                continue;
            };
            let r = object(value);
            if home.provider == Provider::Claude {
                if matches!(string(r, "type"), Some("user" | "assistant" | "system"))
                    && let Some(uuid) = string(r, "uuid")
                    && has(r, "parentUuid")
                {
                    node.execute(params![ordinal, uuid, string(r, "parentUuid")])?;
                    leaf = Some(uuid.to_owned());
                }
                // Claude's compaction summary continues its boundary: the boundary's item carries it.
                let uuid = string(r, "uuid");
                if string(r, "type") == Some("system")
                    && string(r, "subtype") == Some("compact_boundary")
                    && let Some(uuid) = uuid
                {
                    boundary.execute([uuid])?;
                }
                if let Some((boundary_uuid, text)) = compact_summary_of(value) {
                    let data = (record.bytes <= INLINE_RAW_BYTES).then(|| value.to_string());
                    summary.execute(params![boundary_uuid, uuid, ordinal, text, data])?;
                }
            }
            if home.provider == Provider::Pi
                && let Some(id) = string(r, "id")
                && has(r, "parentId")
            {
                node.execute(params![ordinal, id, string(r, "parentId")])?;
                leaf = Some(id.to_owned());
            }
            for completion in native_completions(value, home.provider) {
                let data = serde_json::to_string(&completion)
                    .map_err(|e| Error::message(e.to_string()))?;
                result.execute(params![completion.id, ordinal, data])?;
            }
        }
    }
    db.execute_batch("COMMIT; BEGIN")?;
    let has_ancestry = leaf.is_some();
    let mut ancestors = 0;
    while let Some(current) = leaf.take() {
        ancestors += 1;
        if ancestors % 64 == 0 {
            cancel.check()?;
        }
        let row: Option<(Option<String>, i64)> = db
            .prepare_cached("SELECT parent,selected FROM ancestry WHERE uuid=?1")?
            .query_row([&current], |r| {
                Ok((r.get(0)?, r.get::<_, Option<i64>>(1)?.unwrap_or(0)))
            })
            .optional()?;
        let Some((parent, selected)) = row else { break };
        if selected != 0 {
            return Err(Error::message("Cyclic native conversation ancestry"));
        }
        db.prepare_cached("UPDATE ancestry SET selected=1 WHERE uuid=?1")?
            .execute([&current])?;
        leaf = parent;
    }
    if has_ancestry {
        db.execute_batch(
            "DELETE FROM results WHERE ordinal IN (SELECT ordinal FROM ancestry WHERE selected=0); DELETE FROM summaries WHERE ordinal IN (SELECT ordinal FROM ancestry WHERE selected=0)",
        )?;
    }
    Ok(Plan {
        db: Some(db),
        _dir: Some(dir),
        has_ancestry,
    })
}
