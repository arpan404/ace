// SPDX-License-Identifier: Apache-2.0
//! Checkpoint sequence numbers (`packages/git/src/checkpoint-numbers.ts`, G5): the thread's
//! checkpoint refs, the durable counter ref that allocates the next sequence, and the bounded
//! cache in front of it.
//!
//! Compare-and-swap lives in `create_checkpoint` (`checkpoints/snapshot.rs`): it publishes the
//! checkpoint ref and the counter in one `update-ref --stdin` transaction, so a lost race
//! leaves both untouched and the allocator retries. Only completed reads and allocations are
//! cached; an eviction has no Git effect.

use indexmap::IndexMap;

use crate::checkpoints::metadata::{checkpoint_identity, checkpoint_prefix, metadata};
use crate::core::decode::{hash, malformed, nul};
use crate::core::error::{GitError, GitErrorCode};
use crate::reads::{Command, CommandPort, checked, text_output};

/// The counter's bound, as `BoundedCache`'s constructor bounds it.
pub const MIN_CAPACITY: usize = 1;
/// `z.number().int().min(1).max(4096)`.
pub const MAX_CAPACITY: usize = 4_096;
/// The cache's default capacity (`new CheckpointNumbers(cli)`).
pub const DEFAULT_CAPACITY: usize = 128;

/// The thread's durable counter: the commit the counter ref names, or the last sequence
/// before durable counters existed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Counter {
    pub sha: Option<String>,
    pub sequence: u64,
}

/// One checkpoint ref of a thread.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckpointRef {
    pub id: String,
    pub sha: String,
    pub sequence: u64,
}

/// `counterRef`: the ref whose commit names the thread's last sequence.
pub fn counter_ref(thread_id: &str) -> Result<String, GitError> {
    checkpoint_prefix(thread_id)?;
    Ok(format!("refs/ace/checkpoint-sequences/{thread_id}"))
}

/// `checkpointRefs`: every checkpoint ref of the thread, oldest sequence first.
pub async fn checkpoint_refs(
    port: &dyn CommandPort,
    root: &str,
    thread_id: &str,
) -> Result<Vec<CheckpointRef>, GitError> {
    let prefix = checkpoint_prefix(thread_id)?;
    let output = text_output(
        &checked(
            port,
            Command::new(
                root,
                &[
                    "for-each-ref",
                    "--format=%(refname)%00%(objectname)",
                    &prefix,
                ],
            ),
        )
        .await?
        .stdout,
    )?;
    if output.is_empty() {
        return Ok(Vec::new());
    }
    let mut refs = Vec::new();
    for record in output.split('\n') {
        let fields: Vec<&str> = record.split('\0').collect();
        let [id, sha] = fields.as_slice() else {
            return Err(malformed("checkpoint ref record"));
        };
        let (ref_thread, sequence) =
            checkpoint_identity(id).map_err(|_| malformed("checkpoint ref identity"))?;
        if ref_thread != thread_id {
            return Err(malformed("checkpoint ref namespace"));
        }
        refs.push(CheckpointRef {
            id: (*id).to_owned(),
            sha: hash(sha)?,
            sequence,
        });
    }
    // Stable by sequence, as `toSorted` is.
    refs.sort_by_key(|reference| reference.sequence);
    Ok(refs)
}

/// `show --no-show-signature -s --format=%H%x00%B%x00 <ref>`: one counter commit's id and
/// message.
fn counter_record(stdout: &[u8], thread_id: &str) -> Result<Counter, GitError> {
    // `show` adds a newline after the final NUL.
    if stdout.last() != Some(&b'\n') || stdout.len() < 2 || stdout[stdout.len() - 2] != 0 {
        return Err(malformed("checkpoint counter framing"));
    }
    let records = nul(&stdout[..stdout.len() - 1])?;
    let [sha, message] = records.as_slice() else {
        return Err(malformed("checkpoint counter record"));
    };
    let data = metadata(message)?;
    let Some(sequence) = data.sequence else {
        return Err(malformed("checkpoint counter metadata"));
    };
    if data.thread_id != thread_id {
        return Err(malformed("checkpoint counter metadata"));
    }
    Ok(Counter {
        sha: Some(hash(sha)?),
        sequence,
    })
}

/// A `BoundedCache` over `root\0thread`: at most `capacity` counters, least recently used
/// first out. `get` and `remember` move an entry to newest; `forget` is not an eviction.
#[derive(Debug)]
pub struct CounterCache {
    capacity: usize,
    entries: IndexMap<String, Counter>,
}

impl CounterCache {
    /// `BoundedCache(limit, limit)` with a cost of 1 per entry: at most `limit` entries.
    pub fn new(capacity: usize) -> Result<Self, GitError> {
        if !(MIN_CAPACITY..=MAX_CAPACITY).contains(&capacity) {
            return Err(GitError::new(
                GitErrorCode::InvalidArgument,
                "Invalid cache budget",
            ));
        }
        Ok(Self {
            capacity,
            entries: IndexMap::new(),
        })
    }

    pub fn size(&self) -> usize {
        self.entries.len()
    }

    pub fn get(&mut self, key: &str) -> Option<Counter> {
        let value = self.entries.shift_remove(key)?;
        self.entries.insert(key.to_owned(), value.clone());
        Some(value)
    }

    pub fn remember(&mut self, key: String, value: Counter) {
        self.entries.shift_remove(&key);
        self.entries.insert(key, value);
        while self.entries.len() > self.capacity {
            self.entries.shift_remove_index(0);
        }
    }

    pub fn forget(&mut self, key: &str) {
        self.entries.shift_remove(key);
    }
}

/// `CheckpointNumbers`: the counter cache of one Git service.
#[derive(Debug)]
pub struct CheckpointNumbers {
    cache: CounterCache,
}

impl Default for CheckpointNumbers {
    fn default() -> Self {
        Self {
            cache: CounterCache {
                capacity: DEFAULT_CAPACITY,
                entries: IndexMap::new(),
            },
        }
    }
}

impl CheckpointNumbers {
    pub fn new(capacity: usize) -> Result<Self, GitError> {
        Ok(Self {
            cache: CounterCache::new(capacity)?,
        })
    }

    pub fn size(&self) -> usize {
        self.cache.size()
    }

    fn key(root: &str, thread_id: &str) -> String {
        format!("{root}\0{thread_id}")
    }

    /// `get`: the cached counter, or a fresh read.
    pub async fn get(
        &mut self,
        port: &dyn CommandPort,
        root: &str,
        thread_id: &str,
    ) -> Result<Counter, GitError> {
        if let Some(value) = self.cache.get(&Self::key(root, thread_id)) {
            return Ok(value);
        }
        self.refresh(port, root, thread_id).await
    }

    /// `remember`: a completed read or allocation.
    pub fn remember(&mut self, root: &str, thread_id: &str, value: Counter) {
        self.cache.remember(Self::key(root, thread_id), value);
    }

    /// `forget`: the thread was deleted.
    pub fn forget(&mut self, root: &str, thread_id: &str) {
        self.cache.forget(&Self::key(root, thread_id));
    }

    /// `refresh`: the counter ref's commit, or the one-time migration from a thread whose
    /// checkpoints were written before durable counters existed.
    pub async fn refresh(
        &mut self,
        port: &dyn CommandPort,
        root: &str,
        thread_id: &str,
    ) -> Result<Counter, GitError> {
        let reference = counter_ref(thread_id)?;
        let output = checked(
            port,
            Command::new(
                root,
                &[
                    "show",
                    "--no-show-signature",
                    "-s",
                    "--format=%H%x00%B%x00",
                    &reference,
                ],
            )
            .allowing_failure(),
        )
        .await?;
        let value = if output.exit_code == 0 {
            counter_record(&output.stdout, thread_id)?
        } else {
            let refs = checkpoint_refs(port, root, thread_id).await?;
            Counter {
                sha: None,
                sequence: refs.last().map_or(0, |reference| reference.sequence),
            }
        };
        self.remember(root, thread_id, value.clone());
        Ok(value)
    }
}

#[cfg(test)]
mod tests;
