// SPDX-License-Identifier: Apache-2.0

//! macOS: files-watch's own FSEvents stream, so nothing written after `watch()` returns is lost.
//!
//! `notify`'s FSEvents watcher starts its stream at "now" as fseventsd sees it, which is some time
//! after the call returns when fseventsd is busy with many streams, so a change made right after
//! the watch came up could fall in the gap and never be reported. It also drops records that carry
//! no item flag, which is how FSEvents describes a folder after it coalesces a burst, and only
//! asks for a rescan on `MustScanSubDirs`.
//!
//! This backend creates the stream itself and starts it before [`Stream::start`] returns. The
//! stream begins at `FSEventsGetCurrentEventId()`, read before the stream exists, so fseventsd
//! replays anything that landed between that read and the moment it registered the stream. It is
//! delivered on its own serial dispatch queue, with a short latency and `NoDefer`, so a lone
//! change in a quiet folder reaches the worker almost at once. `flags.rs` turns each record into
//! the events the rest of the crate translates, and every record that cannot be described file
//! by file into a rescan.
//!
//! Every `unsafe` block is a call into `objc2-core-services`, and each carries a `SAFETY`
//! comment naming what keeps it sound.

#![allow(unsafe_code)]

use std::ffi::{CStr, OsStr, c_void};
use std::os::unix::ffi::OsStrExt;
use std::path::Path;
use std::ptr::NonNull;

use dispatch2::{DispatchQueue, DispatchQueueAttr, DispatchRetained};
use files_safe::Root;
use objc2_core_foundation::{CFArray, CFString};
use objc2_core_services::{
    ConstFSEventStreamRef, FSEventStreamContext, FSEventStreamCreate, FSEventStreamEventFlags,
    FSEventStreamEventId, FSEventStreamInvalidate, FSEventStreamRef, FSEventStreamRelease,
    FSEventStreamSetDispatchQueue, FSEventStreamStart, FSEventStreamStop,
    FSEventsGetCurrentEventId, kFSEventStreamCreateFlagFileEvents, kFSEventStreamCreateFlagNoDefer,
    kFSEventStreamCreateFlagWatchRoot,
};

use crate::error::Error;
use crate::exclude::Excluder;
use crate::translate::Notice;
use crate::watch::Events;

mod flags;

/// How long FSEvents may hold records before it hands them over. With `NoDefer` the first record
/// after a quiet spell is delivered at once and this only groups the ones that follow it.
const LATENCY_SECONDS: f64 = 0.02;

/// File-level records, the first one delivered without waiting, and word when the root moves.
const CREATE_FLAGS: u32 = kFSEventStreamCreateFlagFileEvents
    | kFSEventStreamCreateFlagNoDefer
    | kFSEventStreamCreateFlagWatchRoot;

/// What the stream's callback needs: where to send events. Owned by the stream, which frees it
/// through [`release_context`] when the stream is released.
struct Context {
    events: Events,
}

/// One running FSEvents stream over the root.
pub(crate) struct Stream {
    /// Never null: `start` only builds a `Stream` around a stream FSEvents created.
    stream: FSEventStreamRef,
    queue: DispatchRetained<DispatchQueue>,
}

// SAFETY: an FSEventStreamRef may be used from any thread as long as calls on it are not made
// concurrently. `Stream` is moved into the worker thread once and only that thread touches it
// afterwards; the callback runs on the stream's dispatch queue and never sees the `Stream`.
unsafe impl Send for Stream {}

impl Stream {
    /// Creates the stream and starts it on its own dispatch queue before returning.
    pub(crate) fn start(
        root: &Root,
        _excluder: &Excluder,
        events: Events,
    ) -> Result<Stream, Error> {
        // Read first: everything recorded after this id is replayed or delivered, including what
        // the caller writes the moment this returns.
        // SAFETY: a plain read of fseventsd's counter, with no arguments.
        let since = unsafe { FSEventsGetCurrentEventId() };
        let path = root
            .path()
            .to_str()
            .ok_or_else(|| Error::Unsupported(format!("{} is not UTF-8", root.path().display())))?;
        let watched = CFString::from_str(path);
        let paths = CFArray::from_objects(&[&*watched]);
        let info = Box::into_raw(Box::new(Context { events }));
        let mut context = FSEventStreamContext {
            version: 0,
            info: info.cast(),
            retain: None,
            release: Some(release_context),
            copyDescription: None,
        };
        // SAFETY: `context` is a valid FSEventStreamContext for the call, and FSEvents copies it.
        // From here the stream owns `info` and frees it through `release_context`; `paths` is a
        // live CFArray of CFStrings, which FSEvents retains.
        let stream = unsafe {
            FSEventStreamCreate(
                None,
                Some(callback),
                &raw mut context,
                paths.as_opaque(),
                since,
                LATENCY_SECONDS,
                CREATE_FLAGS,
            )
        };
        if stream.is_null() {
            // SAFETY: the stream was never created, so nothing else holds `info`.
            drop(unsafe { Box::from_raw(info) });
            return Err(Error::Unsupported(
                "FSEvents would not create a stream".to_owned(),
            ));
        }
        let queue = DispatchQueue::new("dev.acehq.files-watch", DispatchQueueAttr::SERIAL);
        // SAFETY: `stream` was just created and is not started; the queue outlives the stream,
        // because `Stream` releases the stream before it drops its queue handle.
        unsafe { FSEventStreamSetDispatchQueue(stream, Some(&queue)) };
        // SAFETY: as above; starting a scheduled stream has no other precondition.
        if !unsafe { FSEventStreamStart(stream) } {
            // SAFETY: the stream is scheduled but not started; invalidating and releasing it is
            // the documented teardown, and the release frees `info`.
            unsafe {
                FSEventStreamInvalidate(stream);
                FSEventStreamRelease(stream);
            }
            return Err(Error::Unsupported(
                "FSEvents would not start the stream".to_owned(),
            ));
        }
        Ok(Stream { stream, queue })
    }

    /// The stream is recursive: folders that appear are already covered.
    pub(crate) fn adopt(
        &mut self,
        _root: &Root,
        _excluder: &Excluder,
        _notices: &mut Vec<Notice>,
    ) -> Result<(), Error> {
        Ok(())
    }

    /// The stream keeps running after it reports lost events, so there is nothing to rebuild.
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

impl Drop for Stream {
    fn drop(&mut self) {
        let stream = self.stream;
        // SAFETY: the stream is started and owned by this value; stopping and invalidating it
        // unschedules it from its queue, so FSEvents queues no further callback.
        unsafe {
            FSEventStreamStop(stream);
            FSEventStreamInvalidate(stream);
        }
        // A callback queued before the invalidation may still be waiting or running. The queue is
        // serial, so once this empty block has run every earlier one has finished, and no callback
        // runs after the stop returns.
        self.queue.exec_sync(|| {});
        // SAFETY: the stream is invalidated and no callback is left; this drops our reference,
        // and when FSEvents drops its own the context is freed.
        unsafe { FSEventStreamRelease(stream) };
    }
}

/// Frees the [`Context`] when FSEvents releases the stream that owns it.
unsafe extern "C-unwind" fn release_context(info: *const c_void) {
    // SAFETY: `info` is the pointer `Stream::start` made with `Box::into_raw`, and FSEvents calls
    // this once, when the stream is deallocated, after its last callback.
    drop(unsafe { Box::from_raw(info.cast::<Context>().cast_mut()) });
}

/// Hands each record to the worker as the events it stands for.
unsafe extern "C-unwind" fn callback(
    _stream: ConstFSEventStreamRef,
    info: *mut c_void,
    count: usize,
    paths: NonNull<c_void>,
    flags: NonNull<FSEventStreamEventFlags>,
    _ids: NonNull<FSEventStreamEventId>,
) {
    // SAFETY: `info` is the live Context the stream owns; FSEvents frees it only after the last
    // callback, and the callback only reads it.
    let context = unsafe { &*info.cast::<Context>() };
    // SAFETY: without `UseCFTypes`, FSEvents passes `count` C strings and `count` flags, valid for
    // the duration of the call.
    let (paths, flags) = unsafe {
        (
            std::slice::from_raw_parts(paths.as_ptr().cast::<*const std::ffi::c_char>(), count),
            std::slice::from_raw_parts(flags.as_ptr(), count),
        )
    };
    for (path, flags) in paths.iter().zip(flags) {
        // SAFETY: each entry is a NUL-terminated path FSEvents keeps alive for the call.
        let bytes = unsafe { CStr::from_ptr(*path) }.to_bytes();
        let path = Path::new(OsStr::from_bytes(bytes));
        for event in flags::events(path, *flags) {
            context.events.send(event);
        }
    }
}
