// SPDX-License-Identifier: Apache-2.0
//! Ports `packages/settings/src/io.ts`, `file-watch.ts` and `durability.test.ts`'s atomic
//! cases on real temporary directories: a 0600 temporary file in the destination's folder,
//! synced and renamed with the containment check between; a read that refuses a symlink at
//! the file's own path; a temporary file recovered after its folder is moved; a watch that
//! reports a change; and a migrated document written back exactly once.

// The service and its IO shell are single-threaded; `Arc` is the port's shape, not sharing.
#![allow(clippy::arc_with_non_send_sync)]

use std::cell::Cell;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use ace_settings::file::{Scheduler, SettingsFile, SettingsIo, Stop, Validate};
use ace_settings::io::FsIo;
use ace_settings::layers::Provenance;
use ace_settings::service::{Scope, SettingsService};
use ace_settings::validation::{SettingsCode, SettingsError};
use ace_settings::workspace::{RealWorkspaceFs, WorkspaceGuard};

static SERIAL: AtomicUsize = AtomicUsize::new(0);

fn scratch(name: &str) -> PathBuf {
    let unique = SERIAL.fetch_add(1, Ordering::Relaxed);
    let root = std::env::temp_dir().join(format!(
        "ace-settings-io-{name}-{}-{unique}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap_or_else(|error| panic!("{error}"));
    root
}

struct NoScheduler;

impl Scheduler for NoScheduler {
    fn schedule(&self, _delay_ms: u64, _callback: Box<dyn Fn()>) -> Stop {
        Box::new(|| {})
    }
}

/// Every temporary file left below `root`, at most three levels deep.
fn temporaries(root: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    while let Some((directory, depth)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.ends_with(".tmp") && name.starts_with('.') {
                found.push(path);
                continue;
            }
            if depth < 3 && entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
                stack.push((path, depth + 1));
            }
        }
    }
    found
}

#[test]
fn a_write_uses_a_hidden_0600_temporary_and_replaces_the_file_with_it() {
    let root = scratch("write");
    let path = root.join("settings.json");
    let io = FsIo::new();

    let seen: Rc<Cell<bool>> = Rc::new(Cell::new(false));
    let inspect = seen.clone();
    let directory = root.clone();
    let before: Validate = Rc::new(move || -> Result<(), SettingsError> {
        let temporary: Vec<PathBuf> = temporaries(&directory)
            .into_iter()
            .filter(|path| path.to_string_lossy().contains("settings.json"))
            .collect();
        assert_eq!(
            temporary.len(),
            1,
            "one temporary file waits for the rename"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&temporary[0])
                .unwrap_or_else(|error| panic!("{error}"))
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600, "the temporary file is owner-only");
        }
        inspect.set(true);
        Ok(())
    });
    io.write(&path, "{\"version\":2,\"settings\":{}}", Some(&before))
        .unwrap_or_else(|error| panic!("{error}"));
    assert!(seen.get(), "the check ran before the rename");
    assert_eq!(
        std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{error}")),
        "{\"version\":2,\"settings\":{}}"
    );
    assert!(temporaries(&root).is_empty());
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn a_failed_check_leaves_the_destination_and_removes_the_temporary() {
    let root = scratch("refuse");
    let path = root.join("settings.json");
    std::fs::write(&path, "original").unwrap_or_else(|error| panic!("{error}"));
    let io = FsIo::new();
    let refuse: Validate = Rc::new(|| -> Result<(), SettingsError> {
        Err(SettingsError::new(
            SettingsCode::Validation,
            "Workspace root changed during settings access",
        ))
    });
    assert_eq!(
        io.write(&path, "replacement", Some(&refuse))
            .map_err(|error| error.code),
        Err(SettingsCode::Validation)
    );
    assert_eq!(
        std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{error}")),
        "original"
    );
    assert!(temporaries(&root).is_empty(), "the temporary file is gone");
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn a_read_refuses_a_symlink_at_the_files_own_path() {
    let root = scratch("nofollow");
    let target = root.join("target.json");
    std::fs::write(&target, "{\"version\":2,\"settings\":{}}")
        .unwrap_or_else(|error| panic!("{error}"));
    let link = root.join("settings.json");
    #[cfg(unix)]
    std::os::unix::fs::symlink(&target, &link).unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(
        FsIo::new()
            .read(&link)
            .map(|_| ())
            .map_err(|error| error.code),
        Err(SettingsCode::Io),
        "O_NOFOLLOW refuses the link instead of reading through it"
    );
    assert!(FsIo::new().read(&target).is_ok());
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn a_check_that_sees_its_workspace_swapped_never_renames_into_the_outside_folder() {
    let root = scratch("swap");
    let repo = root.join("repo");
    let outside = root.join("outside");
    std::fs::create_dir_all(repo.join(".ace")).unwrap_or_else(|error| panic!("{error}"));
    std::fs::create_dir_all(&outside).unwrap_or_else(|error| panic!("{error}"));
    let outside_file = outside.join("settings.json");
    let source = "{\"version\":2,\"settings\":{}}";
    std::fs::write(&outside_file, source).unwrap_or_else(|error| panic!("{error}"));

    let guard = Rc::new(
        WorkspaceGuard::pin(&repo, Arc::new(RealWorkspaceFs))
            .unwrap_or_else(|error| panic!("{error}")),
    );
    // The first two checks run on the original workspace; the third is the write's last
    // check, after the temporary file is complete. It swaps `.ace` for a symlink to the
    // outside folder before checking containment, as an attacker racing the rename would.
    let calls = Rc::new(Cell::new(0usize));
    let swap_repo = repo.clone();
    let swap_outside = outside.clone();
    let guard_for_check = guard.clone();
    let check: Rc<dyn Fn() -> Result<(), SettingsError>> = Rc::new(move || {
        calls.set(calls.get() + 1);
        if calls.get() == 3 {
            std::fs::rename(swap_repo.join(".ace"), swap_repo.join("old-ace"))
                .unwrap_or_else(|error| panic!("{error}"));
            #[cfg(unix)]
            std::os::unix::fs::symlink(&swap_outside, swap_repo.join(".ace"))
                .unwrap_or_else(|error| panic!("{error}"));
        }
        guard_for_check.check()
    });

    let io = Arc::new(FsIo::new());
    let path = repo.join(".ace").join("settings.json");
    let mut file = SettingsFile::new(
        path.clone(),
        Provenance::Workspace,
        io.clone(),
        Rc::new(|_| {}),
    );
    let _ = file.reload();
    file.protect(check);
    let refusal = file.set("threads.settleOnClose", &true.into());
    assert_eq!(
        refusal.map_err(|error| (error.code, error.message)),
        Err((
            SettingsCode::Validation,
            "Workspace settings cannot use symlink components".into()
        ))
    );
    assert_eq!(
        std::fs::read_to_string(&outside_file).unwrap_or_else(|error| panic!("{error}")),
        source,
        "the outside file is untouched"
    );
    assert!(
        !repo.join("old-ace").join("settings.json").exists(),
        "the rename never happened"
    );
    assert!(
        temporaries(&root).is_empty(),
        "the temporary file was recovered from the moved folder: {:?}",
        temporaries(&root)
    );
    let _ = std::fs::remove_dir_all(&root);
}

/// `service.test.ts`: "a v1 document migrates on read and is written back exactly once".
#[test]
fn a_v1_document_migrates_on_read_and_is_written_back_exactly_once() {
    let root = scratch("migrate-once");
    let data = root.join("data");
    std::fs::create_dir_all(&data).unwrap_or_else(|error| panic!("{error}"));
    let path = data.join("settings.json");
    std::fs::write(
        &path,
        "{\"version\":1,\"values\":{\"threads.settleOnClose\":true}}",
    )
    .unwrap_or_else(|error| panic!("{error}"));
    let before = std::fs::metadata(&path).unwrap_or_else(|error| panic!("{error}"));
    let before_mtime = before.modified().unwrap_or_else(|error| panic!("{error}"));
    let io = Arc::new(FsIo::new());
    let service = SettingsService::new(
        data,
        io,
        Arc::new(NoScheduler),
        std::collections::BTreeMap::new(),
    )
    .unwrap_or_else(|error| panic!("{error}"));

    let entry = SettingsService::get(&service, "threads.settleOnClose", &Scope::default())
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(entry.value, true);
    let migrated = std::fs::metadata(&path).unwrap_or_else(|error| panic!("{error}"));
    assert!(
        std::fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("{error}"))
            .contains("\"version\":2"),
        "the migration was written"
    );
    for _ in 0..2 {
        SettingsService::refresh(&service, &ace_settings::layers::Layer::Global)
            .unwrap_or_else(|error| panic!("{error}"));
    }
    let after = std::fs::metadata(&path).unwrap_or_else(|error| panic!("{error}"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        assert_ne!(
            before.ino(),
            migrated.ino(),
            "the migration replaced the file"
        );
        assert_eq!(
            after.ino(),
            migrated.ino(),
            "a later reload does not rewrite the migration"
        );
    }
    assert_eq!(
        after.modified().unwrap_or_else(|error| panic!("{error}")),
        migrated
            .modified()
            .unwrap_or_else(|error| panic!("{error}")),
        "a later reload leaves the modification time alone"
    );
    assert_ne!(
        after.modified().unwrap_or_else(|error| panic!("{error}")),
        before_mtime,
        "the migration itself did write"
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn a_watch_reports_a_change_to_its_file_and_ignores_a_sibling() {
    let root = scratch("watch");
    let path = root.join("settings.json");
    std::fs::write(&path, "{\"version\":2,\"settings\":{}}")
        .unwrap_or_else(|error| panic!("{error}"));
    let io = FsIo::new();
    let hits: Rc<Cell<usize>> = Rc::new(Cell::new(0));
    let counted = hits.clone();
    let stop = io
        .watch(
            &path,
            Rc::new(move || counted.set(counted.get() + 1)),
            Rc::new(|| panic!("the watch must not fail")),
        )
        .unwrap_or_else(|error| panic!("{error}"));

    // macOS FSEvents can deliver the pre-watch creation of `settings.json` asynchronously
    // after the watch starts; drain startup noise before testing sibling isolation.
    std::thread::sleep(Duration::from_millis(300));
    io.pump();
    hits.set(0);
    std::fs::write(root.join("sibling.json"), "{}").unwrap_or_else(|error| panic!("{error}"));
    // A sibling write is not this file's change.
    let quiet = Instant::now() + Duration::from_millis(800);
    while Instant::now() < quiet {
        io.pump();
        assert_eq!(hits.get(), 0, "a sibling write is ignored");
        std::thread::sleep(Duration::from_millis(20));
    }
    let after_sibling = hits.get();
    std::fs::write(
        &path,
        "{\"version\":2,\"settings\":{\"threads.sortBy\":\"manual\"}}",
    )
    .unwrap_or_else(|error| panic!("{error}"));
    wait_for(&io, || hits.get() > after_sibling, || false);
    stop();
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn a_watch_on_a_folder_that_does_not_exist_yet_reports_its_creation() {
    let root = scratch("watch-missing");
    let path = root.join("threads").join("t1").join("settings.json");
    let io = FsIo::new();
    let hits: Rc<Cell<usize>> = Rc::new(Cell::new(0));
    let counted = hits.clone();
    let _stop = io
        .watch(
            &path,
            Rc::new(move || counted.set(counted.get() + 1)),
            Rc::new(|| panic!("the watch must not fail")),
        )
        .unwrap_or_else(|error| panic!("{error}"));
    std::fs::create_dir_all(root.join("threads").join("t1"))
        .unwrap_or_else(|error| panic!("{error}"));
    wait_for(&io, || hits.get() >= 1, || false);
    let _ = std::fs::remove_dir_all(&root);
}

/// Pumps the shell's queued watch events until `done`, for at most five seconds.
fn wait_for(io: &FsIo, done: impl Fn() -> bool, failed: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        io.pump();
        if done() {
            return;
        }
        assert!(!failed(), "the watch failed");
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("the watch did not report within five seconds");
}
