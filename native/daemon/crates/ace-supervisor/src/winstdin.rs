// SPDX-License-Identifier: Apache-2.0
//! Windows stdin as libuv writes it: an overlapped named-pipe server for
//! ace's end, written from one thread, each write acknowledged only once
//! `GetOverlappedResult` reports it complete (so its error, the last one
//! included, is the shell's). Destroying stdin cancels the pending write
//! (`CancelIoEx`) and closes the handle; EOF is closing it after the last
//! write completed.
#![allow(unsafe_code)]

use crate::pump::StdinMessage;
use crate::spawn::EventSink;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_IO_PENDING, GetLastError, HANDLE, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Storage::FileSystem::{
    FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED, PIPE_ACCESS_OUTBOUND, WriteFile,
};
use windows_sys::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};
use windows_sys::Win32::System::Pipes::{
    CreateNamedPipeW, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_WAIT,
};
use windows_sys::Win32::System::Threading::CreateEventW;

/// Distinguishes this process's stdin pipe names; the pid separates processes.
static NEXT_STDIN: AtomicU64 = AtomicU64::new(0);

/// Ace's end of one child's stdin.
pub(crate) struct StdinPipe {
    /// The handle and what is in flight on it. A write is submitted under
    /// this lock and an abort cancels under it, so an abort either comes
    /// before the submission (which then never happens) or cancels a write
    /// that was submitted; the completion wait runs only for a submitted one.
    state: Mutex<PipeState>,
}

struct PipeState {
    /// The server handle; `None` once closed.
    handle: Option<usize>,
    aborted: bool,
    /// A write was submitted and its completion not yet collected.
    in_flight: bool,
}

fn os_error(code: u32) -> std::io::Error {
    std::io::Error::from_raw_os_error(i32::try_from(code).unwrap_or(i32::MAX))
}

/// Makes the pipe: ace's overlapped write end and the child's read end.
pub(crate) fn stdin_pipe() -> std::io::Result<(StdinPipe, std::fs::File)> {
    for _ in 0..16 {
        let name = format!(
            r"\\.\pipe\ace-supervisor-stdin-{}-{}",
            std::process::id(),
            NEXT_STDIN.fetch_add(1, Ordering::Relaxed)
        );
        let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
        // SAFETY: `wide` is a NUL-terminated UTF-16 name that outlives the
        // call; the other arguments are plain values. A valid handle is
        // owned by the returned `StdinPipe`, which closes it once.
        let handle = unsafe {
            CreateNamedPipeW(
                wide.as_ptr(),
                PIPE_ACCESS_OUTBOUND | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
                PIPE_TYPE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                1,
                65_536,
                65_536,
                0,
                std::ptr::null(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            // The name is taken (first instance only): try the next one.
            continue;
        }
        let pipe = StdinPipe {
            state: Mutex::new(PipeState {
                handle: Some(handle as usize),
                aborted: false,
                in_flight: false,
            }),
        };
        let child_end = std::fs::OpenOptions::new().read(true).open(&name)?;
        return Ok((pipe, child_end));
    }
    Err(std::io::Error::other("no free supervisor stdin pipe name"))
}

impl StdinPipe {
    fn aborted(&self) -> bool {
        self.state.lock().map_or(true, |state| state.aborted)
    }

    /// Submits one write under the lock; `None` when aborted or closed
    /// first (nothing submitted), else whether it is pending (or done).
    fn submit(&self, rest: &[u8], overlapped: &mut OVERLAPPED) -> Option<std::io::Result<HANDLE>> {
        let mut state = self.state.lock().ok()?;
        if state.aborted {
            return None;
        }
        let handle = state.handle? as HANDLE;
        let length = u32::try_from(rest.len()).unwrap_or(u32::MAX);
        // SAFETY: `handle` is the live server handle (only the writer thread
        // closes it, after its last write); `rest` and `overlapped` are the
        // caller's and outlive the I/O, which completes or is cancelled
        // before the caller's GetOverlappedResult (waiting) returns.
        let started = unsafe {
            WriteFile(
                handle,
                rest.as_ptr(),
                length,
                std::ptr::null_mut(),
                overlapped,
            )
        };
        if started == 0 {
            // SAFETY: reads this thread's error slot right after the call.
            let error = unsafe { GetLastError() };
            if error != ERROR_IO_PENDING {
                return Some(Err(os_error(error)));
            }
        }
        state.in_flight = true;
        Some(Ok(handle))
    }

    /// Writes every byte, returning once the kernel completed the writes.
    fn write(&self, bytes: &[u8]) -> std::io::Result<()> {
        // SAFETY: a manual-reset, unnamed event; closed below.
        let event = unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) };
        if event.is_null() {
            return Err(std::io::Error::last_os_error());
        }
        let mut written_total = 0usize;
        let result = loop {
            if written_total >= bytes.len() {
                break Ok(());
            }
            // SAFETY: plain data; only `hEvent` is set before the write.
            let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
            overlapped.hEvent = event;
            let handle = match self.submit(&bytes[written_total..], &mut overlapped) {
                None => break Err(std::io::Error::from(std::io::ErrorKind::BrokenPipe)),
                Some(Err(error)) => break Err(error),
                Some(Ok(handle)) => handle,
            };
            let mut written = 0u32;
            // SAFETY: waits for the write submitted above on its own
            // OVERLAPPED; a cancel makes it return with an error.
            let completed = unsafe { GetOverlappedResult(handle, &overlapped, &mut written, 1) };
            let failure = (completed == 0).then(std::io::Error::last_os_error);
            if let Ok(mut state) = self.state.lock() {
                state.in_flight = false;
            }
            if let Some(error) = failure {
                break Err(error);
            }
            written_total += written as usize;
        };
        // SAFETY: `event` came from CreateEventW above and is closed once.
        unsafe {
            CloseHandle(event);
        }
        result
    }

    /// The shell destroyed stdin: a submitted write is cancelled, and no
    /// later one is submitted.
    pub(crate) fn abort(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.aborted = true;
            if state.in_flight
                && let Some(raw) = state.handle
            {
                // SAFETY: the handle is live while the lock shows it open;
                // the call cancels the submitted write, which the writer's
                // completion wait then reports.
                unsafe {
                    CancelIoEx(raw as HANDLE, std::ptr::null());
                }
            }
        }
    }

    fn close(&self) {
        if let Ok(mut state) = self.state.lock()
            && let Some(raw) = state.handle.take()
        {
            // SAFETY: the handle came from CreateNamedPipeW and leaves the
            // state here, so it is closed exactly once.
            unsafe {
                CloseHandle(raw as HANDLE);
            }
        }
    }

    /// Writes the queue in order until `End`, an abort or a failure, then
    /// closes the pipe (the child reads EOF). Runs on its own thread.
    pub(crate) fn run<E: EventSink>(
        &self,
        sink: &E,
        mut queue: tokio::sync::mpsc::UnboundedReceiver<StdinMessage>,
    ) {
        while let Some(StdinMessage::Write(bytes)) = queue.blocking_recv() {
            if self.aborted() {
                break;
            }
            match self.write(&bytes) {
                Ok(()) => sink.stdin_written(),
                Err(error) => {
                    if !self.aborted() {
                        sink.stdin_error(error.to_string());
                    }
                    break;
                }
            }
        }
        self.close();
    }
}

impl Drop for StdinPipe {
    fn drop(&mut self) {
        self.close();
    }
}
