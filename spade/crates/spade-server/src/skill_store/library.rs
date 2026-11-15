//! The store as the [`SkillLibrary`] Spade's skill tools and proposals read (ADR 0151, point 3):
//! listing and loading from the store; a new skill or an edit of an ace skill goes to ace's
//! library while ace is there (then copied back), and a new skill goes to the store as a
//! `spade` skill while ace is away. An edit of a `spade` skill stays in the store: Spade never
//! sends one to ace on its own.

use std::collections::{HashMap, HashSet};

use spade_core::skills::{SkillEntry, Use};
use spade_store::{SkillOrigin, StoredSkill};

use super::{SkillStore, files_of, folders};
use crate::tools::{
    AceLibrary, LibraryFuture, SkillFileData, SkillLibrary, SkillSource, WriteError, WriteFuture,
};

/// A skill's file is read back at most this large (the daemon sends at most 1 MB).
const LARGEST_FILE: u64 = 2 * 1024 * 1024;

const ACE_AWAY: &str =
    "ace isn't running, so its library can't take this edit now. Save again once ace is back.";

/// Which of several skills with one name is offered: ace's personal one, then ace's others, then
/// one written in Spade, then a plugin's.
fn rank(row: &StoredSkill) -> u8 {
    match (row.origin, row.source.as_deref()) {
        (SkillOrigin::Ace, Some("personal")) => 0,
        (SkillOrigin::Ace, _) => 1,
        (SkillOrigin::Spade, _) => 2,
        (SkillOrigin::Plugin, _) => 3,
    }
}

/// One row per name: the one [`rank`] puts first.
fn one_per_name(mut rows: Vec<StoredSkill>) -> Vec<StoredSkill> {
    rows.sort_by(|a, b| a.name.cmp(&b.name).then(rank(a).cmp(&rank(b))));
    let mut seen = HashSet::new();
    rows.retain(|row| seen.insert(row.name.clone()));
    rows
}

fn entry(row: StoredSkill) -> SkillEntry {
    SkillEntry {
        id: row.id,
        name: row.name,
        description: row.description,
        manual: row.manual,
        body: row.body,
    }
}

impl SkillStore {
    /// Every skill, one per name, plugins' included: what a new skill's name must not take.
    fn offered(&self) -> Result<Vec<StoredSkill>, String> {
        Ok(one_per_name(self.rows()?))
    }

    /// What `agent` is offered, one per name: every skill but those of plugins it may not use
    /// now (all plugins' without an agent).
    fn offered_to(&self, agent: Option<&str>) -> Result<Vec<StoredSkill>, String> {
        let plugins = self.plugins_for(agent);
        let mut rows = self.rows()?;
        rows.retain(|row| {
            row.origin != SkillOrigin::Plugin
                || row.source.as_ref().is_some_and(|p| plugins.contains(p))
        });
        Ok(one_per_name(rows))
    }

    fn source_here(&self, name: &str) -> Result<Option<SkillSource>, String> {
        let Some(row) = self.offered()?.into_iter().find(|row| row.name == name) else {
            return Ok(None);
        };
        let editable = match row.origin {
            SkillOrigin::Spade => true,
            // Saved through ace once ace is back.
            SkillOrigin::Ace => row.source.as_deref() == Some("personal"),
            SkillOrigin::Plugin => false,
        };
        Ok(Some(SkillSource {
            id: row.id,
            name: row.name,
            description: row.description,
            hash: row.hash,
            body: row.body,
            manual: row.manual,
            editable,
        }))
    }
}

impl SkillLibrary for SkillStore {
    fn list(&self) -> LibraryFuture<Vec<SkillEntry>> {
        let listed = self
            .offered_to(None)
            .map(|rows| rows.into_iter().map(entry).collect());
        Box::pin(async move { listed })
    }

    fn list_for(&self, agent: Option<&str>) -> LibraryFuture<Vec<SkillEntry>> {
        let (this, agent) = (self.handle(), agent.map(str::to_owned));
        Box::pin(async move {
            let this = this.ok_or_else(|| "the skill store closed".to_owned())?;
            // A plugin turned off in ace since the last reading is dropped first.
            if let Some(access) = this.plugin_access() {
                access.refresh().await;
            }
            this.offered_to(agent.as_deref())
                .map(|rows| rows.into_iter().map(entry).collect())
        })
    }

    fn read(&self, id: &str) -> LibraryFuture<String> {
        let text = folders::read_skill(&self.root, id).map_err(|e| e.to_string());
        Box::pin(async move { text })
    }

    fn source(&self, name: &str) -> LibraryFuture<Option<SkillSource>> {
        let ace = self.ace_now();
        let here = self.source_here(name);
        let name = name.to_owned();
        Box::pin(async move {
            let Some(ace) = ace else {
                return here;
            };
            // ace's library is the truth for its skills; a Spade skill is only in the store.
            match AceLibrary(ace).source(&name).await? {
                Some(found) => Ok(Some(found)),
                None => Ok(here?.filter(|s| s.id.starts_with("sks_"))),
            }
        })
    }

    fn create(&self, name: &str, description: &str, body: &str) -> WriteFuture {
        let (name, description, body) = (name.to_owned(), description.to_owned(), body.to_owned());
        let ace = self.ace_now();
        let this = self.handle();
        Box::pin(async move {
            let Some(this) = this else {
                return Err(WriteError::Unavailable("the skill store closed".to_owned()));
            };
            match ace {
                Some(ace) => {
                    let id = AceLibrary(ace.clone())
                        .create(&name, &description, &body)
                        .await?;
                    if let Err(error) = this.mirror_from(&ace, false).await {
                        tracing::warn!(%error, "a saved skill waits for the next mirror");
                    }
                    Ok(id)
                }
                None => this.create_here(&name, &description, &body).await,
            }
        })
    }

    fn edit(&self, base: &SkillSource, description: &str, body: &str) -> WriteFuture {
        let base = base.clone();
        let (description, body) = (description.to_owned(), body.to_owned());
        let ace = self.ace_now();
        let this = self.handle();
        Box::pin(async move {
            let Some(this) = this else {
                return Err(WriteError::Unavailable("the skill store closed".to_owned()));
            };
            if base.id.starts_with("sks_") {
                return this
                    .edit_here(&base.id, &base.hash, &description, &body)
                    .await;
            }
            let ace = ace.ok_or_else(|| WriteError::Unavailable(ACE_AWAY.to_owned()))?;
            let id = AceLibrary(ace.clone())
                .edit(&base, &description, &body)
                .await?;
            if let Err(error) = this.mirror_from(&ace, false).await {
                tracing::warn!(%error, "an edited skill waits for the next mirror");
            }
            Ok(id)
        })
    }

    fn files(&self, id: &str) -> LibraryFuture<Vec<SkillFileData>> {
        let read = (|| {
            let Some(row) = self.store.skill(id).map_err(|e| e.to_string())? else {
                return Err(format!("{id} is not in the skill store"));
            };
            files_of(&row)
                .into_iter()
                .map(|file| {
                    folders::read_file(&self.root, id, &file.path, LARGEST_FILE)
                        .map(|bytes| SkillFileData {
                            path: file.path.clone(),
                            bytes,
                            executable: file.executable,
                        })
                        .map_err(|e| format!("{}: {e}", file.path))
                })
                .collect()
        })();
        Box::pin(async move { read })
    }

    fn uses(&self, agent: &str) -> HashMap<String, Use> {
        self.uses_of(agent)
    }

    fn record_load(&self, agent: &str, name: &str) {
        if let Err(error) = self.store.record_skill_load(agent, name) {
            tracing::warn!(%error, "a skill load was not counted");
        }
    }

    fn record_verdict(&self, agent: &str, name: &str, helpful: bool) {
        if let Err(error) = self.store.record_skill_verdict(agent, name, helpful) {
            tracing::warn!(%error, "a skill verdict was not kept for ranking");
        }
    }
}
