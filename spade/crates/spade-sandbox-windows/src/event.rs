//! A one-shot event the launcher waits on and the in-container egress bridge signals once it has
//! bound its loopback port (ADR 0167 Windows hardening, per-run acknowledgements). The event is
//! made inheritable, and its handle value is passed to the bridge on its command line; the bridge,
//! which inherits the handle, signals it. So the launcher only lets the command start after the
//! bridge is really listening, and fails the run closed otherwise.

use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};

use windows::Win32::Foundation::{
    HANDLE, HANDLE_FLAG_INHERIT, SetHandleInformation, WAIT_OBJECT_0,
};
use windows::Win32::System::Threading::{CreateEventW, SetEvent, WaitForSingleObject};

/// An auto-reset readiness event owned by the launcher.
pub struct Ready(OwnedHandle);

impl Ready {
    /// A fresh, inheritable auto-reset event.
    pub fn new() -> std::io::Result<Self> {
        // SAFETY: default attributes, auto-reset, not signalled, no name.
        let handle = unsafe { CreateEventW(None, false, false, windows::core::PCWSTR::null()) }
            .map_err(crate::io)?;
        // SAFETY: make it inheritable so the bridge receives the same handle value.
        unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT.0, HANDLE_FLAG_INHERIT) }
            .map_err(crate::io)?;
        // SAFETY: a fresh handle this owns.
        Ok(Self(unsafe { OwnedHandle::from_raw_handle(handle.0) }))
    }

    /// The handle value to hand the bridge (valid in the child, which inherits the handle).
    pub fn raw_value(&self) -> isize {
        self.0.as_raw_handle() as isize
    }

    /// Waits up to `millis` for the bridge to signal readiness; `true` if it did.
    pub fn wait(&self, millis: u32) -> bool {
        // SAFETY: a live event handle.
        let waited = unsafe { WaitForSingleObject(HANDLE(self.0.as_raw_handle()), millis) };
        waited == WAIT_OBJECT_0
    }
}

/// Signals the readiness event named by handle value `raw` (inherited from the launcher). A zero or
/// unusable value is ignored, so a bridge started without one still runs.
pub fn signal_ready(raw: isize) {
    if raw == 0 {
        return;
    }
    // SAFETY: `raw` is a handle value this process inherited; signalling it wakes the launcher.
    let _ = unsafe { SetEvent(HANDLE(raw as *mut core::ffi::c_void)) };
}
