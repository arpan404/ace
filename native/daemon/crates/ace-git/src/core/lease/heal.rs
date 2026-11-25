// SPDX-License-Identifier: Apache-2.0
//! Self-healing: retire what is stale, then remove Git locks no live process
//! holds (`healRepository`/`healRepositories` in `lease-admission.ts`).

use std::collections::HashSet;

use crate::core::error::GitError;
use crate::core::lease::admission::mutation_state;
use crate::core::lease::locks::{LOCK_GRACE_MS, clear_leftover_locks, git_common_directory};
use crate::core::lease::{LeasePorts, LeaseRegistry, Scan};

/// One checkout: retire stale intents, then remove the locks their processes left.
pub async fn heal_repository(
    path: &str,
    ports: &dyn LeasePorts,
    registry: &LeaseRegistry,
    grace_ms: i64,
) -> Result<Vec<String>, GitError> {
    mutation_state(path, ports, registry).await?;
    if !ports.has_evidence() {
        return Ok(Vec::new());
    }
    let before = ports.now_ms().await - grace_ms;
    clear_leftover_locks(path, &Scan::new(ports), before).await
}

/// The periodic sweep over many checkouts: one process listing for the whole
/// sweep (taken only when some lock is old enough) and each repository's locks
/// cleared once, however many of its worktrees are listed.
pub async fn heal_repositories(
    paths: &[String],
    ports: &dyn LeasePorts,
    registry: &LeaseRegistry,
    failed: &mut (dyn FnMut(&str, &GitError) + Send),
    grace_ms: i64,
) -> Result<Vec<String>, GitError> {
    let evidence = ports.has_evidence();
    let before = if evidence {
        Some(ports.now_ms().await - grace_ms)
    } else {
        None
    };
    let scan = Scan::new(ports);
    let mut cleared: HashSet<String> = HashSet::new();
    let mut removed = Vec::new();
    for path in paths {
        let healed = async {
            mutation_state(path, ports, registry).await?;
            let Some(before) = before else {
                return Ok(Vec::new());
            };
            let Some(common) = git_common_directory(path) else {
                return Ok(Vec::new());
            };
            if !cleared.insert(common) {
                return Ok(Vec::new());
            }
            clear_leftover_locks(path, &scan, before).await
        }
        .await;
        match healed {
            Ok(found) => removed.extend(found),
            Err(error) => failed(path, &error),
        }
    }
    Ok(removed)
}

/// The default grace a sweep gives a Git command that is just starting.
pub const HEAL_GRACE_MS: i64 = 60_000;

/// `LOCK_GRACE_MS` is the lock-specific grace; the sweep's is wider.
pub const SWEEP_GRACE_MS: i64 = if HEAL_GRACE_MS > LOCK_GRACE_MS {
    HEAL_GRACE_MS
} else {
    LOCK_GRACE_MS
};
