//! The `plugin` rows (ADR 0151, point 10): the skills and commands of the person's accepted
//! plugins that ace has on. A skill is an ordinary store skill; a command is a manual one, which
//! only the person starts and the bot never loads on its own. They come from `plugins.spade`
//! and their files from the daemon (`plugins.spadeFile`); Spade never reads a plugin's folder.
//!
//! Every plugin's rows are kept, and each bot is offered only those of the plugins it may use
//! now ([`PluginAccess`]), so turning a plugin off for a bot hides them at once and turning it off
//! in ace drops them at the next reading.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;

use spade_store::{SkillOrigin, StoredSkill};

use super::folders::{self, FileOut};
use super::{SkillStore, StoredFile, files_of, sha256};
use crate::tools::body_of;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Which plugins each bot may use now: the person's plugins, as `plugins::Plugins` knows them.
pub trait PluginAccess: Send + Sync {
    /// The plugins `agent` may use now, by name.
    fn plugins_for(&self, agent: &str) -> Vec<String>;
    /// Reads ace's plugins again when the last reading is stale, which brings the rows in step.
    fn refresh(&self) -> BoxFuture<'_, ()>;
}

/// Reads one of a plugin skill's files through the daemon.
pub trait PluginFiles: Send + Sync {
    /// The file at `path` in the plugin `plugin`.
    fn file<'a>(&'a self, plugin: &'a str, path: &'a str)
    -> BoxFuture<'a, Result<Vec<u8>, String>>;
}

/// A skill or a command of an accepted plugin, as `plugins.spade` gave it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginSkill {
    pub plugin: String,
    pub name: String,
    pub description: String,
    /// SKILL.md, or the command's file.
    pub text: String,
    /// A command: only the person starts it.
    pub manual: bool,
    /// The skill's folder in the plugin (empty for a command).
    pub folder: String,
    pub files: Vec<spade_ace::plugins::PluginFile>,
}

impl PluginSkill {
    /// Its id in the store: `plg_` and 20 hex digits of the SHA-256 of plugin, kind and name.
    fn id(&self) -> String {
        let kind = if self.manual { "command" } else { "skill" };
        let digest = sha256(format!("{}\0{kind}\0{}", self.plugin, self.name).as_bytes());
        format!("plg_{}", &digest[..20])
    }

    /// Its files that can be placed in a folder.
    fn usable_files(&self) -> impl Iterator<Item = &spade_ace::plugins::PluginFile> {
        self.files
            .iter()
            .filter(|file| folders::inside(&file.path).is_some())
    }

    /// Whether `row` already holds this skill as it is now.
    fn held_by(&self, row: &StoredSkill) -> bool {
        let wanted: HashSet<(&str, &str)> = self
            .usable_files()
            .map(|f| (f.path.as_str(), f.hash.as_str()))
            .collect();
        let stored = files_of(row);
        let have: HashSet<(&str, &str)> = stored
            .iter()
            .map(|f| (f.path.as_str(), f.hash.as_str()))
            .collect();
        row.hash == sha256(self.text.as_bytes())
            && row.name == self.name
            && row.description == self.description
            && row.manual == self.manual
            && row.source.as_deref() == Some(self.plugin.as_str())
            && wanted == have
    }
}

impl SkillStore {
    /// The plugins each bot may use, so each is offered only its plugins' skills. Until this is
    /// set, no bot is offered a plugin's skill.
    pub fn set_plugins(&self, access: std::sync::Weak<dyn PluginAccess>) {
        let _ = self.plugins.set(access);
    }

    pub(super) fn plugin_access(&self) -> Option<std::sync::Arc<dyn PluginAccess>> {
        self.plugins.get().and_then(std::sync::Weak::upgrade)
    }

    /// The plugins `agent` may use now; none without an agent.
    pub(super) fn plugins_for(&self, agent: Option<&str>) -> HashSet<String> {
        match (agent, self.plugin_access()) {
            (Some(agent), Some(access)) => access.plugins_for(agent).into_iter().collect(),
            _ => HashSet::new(),
        }
    }

    /// Makes the `plugin` rows exactly `wanted`: a new or changed one is copied with its files
    /// (each checked against its listed hash), one no longer wanted is dropped. A skill whose
    /// files could not be read keeps its last copy until the next reading.
    pub async fn sync_plugins(
        &self,
        wanted: &[PluginSkill],
        files: &dyn PluginFiles,
    ) -> Result<(), String> {
        let _writing = self.writing.lock().await;
        let rows = self.rows()?;
        let held: HashMap<&str, &StoredSkill> = rows
            .iter()
            .filter(|row| row.origin == SkillOrigin::Plugin)
            .map(|row| (row.id.as_str(), row))
            .collect();
        let mut keep = HashSet::new();
        for skill in wanted {
            let id = skill.id();
            keep.insert(id.clone());
            if held.get(id.as_str()).is_some_and(|row| skill.held_by(row)) {
                continue;
            }
            if let Err(error) = self.copy_plugin_skill(&id, skill, files).await {
                tracing::warn!(plugin = %skill.plugin, skill = %skill.name, %error,
                    "a plugin's skill was not copied");
            }
        }
        for id in held.keys().filter(|id| !keep.contains(**id)) {
            folders::remove(&self.root, id).map_err(|e| e.to_string())?;
            self.store.remove_skill(id).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    async fn copy_plugin_skill(
        &self,
        id: &str,
        skill: &PluginSkill,
        files: &dyn PluginFiles,
    ) -> Result<(), String> {
        let mut read = Vec::new();
        for file in skill.usable_files() {
            let path = format!("{}/{}", skill.folder, file.path);
            let bytes = files.file(&skill.plugin, &path).await?;
            if sha256(&bytes) != file.hash {
                return Err(format!("{} is not the file that was accepted", file.path));
            }
            read.push((file, bytes));
        }
        let out: Vec<FileOut<'_>> = read
            .iter()
            .map(|(file, bytes)| FileOut {
                path: &file.path,
                bytes,
                executable: file.executable,
            })
            .collect();
        folders::replace(&self.root, id, &skill.text, &out).map_err(|e| e.to_string())?;
        let kept: Vec<StoredFile> = read
            .iter()
            .map(|(file, bytes)| StoredFile {
                path: file.path.clone(),
                size: bytes.len() as u64,
                hash: file.hash.clone(),
                executable: file.executable,
            })
            .collect();
        self.store
            .put_skill(&StoredSkill {
                id: id.to_owned(),
                origin: SkillOrigin::Plugin,
                name: skill.name.clone(),
                description: skill.description.clone(),
                manual: skill.manual,
                body: body_of(&skill.text).to_owned(),
                hash: sha256(skill.text.as_bytes()),
                files: serde_json::to_string(&kept).map_err(|e| e.to_string())?,
                source: Some(skill.plugin.clone()),
                updated_ms: self.clock.now_ms(),
            })
            .map_err(|e| e.to_string())
    }
}
