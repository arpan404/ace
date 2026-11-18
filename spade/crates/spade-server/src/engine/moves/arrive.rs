//! A moved bot arriving (ADR 0187): its staged files are put together and checked, its rows
//! are written and checked in one transaction together with what changes on arrival (routines
//! paused, webhooks given new secrets, folder grants checked again, clubs pointed here, the
//! host choice for Spade), then its files are placed. A crash after the rows were written
//! leaves the move `placing`, and placing finishes at the next start.

use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;
use std::path::{Path, PathBuf};

use base64::Engine as _;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use spade_store::{Arrived, Arriving, HostChange, Import, Part, Row, StoredMove, TableSum};

use super::files::{is_sha256, under};
use super::host::{HostRecord, MAIN_ENABLED, MAIN_HOST, MAIN_OFF};
use super::receive::manifest_agents;
use super::{ARRIVED, COMMITTED, Engine, PLACING, detail};

/// The rows of the staged parts, in order: a run of pieces is joined into its one row.
struct StagedRows {
    parts: std::vec::IntoIter<PathBuf>,
}

impl Iterator for StagedRows {
    type Item = Part;

    fn next(&mut self) -> Option<Part> {
        let mut text = String::new();
        for path in self.parts.by_ref() {
            let part: Value = match std::fs::read_to_string(&path)
                .map_err(|e| e.to_string())
                .and_then(|t| serde_json::from_str(&t).map_err(|e| e.to_string()))
            {
                Ok(part) => part,
                Err(problem) => return Some(Err(problem)),
            };
            let table = part["table"].as_str().unwrap_or_default().to_owned();
            match part["kind"].as_str() {
                Some("rows") => {
                    let rows: Vec<Row> = part["rows"]
                        .as_array()
                        .map(|rows| rows.iter().filter_map(|r| r.as_object().cloned()).collect())
                        .unwrap_or_default();
                    return Some(Ok((table, rows)));
                }
                Some("piece") => {
                    text.push_str(part["text"].as_str().unwrap_or_default());
                    if part["last"] == json!(true) {
                        return Some(match serde_json::from_str::<Row>(&text) {
                            Ok(row) => Ok((table, vec![row])),
                            Err(error) => Err(error.to_string()),
                        });
                    }
                }
                _ => {}
            }
        }
        None
    }
}

/// Where the staged files go together: `files/<agent>/…` and `images/<sha256>`.
fn assemble(staging: &Path, parts: &[PathBuf], agents: &[String]) -> Result<u64, String> {
    let mut current: Option<(PathBuf, Sha256, u64)> = None;
    let mut files = 0;
    for path in parts {
        let part: Value =
            serde_json::from_str(&std::fs::read_to_string(path).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        let target = match part["kind"].as_str() {
            Some("file") => {
                let agent = part["agent"].as_str().unwrap_or_default();
                if !agents.iter().any(|a| a == agent) {
                    return Err("a file belongs to no bot of the move".to_owned());
                }
                let root = staging.join("files").join(agent);
                under(&root, part["path"].as_str().unwrap_or_default())
                    .ok_or("a file's path would leave the bot's folder")?
            }
            Some("image") => {
                let name = part["sha256_name"].as_str().unwrap_or_default();
                if !is_sha256(name) {
                    return Err("an image is not named by its hash".to_owned());
                }
                staging.join("images").join(name)
            }
            _ => continue,
        };
        let offset = part["offset"].as_u64().unwrap_or(u64::MAX);
        let (file, mut digest, written) = match current.take() {
            Some((at, digest, written)) if at == target && offset == written => {
                (at, digest, written)
            }
            _ if offset == 0 => (target, Sha256::new(), 0),
            _ => return Err("a file's pieces arrived out of order".to_owned()),
        };
        if let Some(parent) = file.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let data = base64::engine::general_purpose::STANDARD
            .decode(part["data"].as_str().unwrap_or_default())
            .map_err(|e| e.to_string())?;
        let mut out = std::fs::OpenOptions::new()
            .create(true)
            .append(written > 0)
            .write(true)
            .truncate(written == 0)
            .open(&file)
            .map_err(|e| e.to_string())?;
        out.write_all(&data).map_err(|e| e.to_string())?;
        digest.update(&data);
        let written = written + data.len() as u64;
        if part["last"] == json!(true) {
            let sha: String = digest
                .finalize()
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect();
            if part["size"].as_u64() != Some(written) || part["sha256"].as_str() != Some(&sha) {
                return Err(format!("{} arrived changed", file.display()));
            }
            if part["kind"] == "file" {
                files += 1;
            }
        } else {
            current = Some((file, digest, written));
        }
    }
    if current.is_some() {
        return Err("a file's last piece is missing".to_owned());
    }
    Ok(files)
}

/// A bot's security settings with every folder this machine doesn't have dropped, and those
/// folders. Folders that exist here are kept, as the same project is usually at the same path.
fn recheck_folders(text: &str) -> (String, Vec<String>) {
    let Ok(mut settings) = serde_json::from_str::<Value>(text) else {
        return (text.to_owned(), Vec::new());
    };
    let mut dropped = Vec::new();
    if let Some(grants) = settings["grants"].as_array_mut() {
        grants.retain(|grant| {
            let folder = grant["kind"] == "folder";
            let path = grant["path"].as_str().unwrap_or_default();
            let here = Path::new(path).is_absolute() && Path::new(path).is_dir();
            if folder && !here {
                dropped.push(path.to_owned());
            }
            !folder || here
        });
    }
    if let Some(toolchains) = settings["toolchains"].as_array_mut() {
        toolchains.retain(|t| {
            let here = t.as_str().is_some_and(|p| Path::new(p).is_dir());
            if !here {
                dropped.push(t.as_str().unwrap_or_default().to_owned());
            }
            here
        });
    }
    (settings.to_string(), dropped)
}

impl Engine {
    /// Writes the staged move here and answers what needs the person, or why it didn't take
    /// (the move is then given up here, and nothing of it kept).
    pub(super) fn arrive(
        &self,
        entry: &StoredMove,
        host: &Value,
        connectors: Option<&spade_connect::Connectors>,
    ) -> Result<Value, String> {
        let kept = detail(entry);
        let manifest = &kept["manifest"];
        let agents = manifest_agents(manifest).ok_or("the move's bots are not named right")?;
        let staging = self.moves_dir(&entry.id).join("in");
        let total = manifest["parts"].as_u64().unwrap_or(0);
        let parts: Vec<PathBuf> = (0..total)
            .map(|i| staging.join("parts").join(format!("{i:06}.json")))
            .collect();
        let refuse = |problem: String| {
            self.drop_staging(entry, &problem);
            Err(problem)
        };
        let _ = std::fs::remove_dir_all(staging.join("files"));
        let _ = std::fs::remove_dir_all(staging.join("images"));
        match assemble(&staging, &parts, &agents) {
            Ok(files) if Some(files) == manifest["files"]["count"].as_u64() => {}
            Ok(_) => return refuse("files went missing on the way".to_owned()),
            Err(problem) => return refuse(problem),
        }
        let expected: BTreeMap<String, TableSum> = manifest["tables"]
            .as_object()
            .map(|tables| {
                tables
                    .iter()
                    .map(|(name, sum)| {
                        (
                            name.clone(),
                            TableSum {
                                rows: sum["rows"].as_u64().unwrap_or(0),
                                hash: sum["hash"].as_str().unwrap_or_default().to_owned(),
                            },
                        )
                    })
                    .collect()
            })
            .unwrap_or_default();
        let secret = self.routines_shared().new_secret();
        let record = HostRecord::parse(host).filter(|_| entry.main);
        let newer = |held: Option<&str>| {
            let held = held
                .and_then(|t| serde_json::from_str::<Value>(t).ok())
                .and_then(|v| HostRecord::parse(&v));
            record
                .as_ref()
                .is_some_and(|record| held.is_none_or(|held| record.newer_than(&held)))
        };
        let security_key = |agent: &str| crate::security::settings::key(agent);
        let arriving = Arriving {
            move_id: &entry.id,
            placing: PLACING,
            now_ms: self.now_ms(),
            from: &entry.peer,
            secret: &secret,
            security_key: &security_key,
            recheck: &recheck_folders,
            host: record.as_ref().map(|record| HostChange {
                key: MAIN_HOST,
                value: record.to_json().to_string(),
                newer: &newer,
                clear: &[MAIN_ENABLED, MAIN_OFF],
            }),
        };
        let mut rows = StagedRows {
            parts: parts.clone().into_iter(),
        };
        let written = {
            let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
            self.store.move_import(Import {
                agents: &agents,
                expected: &expected,
                parts: &mut rows,
                main: entry.main,
                arriving,
            })
        };
        let (written, needs) = match written {
            Ok(Ok(done)) => done,
            Ok(Err(problem)) => return refuse(problem),
            Err(error) => return refuse(error.to_string()),
        };
        // Nothing of it runs until its files are in place.
        self.freeze(&written.conversations);
        let arrival = self.arrival(entry, manifest, &agents, &needs, connectors);
        let mut kept = kept.clone();
        kept["arrival"] = arrival.clone();
        kept["conversations"] = json!(written.conversations);
        let _ = self
            .store
            .set_move(&entry.id, PLACING, &kept.to_string(), self.now_ms());
        if let Ok(Some(placing)) = self.store.stored_move(&entry.id) {
            self.finish_placing(&placing);
        }
        Ok(arrival)
    }

    /// What needs the person, stored for the bot's profile: routines to resume, webhooks with
    /// new addresses, folders to grant again, endpoints to add, apps to connect, plugins to
    /// install, and what stayed behind.
    fn arrival(
        &self,
        entry: &StoredMove,
        manifest: &Value,
        agents: &[String],
        needs: &Arrived,
        connectors: Option<&spade_connect::Connectors>,
    ) -> Value {
        let here: BTreeSet<String> = self
            .store
            .endpoints()
            .map(|all| all.into_iter().map(|e| e.id).collect())
            .unwrap_or_default();
        let endpoints: Vec<Value> = manifest["endpoints"]
            .as_array()
            .map(|all| {
                all.iter()
                    .filter(|e| !e["id"].as_str().is_some_and(|id| here.contains(id)))
                    .map(|e| e["name"].clone())
                    .collect()
            })
            .unwrap_or_default();
        let mut plugins = BTreeSet::new();
        let mut apps = BTreeSet::new();
        for agent in agents {
            let wanted: BTreeSet<String> = manifest["extras"]["plugins"][agent]
                .as_array()
                .map(|n| {
                    n.iter()
                        .filter_map(|v| v.as_str().map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default();
            if let Some(hub) = self.plugins() {
                let mut kept = wanted.clone();
                while let Err(crate::plugins::AllowError::Unknown(name)) =
                    hub.set_allowed(agent, kept.clone())
                {
                    kept.remove(&name);
                    plugins.insert(name);
                }
            } else {
                plugins.extend(wanted);
            }
            let choice = &manifest["extras"]["connectors"][agent];
            if choice == "all" {
                if let Some(hub) = connectors {
                    let _ = hub.set_access(agent, spade_connect::Access::All);
                }
            } else if let Some(chosen) = choice.as_array() {
                let names: BTreeSet<String> = chosen
                    .iter()
                    .filter_map(|v| v.as_str().map(str::to_owned))
                    .collect();
                match connectors {
                    Some(hub) => {
                        let known: BTreeSet<String> =
                            hub.list().into_iter().map(|c| c.id).collect();
                        let (have, lack): (BTreeSet<_>, BTreeSet<_>) =
                            names.into_iter().partition(|id| known.contains(id));
                        apps.extend(lack);
                        let _ = hub.set_access(agent, spade_connect::Access::Only(have));
                    }
                    None => apps.extend(names),
                }
            }
        }
        let arrival = json!({
            "from": { "host": entry.peer, "name": entry.peer_name },
            "at": self.now_ms(),
            "routines_paused": needs.routines_paused,
            "webhooks": needs.webhooks,
            "folders": needs.folders,
            "endpoints": endpoints,
            "apps": apps,
            "plugins": plugins,
            "left": manifest["left"],
        });
        if let Err(error) = self.store.set_setting(
            &format!("{ARRIVED}:{}", entry.agent_id),
            Some(&arrival.to_string()),
        ) {
            tracing::error!(%error, "what a moved bot needs could not be stored");
        }
        arrival
    }

    /// Puts the staged files in place (each step can run again), then the move has taken.
    pub(super) fn finish_placing(&self, entry: &StoredMove) {
        let kept = detail(entry);
        let staging = self.moves_dir(&entry.id).join("in");
        let data = self.data_dir();
        let agents = manifest_agents(&kept["manifest"]).unwrap_or_default();
        let mut placed = true;
        for agent in &agents {
            let from = staging.join("files").join(agent);
            let to = data.join("workspace").join(agent);
            if from.exists() {
                if to.exists() {
                    let aside = data
                        .join("moved")
                        .join(&entry.id)
                        .join("replaced")
                        .join(agent);
                    let _ = std::fs::create_dir_all(aside.parent().unwrap_or(&data));
                    placed &= std::fs::rename(&to, &aside).is_ok();
                }
                let _ = std::fs::create_dir_all(data.join("workspace"));
                placed &= std::fs::rename(&from, &to).is_ok();
            }
        }
        if let Ok(images) = std::fs::read_dir(staging.join("images")) {
            for image in images.filter_map(|e| e.ok()) {
                let to = self.images.dir().join(image.file_name());
                if !to.exists() {
                    placed &= std::fs::rename(image.path(), to).is_ok();
                }
            }
        }
        if !placed {
            tracing::error!(id = %entry.id, "a moved bot's files could not all be placed");
            return;
        }
        let conversations = super::strings(&kept["conversations"]);
        for conversation in &conversations {
            self.forget_activity(conversation);
        }
        self.forget_tree();
        let _ = std::fs::remove_dir_all(self.moves_dir(&entry.id));
        if let Err(error) =
            self.store
                .set_move(&entry.id, COMMITTED, &kept.to_string(), self.now_ms())
        {
            tracing::error!(%error, "a moved bot's arrival could not be stored");
        }
        self.thaw(&conversations);
    }
}

#[cfg(test)]
mod tests {
    use super::recheck_folders;

    #[test]
    fn a_folder_grant_this_machine_lacks_is_dropped_and_named() {
        let here = std::env::temp_dir();
        let here = here.to_string_lossy();
        let text = serde_json::json!({
            "grants": [
                { "id": "g1", "kind": "folder", "path": here, "write": false, "by": "person", "created_at": 1 },
                { "id": "g2", "kind": "folder", "path": "/no/such/folder/anywhere", "by": "person", "created_at": 1 },
                { "id": "g3", "kind": "git_push", "repo": "o/r", "branch": "main", "by": "person", "created_at": 1 },
            ],
            "toolchains": ["/no/such/toolchain"],
        })
        .to_string();
        let (checked, dropped) = recheck_folders(&text);
        assert_eq!(dropped, ["/no/such/folder/anywhere", "/no/such/toolchain"]);
        let checked: serde_json::Value = serde_json::from_str(&checked).unwrap_or_default();
        let ids: Vec<_> = checked["grants"]
            .as_array()
            .map(|g| g.iter().filter_map(|g| g["id"].as_str()).collect())
            .unwrap_or_default();
        assert_eq!(ids, ["g1", "g3"]);
    }
}
