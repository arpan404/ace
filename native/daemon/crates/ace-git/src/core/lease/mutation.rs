// SPDX-License-Identifier: Apache-2.0
//! Mutation leases: the durable intent a writer writes before it mutates a
//! root, and its scope (`packages/git/src/mutation-leases.ts`).

use std::path::Path;
use std::sync::{Arc, Mutex};

use crate::core::error::{CleanupResult, GitError, GitErrorCode};
use crate::core::lease::admission::{assert_available, local_lease};
use crate::core::lease::journal::{
    HeldLease, LeaseRecord, LeaseRegistry, OwnerEndpoint, scope_journal, sync_directory,
};
use crate::core::lease::owner::lease_owner;
use crate::core::lease::state::LeaseOwnerState;
use crate::core::lease::{LeasePorts, LeaseState};

tokio::task_local! {
    /// The leases each async operation holds, outermost first.
    static SCOPE: Arc<Vec<Arc<Mutex<HeldLease>>>>;
}

/// The leases the calling operation holds (`scope.getStore()`).
pub fn held_leases() -> Vec<Arc<Mutex<HeldLease>>> {
    SCOPE
        .try_with(|scope| scope.as_ref().clone())
        .unwrap_or_default()
}

fn held_ids(held: &[Arc<Mutex<HeldLease>>]) -> std::collections::HashSet<String> {
    held.iter()
        .filter_map(|lease| lease.lock().ok().map(|lease| lease.record.id.clone()))
        .collect()
}

/// Admission for the calling operation, which never waits for the leases it holds itself.
pub async fn assert_available_for_scope(
    path: &str,
    ports: &dyn LeasePorts,
    registry: &LeaseRegistry,
) -> Result<(), GitError> {
    let held = held_leases();
    assert_available(path, ports, registry, &held_ids(&held)).await
}

/// Writes the intent, runs `operation` inside its scope, then retires it.
pub async fn with_mutation_lease<T, F, Fut>(
    state: &Arc<LeaseState>,
    root: &str,
    id: String,
    ports: &dyn LeasePorts,
    operation: F,
) -> Result<T, GitError>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<T, GitError>>,
{
    let ancestors = held_leases();
    assert_available(root, ports, state.registry(), &held_ids(&ancestors)).await?;
    let directory = scope_journal(root)?;
    let endpoint = lease_owner(&id, Arc::new(owner_state));
    let record = LeaseRecord {
        version: 1,
        id: id.clone(),
        root: root.to_owned(),
        roots: vec![root.to_owned()],
        owner: endpoint.map(|owner| OwnerEndpoint {
            port: owner.port,
            token: owner.token,
        }),
    };
    let file = Path::new(&directory).join(&record.id);
    std::fs::create_dir_all(&directory).map_err(|error| GitError::from_io(&error))?;
    let owned = Arc::new(Mutex::new(HeldLease {
        record: record.clone(),
        file: file.to_string_lossy().into_owned(),
        quarantined: false,
        done: false,
        groups: Some(Vec::new()),
    }));
    // The intent reaches disk before any process can mutate this root.
    for ancestor in &ancestors {
        let mut ancestor = ancestor.lock().map_err(|_| busy())?;
        if !ancestor.record.roots.iter().any(|known| known == root) {
            ancestor.record.roots.push(root.to_owned());
        }
        write_record(
            Path::new(&format!("{}.next", ancestor.file)),
            &ancestor.record,
        )?;
        std::fs::rename(format!("{}.next", ancestor.file), &ancestor.file)
            .map_err(|error| GitError::from_io(&error))?;
        sync_directory(Path::new(&directory))?;
    }
    if state.registry.is_live(&record.id) {
        return Err(busy());
    }
    state.registry.insert_live(
        owned
            .lock()
            .map(|lease| lease.clone())
            .map_err(|_| busy())?,
    );
    let mut created = false;
    let outcome = async {
        let pending_text = format!("{}.next", file.to_string_lossy());
        let pending = Path::new(&pending_text);
        write_record(pending, &record)?;
        if file.exists() {
            return Err(busy());
        }
        std::fs::rename(pending, &file).map_err(|error| GitError::from_io(&error))?;
        created = true;
        sync_directory(Path::new(&directory))?;
        let mut scoped = ancestors.clone();
        scoped.push(Arc::clone(&owned));
        SCOPE.scope(Arc::new(scoped), operation()).await
    }
    .await;
    let (quarantined, lease_file) = owned
        .lock()
        .map(|lease| (lease.quarantined, lease.file.clone()))
        .unwrap_or((false, String::new()));
    state.registry.orphan(&record.id);
    if created && !quarantined {
        let _ = std::fs::remove_file(&lease_file);
    }
    outcome
}

fn write_record(file: &Path, record: &LeaseRecord) -> Result<(), GitError> {
    use std::io::Write;
    let mut handle = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(file)
        .map_err(|error| GitError::from_io(&error))?;
    handle
        .write_all(record.json().as_bytes())
        .map_err(|error| GitError::from_io(&error))?;
    handle.sync_all().map_err(|error| GitError::from_io(&error))
}

fn busy() -> GitError {
    GitError::new(
        GitErrorCode::GitBusy,
        "Mutation lease identity already active",
    )
}

/// Answers a liveness probe for one of this process's leases.
fn owner_state(id: &str) -> LeaseOwnerState {
    let registry = crate::core::lease::global_leases();
    match registry.registry.owned(id) {
        Some(lease) if lease.quarantined => LeaseOwnerState::Quarantined,
        Some(_) => LeaseOwnerState::Active,
        None => LeaseOwnerState::Unknown,
    }
}

/// Reconciles with the cleanup supervisor: a confirmed reconcile retires every
/// captured intent, and any unconfirmed outcome keeps the parent fenced.
pub async fn recover_mutation_leases(
    path: &str,
    ports: &dyn LeasePorts,
    registry: &LeaseRegistry,
) -> Result<crate::core::lease::state::MutationState, GitError> {
    let mut discovered = crate::core::lease::journal::records(path, ports, registry).await?;
    let mut seen: std::collections::HashSet<String> = discovered
        .iter()
        .map(|entry| entry.record.id.clone())
        .collect();
    let mut index = 0usize;
    while index < discovered.len() {
        let roots = discovered[index].record.roots.clone();
        for root in roots {
            // A removed root has no journal of its own left.
            let nested: Vec<crate::core::lease::journal::JournalEntry> =
                crate::core::lease::journal::records(&root, ports, registry)
                    .await
                    .unwrap_or_default();
            for entry in nested {
                if seen.insert(entry.record.id.clone()) {
                    discovered.push(entry);
                }
            }
        }
        index += 1;
    }
    if discovered
        .iter()
        .any(|entry| registry.is_live(&entry.record.id))
    {
        return crate::core::lease::admission::mutation_state(path, ports, registry).await;
    }
    for entry in &discovered {
        let local = local_lease(ports, registry, &entry.record).await;
        if !local.present
            && crate::core::lease::owner::query_lease_owner(&entry.record, ports).await
                == LeaseOwnerState::Active
        {
            return crate::core::lease::admission::mutation_state(path, ports, registry).await;
        }
    }
    let mut outcomes: Vec<CleanupResult> = Vec::new();
    for entry in &discovered {
        outcomes.push(ports.recover(&entry.record).await);
    }
    if outcomes
        .iter()
        .all(|outcome| matches!(outcome, CleanupResult::Confirmed { .. }))
    {
        for entry in &discovered {
            let _ = std::fs::remove_file(&entry.file);
            registry.forget(&entry.record.id);
        }
    }
    crate::core::lease::admission::mutation_state(path, ports, registry).await
}
