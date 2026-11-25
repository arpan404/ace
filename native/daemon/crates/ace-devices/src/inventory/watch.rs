// SPDX-License-Identifier: Apache-2.0
//! `notify` 8 directory watches for the Android AVD folder and macOS
//! CoreSimulator device set (ADR 0225, D2). Handles missing directories via
//! nearest-existing-parent watches, detects delete/replace/rescan signals, and
//! filters unrelated sibling writes while waiting on a parent.

use crate::error::DeviceError;
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::{Component, Path, PathBuf};
use tokio::sync::mpsc;

/// Resolves the Android AVD folder: `ANDROID_AVD_HOME` when non-empty, else `<home>/.android/avd`.
pub fn avd_folder(env: &[(String, String)], home: &Path) -> PathBuf {
    if let Some((_, val)) = env
        .iter()
        .find(|(key, val)| key == "ANDROID_AVD_HOME" && !val.trim().is_empty())
    {
        return PathBuf::from(val);
    }
    home.join(".android").join("avd")
}

/// Resolves macOS CoreSimulator's default device set folder.
pub fn core_simulator_folder(home: &Path) -> PathBuf {
    home.join("Library")
        .join("Developer")
        .join("CoreSimulator")
        .join("Devices")
}

/// Stable directory identity used to detect deletion or replacement (e.g. Xcode reset).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DirIdentity {
    #[cfg(unix)]
    dev: u64,
    #[cfg(unix)]
    ino: u64,
    #[cfg(not(unix))]
    exists: bool,
}

/// Reads the current identity of an existing directory, or `None` if absent or not a directory.
pub fn dir_identity(path: &Path) -> Option<DirIdentity> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_dir() {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Some(DirIdentity {
            dev: meta.dev(),
            ino: meta.ino(),
        })
    }
    #[cfg(not(unix))]
    {
        Some(DirIdentity { exists: true })
    }
}

/// Where a watch actually attaches: the target itself, or its nearest existing ancestor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WatchAttachment {
    /// Target directory exists; watched recursively.
    Target {
        path: PathBuf,
        identity: DirIdentity,
    },
    /// Target does not exist yet; nearest existing ancestor is watched non-recursively
    /// until `next_child` appears.
    Parent {
        parent: PathBuf,
        parent_identity: DirIdentity,
        next_child: PathBuf,
    },
}

/// Resolves where to attach a watch for `target` (target itself or nearest existing parent).
pub fn resolve_watch_attachment(target: &Path) -> Result<WatchAttachment, DeviceError> {
    if let Some(identity) = dir_identity(target) {
        return Ok(WatchAttachment::Target {
            path: target.to_path_buf(),
            identity,
        });
    }
    let mut cursor = target.to_path_buf();
    let mut missing_components: Vec<PathBuf> = Vec::new();
    loop {
        let Some(name) = cursor.file_name() else {
            return Err(DeviceError::Watch(format!(
                "no existing parent directory for {}",
                target.display()
            )));
        };
        missing_components.push(PathBuf::from(name));
        let Some(parent) = cursor.parent() else {
            return Err(DeviceError::Watch(format!(
                "no existing parent directory for {}",
                target.display()
            )));
        };
        if let Some(parent_identity) = dir_identity(parent) {
            let next_name = missing_components
                .last()
                .cloned()
                .unwrap_or_else(PathBuf::new);
            return Ok(WatchAttachment::Parent {
                parent: parent.to_path_buf(),
                parent_identity,
                next_child: parent.join(next_name),
            });
        }
        if parent == cursor {
            return Err(DeviceError::Watch(format!(
                "no existing parent directory for {}",
                target.display()
            )));
        }
        cursor = parent.to_path_buf();
    }
}

/// Events produced by a live directory watch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DirWatchEvent {
    /// A file or subdirectory changed inside the watched target directory.
    Changed,
    /// The watcher errored, received `need_rescan`, the watched folder was deleted/replaced,
    /// or a missing parent component appeared and the watch should advance toward the target.
    RestartNeeded(String),
}

/// Pure classifier for one `notify` callback result against the current attachment.
pub fn classify_notify_result(
    attachment: &WatchAttachment,
    result: Result<&Event, &notify::Error>,
) -> Option<DirWatchEvent> {
    let event = match result {
        Ok(event) => event,
        Err(err) => {
            return Some(DirWatchEvent::RestartNeeded(format!(
                "notify watcher error: {err}"
            )));
        }
    };

    if event.need_rescan() {
        return Some(DirWatchEvent::RestartNeeded(
            "notify watcher signalled rescan".into(),
        ));
    }

    match attachment {
        WatchAttachment::Target { path, identity } => {
            if dir_identity(path) != Some(*identity) {
                return Some(DirWatchEvent::RestartNeeded(format!(
                    "watched directory deleted or replaced: {}",
                    path.display()
                )));
            }
            // Ignore pure access/metadata noise only when notify reports Access; any create/modify/remove/any triggers.
            if matches!(event.kind, notify::EventKind::Access(_)) {
                return None;
            }
            Some(DirWatchEvent::Changed)
        }
        WatchAttachment::Parent {
            parent,
            parent_identity,
            next_child,
        } => {
            if dir_identity(parent) != Some(*parent_identity) {
                return Some(DirWatchEvent::RestartNeeded(format!(
                    "watched parent deleted or replaced: {}",
                    parent.display()
                )));
            }
            if next_child.exists()
                || event
                    .paths
                    .iter()
                    .any(|p| path_matches_component(p, next_child))
            {
                return Some(DirWatchEvent::RestartNeeded(format!(
                    "missing path component appeared: {}",
                    next_child.display()
                )));
            }
            // Unrelated sibling write in parent (e.g. ~/.zsh_history or test reads file): ignore.
            None
        }
    }
}

fn path_matches_component(candidate: &Path, expected: &Path) -> bool {
    if candidate == expected {
        return true;
    }
    // Compare normalized last component + parent in case of macOS `/var` vs `/private/var` symlinks.
    let cand_name = candidate.file_name();
    let exp_name = expected.file_name();
    if cand_name.is_some() && cand_name == exp_name {
        // Check that expected is not just matching an unrelated directory of the same name elsewhere.
        let mut cand_comps: Vec<Component<'_>> = candidate.components().collect();
        let mut exp_comps: Vec<Component<'_>> = expected.components().collect();
        cand_comps.pop();
        exp_comps.pop();
        if cand_comps == exp_comps {
            return true;
        }
        if let (Ok(c_parent), Ok(e_parent)) = (
            candidate.parent().map(std::fs::canonicalize).transpose(),
            expected.parent().map(std::fs::canonicalize).transpose(),
        ) {
            return c_parent.is_some() && c_parent == e_parent;
        }
    }
    false
}

/// Live OS directory watch; dropping it stops the underlying `notify` watcher.
pub struct DirWatchHandle {
    _watcher: RecommendedWatcher,
    attachment: WatchAttachment,
}

impl DirWatchHandle {
    /// True when the target directory itself exists and is watched recursively.
    pub fn is_on_target(&self) -> bool {
        matches!(self.attachment, WatchAttachment::Target { .. })
    }

    pub fn attachment(&self) -> &WatchAttachment {
        &self.attachment
    }
}

/// Starts a `notify` 8 watch on `target` or its nearest existing parent.
pub fn start_dir_watch(
    target: &Path,
    tx: mpsc::UnboundedSender<DirWatchEvent>,
) -> Result<DirWatchHandle, DeviceError> {
    let attachment = resolve_watch_attachment(target)?;
    let (watch_path, mode) = match &attachment {
        WatchAttachment::Target { path, .. } => (path.clone(), RecursiveMode::Recursive),
        WatchAttachment::Parent { parent, .. } => (parent.clone(), RecursiveMode::NonRecursive),
    };
    let attachment_for_cb = attachment.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
        let classified = match &res {
            Ok(ev) => classify_notify_result(&attachment_for_cb, Ok(ev)),
            Err(err) => classify_notify_result(&attachment_for_cb, Err(err)),
        };
        if let Some(event) = classified {
            let _ = tx.send(event);
        }
    })
    .map_err(|e| DeviceError::Watch(format!("create notify watcher: {e}")))?;

    watcher
        .watch(&watch_path, mode)
        .map_err(|e| DeviceError::Watch(format!("watch {}: {e}", watch_path.display())))?;

    Ok(DirWatchHandle {
        _watcher: watcher,
        attachment,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    fn unique_temp_dir(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "ace-devices-watch-{label}-{}-{nanos}",
            std::process::id()
        ));
        let _ = std::fs::create_dir_all(&dir);
        dir
    }

    #[test]
    fn avd_folder_prefers_env_override_else_dot_android_avd() {
        let home = Path::new("/tmp/fake-home");
        assert_eq!(
            avd_folder(&[], home),
            PathBuf::from("/tmp/fake-home/.android/avd")
        );
        assert_eq!(
            avd_folder(&[("ANDROID_AVD_HOME".into(), "".into())], home),
            PathBuf::from("/tmp/fake-home/.android/avd")
        );
        assert_eq!(
            avd_folder(&[("ANDROID_AVD_HOME".into(), "/custom/avds".into())], home),
            PathBuf::from("/custom/avds")
        );
        assert_eq!(
            core_simulator_folder(home),
            PathBuf::from("/tmp/fake-home/Library/Developer/CoreSimulator/Devices")
        );
    }

    #[test]
    fn missing_target_attaches_to_nearest_existing_parent_and_ignores_unrelated_siblings() {
        let root = unique_temp_dir("parent");
        let target = root.join(".android").join("avd");
        let attachment = resolve_watch_attachment(&target);
        assert!(matches!(
            attachment,
            Ok(WatchAttachment::Parent {
                ref parent,
                ref next_child,
                ..
            }) if parent == &root && next_child == &root.join(".android")
        ));
        if let Ok(att) = attachment {
            // Unrelated sibling write in root must not trigger restart or change.
            let sibling_event =
                Event::new(notify::EventKind::Create(notify::event::CreateKind::File))
                    .add_path(root.join("unrelated.txt"));
            assert_eq!(classify_notify_result(&att, Ok(&sibling_event)), None);

            // Creating the next component triggers RestartNeeded to advance watch.
            let _ = std::fs::create_dir_all(root.join(".android"));
            let child_event =
                Event::new(notify::EventKind::Create(notify::event::CreateKind::Folder))
                    .add_path(root.join(".android"));
            assert!(matches!(
                classify_notify_result(&att, Ok(&child_event)),
                Some(DirWatchEvent::RestartNeeded(_))
            ));
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn need_rescan_and_target_replacement_request_restart() {
        let root = unique_temp_dir("rescan");
        let target = root.join("avd");
        let _ = std::fs::create_dir_all(&target);
        let Ok(att) = resolve_watch_attachment(&target) else {
            panic!("expected Target attachment");
        };
        let mut rescan = Event::new(notify::EventKind::Any);
        rescan.attrs.set_flag(notify::event::Flag::Rescan);
        assert!(matches!(
            classify_notify_result(&att, Ok(&rescan)),
            Some(DirWatchEvent::RestartNeeded(_))
        ));

        // Removing the watched folder triggers RestartNeeded on the next event.
        let _ = std::fs::remove_dir_all(&target);
        let ev = Event::new(notify::EventKind::Remove(notify::event::RemoveKind::Folder))
            .add_path(target.clone());
        assert!(matches!(
            classify_notify_result(&att, Ok(&ev)),
            Some(DirWatchEvent::RestartNeeded(_))
        ));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn live_notify_watch_detects_file_creation_in_target_directory() {
        let root = unique_temp_dir("live");
        let target = root.join("avd");
        let _ = std::fs::create_dir_all(&target);
        let (tx, mut rx) = mpsc::unbounded_channel();
        let handle = start_dir_watch(&target, tx);
        assert!(handle.is_ok());
        let Ok(_handle) = handle else {
            let _ = std::fs::remove_dir_all(&root);
            return;
        };
        assert!(_handle.is_on_target());

        let _ = std::fs::write(target.join("Pixel.ini"), b"path=Pixel.avd\n");
        let received = tokio::time::timeout(Duration::from_secs(5), rx.recv()).await;
        assert!(matches!(received, Ok(Some(DirWatchEvent::Changed))));
        drop(_handle);
        let _ = std::fs::remove_dir_all(&root);
    }
}
