//! Spade's skill store index (ADR 0151): one row per skill whose folder is
//! `<data folder>/skills/<id>/`, and how each bot used each skill, for ranking. The folders are
//! the server's; this keeps what lists, searches and ranks them.

use std::collections::HashMap;

use rusqlite::{OptionalExtension, Row, params};

use crate::{Result, Store};

/// The schema step that adds the skill store.
pub(crate) const SCHEMA: &str = "
    CREATE TABLE skills (
        id TEXT PRIMARY KEY,
        origin TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        manual INTEGER NOT NULL DEFAULT 0,
        body TEXT NOT NULL,
        hash TEXT NOT NULL,
        files TEXT NOT NULL DEFAULT '[]',
        source TEXT,
        updated_ms INTEGER NOT NULL
    );
    CREATE INDEX skills_by_name ON skills (name);
    CREATE TABLE skill_uses (
        agent_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        loads INTEGER NOT NULL DEFAULT 0,
        helpful INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (agent_id, name)
    );
";

/// Where a stored skill came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SkillOrigin {
    /// A copy of a skill in ace's library; read only.
    Ace,
    /// Written in Spade, by a bot's proposal or by the person.
    Spade,
    /// From a plugin a bot is allowed; read only.
    Plugin,
    /// A skill installed from ace's marketplace (ADR 0168), copied from the daemon; read only.
    Market,
}

impl SkillOrigin {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ace => "ace",
            Self::Spade => "spade",
            Self::Plugin => "plugin",
            Self::Market => "market",
        }
    }

    fn parse(text: &str) -> Option<Self> {
        match text {
            "ace" => Some(Self::Ace),
            "spade" => Some(Self::Spade),
            "plugin" => Some(Self::Plugin),
            "market" => Some(Self::Market),
            _ => None,
        }
    }
}

/// One skill in the store.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredSkill {
    /// The folder's name too: an ace copy keeps the library's id, a Spade skill is `sks_…`.
    pub id: String,
    pub origin: SkillOrigin,
    pub name: String,
    pub description: String,
    pub manual: bool,
    /// SKILL.md below its frontmatter, for search.
    pub body: String,
    /// SHA-256 of SKILL.md; for an ace copy, the library's hash it was copied at.
    pub hash: String,
    /// The skill's other files as JSON (`[{path, size, hash, executable}]`), shaped by the server.
    pub files: String,
    /// For a plugin's skill, the plugin; for a market skill, its entry name; for an ace copy,
    /// its scope.
    pub source: Option<String>,
    pub updated_ms: i64,
}

/// How one bot has used a skill, by name.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SkillUse {
    pub loads: u32,
    pub helpful: bool,
}

const COLUMNS: &str =
    "id, origin, name, description, manual, body, hash, files, source, updated_ms";

fn row(row: &Row<'_>) -> rusqlite::Result<Option<StoredSkill>> {
    let origin: String = row.get(1)?;
    let Some(origin) = SkillOrigin::parse(&origin) else {
        // An origin a newer build wrote: left out rather than misread.
        return Ok(None);
    };
    Ok(Some(StoredSkill {
        id: row.get(0)?,
        origin,
        name: row.get(2)?,
        description: row.get(3)?,
        manual: row.get(4)?,
        body: row.get(5)?,
        hash: row.get(6)?,
        files: row.get(7)?,
        source: row.get(8)?,
        updated_ms: row.get(9)?,
    }))
}

impl Store {
    /// Every stored skill, by name and then origin.
    pub fn skills(&self) -> Result<Vec<StoredSkill>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(&format!(
            "SELECT {COLUMNS} FROM skills ORDER BY name, origin"
        ))?;
        let rows = statement.query_map([], row)?;
        let mut out = Vec::new();
        for skill in rows {
            out.extend(skill?);
        }
        Ok(out)
    }

    pub fn skill(&self, id: &str) -> Result<Option<StoredSkill>> {
        Ok(self
            .lock()?
            .query_row(
                &format!("SELECT {COLUMNS} FROM skills WHERE id = ?1"),
                params![id],
                row,
            )
            .optional()?
            .flatten())
    }

    /// Adds the skill or replaces the one with its id.
    pub fn put_skill(&self, skill: &StoredSkill) -> Result<()> {
        self.lock()?.execute(
            &format!(
                "INSERT OR REPLACE INTO skills ({COLUMNS})
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)"
            ),
            params![
                skill.id,
                skill.origin.as_str(),
                skill.name,
                skill.description,
                skill.manual,
                skill.body,
                skill.hash,
                skill.files,
                skill.source,
                skill.updated_ms,
            ],
        )?;
        Ok(())
    }

    /// Removes the skill; `false` when there was none.
    pub fn remove_skill(&self, id: &str) -> Result<bool> {
        Ok(self
            .lock()?
            .execute("DELETE FROM skills WHERE id = ?1", params![id])?
            > 0)
    }

    /// How `agent` used each skill it used, by name.
    pub fn skill_uses(&self, agent: &str) -> Result<HashMap<String, SkillUse>> {
        let connection = self.lock()?;
        let mut statement = connection
            .prepare("SELECT name, loads, helpful FROM skill_uses WHERE agent_id = ?1")?;
        let rows = statement.query_map(params![agent], |row| {
            Ok((
                row.get::<_, String>(0)?,
                SkillUse {
                    loads: u32::try_from(row.get::<_, i64>(1)?).unwrap_or(u32::MAX),
                    helpful: row.get(2)?,
                },
            ))
        })?;
        rows.collect::<rusqlite::Result<_>>().map_err(Into::into)
    }

    /// The bots that loaded each skill, by the skill's name, each list in id order.
    pub fn skill_users(&self) -> Result<HashMap<String, Vec<String>>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT name, agent_id FROM skill_uses WHERE loads > 0 ORDER BY name, agent_id",
        )?;
        let rows = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get(1)?)))?;
        let mut users: HashMap<String, Vec<String>> = HashMap::new();
        for row in rows {
            let (name, agent) = row?;
            users.entry(name).or_default().push(agent);
        }
        Ok(users)
    }

    /// `agent` loaded the skill named `name` once more.
    pub fn record_skill_load(&self, agent: &str, name: &str) -> Result<()> {
        self.lock()?.execute(
            "INSERT INTO skill_uses (agent_id, name, loads) VALUES (?1, ?2, 1)
             ON CONFLICT (agent_id, name) DO UPDATE SET loads = loads + 1",
            params![agent, name],
        )?;
        Ok(())
    }

    /// `agent`'s latest verdict on the skill named `name`.
    pub fn record_skill_verdict(&self, agent: &str, name: &str, helpful: bool) -> Result<()> {
        self.lock()?.execute(
            "INSERT INTO skill_uses (agent_id, name, helpful) VALUES (?1, ?2, ?3)
             ON CONFLICT (agent_id, name) DO UPDATE SET helpful = excluded.helpful",
            params![agent, name, helpful],
        )?;
        Ok(())
    }
}
