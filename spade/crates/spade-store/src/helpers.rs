//! Helpers (ADR 0152): each is a hidden conversation of its own, linked to the bot conversation
//! and the `helper` call that started it. The conversation list leaves them out; anything that
//! asks which bot a helper's conversation belongs to gets its bot.

use rusqlite::{OptionalExtension, params};
use spade_core::Event;

use crate::gate::ARRIVING_CONVERSATIONS;
use crate::{Result, Store, StoreError};

/// The schema step that adds helpers.
pub(crate) const SCHEMA: &str = "
    CREATE TABLE helpers (
        conversation_id TEXT PRIMARY KEY REFERENCES conversations (id),
        parent_id TEXT NOT NULL,
        job TEXT NOT NULL,
        reply TEXT NOT NULL,
        profile TEXT NOT NULL,
        system TEXT NOT NULL,
        reads_only INTEGER NOT NULL,
        tools TEXT,
        model TEXT NOT NULL,
        created_ms INTEGER NOT NULL,
        UNIQUE (parent_id, job)
    );
    CREATE INDEX helpers_by_parent ON helpers (parent_id, created_ms);
";

/// A helper as stored. The profile is kept as it was when the helper started, so its prompt
/// rebuilds to the same bytes after a restart even if the profile changed or went away.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredHelper {
    /// The helper's own conversation.
    pub conversation: String,
    /// The bot's conversation.
    pub parent: String,
    /// The bot's job (the `helper` call's id).
    pub job: String,
    /// The bot's reply that started it, so Stop on that reply stops it.
    pub reply: String,
    pub profile: String,
    /// Its standing instructions.
    pub system: String,
    pub reads_only: bool,
    /// The tools a plugin agent's profile narrowed it to, by name.
    pub tools: Option<Vec<String>>,
    pub model: String,
    pub created_ms: i64,
}

const COLUMNS: &str =
    "conversation_id, parent_id, job, reply, profile, system, reads_only, tools, model, created_ms";

fn helper(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredHelper> {
    let tools: Option<String> = row.get(7)?;
    Ok(StoredHelper {
        conversation: row.get(0)?,
        parent: row.get(1)?,
        job: row.get(2)?,
        reply: row.get(3)?,
        profile: row.get(4)?,
        system: row.get(5)?,
        reads_only: row.get::<_, i64>(6)? != 0,
        tools: tools.and_then(|t| serde_json::from_str(&t).ok()),
        model: row.get(8)?,
        created_ms: row.get(9)?,
    })
}

impl Store {
    /// Creates the helper's conversation, its row and its first events in one write. `false`
    /// (nothing written) when the bot's job already has a helper: starting one is idempotent.
    pub fn create_helper(
        &self,
        helper: &StoredHelper,
        first: &[Event],
        now_ms: i64,
    ) -> Result<bool> {
        let mut connection = self.lock()?;
        let tx = connection.transaction()?;
        let taken: Option<String> = tx
            .query_row(
                "SELECT conversation_id FROM helpers WHERE parent_id = ?1 AND job = ?2",
                params![helper.parent, helper.job],
                |row| row.get(0),
            )
            .optional()?;
        if taken.is_some() {
            return Ok(false);
        }
        let parent: Option<bool> = tx
            .query_row(
                &format!("SELECT 1 FROM conversations WHERE id = ?1 AND id NOT IN {ARRIVING_CONVERSATIONS}"),
                params![helper.parent],
                |_| Ok(true),
            )
            .optional()?;
        if parent.is_none() {
            return Err(StoreError::NoConversation(helper.parent.clone()));
        }
        let inserted = tx.execute(
            "INSERT OR IGNORE INTO conversations (id, title, created_ms, updated_ms)
             VALUES (?1, NULL, ?2, ?2)",
            params![helper.conversation, now_ms],
        )?;
        if inserted == 0 {
            return Err(StoreError::Exists(helper.conversation.clone()));
        }
        let tools = helper
            .tools
            .as_ref()
            .map(|t| serde_json::to_string(t).unwrap_or_else(|_| "[]".to_owned()));
        tx.execute(
            &format!(
                "INSERT INTO helpers ({COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)"
            ),
            params![
                helper.conversation,
                helper.parent,
                helper.job,
                helper.reply,
                helper.profile,
                helper.system,
                i64::from(helper.reads_only),
                tools,
                helper.model,
                now_ms
            ],
        )?;
        crate::append_in(&tx, &helper.conversation, first, now_ms)?;
        tx.commit()?;
        Ok(true)
    }

    /// The helper whose conversation is `conversation`.
    pub fn helper(&self, conversation: &str) -> Result<Option<StoredHelper>> {
        let connection = self.lock()?;
        Ok(connection
            .query_row(
                &format!(
                    "SELECT {COLUMNS} FROM helpers WHERE conversation_id = ?1
                     AND parent_id NOT IN {ARRIVING_CONVERSATIONS}"
                ),
                params![conversation],
                helper,
            )
            .optional()?)
    }

    /// The helper the bot's job `job` runs.
    pub fn helper_for_job(&self, parent: &str, job: &str) -> Result<Option<StoredHelper>> {
        let connection = self.lock()?;
        Ok(connection
            .query_row(
                &format!(
                    "SELECT {COLUMNS} FROM helpers WHERE parent_id = ?1 AND job = ?2
                     AND parent_id NOT IN {ARRIVING_CONVERSATIONS}"
                ),
                params![parent, job],
                helper,
            )
            .optional()?)
    }

    /// The bot's helpers, oldest first (the order queued ones start in).
    pub fn helpers_of(&self, parent: &str) -> Result<Vec<StoredHelper>> {
        self.helpers_where("AND parent_id = ?1", params![parent])
    }

    /// Every helper, oldest first.
    pub fn helpers(&self) -> Result<Vec<StoredHelper>> {
        self.helpers_where("", params![])
    }

    fn helpers_where(
        &self,
        condition: &str,
        values: &[&dyn rusqlite::ToSql],
    ) -> Result<Vec<StoredHelper>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(&format!(
            "SELECT {COLUMNS} FROM helpers WHERE parent_id NOT IN {ARRIVING_CONVERSATIONS}
             {condition} ORDER BY created_ms, conversation_id"
        ))?;
        let rows = statement.query_map(values, helper)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }
}

/// Deletes the helpers of `parent` with their conversations and events, inside `tx`.
pub(crate) fn delete_of(tx: &rusqlite::Transaction<'_>, parent: &str) -> rusqlite::Result<()> {
    tx.execute(
        "DELETE FROM events WHERE conversation_id IN
           (SELECT conversation_id FROM helpers WHERE parent_id = ?1)",
        params![parent],
    )?;
    let conversations: Vec<String> = {
        let mut statement =
            tx.prepare("SELECT conversation_id FROM helpers WHERE parent_id = ?1")?;
        let rows = statement.query_map(params![parent], |row| row.get(0))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    tx.execute("DELETE FROM helpers WHERE parent_id = ?1", params![parent])?;
    for conversation in conversations {
        tx.execute(
            "DELETE FROM conversations WHERE id = ?1",
            params![conversation],
        )?;
    }
    Ok(())
}
