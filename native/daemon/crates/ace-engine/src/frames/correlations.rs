// SPDX-License-Identifier: Apache-2.0
//! Durable input correlation (`attachment-correlations.ts`), independent of transcript bodies and
//! native echo timing. The DDL text is the TypeScript's byte for byte: SQLite stores it in
//! `sqlite_master`, so a home created by either backend has the same schema text.

use crate::EngineError;
use ace_json::{JsString, Value};
use ace_store::{Connection, Value as Row, stmt_cache};
use std::sync::Arc;

/// The repository's table text, exactly as `attachment-correlations.ts:20` writes it.
pub const DDL: &str = "CREATE TABLE IF NOT EXISTS engine_attachment_inputs (
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      sha256 TEXT NOT NULL, intent_id INTEGER NOT NULL,
      attachment JSON NOT NULL, PRIMARY KEY(thread_id,sha256)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS engine_attachment_paths (
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      sha256 TEXT NOT NULL, path TEXT NOT NULL, PRIMARY KEY(thread_id,sha256)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS engine_attachment_read_paths ON engine_attachment_paths(thread_id,path);";

/// `Attachment`'s key order (`packages/protocol/src/context.ts:138`).
const ATTACHMENT_KEYS: [&str; 9] = [
    "sha256",
    "bytes",
    "mimeType",
    "name",
    "kind",
    "delivery",
    "width",
    "height",
    "thumbnailAvailable",
];

/// The most attachments one `remember` may write.
const MAX_ATTACHMENTS: usize = 64;

/// The most paths one `remember_paths` may write, and the longest one.
const MAX_PATHS: usize = 64;
const MAX_PATH_POINTS: usize = 4096;

/// What `Attachment.parse` returns for a stored row: the schema's key order, unknown keys
/// dropped.
fn project(attachment: &Value) -> Result<Value, EngineError> {
    let Value::Object(map) = attachment else {
        return Err(EngineError::InvalidStoredAttachment);
    };
    let mut projected = ace_json::Map::new();
    for key in ATTACHMENT_KEYS {
        if let Some(value) = map.get(key) {
            projected.insert(key, value.clone());
        }
    }
    match projected.get("sha256") {
        Some(Value::String(text)) if !text.is_empty() => Ok(Value::Object(projected)),
        _ => Err(EngineError::InvalidStoredAttachment),
    }
}

fn text(value: &JsString) -> String {
    value.to_string_lossy().into_owned()
}

/// The input correlation store, over the connection's prepared-statements cache.
pub struct Correlations {
    conn: Arc<Connection>,
}

impl Correlations {
    /// `new AttachmentCorrelations(store)`: the DDL in one transaction, every statement
    /// `IF NOT EXISTS`, so an existing home does no history-sized work (ADR 0170).
    pub fn open(conn: &Arc<Connection>) -> Result<Correlations, EngineError> {
        let store = Correlations {
            conn: Arc::clone(conn),
        };
        conn.exec("BEGIN")?;
        match conn.exec(DDL) {
            Ok(()) => conn.exec("COMMIT")?,
            Err(error) => {
                let _ = conn.exec("ROLLBACK");
                return Err(EngineError::Store(error));
            }
        }
        Ok(store)
    }

    /// The same store over a connection whose DDL the opener already ran: the repository's
    /// `attachments.get` (E5.3) reads through it without repeating the statements.
    pub fn on(conn: &Arc<Connection>) -> Correlations {
        Correlations {
            conn: Arc::clone(conn),
        }
    }

    /// Upsert each attachment in schema order, refusing the batch before writing anything.
    pub fn remember(
        &self,
        thread: &str,
        intent: i64,
        attachments: &[Value],
    ) -> Result<(), EngineError> {
        if attachments.len() > MAX_ATTACHMENTS {
            return Err(EngineError::InvalidStoredAttachment);
        }
        let mut rows = Vec::with_capacity(attachments.len());
        for attachment in attachments {
            let projected = project(attachment)?;
            rows.push(projected);
        }
        for attachment in rows {
            let sha256 = match attachment.as_object().and_then(|map| map.get("sha256")) {
                Some(Value::String(text)) => text.clone(),
                _ => return Err(EngineError::InvalidStoredAttachment),
            };
            let statement = self.conn.prepare(
                "INSERT INTO engine_attachment_inputs VALUES (?,?,?,?)
        ON CONFLICT(thread_id,sha256) DO UPDATE SET intent_id=excluded.intent_id,attachment=excluded.attachment",
            )?;
            statement.bind(&[
                Some(Row::Text(thread.to_string())),
                Some(Row::Text(text(&sha256))),
                Some(Row::Integer(intent)),
                Some(Row::Text(ace_json::to_string(&attachment))),
            ])?;
            statement.step()?;
        }
        Ok(())
    }

    /// One remembered attachment, in `Attachment`'s key order.
    pub fn get(&self, thread: &str, hash: &str) -> Result<Option<Value>, EngineError> {
        let row = stmt_cache::get_row_raw(
            &self.conn,
            "SELECT attachment FROM engine_attachment_inputs WHERE thread_id=? AND sha256=?",
            vec![Row::Text(thread.to_string()), Row::Text(hash.to_string())],
        )?;
        let Some(row) = row else {
            return Ok(None);
        };
        let Some(Row::Text(stored)) = row.into_iter().next() else {
            return Err(EngineError::InvalidStoredAttachment);
        };
        let parsed = ace_json::parse(&stored).map_err(|_| EngineError::InvalidStoredAttachment)?;
        project(&parsed).map(Some)
    }

    /// Upsert each input path; a malformed list is refused before anything is written.
    pub fn remember_paths(
        &self,
        thread: &str,
        paths: &[(String, String)],
    ) -> Result<(), EngineError> {
        if paths.len() > MAX_PATHS {
            return Err(EngineError::InvalidStoredAttachment);
        }
        for (sha256, path) in paths {
            if path.is_empty() || path.chars().count() > MAX_PATH_POINTS || sha256.is_empty() {
                return Err(EngineError::InvalidStoredAttachment);
            }
        }
        for (sha256, path) in paths {
            let statement = self.conn.prepare(
                "INSERT INTO engine_attachment_paths VALUES (?,?,?) ON CONFLICT(thread_id,sha256) DO UPDATE SET path=excluded.path",
            )?;
            statement.bind(&[
                Some(Row::Text(thread.to_string())),
                Some(Row::Text(sha256.clone())),
                Some(Row::Text(path.clone())),
            ])?;
            statement.step()?;
        }
        Ok(())
    }

    /// Whether the thread exists, is not deleted, and has this path.
    pub fn can_read(&self, thread: &str, path: &str) -> Result<bool, EngineError> {
        let owner = stmt_cache::get_row_raw(
            &self.conn,
            "SELECT 1 FROM threads WHERE id=? AND json_extract(client,'$.deletedAt') IS NULL",
            vec![Row::Text(thread.to_string())],
        )?;
        if owner.is_none() {
            return Ok(false);
        }
        let row = stmt_cache::get_row_raw(
            &self.conn,
            "SELECT 1 FROM engine_attachment_paths WHERE thread_id=? AND path=?",
            vec![Row::Text(thread.to_string()), Row::Text(path.to_string())],
        )?;
        Ok(row.is_some())
    }
}

#[cfg(test)]
mod tests {
    use super::Correlations;
    use ace_json::json;
    use ace_store::{Connection, OpenOptions};
    use std::sync::Arc;

    fn temp_connection() -> (Arc<Connection>, std::path::PathBuf) {
        let path = std::env::temp_dir().join(format!(
            "ace-correlations-{}-{}.sqlite",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|since| since.as_nanos())
                .unwrap_or(0)
        ));
        let conn = Connection::open(path.to_str().unwrap_or(""), OpenOptions::default())
            .expect("a temp connection");
        conn.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, client TEXT NOT NULL)")
            .expect("a threads table");
        conn.exec("INSERT INTO threads (id, client) VALUES ('t1', '{}')")
            .expect("a thread row");
        (conn, path)
    }

    #[test]
    fn remember_writes_each_attachment_in_schema_order_without_unknown_keys() {
        let (conn, path) = temp_connection();
        let correlations = Correlations::open(&conn).expect("the DDL");
        correlations
            .remember(
                "t1",
                7,
                &[json!({"mimeType": "image/png", "sha256": "abc", "bytes": 3, "extra": 1})],
            )
            .expect("a remember");
        let stored = correlations
            .get("t1", "abc")
            .expect("a read")
            .expect("a row");
        assert_eq!(
            ace_json::to_string(&stored),
            "{\"sha256\":\"abc\",\"bytes\":3,\"mimeType\":\"image/png\"}"
        );
        drop(correlations);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn opening_twice_leaves_sqlite_master_with_the_type_scripts_ddl_text() {
        let (conn, path) = temp_connection();
        Correlations::open(&conn).expect("the first open");
        Correlations::open(&conn).expect("the second open");
        let row = ace_store::stmt_cache::get_row_raw(
            &conn,
            "SELECT sql FROM sqlite_master WHERE name='engine_attachment_inputs'",
            vec![],
        )
        .expect("a read")
        .expect("the table");
        let Some(ace_store::Value::Text(sql)) = row.into_iter().next() else {
            panic!("the table's text");
        };
        // SQLite stores the text with `IF NOT EXISTS` normalized out, whichever backend wrote
        // it, so this is the TypeScript's DDL text as SQLite keeps it.
        let expected = super::DDL.replace("CREATE TABLE IF NOT EXISTS", "CREATE TABLE");
        assert!(
            expected.contains(sql.as_str()),
            "the stored text is ours: {sql:?}"
        );
        drop(conn);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn an_attachment_path_accepts_4096_emoji() {
        let (conn, path) = temp_connection();
        let correlations = Correlations::open(&conn).expect("correlations");
        for length in [4096, 4097] {
            let input = [("sha".to_owned(), "😀".repeat(length))];
            assert_eq!(
                correlations.remember_paths("t1", &input).is_ok(),
                length == 4096
            );
        }
        drop(correlations);
        drop(conn);
        let _ = std::fs::remove_file(path);
    }
}
