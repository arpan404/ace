//! Groups, and asks between machines (ADR 0132). A group is a row, its members, and a
//! conversation holding its transcript. The outbox holds asks this Spade sends to bots of other
//! machines until they are answered; the inbox records each ask another machine sent here, by
//! key, in the same transaction as the message it delivered, so an ask is delivered once.

use rusqlite::{OptionalExtension, Row, params};
use spade_core::Event;

use crate::{Result, Store, StoreError, StoredEvent};

pub(crate) const SCHEMA: &str = "
    CREATE TABLE groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        lead_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL UNIQUE REFERENCES conversations (id),
        created_ms INTEGER NOT NULL,
        updated_ms INTEGER NOT NULL
    );
    CREATE TABLE group_members (
        group_id TEXT NOT NULL REFERENCES groups (id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        agent_id TEXT NOT NULL,
        machine TEXT NOT NULL,
        name TEXT NOT NULL,
        avatar TEXT,
        PRIMARY KEY (group_id, machine, agent_id)
    ) WITHOUT ROWID;
    CREATE INDEX group_members_by_agent ON group_members (machine, agent_id);
    CREATE TABLE outbox (
        key TEXT PRIMARY KEY,
        machine TEXT NOT NULL,
        machine_name TEXT NOT NULL,
        request TEXT NOT NULL,
        state TEXT NOT NULL,
        answer TEXT,
        attempts INTEGER NOT NULL,
        next_ms INTEGER NOT NULL,
        stop INTEGER NOT NULL,
        created_ms INTEGER NOT NULL,
        updated_ms INTEGER NOT NULL
    );
    CREATE INDEX outbox_open ON outbox (next_ms) WHERE state IN ('queued', 'sent');
    CREATE TABLE inbox (
        from_host TEXT NOT NULL,
        key TEXT NOT NULL,
        from_name TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        created_ms INTEGER NOT NULL,
        PRIMARY KEY (from_host, key)
    ) WITHOUT ROWID;
";

/// A group member: a bot of this machine (`machine` empty) or of another, by host id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredMember {
    pub agent_id: String,
    /// The machine's host id; empty for this machine.
    pub machine: String,
    /// The name and avatar (JSON) it last answered with.
    pub name: String,
    pub avatar: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredGroup {
    pub id: String,
    pub name: String,
    /// A member of this machine.
    pub lead_id: String,
    pub conversation: String,
    pub members: Vec<StoredMember>,
    pub created_ms: i64,
    pub updated_ms: i64,
}

/// An ask to a bot of another machine, until it ends.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutboxEntry {
    pub key: String,
    /// The target machine's host id, and its name for the person.
    pub machine: String,
    pub machine_name: String,
    /// The inbox `ask` body, as JSON.
    pub request: String,
    /// `queued` (not yet taken there), `sent` (taken; its answer is being read), or how it ended:
    /// `answered`, `stopped`, `failed`, `withdrawn`, `gave_up`.
    pub state: String,
    /// The answer there, as JSON (`{"status", "text"}`), once it ended.
    pub answer: Option<String>,
    pub attempts: u32,
    pub next_ms: i64,
    /// The person pressed Stop: withdraw it if queued, else send `stop` there.
    pub stop: bool,
    pub created_ms: i64,
}

/// An ask another machine delivered here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InboxEntry {
    pub from_host: String,
    pub key: String,
    pub from_name: String,
    pub agent_id: String,
    pub conversation: String,
    /// The seq of the message it delivered.
    pub seq: i64,
}

const GROUP_COLUMNS: &str = "id, name, lead_id, conversation_id, created_ms, updated_ms";

fn group_row(row: &Row<'_>) -> rusqlite::Result<StoredGroup> {
    Ok(StoredGroup {
        id: row.get(0)?,
        name: row.get(1)?,
        lead_id: row.get(2)?,
        conversation: row.get(3)?,
        members: Vec::new(),
        created_ms: row.get(4)?,
        updated_ms: row.get(5)?,
    })
}

const OUTBOX_COLUMNS: &str = "key, machine, machine_name, request, state, answer, attempts,
    next_ms, stop, created_ms";

fn outbox_row(row: &Row<'_>) -> rusqlite::Result<OutboxEntry> {
    Ok(OutboxEntry {
        key: row.get(0)?,
        machine: row.get(1)?,
        machine_name: row.get(2)?,
        request: row.get(3)?,
        state: row.get(4)?,
        answer: row.get(5)?,
        attempts: row.get(6)?,
        next_ms: row.get(7)?,
        stop: row.get(8)?,
        created_ms: row.get(9)?,
    })
}

fn members_of(
    connection: &rusqlite::Connection,
    group: &str,
) -> rusqlite::Result<Vec<StoredMember>> {
    let mut statement = connection.prepare(
        "SELECT agent_id, machine, name, avatar FROM group_members
         WHERE group_id = ?1 ORDER BY position",
    )?;
    let rows = statement.query_map(params![group], |row| {
        Ok(StoredMember {
            agent_id: row.get(0)?,
            machine: row.get(1)?,
            name: row.get(2)?,
            avatar: row.get(3)?,
        })
    })?;
    rows.collect()
}

fn put_members(
    tx: &rusqlite::Transaction<'_>,
    group: &str,
    members: &[StoredMember],
) -> rusqlite::Result<()> {
    tx.execute("DELETE FROM group_members WHERE group_id = ?1", params![group])?;
    for (position, member) in members.iter().enumerate() {
        tx.execute(
            "INSERT OR REPLACE INTO group_members
             (group_id, position, agent_id, machine, name, avatar)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                group,
                position as i64,
                member.agent_id,
                member.machine,
                member.name,
                member.avatar
            ],
        )?;
    }
    Ok(())
}

impl Store {
    /// Stores a new group and creates its conversation, together.
    pub fn create_group(&self, group: &StoredGroup) -> Result<()> {
        let mut connection = self.lock()?;
        let tx = connection.transaction()?;
        tx.execute(
            "INSERT INTO conversations (id, title, created_ms, updated_ms) VALUES (?1, ?2, ?3, ?3)",
            params![group.conversation, group.name, group.created_ms],
        )?;
        tx.execute(
            "INSERT INTO groups (id, name, lead_id, conversation_id, created_ms, updated_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![
                group.id,
                group.name,
                group.lead_id,
                group.conversation,
                group.created_ms
            ],
        )?;
        put_members(&tx, &group.id, &group.members)?;
        tx.commit()?;
        Ok(())
    }

    /// Every group, with its members.
    pub fn groups(&self) -> Result<Vec<StoredGroup>> {
        let connection = self.lock()?;
        let mut statement =
            connection.prepare(&format!("SELECT {GROUP_COLUMNS} FROM groups ORDER BY created_ms"))?;
        let mut groups = statement
            .query_map([], group_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for group in &mut groups {
            group.members = members_of(&connection, &group.id)?;
        }
        Ok(groups)
    }

    pub fn group(&self, id: &str) -> Result<Option<StoredGroup>> {
        let connection = self.lock()?;
        let group = connection
            .query_row(
                &format!("SELECT {GROUP_COLUMNS} FROM groups WHERE id = ?1"),
                params![id],
                group_row,
            )
            .optional()?;
        let Some(mut group) = group else {
            return Ok(None);
        };
        group.members = members_of(&connection, id)?;
        Ok(Some(group))
    }

    /// The group whose transcript is `conversation`.
    pub fn group_for_conversation(&self, conversation: &str) -> Result<Option<String>> {
        Ok(self
            .lock()?
            .query_row(
                "SELECT id FROM groups WHERE conversation_id = ?1",
                params![conversation],
                |row| row.get(0),
            )
            .optional()?)
    }

    /// Changes a group's name, lead and members as one write. False when it is gone.
    pub fn update_group(&self, group: &StoredGroup, now_ms: i64) -> Result<bool> {
        let mut connection = self.lock()?;
        let tx = connection.transaction()?;
        let changed = tx.execute(
            "UPDATE groups SET name = ?2, lead_id = ?3, updated_ms = ?4 WHERE id = ?1",
            params![group.id, group.name, group.lead_id, now_ms],
        )?;
        if changed == 0 {
            return Ok(false);
        }
        tx.execute(
            "UPDATE conversations SET title = ?2 WHERE id = ?1",
            params![group.conversation, group.name],
        )?;
        put_members(&tx, &group.id, &group.members)?;
        tx.commit()?;
        Ok(true)
    }

    /// Keeps the name and avatar a member last answered with.
    pub fn refresh_member(
        &self,
        machine: &str,
        agent: &str,
        name: &str,
        avatar: Option<&str>,
    ) -> Result<()> {
        self.lock()?.execute(
            "UPDATE group_members SET name = ?3, avatar = ?4 WHERE machine = ?1 AND agent_id = ?2",
            params![machine, agent, name, avatar],
        )?;
        Ok(())
    }

    /// Deletes a group with its transcript.
    pub fn delete_group(&self, id: &str) -> Result<bool> {
        let mut connection = self.lock()?;
        let tx = connection.transaction()?;
        let conversation: Option<String> = tx
            .query_row(
                "SELECT conversation_id FROM groups WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(conversation) = conversation else {
            return Ok(false);
        };
        tx.execute("DELETE FROM groups WHERE id = ?1", params![id])?;
        tx.execute(
            "DELETE FROM events WHERE conversation_id = ?1",
            params![conversation],
        )?;
        tx.execute(
            "DELETE FROM conversations WHERE id = ?1",
            params![conversation],
        )?;
        tx.commit()?;
        Ok(true)
    }

    /// Takes a deleted bot of this machine out of every group.
    pub fn leave_groups(&self, agent: &str) -> Result<()> {
        self.lock()?.execute(
            "DELETE FROM group_members WHERE machine = '' AND agent_id = ?1",
            params![agent],
        )?;
        Ok(())
    }

    /// Stores a new outbox entry; false when its key is already there.
    pub fn insert_outbox(&self, entry: &OutboxEntry) -> Result<bool> {
        let inserted = self.lock()?.execute(
            "INSERT OR IGNORE INTO outbox
             (key, machine, machine_name, request, state, answer, attempts, next_ms, stop,
              created_ms, updated_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
            params![
                entry.key,
                entry.machine,
                entry.machine_name,
                entry.request,
                entry.state,
                entry.answer,
                entry.attempts,
                entry.next_ms,
                entry.stop,
                entry.created_ms
            ],
        )?;
        Ok(inserted == 1)
    }

    pub fn outbox(&self, key: &str) -> Result<Option<OutboxEntry>> {
        Ok(self
            .lock()?
            .query_row(
                &format!("SELECT {OUTBOX_COLUMNS} FROM outbox WHERE key = ?1"),
                params![key],
                outbox_row,
            )
            .optional()?)
    }

    /// Entries not yet ended, soonest first.
    pub fn open_outbox(&self) -> Result<Vec<OutboxEntry>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(&format!(
            "SELECT {OUTBOX_COLUMNS} FROM outbox WHERE state IN ('queued', 'sent')
             ORDER BY next_ms, created_ms"
        ))?;
        Ok(statement
            .query_map([], outbox_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Moves an open entry on. Never changes one that already ended; false then.
    pub fn advance_outbox(
        &self,
        key: &str,
        state: &str,
        answer: Option<&str>,
        attempts: u32,
        next_ms: i64,
        now_ms: i64,
    ) -> Result<bool> {
        let changed = self.lock()?.execute(
            "UPDATE outbox SET state = ?2, answer = ?3, attempts = ?4, next_ms = ?5, updated_ms = ?6
             WHERE key = ?1 AND state IN ('queued', 'sent')",
            params![key, state, answer, attempts, next_ms, now_ms],
        )?;
        Ok(changed == 1)
    }

    /// Marks an entry to be stopped; its worker withdraws or stops it.
    pub fn stop_outbox(&self, key: &str, now_ms: i64) -> Result<()> {
        self.lock()?.execute(
            "UPDATE outbox SET stop = 1, next_ms = ?2, updated_ms = ?2
             WHERE key = ?1 AND state IN ('queued', 'sent')",
            params![key, now_ms],
        )?;
        Ok(())
    }

    pub fn inbox(&self, from_host: &str, key: &str) -> Result<Option<InboxEntry>> {
        Ok(self
            .lock()?
            .query_row(
                "SELECT from_host, key, from_name, agent_id, conversation_id, seq FROM inbox
                 WHERE from_host = ?1 AND key = ?2",
                params![from_host, key],
                |row| {
                    Ok(InboxEntry {
                        from_host: row.get(0)?,
                        key: row.get(1)?,
                        from_name: row.get(2)?,
                        agent_id: row.get(3)?,
                        conversation: row.get(4)?,
                        seq: row.get(5)?,
                    })
                },
            )
            .optional()?)
    }

    /// Appends `events` and records the ask that delivered the first of them, in one
    /// transaction. `Ok(None)` when that ask is already recorded: nothing is appended.
    pub fn append_delivered(
        &self,
        conversation: &str,
        events: &[Event],
        ask: &InboxEntry,
        now_ms: i64,
    ) -> Result<Option<Vec<StoredEvent>>> {
        let mut connection = self.lock()?;
        let tx = connection.transaction()?;
        let known: bool = tx
            .query_row(
                "SELECT 1 FROM inbox WHERE from_host = ?1 AND key = ?2",
                params![ask.from_host, ask.key],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false);
        if known {
            return Ok(None);
        }
        let stored = crate::append_in(&tx, conversation, events, now_ms)?;
        let seq = stored
            .first()
            .map(|e| e.seq)
            .ok_or_else(|| StoreError::NoConversation(conversation.to_owned()))?;
        tx.execute(
            "INSERT INTO inbox (from_host, key, from_name, agent_id, conversation_id, seq, created_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                ask.from_host,
                ask.key,
                ask.from_name,
                ask.agent_id,
                conversation,
                seq,
                now_ms
            ],
        )?;
        tx.commit()?;
        Ok(Some(stored))
    }
}
