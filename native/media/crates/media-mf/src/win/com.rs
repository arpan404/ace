// SPDX-License-Identifier: Apache-2.0
//! COM apartment and Media Foundation start-up, and error mapping.
use media_codec::CodecError;
use std::cell::Cell;
use windows::Win32::Media::MediaFoundation::{MF_VERSION, MFSTARTUP_LITE, MFShutdown, MFStartup};
use windows::Win32::System::Com::{COINIT_MULTITHREADED, CoInitializeEx};
use windows::Win32::System::LibraryLoader::{
    LOAD_LIBRARY_SEARCH_DEFAULT_DIRS, SetDefaultDllDirectories,
};

thread_local! {
    static JOINED: Cell<bool> = const { Cell::new(false) };
}

/// Joins the calling thread to the process's multithreaded apartment, once per thread.
/// Never left: Media Foundation and D3D objects are free-threaded and may be released on
/// any thread, so the apartment must outlive them. A thread already in a single-threaded
/// apartment keeps it; the objects used here work from either.
pub(crate) fn enter() {
    JOINED.with(|joined| {
        if !joined.get() {
            // SAFETY: No reserved pointer; the result is checked only to learn the mode.
            let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
            joined.set(true);
        }
    });
}

/// Once per process, before this crate makes Media Foundation, COM or WIC load anything:
/// plain `LoadLibrary` calls search the application folder and System32 only, never the
/// working directory or `PATH` (DLL planting). COM loads MFTs and WIC codecs by full
/// registered path, so they are unaffected. The binary's own imports are covered by
/// linking with `/DEPENDENTLOADFLAG:0x800` (`ace-media`'s build script).
fn harden_dll_search() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        // SAFETY: A documented process-wide flag; failure leaves the default order.
        let _ = unsafe { SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_DEFAULT_DIRS) };
    });
}

/// One `MFStartup`, balanced by `MFShutdown` on drop. Media Foundation counts them, so
/// every encoder, decoder and device holds its own and drops it last.
pub(crate) struct Runtime(());
impl Runtime {
    pub fn start() -> Result<Self, CodecError> {
        harden_dll_search();
        enter();
        // SAFETY: Version constant from the SDK; lite mode skips the socket layer.
        unsafe { MFStartup(MF_VERSION, MFSTARTUP_LITE) }.ctx("MFStartup")?;
        Ok(Self(()))
    }
}
impl Drop for Runtime {
    fn drop(&mut self) {
        // SAFETY: Balances the `MFStartup` this value made.
        let _ = unsafe { MFShutdown() };
    }
}

pub(crate) trait Ctx<T> {
    fn ctx(self, what: &str) -> Result<T, CodecError>;
}
impl<T> Ctx<T> for windows_core::Result<T> {
    fn ctx(self, what: &str) -> Result<T, CodecError> {
        self.map_err(|e| CodecError::Backend(format!("{what}: {e}")))
    }
}
