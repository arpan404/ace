//! Helpers (ADR 0152): each is a hidden conversation of its own, linked to the bot conversation
//! and the `helper` call that started it. The conversation list leaves them out; anything that
//! asks which bot a helper's conversation belongs to gets its bot.

use rusqlite::{OptionalExtension, params};
use spade_core::Event;

use crate::gate::ARRIVING_CONVERSATIONS;
use crate::{Result, Store, StoreError, StoredEvent};

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

/// The schema step that adds the task lanes that haven't ended (ADR 0217): a lane is listed from
/// its start until its last report, and again once it opens a new reply.
pub(crate) const LANES_LIVE: &str = "
    CREATE TABLE lanes_live (
        conversation_id TEXT PRIMARY KEY REFERENCES conversations (id),
        parent_id TEXT NOT NULL
    );
    CREATE INDEX lanes_live_by_parent ON lanes_live (parent_id);
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

/// [`COLUMNS`], each named in table `alias`.
fn prefixed(alias: &str) -> String {
    COLUMNS
        .split(", ")
        .map(|column| format!("{alias}.{column}"))
        .collect::<Vec<_>>()
        .join(", ")
}

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
        if insert_hidden(&tx, helper, first, now_ms)?.is_none() {
            return Ok(false);
        }
        tx.commit()?;
        Ok(true)
    }

    /// Creates a task lane (ADR 0217) as [`Store::create_helper`] does, and stores `parent_events`
    /// in its bot's conversation in the same write, so a crash never keeps one without the other.
    /// The helpers of `adopt_jobs` (main's jobs that move with it) become the lane's.
    /// `None` (nothing written) when the call already made its lane.
    pub fn create_lane(
        &self,
        lane: &StoredHelper,
        first: &[Event],
        parent_events: &[Event],
        adopt_jobs: &[String],
        now_ms: i64,
    ) -> Result<Option<(Vec<StoredEvent>, Vec<StoredEvent>)>> {
        let mut connection = self.lock()?;
        let tx = connection.transaction()?;
        let Some(own) = insert_hidden(&tx, lane, first, now_ms)? else {
            return Ok(None);
        };
        // The helpers of jobs that moved with main's work answer to the lane now, a rerun too.
        for job in adopt_jobs {
            tx.execute(
                "UPDATE helpers SET parent_id = ?1
                 WHERE parent_id = ?2 AND (job = ?3 OR job = ?3 || '~2')",
                params![lane.conversation, lane.parent, job],
            )?;
        }
        tx.execute(
            "INSERT OR IGNORE INTO lanes_live (conversation_id, parent_id) VALUES (?1, ?2)",
            params![lane.conversation, lane.parent],
        )?;
        let parent = crate::append_in(&tx, &lane.parent, parent_events, now_ms)?;
        tx.commit()?;
        Ok(Some((own, parent)))
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

    /// The task lanes of `parent` that haven't ended (ADR 0217), oldest first; every bot's
    /// with `None`. Reads only those, however many a bot ran.
    pub fn live_lanes(&self, parent: Option<&str>) -> Result<Vec<StoredHelper>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(&format!(
            "SELECT {} FROM helpers h JOIN lanes_live l ON l.conversation_id = h.conversation_id
             WHERE h.parent_id NOT IN {ARRIVING_CONVERSATIONS}
               AND (?1 IS NULL OR l.parent_id = ?1)
             ORDER BY h.created_ms, h.conversation_id",
            prefixed("h")
        ))?;
        let rows = statement.query_map(params![parent], helper)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// The `limit` task lanes of `parent` that ended most recently first, the oldest of them
    /// first: the task list shows these after the live ones.
    pub fn ended_lanes(&self, parent: &str, limit: usize) -> Result<Vec<StoredHelper>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(&format!(
            "SELECT {} FROM helpers h
             WHERE h.parent_id = ?1 AND h.profile = 'lane'
               AND h.conversation_id NOT IN (SELECT conversation_id FROM lanes_live)
               AND h.parent_id NOT IN {ARRIVING_CONVERSATIONS}
             ORDER BY h.created_ms DESC, h.conversation_id DESC LIMIT ?2",
            prefixed("h")
        ))?;
        let limit = i64::try_from(limit).unwrap_or(i64::MAX);
        let rows = statement.query_map(params![parent, limit], helper)?;
        let mut lanes = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        lanes.reverse();
        Ok(lanes)
    }

    /// Marks task lane `lane` (of `parent`) as not ended, or ended.
    pub fn set_lane_live(&self, lane: &str, parent: &str, live: bool) -> Result<()> {
        let connection = self.lock()?;
        match live {
            true => connection.execute(
                "INSERT OR IGNORE INTO lanes_live (conversation_id, parent_id)
                 SELECT ?1, ?2 WHERE EXISTS (SELECT 1 FROM conversations WHERE id = ?1)",
                params![lane, parent],
            )?,
            false => connection.execute(
                "DELETE FROM lanes_live WHERE conversation_id = ?1",
                params![lane],
            )?,
        };
        Ok(())
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

/// Writes a hidden conversation's row and first events inside `tx`; `None` (nothing written) when
/// its parent's job already has one.
fn insert_hidden(
    tx: &rusqlite::Transaction<'_>,
    helper: &StoredHelper,
    first: &[Event],
    now_ms: i64,
) -> Result<Option<Vec<StoredEvent>>> {
    let taken: Option<String> = tx
        .query_row(
            "SELECT conversation_id FROM helpers WHERE parent_id = ?1 AND job = ?2",
            params![helper.parent, helper.job],
            |row| row.get(0),
        )
        .optional()?;
    if taken.is_some() {
        return Ok(None);
    }
    let parent: Option<bool> = tx
        .query_row(
            &format!(
                "SELECT 1 FROM conversations WHERE id = ?1 AND id NOT IN {ARRIVING_CONVERSATIONS}"
            ),
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
    Ok(Some(crate::append_in(
        tx,
        &helper.conversation,
        first,
        now_ms,
    )?))
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
    tx.execute(
        "DELETE FROM lanes_live WHERE parent_id = ?1",
        params![parent],
    )?;
    tx.execute("DELETE FROM helpers WHERE parent_id = ?1", params![parent])?;
    for conversation in conversations {
        tx.execute(
            "DELETE FROM conversations WHERE id = ?1",
            params![conversation],
        )?;
    }
    Ok(())
}
