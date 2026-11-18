// SPDX-License-Identifier: Apache-2.0

//! Windows: one recursive `ReadDirectoryChangesW` watch, so a lost-event status becomes a rescan.
//!
//! `notify`'s Windows backend throws away the two statuses that say the kernel's change buffer
//! ran out — a zero-length completion and `ERROR_NOTIFY_ENUM_DIR` — so a burst larger than the
//! buffer loses changes without ever asking for a rescan. This backend issues the same call
//! itself, overlapped, on one thread with a 64 KiB buffer: either status becomes an event with
//! `Flag::Rescan`, which the coalescer turns into `Batch::Rescan { dir: None }`, and the watch
//! is armed again for the next batch. Rename records name the old path and the new one; each
//! maps to the same `notify` event the rest of the crate already translates, so Linux and macOS
//! keep `notify` and this module only supplies the events.
//!
//! Every `unsafe` block is a call into `windows-sys`, and each one carries a `SAFETY` comment
//! naming what keeps it sound.

#![allow(unsafe_code)]

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, SyncSender};
use std::thread::JoinHandle;
use std::time::Duration;

use files_safe::Root;
use notify::Event;
use notify::event::{EventKind, ModifyKind, RenameMode};
use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_IO_PENDING, ERROR_NOTIFY_ENUM_DIR, ERROR_OPERATION_ABORTED, HANDLE,
    INVALID_HANDLE_VALUE, WAIT_FAILED, WAIT_OBJECT_0,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_ACTION_RENAMED_NEW_NAME, FILE_ACTION_RENAMED_OLD_NAME,
    FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OVERLAPPED, FILE_LIST_DIRECTORY,
    FILE_NOTIFY_CHANGE_ATTRIBUTES, FILE_NOTIFY_CHANGE_CREATION, FILE_NOTIFY_CHANGE_DIR_NAME,
    FILE_NOTIFY_CHANGE_FILE_NAME, FILE_NOTIFY_CHANGE_LAST_WRITE, FILE_NOTIFY_CHANGE_SIZE,
    FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING, ReadDirectoryChangesW,
};
use windows_sys::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};
use windows_sys::Win32::System::Threading::{
    CreateEventW, INFINITE, ResetEvent, SetEvent, WaitForMultipleObjects, WaitForSingleObject,
};

use crate::error::Error;
use crate::exclude::Excluder;
use crate::translate::Notice;
use crate::watch::Events;

mod records;

use records::{kind, parse};

/// The kernel buffer for one delivery, as the plan asks.
const BUFFER_BYTES: usize = 64 * 1024;

/// How long [`Watch::start`] waits for the thread to issue its first read.
const ARMING: Duration = Duration::from_secs(5);

/// What the watch asks the kernel to report; the same set `notify` requests.
const FILTER: u32 = FILE_NOTIFY_CHANGE_FILE_NAME
    | FILE_NOTIFY_CHANGE_DIR_NAME
    | FILE_NOTIFY_CHANGE_ATTRIBUTES
    | FILE_NOTIFY_CHANGE_SIZE
    | FILE_NOTIFY_CHANGE_LAST_WRITE
    | FILE_NOTIFY_CHANGE_CREATION;

/// One recursive Windows watch.
pub(crate) struct Watch {
    stop: Handle,
    worker: Option<JoinHandle<()>>,
}

impl Watch {
    /// Opens the root and starts the thread that owns the recursive watch.
    pub(crate) fn start(root: &Root, _excluder: &Excluder, events: Events) -> Result<Watch, Error> {
        let directory = open_directory(root.path())?;
        let stop = match create_event() {
            Ok(event) => event,
            Err(error) => {
                directory.close();
                return Err(error);
            }
        };
        let completion = match create_event() {
            Ok(event) => event,
            Err(error) => {
                directory.close();
                stop.close();
                return Err(error);
            }
        };
        let watched = root.path().to_path_buf();
        // The first read must be issued before `start` returns: a change made before the call
        // is up is a change nobody hears about, and a caller that writes immediately after
        // `start` would miss its own file.
        let (started, armed) = mpsc::sync_channel(1);
        let worker = std::thread::Builder::new()
            .name("files-watch-windows".to_owned())
            .spawn(move || run(&watched, directory, stop, completion, events, started));
        let worker = match worker {
            Ok(worker) => worker,
            Err(error) => {
                directory.close();
                stop.close();
                completion.close();
                return Err(Error::Unsupported(format!(
                    "cannot start the file watching thread: {error}"
                )));
            }
        };
        match armed.recv_timeout(ARMING) {
            Ok(Ok(())) => Ok(Watch {
                stop,
                worker: Some(worker),
            }),
            failed => {
                // SAFETY: the stop event is open until it is closed below; signalling it
                // wakes the thread's wait so it can finish and be joined.
                unsafe { SetEvent(stop.0) };
                let _ = worker.join();
                stop.close();
                let message = match failed {
                    Ok(Err(message)) => message,
                    _ => "the file watch did not start in time".to_owned(),
                };
                Err(Error::Unsupported(message))
            }
        }
    }

    /// The watch is recursive: folders that appear are already covered.
    pub(crate) fn adopt(
        &mut self,
        _root: &Root,
        _excluder: &Excluder,
        _notices: &mut Vec<Notice>,
    ) -> Result<(), Error> {
        Ok(())
    }

    /// The thread arms the watch again after every overflow, so there is nothing to rebuild.
    pub(crate) fn rescan(
        &mut self,
        _root: &Root,
        _excluder: &Excluder,
        _dir: Option<&str>,
    ) -> Result<(), Error> {
        Ok(())
    }

    pub(crate) fn stop(self) {
        drop(self);
    }
}

impl Drop for Watch {
    fn drop(&mut self) {
        // SAFETY: the stop event stays open until this function closes it, and SetEvent only
        // marks the kernel object; the thread waiting on it wakes and finishes.
        unsafe { SetEvent(self.stop.0) };
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
        self.stop.close();
    }
}

/// A Windows kernel handle.
///
/// A handle names a kernel object, not memory, and a copy still names the same object.
/// `Copy` is deliberate: the watch thread waits on the stop event while [`Watch`] signals it.
/// Each handle has exactly one closer — the thread closes the directory and completion events
/// before it returns, and [`Watch`] closes the stop event after joining it.
#[derive(Clone, Copy)]
struct Handle(HANDLE);

// SAFETY: a HANDLE names a kernel object rather than memory, and Windows lets any thread wait
// on or signal the object it names.
unsafe impl Send for Handle {}

impl Handle {
    /// Closes the object; the caller must be its only closer.
    fn close(self) {
        // SAFETY: the caller owns this handle and closes it exactly once.
        unsafe { CloseHandle(self.0) };
    }
}

/// The watch thread: issue one overlapped read at a time and translate what it returns.
///
/// Reports `Ok` through `started` once the first read is up, so the caller knows the watch is
/// armed, or the reason it never was.
fn run(
    root: &Path,
    directory: Handle,
    stop: Handle,
    completion: Handle,
    events: Events,
    started: SyncSender<Result<(), String>>,
) {
    // The kernel documents a four-byte-aligned buffer for its records, so the bytes live in
    // `u32`s rather than a byte vector. Both it and `overlapped` are locals: this thread never
    // returns while a read it issued may still write into either, because every exit path waits
    // for the completion or cancels the read and drains the cancellation.
    let mut buffer = vec![0u32; BUFFER_BYTES / 4];
    let mut overlapped = OVERLAPPED {
        hEvent: completion.0,
        ..OVERLAPPED::default()
    };
    let mut renames = Rename::default();
    let mut armed = false;
    loop {
        // A status the kernel keeps returning without a completion (a directory that cannot be
        // read any more, say) would otherwise spin here, and the join in `Watch::drop` would
        // never finish. The owner's stop ends the thread before the next read is issued.
        if stopping(stop) {
            break;
        }
        // SAFETY: the directory handle stays open until this thread returns; the buffer is
        // writable for its whole length and four-byte aligned (it is `u32`s), and it is not
        // touched again until the operation below completes; `overlapped` is a valid structure
        // whose event stays open until then; the byte count is unused for an overlapped read, so
        // a null pointer is what the call expects; and a null completion routine is what an
        // overlapped caller passes.
        let read = unsafe {
            ReadDirectoryChangesW(
                directory.0,
                buffer.as_mut_ptr().cast(),
                BUFFER_BYTES as u32,
                1,
                FILTER,
                std::ptr::null_mut(),
                &mut overlapped,
                None,
            )
        };
        if read == 0 {
            let error = std::io::Error::last_os_error();
            let code = error.raw_os_error();
            if code == Some(ERROR_NOTIFY_ENUM_DIR as i32) {
                // The new half of a rename may be among the lost records.
                renames.clear();
                events.lost_events();
                continue;
            }
            // A queued overlapped read is a success that has not completed yet; wait for it.
            if code != Some(ERROR_IO_PENDING as i32) {
                fail(
                    &started,
                    armed,
                    format!("cannot watch {}: {error}", root.display()),
                    &events,
                );
                break;
            }
        }
        if !armed {
            armed = true;
            let _ = started.send(Ok(()));
        }
        let handles = [stop.0, completion.0];
        // SAFETY: both handles stay open until this thread returns, and the array holds the
        // two entries the count names; waiting touches no buffer.
        let waited = unsafe { WaitForMultipleObjects(2, handles.as_ptr(), 0, INFINITE) };
        let mut bytes = 0u32;
        if waited != WAIT_OBJECT_0 + 1 {
            if waited == WAIT_FAILED {
                let error = std::io::Error::last_os_error();
                events.failed(&format!("cannot wait for the file watch: {error}"));
            }
            // SAFETY: this cancels the one operation this thread issued. Waiting on the
            // overlapped result then keeps the kernel from writing into `buffer` after this
            // function returns and frees it.
            unsafe {
                CancelIoEx(directory.0, &overlapped);
                GetOverlappedResult(directory.0, &overlapped, &mut bytes, 1);
            }
            break;
        }
        // SAFETY: the completion event is signalled, so this reports the operation just
        // issued; `bytes` is a valid out pointer, and the buffer stays alive until it returns.
        let finished = unsafe { GetOverlappedResult(directory.0, &overlapped, &mut bytes, 1) };
        if finished == 0 {
            let error = std::io::Error::last_os_error();
            let code = error.raw_os_error();
            if code == Some(ERROR_NOTIFY_ENUM_DIR as i32) {
                renames.clear();
                events.lost_events();
            } else {
                // An abort is the owner stopping the watch; any other status means the native
                // watch is gone for good, and the worker must hear it and fall back.
                let aborted = code == Some(ERROR_OPERATION_ABORTED as i32);
                if !(aborted && stopping(stop)) {
                    events.failed(&format!("cannot watch {}: {error}", root.display()));
                }
                break;
            }
        } else if bytes == 0 {
            // A completion with nothing in it is the kernel saying its buffer ran out.
            renames.clear();
            events.lost_events();
        } else {
            // SAFETY: this is the completed read's byte count, inside the buffer this thread
            // owns; the buffer is alive because the thread waits on every operation before it
            // returns.
            let filled =
                unsafe { std::slice::from_raw_parts(buffer.as_ptr().cast::<u8>(), bytes as usize) };
            emit(root, filled, &events, &mut renames);
        }
        // SAFETY: this resets this thread's own manual-reset completion event before the next
        // read; the event stays open until the thread returns.
        unsafe { ResetEvent(completion.0) };
    }
    completion.close();
    directory.close();
}

/// Reports a dead watch to the worker, or to the caller while it is still starting one.
fn fail(started: &SyncSender<Result<(), String>>, armed: bool, message: String, events: &Events) {
    if armed {
        events.failed(&message);
    } else {
        let _ = started.send(Err(message));
    }
}

/// Whether the owner asked the watch to stop.
fn stopping(stop: Handle) -> bool {
    // SAFETY: the stop event is open for the whole thread, and a zero-timeout wait only reads
    // its state.
    unsafe { WaitForSingleObject(stop.0, 0) == WAIT_OBJECT_0 }
}

/// Opens a folder for change notifications, recursively.
fn open_directory(path: &Path) -> Result<Handle, Error> {
    let name = wide(path.as_os_str());
    // SAFETY: `name` is NUL-terminated and outlives the call; the access, share, creation and
    // flag values are the documented ones for a folder watched with overlapped reads; and a
    // null security descriptor and template handle are what the call expects.
    let handle = unsafe {
        CreateFileW(
            name.as_ptr(),
            FILE_LIST_DIRECTORY,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OVERLAPPED,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(Error::Unsupported(format!(
            "cannot watch {}: {}",
            path.display(),
            std::io::Error::last_os_error()
        )));
    }
    Ok(Handle(handle))
}

/// A manual-reset event, so a wait stays signalled until the thread that owns it resets it.
fn create_event() -> Result<Handle, Error> {
    // SAFETY: a null security descriptor asks for the default one and a null name asks for an
    // unnamed event; the flags make it manual-reset and initially unsignalled.
    let handle = unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) };
    if handle.is_null() {
        return Err(Error::Unsupported(format!(
            "cannot create a file watching event: {}",
            std::io::Error::last_os_error()
        )));
    }
    Ok(Handle(handle))
}

/// A NUL-terminated UTF-16 copy of an operating-system string.
fn wide(text: &OsStr) -> Vec<u16> {
    text.encode_wide().chain(Some(0)).collect()
}

/// The old half of a rename whose new half has not arrived yet.
///
/// The kernel writes the two halves as separate records, and a buffer boundary can fall between
/// them, so the half waits across completions. Any other record, an overflow or a damaged chain
/// ends it: only a rename names a new path immediately after its old one.
#[derive(Default)]
struct Rename {
    old: Option<PathBuf>,
}

impl Rename {
    /// Appends the events one buffer's records describe, in order.
    fn events(&mut self, root: &Path, records: &[(u32, String)], out: &mut Vec<Event>) {
        for (action, name) in records {
            // The name is relative to the watched root and uses backslashes, which `join` and
            // files-safe's relative form both understand.
            let path = root.join(name);
            match *action {
                FILE_ACTION_RENAMED_OLD_NAME => {
                    self.flush(out);
                    self.old = Some(path);
                }
                FILE_ACTION_RENAMED_NEW_NAME => {
                    let event = match self.old.take() {
                        Some(old) => {
                            Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Both)))
                                .add_path(old)
                                .add_path(path)
                        }
                        // The old half was lost or named a path outside the tree: the new path
                        // is still a creation for this watch.
                        None => Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::To)))
                            .add_path(path),
                    };
                    out.push(event);
                }
                _ => {
                    self.flush(out);
                    if let Some(kind) = kind(*action) {
                        out.push(Event::new(kind).add_path(path));
                    }
                }
            }
        }
    }

    /// Ends a pending old half as the deletion it is: a move out of the tree names only the old
    /// path, so no new record will ever pair with it.
    fn flush(&mut self, out: &mut Vec<Event>) {
        if let Some(old) = self.old.take() {
            out.push(
                Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::From))).add_path(old),
            );
        }
    }

    /// The new half may have been among records the kernel lost, and a rescan covers the rest.
    fn clear(&mut self) {
        self.old = None;
    }
}

/// Sends the events one buffer of records describes.
fn emit(root: &Path, bytes: &[u8], events: &Events, renames: &mut Rename) {
    let mut out = Vec::new();
    renames.events(root, &parse(bytes), &mut out);
    for event in out {
        events.send(event);
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use notify::event::{CreateKind, EventKind, ModifyKind, RenameMode};
    use windows_sys::Win32::Storage::FileSystem::FILE_ACTION_ADDED;

    use super::{FILE_ACTION_RENAMED_NEW_NAME, FILE_ACTION_RENAMED_OLD_NAME, Rename};

    fn root() -> &'static Path {
        Path::new("root")
    }

    fn one(action: u32, name: &str) -> Vec<(u32, String)> {
        vec![(action, name.to_owned())]
    }

    #[test]
    fn a_rename_is_one_pair_whether_the_halves_share_a_buffer_or_not() {
        let records = [
            (FILE_ACTION_RENAMED_OLD_NAME, "foo.txt".to_owned()),
            (FILE_ACTION_RENAMED_NEW_NAME, "Foo.txt".to_owned()),
        ];
        let mut renames = Rename::default();
        let mut out = Vec::new();
        renames.events(root(), &records, &mut out);
        assert_eq!(out.len(), 1);
        assert_eq!(
            out[0].kind,
            EventKind::Modify(ModifyKind::Name(RenameMode::Both))
        );
        assert_eq!(
            out[0].paths,
            [root().join("foo.txt"), root().join("Foo.txt")]
        );

        // The kernel can split the halves at a buffer boundary, so the second half arrives in a
        // later completion.
        let mut renames = Rename::default();
        let mut out = Vec::new();
        renames.events(
            root(),
            &one(FILE_ACTION_RENAMED_OLD_NAME, "foo.txt"),
            &mut out,
        );
        assert!(out.is_empty(), "the old half waits for its new half");
        renames.events(
            root(),
            &one(FILE_ACTION_RENAMED_NEW_NAME, "Foo.txt"),
            &mut out,
        );
        assert_eq!(out.len(), 1);
        assert_eq!(
            out[0].paths,
            [root().join("foo.txt"), root().join("Foo.txt")]
        );
    }

    #[test]
    fn another_record_ends_a_half_seen_rename_as_a_deletion() {
        let mut renames = Rename::default();
        let mut out = Vec::new();
        renames.events(
            root(),
            &one(FILE_ACTION_RENAMED_OLD_NAME, "gone.txt"),
            &mut out,
        );
        renames.events(root(), &one(FILE_ACTION_ADDED, "new.txt"), &mut out);
        assert_eq!(out.len(), 2);
        assert_eq!(
            out[0].kind,
            EventKind::Modify(ModifyKind::Name(RenameMode::From)),
            "a move out of the tree names only its old path"
        );
        assert_eq!(out[0].paths, [root().join("gone.txt")]);
        assert_eq!(out[1].kind, EventKind::Create(CreateKind::Any));
    }

    #[test]
    fn an_overflow_forgets_a_pending_half() {
        let mut renames = Rename::default();
        let mut out = Vec::new();
        renames.events(
            root(),
            &one(FILE_ACTION_RENAMED_OLD_NAME, "gone.txt"),
            &mut out,
        );
        renames.clear();
        renames.events(
            root(),
            &one(FILE_ACTION_RENAMED_NEW_NAME, "made.txt"),
            &mut out,
        );
        assert_eq!(
            out.len(),
            1,
            "the lost half must not pair with a new rename"
        );
        assert_eq!(
            out[0].kind,
            EventKind::Modify(ModifyKind::Name(RenameMode::To))
        );
    }
}
