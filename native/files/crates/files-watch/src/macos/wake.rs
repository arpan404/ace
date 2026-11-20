// SPDX-License-Identifier: Apache-2.0

//! The kernel's word that an open folder changed, so the safety net checks it at once.
//!
//! FSEvents goes through fseventsd, which on a busy Mac hands a lone change over hundreds of
//! milliseconds late, or minutes late after a burst anywhere on the volume. kqueue does not: a
//! `NOTE_WRITE` on a folder's handle fires as the kernel changes its entries. Each open folder's
//! handle is registered with one kqueue, and a thread waiting on it tells the worker which folder
//! moved; the worker then lists that folder through the net. Only the first [`MAX_WOKEN`] open
//! folders get a handle, because every one is a descriptor held for as long as the folder is open
//! and macOS starts a process with 256; the rest are checked by the net's timer alone.
//!
//! Every `unsafe` block is a `libc` call on the kqueue, and each carries a `SAFETY` comment.

use std::collections::BTreeMap;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread::JoinHandle;

use files_safe::Root;

use crate::watch::Events;

/// The most open folders that hold a kqueue handle, the root first.
const MAX_WOKEN: usize = 64;

/// The user event that tells the thread to finish.
const STOP: usize = 1;

/// What a folder's handle reports: its entries changed, it was linked, or it went away.
const VNODE_NOTES: u32 =
    libc::NOTE_WRITE | libc::NOTE_LINK | libc::NOTE_DELETE | libc::NOTE_RENAME | libc::NOTE_REVOKE;

/// Notes after which the handle no longer names the open folder and must be opened again.
const GONE_NOTES: u32 = libc::NOTE_DELETE | libc::NOTE_RENAME | libc::NOTE_REVOKE;

/// Which folder each registered descriptor belongs to, shared with the waiting thread.
type Names = Arc<Mutex<BTreeMap<RawFd, String>>>;

/// One kqueue over the open folders, and the thread waiting on it.
pub(crate) struct Wake {
    queue: Arc<OwnedFd>,
    names: Names,
    held: BTreeMap<String, cap_std::fs::Dir>,
    thread: Option<JoinHandle<()>>,
}

impl Wake {
    /// Creates the kqueue and its thread, or `None` if either cannot be had; the net's timer
    /// still checks every open folder then.
    pub(crate) fn start(events: Events) -> Option<Wake> {
        // SAFETY: kqueue takes no arguments and returns a new descriptor or -1.
        let raw = unsafe { libc::kqueue() };
        if raw < 0 {
            return None;
        }
        // SAFETY: `raw` is a descriptor this function just created and nothing else owns.
        let queue = Arc::new(unsafe { OwnedFd::from_raw_fd(raw) });
        if !change(&queue, user(libc::EV_ADD | libc::EV_CLEAR, 0)) {
            return None;
        }
        let names: Names = Arc::new(Mutex::new(BTreeMap::new()));
        let thread = {
            let queue = Arc::clone(&queue);
            let names = Arc::clone(&names);
            std::thread::Builder::new()
                .name("files-watch-wake".to_owned())
                .spawn(move || wait(&queue, &names, &events))
                .ok()?
        };
        Some(Wake {
            queue,
            names,
            held: BTreeMap::new(),
            thread: Some(thread),
        })
    }

    /// Holds a handle on the first [`MAX_WOKEN`] of `folders` and lets go of the rest.
    pub(crate) fn follow<'a>(&mut self, root: &Root, folders: impl Iterator<Item = &'a str>) {
        let wanted: Vec<&str> = folders.take(MAX_WOKEN).collect();
        let gone: Vec<String> = self
            .held
            .keys()
            .filter(|folder| !wanted.contains(&folder.as_str()))
            .cloned()
            .collect();
        for folder in gone {
            self.release(&folder);
        }
        for folder in wanted {
            if !self.held.contains_key(folder) {
                self.hold(root, folder);
            }
        }
    }

    /// The handle on `folder` went with a folder that was moved or removed: open the one there
    /// now, if any.
    pub(crate) fn rearm(&mut self, root: &Root, folder: &str) {
        if self.release(folder) {
            self.hold(root, folder);
        }
    }

    fn hold(&mut self, root: &Root, folder: &str) {
        let Ok(dir) = root.open_dir(folder) else {
            return;
        };
        let fd = dir.as_raw_fd();
        self.names
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(fd, folder.to_owned());
        if change(&self.queue, vnode(fd)) {
            self.held.insert(folder.to_owned(), dir);
        } else {
            self.names
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .remove(&fd);
        }
    }

    /// Lets go of a folder's handle; closing it removes its registration. False if none was held.
    fn release(&mut self, folder: &str) -> bool {
        let Some(dir) = self.held.remove(folder) else {
            return false;
        };
        self.names
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&dir.as_raw_fd());
        drop(dir);
        true
    }
}

impl Drop for Wake {
    fn drop(&mut self) {
        change(&self.queue, user(0, libc::NOTE_TRIGGER));
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// Waits for folder notes and tells the worker which folder moved, until the stop event fires.
fn wait(queue: &OwnedFd, names: &Names, events: &Events) {
    // SAFETY: an all-zero kevent is a valid value of this plain C struct; the kernel fills it.
    let mut fired: [libc::kevent; 32] = unsafe { std::mem::zeroed() };
    loop {
        // SAFETY: the queue is open for as long as this thread runs, because the `Arc` keeps it,
        // and `fired` is a writable buffer of the length passed. No changes are submitted.
        let count = unsafe {
            libc::kevent(
                queue.as_raw_fd(),
                std::ptr::null(),
                0,
                fired.as_mut_ptr(),
                fired.len() as libc::c_int,
                std::ptr::null(),
            )
        };
        if count < 0 {
            if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            return;
        }
        let count = usize::try_from(count).unwrap_or(0).min(fired.len());
        for event in &fired[..count] {
            if event.filter == libc::EVFILT_USER {
                return;
            }
            let Ok(fd) = RawFd::try_from(event.ident) else {
                continue;
            };
            let folder = names
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .get(&fd)
                .cloned();
            if let Some(folder) = folder {
                events.poke(folder, event.fflags & GONE_NOTES != 0);
            }
        }
    }
}

/// The registration for a folder's handle.
fn vnode(fd: RawFd) -> libc::kevent {
    libc::kevent {
        ident: usize::try_from(fd).unwrap_or(usize::MAX),
        filter: libc::EVFILT_VNODE,
        flags: libc::EV_ADD | libc::EV_CLEAR,
        fflags: VNODE_NOTES,
        data: 0,
        udata: std::ptr::null_mut(),
    }
}

/// The stop event, added or triggered.
fn user(flags: u16, fflags: u32) -> libc::kevent {
    libc::kevent {
        ident: STOP,
        filter: libc::EVFILT_USER,
        flags,
        fflags,
        data: 0,
        udata: std::ptr::null_mut(),
    }
}

/// Submits one change to the queue. False when the kernel refused it.
fn change(queue: &OwnedFd, event: libc::kevent) -> bool {
    // SAFETY: the queue is open, `event` is one valid kevent read by the kernel, and no events
    // are collected, so no output buffer is needed.
    let result = unsafe {
        libc::kevent(
            queue.as_raw_fd(),
            &raw const event,
            1,
            std::ptr::null_mut(),
            0,
            std::ptr::null(),
        )
    };
    result >= 0
}
