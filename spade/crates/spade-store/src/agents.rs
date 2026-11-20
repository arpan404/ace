//! Agents (ADR 0126, 0127): a name, task, avatar and model with exactly one conversation. The row
//! holds what the person set now; a task or model change is also stored as an `agent_configured`
//! event in the conversation, which is what turns read, so a restart rebuilds the same prompt.

use rusqlite::{OptionalExtension, Row, Transaction, params};
use serde_json::json;
use spade_core::Event;
use spade_core::event::Known;
use spade_core::face;

use crate::gate::ARRIVING_AGENTS;
use crate::{Result, Store, StoreError, StoredEvent, append_in};

/// The colours an initials avatar used, before character faces (schema 2's backfill).
const AVATAR_COLORS: [&str; 10] = [
    "slate", "red", "orange", "amber", "green", "teal", "blue", "indigo", "violet", "pink",
];

/// A colour picked from `seed`, the same every time.
fn generated_color(seed: &str) -> &'static str {
    // FNV-1a: stable across builds, unlike the standard hasher.
    let hash = seed.bytes().fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3)
    });
    AVATAR_COLORS[(hash % AVATAR_COLORS.len() as u64) as usize]
}

/// The settings key prefix for a bot made from a marketplace recipe (ADR 0168): where it came
/// from and the built-in tools it is narrowed to, as JSON the server shapes.
pub const BOT_RECIPE: &str = "bot_recipe";

/// One bot's recipe settings key.
pub fn recipe_key(agent: &str) -> String {
    format!("{BOT_RECIPE}:{agent}")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Agent {
    pub id: String,
    /// `main` (Spade itself, ADR 0127) or `bot`.
    pub kind: String,
    pub name: String,
    pub task: String,
    /// The avatar as JSON: `{"kind":"image","sha256"}`, `{"kind":"generated","color"}` or
    /// `{"kind":"spade"}`.
    pub avatar: String,
    pub model: String,
    pub conversation: String,
    pub created_ms: i64,
    pub updated_ms: i64,
    /// When its conversation last changed.
    pub last_activity_ms: i64,
    /// When the person pinned it to the top of their list; `None` when it isn't pinned.
    pub pinned_ms: Option<i64>,
    /// How it talks, when set; `None` leaves it to the bot.
    pub personality: Option<spade_core::personality::Personality>,
}

/// What creating an agent needs.
#[derive(Debug, Clone, Copy)]
pub struct NewAgent<'a> {
    pub id: &'a str,
    pub kind: &'a str,
    pub name: &'a str,
    pub task: &'a str,
    pub avatar: &'a str,
    pub model: &'a str,
    pub conversation: &'a str,
}

const COLUMNS: &str = "a.id, a.kind, a.name, a.task, a.avatar, a.model, a.conversation_id,
    a.created_ms, a.updated_ms, c.updated_ms, a.pinned_ms, a.personality";

/// A stored personality; one this build can't read counts as none.
fn personality(text: Option<String>) -> Option<spade_core::personality::Personality> {
    text.and_then(|text| serde_json::from_str(&text).ok())
}

fn agent(row: &Row<'_>) -> rusqlite::Result<Agent> {
    Ok(Agent {
        id: row.get(0)?,
        kind: row.get(1)?,
        name: row.get(2)?,
        task: row.get(3)?,
        avatar: row.get(4)?,
        model: row.get(5)?,
        conversation: row.get(6)?,
        created_ms: row.get(7)?,
        updated_ms: row.get(8)?,
        last_activity_ms: row.get(9)?,
        pinned_ms: row.get(10)?,
        personality: personality(row.get(11)?),
    })
}

impl Store {
    /// Creates the agent and its one conversation together, with `first` as the conversation's
    /// first events: both exist, or neither.
    pub fn create_agent(&self, new: NewAgent<'_>, first: &[Event], now_ms: i64) -> Result<()> {
        let mut connection = self.lock()?;
        let tx = connection.transaction()?;
        let inserted = tx.execute(
            "INSERT OR IGNORE INTO conversations (id, title, created_ms, updated_ms)
             VALUES (?1, NULL, ?2, ?2)",
            params![new.conversation, now_ms],
        )?;
        if inserted == 0 {
            return Err(StoreError::Exists(new.conversation.to_owned()));
        }
        let inserted = tx.execute(
            "INSERT OR IGNORE INTO agents
             (id, kind, name, task, avatar, model, conversation_id, created_ms, updated_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
            params![
                new.id,
                new.kind,
                new.name,
                new.task,
                new.avatar,
                new.model,
                new.conversation,
                now_ms
            ],
        )?;
        if inserted == 0 {
            return Err(StoreError::Exists(new.id.to_owned()));
        }
        append_in(&tx, new.conversation, first, now_ms)?;
        tx.commit()?;
        Ok(())
    }

    /// Every agent: the main one first, then by latest activity. A main bot another machine's
    /// Spade replaced when it moved here (ADR 0187) is kept, retired, and never listed; nor is a
    /// bot still arriving from another machine.
    pub fn agents(&self) -> Result<Vec<Agent>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(&format!(
            "SELECT {COLUMNS} FROM agents a JOIN conversations c ON c.id = a.conversation_id
             WHERE a.kind IN ('main', 'bot') AND a.id NOT IN {ARRIVING_AGENTS}
             ORDER BY a.kind = 'main' DESC, c.updated_ms DESC, a.id DESC"
        ))?;
        let rows = statement.query_map([], agent)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Pins the agent at `now_ms`, or unpins it. Pinning a pinned agent keeps its place. Answers
    /// false when there is no such agent.
    pub fn set_agent_pinned(&self, id: &str, pinned: bool, now_ms: i64) -> Result<bool> {
        let connection = self.lock()?;
        let changed = connection.execute(
            &format!(
                "UPDATE agents SET pinned_ms = CASE WHEN ?2 THEN COALESCE(pinned_ms, ?3) END
                 WHERE id = ?1 AND id NOT IN {ARRIVING_AGENTS}"
            ),
            params![id, pinned, now_ms],
        )?;
        Ok(changed > 0)
    }

    pub fn agent(&self, id: &str) -> Result<Option<Agent>> {
        self.agent_where("a.id = ?1", id)
    }

    /// The agent whose conversation is `conversation`. A helper's conversation (ADR 0152)
    /// belongs to its bot: its tools, connectors and settings are the bot's.
    pub fn agent_for_conversation(&self, conversation: &str) -> Result<Option<Agent>> {
        self.agent_where(
            "a.conversation_id = COALESCE(
                 (SELECT parent_id FROM helpers WHERE conversation_id = ?1), ?1)",
            conversation,
        )
    }

    /// The one agent `condition` names. A bot still arriving from another machine (ADR 0187,
    /// kind `arriving`) is no agent here until its move makes it one: nothing finds it by its id
    /// or its conversation, so nothing can reach it or act as it.
    fn agent_where(&self, condition: &str, value: &str) -> Result<Option<Agent>> {
        let connection = self.lock()?;
        Ok(connection
            .query_row(
                &format!(
                    "SELECT {COLUMNS} FROM agents a JOIN conversations c
                     ON c.id = a.conversation_id WHERE ({condition}) AND a.kind != 'arriving'
                     AND a.id NOT IN {ARRIVING_AGENTS}"
                ),
                params![value],
                agent,
            )
            .optional()?)
    }

    /// Changes the name and avatar, which apply at once. Returns whether the agent exists.
    pub fn set_agent_profile(
        &self,
        id: &str,
        name: &str,
        avatar: &str,
        now_ms: i64,
    ) -> Result<bool> {
        let changed = self.lock()?.execute(
            &format!(
                "UPDATE agents SET name = ?2, avatar = ?3, updated_ms = ?4
                 WHERE id = ?1 AND id NOT IN {ARRIVING_AGENTS}"
            ),
            params![id, name, avatar, now_ms],
        )?;
        Ok(changed > 0)
    }

    /// Changes the task and model: the row and an `agent_configured` event, together. The
    /// personality stays as it is, and the event carries it so turns keep reading it.
    pub fn configure_agent(
        &self,
        id: &str,
        task: &str,
        model: &str,
        now_ms: i64,
    ) -> Result<StoredEvent> {
        self.configure(id, Some((task, model)), None, now_ms)
    }

    /// Sets how the agent talks (`None`: left to the bot): the row and an `agent_configured`
    /// event with its task and model as they are, together.
    pub fn set_agent_personality(
        &self,
        id: &str,
        personality: Option<spade_core::personality::Personality>,
        now_ms: i64,
    ) -> Result<StoredEvent> {
        self.configure(id, None, Some(personality), now_ms)
    }

    fn configure(
        &self,
        id: &str,
        work: Option<(&str, &str)>,
        voice: Option<Option<spade_core::personality::Personality>>,
        now_ms: i64,
    ) -> Result<StoredEvent> {
        let mut connection = self.lock()?;
        let tx = connection.transaction()?;
        let row: Option<(String, String, String, Option<String>)> = tx
            .query_row(
                &format!("SELECT conversation_id, task, model, personality FROM agents WHERE id = ?1 AND id NOT IN {ARRIVING_AGENTS}"),
                params![id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?;
        let Some((conversation, old_task, old_model, old_voice)) = row else {
            return Err(StoreError::NoConversation(id.to_owned()));
        };
        let (task, model) = work.unwrap_or((&old_task, &old_model));
        let personality = voice.unwrap_or_else(|| self::personality(old_voice));
        let stored_voice = personality.and_then(|p| serde_json::to_string(&p).ok());
        tx.execute(
            "UPDATE agents SET task = ?2, model = ?3, personality = ?4, updated_ms = ?5
             WHERE id = ?1",
            params![id, task, model, stored_voice, now_ms],
        )?;
        let event = Event::Known(Known::AgentConfigured {
            task: task.to_owned(),
            model: model.to_owned(),
            personality,
        });
        let mut stored = append_in(&tx, &conversation, &[event], now_ms)?;
        tx.commit()?;
        stored.pop().ok_or(StoreError::NoConversation(conversation))
    }

    /// Sets the model of agents that have none (migrated ones whose conversation never replied).
    pub fn fill_missing_models(&self, model: &str) -> Result<()> {
        self.lock()?.execute(
            &format!(
                "UPDATE agents SET model = ?1 WHERE model = '' AND id NOT IN {ARRIVING_AGENTS}"
            ),
            params![model],
        )?;
        Ok(())
    }

    /// Deletes the agent, its conversation and the conversation's events. Spending stays in the
    /// ledger, so the day's spend still shows it. Returns whether the agent existed.
    pub fn delete_agent(&self, id: &str) -> Result<bool> {
        let mut connection = self.lock()?;
        let tx = connection.transaction()?;
        let conversation: Option<String> = tx
            .query_row(
                &format!("SELECT conversation_id FROM agents WHERE id = ?1 AND id NOT IN {ARRIVING_AGENTS}"),
                params![id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(conversation) = conversation else {
            return Ok(false);
        };
        tx.execute("DELETE FROM agents WHERE id = ?1", params![id])?;
        // Its helpers' hidden conversations go with it (ADR 0152).
        crate::helpers::delete_of(&tx, &conversation)?;
        // Its review switch (ADR 0135); its spend stays in the ledger.
        tx.execute(
            "DELETE FROM settings WHERE key = ?1",
            params![crate::oversight::agent_key(id)],
        )?;
        // Its digest settings (ADR 0165); its digests go with the row.
        tx.execute(
            "DELETE FROM settings WHERE key = ?1",
            params![crate::digests::digests_key(id)],
        )?;
        // Its model roles (ADR 0162).
        tx.execute(
            "DELETE FROM settings WHERE key = ?1",
            params![crate::spend::roles_key(id)],
        )?;
        // The recipe it was made from (ADR 0168).
        tx.execute(
            "DELETE FROM settings WHERE key = ?1",
            params![recipe_key(id)],
        )?;
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

    /// The names of agents whose model is on `endpoint`.
    pub fn agents_using_endpoint(&self, endpoint: &str) -> Result<Vec<String>> {
        let connection = self.lock()?;
        let prefix = format!("{endpoint}/");
        let mut statement = connection.prepare(&format!(
            "SELECT name FROM agents WHERE substr(model, 1, length(?1)) = ?1
             AND id NOT IN {ARRIVING_AGENTS} ORDER BY name"
        ))?;
        let rows = statement.query_map(params![prefix], |row| row.get(0))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }
}

/// Schema 2: every conversation stored before agents becomes a bot named after its title, with
/// an empty task, a generated avatar and the model its latest reply used (empty when it never
/// replied; the engine fills those with the preset main model).
pub(crate) fn backfill(tx: &Transaction<'_>) -> rusqlite::Result<()> {
    let conversations: Vec<(String, Option<String>, i64, i64)> = {
        let mut statement =
            tx.prepare("SELECT id, title, created_ms, updated_ms FROM conversations")?;
        let rows = statement.query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    for (id, title, created, updated) in conversations {
        let model: Option<String> = tx
            .query_row(
                "SELECT json_extract(body, '$.model') FROM events
                 WHERE conversation_id = ?1 AND json_extract(body, '$.type') = 'reply_started'
                 ORDER BY seq DESC LIMIT 1",
                params![id],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        let name = title
            .map(|t| t.trim().chars().take(40).collect::<String>())
            .filter(|t| !t.trim().is_empty())
            .map_or_else(|| "Agent".to_owned(), |t| t.trim().to_owned());
        let avatar = json!({ "kind": "generated", "color": generated_color(&id) }).to_string();
        tx.execute(
            "INSERT INTO agents
             (id, kind, name, task, avatar, model, conversation_id, created_ms, updated_ms)
             VALUES (?1, 'bot', ?2, '', ?3, ?4, ?5, ?6, ?7)",
            params![
                format!("a_{id}"),
                name,
                avatar,
                model.unwrap_or_default(),
                id,
                created,
                updated
            ],
        )?;
    }
    Ok(())
}

/// Schema 6: every initials avatar (and any avatar that doesn't read) becomes a character face
/// seeded by the agent's id, preferring colour pairs no earlier agent wears. Pictures and the
/// main agent's mark stay. A database migrates once; the same agents always get the same faces.
pub(crate) fn character_faces(tx: &Transaction<'_>) -> rusqlite::Result<()> {
    let agents: Vec<(String, String)> = {
        let mut statement = tx.prepare("SELECT id, avatar FROM agents ORDER BY created_ms, id")?;
        let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    let mut taken: Vec<&'static str> = Vec::new();
    for (id, avatar) in agents {
        let stored: serde_json::Value = serde_json::from_str(&avatar).unwrap_or_default();
        if matches!(stored["kind"].as_str(), Some("image" | "spade")) {
            continue;
        }
        if let Some(pair) = face::worn_pair(&avatar) {
            taken.push(pair);
            continue;
        }
        let made = face::face_for_id(&id, &taken);
        tx.execute(
            "UPDATE agents SET avatar = ?2 WHERE id = ?1",
            params![id, made.to_json().to_string()],
        )?;
        taken.extend(made.get("pair"));
    }
    Ok(())
}
