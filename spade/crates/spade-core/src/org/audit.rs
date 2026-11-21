//! The org host's audit log (ADR 0206 §4.2): each entry carries the SHA-256 of the one before,
//! and the host signs a checkpoint over the chain's head every [`CHECKPOINT_EVERY`] entries or
//! [`CHECKPOINT_MS`], whichever comes first. A rewrite of anything a checkpoint covers no longer
//! matches its signature. Metadata holds digests and names, never content.
//!
//! An export is JSON Lines: one `header`, then `entry` and `checkpoint` lines in chain order.
//! [`verify`] checks one offline against the host's registered audit key.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

/// A checkpoint is signed after this many entries since the last one...
pub const CHECKPOINT_EVERY: i64 = 100;
/// ...or once the oldest entry it would cover is this old.
pub const CHECKPOINT_MS: i64 = 5 * 60_000;

/// The hash before the first entry.
pub const GENESIS: &str = "0000000000000000000000000000000000000000000000000000000000000000";

/// What an entry names: an actor or a target (`{type: "bot", id: "a_1", name: "CI watcher"}`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ref {
    #[serde(rename = "type")]
    pub kind: String,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

impl Ref {
    pub fn new(kind: &str, id: &str) -> Self {
        Self {
            kind: kind.to_owned(),
            id: id.to_owned(),
            name: None,
        }
    }

    #[must_use]
    pub fn named(mut self, name: &str) -> Self {
        self.name = Some(name.to_owned());
        self
    }
}

/// One entry, as the backend's audit route takes it (`AceOrgAuditEntry` without its hash).
/// Field order and the metadata's sorted keys make its JSON the same on every machine.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub action: String,
    pub occurred_at: i64,
    pub actor: Ref,
    pub targets: Vec<Ref>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub metadata: BTreeMap<String, Value>,
}

impl Entry {
    pub fn new(action: &str, occurred_at: i64, actor: Ref, targets: Vec<Ref>) -> Self {
        Self {
            action: action.to_owned(),
            occurred_at,
            actor,
            targets,
            metadata: BTreeMap::new(),
        }
    }

    /// With `key` set to `value` (a digest, a name, a number), within WorkOS's limits: keys of at
    /// most 40 characters, values of at most 500.
    #[must_use]
    pub fn with(mut self, key: &str, value: impl Into<Value>) -> Self {
        let value = match value.into() {
            Value::String(text) => Value::String(text.chars().take(500).collect()),
            value @ (Value::Number(_) | Value::Bool(_)) => value,
            other => Value::String(other.to_string().chars().take(500).collect()),
        };
        self.metadata.insert(key.chars().take(40).collect(), value);
        self
    }
}

/// An entry in the chain.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Chained {
    /// Its place in the host's log, from 1.
    pub seq: i64,
    /// The hash of the entry before it ([`GENESIS`] for the first).
    pub prev: String,
    pub hash: String,
    #[serde(flatten)]
    pub entry: Entry,
}

/// The hash of `entry` following `prev`: hex SHA-256 over a version line, `prev` and the entry's
/// JSON.
pub fn hash(prev: &str, entry: &Entry) -> String {
    let body = serde_json::to_string(entry).unwrap_or_default();
    hex(&Sha256::digest(
        format!("spade-org-audit/1\n{prev}\n{body}").as_bytes(),
    ))
}

/// A signed statement over the chain's head.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Checkpoint {
    /// How many entries it covers: the chain up to and including entry `count`.
    pub count: i64,
    /// The hash of entry `count`.
    pub head: String,
    pub at: i64,
    /// Ed25519 over [`checkpoint_message`], base64url.
    pub signature: String,
}

/// What a checkpoint's signature is made over: the organization and host it is for, the count,
/// the head and the time.
pub fn checkpoint_message(org: &str, host: &str, count: i64, head: &str, at: i64) -> Vec<u8> {
    format!("spade-org-audit-checkpoint/1\n{org}\n{host}\n{count}\n{head}\n{at}").into_bytes()
}

/// Whether a checkpoint is due: entries since the last one reach [`CHECKPOINT_EVERY`], or the
/// oldest of them is [`CHECKPOINT_MS`] old.
pub fn checkpoint_due(unsigned: i64, oldest_unsigned_at: Option<i64>, now_ms: i64) -> bool {
    unsigned >= CHECKPOINT_EVERY
        || (unsigned > 0 && oldest_unsigned_at.is_some_and(|at| now_ms - at >= CHECKPOINT_MS))
}

/// One line of an export.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Line {
    Header {
        org: String,
        host: String,
        /// The host's audit key, base64url, as the export says it: [`verify`] checks against
        /// the key it is given, never this one.
        key: String,
    },
    Entry(Chained),
    Checkpoint(Checkpoint),
}

/// What a verified export holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Verified {
    pub entries: usize,
    pub checkpoints: usize,
    /// Entries after the last checkpoint: what the host vouches for only by its chain.
    pub unsigned: usize,
}

/// Why an export doesn't verify, at which line (from 1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Broken {
    pub line: usize,
    pub why: &'static str,
}

/// Checks an export: every entry's hash, every link to the one before, and every checkpoint's
/// head and signature (`signed`: whether a signature over a message is the host's, with the key
/// the caller registered). An export of a range starts mid-chain: its first entry's `prev` is
/// taken as given, and a checkpoint for an entry outside the range is checked by signature only.
pub fn verify(text: &str, signed: &dyn Fn(&[u8], &str) -> bool) -> Result<Verified, Broken> {
    let mut header: Option<(String, String)> = None;
    let mut last: Option<(i64, String)> = None;
    let mut hashes: BTreeMap<i64, String> = BTreeMap::new();
    let mut entries = 0;
    let mut checkpoints = 0;
    let mut last_signed = 0i64;
    for (at, raw) in text.lines().enumerate() {
        let line = at + 1;
        if raw.trim().is_empty() {
            continue;
        }
        let broken = |why| Broken { line, why };
        let parsed: Line = serde_json::from_str(raw).map_err(|_| broken("unreadable line"))?;
        match parsed {
            Line::Header { org, host, .. } => {
                if header.is_some() || entries > 0 {
                    return Err(broken("a second header"));
                }
                header = Some((org, host));
            }
            Line::Entry(chained) => {
                if header.is_none() {
                    return Err(broken("no header before the first entry"));
                }
                if let Some((seq, prev)) = &last {
                    if chained.seq != seq + 1 {
                        return Err(broken("an entry is missing"));
                    }
                    if chained.prev != *prev {
                        return Err(broken("an entry doesn't follow the one before"));
                    }
                } else if chained.seq == 1 && chained.prev != GENESIS {
                    return Err(broken("the first entry doesn't start the chain"));
                }
                if hash(&chained.prev, &chained.entry) != chained.hash {
                    return Err(broken("an entry was changed"));
                }
                hashes.insert(chained.seq, chained.hash.clone());
                last = Some((chained.seq, chained.hash));
                entries += 1;
            }
            Line::Checkpoint(checkpoint) => {
                let Some((org, host)) = &header else {
                    return Err(broken("no header before the first checkpoint"));
                };
                if let Some(head) = hashes.get(&checkpoint.count)
                    && *head != checkpoint.head
                {
                    return Err(broken("the chain doesn't match a checkpoint"));
                }
                if last
                    .as_ref()
                    .is_some_and(|(seq, _)| checkpoint.count > *seq)
                {
                    return Err(broken("a checkpoint covers entries not in the export"));
                }
                let message = checkpoint_message(
                    org,
                    host,
                    checkpoint.count,
                    &checkpoint.head,
                    checkpoint.at,
                );
                if !signed(&message, &checkpoint.signature) {
                    return Err(broken("a checkpoint's signature isn't the host's"));
                }
                last_signed = last_signed.max(checkpoint.count);
                checkpoints += 1;
            }
        }
    }
    if header.is_none() {
        return Err(Broken {
            line: 1,
            why: "not an audit export",
        });
    }
    let unsigned = last
        .map(|(seq, _)| usize::try_from(seq - last_signed).unwrap_or(0).min(entries))
        .unwrap_or(0);
    Ok(Verified {
        entries,
        checkpoints,
        unsigned,
    })
}

/// Hex SHA-256 of `bytes`, as `args_sha256` names a call's arguments.
pub fn digest(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
