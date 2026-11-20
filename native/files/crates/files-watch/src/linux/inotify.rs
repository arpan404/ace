// SPDX-License-Identifier: Apache-2.0

//! Linux's inotify, read directly, asking only for the events that change the tree.
//!
//! `notify`'s inotify watcher always registers `IN_OPEN` on every folder it watches, and offers no
//! way to leave it out. A content search or the quick-open walk opens every file of a checkout, so
//! each open queued an event that its thread read, turned into a path and handed over, only for
//! the watcher to drop it: about a fifth of a search's time on a large checkout went to it. This
//! watch asks for creates, deletes, renames, writes and attribute changes, nothing else, and turns
//! them into the same `notify` events the rest of the crate already translates.

use std::collections::HashMap;
use std::ffi::OsStr;
use std::os::fd::{AsFd, OwnedFd};
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread::JoinHandle;
use std::time::Duration;

use notify::event::{
    CreateKind, DataChange, EventKind, Flag, MetadataKind, ModifyKind, RemoveKind, RenameMode,
};
use notify::{Event, EventHandler};
use rustix::event::{EventfdFlags, PollFd, PollFlags, eventfd, poll};
use rustix::fs::inotify::{self, CreateFlags, ReadFlags, WatchFlags};
use rustix::io::Errno;

use crate::error::Error;
use crate::watch::Events;

/// What each folder watch asks the kernel for. Opens, reads and closes are left out: they change
/// nothing in the tree. `ONLYDIR` and `DONT_FOLLOW` keep a folder swapped for a link from taking a
/// watch on whatever the link points at.
fn mask() -> WatchFlags {
    WatchFlags::ATTRIB
        | WatchFlags::CREATE
        | WatchFlags::DELETE
        | WatchFlags::MODIFY
        | WatchFlags::MOVED_FROM
        | WatchFlags::MOVED_TO
        | WatchFlags::DELETE_SELF
        | WatchFlags::MOVE_SELF
        | WatchFlags::ONLYDIR
        | WatchFlags::DONT_FOLLOW
}

/// How long the reader rests after the kernel refused a read, so a broken descriptor cannot spin.
const READ_ERROR_PAUSE: Duration = Duration::from_millis(100);

/// The bytes one read of the descriptor may return: room for hundreds of events.
const BUFFER: usize = 64 * 1024;

/// One inotify instance with its reader thread. Dropping it stops the thread.
pub(crate) struct Inotify {
    fd: Arc<OwnedFd>,
    /// The folder each watch descriptor stands for. The kernel names events by descriptor, and
    /// a folder watched again under a new path (after a rename) keeps its descriptor.
    paths: Arc<Mutex<HashMap<i32, PathBuf>>>,
    stop: Arc<OwnedFd>,
    reader: Option<JoinHandle<()>>,
}

impl Inotify {
    /// Starts an instance that hands its events to `events`.
    pub(crate) fn start(events: Events) -> Result<Inotify, Error> {
        let unsupported = |error: Errno| Error::Unsupported(format!("inotify: {error}"));
        let fd = Arc::new(
            inotify::init(CreateFlags::CLOEXEC | CreateFlags::NONBLOCK).map_err(unsupported)?,
        );
        let stop = Arc::new(
            eventfd(0, EventfdFlags::CLOEXEC | EventfdFlags::NONBLOCK).map_err(unsupported)?,
        );
        let paths = Arc::new(Mutex::new(HashMap::new()));
        let reader = {
            let (fd, stop, paths) = (Arc::clone(&fd), Arc::clone(&stop), Arc::clone(&paths));
            std::thread::Builder::new()
                .name("files-watch inotify".to_owned())
                .spawn(move || read_loop(&fd, &stop, &paths, events))
                .map_err(|error| Error::Unsupported(format!("inotify reader: {error}")))?
        };
        Ok(Inotify {
            fd,
            paths,
            stop,
            reader: Some(reader),
        })
    }

    /// Watches one folder, not what is below it. The watch budget running out is the one error
    /// the caller acts on; any other failure leaves the folder unwatched, as a folder that went
    /// away or may not be read.
    pub(crate) fn watch(&self, path: &Path) -> Result<bool, Error> {
        match inotify::add_watch(&*self.fd, path, mask()) {
            Ok(descriptor) => {
                self.paths
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .insert(descriptor, path.to_path_buf());
                Ok(true)
            }
            Err(Errno::NOSPC) => Err(Error::Unsupported(format!(
                "inotify watch limit reached watching {}",
                path.display()
            ))),
            Err(_) => Ok(false),
        }
    }
}

impl Drop for Inotify {
    fn drop(&mut self) {
        let _ = rustix::io::write(&*self.stop, &1u64.to_ne_bytes());
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}

/// Reads the descriptor until the stop descriptor is written, handing each event over.
fn read_loop(
    fd: &OwnedFd,
    stop: &OwnedFd,
    paths: &Mutex<HashMap<i32, PathBuf>>,
    mut events: Events,
) {
    let mut buffer = vec![std::mem::MaybeUninit::<u8>::uninit(); BUFFER];
    let mut pairs = Renames::default();
    loop {
        let (ready, stopping) = {
            let mut fds = [
                PollFd::new(fd, PollFlags::IN),
                PollFd::new(stop, PollFlags::IN),
            ];
            match poll(&mut fds, None) {
                Ok(_) => (!fds[0].revents().is_empty(), !fds[1].revents().is_empty()),
                Err(Errno::INTR) => continue,
                Err(error) => {
                    events.handle_event(Err(notify::Error::io(error.into())));
                    std::thread::sleep(READ_ERROR_PAUSE);
                    continue;
                }
            }
        };
        if stopping {
            return;
        }
        if !ready {
            continue;
        }
        let mut reader = inotify::Reader::new(fd.as_fd(), &mut buffer);
        loop {
            let event = match reader.next() {
                Ok(event) => event,
                Err(Errno::AGAIN | Errno::INTR) => break,
                Err(error) => {
                    events.handle_event(Err(notify::Error::io(error.into())));
                    std::thread::sleep(READ_ERROR_PAUSE);
                    break;
                }
            };
            let flags = event.events();
            let named = {
                let mut paths = paths.lock().unwrap_or_else(PoisonError::into_inner);
                if flags.contains(ReadFlags::IGNORED) {
                    // The kernel dropped this watch: its folder went away or was unmounted.
                    paths.remove(&event.wd());
                    continue;
                }
                paths
                    .get(&event.wd())
                    .map(|folder| match event.file_name() {
                        Some(name) => folder.join(OsStr::from_bytes(name.to_bytes())),
                        None => folder.clone(),
                    })
            };
            for translated in translate(flags, named, event.cookie(), &mut pairs) {
                events.handle_event(Ok(translated));
            }
        }
    }
}

/// The old half of the last rename seen, waiting for its new half: inotify gives both the same
/// cookie, one after the other.
#[derive(Default)]
struct Renames {
    from: Option<(u32, PathBuf)>,
}

/// The `notify` events one inotify record stands for, in the order `notify` sends them. `path` is
/// `None` for a record about a watch this instance no longer knows, which says nothing unless it
/// is the kernel's overflow.
fn translate(
    flags: ReadFlags,
    path: Option<PathBuf>,
    cookie: u32,
    pairs: &mut Renames,
) -> Vec<Event> {
    let mut out = Vec::new();
    if flags.contains(ReadFlags::QUEUE_OVERFLOW) {
        out.push(Event::new(EventKind::Other).set_flag(Flag::Rescan));
    }
    let Some(path) = path else {
        return out;
    };
    let directory = flags.contains(ReadFlags::ISDIR);
    let event = |kind: EventKind| Event::new(kind).add_path(path.clone());
    let tracked = || usize::try_from(cookie).unwrap_or(usize::MAX);
    if flags.contains(ReadFlags::MOVED_FROM) {
        out.push(
            event(EventKind::Modify(ModifyKind::Name(RenameMode::From))).set_tracker(tracked()),
        );
        pairs.from = Some((cookie, path.clone()));
    } else if flags.contains(ReadFlags::MOVED_TO) {
        out.push(event(EventKind::Modify(ModifyKind::Name(RenameMode::To))).set_tracker(tracked()));
        if let Some((_, from)) = pairs.from.take_if(|(waiting, _)| *waiting == cookie) {
            out.push(
                Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Both)))
                    .set_tracker(tracked())
                    .add_path(from)
                    .add_path(path.clone()),
            );
        }
    }
    if flags.contains(ReadFlags::MOVE_SELF) {
        out.push(event(EventKind::Modify(ModifyKind::Name(RenameMode::From))));
    }
    if flags.contains(ReadFlags::CREATE) {
        out.push(event(EventKind::Create(if directory {
            CreateKind::Folder
        } else {
            CreateKind::File
        })));
    }
    if flags.contains(ReadFlags::DELETE) {
        out.push(event(EventKind::Remove(if directory {
            RemoveKind::Folder
        } else {
            RemoveKind::File
        })));
    }
    if flags.contains(ReadFlags::DELETE_SELF) {
        // Only folders are watched.
        out.push(event(EventKind::Remove(RemoveKind::Folder)));
    }
    if flags.contains(ReadFlags::MODIFY) {
        out.push(event(EventKind::Modify(ModifyKind::Data(DataChange::Any))));
    }
    if flags.contains(ReadFlags::ATTRIB) {
        out.push(event(EventKind::Modify(ModifyKind::Metadata(
            MetadataKind::Any,
        ))));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{Renames, translate};
    use notify::event::{CreateKind, EventKind, ModifyKind, RemoveKind, RenameMode};
    use rustix::fs::inotify::ReadFlags;
    use std::path::PathBuf;

    fn kinds(events: &[notify::Event]) -> Vec<EventKind> {
        events.iter().map(|event| event.kind).collect()
    }

    #[test]
    fn a_rename_in_two_records_ends_with_both_paths_in_one_event() {
        let mut pairs = Renames::default();
        let old = translate(
            ReadFlags::MOVED_FROM,
            Some(PathBuf::from("/r/old")),
            7,
            &mut pairs,
        );
        assert_eq!(
            kinds(&old),
            [EventKind::Modify(ModifyKind::Name(RenameMode::From))]
        );
        let new = translate(
            ReadFlags::MOVED_TO,
            Some(PathBuf::from("/r/new")),
            7,
            &mut pairs,
        );
        assert_eq!(
            kinds(&new),
            [
                EventKind::Modify(ModifyKind::Name(RenameMode::To)),
                EventKind::Modify(ModifyKind::Name(RenameMode::Both)),
            ]
        );
        assert_eq!(
            new[1].paths,
            [PathBuf::from("/r/old"), PathBuf::from("/r/new")]
        );
    }

    #[test]
    fn a_new_name_with_another_cookie_is_not_paired_with_a_waiting_old_one() {
        // A name moved out of the root and another moved in: two halves, two renames.
        let mut pairs = Renames::default();
        translate(
            ReadFlags::MOVED_FROM,
            Some(PathBuf::from("/r/out")),
            1,
            &mut pairs,
        );
        let moved_in = translate(
            ReadFlags::MOVED_TO,
            Some(PathBuf::from("/r/in")),
            2,
            &mut pairs,
        );
        assert_eq!(
            kinds(&moved_in),
            [EventKind::Modify(ModifyKind::Name(RenameMode::To))]
        );
    }

    #[test]
    fn a_folder_created_or_removed_says_it_is_a_folder() {
        let mut pairs = Renames::default();
        let path = || Some(PathBuf::from("/r/dir"));
        assert_eq!(
            kinds(&translate(
                ReadFlags::CREATE | ReadFlags::ISDIR,
                path(),
                0,
                &mut pairs
            )),
            [EventKind::Create(CreateKind::Folder)]
        );
        assert_eq!(
            kinds(&translate(
                ReadFlags::DELETE | ReadFlags::ISDIR,
                path(),
                0,
                &mut pairs
            )),
            [EventKind::Remove(RemoveKind::Folder)]
        );
        assert_eq!(
            kinds(&translate(ReadFlags::CREATE, path(), 0, &mut pairs)),
            [EventKind::Create(CreateKind::File)]
        );
    }

    #[test]
    fn an_overflow_asks_for_a_rescan_without_a_path() {
        let mut pairs = Renames::default();
        let events = translate(ReadFlags::QUEUE_OVERFLOW, None, 0, &mut pairs);
        assert_eq!(events.len(), 1);
        assert!(events[0].need_rescan());
        assert!(events[0].paths.is_empty());
    }

    #[test]
    fn a_record_for_a_forgotten_watch_says_nothing() {
        let mut pairs = Renames::default();
        assert!(translate(ReadFlags::CREATE, None, 0, &mut pairs).is_empty());
    }
}
