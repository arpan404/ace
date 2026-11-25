// SPDX-License-Identifier: Apache-2.0
//! Lease admission: which intents still fence a checkout, which retire, and
//! what a caller is told when they must wait (`packages/git/src/lease-admission.ts`).

use std::collections::HashSet;

use ace_json::{JsString, Map, Value};

use crate::core::error::{GitError, GitErrorCode};
use crate::core::lease::journal::{
    JournalEntry, LeaseRecord, LeaseRegistry, records, sync_directory, text,
};
use crate::core::lease::locks::{LOCK_GRACE_MS, clear_leftover_locks};
use crate::core::lease::owner::{owned_by_this_process, query_lease_owner};
use crate::core::lease::processes::touches;
use crate::core::lease::roots::{journal_repository, root_kind};
use crate::core::lease::state::{
    LeaseFacts, LeaseOwnerState, MutationState, RootKind, clears_on_its_own, fences, lease_state,
    quarantine_message, retires_automatically, retires_on_confirmation,
};
use crate::core::lease::{LeasePorts, LocalLease, POLL_MS, RetiredLease, Scan};

/// One assessed intent: its facts plus the file that holds it.
#[derive(Debug, Clone)]
pub struct Assessed {
    pub facts: LeaseFacts,
    pub file: String,
}

/// Who may still be doing this lease's work, from evidence this process can trust.
async fn busy(
    owner: LeaseOwnerState,
    local: &LocalLease,
    record: &LeaseRecord,
    scan: &Scan<'_>,
    ports: &dyn LeasePorts,
) -> Option<Vec<String>> {
    if !ports.has_evidence() {
        return None;
    }
    if owner == LeaseOwnerState::Held && local.present {
        let groups = local.groups.as_ref()?;
        if !local.done {
            return Some(vec!["the ace operation that started it".to_owned()]);
        }
        let mut held = Vec::new();
        for pid in groups {
            if ports.group_alive(*pid).await {
                held.push(format!("a stopped Git process (process group {pid})"));
            }
        }
        return Some(held);
    }
    if !matches!(owner, LeaseOwnerState::Gone | LeaseOwnerState::Orphaned) {
        return None;
    }
    let listing = scan.get().await?;
    let mut roots = Vec::with_capacity(record.roots.len());
    for root in &record.roots {
        roots.push(crate::core::paths::canonical(root).unwrap_or_else(|_| root.clone()));
    }
    let earlier = if owner == LeaseOwnerState::Gone {
        ports.running_when_gone(record, &listing).await
    } else {
        None
    };
    let mut found = Vec::new();
    for entry in &listing {
        if !touches(entry, &roots) {
            continue;
        }
        // Every Git call ace starts leads its own process group, so Git in a group a live
        // non-Git program leads (an agent's shell) is never this lease's work.
        match earlier.as_ref() {
            Some(earlier) if !earlier.contains(&entry.pid) => continue,
            None if entry.git_group == Some(false) => continue,
            _ => {}
        }
        found.push(format!(
            "a running Git process (pid {}{})",
            entry.pid,
            entry
                .cwd
                .as_ref()
                .map(|cwd| format!(" in {cwd}"))
                .unwrap_or_default()
        ));
    }
    Some(found)
}

async fn assess(
    entry: &JournalEntry,
    ports: &dyn LeasePorts,
    registry: &LeaseRegistry,
    scan: &Scan<'_>,
) -> Result<Assessed, GitError> {
    let local = local_lease(ports, registry, &entry.record).await;
    let owner = if local.present {
        if local.quarantined {
            LeaseOwnerState::Held
        } else {
            LeaseOwnerState::Running
        }
    } else if local.mine {
        LeaseOwnerState::Orphaned
    } else {
        query_lease_owner(&entry.record).await
    };
    let directory = parent_dir(&entry.file);
    let roots: Vec<RootKind> = entry
        .record
        .roots
        .iter()
        .map(|root| root_kind(root, &directory))
        .collect();
    let busy_list = if owner == LeaseOwnerState::Running {
        None
    } else {
        busy(owner, &local, &entry.record, scan, ports).await
    };
    Ok(Assessed {
        facts: LeaseFacts {
            record: entry.record.clone(),
            owner,
            roots,
            busy: busy_list,
        },
        file: entry.file.clone(),
    })
}

/// This process's own knowledge of a lease: the shell's `live`/`orphans` plus ours.
pub async fn local_lease(
    ports: &dyn LeasePorts,
    registry: &LeaseRegistry,
    record: &LeaseRecord,
) -> LocalLease {
    let mut local = ports.local_lease(record).await;
    if let Some(held) = registry.owned(&record.id) {
        local.present = true;
        local.live = registry.is_live(&record.id);
        local.quarantined = held.quarantined;
        local.done = held.done;
        local.groups = held.groups.clone();
        local.record = Some(held.record);
        local.mine = true;
    }
    local.mine |= owned_by_this_process(record);
    local
}

pub fn parent_dir(file: &str) -> String {
    std::path::Path::new(file)
        .parent()
        .map(|parent| parent.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Whether the owner the lease was assessed with still can't finish it.
async fn still_abandoned(
    entry: &Assessed,
    ports: &dyn LeasePorts,
    registry: &LeaseRegistry,
) -> bool {
    let local = local_lease(ports, registry, &entry.facts.record).await;
    if entry.facts.owner == LeaseOwnerState::Held {
        return local.present && local.done && local.quarantined;
    }
    if local.present {
        return false;
    }
    if entry.facts.owner == LeaseOwnerState::Orphaned {
        return local.mine;
    }
    query_lease_owner(&entry.facts.record).await == LeaseOwnerState::Gone
}

/// Removes the intent after rechecking its owner, then the Git locks its processes left.
async fn retire(
    entry: &Assessed,
    ports: &dyn LeasePorts,
    registry: &LeaseRegistry,
    reason: &'static str,
    scan: &Scan<'_>,
) -> Result<bool, GitError> {
    if !still_abandoned(entry, ports, registry).await {
        return Ok(false);
    }
    let _ = std::fs::remove_file(format!("{}.next", entry.file));
    let _ = std::fs::remove_file(&entry.file);
    let _ = sync_directory(std::path::Path::new(&parent_dir(&entry.file)));
    registry.forget(&entry.facts.record.id);
    ports.retired(&RetiredLease {
        lease: entry.facts.record.clone(),
        repository: journal_repository(&parent_dir(&entry.file), &entry.facts.record.root),
        reason,
    });
    if ports.has_evidence() && entry.facts.busy.as_ref().is_some_and(Vec::is_empty) {
        let before = ports.now_ms().await - LOCK_GRACE_MS;
        for (index, root) in entry.facts.record.roots.iter().enumerate() {
            if entry.facts.roots.get(index) == Some(&RootKind::Gone) {
                continue;
            }
            let _ = clear_leftover_locks(root, scan, before).await;
        }
    }
    Ok(true)
}

fn retirement(entry: &Assessed) -> &'static str {
    match entry.facts.owner {
        LeaseOwnerState::Held => "own_processes_gone",
        LeaseOwnerState::Orphaned => "own_lease_processes_gone",
        _ => {
            if entry
                .facts
                .roots
                .iter()
                .all(|kind| matches!(kind, RootKind::Gone | RootKind::Unregistered))
            {
                "owner_gone_roots_settled"
            } else {
                "owner_gone_processes_gone"
            }
        }
    }
}

/// Facts for the intents that still exist, retiring the ones that are definitively stale.
pub async fn survey(
    path: &str,
    ports: &dyn LeasePorts,
    registry: &LeaseRegistry,
    confirmed: bool,
) -> Result<(Vec<Assessed>, Vec<LeaseRecord>), GitError> {
    let scan = Scan::new(ports);
    let mut facts = Vec::new();
    let mut retired = Vec::new();
    for entry in records(path, ports, registry).await? {
        let assessed = assess(&entry, ports, registry, &scan).await?;
        if assessed.facts.owner != LeaseOwnerState::Running {
            let automatic = retires_automatically(&assessed.facts);
            let asked = confirmed
                && fences(&assessed.facts, path)
                && retires_on_confirmation(&assessed.facts);
            if automatic || asked {
                let reason = if automatic {
                    retirement(&assessed)
                } else {
                    "confirmed_stale"
                };
                if retire(&assessed, ports, registry, reason, &scan).await? {
                    retired.push(assessed.facts.record);
                    continue;
                }
            }
            if text(std::path::Path::new(&entry.file))?.is_none() {
                continue; // Successful concurrent retirement.
            }
        }
        facts.push(assessed);
    }
    Ok((facts, retired))
}

/// `mutationState`: no Git is invoked; stale intents retire as they are found.
pub async fn mutation_state(
    path: &str,
    ports: &dyn LeasePorts,
    registry: &LeaseRegistry,
) -> Result<MutationState, GitError> {
    let root = crate::core::paths::canonical(path).map_err(|error| GitError::from_io(&error))?;
    let (assessed, _) = survey(&root, ports, registry, false).await?;
    let facts: Vec<LeaseFacts> = assessed.into_iter().map(|entry| entry.facts).collect();
    Ok(lease_state(&facts, &root))
}

/// Admission: a lease that clears on its own is waited for, up to `wait_ms`.
/// `inside`: the leases the caller itself holds, which can't clear while it waits.
pub async fn assert_available(
    path: &str,
    ports: &dyn LeasePorts,
    registry: &LeaseRegistry,
    inside: &HashSet<String>,
) -> Result<(), GitError> {
    let polls = ports.wait_ms().div_ceil(POLL_MS);
    let mut attempt = 0u64;
    loop {
        let root = match crate::core::paths::canonical(path) {
            Ok(root) => root,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(GitError::new(
                    GitErrorCode::NotARepo,
                    format!("Git working directory no longer exists: {path}"),
                ));
            }
            Err(error) => return Err(GitError::from_io(&error)),
        };
        let (assessed, _) = survey(&root, ports, registry, false).await?;
        let facts: Vec<LeaseFacts> = assessed.iter().map(|entry| entry.facts.clone()).collect();
        let state = lease_state(&facts, &root);
        if state.status == "available" {
            return Ok(());
        }
        let fencing: Vec<&Assessed> = assessed
            .iter()
            .filter(|entry| fences(&entry.facts, &root))
            .collect();
        let waiting = fencing.iter().all(|entry| {
            !inside.contains(&entry.facts.record.id) && clears_on_its_own(&entry.facts)
        });
        if attempt < polls && waiting {
            ports.pause(POLL_MS).await;
            attempt += 1;
            continue;
        }
        return Err(refusal(&fencing, &state, ports).await);
    }
}

fn leases_value(state: &MutationState) -> Value {
    Value::Array(state.leases.iter().map(LeaseRecord::to_value).collect())
}

/// The error naming the first fencing lease: which repository, which checkout, what holds it.
async fn refusal(
    fencing: &[&Assessed],
    state: &MutationState,
    _ports: &dyn LeasePorts,
) -> GitError {
    let Some(first) = fencing.first() else {
        let mut details = Map::new();
        details.insert(JsString::from("leases"), leases_value(state));
        return GitError::with_details(
            GitErrorCode::GitQuarantined,
            "Repository cleanup is unconfirmed",
            details,
        );
    };
    let since = std::fs::metadata(&first.file)
        .and_then(|info| info.modified())
        .ok()
        .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|since| since.as_millis() as i64);
    let repository = journal_repository(&parent_dir(&first.file), &first.facts.record.root);
    let message = quarantine_message(&first.facts, &repository, since);
    let mut details = Map::new();
    details.insert(JsString::from("leases"), leases_value(state));
    details.insert(
        JsString::from("repository"),
        Value::from(repository.as_str()),
    );
    details.insert(
        JsString::from("owner"),
        Value::from(first.facts.owner.as_str()),
    );
    GitError::with_details(GitErrorCode::GitQuarantined, message, details)
}

/// "Clear stale lock": the same verification as admission, then retire every
/// fencing intent whose owner is definitively gone.
pub async fn clear_stale_leases(
    path: &str,
    ports: &dyn LeasePorts,
    registry: &LeaseRegistry,
) -> Result<(Vec<LeaseRecord>, MutationState, Option<String>), GitError> {
    let root = crate::core::paths::canonical(path).map_err(|error| GitError::from_io(&error))?;
    let (assessed, retired) = survey(&root, ports, registry, true).await?;
    let facts: Vec<LeaseFacts> = assessed.iter().map(|entry| entry.facts.clone()).collect();
    let state = lease_state(&facts, &root);
    if state.status == "available" {
        return Ok((retired, state, None));
    }
    let fencing: Vec<&Assessed> = assessed
        .iter()
        .filter(|entry| fences(&entry.facts, &root))
        .collect();
    let message = refusal(&fencing, &state, ports).await.message;
    Ok((retired, state, Some(message)))
}
