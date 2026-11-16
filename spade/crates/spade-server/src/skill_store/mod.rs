//! Spade's own skill store (ADR 0151, points 1–3 and 7). Each skill is a folder,
//! `<data folder>/skills/<id>/`, with its `SKILL.md` and other files, and a row in Spade's
//! SQLite (`spade_store::StoredSkill`). Origins:
//!
//! - `ace`: a copy of a skill in ace's library, kept in step by [`SkillStore::mirror_now`] and
//!   [`SkillStore::run_mirror`]; read only here.
//! - `spade`: written in Spade while ace was away (or on Spade Cloud, where ace never is).
//! - `plugin`: a plugin's skill or command, offered only to bots the person allowed the plugin
//!   ([`plugin_rows`]); read only.
//! - `market`: a skill the person installed from ace's marketplace (ADR 0168), copied from the
//!   daemon by [`SkillStore::market_now`] and [`SkillStore::run_market`]; read only, for every bot.
//!
//! The store answers [`SkillLibrary`], so `skill_search`, `skill_load`, the frozen index and
//! proposals all read it. A proposal goes to ace while ace is there and to the store otherwise.

mod folders;
mod library;
mod market;
mod mirror;
mod plugin_rows;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use spade_ace::AceSkills;
use spade_store::{SkillOrigin, Store, StoredSkill};

use crate::clock::Clock;
use crate::tools::{AceLibrary, SkillLibrary, WriteError};

pub use market::Synced;
pub use mirror::Mirrored;
pub use plugin_rows::{PluginAccess, PluginFiles, PluginSkill};

/// Where ace's library is, while Spade is connected to it.
pub trait Upstream: Send + Sync {
    /// ace's library now; `None` while ace is away (and always on Spade Cloud).
    fn library(&self) -> Option<Arc<AceSkills>>;
}

/// An [`Upstream`] set by hand, for tests and for a fixed daemon.
#[derive(Default)]
pub struct AceSwitch(Mutex<Option<Arc<AceSkills>>>);

impl AceSwitch {
    pub fn new(library: Option<Arc<AceSkills>>) -> Self {
        Self(Mutex::new(library))
    }

    /// ace is there (`Some`) or away (`None`) from now on.
    pub fn set(&self, library: Option<Arc<AceSkills>>) {
        *self.0.lock().unwrap_or_else(|p| p.into_inner()) = library;
    }
}

impl Upstream for AceSwitch {
    fn library(&self) -> Option<Arc<AceSkills>> {
        self.0.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }
}

/// One of a skill's other files as the store keeps it (`StoredSkill::files`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoredFile {
    pub path: String,
    pub size: u64,
    pub hash: String,
    #[serde(default)]
    pub executable: bool,
}

/// A store skill as Settings lists it.
#[derive(Debug, Clone, Serialize)]
pub struct SkillView {
    pub id: String,
    pub name: String,
    pub description: String,
    /// `ace`, `spade`, `plugin` or `market`.
    pub origin: &'static str,
    pub manual: bool,
    /// How many other files it has besides SKILL.md.
    pub files: usize,
    pub updated_at: i64,
    /// The bots that have loaded it, by id.
    pub used_by: Vec<String>,
}

/// Why **Add to ace's library** did not.
#[derive(Debug, thiserror::Error)]
pub enum AddError {
    #[error("no such skill")]
    NotFound,
    #[error("only skills written in Spade can be added to ace's library")]
    NotSpade,
    #[error("ace isn't running, so its library can't take this skill now")]
    AceAway,
    #[error("{0}")]
    Library(WriteError),
    #[error("{0}")]
    Io(String),
}

/// Ids of skills written in Spade: `sks_` and 20 hex digits of the SHA-256 of the name.
fn spade_id(name: &str) -> String {
    named_id("sks_", name)
}

/// `prefix` and 20 hex digits of the SHA-256 of `name`.
fn named_id(prefix: &str, name: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(name.as_bytes());
    let hex: String = digest.iter().take(10).map(|b| format!("{b:02x}")).collect();
    format!("{prefix}{hex}")
}

/// Marks a Spade skill already sent to ace's library as the skill with that library id. It is
/// dropped from the store once a mirror finds the library holds it.
const ADDED: &str = "added:";

/// SKILL.md for a skill Spade writes: the frontmatter ace's agents read, then the body.
fn skill_md(name: &str, description: &str, body: &str) -> String {
    let quoted = serde_json::to_string(description).unwrap_or_else(|_| "\"\"".to_owned());
    format!("---\nname: {name}\ndescription: {quoted}\n---\n{body}")
}

fn sha256(bytes: &[u8]) -> String {
    crate::workspace::trust::hash(bytes)
}

pub struct SkillStore {
    root: PathBuf,
    store: Store,
    clock: Arc<dyn Clock>,
    ace: Option<Arc<dyn Upstream>>,
    /// One mirror or store write at a time.
    writing: tokio::sync::Mutex<()>,
    /// This store, for futures that outlive a borrow of it.
    me: std::sync::Weak<SkillStore>,
    /// Which plugins each bot may use, once the person's plugins are known.
    plugins: std::sync::OnceLock<std::sync::Weak<dyn PluginAccess>>,
}

impl SkillStore {
    /// The store in `root` (`<data folder>/skills`), indexed in `store`. `ace` is `None` on Spade
    /// Cloud, which only ever has `spade` skills. A crash's leftovers are tidied now.
    pub fn open(
        root: impl Into<PathBuf>,
        store: Store,
        clock: Arc<dyn Clock>,
        ace: Option<Arc<dyn Upstream>>,
    ) -> Arc<Self> {
        let root = root.into();
        folders::recover(&root);
        Arc::new_cyclic(|me| Self {
            root,
            store,
            clock,
            ace,
            writing: tokio::sync::Mutex::new(()),
            me: me.clone(),
            plugins: std::sync::OnceLock::new(),
        })
    }

    fn handle(&self) -> Option<Arc<Self>> {
        self.me.upgrade()
    }

    fn ace_now(&self) -> Option<Arc<AceSkills>> {
        self.ace.as_ref().and_then(|ace| ace.library())
    }

    fn rows(&self) -> Result<Vec<StoredSkill>, String> {
        self.store.skills().map_err(|e| e.to_string())
    }

    /// Every skill in the store, for Settings: by name, then origin.
    pub fn views(&self) -> Result<Vec<SkillView>, String> {
        let users = self.store.skill_users().map_err(|e| e.to_string())?;
        Ok(self
            .rows()?
            .into_iter()
            .map(|row| SkillView {
                used_by: users.get(&row.name).cloned().unwrap_or_default(),
                files: files_of(&row).len(),
                id: row.id,
                name: row.name,
                description: row.description,
                origin: row.origin.as_str(),
                manual: row.manual,
                updated_at: row.updated_ms,
            })
            .collect())
    }

    /// Saves a new `spade` skill. A name the store already holds is refused as existing.
    async fn create_here(
        &self,
        name: &str,
        description: &str,
        body: &str,
    ) -> Result<String, WriteError> {
        let _writing = self.writing.lock().await;
        let rows = self.rows().map_err(WriteError::Unavailable)?;
        if let Some(taken) = rows.iter().find(|row| row.name == name) {
            return Err(WriteError::Exists(match taken.origin {
                SkillOrigin::Spade => format!("You already have a skill called {name}."),
                _ => format!("ace's library already has a skill called {name}."),
            }));
        }
        let id = spade_id(name);
        self.write_spade(&id, name, description, body, None)?;
        Ok(id)
    }

    /// Replaces a `spade` skill's description and body if its SKILL.md still has `hash`.
    async fn edit_here(
        &self,
        id: &str,
        hash: &str,
        description: &str,
        body: &str,
    ) -> Result<String, WriteError> {
        let _writing = self.writing.lock().await;
        let row = self
            .store
            .skill(id)
            .map_err(|e| WriteError::Unavailable(e.to_string()))?
            .filter(|row| row.origin == SkillOrigin::Spade)
            .ok_or_else(|| WriteError::Refused("That skill is no longer in Spade.".to_owned()))?;
        if row.hash != hash {
            return Err(WriteError::Conflict(
                "This skill changed since. Reload it before saving.".to_owned(),
            ));
        }
        self.write_spade(id, &row.name, description, body, row.source.as_deref())?;
        Ok(id.to_owned())
    }

    fn write_spade(
        &self,
        id: &str,
        name: &str,
        description: &str,
        body: &str,
        source: Option<&str>,
    ) -> Result<(), WriteError> {
        let text = skill_md(name, description, body);
        folders::replace(&self.root, id, &text, &[])
            .map_err(|e| WriteError::Unavailable(format!("the skill could not be written: {e}")))?;
        self.store
            .put_skill(&StoredSkill {
                id: id.to_owned(),
                origin: SkillOrigin::Spade,
                name: name.to_owned(),
                description: description.to_owned(),
                manual: false,
                body: body.to_owned(),
                hash: sha256(text.as_bytes()),
                files: "[]".to_owned(),
                source: source.map(str::to_owned),
                updated_ms: self.clock.now_ms(),
            })
            .map_err(|e| WriteError::Unavailable(e.to_string()))
    }

    /// **Add to ace's library** (ADR 0151, point 3): creates the `spade` skill `id` in ace's
    /// library, for every agent, and drops the store's copy once the library has it (the
    /// mirror then holds it as an `ace` copy). Answers the library's id for it.
    pub async fn add_to_ace(&self, id: &str) -> Result<String, AddError> {
        let row = self
            .store
            .skill(id)
            .map_err(|e| AddError::Io(e.to_string()))?
            .ok_or(AddError::NotFound)?;
        if row.origin != SkillOrigin::Spade {
            return Err(AddError::NotSpade);
        }
        let ace = self.ace_now().ok_or(AddError::AceAway)?;
        let added = match row.source.as_deref().and_then(|s| s.strip_prefix(ADDED)) {
            // Sent before, and the drop never happened: only the drop is left.
            Some(added) => added.to_owned(),
            None => {
                let written = AceLibrary(ace.clone())
                    .create(&row.name, &row.description, &row.body)
                    .await
                    .map_err(AddError::Library)?;
                let mut marked = row.clone();
                marked.source = Some(format!("{ADDED}{written}"));
                self.store
                    .put_skill(&marked)
                    .map_err(|e| AddError::Io(e.to_string()))?;
                written
            }
        };
        if let Err(error) = self.mirror_from(&ace, false).await {
            tracing::warn!(%error, "the skill was added to ace's library; its copy waits for the next mirror");
        }
        Ok(added)
    }

    /// How `agent` used each skill, by name.
    fn uses_of(&self, agent: &str) -> HashMap<String, spade_core::skills::Use> {
        self.store
            .skill_uses(agent)
            .map(|uses| {
                uses.into_iter()
                    .map(|(name, u)| {
                        (
                            name,
                            spade_core::skills::Use {
                                loads: u.loads,
                                helpful: u.helpful,
                            },
                        )
                    })
                    .collect()
            })
            .unwrap_or_default()
    }
}

/// The row's other files.
fn files_of(row: &StoredSkill) -> Vec<StoredFile> {
    serde_json::from_str(&row.files).unwrap_or_default()
}

/// The store as a [`SkillLibrary`] handle.
pub fn library(store: &Arc<SkillStore>) -> Arc<dyn SkillLibrary> {
    store.clone()
}
