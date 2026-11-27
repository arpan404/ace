// SPDX-License-Identifier: Apache-2.0
//! The real file shell (`io.ts`, `file-watch.ts`, `temporary.ts`): a settings file is read
//! without following a symlink at its own path, written through a 0600 temporary file that is
//! fsynced and renamed with a last containment check, and watched through `notify`
//! directory watches.
//!
//! The shell is single-threaded. `notify` reports on its own thread into a queue, and
//! [`FsIo::pump`] delivers the queued changes to the registered callbacks, so a callback can
//! re-enter the shell (a reload re-watches its file). A host that embeds this shell calls
//! `pump` from its event loop.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};

use crate::file::{SettingsIo, Stop, Validate};
use crate::validation::{MAX_DOCUMENT_BYTES, SettingsCode, SettingsError};

/// How many directories keep a watch, and how many files one directory may carry.
const MAX_WATCHED_DIRECTORIES: usize = 128;
const MAX_WATCHERS_PER_DIRECTORY: usize = 128;
/// How often a mount point that does not exist yet is checked.
const MISSING_POLL: Duration = Duration::from_millis(500);
/// How many sibling directories are inspected to recover a temporary file whose folder moved.
const MAX_SIBLINGS: usize = 128;

fn io_error() -> SettingsError {
    SettingsError::new(SettingsCode::Io, "Cannot read or write settings file")
}

fn size_error() -> SettingsError {
    SettingsError::new(SettingsCode::Size, "Settings document exceeds 1 MiB")
}

/// The real filesystem port.
pub struct FsIo {
    hub: Rc<RefCell<WatchHub>>,
}

impl Default for FsIo {
    fn default() -> Self {
        Self::new()
    }
}

impl FsIo {
    pub fn new() -> Self {
        let (sender, events) = mpsc::channel();
        let missing: Arc<Mutex<std::collections::BTreeSet<PathBuf>>> = Arc::default();
        let stop = Arc::new(AtomicBool::new(false));
        spawn_missing_poll(missing.clone(), sender.clone(), stop.clone());
        Self {
            hub: Rc::new(RefCell::new(WatchHub {
                directories: BTreeMap::new(),
                listeners: BTreeMap::new(),
                next_directory: 0,
                next_listener: 0,
                missing,
                stop,
                sender,
                events,
            })),
        }
    }

    /// Delivers every queued watch event to its callbacks. Returns whether any ran. Call it
    /// from the thread that owns the service: the callbacks are not `Send`.
    pub fn pump(&self) -> bool {
        let mut changed: Vec<Rc<dyn Fn()>> = Vec::new();
        let mut failed: Vec<Rc<dyn Fn()>> = Vec::new();
        {
            let hub = self.hub.borrow();
            loop {
                match hub.events.try_recv() {
                    Ok(HubEvent::Paths(directory, paths)) => {
                        for listener in hub.listeners.values() {
                            if listener.directory != directory {
                                continue;
                            }
                            let touched =
                                paths.is_empty() || paths.iter().any(|path| listener.owns(path));
                            if touched {
                                changed.push(listener.changed.clone());
                            }
                        }
                    }
                    Ok(HubEvent::Failed(directory)) => {
                        for listener in hub.listeners.values() {
                            if listener.directory == directory {
                                failed.push(listener.failed.clone());
                            }
                        }
                    }
                    Ok(HubEvent::Appeared(path)) => {
                        for listener in hub.listeners.values() {
                            if listener.missing.as_ref() == Some(&path) {
                                changed.push(listener.changed.clone());
                            }
                        }
                    }
                    Err(TryRecvError::Empty | TryRecvError::Disconnected) => break,
                }
            }
        }
        let called = !changed.is_empty() || !failed.is_empty();
        for callback in failed {
            callback();
        }
        for callback in changed {
            callback();
        }
        called
    }
}

impl Drop for FsIo {
    fn drop(&mut self) {
        self.hub.borrow().stop.store(true, Ordering::Relaxed);
    }
}

impl SettingsIo for FsIo {
    fn read(&self, path: &Path) -> Result<Option<String>, SettingsError> {
        read_bounded(path)
    }

    fn write(
        &self,
        path: &Path,
        text: &str,
        before_commit: Option<&Validate>,
    ) -> Result<(), SettingsError> {
        atomic_write(path, text, before_commit)
    }

    fn watch(
        &self,
        path: &Path,
        changed: Rc<dyn Fn()>,
        failed: Rc<dyn Fn()>,
    ) -> Result<Stop, SettingsError> {
        let mut hub = self.hub.borrow_mut();
        let parent = path.parent().ok_or_else(io_error)?;
        let (ancestor, missing) = nearest_existing(parent)?;
        let child = relative_first(&ancestor, path);
        if !hub.directories.contains_key(&ancestor) {
            if hub.directories.len() >= MAX_WATCHED_DIRECTORIES {
                return Err(SettingsError::new(
                    SettingsCode::Limit,
                    "Settings watcher limit reached",
                ));
            }
            let sender = hub.sender.clone();
            let id = hub.next_directory;
            hub.next_directory += 1;
            let watcher =
                notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                    let message = match event {
                        Ok(event) => HubEvent::Paths(id, event.paths),
                        Err(_) => HubEvent::Failed(id),
                    };
                    let _ = sender.send(message);
                })
                .map_err(|_| SettingsError::new(SettingsCode::Io, "Settings watcher failed"))?;
            hub.directories.insert(
                ancestor.clone(),
                DirectoryWatch {
                    id,
                    watcher,
                    refs: 0,
                },
            );
        }
        let entry = hub.directories.get_mut(&ancestor).ok_or_else(io_error)?;
        let directory = entry.id;
        if entry.refs >= MAX_WATCHERS_PER_DIRECTORY {
            return Err(SettingsError::new(
                SettingsCode::Limit,
                "Settings watcher subscriber limit reached",
            ));
        }
        if entry.refs == 0 {
            entry
                .watcher
                .watch(&ancestor, RecursiveMode::NonRecursive)
                .map_err(|_| SettingsError::new(SettingsCode::Io, "Settings watcher failed"))?;
        }
        entry.refs += 1;
        let id = hub.next_listener;
        hub.next_listener += 1;
        if let Some(missing) = &missing {
            hub.missing
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .insert(missing.clone());
        }
        hub.listeners.insert(
            id,
            Listener {
                directory,
                child,
                missing,
                changed,
                failed,
            },
        );
        let hub = self.hub.clone();
        Ok(Box::new(move || {
            let mut hub = hub.borrow_mut();
            let Some(listener) = hub.listeners.remove(&id) else {
                return;
            };
            let watched = hub
                .directories
                .iter()
                .find(|(_, entry)| entry.id == listener.directory)
                .map(|(path, _)| path.clone());
            let mut done = false;
            if let Some(path) = &watched
                && let Some(entry) = hub.directories.get_mut(path)
            {
                entry.refs = entry.refs.saturating_sub(1);
                if entry.refs == 0 {
                    let _ = entry.watcher.unwatch(path);
                    done = true;
                }
            }
            if done && let Some(path) = watched {
                hub.directories.remove(&path);
            }
            let still_wanted = hub
                .listeners
                .values()
                .any(|other| other.missing == listener.missing);
            if !still_wanted && let Some(missing) = &listener.missing {
                hub.missing
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .remove(missing);
            }
        }))
    }
}

/// One directory's watch and how many files have registered on it.
struct DirectoryWatch {
    /// The id its events carry, so a path spelled through a symlink still matches.
    id: usize,
    watcher: RecommendedWatcher,
    refs: usize,
}

/// One file's registration on a directory watch.
struct Listener {
    directory: usize,
    /// The first path component below the watched directory, so a sibling write is ignored.
    child: String,
    /// A directory between the watched ancestor and the file that does not exist yet.
    missing: Option<PathBuf>,
    changed: Rc<dyn Fn()>,
    failed: Rc<dyn Fn()>,
}

impl Listener {
    fn owns(&self, path: &Path) -> bool {
        match &self.missing {
            // The watched directory is the file's own: an event on the file names it.
            None => path
                .file_name()
                .map(|name| name.to_string_lossy() == self.child)
                .unwrap_or(false),
            // The watched directory is above a folder that did not exist yet: the event
            // names that folder when it appears.
            Some(missing) => {
                path == missing
                    || (path.exists()
                        && std::fs::canonicalize(path).ok() == std::fs::canonicalize(missing).ok())
            }
        }
    }
}

struct WatchHub {
    directories: BTreeMap<PathBuf, DirectoryWatch>,
    listeners: BTreeMap<usize, Listener>,
    next_directory: usize,
    next_listener: usize,
    missing: Arc<Mutex<std::collections::BTreeSet<PathBuf>>>,
    stop: Arc<AtomicBool>,
    sender: Sender<HubEvent>,
    events: Receiver<HubEvent>,
}

#[derive(Debug)]
enum HubEvent {
    /// A watched directory (by id) reported changes to these paths.
    Paths(usize, Vec<PathBuf>),
    /// A watched directory's (by id) source failed.
    Failed(usize),
    /// A polled directory now exists.
    Appeared(PathBuf),
}

/// A pattern that fixes no path waits for it, as `createMissingDirectoryPoll` does.
fn spawn_missing_poll(
    missing: Arc<Mutex<std::collections::BTreeSet<PathBuf>>>,
    sender: Sender<HubEvent>,
    stop: Arc<AtomicBool>,
) {
    std::thread::spawn(move || {
        while !stop.load(Ordering::Relaxed) {
            std::thread::sleep(MISSING_POLL);
            let appeared: Vec<PathBuf> = {
                let missing = missing.lock().unwrap_or_else(|error| error.into_inner());
                missing
                    .iter()
                    .filter(|path| path.exists())
                    .cloned()
                    .collect()
            };
            for path in appeared {
                missing
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .remove(&path);
                if sender.send(HubEvent::Appeared(path)).is_err() {
                    return;
                }
            }
        }
    });
}

/// The nearest ancestor of `parent` that exists, and the missing path below it when the
/// parent itself does not.
fn nearest_existing(parent: &Path) -> Result<(PathBuf, Option<PathBuf>), SettingsError> {
    let mut current = parent.to_path_buf();
    loop {
        match std::fs::metadata(&current) {
            Ok(_) => {
                let missing =
                    (current != parent).then(|| current.join(relative_first(&current, parent)));
                return Ok((current, missing));
            }
            Err(error) if error.kind() == ErrorKind::NotFound => {
                let next = current.parent().map(Path::to_path_buf);
                match next {
                    Some(next) if next != current => current = next,
                    _ => return Err(io_error()),
                }
            }
            Err(_) => return Err(io_error()),
        }
    }
}

/// The first component of `path` below `ancestor`.
fn relative_first(ancestor: &Path, path: &Path) -> String {
    path.strip_prefix(ancestor)
        .ok()
        .and_then(|rest| rest.components().next())
        .map(|component| component.as_os_str().to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// `readBounded`: no symlink at the file's own path, a regular file, at most 1 MiB, UTF-8.
pub fn read_bounded(path: &Path) -> Result<Option<String>, SettingsError> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let mut file = match options.open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(io_error()),
    };
    let metadata = file.metadata().map_err(|_| io_error())?;
    if !metadata.is_file() {
        return Err(SettingsError::new(
            SettingsCode::Validation,
            "Settings file must be a regular file",
        ));
    }
    if metadata.len() > MAX_DOCUMENT_BYTES as u64 {
        return Err(size_error());
    }
    let mut buffer = Vec::with_capacity(metadata.len() as usize + 1);
    (&mut file)
        .take(MAX_DOCUMENT_BYTES as u64 + 1)
        .read_to_end(&mut buffer)
        .map_err(|_| io_error())?;
    if buffer.len() > MAX_DOCUMENT_BYTES {
        return Err(size_error());
    }
    String::from_utf8(buffer)
        .map(Some)
        .map_err(|_| SettingsError::new(SettingsCode::Parse, "Settings file is not valid UTF-8"))
}

/// `atomicWrite`: a 0600 temporary file in the same folder, synced, checked, renamed, and the
/// folder synced. A failed write removes its temporary file, even when the folder was moved.
pub fn atomic_write(
    path: &Path,
    text: &str,
    before_commit: Option<&Validate>,
) -> Result<(), SettingsError> {
    let parent = path.parent().ok_or_else(io_error)?;
    std::fs::create_dir_all(parent).map_err(|_| io_error())?;
    let temporary = parent.join(temporary_name(path));
    let directory = std::fs::File::open(parent).map_err(|_| io_error())?;
    let mut temporary_exists = false;
    let result = (|| -> Result<(), SettingsError> {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary).map_err(|_| io_error())?;
        temporary_exists = true;
        file.write_all(text.as_bytes()).map_err(|_| io_error())?;
        file.sync_all().map_err(|_| io_error())?;
        drop(file);
        if let Some(before_commit) = before_commit {
            before_commit()?;
        }
        std::fs::rename(&temporary, path).map_err(|_| io_error())?;
        temporary_exists = false;
        file_sync(&directory)?;
        Ok(())
    })();
    if result.is_err() && temporary_exists {
        let cleaned = remove_temporary(&temporary, &directory);
        drop(cleaned);
    }
    result
}

#[cfg(unix)]
fn file_sync(directory: &std::fs::File) -> Result<(), SettingsError> {
    directory.sync_all().map_err(|_| io_error())
}

/// Windows cannot flush a directory handle (EPERM); NTFS journals the rename itself.
#[cfg(not(unix))]
fn file_sync(_directory: &std::fs::File) -> Result<(), SettingsError> {
    Ok(())
}

/// A UUIDv4 temporary name in the destination's folder.
fn temporary_name(path: &Path) -> String {
    let mut bytes = [0u8; 16];
    let _ = getrandom::fill(&mut bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    format!(
        ".{name}.{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}.tmp",
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
        bytes[6],
        bytes[7],
        bytes[8],
        bytes[9],
        bytes[10],
        bytes[11],
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15]
    )
}

/// `removeTemporary`: only the original folder is recovered by identity; a replaced symlink
/// is never followed for cleanup.
fn remove_temporary(temporary: &Path, owner: &std::fs::File) -> Result<(), SettingsError> {
    let original = match (owner.metadata(), temporary.parent()) {
        (Ok(metadata), Some(parent)) => (identity_of(&metadata), parent.to_path_buf()),
        _ => return Err(io_error()),
    };
    let (owner_identity, parent) = original;
    if std::fs::metadata(&parent)
        .map(|metadata| identity_of(&metadata) == owner_identity)
        .unwrap_or(false)
    {
        return remove_file(temporary);
    }
    let grandparent = match parent.parent() {
        Some(path) => path.to_path_buf(),
        None => return Err(io_error()),
    };
    let entries = match std::fs::read_dir(&grandparent) {
        Ok(entries) => entries,
        Err(_) => return Err(io_error()),
    };
    let name = temporary.file_name().map(PathBuf::from);
    let Some(name) = name else {
        return Err(io_error());
    };
    for (inspected, entry) in entries.flatten().enumerate() {
        if inspected >= MAX_SIBLINGS {
            break;
        }
        let Ok(metadata) = std::fs::symlink_metadata(entry.path()) else {
            continue;
        };
        if !metadata.is_dir() {
            continue;
        }
        if identity_of(&metadata) == owner_identity {
            return remove_file(&entry.path().join(&name));
        }
    }
    Err(SettingsError::new(
        SettingsCode::Io,
        "Cannot locate moved settings directory for temporary cleanup",
    ))
}

fn remove_file(path: &Path) -> Result<(), SettingsError> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(_) => Err(io_error()),
    }
}

#[cfg(unix)]
fn identity_of(metadata: &std::fs::Metadata) -> (u64, u64) {
    use std::os::unix::fs::MetadataExt;
    (metadata.dev(), metadata.ino())
}

#[cfg(not(unix))]
fn identity_of(_metadata: &std::fs::Metadata) -> (u64, u64) {
    (0, 0)
}

#[cfg(test)]
mod tests {
    //! The read's refusals, checked where they are cheap: the real folder cases live in
    //! `tests/io.rs`.

    use super::*;

    #[test]
    fn an_oversized_text_is_a_size_diagnostic_not_a_truncated_read() {
        let directory =
            std::env::temp_dir().join(format!("ace-settings-io-read-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(&directory).unwrap_or_else(|error| panic!("{error}"));
        let path = directory.join("settings.json");
        std::fs::write(&path, vec![b' '; MAX_DOCUMENT_BYTES + 1])
            .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(
            read_bounded(&path).map(|_| ()).map_err(|error| error.code),
            Err(SettingsCode::Size)
        );
        std::fs::write(&path, [0xff, 0xfe, b'{']).unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(
            read_bounded(&path).map(|_| ()).map_err(|error| error.code),
            Err(SettingsCode::Parse)
        );
        assert!(
            read_bounded(&directory.join("absent.json"))
                .unwrap_or_else(|error| panic!("{error}"))
                .is_none()
        );
        let _ = std::fs::remove_dir_all(&directory);
    }

    #[test]
    fn a_temporary_name_is_a_hidden_uuid_in_the_destinations_folder() {
        let name = temporary_name(Path::new("/repo/.ace/settings.json"));
        assert!(name.starts_with(".settings.json."), "{name}");
        assert!(name.ends_with(".tmp"), "{name}");
        let unique: std::collections::BTreeSet<String> = (0..32)
            .map(|_| temporary_name(Path::new("/repo/.ace/settings.json")))
            .collect();
        assert_eq!(unique.len(), 32);
    }
}
