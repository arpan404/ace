//! Knowledge bases (ADR 0164, docs/knowledge.md): each bot's entries, searched with FTS5, their
//! links, and the folds that keep a base within its bound. What to fold, when two entries are
//! the same and what trust an entry gets are `spade_core::knowledge`'s; this stores and queries,
//! and applies a write and its folds in one transaction.

use rusqlite::{OptionalExtension, Row, Transaction, params};
use spade_core::knowledge::{self, Entry, Fold, Kind, Relation, SourceKind, Trust};

use crate::{Result, Store};

/// An entry of no bot still arriving (ADR 0187), as `k` and as its own row; and those that are.
const LIVE_ENTRY: &str =
    "k.agent_id NOT IN (SELECT id FROM move_claims WHERE kind = 'agent' AND hidden = 1)";
const LIVE_ENTRY_ROW: &str =
    "agent_id NOT IN (SELECT id FROM move_claims WHERE kind = 'agent' AND hidden = 1)";
const ARRIVING_ENTRIES: &str = "(SELECT id FROM knowledge WHERE agent_id IN \
     (SELECT id FROM move_claims WHERE kind = 'agent' AND hidden = 1))";

/// The schema step that adds knowledge bases and episodes.
pub(crate) const SCHEMA: &str = "
    CREATE TABLE knowledge (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
        topic TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        kind TEXT NOT NULL,
        source TEXT NOT NULL,
        source_detail TEXT,
        trust TEXT NOT NULL,
        author TEXT,
        created_ms INTEGER NOT NULL,
        updated_ms INTEGER NOT NULL,
        used_ms INTEGER,
        uses INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX knowledge_by_topic ON knowledge (agent_id, topic, updated_ms);
    CREATE VIRTUAL TABLE knowledge_search USING fts5 (
        topic, title, body, content = 'knowledge', content_rowid = 'rowid',
        tokenize = 'porter unicode61'
    );
    CREATE TRIGGER knowledge_added AFTER INSERT ON knowledge BEGIN
        INSERT INTO knowledge_search (rowid, topic, title, body)
        VALUES (new.rowid, new.topic, new.title, new.body);
    END;
    CREATE TRIGGER knowledge_removed AFTER DELETE ON knowledge BEGIN
        INSERT INTO knowledge_search (knowledge_search, rowid, topic, title, body)
        VALUES ('delete', old.rowid, old.topic, old.title, old.body);
    END;
    CREATE TRIGGER knowledge_changed AFTER UPDATE OF topic, title, body ON knowledge BEGIN
        INSERT INTO knowledge_search (knowledge_search, rowid, topic, title, body)
        VALUES ('delete', old.rowid, old.topic, old.title, old.body);
        INSERT INTO knowledge_search (rowid, topic, title, body)
        VALUES (new.rowid, new.topic, new.title, new.body);
    END;
    CREATE TABLE knowledge_links (
        from_id TEXT NOT NULL REFERENCES knowledge (id) ON DELETE CASCADE,
        to_id TEXT NOT NULL REFERENCES knowledge (id) ON DELETE CASCADE,
        relation TEXT NOT NULL,
        PRIMARY KEY (from_id, to_id)
    ) WITHOUT ROWID;
    CREATE INDEX knowledge_links_to ON knowledge_links (to_id);
";

/// A stored entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredEntry {
    pub id: String,
    /// The bot whose base holds it.
    pub agent: String,
    pub topic: String,
    pub title: String,
    pub body: String,
    pub kind: Kind,
    pub source: SourceKind,
    /// The URL, path or tool and call it came from.
    pub source_detail: Option<String>,
    pub trust: Trust,
    /// The bot that wrote it; `None` for the person.
    pub author: Option<String>,
    pub created_ms: i64,
    pub updated_ms: i64,
    pub used_ms: Option<i64>,
    pub uses: u32,
    /// Where it came from beyond its source: the conversation, the message, what was in view.
    pub origin: Option<spade_core::provenance::Origin>,
}

impl StoredEntry {
    /// The entry as the rules read it.
    pub fn as_entry(&self) -> Entry {
        Entry {
            id: self.id.clone(),
            topic: self.topic.clone(),
            title: self.title.clone(),
            body: self.body.clone(),
            kind: self.kind,
            source: self.source,
            trust: self.trust,
            by_person: self.author.is_none(),
            created_ms: self.created_ms,
            updated_ms: self.updated_ms,
        }
    }
}

/// An entry to store; its text already cleaned and its trust decided.
#[derive(Debug, Clone)]
pub struct NewEntry<'a> {
    pub id: &'a str,
    pub agent: &'a str,
    pub topic: &'a str,
    pub title: &'a str,
    pub body: &'a str,
    pub kind: Kind,
    pub source: SourceKind,
    pub source_detail: Option<&'a str>,
    pub trust: Trust,
    pub author: Option<&'a str>,
    pub now_ms: i64,
}

/// What a write did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Written {
    New {
        entry: StoredEntry,
        /// Entries in its topic alike enough to merge.
        alike: Vec<StoredEntry>,
        /// How many older entries were folded into digests to make room.
        folded: usize,
    },
    /// An entry in its topic already says this.
    Exists(StoredEntry),
    /// The base is at its bound and nothing more may fold.
    Full,
}

/// A change to an entry's text, topic or kind; `None` keeps what it is.
#[derive(Debug, Clone, Default)]
pub struct EntryChange<'a> {
    pub topic: Option<&'a str>,
    pub title: Option<&'a str>,
    pub body: Option<&'a str>,
    pub kind: Option<Kind>,
    pub trust: Option<Trust>,
}

/// What a change did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Changed {
    Done(StoredEntry),
    /// It changed since the version the caller started from; this is the entry now.
    Moved(StoredEntry),
    Missing,
}

/// A link from or to an entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EntryLink {
    pub other: String,
    pub relation: Relation,
    /// From this entry to `other`.
    pub outgoing: bool,
}

const COLUMNS: &str = "k.id, k.agent_id, k.topic, k.title, k.body, k.kind, k.source, \
                       k.source_detail, k.trust, k.author, k.created_ms, k.updated_ms, \
                       k.used_ms, k.uses, k.origin";

fn entry(row: &Row<'_>) -> rusqlite::Result<StoredEntry> {
    Ok(StoredEntry {
        id: row.get(0)?,
        agent: row.get(1)?,
        topic: row.get(2)?,
        title: row.get(3)?,
        body: row.get(4)?,
        kind: Kind::parse(&row.get::<_, String>(5)?),
        source: SourceKind::parse(&row.get::<_, String>(6)?),
        source_detail: row.get(7)?,
        trust: Trust::parse(&row.get::<_, String>(8)?),
        author: row.get(9)?,
        created_ms: row.get(10)?,
        updated_ms: row.get(11)?,
        used_ms: row.get(12)?,
        uses: u32::try_from(row.get::<_, i64>(13)?).unwrap_or(0),
        origin: spade_core::provenance::Origin::parse(row.get::<_, Option<String>>(14)?.as_deref()),
    })
}

fn base_in(tx: &Transaction<'_>, agent: &str) -> rusqlite::Result<Vec<StoredEntry>> {
    let mut statement = tx.prepare(&format!(
        "SELECT {COLUMNS} FROM knowledge k WHERE k.agent_id = ?1 ORDER BY k.updated_ms, k.id"
    ))?;
    let rows = statement.query_map(params![agent], entry)?;
    rows.collect()
}

fn one_in(tx: &rusqlite::Connection, id: &str) -> rusqlite::Result<Option<StoredEntry>> {
    tx.query_row(
        &format!("SELECT {COLUMNS} FROM knowledge k WHERE k.id = ?1 AND {LIVE_ENTRY}"),
        params![id],
        entry,
    )
    .optional()
}

fn insert(tx: &Transaction<'_>, new: &NewEntry<'_>) -> rusqlite::Result<()> {
    tx.execute(
        "INSERT INTO knowledge (id, agent_id, topic, title, body, kind, source, source_detail,
                                trust, author, created_ms, updated_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)",
        params![
            new.id,
            new.agent,
            new.topic,
            new.title,
            new.body,
            new.kind.name(),
            new.source.name(),
            new.source_detail,
            new.trust.name(),
            new.author,
            new.now_ms
        ],
    )?;
    Ok(())
}

/// Moves every link of `from` to `to`, leaving out links between the two and repeats.
fn move_links(tx: &Transaction<'_>, from: &str, to: &str) -> rusqlite::Result<()> {
    tx.execute(
        "INSERT OR IGNORE INTO knowledge_links (from_id, to_id, relation)
         SELECT ?2, to_id, relation FROM knowledge_links WHERE from_id = ?1 AND to_id <> ?2",
        params![from, to],
    )?;
    tx.execute(
        "INSERT OR IGNORE INTO knowledge_links (from_id, to_id, relation)
         SELECT from_id, ?2, relation FROM knowledge_links WHERE to_id = ?1 AND from_id <> ?2",
        params![from, to],
    )?;
    Ok(())
}

/// Replaces each fold's entries with one digest entry, whose links are theirs.
fn apply_folds(
    tx: &Transaction<'_>,
    agent: &str,
    base: &[StoredEntry],
    folds: &[Fold],
    ids: &mut dyn FnMut() -> String,
    now_ms: i64,
) -> rusqlite::Result<usize> {
    let mut folded = 0;
    for fold in folds {
        let entries: Vec<Entry> = base
            .iter()
            .filter(|e| fold.entries.contains(&e.id))
            .map(StoredEntry::as_entry)
            .collect();
        let refs: Vec<&Entry> = entries.iter().collect();
        let (title, body) = knowledge::digest(&refs);
        let id = ids();
        insert(
            tx,
            &NewEntry {
                id: &id,
                agent,
                topic: &fold.topic,
                title: &title,
                body: &body,
                kind: Kind::Summary,
                source: SourceKind::Bot,
                source_detail: None,
                trust: fold.trust,
                author: Some(agent),
                now_ms,
            },
        )?;
        for old in &fold.entries {
            move_links(tx, old, &id)?;
            tx.execute("DELETE FROM knowledge WHERE id = ?1", params![old])?;
            folded += 1;
        }
    }
    Ok(folded)
}

impl Store {
    /// One bot's entries, most recently changed first; only `topic`'s with one.
    pub fn knowledge(&self, agent: &str, topic: Option<&str>) -> Result<Vec<StoredEntry>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(&format!(
            "SELECT {COLUMNS} FROM knowledge k WHERE k.agent_id = ?1 AND (?2 IS NULL OR k.topic = ?2)
               AND {LIVE_ENTRY}
             ORDER BY k.updated_ms DESC, k.id DESC"
        ))?;
        let rows = statement.query_map(params![agent, topic], entry)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn knowledge_entry(&self, id: &str) -> Result<Option<StoredEntry>> {
        let connection = self.lock()?;
        Ok(one_in(&connection, id)?)
    }

    /// Entries of the bases of `agents` matching the FTS5 `query`, each with its BM25 (lower is
    /// better), best first, at most `limit`.
    pub fn search_knowledge(
        &self,
        agents: &[String],
        query: &str,
        limit: usize,
    ) -> Result<Vec<(StoredEntry, f64)>> {
        if agents.is_empty() {
            return Ok(Vec::new());
        }
        let connection = self.lock()?;
        let bases = serde_json::to_string(agents).unwrap_or_else(|_| "[]".to_owned());
        let mut statement = connection.prepare(&format!(
            "SELECT {COLUMNS}, bm25(knowledge_search) FROM knowledge_search
             JOIN knowledge k ON k.rowid = knowledge_search.rowid
             WHERE knowledge_search MATCH ?1
               AND k.agent_id IN (SELECT value FROM json_each(?2)) AND {LIVE_ENTRY}
             ORDER BY bm25(knowledge_search) LIMIT ?3"
        ))?;
        let limit = i64::try_from(limit).unwrap_or(i64::MAX);
        let rows = statement.query_map(params![query, bases, limit], |row| {
            Ok((entry(row)?, row.get::<_, f64>(15)?))
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Records where entry `id` came from, once it is written.
    pub fn set_entry_origin(
        &self,
        id: &str,
        origin: &spade_core::provenance::Origin,
    ) -> Result<()> {
        let text = serde_json::to_string(origin).unwrap_or_default();
        self.lock()?.execute(
            "UPDATE knowledge SET origin = ?2 WHERE id = ?1",
            params![id, text],
        )?;
        Ok(())
    }

    /// Stores an entry in one transaction: unless one in its topic says the same; after folding
    /// the base's oldest bot-written entries if it would pass `limit` bytes (refused as
    /// [`Written::Full`] when folding can't make room); then folds its topic if it grew past
    /// its bound. `ids` names the digests made.
    pub fn write_knowledge(
        &self,
        new: NewEntry<'_>,
        limit: u64,
        ids: &mut dyn FnMut() -> String,
    ) -> Result<Written> {
        let mut connection = self.lock()?;
        let tx = connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let base = base_in(&tx, new.agent)?;
        if let Some(found) = base.iter().find(|e| {
            e.topic == new.topic && knowledge::same(&e.title, &e.body, new.title, new.body)
        }) {
            return Ok(Written::Exists(found.clone()));
        }
        let entries: Vec<Entry> = base.iter().map(StoredEntry::as_entry).collect();
        let incoming = (new.topic.len() + new.title.len() + new.body.len()) as u64;
        let Some(folds) = knowledge::bound_folds(&entries, limit, incoming) else {
            return Ok(Written::Full);
        };
        let mut folded = apply_folds(&tx, new.agent, &base, &folds, ids, new.now_ms)?;
        insert(&tx, &new)?;
        let topic = {
            let mut statement = tx.prepare(&format!(
                "SELECT {COLUMNS} FROM knowledge k WHERE k.agent_id = ?1 AND k.topic = ?2"
            ))?;
            let rows = statement.query_map(params![new.agent, new.topic], entry)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        let topic_entries: Vec<Entry> = topic.iter().map(StoredEntry::as_entry).collect();
        let grown = knowledge::topic_folds(&topic_entries);
        // The entry just written is the newest: folding oldest first leaves it.
        folded += apply_folds(&tx, new.agent, &topic, &grown, ids, new.now_ms)?;
        let written = one_in(&tx, new.id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)?;
        let written_entry = written.as_entry();
        let alike = topic
            .iter()
            .filter(|e| e.id != new.id && one_in(&tx, &e.id).ok().flatten().is_some())
            .filter(|e| knowledge::alike(&e.as_entry(), &written_entry))
            .cloned()
            .collect();
        tx.commit()?;
        Ok(Written::New {
            entry: written,
            alike,
            folded,
        })
    }

    /// Changes an entry. With `expected`, only if it was last changed then.
    pub fn change_knowledge(
        &self,
        id: &str,
        change: &EntryChange<'_>,
        expected: Option<i64>,
        now_ms: i64,
    ) -> Result<Changed> {
        let connection = self.lock()?;
        let changed = connection.execute(
            &format!(
                "UPDATE knowledge SET topic = COALESCE(?2, topic), title = COALESCE(?3, title),
                 body = COALESCE(?4, body), kind = COALESCE(?5, kind),
                 trust = COALESCE(?6, trust), updated_ms = MAX(?7, updated_ms + 1)
             WHERE id = ?1 AND (?8 IS NULL OR updated_ms = ?8) AND {LIVE_ENTRY_ROW}"
            ),
            params![
                id,
                change.topic,
                change.title,
                change.body,
                change.kind.map(Kind::name),
                change.trust.map(Trust::name),
                now_ms,
                expected
            ],
        )?;
        Ok(match (changed, one_in(&connection, id)?) {
            (_, None) => Changed::Missing,
            (0, Some(entry)) => Changed::Moved(entry),
            (_, Some(entry)) => Changed::Done(entry),
        })
    }

    /// Deletes an entry and its links; whether there was one.
    pub fn delete_knowledge(&self, id: &str) -> Result<bool> {
        Ok(self.lock()?.execute(
            &format!("DELETE FROM knowledge WHERE id = ?1 AND {LIVE_ENTRY_ROW}"),
            params![id],
        )? > 0)
    }

    /// Links `from` to `to`, replacing any link between them in that direction.
    pub fn link_knowledge(&self, from: &str, to: &str, relation: Relation) -> Result<()> {
        self.lock()?.execute(
            &format!(
                "INSERT INTO knowledge_links (from_id, to_id, relation)
                 SELECT ?1, ?2, ?3 WHERE ?1 NOT IN {ARRIVING_ENTRIES} AND ?2 NOT IN {ARRIVING_ENTRIES}
                 ON CONFLICT (from_id, to_id) DO UPDATE SET relation = excluded.relation"
            ),
            params![from, to, relation.name()],
        )?;
        Ok(())
    }

    /// Removes the link from `from` to `to`; whether there was one.
    pub fn unlink_knowledge(&self, from: &str, to: &str) -> Result<bool> {
        Ok(self.lock()?.execute(
            &format!(
                "DELETE FROM knowledge_links WHERE from_id = ?1 AND to_id = ?2
                 AND from_id NOT IN {ARRIVING_ENTRIES}"
            ),
            params![from, to],
        )? > 0)
    }

    /// The links from and to an entry.
    pub fn knowledge_links(&self, id: &str) -> Result<Vec<EntryLink>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(&format!(
            "SELECT to_id, relation, 1 FROM knowledge_links WHERE from_id = ?1
               AND to_id NOT IN {ARRIVING_ENTRIES} AND from_id NOT IN {ARRIVING_ENTRIES}
             UNION ALL
             SELECT from_id, relation, 0 FROM knowledge_links WHERE to_id = ?1
               AND to_id NOT IN {ARRIVING_ENTRIES} AND from_id NOT IN {ARRIVING_ENTRIES}
             ORDER BY 3 DESC, 1"
        ))?;
        let rows = statement.query_map(params![id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (other, relation, outgoing) = row?;
            if let Some(relation) = Relation::parse(&relation) {
                out.push(EntryLink {
                    other,
                    relation,
                    outgoing: outgoing != 0,
                });
            }
        }
        Ok(out)
    }

    /// Folds `from` into `into` in one transaction: their bodies appended under their titles,
    /// their links moved, then they are deleted. `None` when the merged body would be too long
    /// or an entry is missing; `into` is lowered to untrusted if any of them is.
    pub fn merge_knowledge(
        &self,
        into: &str,
        from: &[String],
        now_ms: i64,
    ) -> Result<Option<StoredEntry>> {
        let mut connection = self.lock()?;
        let tx = connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let Some(target) = one_in(&tx, into)? else {
            return Ok(None);
        };
        let mut body = target.body.clone();
        let mut trust = target.trust;
        for id in from.iter().filter(|id| *id != into) {
            let Some(other) = one_in(&tx, id)? else {
                return Ok(None);
            };
            body.push_str(&format!("\n\n{}:\n{}", other.title, other.body));
            if other.trust == Trust::Untrusted {
                trust = Trust::Untrusted;
            }
        }
        if body.chars().count() > knowledge::BODY_CHARS {
            return Ok(None);
        }
        for id in from.iter().filter(|id| *id != into) {
            move_links(&tx, id, into)?;
            tx.execute("DELETE FROM knowledge WHERE id = ?1", params![id])?;
        }
        tx.execute(
            &format!(
                "UPDATE knowledge SET body = ?2, trust = ?3, updated_ms = MAX(?4, updated_ms + 1)
             WHERE id = ?1 AND {LIVE_ENTRY_ROW}"
            ),
            params![into, body, trust.name(), now_ms],
        )?;
        let merged = one_in(&tx, into)?;
        tx.commit()?;
        Ok(merged)
    }

    /// Counts the entries as used now: shown in a prompt or returned by a search.
    pub fn mark_knowledge_used(&self, ids: &[String], now_ms: i64) -> Result<()> {
        let mut connection = self.lock()?;
        let tx = connection.transaction()?;
        for id in ids {
            tx.execute(
                &format!("UPDATE knowledge SET used_ms = ?2, uses = uses + 1 WHERE id = ?1 AND {LIVE_ENTRY_ROW}"),
                params![id, now_ms],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// The bytes one base holds, as its bound counts them.
    pub fn knowledge_bytes(&self, agent: &str) -> Result<u64> {
        let bytes: i64 = self.lock()?.query_row(
            &format!(
                "SELECT COALESCE(SUM(LENGTH(CAST(topic AS BLOB)) + LENGTH(CAST(title AS BLOB))
                                 + LENGTH(CAST(body AS BLOB))), 0)
             FROM knowledge WHERE agent_id = ?1 AND {LIVE_ENTRY_ROW}"
            ),
            params![agent],
            |row| row.get(0),
        )?;
        Ok(u64::try_from(bytes).unwrap_or(0))
    }
}

#[cfg(test)]
mod tests;
