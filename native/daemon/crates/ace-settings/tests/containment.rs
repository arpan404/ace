// SPDX-License-Identifier: Apache-2.0
//! Ports `packages/settings/src/containment.test.ts`: a workspace root is pinned to the
//! identity it had when first read, and replacing its `.ace` folder with a symlink can
//! neither read nor migrate an outside settings file, because the check runs before a read
//! and again before a write's rename.

use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use ace_settings::file::{SettingsIo, Stop, Validate};
use ace_settings::layers::{Layer, Provenance};
use ace_settings::service::{Scope, SettingsService};
use ace_settings::validation::{SettingsCode, SettingsError};

struct FsIo;

fn io_error() -> SettingsError {
    SettingsError::new(SettingsCode::Io, "Cannot read or write settings file")
}

impl SettingsIo for FsIo {
    fn read(&self, path: &Path) -> Result<Option<String>, SettingsError> {
        match std::fs::read_to_string(path) {
            Ok(text) => Ok(Some(text)),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
            Err(_) => Err(io_error()),
        }
    }

    fn write(
        &self,
        path: &Path,
        text: &str,
        before_commit: Option<&Validate>,
    ) -> Result<(), SettingsError> {
        if let Some(before_commit) = before_commit {
            before_commit()?;
        }
        write_atomically(path, text)
    }

    fn watch(
        &self,
        _path: &Path,
        _changed: std::rc::Rc<dyn Fn()>,
        _failed: std::rc::Rc<dyn Fn()>,
    ) -> Result<Stop, SettingsError> {
        Ok(Box::new(|| {}))
    }
}

/// The same shape as `io.ts`'s `atomicWrite`: a temporary file, then the rename.
fn write_atomically(path: &Path, text: &str) -> Result<(), SettingsError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|_| io_error())?;
    }
    let temporary = path.with_extension("settings.json.tmp");
    std::fs::write(&temporary, text).map_err(|_| io_error())?;
    std::fs::rename(&temporary, path).map_err(|_| io_error())
}

/// An IO that runs an armed callback after the change is computed and before the write
/// commits, the moment a symlink swap would happen in the wild.
struct SwappingIo {
    swap: Mutex<Option<Box<dyn Fn() + Send + Sync>>>,
}

impl SettingsIo for SwappingIo {
    fn read(&self, path: &Path) -> Result<Option<String>, SettingsError> {
        FsIo.read(path)
    }

    fn write(
        &self,
        path: &Path,
        text: &str,
        before_commit: Option<&Validate>,
    ) -> Result<(), SettingsError> {
        if let Some(swap) = self
            .swap
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take()
        {
            swap();
        }
        FsIo.write(path, text, before_commit)
    }

    fn watch(
        &self,
        path: &Path,
        changed: std::rc::Rc<dyn Fn()>,
        failed: std::rc::Rc<dyn Fn()>,
    ) -> Result<Stop, SettingsError> {
        FsIo.watch(path, changed, failed)
    }
}

static SERIAL: AtomicUsize = AtomicUsize::new(0);

/// A scratch root with `repo`, `outside` and `data` folders.
fn scratch(name: &str) -> PathBuf {
    let unique = SERIAL.fetch_add(1, Ordering::Relaxed);
    let root = std::env::temp_dir().join(format!(
        "ace-settings-containment-{name}-{}-{unique}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&root);
    for child in ["repo", "outside", "data"] {
        std::fs::create_dir_all(root.join(child)).unwrap_or_else(|error| panic!("{error}"));
    }
    root
}

fn service(
    root: &Path,
    io: Arc<dyn SettingsIo>,
) -> std::rc::Rc<std::cell::RefCell<SettingsService>> {
    SettingsService::new(
        root.join("data"),
        io,
        Arc::new(NoScheduler),
        std::collections::BTreeMap::new(),
    )
    .unwrap_or_else(|error| panic!("{error}"))
}

struct NoScheduler;

impl ace_settings::file::Scheduler for NoScheduler {
    fn schedule(&self, _delay_ms: u64, _callback: Box<dyn Fn()>) -> Stop {
        Box::new(|| {})
    }
}

/// Replaces `<repo>/.ace` with a symlink to `<outside>`, keeping the old folder.
fn swap_ace_for_outside(root: &Path) {
    let repo = root.join("repo");
    let ace = repo.join(".ace");
    std::fs::rename(&ace, repo.join("old-ace")).unwrap_or_else(|error| panic!("{error}"));
    #[cfg(unix)]
    std::os::unix::fs::symlink(root.join("outside"), &ace)
        .unwrap_or_else(|error| panic!("{error}"));
}

fn read_text(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|error| panic!("{error}"))
}

#[test]
fn refreshing_a_pinned_workspace_cannot_read_or_migrate_an_outside_v1_file() {
    let root = scratch("v1");
    let io = Arc::new(FsIo);
    let service = service(&root, io);
    let scope = Layer::Workspace {
        workspace: root.join("repo"),
    };
    SettingsService::set(&service, "threads.settleOnClose", &true.into(), &scope)
        .unwrap_or_else(|error| panic!("{error}"));

    let outside = root.join("outside").join("settings.json");
    let source = "{\"version\":1,\"values\":{\"threads.settleOnClose\":false}}";
    std::fs::write(&outside, source).unwrap_or_else(|error| panic!("{error}"));
    swap_ace_for_outside(&root);

    SettingsService::refresh(&service, &scope).unwrap_or_else(|error| panic!("{error}"));
    let (entries, diagnostics) = SettingsService::read(
        &service,
        &["threads.settleOnClose".to_owned()],
        &Scope {
            workspace: Some(root.join("repo")),
            thread: None,
        },
    )
    .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(entries[0].value, true, "the last good value stays");
    assert_eq!(entries[0].provenance, Provenance::Workspace);
    assert!(
        diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == SettingsCode::Validation
                && diagnostic.layer == Provenance::Workspace),
        "{diagnostics:?}"
    );
    assert_eq!(read_text(&outside), source, "the outside file is untouched");
}

#[test]
fn a_cold_workspace_read_cannot_migrate_an_outside_v2_file() {
    let root = scratch("cold");
    let outside = root.join("outside").join("settings.json");
    let source = "{\"version\":2,\"settings\":{\"threads.settleOnClose\":true}}";
    std::fs::write(&outside, source).unwrap_or_else(|error| panic!("{error}"));
    #[cfg(unix)]
    std::os::unix::fs::symlink(root.join("outside"), root.join("repo").join(".ace"))
        .unwrap_or_else(|error| panic!("{error}"));

    let service = service(&root, Arc::new(FsIo));
    let (entries, diagnostics) = SettingsService::read(
        &service,
        &["threads.settleOnClose".to_owned()],
        &Scope {
            workspace: Some(root.join("repo")),
            thread: None,
        },
    )
    .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(entries[0].value, false, "the shipped default");
    assert_eq!(entries[0].provenance, Provenance::Defaults);
    assert!(
        diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == SettingsCode::Validation),
        "{diagnostics:?}"
    );
    assert_eq!(read_text(&outside), source, "the outside file is untouched");
}

#[test]
fn a_write_rechecks_containment_immediately_before_its_rename() {
    let root = scratch("rename");
    let io = Arc::new(SwappingIo {
        swap: Mutex::new(None),
    });
    let service = service(&root, io.clone());
    let scope = Layer::Workspace {
        workspace: root.join("repo"),
    };
    SettingsService::set(&service, "threads.settleOnClose", &true.into(), &scope)
        .unwrap_or_else(|error| panic!("{error}"));
    let stored = read_text(&root.join("repo").join(".ace").join("settings.json"));

    let outside = root.join("outside").join("settings.json");
    let outside_source = "{\"version\":2,\"settings\":{}}";
    std::fs::write(&outside, outside_source).unwrap_or_else(|error| panic!("{error}"));
    let swap_root = root.clone();
    *io.swap.lock().unwrap_or_else(|error| error.into_inner()) =
        Some(Box::new(move || swap_ace_for_outside(&swap_root)));

    let refusal = SettingsService::set(&service, "threads.settleOnClose", &false.into(), &scope);
    assert_eq!(
        refusal.map_err(|error| (error.code, error.message)),
        Err((
            SettingsCode::Validation,
            "Workspace settings cannot use symlink components".into()
        ))
    );
    assert_eq!(
        read_text(&outside),
        outside_source,
        "the write never reached the outside file"
    );
    assert_eq!(
        read_text(&root.join("repo").join("old-ace").join("settings.json")),
        stored
    );
}
