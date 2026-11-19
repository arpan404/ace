//! Borrowing the clipboard for a paste: what is on it is saved, the pasted content goes on
//! (kept out of clipboard history), and the saved content is put back afterwards, unless
//! someone copied something in the meantime (the clipboard's sequence number moved). A named
//! mutex keeps two helpers from interleaving their borrows, and the saved content waits on
//! disk until it is back, so a helper that dies mid-paste restores it on the next start.
use super::borrow_file::{self, Formats};
use super::error::{CuError, CuResult};
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;
use windows::core::w;
use windows::Win32::{
    Foundation::*,
    System::{DataExchange::*, Memory::*, Threading::*},
    UI::WindowsAndMessaging::*,
};

const CF_TEXT: u32 = 1;
const CF_OEMTEXT: u32 = 7;
const CF_UNICODETEXT: u32 = 13;

pub struct Clipboard {
    owner: HWND,
    lock: HANDLE,
    /// What was on the clipboard, and its sequence number right after the borrow.
    saved: Option<(u32, Formats)>,
    locked: bool,
}

/// Where a borrow waits on disk (`--data-dir`); none when the helper has no data dir.
static DIR: OnceLock<Option<PathBuf>> = OnceLock::new();

fn file() -> Option<PathBuf> {
    DIR.get()
        .and_then(Option::as_ref)
        .map(|dir| dir.join("clipboard-borrow.bin"))
}

/// Formats whose data is plain global memory and can be copied and put back.
fn copyable(format: u32) -> bool {
    !matches!(
        format,
        2 | 3 | 9 | 14 | 0x80 | 0x82 | 0x83 | 0x8E | 0x200..=0x3FF
    )
}

fn global(bytes: &[u8]) -> CuResult<HGLOBAL> {
    unsafe {
        let memory = GlobalAlloc(GMEM_MOVEABLE, bytes.len().max(1))
            .map_err(|e| CuError::new("internal", format!("Clipboard memory: {e}")))?;
        let target = GlobalLock(memory);
        if target.is_null() {
            let _ = GlobalFree(memory);
            return Err(CuError::new(
                "internal",
                "Clipboard memory could not be locked.",
            ));
        }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), target.cast(), bytes.len());
        let _ = GlobalUnlock(memory);
        Ok(memory)
    }
}

impl Clipboard {
    /// Remembers the data dir and puts back a borrow a previous helper left behind.
    pub fn recover(dir: Option<PathBuf>) {
        DIR.get_or_init(|| dir);
        let Some(path) = file() else { return };
        let Some((sequence, formats)) = std::fs::read(&path)
            .ok()
            .and_then(|d| borrow_file::decode(&d))
        else {
            let _ = std::fs::remove_file(&path);
            return;
        };
        if let Ok(mut clipboard) = Self::new() {
            if clipboard.acquire().is_ok() {
                clipboard.saved = Some((sequence, formats));
                clipboard.restore();
            }
        }
        let _ = std::fs::remove_file(&path);
    }

    pub fn new() -> CuResult<Self> {
        unsafe {
            let owner = CreateWindowExW(
                WINDOW_EX_STYLE(0),
                w!("STATIC"),
                w!("ace computer use clipboard"),
                WS_OVERLAPPED,
                0,
                0,
                0,
                0,
                HWND_MESSAGE,
                None,
                None,
                None,
            )
            .map_err(|e| CuError::new("internal", format!("Clipboard window: {e}")))?;
            let lock = CreateMutexW(None, false, w!("Local\\ace-computer-use-clipboard"))
                .map_err(|e| CuError::new("internal", format!("Clipboard lock: {e}")))?;
            Ok(Self {
                owner,
                lock,
                saved: None,
                locked: false,
            })
        }
    }

    /// Takes the cross-helper lock, waiting up to five seconds for another helper's paste.
    fn acquire(&mut self) -> CuResult<()> {
        if self.locked {
            return Ok(());
        }
        let waited = unsafe { WaitForSingleObject(self.lock, 5_000) };
        if waited != WAIT_OBJECT_0 && waited != WAIT_ABANDONED {
            return Err(CuError::new(
                "app_busy",
                "Another paste is still using the clipboard. Try again in a moment.",
            ));
        }
        self.locked = true;
        Ok(())
    }

    fn release(&mut self) {
        if self.locked {
            unsafe {
                let _ = ReleaseMutex(self.lock);
            }
            self.locked = false;
        }
    }

    fn open(&self) -> CuResult<()> {
        for _ in 0..40 {
            if unsafe { OpenClipboard(self.owner) }.is_ok() {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        Err(CuError::new(
            "action_failed",
            "Another app is holding the clipboard, so the paste could not start. Try again.",
        ))
    }

    fn save(&self) -> Vec<(u32, Vec<u8>)> {
        let mut saved = Vec::new();
        unsafe {
            let unicode = IsClipboardFormatAvailable(CF_UNICODETEXT).is_ok();
            let mut format = 0;
            loop {
                format = EnumClipboardFormats(format);
                if format == 0 {
                    break;
                }
                // Windows makes these from the Unicode text by itself.
                if !copyable(format) || unicode && (format == CF_TEXT || format == CF_OEMTEXT) {
                    continue;
                }
                let Ok(handle) = GetClipboardData(format) else {
                    continue;
                };
                let memory = HGLOBAL(handle.0);
                let size = GlobalSize(memory);
                if size == 0 || size > 64 * 1024 * 1024 {
                    continue;
                }
                let source = GlobalLock(memory);
                if source.is_null() {
                    continue;
                }
                saved.push((
                    format,
                    std::slice::from_raw_parts(source.cast::<u8>(), size).to_vec(),
                ));
                let _ = GlobalUnlock(memory);
            }
        }
        saved
    }

    fn put(format: u32, bytes: &[u8]) -> CuResult<()> {
        let memory = global(bytes)?;
        unsafe { SetClipboardData(format, HANDLE(memory.0)) }
            .map(|_| ())
            .map_err(|e| {
                unsafe {
                    let _ = GlobalFree(memory);
                }
                CuError::new(
                    "action_failed",
                    format!("The clipboard refused the paste: {e}"),
                )
            })
    }

    /// Puts text (and HTML when given) on the clipboard, saving what was there. On any failure
    /// the saved content goes straight back.
    pub fn borrow(&mut self, text: &str, html: Option<&str>) -> CuResult<()> {
        self.restore();
        self.acquire()?;
        if let Err(error) = self.open() {
            self.release();
            return Err(error);
        }
        let saved = self.save();
        let result = (|| unsafe {
            EmptyClipboard().map_err(|e| {
                CuError::new(
                    "action_failed",
                    format!("The clipboard could not be cleared: {e}"),
                )
            })?;
            let units: Vec<u16> = text.encode_utf16().chain(Some(0)).collect();
            let bytes: Vec<u8> = units.iter().flat_map(|u| u.to_le_bytes()).collect();
            Self::put(CF_UNICODETEXT, &bytes)?;
            if let Some(html) = html {
                let format = RegisterClipboardFormatW(w!("HTML Format"));
                let mut bytes = html.as_bytes().to_vec();
                bytes.push(0);
                Self::put(format, &bytes)?;
            }
            // Keep the agent's paste out of clipboard history and cloud clipboard.
            let zero = 0u32.to_le_bytes();
            for name in [
                w!("CanIncludeInClipboardHistory"),
                w!("CanUploadToCloudClipboard"),
            ] {
                let _ = Self::put(RegisterClipboardFormatW(name), &zero);
            }
            let _ = Self::put(
                RegisterClipboardFormatW(w!("ExcludeClipboardContentFromMonitorProcessing")),
                &zero,
            );
            Ok(())
        })();
        unsafe {
            let _ = CloseClipboard();
        }
        let sequence = unsafe { GetClipboardSequenceNumber() };
        if let Some(path) = file() {
            let _ = std::fs::write(&path, borrow_file::encode(sequence, &saved));
        }
        self.saved = Some((sequence, saved));
        if result.is_err() {
            self.restore();
        }
        result
    }

    /// Puts back what was on the clipboard before the last borrow, unless something else was
    /// copied since (the person, or the app the text was pasted into).
    pub fn restore(&mut self) {
        if let Some((sequence, saved)) = self.saved.take() {
            let untouched = unsafe { GetClipboardSequenceNumber() } == sequence;
            if untouched && self.open().is_ok() {
                unsafe {
                    let _ = EmptyClipboard();
                }
                for (format, bytes) in &saved {
                    let _ = Self::put(*format, bytes);
                }
                unsafe {
                    let _ = CloseClipboard();
                }
            }
            if let Some(path) = file() {
                let _ = std::fs::remove_file(path);
            }
        }
        self.release();
    }
}

impl Drop for Clipboard {
    fn drop(&mut self) {
        self.restore();
        unsafe {
            let _ = DestroyWindow(self.owner);
            let _ = CloseHandle(self.lock);
        }
    }
}
