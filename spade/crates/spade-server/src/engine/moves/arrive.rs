//! A moved bot arriving (ADR 0187). Its staged files are put together and checked against the
//! move's inventory (every file and image named with its size and hash, the inventory bound to
//! the manifest the move began with): nothing missing, twice or unexpected. Its rows are staged
//! and checked apart, then copied in behind the store's gate, insert-only, each inserted row's
//! key recorded with it (`activating`); then its files are placed and flushed with the rows still
//! hidden (`placing`); then one transaction makes it this machine's: its bots, Spade's host
//! choice and `committed`, which is what the source waits for. A failure takes out exactly what
//! it inserted. A crash mid-copy is undone at the next step or start; one while placing finishes.

use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;
use std::path::{Path, PathBuf};

use base64::Engine as _;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use spade_core::Event;
use spade_core::event::Known;
use spade_store::{Arrived, Begun, Cutover, Handover, Row, Selection, Stage, StoredMove, TableSum};

use super::files::is_sha256;
use super::host::{HostRecord, MAIN_ENABLED, MAIN_HOST, MAIN_OFF, main_active_with};
use super::paths::{self, under};
use super::receive::manifest_agents;
use super::{
    ABORTED, ACTIVATING, ARRIVED, Engine, PLACING, RECEIVING, UNDOING, budget, consent, detail,
};

/// Why a commit didn't end with the bot here.
#[derive(Debug)]
pub(super) enum Failed {
    /// The move doesn't hold up; it is given up here and nothing of it is kept.
    Refused(String),
    /// Its rows are written but its files aren't placed yet: ask again.
    Placing(String),
}

/// A part's rows, or why they can't be read.
type Part = Result<(String, Vec<Row>), String>;

/// The rows of the staged parts, in order: a run of pieces is joined into its one row, of at
/// most `most` bytes.
struct StagedRows {
    parts: std::vec::IntoIter<PathBuf>,
    most: usize,
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
                    let piece = part["text"].as_str().unwrap_or_default();
                    if text.len() + piece.len() > self.most {
                        return Some(Err("a row is larger than a move carries".to_owned()));
                    }
                    text.push_str(piece);
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

/// The setting the person's apps keep each bot's access in (`spade_connect`).
const APP_ACCESS: &str = "connectors.access";

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
    let declared = budget::declared(manifest)?;
    let mut entries = Vec::new();
    for path in parts {
        let part = read_part(path)?;
        if part["kind"] == "inventory" {
            let more = part["entries"].as_array().cloned().unwrap_or_default();
            if (entries.len() + more.len()) as u64 > declared.files {
                return Err("the inventory names more files than the move declared".to_owned());
            }
            entries.extend(more);
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
    let mut total: u64 = 0;
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
        total = total.saturating_add(size);
        if total > declared.file_bytes {
            return Err("the inventory's files are larger than the move declared".to_owned());
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
        let encoded = part["data"].as_str().unwrap_or_default();
        // Decoded, it may not run past the size the inventory gave it.
        let decoded = (encoded.len() as u64 / 4) * 3;
        let most = expected.get(&key).map_or(0, |(size, _)| *size);
        if written.saturating_add(decoded.saturating_sub(2)) > most {
            return Err(format!("{} is larger than the inventory says", key.2));
        }
        let data = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|e| e.to_string())?;
        if written + data.len() as u64 > most {
            return Err(format!("{} is larger than the inventory says", key.2));
        }
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
    /// Writes the staged move here (it reads `receiving`). Answers what needs the person once
    /// the move took, else why not: refused (nothing of it kept, the move given up) or not done
    /// yet (ask again).
    pub(super) fn arrive(&self, entry: &StoredMove) -> Result<Value, Failed> {
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
        // Every folder made for them reaches the disk before anything is placed from it.
        for name in ["files", "images"] {
            paths::sync_tree(&staging.join(name)).map_err(&refuse)?;
        }
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
        // Staged and checked in a database of its own, then copied in batches: Spade's own
        // connection is never held for the whole move (ADR 0170).
        let mut rows = StagedRows {
            parts: parts.clone().into_iter(),
            most: budget::MOST_ROW_BYTES,
        };
        let stage = Stage::create(&staging.join("stage.sqlite"), &agents, entry.main)
            .map_err(|e| refuse(e.to_string()))
            .and_then(|mut stage| {
                for part in rows.by_ref() {
                    let (table, list) = part.map_err(&refuse)?;
                    stage
                        .add(&table, list)
                        .map_err(|e| refuse(e.to_string()))?
                        .map_err(&refuse)?;
                }
                Ok(stage)
            })?;
        let selection = match stage.verify(&expected) {
            Ok(Ok(selection)) => selection,
            Ok(Err(problem)) => return Err(refuse(problem)),
            Err(error) => return Err(refuse(error.to_string())),
        };
        let kinds = stage.kinds().map_err(|e| refuse(e.to_string()))?;
        let routines_paused = stage
            .running_routines()
            .map_err(|e| refuse(e.to_string()))?;
        let mut activating = kept.clone();
        activating["selection"] = json!({
            "agents": selection.agents,
            "conversations": selection.conversations,
            "groups": selection.groups,
        });
        activating["conversations"] = json!(selection.conversations);
        activating["kinds"] = json!(kinds);
        activating["routines_paused"] = json!(routines_paused);
        activating["outside"] = self.outside_needs(manifest, &agents);
        // The gate closes on all it carries, with the move reading `activating`, in one
        // transaction before the first row lands: from here the store finds none of it.
        let begun = self
            .store
            .move_arrive_begin(
                &entry.id,
                &activating.to_string(),
                self.now_ms(),
                &selection,
            )
            .map_err(|e| Failed::Placing(e.to_string()))?;
        match begun {
            Begun::Begun => {}
            Begun::Taken => {
                return Err(refuse(
                    "part of this move is already arriving with another".to_owned(),
                ));
            }
            Begun::NotReceiving => {
                return Err(Failed::Placing(
                    "the move changed while it was checked".to_owned(),
                ));
            }
        }
        let after_batch = || self.after_batch();
        let copied = self.store.move_arrive_copy(
            &entry.id,
            &stage,
            &after_batch,
            &activating.to_string(),
            self.now_ms(),
        );
        match copied {
            Ok(Ok(())) => {}
            Ok(Err(problem)) => return Err(self.abandon(&entry.id, &problem)),
            Err(error) => {
                // What it copied comes out again now; the source's next commit copies afresh.
                self.recover(&entry.id);
                return Err(Failed::Placing(error.to_string()));
            }
        }
        self.at_point("copied");
        let placing = self
            .store
            .stored_move(&entry.id)
            .ok()
            .flatten()
            .ok_or_else(|| Failed::Placing("the move's state can't be read".to_owned()))?;
        self.finish_placing(&placing)
    }

    /// Gives up an arrival whose gate is closed: exactly the rows it inserted come out, its
    /// placed files go, its staging goes, and it reads given up. If taking them out stops
    /// short, the move reads `undoing` and the next step, the sweep or a restart carries on.
    pub(super) fn abandon(&self, id: &str, problem: &str) -> Failed {
        let held = self.store.stored_move(id).ok().flatten();
        let mut kept = held.as_ref().map(detail).unwrap_or_else(|| json!({}));
        kept["problem"] = json!(problem);
        let undone = self.unplace(id).and_then(|()| {
            self.store
                .move_arrive_undo(id, ABORTED, &kept.to_string(), self.now_ms())
                .map_err(|e| e.to_string())
        });
        match undone {
            Ok(_) => {
                if let Err(error) = paths::remove_child(&self.data_dir().join("moves"), id) {
                    tracing::warn!(%error, "a given-up move's staging could not be removed");
                }
            }
            Err(error) => {
                tracing::error!(%error, "a given-up move isn't taken out yet; it carries on later")
            }
        }
        Failed::Refused(problem.to_owned())
    }

    /// Carries on an arrival cut off while its rows were copied in or taken out (it reads
    /// `activating` or `undoing` with nobody working on it): what it inserted comes out, and it
    /// reads `receiving` again, so the source's next commit copies it afresh. A move placing
    /// its files finishes instead. Run under the move's lock.
    pub(super) fn recover(&self, id: &str) {
        let Ok(Some(entry)) = self.store.stored_move(id) else {
            return;
        };
        match entry.state.as_str() {
            ACTIVATING | UNDOING => {
                let undone = self.unplace(id).and_then(|()| {
                    self.store
                        .move_arrive_undo(id, RECEIVING, &entry.detail, self.now_ms())
                        .map_err(|e| e.to_string())
                });
                if let Err(error) = undone {
                    tracing::error!(%error, "a cut-off move's rows could not be taken out yet");
                }
            }
            PLACING => {
                if let Err(error) = self.finish_placing(&entry) {
                    tracing::warn!(?error, "a moved bot's files could not be placed yet");
                }
            }
            _ => {}
        }
    }

    /// Tells a test the point an arrival reached.
    fn at_point(&self, point: &str) {
        #[cfg(feature = "test-hooks")]
        {
            let hold = super::lock(&self.moves.at_point).clone();
            if let Some(hold) = hold {
                hold(point);
            }
        }
        let _ = point;
    }

    /// Lets a test hold an arrival between its batches.
    fn after_batch(&self) {
        #[cfg(feature = "test-hooks")]
        {
            let hold = super::lock(&self.moves.after_batch).clone();
            if let Some(hold) = hold {
                hold();
            }
        }
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

    /// Puts the staged files in place (each step can run again) and flushes them, with the rows
    /// still behind the gate; then the one transaction that makes the move this machine's: its
    /// bots, Spade's host choice and `committed`, together. Answers what needs the person.
    pub(super) fn finish_placing(&self, entry: &StoredMove) -> Result<Value, Failed> {
        let kept = detail(entry);
        let placing = |problem: String| Failed::Placing(problem);
        self.place(entry).map_err(placing)?;
        let list = |name: &str| super::strings(&kept["selection"][name]);
        let selection = Selection {
            agents: list("agents"),
            conversations: list("conversations"),
            groups: list("groups"),
        };
        let kinds: Vec<(String, String)> =
            serde_json::from_value(kept["kinds"].clone()).unwrap_or_default();
        let secret = self.routines_shared().new_secret();
        let security_key = |agent: &str| crate::security::settings::key(agent);
        let marker = Event::Known(Known::Arrived {
            from: entry.peer_name.clone(),
        });
        let here = self.here();
        let main_active =
            |read: &dyn Fn(&str) -> Option<String>| main_active_with(read, here.as_deref());
        // Spade's new host choice is made here, only from the choice the accepted manifest began
        // with: it names this machine, the move's accepted destination, exactly one version on.
        // One held here newer than that was chosen since: the move is stale and refused.
        let began = HostRecord::parse(&kept["manifest"]["host"]);
        let to = kept["to"].as_str().unwrap_or_default().to_owned();
        let now = self.now_ms();
        let chosen = std::cell::RefCell::new(None::<HostRecord>);
        let record = |held: Option<&str>| {
            let held = held
                .and_then(|t| serde_json::from_str::<Value>(t).ok())
                .and_then(|v| HostRecord::parse(&v));
            if let Some(held) = &held
                && began.as_ref().is_none_or(|began| held.newer_than(began))
            {
                return None;
            }
            let version = began.as_ref().map_or(0, |r| r.version) + 1;
            let record = HostRecord {
                host: to.clone(),
                version,
                at: now,
                by: "move".to_owned(),
            };
            let text = record.to_json().to_string();
            *chosen.borrow_mut() = Some(record);
            Some(text)
        };
        let manifest = &kept["manifest"];
        let outside = kept["outside"].clone();
        let answer = std::cell::RefCell::new(Value::Null);
        let arrival = |arrived: &Arrived| {
            let shown = arrival_json(entry, now, arrived, &outside, manifest);
            let mut committed = kept.clone();
            committed["arrival"] = shown.clone();
            committed["host"] = chosen
                .borrow()
                .as_ref()
                .map_or(Value::Null, HostRecord::to_json);
            *answer.borrow_mut() = shown.clone();
            (
                format!("{ARRIVED}:{}", entry.agent_id),
                shown.to_string(),
                committed.to_string(),
            )
        };
        // Its apps start at none, before it can be anyone's: in the hub (which keeps the whole
        // map), and the same in the cutover's own transaction, so no path publishes it with more.
        if let Some(grants) = self.connector_grants() {
            for agent in &selection.agents {
                grants.grant(agent, BTreeSet::new()).map_err(placing)?;
            }
        }
        let none =
            serde_json::to_value(spade_connect::Access::Only(BTreeSet::new())).unwrap_or_default();
        let deny = |held: Option<&str>| {
            let mut access: serde_json::Map<String, Value> = held
                .and_then(|text| serde_json::from_str(text).ok())
                .unwrap_or_default();
            for agent in &selection.agents {
                access.insert(agent.clone(), none.clone());
            }
            Value::Object(access).to_string()
        };
        let merges: [spade_store::Merge<'_>; 1] = [(APP_ACCESS, &deny)];
        self.at_point("placed");
        let cutover = Cutover {
            move_id: &entry.id,
            now_ms: now,
            selection: &selection,
            kinds: &kinds,
            routines_paused: kept["routines_paused"].as_u64().unwrap_or(0),
            from: &entry.peer,
            secret: &secret,
            security_key: &security_key,
            reset: &consent::reset,
            marker: &marker,
            main: entry.main.then_some(Handover {
                active: &main_active,
                key: MAIN_HOST,
                record: &record,
                clear: &[MAIN_ENABLED, MAIN_OFF],
            }),
            arrival: &arrival,
            merges: &merges,
        };
        match self.store.move_arrive_cutover(&cutover) {
            Ok(Ok(_)) => {}
            Ok(Err(problem)) => return Err(self.abandon(&entry.id, &problem)),
            Err(error) => return Err(placing(error.to_string())),
        }
        self.at_point("committed");
        for conversation in &selection.conversations {
            self.forget_activity(conversation);
        }
        self.forget_tree();
        if let Err(error) = self.store.move_arrive_forget(&entry.id) {
            tracing::warn!(%error, "a moved bot's record of its rows could not be forgotten yet");
        }
        if let Err(error) = paths::remove_child(&self.data_dir().join("moves"), &entry.id) {
            tracing::warn!(%error, "a moved bot's staging could not be removed");
        }
        Ok(answer.into_inner())
    }

    /// Puts the staged workspace folders and images in place, each step recorded durably before
    /// it is done (`move_file_record`), so undoing puts back exactly what was placed; then every
    /// folder a rename touched is flushed. A folder already where a bot's goes (of no bot here:
    /// its id is new here) is set aside in the archive, never removed. An image this machine
    /// already had stays its own. Each step can run again.
    fn place(&self, entry: &StoredMove) -> Result<(), String> {
        let id = &entry.id;
        let data = self.data_dir();
        let staging = self
            .moves_dir(id)
            .and_then(|folder| paths::child(&folder, "in"))?;
        let agents = manifest_agents(&detail(entry)["manifest"]).unwrap_or_default();
        let journal: BTreeSet<(String, String)> = self
            .store
            .move_files_of(id)
            .map_err(|e| e.to_string())?
            .into_iter()
            .collect();
        let has = |kind: &str, name: &str| journal.contains(&(kind.to_owned(), name.to_owned()));
        let record = |kind: &str, name: &str| {
            self.store
                .move_file_record(id, kind, name)
                .map_err(|e| e.to_string())
        };
        let workspaces = data.join("workspace");
        std::fs::create_dir_all(&workspaces).map_err(|e| e.to_string())?;
        let files = paths::child(&staging, "files")?;
        let aside = paths::child(&data.join("moved"), id)
            .and_then(|archive| paths::child(&archive, "replaced"))?;
        for agent in &agents {
            let from = paths::child(&files, agent)?;
            if !from.exists() {
                // None came, or it is in place already.
                continue;
            }
            let to = paths::child(&workspaces, agent)?;
            if to.exists() && !has("workspace", agent) {
                std::fs::create_dir_all(&aside).map_err(|e| e.to_string())?;
                record("aside", agent)?;
                std::fs::rename(&to, paths::child(&aside, agent)?).map_err(|e| e.to_string())?;
                paths::sync_dir(&aside)?;
                paths::sync_dir(aside.parent().unwrap_or(&aside))?;
            }
            record("workspace", agent)?;
            std::fs::rename(&from, &to).map_err(|e| e.to_string())?;
        }
        paths::sync_dir(&workspaces)?;
        // A move that brought no files or images made no folder for them.
        let flush = |dir: &std::path::Path| {
            if dir.is_dir() {
                paths::sync_dir(dir)
            } else {
                Ok(())
            }
        };
        flush(&files)?;
        let images = paths::child(&staging, "images")?;
        if let Ok(staged) = std::fs::read_dir(&images) {
            for image in staged.filter_map(|e| e.ok()) {
                let name = image.file_name().to_string_lossy().into_owned();
                if !is_sha256(&name) {
                    continue;
                }
                let to = self.images.dir().join(&name);
                if to.exists() {
                    continue;
                }
                record("image", &name)?;
                std::fs::rename(image.path(), to).map_err(|e| e.to_string())?;
            }
        }
        paths::sync_dir(self.images.dir())?;
        flush(&images)
    }

    /// Puts back what this arrival placed, as recorded and only that: each image it added and
    /// each workspace folder goes back into its staging, each folder it set aside returns; each
    /// record goes only once that is on disk. The move's rows and gate stay until none is left.
    fn unplace(&self, id: &str) -> Result<(), String> {
        let data = self.data_dir();
        let staging = self
            .moves_dir(id)
            .and_then(|folder| paths::child(&folder, "in"))?;
        let files = paths::child(&staging, "files")?;
        let images = paths::child(&staging, "images")?;
        let workspaces = data.join("workspace");
        let aside = paths::child(&data.join("moved"), id)
            .and_then(|archive| paths::child(&archive, "replaced"))?;
        let journal = self.store.move_files_of(id).map_err(|e| e.to_string())?;
        // Placed ones first, then what was set aside, into the places they free.
        let order = |kind: &str| match kind {
            "aside" => 1,
            _ => 0,
        };
        let mut journal = journal;
        journal.sort_by_key(|(kind, _)| order(kind));
        for (kind, name) in journal {
            let (placed, back) = match kind.as_str() {
                "workspace" => (
                    paths::child(&workspaces, &name)?,
                    paths::child(&files, &name)?,
                ),
                "image" if is_sha256(&name) => (self.images.dir().join(&name), images.join(&name)),
                "aside" => (
                    paths::child(&aside, &name)?,
                    paths::child(&workspaces, &name)?,
                ),
                _ => continue,
            };
            // Recorded before it was done: if it never was, there is nothing to put back.
            if placed.exists() && !back.exists() {
                if let Some(parent) = back.parent() {
                    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                std::fs::rename(&placed, &back).map_err(|e| e.to_string())?;
                for dir in [placed.parent(), back.parent()].into_iter().flatten() {
                    paths::sync_dir(dir)?;
                }
            }
            self.store
                .move_file_reverted(id, &kind, &name)
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}

/// What needs the person since the bot arrived, as its profile shows it.
fn arrival_json(
    entry: &StoredMove,
    now: i64,
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

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::path::PathBuf;

    use base64::Engine as _;
    use serde_json::{Value, json};
    use sha2::{Digest, Sha256};

    use super::{StagedRows, assemble, inventory};

    fn parts(dir: &std::path::Path, parts: &[Value]) -> Vec<PathBuf> {
        parts
            .iter()
            .enumerate()
            .map(|(i, part)| {
                let path = dir.join(format!("{i:06}.json"));
                std::fs::write(&path, part.to_string()).unwrap_or_else(|e| panic!("{e}"));
                path
            })
            .collect()
    }

    fn hex(bytes: &[u8]) -> String {
        Sha256::digest(bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }

    #[test]
    fn a_row_joined_from_pieces_past_its_limit_is_refused_before_it_grows_further() {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let piece = |last: bool| json!({ "kind": "piece", "table": "events", "text": "x".repeat(40), "last": last });
        let staged = parts(dir.path(), &[piece(false), piece(false), piece(true)]);
        let mut rows = StagedRows {
            parts: staged.into_iter(),
            most: 100,
        };
        assert!(rows.next().is_some_and(|row| row.is_err()));
    }

    fn manifest(entries: &[Value], count: u64, bytes: u64) -> Value {
        json!({
            "parts": 1, "bytes": 1,
            "inventory": {
                "count": count, "bytes": bytes,
                "sha256": hex(Value::Array(entries.to_vec()).to_string().as_bytes()),
            },
        })
    }

    #[test]
    fn an_inventory_past_what_the_move_declared_is_refused() {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let entry = |path: &str, size: u64| json!({ "kind": "file", "agent": "a_1", "path": path, "size": size, "sha256": "0".repeat(64) });
        let entries = [entry("a.md", 10), entry("b.md", 10)];
        let staged = parts(
            dir.path(),
            &[json!({ "kind": "inventory", "entries": entries })],
        );
        let agents = ["a_1".to_owned()];
        assert!(inventory(&staged, &manifest(&entries, 2, 20), &agents).is_ok());
        // More files than declared, or larger together than declared.
        assert!(inventory(&staged, &manifest(&entries, 1, 20), &agents).is_err());
        assert!(inventory(&staged, &manifest(&entries, 2, 19), &agents).is_err());
    }

    #[test]
    fn a_file_larger_than_its_inventory_says_is_refused_before_it_is_written() {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let data = vec![7u8; 4096];
        let staged = parts(
            dir.path(),
            &[json!({
                "kind": "file", "agent": "a_1", "path": "big.bin", "offset": 0, "last": true,
                "data": base64::engine::general_purpose::STANDARD.encode(&data),
            })],
        );
        let staging = dir.path().join("in");
        std::fs::create_dir_all(&staging).unwrap_or_else(|e| panic!("{e}"));
        let mut expected = BTreeMap::new();
        let key = ("file".to_owned(), "a_1".to_owned(), "big.bin".to_owned());
        expected.insert(key.clone(), (16, hex(&data)));
        let refused = assemble(&staging, &staged, &expected);
        assert!(refused.is_err_and(|why| why.contains("larger")));
        assert!(
            !staging.join("files/a_1/big.bin").exists(),
            "nothing was written"
        );
        expected.insert(key, (4096, hex(&data)));
        assert_eq!(assemble(&staging, &staged, &expected), Ok(()));
    }
}
