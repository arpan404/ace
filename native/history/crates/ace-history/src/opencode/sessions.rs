// SPDX-License-Identifier: Apache-2.0

//! An OpenCode database's sessions as catalog rows (`dbSessions` in `provider-db.ts`): title,
//! first request, model, counts and whether each can be opened.

use history_text::{js, sanitize_user_text, session_title};
use rusqlite::{Connection, Statement};
use serde_json::{Value, json};

use super::database::{columns, supports, supports_v1, supports_v2};
use super::{js_number, js_string, json_of};
use crate::error::{Error, Result};
use crate::json::{field, is_true, object, string, timestamp};
use crate::options::Home;
use crate::scan::user::has_user_input;
use crate::session::{Accuracy, Session, Support, source_id};

const UNKNOWN_FORMAT: &str =
    "This OpenCode history format is not recognized. Export the session from OpenCode to open it.";
const TOO_LARGE: &str =
    "OpenCode SQLite record exceeds the bounded decoder limit; use native export";

/// The session's first request from the person, and whether it has one at all.
struct Input {
    text: String,
    real: bool,
}

/// `firstInput`: the first non-synthetic user part with text or an attachment.
fn first_input(rows: &mut Statement<'_>, session: &str) -> Result<Input> {
    let mut rows = rows.query([session])?;
    while let Some(row) = rows.next()? {
        let Some(value) = crate::json::parse(&js_string(row.get_ref(0)?)) else {
            continue;
        };
        let p = object(&value);
        if is_true(p, "synthetic") {
            continue;
        }
        let text = sanitize_user_text(string(p, "text").unwrap_or(""));
        let attached =
            has_user_input(&json!({ "role": "user", "content": [Value::Object(p.clone())] }));
        let files = field(p, "files").as_array().is_some_and(|f| !f.is_empty());
        if !text.is_empty() || attached || files {
            return Ok(Input { text, real: true });
        }
    }
    Ok(Input {
        text: String::new(),
        real: false,
    })
}

fn none() -> Input {
    Input {
        text: String::new(),
        real: false,
    }
}

fn exists(statement: &mut Statement<'_>, params: &[&str]) -> Result<bool> {
    let n: rusqlite::types::Value =
        statement.query_row(rusqlite::params_from_iter(params), |row| row.get(0))?;
    Ok(js_number((&n).into()) > 0.0)
}

fn count(statement: &mut Statement<'_>, session: &str) -> Result<i64> {
    let n: rusqlite::types::Value = statement.query_row([session], |row| row.get(0))?;
    Ok(js_number((&n).into()) as i64)
}

/// The model of the session's latest messages that name one.
fn model(latest: &mut Statement<'_>, session: &str) -> Result<Option<String>> {
    let mut rows = latest.query([session])?;
    while let Some(row) = rows.next()? {
        let Some(value) = crate::json::parse(&js_string(row.get_ref(0)?)) else {
            continue;
        };
        let m = object(&value);
        let found = string(m, "modelID").or_else(|| string(object(field(m, "model")), "modelID"));
        if let Some(found) = found {
            return Ok(Some(found.to_owned()));
        }
    }
    Ok(None)
}

/// Each session of the database at `path`, with whether it is hidden (nothing the person said).
pub fn sessions(
    home: &Home,
    path: &str,
    db: &Connection,
    each: &mut dyn FnMut(Session, bool) -> Result<()>,
) -> Result<()> {
    if !supports(db)? {
        return Err(Error::message("Unknown OpenCode database schema"));
    }
    let v1 = supports_v1(db)?;
    let v1_large = if v1 {
        " OR EXISTS(SELECT 1 FROM message WHERE octet_length(id)>1024) OR EXISTS(SELECT 1 FROM part WHERE octet_length(id)>1024)"
    } else {
        ""
    };
    let too_large: rusqlite::types::Value = db.query_row(
        &format!("SELECT EXISTS(SELECT 1 FROM session WHERE octet_length(id)>1024 OR octet_length(directory)>8192 OR octet_length(parent_id)>1024) {v1_large} AS too_large"),
        [],
        |row| row.get(0),
    )?;
    if js_number((&too_large).into()) > 0.0 {
        return Err(Error::message(
            "OpenCode session metadata exceeds supported limits",
        ));
    }
    let v2 = supports_v2(db)?;
    let mut v2_history = if columns(db, "session_message")?.contains("session_id") {
        Some(db.prepare("SELECT EXISTS(SELECT 1 FROM session_message WHERE session_id=?1) AS n")?)
    } else {
        None
    };
    let prepare = |ok: bool, sql: &str| -> Result<Option<Statement<'_>>> {
        Ok(if ok { Some(db.prepare(sql)?) } else { None })
    };
    let mut v2_input = prepare(
        v2,
        "SELECT data FROM session_message WHERE session_id=?1 AND type='user' AND octet_length(data)<=1048576 ORDER BY seq,id",
    )?;
    let mut v1_input = prepare(
        v1,
        "SELECT p.data FROM message m JOIN part p ON p.message_id=m.id WHERE m.session_id=?1 AND octet_length(m.data)<=1048576 AND json_valid(m.data) AND json_extract(m.data,'$.role')='user' AND octet_length(p.data)<=1048576 ORDER BY m.time_created,m.id,p.id",
    )?;
    let mut v2_large = prepare(
        v2,
        "SELECT EXISTS(SELECT 1 FROM session_message WHERE session_id=?1 AND octet_length(data)>1048576) AS n",
    )?;
    let mut v2_count = prepare(
        v2,
        "SELECT COUNT(*) AS n FROM session_message WHERE session_id=?1 AND type IN ('user','assistant')",
    )?;
    let mut v1_count = prepare(
        v1,
        "SELECT COUNT(*) AS n FROM message WHERE session_id = ?1",
    )?;
    let mut latest = prepare(
        v1,
        "SELECT CASE WHEN octet_length(data)<=65536 THEN data ELSE NULL END AS data FROM message WHERE session_id = ?1 ORDER BY time_created DESC,id DESC LIMIT 32",
    )?;
    let mut oversized = prepare(
        v1,
        "SELECT EXISTS(SELECT 1 FROM message WHERE session_id=?1 AND octet_length(data)>1048576) OR EXISTS(SELECT 1 FROM part p JOIN message m ON m.id=p.message_id WHERE m.session_id=?1 AND octet_length(p.data)>1048576) AS too_large",
    )?;
    let mut rows = db.prepare(
        "SELECT id,directory,CASE WHEN octet_length(title)<=1048576 THEN substr(title,1,1048576) ELSE '[Title exceeds display limit]' END AS title,time_updated,parent_id FROM session ORDER BY id",
    )?;
    let mut rows = rows.query([])?;
    while let Some(row) = rows.next()? {
        let id = js_string(row.get_ref(0)?);
        let rusqlite::types::ValueRef::Text(directory) = row.get_ref(1)? else {
            return Err(Error::message("OpenCode session has no directory"));
        };
        let cwd = String::from_utf8_lossy(directory).into_owned();
        let title_ref = row.get_ref(2)?;
        let same = matches!((title_ref, row.get_ref(0)?), (rusqlite::types::ValueRef::Text(a), rusqlite::types::ValueRef::Text(b)) if a == b);
        let title = if same {
            String::new()
        } else {
            js_string(title_ref)
        };
        let updated = timestamp(&json_of(row.get_ref(3)?));
        let parent = match row.get_ref(4)? {
            rusqlite::types::ValueRef::Text(p) if !p.is_empty() => {
                Some(String::from_utf8_lossy(p).into_owned())
            }
            _ => None,
        };
        let model = match latest.as_mut() {
            Some(latest) => model(latest, &id)?,
            None => None,
        };
        let history = match v2_history.as_mut() {
            Some(query) => exists(query, &[&id])?,
            None => false,
        };
        let input = match (history, v2, v1) {
            (true, true, _) => match v2_input.as_mut() {
                Some(q) => first_input(q, &id)?,
                None => none(),
            },
            (true, false, _) | (false, _, false) => none(),
            (false, _, true) => match v1_input.as_mut() {
                Some(q) => first_input(q, &id)?,
                None => none(),
            },
        };
        let large_record = match oversized.as_mut() {
            Some(q) => exists(q, &[&id])?,
            None => false,
        };
        let large_v2 = history
            && v2
            && match v2_large.as_mut() {
                Some(q) => exists(q, &[&id])?,
                None => false,
            };
        let unsupported =
            (history && !v2) || (!history && !v1) || if history { large_v2 } else { large_record };
        let messages = if history && v2 {
            v2_count.as_mut().map_or(Ok(0), |q| count(q, &id))?
        } else {
            v1_count.as_mut().map_or(Ok(0), |q| count(q, &id))?
        };
        let at = updated.unwrap_or(0);
        let session = Session {
            id: source_id(&home.id, path, &id),
            instance_id: home.id.clone(),
            provider: "opencode".to_owned(),
            title: session_title(&title, &input.text, at),
            native_id: id,
            cwd,
            model: model.map(|m| js::prefix(&m, 512).to_owned()),
            last_activity: at,
            message_count: messages,
            count_accuracy: Accuracy::Exact,
            parent_native_id: parent,
            continuation: None,
            support: if unsupported {
                Support::unsupported(if history && !v2 {
                    UNKNOWN_FORMAT
                } else {
                    TOO_LARGE
                })
            } else {
                Support::Supported
            },
        };
        each(session, !input.real && !unsupported)?;
    }
    Ok(())
}
