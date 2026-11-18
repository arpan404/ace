//! A moved bot arriving (ADR 0187). Its staged files are put together and checked against the
//! move's inventory (every file and image named with its size and hash, the inventory bound to
//! the manifest the move began with): nothing missing, twice or unexpected. Then its rows are
//! written and checked in one transaction together with what changes on arrival and everything
//! needed to finish (the move reads `placing`); then its files are placed and flushed to disk.
//! Only then does the move read `committed`, which is what the source waits for. A crash after
//! the rows were written leaves the move `placing`, and placing finishes at the next start or
//! the next `commit`.

use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;
use std::path::{Path, PathBuf};

use base64::Engine as _;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use spade_core::Event;
use spade_core::event::Known;
use spade_store::{
    Arrived, Arriving, HostChange, Import, Part, Row, Selection, StoredMove, TableSum,
};

use super::files::is_sha256;
use super::host::{HostRecord, MAIN_ENABLED, MAIN_HOST, MAIN_OFF};
use super::paths::{self, under};
use super::receive::manifest_agents;
use super::{ARRIVED, COMMITTED, Engine, PLACING, consent, detail};

/// Why a commit didn't end with the bot here.
#[derive(Debug)]
pub(super) enum Failed {
    /// The move doesn't hold up; it is given up here and nothing of it is kept.
    Refused(String),
    /// Its rows are written but its files aren't placed yet: ask again.
    Placing(String),
}

/// The rows of the staged parts, in order: a run of pieces is joined into its one row.
struct StagedRows {
    parts: std::vec::IntoIter<PathBuf>,
}

fn read_part(path: &Path) -> Result<Value, String> {
    let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

impl Iterator for StagedRows {
    type Item = Part;

    fn next(&mut self) -> Option<Part> {
        let mut text = String::new();
        for path in self.parts.by_ref() {
            let part = match read_part(&path) {
                Ok(part) => part,
                Err(problem) => return Some(Err(problem)),
            };
            let table = part["table"].as_str().unwrap_or_default().to_owned();
            match part["kind"].as_str() {
                Some("rows") => {
                    let Some(list) = part["rows"].as_array() else {
                        return Some(Err("a part's rows are not a list".to_owned()));
                    };
                    let rows: Option<Vec<Row>> =
                        list.iter().map(|r| r.as_object().cloned()).collect();
                    return Some(
                        rows.map(|rows| (table, rows))
                            .ok_or_else(|| "a part holds a row that is not an object".to_owned()),
                    );
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
        (!text.is_empty()).then(|| Err("a row's last piece is missing".to_owned()))
    }
}

/// A file or image the inventory names: its kind and where it goes.
type Key = (String, String, String);

fn key_of(entry: &Value) -> Option<Key> {
    match entry["kind"].as_str()? {
        "file" => Some((
            "file".into(),
            entry["agent"].as_str()?.into(),
            entry["path"].as_str()?.into(),
        )),
        "image" => Some((
            "image".into(),
            String::new(),
            entry["name"].as_str()?.into(),
        )),
        _ => None,
    }
}

/// The inventory from its parts, checked against the manifest: its hash and count, every
/// entry well formed, no name twice. By key, each entry's size and hash.
fn inventory(
    parts: &[PathBuf],
    manifest: &Value,
    agents: &[String],
) -> Result<BTreeMap<Key, (u64, String)>, String> {
    let mut entries = Vec::new();
    for path in parts {
        let part = read_part(path)?;
        if part["kind"] == "inventory" {
            entries.extend(part["entries"].as_array().cloned().unwrap_or_default());
        }
    }
    let sha: String = Sha256::digest(Value::Array(entries.clone()).to_string())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    if manifest["inventory"]["sha256"].as_str() != Some(sha.as_str())
        || manifest["inventory"]["count"].as_u64() != Some(entries.len() as u64)
    {
        return Err("the inventory isn't the one the move began with".to_owned());
    }
    let mut named = BTreeMap::new();
    for entry in &entries {
        let key = key_of(entry).ok_or("the inventory names something Spade doesn't move")?;
        let fine = match key.0.as_str() {
            "file" => agents.contains(&key.1) && under(Path::new("/w"), &key.2).is_some(),
            _ => is_sha256(&key.2),
        };
        let (Some(size), Some(hash)) = (entry["size"].as_u64(), entry["sha256"].as_str()) else {
            return Err("the inventory has an entry without its size and hash".to_owned());
        };
        if !fine || !is_sha256(hash) {
            return Err("the inventory names a file Spade can't place".to_owned());
        }
        if named.insert(key, (size, hash.to_owned())).is_some() {
            return Err("the inventory names a file twice".to_owned());
        }
    }
    Ok(named)
}

/// Puts the staged files together under `files/<agent>/…` and `images/<sha256>`, each flushed
/// to disk, and checks them against the inventory: every one named, of its size and hash, none
/// twice, none missing.
fn assemble(
    staging: &Path,
    parts: &[PathBuf],
    expected: &BTreeMap<Key, (u64, String)>,
) -> Result<(), String> {
    let files = paths::child(staging, "files")?;
    let images = paths::child(staging, "images")?;
    let mut done: BTreeSet<Key> = BTreeSet::new();
    let mut current: Option<(Key, PathBuf, Sha256, u64)> = None;
    for path in parts {
        let part = read_part(path)?;
        let key = match part["kind"].as_str() {
            Some("file") => {
                key_of(&json!({ "kind": "file", "agent": part["agent"], "path": part["path"] }))
            }
            Some("image") => key_of(&json!({ "kind": "image", "name": part["sha256_name"] })),
            _ => continue,
        }
        .ok_or("a file part doesn't say what it is")?;
        if !expected.contains_key(&key) {
            return Err(format!("{} isn't in the inventory", key.2));
        }
        let target = if key.0 == "file" {
            under(&paths::child(&files, &key.1)?, &key.2)
        } else {
            under(&images, &key.2)
        }
        .ok_or("a file's path would leave its folder")?;
        let offset = part["offset"].as_u64().unwrap_or(u64::MAX);
        let (key, file, mut digest, written) = match current.take() {
            Some((at, file, digest, written)) if at == key && offset == written => {
                (at, file, digest, written)
            }
            _ if offset == 0 && !done.contains(&key) => (key, target, Sha256::new(), 0),
            _ if done.contains(&key) => return Err(format!("{} came twice", key.2)),
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
            out.sync_all().map_err(|e| e.to_string())?;
            let sha: String = digest
                .finalize()
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect();
            if expected.get(&key) != Some(&(written, sha)) {
                return Err(format!("{} arrived changed", key.2));
            }
            done.insert(key);
        } else {
            current = Some((key, file, digest, written));
        }
    }
    if current.is_some() {
        return Err("a file's last piece is missing".to_owned());
    }
    if let Some(missing) = expected.keys().find(|key| !done.contains(*key)) {
        return Err(format!("{} never arrived", missing.2));
    }
    Ok(())
}

impl Engine {
    /// Writes the staged move here. Answers what needs the person once the move took, else
    /// why not: refused (nothing kept, the move given up) or not placed yet (ask again).
    pub(super) fn arrive(
        &self,
        entry: &StoredMove,
        host: &Value,
        connectors: Option<&spade_connect::Connectors>,
    ) -> Result<Value, Failed> {
        let kept = detail(entry);
        let manifest = &kept["manifest"];
        let refuse = |problem: String| {
            self.drop_staging(entry, &problem);
            Failed::Refused(problem)
        };
        let agents = manifest_agents(manifest)
            .ok_or_else(|| refuse("the move's bots are not named right".to_owned()))?;
        let staging = self
            .moves_dir(&entry.id)
            .and_then(|folder| paths::child(&folder, "in"))
            .map_err(&refuse)?;
        let total = manifest["parts"].as_u64().unwrap_or(0);
        let parts_dir = paths::child(&staging, "parts").map_err(&refuse)?;
        let parts: Vec<PathBuf> = (0..total)
            .map(|i| parts_dir.join(format!("{i:06}.json")))
            .collect();
        for name in ["files", "images"] {
            paths::remove_child(&staging, name).map_err(&refuse)?;
        }
        let expected_files = inventory(&parts, manifest, &agents).map_err(&refuse)?;
        assemble(&staging, &parts, &expected_files).map_err(&refuse)?;
        let expected: BTreeMap<String, TableSum> = manifest["tables"]
            .as_object()
            .map(|tables| {
                tables
                    .iter()
                    .map(|(name, sum)| {
                        let sum = TableSum {
                            rows: sum["rows"].as_u64().unwrap_or(0),
                            hash: sum["hash"].as_str().unwrap_or_default().to_owned(),
                        };
                        (name.clone(), sum)
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
        let marker = Event::Known(Known::Arrived {
            from: entry.peer_name.clone(),
        });
        let outside = self.outside_needs(manifest, &agents);
        let placing = |written: &Selection, arrived: &Arrived| {
            let mut placing = kept.clone();
            placing["conversations"] = json!(written.conversations);
            placing["arrival"] = arrival_json(entry, &self.now_ms(), arrived, &outside, manifest);
            placing.to_string()
        };
        let arriving = Arriving {
            move_id: &entry.id,
            placing: PLACING,
            now_ms: self.now_ms(),
            from: &entry.peer,
            secret: &secret,
            security_key: &security_key,
            reset: &consent::reset,
            marker: &marker,
            host: record.as_ref().map(|record| HostChange {
                key: MAIN_HOST,
                value: record.to_json().to_string(),
                newer: &newer,
                clear: &[MAIN_ENABLED, MAIN_OFF],
            }),
            detail: &placing,
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
        let (written, _) = match written {
            Ok(Ok(done)) => done,
            Ok(Err(problem)) => return Err(refuse(problem)),
            Err(error) => return Err(refuse(error.to_string())),
        };
        // Nothing of it runs until its files are in place; its apps start at none.
        self.freeze(&entry.id, &written.conversations);
        if let Some(hub) = connectors {
            for agent in &agents {
                let none = spade_connect::Access::Only(BTreeSet::new());
                if let Err(error) = hub.set_access(agent, none) {
                    tracing::warn!(%error, "a moved bot's apps could not be set to none");
                }
            }
        }
        let placing = self
            .store
            .stored_move(&entry.id)
            .ok()
            .flatten()
            .ok_or_else(|| Failed::Placing("the move's state can't be read".to_owned()))?;
        self.finish_placing(&placing)
    }

    /// What the person must add or allow again here that lies outside the rows: endpoints this
    /// machine lacks, and the apps and plugins the bot used, which start at none.
    fn outside_needs(&self, manifest: &Value, agents: &[String]) -> Value {
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
                    .filter_map(|e| {
                        e["name"]
                            .as_str()
                            .map(|n| json!(n.chars().take(80).collect::<String>()))
                    })
                    .collect()
            })
            .unwrap_or_default();
        let mut plugins = BTreeSet::new();
        let mut apps = BTreeSet::new();
        for agent in agents {
            for name in manifest["extras"]["plugins"][agent]
                .as_array()
                .into_iter()
                .flatten()
            {
                if let Some(name) = name.as_str() {
                    plugins.insert(name.chars().take(80).collect::<String>());
                }
            }
            match &manifest["extras"]["connectors"][agent] {
                Value::String(all) if all == "all" => {
                    apps.insert("every app you connected".to_owned());
                }
                Value::Array(ids) => apps
                    .extend(ids.iter().filter_map(|v| {
                        v.as_str().map(|s| s.chars().take(80).collect::<String>())
                    })),
                _ => {}
            }
        }
        json!({ "endpoints": endpoints, "apps": apps, "plugins": plugins })
    }

    /// Puts the staged files in place (each step can run again), flushes them to disk, and only
    /// then records that the move took. Answers what needs the person.
    pub(super) fn finish_placing(&self, entry: &StoredMove) -> Result<Value, Failed> {
        let kept = detail(entry);
        let placing = |problem: String| Failed::Placing(problem);
        let data = self.data_dir();
        let staging = self
            .moves_dir(&entry.id)
            .and_then(|folder| paths::child(&folder, "in"))
            .map_err(placing)?;
        let agents = manifest_agents(&kept["manifest"]).unwrap_or_default();
        let workspaces = data.join("workspace");
        std::fs::create_dir_all(&workspaces).map_err(|e| placing(e.to_string()))?;
        let files = paths::child(&staging, "files").map_err(placing)?;
        for agent in &agents {
            let from = paths::child(&files, agent).map_err(placing)?;
            if !from.exists() {
                continue;
            }
            let to = paths::child(&workspaces, agent).map_err(placing)?;
            if to.exists() {
                let aside = paths::child(&data.join("moved"), &entry.id)
                    .and_then(|archive| paths::child(&archive, "replaced"))
                    .map_err(placing)?;
                std::fs::create_dir_all(&aside).map_err(|e| placing(e.to_string()))?;
                let into = paths::child(&aside, agent).map_err(placing)?;
                std::fs::rename(&to, into).map_err(|e| placing(e.to_string()))?;
            }
            std::fs::rename(&from, &to).map_err(|e| placing(e.to_string()))?;
        }
        paths::sync_dir(&workspaces).map_err(placing)?;
        let images = paths::child(&staging, "images").map_err(placing)?;
        if let Ok(staged) = std::fs::read_dir(&images) {
            for image in staged.filter_map(|e| e.ok()) {
                let name = image.file_name().to_string_lossy().into_owned();
                if !is_sha256(&name) {
                    continue;
                }
                let to = self.images.dir().join(&name);
                if !to.exists() {
                    std::fs::rename(image.path(), to).map_err(|e| placing(e.to_string()))?;
                }
            }
        }
        paths::sync_dir(self.images.dir()).map_err(placing)?;
        let conversations = super::strings(&kept["conversations"]);
        for conversation in &conversations {
            self.forget_activity(conversation);
        }
        self.forget_tree();
        let arrival = kept["arrival"].clone();
        self.store
            .set_setting(
                &format!("{ARRIVED}:{}", entry.agent_id),
                Some(&arrival.to_string()),
            )
            .and_then(|()| {
                self.store
                    .set_move(&entry.id, COMMITTED, &kept.to_string(), self.now_ms())
            })
            .map_err(|e| placing(e.to_string()))?;
        if let Err(error) = paths::remove_child(&data.join("moves"), &entry.id) {
            tracing::warn!(%error, "a moved bot's staging could not be removed");
        }
        self.thaw(&entry.id, &conversations);
        Ok(arrival)
    }
}

/// What needs the person since the bot arrived, as its profile shows it.
fn arrival_json(
    entry: &StoredMove,
    now: &i64,
    arrived: &Arrived,
    outside: &Value,
    manifest: &Value,
) -> Value {
    json!({
        "from": { "host": entry.peer, "name": entry.peer_name },
        "at": now,
        "routines_paused": arrived.routines_paused,
        "webhooks": arrived.webhooks,
        "consent": arrived.consent,
        "endpoints": outside["endpoints"],
        "apps": outside["apps"],
        "plugins": outside["plugins"],
        "left": manifest["left"].as_array().map(|left| left.iter().take(50).cloned().collect::<Vec<_>>()),
    })
}
