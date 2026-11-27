// SPDX-License-Identifier: Apache-2.0
//! The forge's SQLite tables (`store.ts`): thread-to-PR links, link epochs, and bounded
//! auto-fix intent queues on `ace-store`'s connection.

use std::collections::HashSet;
use std::sync::Arc;

use ace_json::Value;
use ace_store::{Connection, Value as SqlValue};
use serde::{Deserialize, Serialize};

use crate::pure::pr_reference::pr_url;
use crate::pure::{ForgePrRef, ForgeRepository};
use crate::transport::error::{ForgeError, Kind};
use crate::transport::redact::redact_data;

const MAX_LINKS_PER_THREAD: usize = 100;
const MAX_PENDING_CAP: usize = 2_000;
const PENDING_PAGE_LIMIT: i64 = 32;

/// Raised when pre-existing `forge_links` or `forge_intents` tables lack current columns.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{reason} ({location}): {guidance}")]
pub struct IncompatibleDataError {
    pub location: String,
    pub reason: String,
    pub guidance: String,
}

/// Errors produced by `ForgeStore` operations.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum StoreError {
    #[error("Invalid queue cap")]
    InvalidQueueCap,
    #[error(transparent)]
    IncompatibleData(#[from] IncompatibleDataError),
    #[error(transparent)]
    Forge(#[from] ForgeError),
    #[error("sqlite error: {0}")]
    Sqlite(#[from] ace_store::Error),
}

/// Association between a thread and a pull request (`ForgeThreadLink`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgeThreadLink {
    pub thread_id: String,
    pub pr: ForgePrRef,
}

impl ForgeThreadLink {
    pub fn validate(&self) -> Result<(), ForgeError> {
        let len = self.thread_id.chars().count();
        if len == 0 || len > 256 || self.pr.number == 0 {
            return Err(ForgeError::new(Kind::InvalidData));
        }
        ForgeRepository::validate(
            self.pr.repository.forge,
            self.pr.repository.host.clone(),
            self.pr.repository.owner.clone(),
            self.pr.repository.name.clone(),
        )?;
        Ok(())
    }
}

/// Stored link together with its monotonic generation (`ForgeLinkState`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgeLinkState {
    pub link: ForgeThreadLink,
    pub generation: u64,
}

/// Summary state of a linked pull request (`LinkedPullRequest.state`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LinkedPrState {
    Open,
    Draft,
    Merged,
    Closed,
}

impl<'de> Deserialize<'de> for LinkedPrState {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        match String::deserialize(deserializer)?.as_str() {
            "open" => Ok(LinkedPrState::Open),
            "draft" => Ok(LinkedPrState::Draft),
            "merged" => Ok(LinkedPrState::Merged),
            "closed" => Ok(LinkedPrState::Closed),
            other => Err(serde::de::Error::custom(format!(
                "unknown PR state: {other}"
            ))),
        }
    }
}

/// Rolled-up check state of a linked pull request (`LinkedPullRequest.checks`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LinkedPrChecks {
    Pending,
    Passed,
    Failed,
}

impl<'de> Deserialize<'de> for LinkedPrChecks {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        match String::deserialize(deserializer)?.as_str() {
            "pending" => Ok(LinkedPrChecks::Pending),
            "passed" => Ok(LinkedPrChecks::Passed),
            "failed" => Ok(LinkedPrChecks::Failed),
            other => Err(serde::de::Error::custom(format!(
                "unknown checks state: {other}"
            ))),
        }
    }
}

/// Local PR summary cached on `forge_links.summary` (`LinkedPullRequest`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedPullRequest {
    pub number: u64,
    pub repo: ForgeRepository,
    pub url: String,
    pub state: LinkedPrState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub updated_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checks: Option<LinkedPrChecks>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unverified: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deleted: Option<bool>,
}

impl LinkedPullRequest {
    pub fn validate(&self) -> Result<(), ForgeError> {
        if self.number == 0
            || self.url.chars().count() > 4096
            || !(self.url.starts_with("http://") || self.url.starts_with("https://"))
        {
            return Err(ForgeError::new(Kind::InvalidData));
        }
        if let Some(title) = &self.title
            && title.chars().count() > 65_536
        {
            return Err(ForgeError::new(Kind::InvalidData));
        }
        if let Some(head) = &self.head
            && head.chars().count() > 64
        {
            return Err(ForgeError::new(Kind::InvalidData));
        }
        ForgeRepository::validate(
            self.repo.forge,
            self.repo.host.clone(),
            self.repo.owner.clone(),
            self.repo.name.clone(),
        )?;
        Ok(())
    }
}

/// Protocol `ForgeCheck` stored inside a CI auto-fix intent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredForgeCheck {
    pub id: String,
    pub name: String,
    pub status: String,
    pub conclusion: Option<String>,
    pub completed_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<Option<String>>,
    pub job_id: Option<u64>,
    pub url: Option<String>,
}

/// Protocol `ForgeComment` stored inside a review auto-fix intent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredForgeComment {
    pub kind: String,
    pub id: u64,
    pub body: String,
    pub author: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author_avatar_url: Option<String>,
    pub file: Option<String>,
    pub line: Option<i64>,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    pub reply_to: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub review_state: Option<String>,
}

/// Auto-fix context (`ForgeAutoFixIntent.context`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ForgeAutoFixContext {
    #[serde(rename_all = "camelCase")]
    Ci {
        check: StoredForgeCheck,
        log_tail: String,
        truncated: bool,
        log_unavailable: bool,
    },
    #[serde(rename_all = "camelCase")]
    Review { comment: StoredForgeComment },
}

fn default_link_generation() -> u64 {
    1
}

/// Queued auto-fix intent (`ForgeAutoFixIntent`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgeAutoFixIntent {
    #[serde(rename = "type")]
    pub kind: String,
    pub key: String,
    pub link: ForgeThreadLink,
    #[serde(default = "default_link_generation")]
    pub link_generation: u64,
    pub head_sha: String,
    pub context: ForgeAutoFixContext,
}

impl ForgeAutoFixIntent {
    pub fn validate(&self) -> Result<(), ForgeError> {
        if self.kind != "auto-fix"
            || self.key.chars().count() > 1_024
            || self.link_generation == 0
            || self.head_sha.chars().count() > 256
        {
            return Err(ForgeError::new(Kind::InvalidData));
        }
        self.link.validate()?;
        match &self.context {
            ForgeAutoFixContext::Ci {
                check, log_tail, ..
            } => {
                if check.id.chars().count() > 256
                    || check.name.chars().count() > 65_536
                    || log_tail.chars().count() > 65_536
                    || !matches!(
                        check.status.as_str(),
                        "pending" | "success" | "failure" | "cancelled" | "unknown"
                    )
                    || check.job_id == Some(0)
                {
                    return Err(ForgeError::new(Kind::InvalidData));
                }
            }
            ForgeAutoFixContext::Review { comment } => {
                if !matches!(comment.kind.as_str(), "inline" | "issue" | "review")
                    || comment.id == 0
                    || comment.body.chars().count() > 65_536
                    || comment.author.chars().count() > 65_536
                {
                    return Err(ForgeError::new(Kind::InvalidData));
                }
            }
        }
        Ok(())
    }
}

/// Canonical `pr_key` stored in `forge_intents.pr_key`.
pub fn pr_key(pr: &ForgePrRef) -> String {
    format!("{}:{}", pr.repository.key(), pr.number)
}

fn assert_current_schema(db: &Arc<Connection>) -> Result<(), StoreError> {
    let expected: [(&str, &[&str]); 2] = [
        (
            "forge_links",
            &[
                "thread_id",
                "repo",
                "number",
                "payload",
                "generation",
                "summary",
            ],
        ),
        ("forge_intents", &["thread_id", "key", "payload", "pr_key"]),
    ];
    for (table, cols) in expected {
        let stmt = db.prepare(&format!("PRAGMA table_info({table})"))?;
        let mut present = HashSet::new();
        while let Some(row) = stmt.step()? {
            if let Some(SqlValue::Text(name)) = row.get(1) {
                present.insert(name.clone());
            }
        }
        if cols.iter().all(|col| present.contains(*col)) {
            continue;
        }
        let location = db
            .location()?
            .unwrap_or_else(|| String::from("the daemon database"));
        return Err(IncompatibleDataError {
            location,
            reason: format!("Pull request links are stored in an older format ({table})"),
            guidance: String::from(
                "Quit ace, then start it with a fresh ACE_HOME, or drop the forge_links, forge_intents and forge_link_epochs tables from that file to forget the old pull request links.",
            ),
        }
        .into());
    }
    Ok(())
}

/// Caller owns database lifetime; tables are isolated from daemon migrations (`ForgeStore`).
pub struct ForgeStore {
    db: Arc<Connection>,
    max_pending: usize,
}

impl ForgeStore {
    pub fn new(db: Arc<Connection>, max_pending: usize) -> Result<Self, StoreError> {
        if !(1..=MAX_PENDING_CAP).contains(&max_pending) {
            return Err(StoreError::InvalidQueueCap);
        }
        db.exec(
            "CREATE TABLE IF NOT EXISTS forge_links (thread_id TEXT NOT NULL, repo TEXT NOT NULL,
                number INTEGER NOT NULL, payload TEXT NOT NULL, generation INTEGER NOT NULL, summary TEXT,
                PRIMARY KEY(thread_id,repo,number));
            CREATE TABLE IF NOT EXISTS forge_intents (thread_id TEXT NOT NULL, key TEXT NOT NULL, payload TEXT,
                pr_key TEXT, PRIMARY KEY(thread_id,key));
            CREATE INDEX IF NOT EXISTS forge_pending ON forge_intents(thread_id) WHERE payload IS NOT NULL;
            CREATE TABLE IF NOT EXISTS forge_link_epochs(thread_id TEXT PRIMARY KEY, generation INTEGER NOT NULL);",
        )?;
        assert_current_schema(&db)?;
        db.exec(
            "CREATE INDEX IF NOT EXISTS forge_repository_links ON forge_links(repo,number,thread_id)",
        )?;
        Ok(Self { db, max_pending })
    }

    pub fn link(&self, input: &ForgeThreadLink) -> Result<(), StoreError> {
        input.validate()?;
        if self
            .get_link_state(&input.thread_id, Some(&input.pr))?
            .is_some()
        {
            return Ok(());
        }
        if self.get_links(&input.thread_id)?.len() >= MAX_LINKS_PER_THREAD {
            return Err(ForgeError::new(Kind::Limit).into());
        }
        self.db.exec("SAVEPOINT forge_link")?;
        let outcome = (|| -> Result<(), StoreError> {
            let advance = self.db.prepare(
                "INSERT INTO forge_link_epochs VALUES (?,1) ON CONFLICT(thread_id) DO UPDATE SET generation=generation+1",
            )?;
            advance.bind(&[Some(SqlValue::Text(input.thread_id.clone()))])?;
            let _ = advance.step()?;

            let read_gen = self
                .db
                .prepare("SELECT generation FROM forge_link_epochs WHERE thread_id=?")?;
            read_gen.bind(&[Some(SqlValue::Text(input.thread_id.clone()))])?;
            let generation = match read_gen.step()? {
                Some(row) => positive_i64(row.first())?,
                None => return Err(ForgeError::new(Kind::InvalidData).into()),
            };

            let payload =
                ace_json::ser::to_string(input).map_err(|_| ForgeError::new(Kind::InvalidData))?;
            let put = self.db.prepare(
                "INSERT INTO forge_links(thread_id,repo,number,payload,generation) VALUES (?,?,?,?,?)",
            )?;
            put.bind(&[
                Some(SqlValue::Text(input.thread_id.clone())),
                Some(SqlValue::Text(input.pr.repository.key())),
                Some(SqlValue::Integer(
                    i64::try_from(input.pr.number)
                        .map_err(|_| ForgeError::new(Kind::InvalidData))?,
                )),
                Some(SqlValue::Text(payload)),
                Some(SqlValue::Integer(generation)),
            ])?;
            let _ = put.step()?;
            Ok(())
        })();
        match outcome {
            Ok(()) => {
                self.db.exec("RELEASE forge_link")?;
                Ok(())
            }
            Err(err) => {
                let _ = self.db.exec("ROLLBACK TO forge_link; RELEASE forge_link");
                Err(err)
            }
        }
    }

    pub fn get_links(&self, thread_id: &str) -> Result<Vec<ForgeLinkState>, StoreError> {
        let stmt = self.db.prepare(
            "SELECT payload,generation,summary FROM forge_links WHERE thread_id=? ORDER BY generation DESC",
        )?;
        stmt.bind(&[Some(SqlValue::Text(thread_id.to_owned()))])?;
        let mut out = Vec::new();
        while let Some(row) = stmt.step()? {
            let link: ForgeThreadLink = decode_payload(row.first())?;
            link.validate()?;
            let generation = positive_i64(row.get(1))? as u64;
            out.push(ForgeLinkState { link, generation });
        }
        Ok(out)
    }

    pub fn get_link(&self, thread_id: &str) -> Result<Option<ForgeThreadLink>, StoreError> {
        Ok(self.get_link_state(thread_id, None)?.map(|s| s.link))
    }

    pub fn get_link_state(
        &self,
        thread_id: &str,
        pr: Option<&ForgePrRef>,
    ) -> Result<Option<ForgeLinkState>, StoreError> {
        let Some(pr) = pr else {
            return Ok(self.get_links(thread_id)?.into_iter().next());
        };
        let stmt = self.db.prepare(
            "SELECT payload,generation FROM forge_links WHERE thread_id=? AND repo=? AND number=?",
        )?;
        stmt.bind(&[
            Some(SqlValue::Text(thread_id.to_owned())),
            Some(SqlValue::Text(pr.repository.key())),
            Some(SqlValue::Integer(
                i64::try_from(pr.number).map_err(|_| ForgeError::new(Kind::InvalidData))?,
            )),
        ])?;
        let Some(row) = stmt.step()? else {
            return Ok(None);
        };
        let link: ForgeThreadLink = decode_payload(row.first())?;
        link.validate()?;
        let generation = positive_i64(row.get(1))? as u64;
        Ok(Some(ForgeLinkState { link, generation }))
    }

    pub fn summaries(&self, thread_id: &str) -> Result<Vec<LinkedPullRequest>, StoreError> {
        let stmt = self.db.prepare(
            "SELECT payload,generation,summary FROM forge_links WHERE thread_id=? ORDER BY generation DESC",
        )?;
        stmt.bind(&[Some(SqlValue::Text(thread_id.to_owned()))])?;
        let mut out = Vec::new();
        while let Some(row) = stmt.step()? {
            match row.get(2) {
                Some(SqlValue::Text(summary)) if !summary.is_empty() => {
                    let parsed: LinkedPullRequest = decode_str(summary)?;
                    parsed.validate()?;
                    out.push(parsed);
                }
                Some(SqlValue::Null) | Some(SqlValue::Text(_)) => {
                    let link: ForgeThreadLink = decode_payload(row.first())?;
                    link.validate()?;
                    out.push(LinkedPullRequest {
                        number: link.pr.number,
                        url: pr_url(&link.pr)?,
                        repo: link.pr.repository,
                        state: LinkedPrState::Open,
                        title: None,
                        updated_at: 0,
                        head: None,
                        checks: None,
                        unverified: Some(true),
                        deleted: None,
                    });
                }
                _ => return Err(ForgeError::new(Kind::InvalidData).into()),
            }
        }
        Ok(out)
    }

    pub fn update(
        &self,
        thread_id: &str,
        pr: &LinkedPullRequest,
        generation: u64,
    ) -> Result<(), StoreError> {
        pr.validate()?;
        let serialized =
            ace_json::ser::to_string(pr).map_err(|_| ForgeError::new(Kind::InvalidData))?;
        let stmt = self.db.prepare(
            "UPDATE forge_links SET summary=? WHERE thread_id=? AND repo=? AND number=? AND generation=?",
        )?;
        stmt.bind(&[
            Some(SqlValue::Text(serialized)),
            Some(SqlValue::Text(thread_id.to_owned())),
            Some(SqlValue::Text(pr.repo.key())),
            Some(SqlValue::Integer(
                i64::try_from(pr.number).map_err(|_| ForgeError::new(Kind::InvalidData))?,
            )),
            Some(SqlValue::Integer(
                i64::try_from(generation).map_err(|_| ForgeError::new(Kind::InvalidData))?,
            )),
        ])?;
        let _ = stmt.step()?;
        Ok(())
    }

    pub fn unlink(&self, thread_id: &str, pr: Option<&ForgePrRef>) -> Result<(), StoreError> {
        self.db.exec("SAVEPOINT forge_unlink")?;
        let outcome = (|| -> Result<(), StoreError> {
            if let Some(pr) = pr {
                let del_intents = self
                    .db
                    .prepare("DELETE FROM forge_intents WHERE thread_id=? AND pr_key=?")?;
                del_intents.bind(&[
                    Some(SqlValue::Text(thread_id.to_owned())),
                    Some(SqlValue::Text(pr_key(pr))),
                ])?;
                let _ = del_intents.step()?;

                let del_link = self
                    .db
                    .prepare("DELETE FROM forge_links WHERE thread_id=? AND repo=? AND number=?")?;
                del_link.bind(&[
                    Some(SqlValue::Text(thread_id.to_owned())),
                    Some(SqlValue::Text(pr.repository.key())),
                    Some(SqlValue::Integer(
                        i64::try_from(pr.number).map_err(|_| ForgeError::new(Kind::InvalidData))?,
                    )),
                ])?;
                let _ = del_link.step()?;
            } else {
                let del_intents = self
                    .db
                    .prepare("DELETE FROM forge_intents WHERE thread_id=?")?;
                del_intents.bind(&[Some(SqlValue::Text(thread_id.to_owned()))])?;
                let _ = del_intents.step()?;

                let del_links = self
                    .db
                    .prepare("DELETE FROM forge_links WHERE thread_id=?")?;
                del_links.bind(&[Some(SqlValue::Text(thread_id.to_owned()))])?;
                let _ = del_links.step()?;
            }
            Ok(())
        })();
        match outcome {
            Ok(()) => {
                self.db.exec("RELEASE forge_unlink")?;
                Ok(())
            }
            Err(err) => {
                let _ = self
                    .db
                    .exec("ROLLBACK TO forge_unlink; RELEASE forge_unlink");
                Err(err)
            }
        }
    }

    pub fn has_intent(&self, thread_id: &str, key: &str) -> Result<bool, StoreError> {
        let stmt = self
            .db
            .prepare("SELECT 1 FROM forge_intents WHERE thread_id=? AND key=?")?;
        stmt.bind(&[
            Some(SqlValue::Text(thread_id.to_owned())),
            Some(SqlValue::Text(key.to_owned())),
        ])?;
        Ok(stmt.step()?.is_some())
    }

    pub fn admit(&self, input: &ForgeAutoFixIntent) -> Result<(), StoreError> {
        let raw_json =
            ace_json::ser::to_string(input).map_err(|_| ForgeError::new(Kind::InvalidData))?;
        let raw_value: Value =
            ace_json::parse(&raw_json).map_err(|_| ForgeError::new(Kind::InvalidData))?;
        let redacted_value = redact_data(&raw_value);
        let intent: ForgeAutoFixIntent = ace_json::from_value(&redacted_value)
            .map_err(|_| ForgeError::new(Kind::InvalidData))?;
        intent.validate()?;

        if self.has_intent(&intent.link.thread_id, &intent.key)? {
            return Ok(());
        }
        let count_stmt = self
            .db
            .prepare("SELECT count(*) AS count FROM forge_intents WHERE payload IS NOT NULL")?;
        let count = match count_stmt.step()? {
            Some(row) => match row.first() {
                Some(SqlValue::Integer(n)) if *n >= 0 => *n as usize,
                _ => return Err(ForgeError::new(Kind::InvalidData).into()),
            },
            None => 0,
        };
        if count >= self.max_pending {
            return Err(ForgeError::new(Kind::Limit).into());
        }
        let state = self.get_link_state(&intent.link.thread_id, Some(&intent.link.pr))?;
        let Some(state) = state else {
            return Err(ForgeError::new(Kind::Conflict).into());
        };
        let state_json = ace_json::ser::to_string(&state.link)
            .map_err(|_| ForgeError::new(Kind::InvalidData))?;
        let intent_link_json = ace_json::ser::to_string(&intent.link)
            .map_err(|_| ForgeError::new(Kind::InvalidData))?;
        if state.generation != intent.link_generation || state_json != intent_link_json {
            return Err(ForgeError::new(Kind::Conflict).into());
        }

        let payload =
            ace_json::ser::to_string(&intent).map_err(|_| ForgeError::new(Kind::InvalidData))?;
        let insert = self.db.prepare(
            "INSERT OR IGNORE INTO forge_intents(thread_id,key,payload,pr_key) VALUES (?,?,?,?)",
        )?;
        insert.bind(&[
            Some(SqlValue::Text(intent.link.thread_id.clone())),
            Some(SqlValue::Text(intent.key.clone())),
            Some(SqlValue::Text(payload)),
            Some(SqlValue::Text(pr_key(&intent.link.pr))),
        ])?;
        let _ = insert.step()?;
        Ok(())
    }

    pub fn pending(
        &self,
        thread_id: &str,
        pr: Option<&ForgePrRef>,
    ) -> Result<Vec<ForgeAutoFixIntent>, StoreError> {
        let stmt = if let Some(pr) = pr {
            let s = self.db.prepare(
                "SELECT payload FROM forge_intents WHERE thread_id=? AND payload IS NOT NULL AND pr_key=? ORDER BY rowid LIMIT ?",
            )?;
            s.bind(&[
                Some(SqlValue::Text(thread_id.to_owned())),
                Some(SqlValue::Text(pr_key(pr))),
                Some(SqlValue::Integer(PENDING_PAGE_LIMIT)),
            ])?;
            s
        } else {
            let s = self.db.prepare(
                "SELECT payload FROM forge_intents WHERE thread_id=? AND payload IS NOT NULL ORDER BY rowid LIMIT ?",
            )?;
            s.bind(&[
                Some(SqlValue::Text(thread_id.to_owned())),
                Some(SqlValue::Integer(PENDING_PAGE_LIMIT)),
            ])?;
            s
        };
        let mut out = Vec::new();
        while let Some(row) = stmt.step()? {
            let intent: ForgeAutoFixIntent = decode_payload(row.first())?;
            intent.validate()?;
            out.push(intent);
        }
        Ok(out)
    }

    pub fn discard(&self, intent: &ForgeAutoFixIntent) -> Result<(), StoreError> {
        let stmt = self.db.prepare(
            "DELETE FROM forge_intents WHERE thread_id=? AND key=? AND payload IS NOT NULL",
        )?;
        stmt.bind(&[
            Some(SqlValue::Text(intent.link.thread_id.clone())),
            Some(SqlValue::Text(intent.key.clone())),
        ])?;
        let _ = stmt.step()?;
        Ok(())
    }

    pub fn acknowledge(&self, intent: &ForgeAutoFixIntent) -> Result<(), StoreError> {
        let stmt = self
            .db
            .prepare("UPDATE forge_intents SET payload=NULL WHERE thread_id=? AND key=?")?;
        stmt.bind(&[
            Some(SqlValue::Text(intent.link.thread_id.clone())),
            Some(SqlValue::Text(intent.key.clone())),
        ])?;
        let _ = stmt.step()?;
        Ok(())
    }
}

fn positive_i64(value: Option<&SqlValue>) -> Result<i64, ForgeError> {
    match value {
        Some(SqlValue::Integer(n)) if *n > 0 => Ok(*n),
        _ => Err(ForgeError::new(Kind::InvalidData)),
    }
}

fn decode_str<T: serde::de::DeserializeOwned>(text: &str) -> Result<T, ForgeError> {
    let value = ace_json::parse(text).map_err(|_| ForgeError::new(Kind::InvalidData))?;
    ace_json::from_value(&value).map_err(|_| ForgeError::new(Kind::InvalidData))
}

fn decode_payload<T: serde::de::DeserializeOwned>(
    value: Option<&SqlValue>,
) -> Result<T, ForgeError> {
    let Some(SqlValue::Text(text)) = value else {
        return Err(ForgeError::new(Kind::InvalidData));
    };
    decode_str(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pure::ForgeKind;
    use ace_store::OpenOptions;

    fn memory_db() -> Arc<Connection> {
        Connection::open(":memory:", OpenOptions::default()).unwrap()
    }

    fn repo(name: &str) -> ForgeRepository {
        ForgeRepository::validate(ForgeKind::Github, "github.com", "octo", name).unwrap()
    }

    fn link(thread: &str, name: &str, number: u64) -> ForgeThreadLink {
        ForgeThreadLink {
            thread_id: thread.into(),
            pr: ForgePrRef {
                repository: repo(name),
                number,
            },
        }
    }

    fn ci_intent(
        link: ForgeThreadLink,
        key: &str,
        generation: u64,
        log_tail: &str,
    ) -> ForgeAutoFixIntent {
        ForgeAutoFixIntent {
            kind: "auto-fix".into(),
            key: key.into(),
            link,
            link_generation: generation,
            head_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
            context: ForgeAutoFixContext::Ci {
                check: StoredForgeCheck {
                    id: "check:1".into(),
                    name: "test".into(),
                    status: "failure".into(),
                    conclusion: Some("failure".into()),
                    completed_at: Some("2026-01-01T00:00:00Z".into()),
                    started_at: None,
                    job_id: Some(7),
                    url: Some("https://github.com/octo/ace/actions/runs/1/job/7".into()),
                },
                log_tail: log_tail.into(),
                truncated: false,
                log_unavailable: false,
            },
        }
    }

    #[test]
    fn refuses_invalid_queue_cap_and_older_table_schema() {
        assert!(matches!(
            ForgeStore::new(memory_db(), 0),
            Err(StoreError::InvalidQueueCap)
        ));
        assert!(matches!(
            ForgeStore::new(memory_db(), 2_001),
            Err(StoreError::InvalidQueueCap)
        ));

        let db = memory_db();
        db.exec("CREATE TABLE forge_links (thread_id TEXT, repo TEXT, number INTEGER);")
            .unwrap();
        let err = ForgeStore::new(db, 100).err().unwrap();
        assert!(matches!(err, StoreError::IncompatibleData(_)));
        assert!(err.to_string().contains("forge_links"));
    }

    #[test]
    fn links_advance_generation_respect_100_cap_and_store_summaries() {
        let store = ForgeStore::new(memory_db(), 2_000).unwrap();
        let l1 = link("t1", "ace", 1);
        let l2 = link("t1", "ace", 2);
        store.link(&l1).unwrap();
        // Idempotent re-link keeps generation 1.
        store.link(&l1).unwrap();
        assert_eq!(
            store
                .get_link_state("t1", Some(&l1.pr))
                .unwrap()
                .unwrap()
                .generation,
            1
        );
        store.link(&l2).unwrap();
        assert_eq!(store.get_link("t1").unwrap().unwrap(), l2);
        assert_eq!(store.summaries("t1").unwrap().len(), 2);
        assert_eq!(store.summaries("t1").unwrap()[0].unverified, Some(true));

        let updated = LinkedPullRequest {
            number: 2,
            repo: repo("ace"),
            url: "https://github.com/octo/ace/pull/2".into(),
            state: LinkedPrState::Draft,
            title: Some("WIP".into()),
            updated_at: 42,
            head: Some("abcdef".into()),
            checks: Some(LinkedPrChecks::Pending),
            unverified: None,
            deleted: None,
        };
        // Stale generation update is ignored; matching generation persists.
        store.update("t1", &updated, 99).unwrap();
        assert_eq!(store.summaries("t1").unwrap()[0].unverified, Some(true));
        store.update("t1", &updated, 2).unwrap();
        assert_eq!(store.summaries("t1").unwrap()[0], updated);

        // Enforce 100-link cap per thread.
        for n in 3..=100 {
            store.link(&link("t1", "ace", n)).unwrap();
        }
        let err = store.link(&link("t1", "ace", 101)).unwrap_err();
        assert!(matches!(err, StoreError::Forge(e) if e.kind == Kind::Limit));
    }

    #[test]
    fn admit_redacts_checks_generation_caps_pending_and_acknowledges() {
        let store = ForgeStore::new(memory_db(), 2).unwrap();
        let l1 = link("t1", "ace", 10);
        store.link(&l1).unwrap();

        // Wrong generation is rejected as conflict.
        let bad = ci_intent(l1.clone(), "k-bad", 99, "ok");
        assert!(matches!(
            store.admit(&bad),
            Err(StoreError::Forge(e)) if e.kind == Kind::Conflict
        ));

        // Admitted intent redacts credentials before storing.
        let secret = "ghp_0123456789abcdef0123456789abcdef0123";
        let i1 = ci_intent(l1.clone(), "k1", 1, &format!("token={secret}"));
        store.admit(&i1).unwrap();
        // Duplicate key is ignored without consuming another slot.
        store.admit(&i1).unwrap();

        let queued = store.pending("t1", Some(&l1.pr)).unwrap();
        assert_eq!(queued.len(), 1);
        match &queued[0].context {
            ForgeAutoFixContext::Ci { log_tail, .. } => assert!(!log_tail.contains(secret)),
            _ => panic!("expected ci context"),
        }

        // Second intent fills cap=2; third hits Limit.
        let i2 = ci_intent(l1.clone(), "k2", 1, "fail 2");
        store.admit(&i2).unwrap();
        let i3 = ci_intent(l1.clone(), "k3", 1, "fail 3");
        assert!(matches!(
            store.admit(&i3),
            Err(StoreError::Forge(e)) if e.kind == Kind::Limit
        ));

        // Acknowledge keeps dedupe marker (`has_intent` stays true) while freeing pending slot.
        store.acknowledge(&i1).unwrap();
        assert!(store.has_intent("t1", "k1").unwrap());
        assert_eq!(store.pending("t1", None).unwrap().len(), 1);

        // Discard deletes pending intent so it can be admitted again.
        store.discard(&i2).unwrap();
        assert!(!store.has_intent("t1", "k2").unwrap());
        assert!(store.pending("t1", None).unwrap().is_empty());

        // Unlinking specific PR clears its intents and link while preserving sibling links.
        let l2 = link("t1", "ace", 20);
        store.link(&l2).unwrap();
        store.admit(&ci_intent(l2.clone(), "k-l2", 2, "x")).unwrap();
        store.unlink("t1", Some(&l1.pr)).unwrap();
        assert!(store.get_link_state("t1", Some(&l1.pr)).unwrap().is_none());
        assert!(!store.has_intent("t1", "k1").unwrap());
        assert_eq!(store.pending("t1", Some(&l2.pr)).unwrap().len(), 1);
    }
}
