//! The `market` copies follow the skills the person installed from ace's marketplace (ADR 0168
//! §8). While ace is there, Spade asks the daemon for the installed market skills with their
//! pinned hashes, and copies each one whose hash is new or changed, every file included: written
//! beside the old copy and renamed over it, so a copy is always replaced whole. A skill the daemon
//! no longer lists is dropped. With ace away, or when the daemon can't answer, the last copies stay
//! and nothing is said about it. Market skills are read only and serve every bot.
//!
//! Syncs run on start, on each new daemon connection, when the daemon pushes
//! `marketplace.changed`, and every ten minutes as a fallback.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use spade_ace::{AceSkills, MarketSkill};
use spade_store::{SkillOrigin, StoredSkill};

use super::folders::{self, FileOut};
use super::{SkillStore, StoredFile, named_id, sha256};
use crate::tools::body_of;

/// Store ids of market skills: `skm_` and 20 hex digits of the SHA-256 of the entry's name.
pub(super) const PREFIX: &str = "skm_";

/// How often the market copies are looked at again without a change notice.
const RESYNC: Duration = Duration::from_secs(10 * 60);
/// How often a waiting sync checks whether ace came, went or was reconnected.
const LOOK: Duration = Duration::from_secs(3);

/// ADR 0103's limits for one skill folder, which the daemon checked at install; held again here.
const MOST_FILES: usize = 512;
const LARGEST_FILE: u64 = 4 * 1024 * 1024;
const LARGEST_SKILL: u64 = 16 * 1024 * 1024;

/// What one market sync changed.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Synced {
    /// Names copied (new or changed).
    pub copied: Vec<String>,
    /// Names dropped because the daemon no longer lists them.
    pub dropped: Vec<String>,
}

fn market_id(name: &str) -> String {
    named_id(PREFIX, name)
}

impl SkillStore {
    /// Brings the market copies in step now. `Ok(None)` while ace is away.
    pub async fn market_now(&self) -> Result<Option<Synced>, String> {
        match self.ace_now() {
            Some(ace) => self.market_from(&ace).await.map(Some),
            None => Ok(None),
        }
    }

    /// Keeps the `market` copies in step for as long as Spade runs: on start, on each
    /// `marketplace.changed` the daemon pushes, when ace comes back or is reconnected, and every
    /// ten minutes as a fallback.
    pub async fn run_market(self: Arc<Self>) {
        loop {
            let Some(ace) = self.ace_now() else {
                tokio::time::sleep(LOOK).await;
                continue;
            };
            if let Err(error) = self.market_from(&ace).await {
                // An older daemon without a marketplace answers this way too; the copies stay.
                tracing::debug!(%error, "market skills did not sync; trying again later");
            }
            let replaced = async {
                loop {
                    tokio::time::sleep(LOOK).await;
                    match self.ace_now() {
                        Some(now) if Arc::ptr_eq(&now, &ace) => {}
                        _ => break,
                    }
                }
            };
            tokio::select! {
                () = ace.market_changed() => {}
                () = replaced => {}
                () = tokio::time::sleep(RESYNC) => {}
            }
        }
    }

    /// One sync from `ace`.
    async fn market_from(&self, ace: &AceSkills) -> Result<Synced, String> {
        let _writing = self.writing.lock().await;
        let listed = ace.market_skills().await.map_err(|e| e.to_string())?;
        let rows = self.rows()?;
        let copies: HashMap<&str, &StoredSkill> = rows
            .iter()
            .filter(|row| row.origin == SkillOrigin::Market)
            .map(|row| (row.id.as_str(), row))
            .collect();
        let mut done = Synced::default();
        let mut wanted = HashSet::new();
        for skill in &listed {
            let id = market_id(&skill.name);
            wanted.insert(id.clone());
            if copies
                .get(id.as_str())
                .is_some_and(|row| row.hash == skill.hash)
            {
                continue;
            }
            match self.copy_market(ace, &id, skill).await {
                Ok(()) => done.copied.push(skill.name.clone()),
                // The last copy stays; the next sync tries again.
                Err(error) => {
                    tracing::warn!(skill = %skill.name, %error, "a market skill was not copied")
                }
            }
        }
        for row in copies.values().filter(|row| !wanted.contains(&row.id)) {
            folders::remove(&self.root, &row.id).map_err(|e| e.to_string())?;
            self.store
                .remove_skill(&row.id)
                .map_err(|e| e.to_string())?;
            done.dropped.push(row.name.clone());
        }
        Ok(done)
    }

    /// Copies one market skill and its files, replacing the store's copy whole.
    async fn copy_market(
        &self,
        ace: &AceSkills,
        id: &str,
        skill: &MarketSkill,
    ) -> Result<(), String> {
        let listed = ace
            .market_files(&skill.name)
            .await
            .map_err(|e| e.to_string())?;
        if listed.len() > MOST_FILES {
            return Err(format!(
                "{} files is more than a skill may have",
                listed.len()
            ));
        }
        let mut text = None;
        let mut files = Vec::with_capacity(listed.len());
        let mut kept = Vec::with_capacity(listed.len());
        let mut total = 0_u64;
        for file in &listed {
            let top = file.path == "SKILL.md";
            if !top && folders::inside(&file.path).is_none() {
                continue;
            }
            if file.bytes > LARGEST_FILE {
                return Err(format!(
                    "{} is larger than a skill's file may be",
                    file.path
                ));
            }
            let read = ace
                .market_file(&skill.name, &file.path)
                .await
                .map_err(|e| e.to_string())?;
            let hash = sha256(&read.bytes);
            if hash != file.hash {
                return Err(format!("{} changed while it was copied", file.path));
            }
            total += read.bytes.len() as u64;
            if total > LARGEST_SKILL {
                return Err("the skill is larger than a skill may be".to_owned());
            }
            if top {
                text = Some(String::from_utf8(read.bytes).map_err(|_| "SKILL.md isn't text")?);
                continue;
            }
            kept.push(StoredFile {
                path: file.path.clone(),
                size: read.bytes.len() as u64,
                hash,
                executable: file.executable,
            });
            files.push((file.path.clone(), read.bytes, file.executable));
        }
        let text = text.ok_or("the skill has no SKILL.md")?;
        let out: Vec<FileOut<'_>> = files
            .iter()
            .map(|(path, bytes, executable)| FileOut {
                path,
                bytes,
                executable: *executable,
            })
            .collect();
        folders::replace(&self.root, id, &text, &out).map_err(|e| e.to_string())?;
        self.store
            .put_skill(&StoredSkill {
                id: id.to_owned(),
                origin: SkillOrigin::Market,
                name: skill.name.clone(),
                description: skill.description.clone(),
                manual: false,
                body: body_of(&text).to_owned(),
                // The daemon's pinned hash, so a new version is seen by its hash alone.
                hash: skill.hash.clone(),
                files: serde_json::to_string(&kept).map_err(|e| e.to_string())?,
                source: Some(skill.name.clone()),
                updated_ms: self.clock.now_ms(),
            })
            .map_err(|e| e.to_string())
    }
}
