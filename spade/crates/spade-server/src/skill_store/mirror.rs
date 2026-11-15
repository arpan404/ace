//! The `ace` copies follow ace's library (ADR 0151, point 2). While ace is there, Spade lists the
//! library (subscribed, so the daemon pushes changes) and copies each skill whose SKILL.md hash
//! changed, its files included; on a new connection it also compares every skill's file list,
//! since a file can change without SKILL.md. A copy is replaced whole. A skill the library no
//! longer has is dropped, unless the listing was stale. With ace away the last copies stay and
//! nothing is said about it.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use spade_ace::{AceSkills, Skill, SkillScope};
use spade_store::{SkillOrigin, StoredSkill};

use super::folders::{self, FileOut};
use super::{ADDED, SkillStore, StoredFile, files_of, sha256};
use crate::tools::body_of;

/// How often the mirror looks again without a change notice, as a fallback.
const RESYNC: Duration = Duration::from_secs(10 * 60);
/// How often a waiting mirror checks whether ace came, went or was reconnected.
const LOOK: Duration = Duration::from_secs(3);

/// What one mirror changed.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Mirrored {
    /// Names copied (new or changed).
    pub copied: Vec<String>,
    /// Names dropped because the library no longer has them.
    pub dropped: Vec<String>,
}

fn scope_name(scope: &SkillScope) -> &str {
    match scope {
        SkillScope::Project => "project",
        SkillScope::Personal => "personal",
        SkillScope::Plugin => "plugin",
        SkillScope::Builtin => "builtin",
        SkillScope::Other(other) => other,
    }
}

impl SkillStore {
    /// Mirrors ace's library now, comparing every skill's files too. `Ok(None)` while ace is
    /// away.
    pub async fn mirror_now(&self) -> Result<Option<Mirrored>, String> {
        match self.ace_now() {
            Some(ace) => self.mirror_from(&ace, true).await.map(Some),
            None => Ok(None),
        }
    }

    /// Keeps the `ace` copies in step for as long as Spade runs: on start, on each change ace
    /// pushes, when ace comes back or is reconnected, and every ten minutes as a fallback.
    pub async fn run_mirror(self: Arc<Self>) {
        // The connection whose files were last compared; a new one compares them again.
        let mut deep_for: std::sync::Weak<AceSkills> = std::sync::Weak::new();
        loop {
            let Some(ace) = self.ace_now() else {
                tokio::time::sleep(LOOK).await;
                continue;
            };
            let deep = !std::ptr::eq(deep_for.as_ptr(), Arc::as_ptr(&ace));
            match self.mirror_from(&ace, deep).await {
                Ok(_) => {
                    if deep {
                        deep_for = Arc::downgrade(&ace);
                    }
                }
                Err(error) => {
                    tracing::debug!(%error, "ace's skill library did not mirror; trying again");
                    tokio::time::sleep(LOOK).await;
                    continue;
                }
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
                () = ace.changed() => {}
                () = replaced => {}
                () = tokio::time::sleep(RESYNC) => {}
            }
        }
    }

    /// One mirror from `ace`; `deep` compares each skill's file list as well as its hash.
    pub(super) async fn mirror_from(
        &self,
        ace: &AceSkills,
        deep: bool,
    ) -> Result<Mirrored, String> {
        let _writing = self.writing.lock().await;
        let list = ace.list_watched().await.map_err(|e| e.to_string())?;
        let rows = self.rows()?;
        let copies: HashMap<&str, &StoredSkill> = rows
            .iter()
            .filter(|row| row.origin == SkillOrigin::Ace)
            .map(|row| (row.id.as_str(), row))
            .collect();
        let mut done = Mirrored::default();
        // A plugin's skill has no SKILL.md of its own in the library; plugins come as their own
        // origin.
        let offered: Vec<&Skill> = list
            .skills
            .iter()
            .filter(|s| s.scope != SkillScope::Plugin && folders::usable_id(&s.id))
            .collect();
        for skill in &offered {
            let current = copies.get(skill.id.as_str()).copied();
            let changed = match current {
                None => true,
                Some(row) if row.hash != skill.hash => true,
                Some(row) if deep => match ace.files(&skill.id).await {
                    Ok(listed) => !same_files(&files_of(row), &listed.files),
                    Err(_) => false,
                },
                Some(_) => false,
            };
            if !changed {
                continue;
            }
            match self.copy(ace, skill).await {
                Ok(()) => done.copied.push(skill.name.clone()),
                // The last copy stays; the next mirror tries again.
                Err(error) => {
                    tracing::warn!(skill = %skill.name, %error, "a skill was not copied from ace")
                }
            }
        }
        let listed: HashSet<&str> = offered.iter().map(|s| s.id.as_str()).collect();
        if !list.stale {
            for row in copies
                .values()
                .filter(|row| !listed.contains(row.id.as_str()))
            {
                folders::remove(&self.root, &row.id).map_err(|e| e.to_string())?;
                self.store
                    .remove_skill(&row.id)
                    .map_err(|e| e.to_string())?;
                done.dropped.push(row.name.clone());
            }
        }
        // Spade skills added to the library go once the library holds them.
        for row in rows.iter().filter(|row| row.origin == SkillOrigin::Spade) {
            let added = row.source.as_deref().and_then(|s| s.strip_prefix(ADDED));
            if added.is_some_and(|id| listed.contains(id)) {
                folders::remove(&self.root, &row.id).map_err(|e| e.to_string())?;
                self.store
                    .remove_skill(&row.id)
                    .map_err(|e| e.to_string())?;
            }
        }
        Ok(done)
    }

    /// Copies one library skill and its files, replacing the store's copy whole.
    async fn copy(&self, ace: &AceSkills, skill: &Skill) -> Result<(), String> {
        let text = ace.read(&skill.id, None).await.map_err(|e| e.to_string())?;
        let listed = ace.files(&skill.id).await.map_err(|e| e.to_string())?;
        let mut files = Vec::with_capacity(listed.files.len());
        let mut kept = Vec::with_capacity(listed.files.len());
        for file in &listed.files {
            if folders::inside(&file.path).is_none() {
                continue;
            }
            let read = ace
                .file(&skill.id, &file.path)
                .await
                .map_err(|e| e.to_string())?;
            let hash = sha256(&read.bytes);
            if hash != file.hash {
                return Err(format!("{} changed while it was copied", file.path));
            }
            kept.push(StoredFile {
                path: file.path.clone(),
                size: read.bytes.len() as u64,
                hash,
                executable: file.executable,
            });
            files.push((file.path.clone(), read.bytes, file.executable));
        }
        let out: Vec<FileOut<'_>> = files
            .iter()
            .map(|(path, bytes, executable)| FileOut {
                path,
                bytes,
                executable: *executable,
            })
            .collect();
        folders::replace(&self.root, &skill.id, &text.text, &out).map_err(|e| e.to_string())?;
        self.store
            .put_skill(&StoredSkill {
                id: skill.id.clone(),
                origin: SkillOrigin::Ace,
                name: skill.name.clone(),
                description: skill.description.clone(),
                manual: skill.manual,
                body: body_of(&text.text).to_owned(),
                hash: text.skill.hash.clone(),
                files: serde_json::to_string(&kept).map_err(|e| e.to_string())?,
                source: Some(scope_name(&skill.scope).to_owned()),
                updated_ms: self.clock.now_ms(),
            })
            .map_err(|e| e.to_string())
    }
}

/// The stored files are the listed ones, by path and hash.
fn same_files(stored: &[StoredFile], listed: &[spade_ace::SkillFile]) -> bool {
    let wanted: HashSet<(&str, &str)> = listed
        .iter()
        .filter(|f| folders::inside(&f.path).is_some())
        .map(|f| (f.path.as_str(), f.hash.as_str()))
        .collect();
    let have: HashSet<(&str, &str)> = stored
        .iter()
        .map(|f| (f.path.as_str(), f.hash.as_str()))
        .collect();
    wanted == have
}
