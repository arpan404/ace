//! Notes (ADR 0128, docs/memory.md): each bot's own and the shared "About you" set, searched
//! with FTS5, and the index of past text `history_search` reads, filled from the event log as it
//! is searched. Ranking and cleaning are `spade_core::memory`'s; this stores and queries.

use rusqlite::{OptionalExtension, Row, params};
use spade_core::Event;
use spade_core::memory;

use crate::{Result, Store};

/// The schema step that adds notes and the past-text index.
pub(crate) const SCHEMA: &str = "
    CREATE TABLE notes (
        id TEXT PRIMARY KEY,
        agent_id TEXT REFERENCES agents (id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        source TEXT NOT NULL,
        created_ms INTEGER NOT NULL,
        updated_ms INTEGER NOT NULL,
        used_ms INTEGER,
        uses INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX notes_by_scope ON notes (agent_id, updated_ms DESC);
    CREATE VIRTUAL TABLE notes_search USING fts5 (
        text, content = 'notes', content_rowid = 'rowid', tokenize = 'porter unicode61'
    );
    CREATE TRIGGER notes_added AFTER INSERT ON notes BEGIN
        INSERT INTO notes_search (rowid, text) VALUES (new.rowid, new.text);
    END;
    CREATE TRIGGER notes_removed AFTER DELETE ON notes BEGIN
        INSERT INTO notes_search (notes_search, rowid, text) VALUES ('delete', old.rowid, old.text);
    END;
    CREATE TRIGGER notes_changed AFTER UPDATE OF text ON notes BEGIN
        INSERT INTO notes_search (notes_search, rowid, text) VALUES ('delete', old.rowid, old.text);
        INSERT INTO notes_search (rowid, text) VALUES (new.rowid, new.text);
    END;
    CREATE TABLE history_indexed (
        conversation_id TEXT PRIMARY KEY REFERENCES conversations (id) ON DELETE CASCADE,
        upto INTEGER NOT NULL
    );
    CREATE VIRTUAL TABLE history_search USING fts5 (
        text, conversation_id UNINDEXED, seq UNINDEXED, tokenize = 'porter unicode61'
    );
    CREATE TRIGGER history_forgotten AFTER DELETE ON conversations BEGIN
        DELETE FROM history_search WHERE conversation_id = old.id;
    END;
";

/// A stored note.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredNote {
    pub id: String,
    /// The bot it belongs to; `None` for a shared note.
    pub agent: Option<String>,
    pub text: String,
    pub source: memory::Source,
    pub created_ms: i64,
    pub updated_ms: i64,
    pub used_ms: Option<i64>,
    pub uses: u32,
}

impl StoredNote {
    /// The note as ranking and the prompt read it.
    pub fn as_note(&self) -> memory::Note {
        memory::Note {
            id: self.id.clone(),
            text: self.text.clone(),
            shared: self.agent.is_none(),
            updated_ms: self.updated_ms,
            used_ms: self.used_ms,
            uses: self.uses,
        }
    }
}

/// Which notes a query covers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Notes<'a> {
    /// Only this bot's own.
    Own(&'a str),
    /// Only the shared ones.
    Shared,
    /// What this bot can see: its own and the shared ones.
    VisibleTo(&'a str),
}

impl Notes<'_> {
    fn clause(&self) -> &'static str {
        match self {
            Self::Own(_) => "n.agent_id = ?1",
            Self::Shared => "n.agent_id IS NULL AND ?1 IS NULL",
            Self::VisibleTo(_) => "(n.agent_id = ?1 OR n.agent_id IS NULL)",
        }
    }

    fn agent(&self) -> Option<&str> {
        match self {
            Self::Own(agent) | Self::VisibleTo(agent) => Some(agent),
            Self::Shared => None,
        }
    }
}

/// A match in a conversation's past: the event's position and the matching words around it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryMatch {
    pub seq: i64,
    pub snippet: String,
}

const COLUMNS: &str = "n.id, n.agent_id, n.text, n.source, n.created_ms, n.updated_ms, n.used_ms, \
                       n.uses";

fn note(row: &Row<'_>) -> rusqlite::Result<StoredNote> {
    let source: String = row.get(3)?;
    Ok(StoredNote {
        id: row.get(0)?,
        agent: row.get(1)?,
        text: row.get(2)?,
        source: memory::Source::parse(&source),
        created_ms: row.get(4)?,
        updated_ms: row.get(5)?,
        used_ms: row.get(6)?,
        uses: u32::try_from(row.get::<_, i64>(7)?).unwrap_or(0),
    })
}

impl Store {
    /// The notes `which` covers, most recently changed first.
    pub fn notes(&self, which: Notes<'_>) -> Result<Vec<StoredNote>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(&format!(
            "SELECT {COLUMNS} FROM notes n WHERE {} ORDER BY n.updated_ms DESC, n.id DESC",
            which.clause()
        ))?;
        let rows = statement.query_map(params![which.agent()], note)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// The notes `which` covers, most used then most recently used or changed first: the order
    /// the prompt's index lists them in.
    pub fn notes_by_use(&self, which: Notes<'_>) -> Result<Vec<StoredNote>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(&format!(
            "SELECT {COLUMNS} FROM notes n WHERE {}
             ORDER BY n.uses DESC, MAX(n.updated_ms, COALESCE(n.used_ms, 0)) DESC, n.id",
            which.clause()
        ))?;
        let rows = statement.query_map(params![which.agent()], note)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn note(&self, id: &str) -> Result<Option<StoredNote>> {
        let connection = self.lock()?;
        Ok(connection
            .query_row(
                &format!("SELECT {COLUMNS} FROM notes n WHERE n.id = ?1"),
                params![id],
                note,
            )
            .optional()?)
    }

    /// How many notes one scope holds: `agent`'s own, or the shared ones with `None`.
    pub fn count_notes(&self, agent: Option<&str>) -> Result<usize> {
        let connection = self.lock()?;
        let count: i64 = connection.query_row(
            "SELECT COUNT(*) FROM notes WHERE agent_id IS ?1",
            params![agent],
            |row| row.get(0),
        )?;
        Ok(usize::try_from(count).unwrap_or(0))
    }

    /// Stores a new note. `text` is already cleaned.
    pub fn add_note(
        &self,
        id: &str,
        agent: Option<&str>,
        text: &str,
        source: memory::Source,
        now_ms: i64,
    ) -> Result<StoredNote> {
        let connection = self.lock()?;
        connection.execute(
            "INSERT INTO notes (id, agent_id, text, source, created_ms, updated_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![id, agent, text, source.name(), now_ms],
        )?;
        Ok(connection.query_row(
            &format!("SELECT {COLUMNS} FROM notes n WHERE n.id = ?1"),
            params![id],
            note,
        )?)
    }

    /// Rewrites a note's text; `None` if there is no such note.
    pub fn update_note(&self, id: &str, text: &str, now_ms: i64) -> Result<Option<StoredNote>> {
        let connection = self.lock()?;
        let changed = connection.execute(
            "UPDATE notes SET text = ?2, updated_ms = ?3 WHERE id = ?1",
            params![id, text, now_ms],
        )?;
        if changed == 0 {
            return Ok(None);
        }
        Ok(connection
            .query_row(
                &format!("SELECT {COLUMNS} FROM notes n WHERE n.id = ?1"),
                params![id],
                note,
            )
            .optional()?)
    }

    /// Deletes a note; whether there was one.
    pub fn delete_note(&self, id: &str) -> Result<bool> {
        Ok(self
            .lock()?
            .execute("DELETE FROM notes WHERE id = ?1", params![id])?
            > 0)
    }

    /// Notes `which` covers that match the FTS5 `query`, each with its BM25 (lower is better), at
    /// most `limit`, best keyword match first.
    pub fn search_notes(
        &self,
        which: Notes<'_>,
        query: &str,
        limit: usize,
    ) -> Result<Vec<(StoredNote, f64)>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(&format!(
            "SELECT {COLUMNS}, bm25(notes_search) FROM notes_search
             JOIN notes n ON n.rowid = notes_search.rowid
             WHERE notes_search MATCH ?2 AND {}
             ORDER BY bm25(notes_search) LIMIT ?3",
            which.clause()
        ))?;
        let limit = i64::try_from(limit).unwrap_or(i64::MAX);
        let rows = statement.query_map(params![which.agent(), query, limit], |row| {
            Ok((note(row)?, row.get::<_, f64>(8)?))
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Counts the notes as used now: shown in a prompt or returned by a search.
    pub fn mark_used(&self, ids: &[String], now_ms: i64) -> Result<()> {
        let mut connection = self.lock()?;
        let tx = connection.transaction()?;
        for id in ids {
            tx.execute(
                "UPDATE notes SET used_ms = ?2, uses = uses + 1 WHERE id = ?1",
                params![id, now_ms],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Events of `conversation` matching the FTS5 `query`, best first, at most `limit`. Events
    /// stored since the last search are indexed first, so the cost follows what is new.
    pub fn search_history(
        &self,
        conversation: &str,
        query: &str,
        limit: usize,
    ) -> Result<Vec<HistoryMatch>> {
        let mut connection = self.lock()?;
        let tx = connection.transaction()?;
        let upto: i64 = tx
            .query_row(
                "SELECT upto FROM history_indexed WHERE conversation_id = ?1",
                params![conversation],
                |row| row.get(0),
            )
            .optional()?
            .unwrap_or(0);
        let mut last = upto;
        {
            let mut read = tx.prepare(
                "SELECT seq, body FROM events WHERE conversation_id = ?1 AND seq > ?2 ORDER BY seq",
            )?;
            let mut write = tx.prepare(
                "INSERT INTO history_search (text, conversation_id, seq) VALUES (?1, ?2, ?3)",
            )?;
            let mut rows = read.query(params![conversation, upto])?;
            while let Some(row) = rows.next()? {
                let seq: i64 = row.get(0)?;
                let body: String = row.get(1)?;
                last = seq;
                let event = Event::from_json(
                    serde_json::from_str(&body).unwrap_or(serde_json::Value::String(body)),
                );
                if let Some(text) = memory::searchable(&event) {
                    write.execute(params![text, conversation, seq])?;
                }
            }
        }
        if last > upto {
            // Only for a conversation that exists: its events are there.
            tx.execute(
                "INSERT INTO history_indexed (conversation_id, upto) VALUES (?1, ?2)
                 ON CONFLICT (conversation_id) DO UPDATE SET upto = excluded.upto",
                params![conversation, last],
            )?;
        }
        let found = {
            let mut statement = tx.prepare(
                "SELECT seq, snippet(history_search, 0, '', '', '…', 24) FROM history_search
                 WHERE history_search MATCH ?1 AND conversation_id = ?2
                 ORDER BY bm25(history_search) LIMIT ?3",
            )?;
            let limit = i64::try_from(limit).unwrap_or(i64::MAX);
            let rows = statement.query_map(params![query, conversation, limit], |row| {
                Ok(HistoryMatch {
                    seq: row.get(0)?,
                    snippet: row.get(1)?,
                })
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        tx.commit()?;
        Ok(found)
    }
}
