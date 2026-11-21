//! Writing a frozen bot out as a move's parts (ADR 0187): its rows table by table, the images
//! its conversations show and its panels' pages, then its workspace files in pieces, each part one JSON file of at
//! most `PART_BYTES`, and last the manifest that counts and hashes all of it. Packing again
//! after a restart starts over; once the manifest is written the parts never change.

use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};

use base64::Engine as _;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use spade_store::{BOT_PANELS, MOVE_TABLES, Row, RowSums, StoredMove};

use super::budget;
use super::files;
use super::paths;
use super::{Engine, FORMAT, VERSION, detail, strings};
use crate::packages::panels;

/// Most bytes of one part's JSON: with the request around it, well inside the 512 KiB an inbox
/// request may carry.
pub(super) const PART_BYTES: usize = 384 * 1024;
/// Raw bytes of a file per part; base64 makes them a third larger.
const FILE_PIECE: usize = 256 * 1024;
/// Writes parts `000000.json`, `000001.json`, … into one folder.
struct Parts {
    dir: PathBuf,
    next: u64,
    table: String,
    rows: Vec<Row>,
    bytes: usize,
    /// Bytes of every part written, for the manifest and the move's limit.
    total: u64,
}

impl Parts {
    fn write(&mut self, part: &Value) -> Result<(), String> {
        let path = self.dir.join(format!("{:06}.json", self.next));
        let text = part.to_string();
        self.total += text.len() as u64;
        self.next += 1;
        budget::within(budget::Declared {
            parts: self.next,
            bytes: self.total,
            files: 0,
            file_bytes: 0,
        })?;
        std::fs::write(&path, text).map_err(|e| e.to_string())
    }

    fn flush(&mut self) -> Result<(), String> {
        if self.rows.is_empty() {
            return Ok(());
        }
        let rows = std::mem::take(&mut self.rows);
        self.bytes = 0;
        self.write(&json!({ "kind": "rows", "table": self.table, "rows": rows }))
    }

    fn row(&mut self, table: &str, row: Row) -> Result<(), String> {
        let text = Value::Object(row.clone()).to_string();
        if text.len() > budget::MOST_ROW_BYTES {
            return Err(format!("a row of {table} is larger than a move carries"));
        }
        if text.len() > PART_BYTES - 1024 {
            // One row larger than a part goes as pieces of its text, joined there.
            self.flush()?;
            let mut rest = text.as_str();
            while !rest.is_empty() {
                let mut cut = rest.len().min(PART_BYTES - 1024);
                while !rest.is_char_boundary(cut) {
                    cut -= 1;
                }
                let (piece, after) = rest.split_at(cut);
                rest = after;
                self.write(&json!({
                    "kind": "piece", "table": table, "text": piece, "last": rest.is_empty(),
                }))?;
            }
            return Ok(());
        }
        if self.table != table || self.bytes + text.len() > PART_BYTES - 1024 {
            self.flush()?;
            table.clone_into(&mut self.table);
        }
        self.bytes += text.len() + 1;
        self.rows.push(row);
        Ok(())
    }

    /// A file in pieces, at most `size` bytes (its size when the preflight read it); answers its
    /// size and SHA-256 for the inventory.
    fn file(&mut self, head: Value, full: &Path, size: u64) -> Result<(u64, String), String> {
        let file = std::fs::File::open(full).map_err(|e| e.to_string())?;
        self.bytes_of(head, file, &full.display().to_string(), size)
    }

    /// What `file` reads (named `name` in a refusal), in pieces, as [`Parts::file`] does.
    fn bytes_of(
        &mut self,
        head: Value,
        mut file: impl Read,
        name: &str,
        size: u64,
    ) -> Result<(u64, String), String> {
        let mut digest = Sha256::new();
        let mut buffer = vec![0u8; FILE_PIECE];
        let mut offset: u64 = 0;
        loop {
            let mut filled = 0;
            while filled < FILE_PIECE {
                match file
                    .read(&mut buffer[filled..])
                    .map_err(|e| e.to_string())?
                {
                    0 => break,
                    read => filled += read,
                }
            }
            let piece = &buffer[..filled];
            if offset + filled as u64 > size {
                return Err(format!("{name} grew while it was being packed"));
            }
            digest.update(piece);
            let last = filled < FILE_PIECE;
            let mut part = head.clone();
            part["offset"] = json!(offset);
            part["data"] = json!(base64::engine::general_purpose::STANDARD.encode(piece));
            part["last"] = json!(last);
            offset += filled as u64;
            self.write(&part)?;
            if last {
                return Ok((offset, hex(&digest.clone().finalize())));
            }
        }
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Endpoint ids a model string (`endpoint/model`, or a role map's values) names.
fn endpoints_of(model: &str, into: &mut Vec<String>) {
    if model.starts_with("cli:") {
        return;
    }
    if let Some((endpoint, _)) = model.split_once('/')
        && !endpoint.is_empty()
        && !into.iter().any(|known| known == endpoint)
    {
        into.push(endpoint.to_owned());
    }
}

impl Engine {
    /// The move's folder of parts and its manifest, written once.
    pub(super) fn packed(&self, id: &str) -> Result<PathBuf, String> {
        paths::child(&self.moves_dir(id)?, "out")
    }

    /// Writes the move's parts and manifest (on a blocking thread). Answers the manifest.
    pub(super) fn pack(&self, entry: &StoredMove) -> Result<Value, String> {
        let out = self.packed(&entry.id)?;
        if let Ok(text) = std::fs::read_to_string(out.join("manifest.json")) {
            return serde_json::from_str(&text).map_err(|e| e.to_string());
        }
        let folder = self.moves_dir(&entry.id)?;
        paths::remove_child(&folder, "out-tmp")?;
        let tmp = paths::child(&folder, "out-tmp")?;
        std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
        let kept = detail(entry);
        let agents = strings(&kept["agents"]);
        if let Some(odd) = agents.iter().find(|agent| !paths::plain_id(agent)) {
            return Err(format!("the bot {odd} has an id Spade can't move"));
        }
        let selection = self
            .store
            .move_selection(&agents)
            .map_err(|e| e.to_string())?;
        // Every file's size first: a move larger than it may be is refused before one is read.
        let workspaces = self.data_dir().join("workspace");
        let mut walks = Vec::new();
        for agent in &agents {
            let root = paths::child(&workspaces, agent)?;
            walks.push((
                agent.clone(),
                files::walk(&root).map_err(|e| e.to_string())?,
            ));
        }
        let sizes: Vec<u64> = walks
            .iter()
            .flat_map(|(_, walked)| walked.files.iter())
            .map(|found| std::fs::metadata(&found.full).map_or(0, |m| m.len()))
            .collect();
        budget::preflight(sizes.iter().copied(), budget::MOST_FILE_BYTES)?;
        let mut parts = Parts {
            dir: tmp.clone(),
            next: 0,
            table: String::new(),
            rows: Vec::new(),
            bytes: 0,
            total: 0,
        };
        let mut sums = BTreeMap::new();
        let mut images = Vec::new();
        let mut pages = Vec::new();
        let mut models = Vec::new();
        // Read a page at a time: Spade's connection is held for one page, never a table.
        for table in MOVE_TABLES {
            let mut sum = RowSums::default();
            let mut cursor = None;
            loop {
                let (page, next) = self
                    .store
                    .move_page(table, &selection, &cursor)
                    .map_err(|e| e.to_string())?;
                for row in page {
                    if table.paged()
                        && let Some(body) = row["body"].as_str()
                    {
                        files::image_refs(body, &mut images);
                    }
                    if table.name == "agents" {
                        files::image_refs(row["avatar"].as_str().unwrap_or(""), &mut images);
                        endpoints_of(row["model"].as_str().unwrap_or(""), &mut models);
                    }
                    if table.name == "settings"
                        && row["key"]
                            .as_str()
                            .is_some_and(|k| k.starts_with(&format!("{BOT_PANELS}:")))
                    {
                        for hash in panels::named_in(row["value"].as_str().unwrap_or("")) {
                            if !pages.contains(&hash) {
                                pages.push(hash);
                            }
                        }
                    }
                    if table.name == "settings"
                        && row["key"]
                            .as_str()
                            .is_some_and(|k| k.starts_with("model_roles:"))
                        && let Some(roles) = row["value"]
                            .as_str()
                            .and_then(|text| serde_json::from_str::<Value>(text).ok())
                    {
                        for model in roles.to_string().split('"') {
                            if model.contains('/') {
                                endpoints_of(model, &mut models);
                            }
                        }
                    }
                    sum.add(&row);
                    parts.row(table.name, row)?;
                }
                match next {
                    Some(next) => cursor = Some(next),
                    None => break,
                }
            }
            let sum = sum.finish();
            sums.insert(
                table.name.to_owned(),
                json!({ "rows": sum.rows, "hash": sum.hash }),
            );
        }
        parts.flush()?;
        // Every file and image, with its size and hash: what the other machine must end up with,
        // exactly.
        let mut inventory = Vec::new();
        for sha in &images {
            let path = self.images.dir().join(sha);
            if path.is_file() {
                let most = std::fs::metadata(&path).map_or(0, |m| m.len());
                let (size, hash) =
                    parts.file(json!({ "kind": "image", "sha256_name": sha }), &path, most)?;
                inventory
                    .push(json!({ "kind": "image", "name": sha, "size": size, "sha256": hash }));
            }
        }
        // Its panels' pages, by hash beside its images (ADR 0200 §5.2), so they show the moment
        // it arrives. A page this machine no longer keeps isn't named.
        for hash in &pages {
            if let Some(html) = panels::page(self, hash) {
                let (size, sha) = parts.bytes_of(
                    json!({ "kind": "page", "sha256_name": hash }),
                    html.as_bytes(),
                    hash,
                    html.len() as u64,
                )?;
                inventory
                    .push(json!({ "kind": "page", "name": hash, "size": size, "sha256": sha }));
            }
        }
        let mut left = Vec::new();
        let mut size_of = sizes.into_iter();
        for (agent, walked) in walks {
            left.extend(walked.left);
            for found in walked.files {
                let most = size_of.next().unwrap_or(0);
                let head = json!({ "kind": "file", "agent": agent, "path": found.path });
                let (size, hash) = parts.file(head, &found.full, most)?;
                inventory.push(json!({
                    "kind": "file", "agent": agent, "path": found.path, "size": size, "sha256": hash,
                }));
            }
        }
        let inventory_sha = hex(&Sha256::digest(Value::Array(inventory.clone()).to_string()));
        let count = inventory.len();
        let bytes: u64 = inventory.iter().filter_map(|e| e["size"].as_u64()).sum();
        let mut chunk = Vec::new();
        let mut chunk_bytes = 0;
        for entry in inventory {
            let size = entry.to_string().len() + 1;
            if chunk_bytes + size > PART_BYTES - 1024 && !chunk.is_empty() {
                parts.write(
                    &json!({ "kind": "inventory", "entries": std::mem::take(&mut chunk) }),
                )?;
                chunk_bytes = 0;
            }
            chunk_bytes += size;
            chunk.push(entry);
        }
        if !chunk.is_empty() {
            parts.write(&json!({ "kind": "inventory", "entries": chunk }))?;
        }
        let endpoints = self.store.endpoints().map_err(|e| e.to_string())?;
        let needs: Vec<Value> = models
            .iter()
            .map(|id| {
                let name = endpoints
                    .iter()
                    .find(|e| &e.id == id)
                    .map_or(id.as_str(), |e| e.name.as_str());
                json!({ "id": id, "name": name })
            })
            .collect();
        let mut extras = kept["extras"].clone();
        if !extras.is_object() {
            extras = json!({});
        }
        // A paused bot's pause goes with it, so it arrives paused (ADR 0200 §6.1).
        if let Some(paused) = self.pauses_to_move(&agents).map_err(|e| e.to_string())? {
            extras["paused"] = paused;
        }
        if let Some(plugins) = self.plugins() {
            extras["plugins"] = agents
                .iter()
                .map(|agent| (agent.clone(), json!(plugins.allowed(agent))))
                .collect::<serde_json::Map<_, _>>()
                .into();
        }
        let manifest = json!({
            "format": FORMAT,
            "version": VERSION,
            "schema": spade_store::Store::schema_version(),
            "move": entry.id,
            "from": kept["from"],
            // A shared bot's organization (ADR 0206): only a host of the same one takes it.
            "bot": {
                "id": entry.agent_id,
                "name": entry.agent_name,
                "main": entry.main,
                "org": match self.agent_space(&entry.agent_id) {
                    spade_core::org::Space::Org(org) => Some(org),
                    spade_core::org::Space::Personal => None,
                },
            },
            "agents": agents,
            "tables": sums,
            "inventory": { "count": count, "bytes": bytes, "sha256": inventory_sha },
            "parts": parts.next,
            "bytes": parts.total,
            "endpoints": needs,
            "extras": extras,
            "left": left,
            // Spade's host choice as the move began: the other machine names itself from it,
            // and refuses the move if the choice changed since.
            "host": if entry.main {
                self.host_record().ok().flatten().map(|r| r.to_json())
            } else {
                None
            },
        });
        // The same limits the other machine holds it to, before anything is sent.
        budget::declared(&manifest)?;
        std::fs::write(tmp.join("manifest.json"), manifest.to_string())
            .map_err(|e| e.to_string())?;
        paths::remove_child(&folder, "out")?;
        std::fs::rename(&tmp, &out).map_err(|e| e.to_string())?;
        Ok(manifest)
    }

    /// One packed part, as sent.
    pub(super) fn packed_part(&self, id: &str, index: u64) -> Result<Value, String> {
        let text = std::fs::read_to_string(self.packed(id)?.join(format!("{index:06}.json")))
            .map_err(|e| e.to_string())?;
        serde_json::from_str(&text).map_err(|e| e.to_string())
    }
}
