// SPDX-License-Identifier: Apache-2.0
//! SQL sidebar page queries (`sidebar-page-storage.ts`, PR #2737 `withChats` UNION ALL).

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use ace_json::{Array, JsString, Map, Number, Value as Json};

use crate::reads::sidebar::facts::{
    SIDEBAR_ACTIVITY, SIDEBAR_COUNTED, SIDEBAR_DELETED, sidebar_columns_readable,
    sidebar_settled_sql,
};
use crate::reads::sidebar::index::{SidebarCount, SidebarScope, sql_to_js_string};
use crate::reads::sidebar::live::SidebarError;
use crate::reads::thread_row::{
    THREAD_ROW_COLUMN_COUNT, THREAD_ROW_COLUMNS, THREAD_ROW_SOURCE, decode_thread_sql_row,
};
use crate::{Connection, Value as SqlValue};

/// Pagination cursor (`ThreadListCursor`: `{ at, id }`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SidebarCursor {
    pub at: u64,
    pub id: String,
}

impl SidebarCursor {
    pub fn to_wire_value(&self) -> Json {
        let mut out = Map::with_capacity(2);
        out.insert("at", Json::Number(Number::from(self.at)));
        out.insert("id", Json::String(JsString::from(self.id.as_str())));
        Json::Object(out)
    }
}

/// One decoded sidebar thread entry paired with its `sidebar_thread_revisions` revision.
#[derive(Debug, Clone, PartialEq)]
pub struct SidebarEntry {
    pub thread: Json,
    pub revision: u64,
}

/// Window metadata (`ThreadListWindow`: `{ before, total, counts, revision }`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SidebarWindowMeta {
    pub before: Option<SidebarCursor>,
    pub total: usize,
    pub counts: Vec<SidebarCount>,
    pub revision: u64,
}

impl SidebarWindowMeta {
    /// Wire JSON object matching `ThreadListWindow` field order: `before`, `total`, `counts`, `revision`.
    pub fn to_wire_value(&self) -> Json {
        let mut out = Map::with_capacity(4);
        out.insert(
            "before",
            match &self.before {
                Some(cursor) => cursor.to_wire_value(),
                None => Json::Null,
            },
        );
        out.insert("total", Json::Number(Number::from(self.total as u64)));
        let counts: Vec<Json> = self
            .counts
            .iter()
            .map(|c| {
                let mut item = Map::with_capacity(2);
                item.insert("id", Json::String(JsString::from(c.id.as_str())));
                item.insert("threads", Json::Number(Number::from(c.threads as u64)));
                Json::Object(item)
            })
            .collect();
        out.insert("counts", Json::Array(Array::from(counts)));
        out.insert("revision", Json::Number(Number::from(self.revision)));
        Json::Object(out)
    }
}

/// One sidebar page read (`{ threads, window }`).
#[derive(Debug, Clone, PartialEq)]
pub struct SidebarPageResult {
    pub threads: Vec<SidebarEntry>,
    pub window: SidebarWindowMeta,
}

/// Retained entries from a live subscription so unchanged historical rows are not re-decoded.
pub struct PageReuse<'a> {
    pub entries: &'a HashMap<String, SidebarEntry>,
    pub changed: &'a HashSet<String>,
}

struct PageSql {
    source: String,
    counted: String,
    visible: String,
    paged: String,
    active: String,
    project: String,
    chats: String,
    scoped: String,
    counted_term: String,
    workspace: String,
    activity: String,
    id: String,
}

fn project_terms(workspace: &str) -> (String, String, String) {
    (
        format!("{workspace} = ?"),
        format!(
            "{workspace} IN (SELECT workspace_id FROM workspace_metadata WHERE kind = 'chat' AND workspace_id != ?)"
        ),
        format!(
            "{workspace} IN (SELECT ? UNION SELECT workspace_id FROM workspace_metadata WHERE kind = 'chat')"
        ),
    )
}

fn column_sql(archived: bool) -> PageSql {
    let (project, chats, scoped) = project_terms("sidebar.workspace_id");
    PageSql {
        source: "sidebar_thread_columns AS sidebar CROSS JOIN threads ON threads.id = sidebar.thread_id LEFT JOIN thread_cold AS cold ON cold.thread_id = threads.id LEFT JOIN sidebar_thread_revisions AS revisions ON revisions.thread_id = threads.id".to_owned(),
        counted: "sidebar_thread_columns AS sidebar".to_owned(),
        visible: format!("sidebar.deleted = 0 AND sidebar.archived = {}", if archived { 1 } else { 0 }),
        paged: if archived { "1".to_owned() } else { "sidebar.settled = 1".to_owned() },
        active: if archived { "0".to_owned() } else { "sidebar.settled = 0".to_owned() },
        project,
        chats,
        scoped,
        counted_term: "sidebar.counted = 1".to_owned(),
        workspace: "sidebar.workspace_id".to_owned(),
        activity: if archived { "sidebar.archived_at".to_owned() } else { "sidebar.activity".to_owned() },
        id: "sidebar.thread_id".to_owned(),
    }
}

fn expression_sql(archived: bool) -> PageSql {
    let settled = sidebar_settled_sql();
    let paged = if archived {
        "1".to_owned()
    } else {
        format!("({settled})")
    };
    let active = format!("NOT ({paged})");
    let (project, chats, scoped) = project_terms("workspace_id");
    PageSql {
        source: format!(
            "{THREAD_ROW_SOURCE} LEFT JOIN sidebar_thread_revisions AS revisions ON revisions.thread_id = threads.id"
        ),
        counted: "threads".to_owned(),
        visible: format!(
            "NOT ({SIDEBAR_DELETED}) AND archived_at IS {}NULL",
            if archived { "NOT " } else { "" }
        ),
        paged,
        active,
        project,
        chats,
        scoped,
        counted_term: format!("({SIDEBAR_COUNTED})"),
        workspace: "workspace_id".to_owned(),
        activity: if archived {
            "archived_at".to_owned()
        } else {
            SIDEBAR_ACTIVITY.to_owned()
        },
        id: "threads.id".to_owned(),
    }
}

fn page_query(
    sql: &PageSql,
    columns: &str,
    project: Option<&str>,
    with_chats: bool,
    cursor: &str,
) -> String {
    let order = format!("{} DESC, {} ASC", sql.activity, sql.id);
    if project.is_none() {
        return format!(
            "SELECT {columns} FROM {} WHERE {} AND {}{cursor} ORDER BY {order} LIMIT ?",
            sql.source, sql.visible, sql.paged
        );
    }
    if !with_chats {
        return format!(
            "SELECT {columns} FROM {} WHERE {} AND {} AND {}{cursor} ORDER BY {order} LIMIT ?",
            sql.source, sql.visible, sql.project, sql.paged
        );
    }
    let arm = |scope: &str| {
        format!(
            "SELECT {columns}, {} AS sidebar_order FROM {} WHERE {} AND {scope} AND {}{cursor} ORDER BY {order} LIMIT ?",
            sql.activity, sql.source, sql.visible, sql.paged
        )
    };
    format!(
        "SELECT * FROM ({}) UNION ALL SELECT * FROM ({}) ORDER BY sidebar_order DESC, id ASC LIMIT ?",
        arm(&sql.project),
        arm(&sql.chats)
    )
}

/// Read one sidebar page directly from SQLite (`sidebarPageStorage`), honouring PR #2737
/// `withChats` rules (two-arm `UNION ALL` for project + chats, strict project otherwise).
pub fn sidebar_page_storage(
    conn: &Arc<Connection>,
    scope: &SidebarScope,
    limit: usize,
    before: Option<&SidebarCursor>,
    reuse: Option<&PageReuse<'_>>,
) -> Result<SidebarPageResult, SidebarError> {
    let sql = if sidebar_columns_readable(conn)? {
        column_sql(scope.archived)
    } else {
        expression_sql(scope.archived)
    };
    let project = scope.project.as_deref();
    let scope_clause = match project {
        Some(_) => format!(
            " AND {}",
            if scope.with_chats {
                &sql.scoped
            } else {
                &sql.project
            }
        ),
        None => String::new(),
    };
    let matching = format!("{}{scope_clause}", sql.visible);
    let scope_params: Vec<Option<SqlValue>> = project
        .map(|p| vec![Some(SqlValue::Text(p.to_owned()))])
        .unwrap_or_default();

    let columns = if reuse.is_some() {
        "threads.id, COALESCE(revisions.revision, 0) AS sidebar_revision".to_owned()
    } else {
        format!("{THREAD_ROW_COLUMNS}, COALESCE(revisions.revision, 0) AS sidebar_revision")
    };

    let fetch_limit = (limit + 1) as i64;
    let cursor_sql = if before.is_some() {
        format!(
            " AND ({} < ? OR ({} = ? AND {} > ?))",
            sql.activity, sql.activity, sql.id
        )
    } else {
        String::new()
    };
    let cursor_params: Vec<Option<SqlValue>> = match before {
        Some(c) => vec![
            Some(SqlValue::Integer(c.at as i64)),
            Some(SqlValue::Integer(c.at as i64)),
            Some(SqlValue::Text(c.id.clone())),
        ],
        None => Vec::new(),
    };

    let mut page_params: Vec<Option<SqlValue>> = Vec::new();
    match (project, scope.with_chats) {
        (Some(p), true) => {
            page_params.push(Some(SqlValue::Text(p.to_owned())));
            page_params.extend(cursor_params.iter().cloned());
            page_params.push(Some(SqlValue::Integer(fetch_limit)));
            page_params.push(Some(SqlValue::Text(p.to_owned())));
            page_params.extend(cursor_params);
            page_params.push(Some(SqlValue::Integer(fetch_limit)));
            page_params.push(Some(SqlValue::Integer(fetch_limit)));
        }
        (Some(p), false) => {
            page_params.push(Some(SqlValue::Text(p.to_owned())));
            page_params.extend(cursor_params);
            page_params.push(Some(SqlValue::Integer(fetch_limit)));
        }
        (None, _) => {
            page_params.extend(cursor_params);
            page_params.push(Some(SqlValue::Integer(fetch_limit)));
        }
    }

    let query = page_query(&sql, &columns, project, scope.with_chats, &cursor_sql);
    let stmt = conn.prepare(&query)?;
    stmt.bind(&page_params)?;
    let mut raw_rows = Vec::new();
    while let Some(row) = stmt.step()? {
        raw_rows.push(row);
    }
    let has_more = raw_rows.len() > limit;

    let mut page = Vec::with_capacity(limit.min(raw_rows.len()));
    for row in raw_rows.into_iter().take(limit) {
        page.push(materialize_row(conn, &row, reuse)?);
    }

    let mut active = Vec::new();
    if before.is_none() {
        let active_sql = format!(
            "SELECT {columns} FROM {} WHERE {matching} AND {} ORDER BY {} DESC, {} ASC",
            sql.source, sql.active, sql.activity, sql.id
        );
        let active_stmt = conn.prepare(&active_sql)?;
        active_stmt.bind(&scope_params)?;
        while let Some(row) = active_stmt.step()? {
            active.push(materialize_row(conn, &row, reuse)?);
        }
    }

    let total_sql = format!(
        "SELECT COUNT(*) FROM {} WHERE {matching} AND {}",
        sql.counted, sql.paged
    );
    let total_stmt = conn.prepare(&total_sql)?;
    total_stmt.bind(&scope_params)?;
    let total = match total_stmt.step()? {
        Some(row) => sql_usize(row.first()),
        None => 0,
    };

    let counts_sql = format!(
        "SELECT {} AS id, COUNT(*) AS threads FROM {} WHERE {} AND {} GROUP BY {} ORDER BY {}",
        sql.workspace, sql.counted, sql.visible, sql.counted_term, sql.workspace, sql.workspace
    );
    let counts_stmt = conn.prepare(&counts_sql)?;
    let mut counts = Vec::new();
    while let Some(row) = counts_stmt.step()? {
        let id = row.first().map(sql_to_js_string).unwrap_or_default();
        let threads = sql_usize(row.get(1));
        counts.push(SidebarCount { id, threads });
    }

    let rev_stmt = conn.prepare("SELECT COALESCE(MAX(revision), 0) FROM sidebar_thread_revisions")?;
    let revision = match rev_stmt.step()? {
        Some(row) => sql_u64(row.first()),
        None => 0,
    };

    let next_before = if has_more {
        page.last().and_then(|last| sidebar_cursor(&last.thread, scope.archived))
    } else {
        None
    };

    let mut threads = Vec::with_capacity(active.len() + page.len());
    threads.extend(active);
    threads.extend(page);

    Ok(SidebarPageResult {
        threads,
        window: SidebarWindowMeta {
            before: next_before,
            total,
            counts,
            revision,
        },
    })
}

/// Compute the continuation cursor for the last entry on a page (`sidebarCursor`).
pub fn sidebar_cursor(entry: &Json, archived: bool) -> Option<SidebarCursor> {
    let id = match entry.get("id") {
        Some(Json::String(s)) => s.as_str().to_owned(),
        _ => return None,
    };
    let primary = if archived {
        entry.get("archivedAt")
    } else {
        entry.get("activityAt")
    };
    let at = primary
        .or_else(|| entry.get("updatedAt"))
        .and_then(|v| match v {
            Json::Number(n) => Some(n.value().max(0.0) as u64),
            _ => None,
        })?;
    Some(SidebarCursor { at, id })
}

fn materialize_row(
    conn: &Arc<Connection>,
    row: &[SqlValue],
    reuse: Option<&PageReuse<'_>>,
) -> Result<SidebarEntry, SidebarError> {
    if let Some(reuse) = reuse {
        let id = match row.first() {
            Some(SqlValue::Text(s)) => s.as_str(),
            _ => return Err(SidebarError::MalformedRow("id")),
        };
        let rev = sql_u64(row.get(1));
        if !reuse.changed.contains(id)
            && let Some(retained) = reuse.entries.get(id)
            && retained.revision == rev
        {
            return Ok(retained.clone());
        }
        return read_full_entry(conn, id);
    }
    let thread = decode_thread_sql_row(row).map_err(|e| SidebarError::Store(e.to_string()))?;
    let revision = sql_u64(row.get(THREAD_ROW_COLUMN_COUNT));
    Ok(SidebarEntry { thread, revision })
}

pub(crate) fn read_full_entry(
    conn: &Arc<Connection>,
    thread_id: &str,
) -> Result<SidebarEntry, SidebarError> {
    let sql = format!(
        "SELECT {THREAD_ROW_COLUMNS}, COALESCE(revisions.revision, 0) AS sidebar_revision FROM {THREAD_ROW_SOURCE} LEFT JOIN sidebar_thread_revisions AS revisions ON revisions.thread_id = threads.id WHERE threads.id = ?"
    );
    let stmt = conn.prepare(&sql)?;
    stmt.bind(&[Some(SqlValue::Text(thread_id.to_owned()))])?;
    let Some(row) = stmt.step()? else {
        return Err(SidebarError::MembershipChanged);
    };
    let thread = decode_thread_sql_row(&row).map_err(|e| SidebarError::Store(e.to_string()))?;
    let revision = sql_u64(row.get(THREAD_ROW_COLUMN_COUNT));
    Ok(SidebarEntry { thread, revision })
}

fn sql_u64(val: Option<&SqlValue>) -> u64 {
    match val {
        Some(SqlValue::Integer(n)) => (*n).max(0) as u64,
        Some(SqlValue::Real(n)) => (*n).max(0.0) as u64,
        _ => 0,
    }
}

fn sql_usize(val: Option<&SqlValue>) -> usize {
    sql_u64(val) as usize
}
