//! A security identifier held as its own bytes.

use windows::Win32::Foundation::{HLOCAL, LocalFree};
use windows::Win32::Security::Authorization::{ConvertSidToStringSidW, ConvertStringSidToSidW};
use windows::Win32::Security::{GetLengthSid, IsValidSid, PSID};
use windows::core::{HSTRING, PWSTR};

/// An owned SID.
#[derive(Clone, PartialEq, Eq)]
pub struct Sid(Vec<u8>);

impl std::fmt::Debug for Sid {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.to_string())
    }
}

impl Sid {
    /// Parses `S-1-…`.
    pub fn parse(text: &str) -> std::io::Result<Self> {
        let mut raw = PSID::default();
        // SAFETY: `raw` receives a LocalAlloc'd SID, copied and freed below.
        unsafe { ConvertStringSidToSidW(&HSTRING::from(text), &mut raw) }.map_err(crate::io)?;
        // SAFETY: the call above succeeded, so `raw` is a valid SID it allocated.
        let sid = unsafe { Self::copy(raw) };
        // SAFETY: `raw` was allocated by LocalAlloc in ConvertStringSidToSidW.
        unsafe { LocalFree(Some(HLOCAL(raw.0))) };
        sid
    }

    /// Copies the SID at `raw`.
    ///
    /// # Safety
    /// `raw` must point to a valid SID.
    pub(crate) unsafe fn copy(raw: PSID) -> std::io::Result<Self> {
        // SAFETY: the caller promises `raw` is a SID; IsValidSid checks its structure.
        if !unsafe { IsValidSid(raw) }.as_bool() {
            return Err(std::io::Error::other("not a valid SID"));
        }
        // SAFETY: a valid SID's length covers exactly its bytes.
        let len = unsafe { GetLengthSid(raw) } as usize;
        // SAFETY: `raw` points to `len` readable bytes.
        let bytes = unsafe { std::slice::from_raw_parts(raw.0.cast::<u8>(), len) };
        Ok(Self(bytes.to_vec()))
    }

    /// The SID for a call that only reads it. Valid while `self` lives.
    pub(crate) fn as_psid(&self) -> PSID {
        PSID(self.0.as_ptr().cast_mut().cast())
    }
}

impl std::fmt::Display for Sid {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let mut text = PWSTR::null();
        // SAFETY: `self` holds a valid SID; `text` receives a LocalAlloc'd string freed below.
        let shown = match unsafe { ConvertSidToStringSidW(self.as_psid(), &mut text) } {
            // SAFETY: the call succeeded, so `text` is a NUL-terminated wide string.
            Ok(()) => unsafe { text.to_string() }.unwrap_or_default(),
            Err(_) => String::new(),
        };
        if !text.is_null() {
            // SAFETY: allocated by ConvertSidToStringSidW with LocalAlloc.
            unsafe { LocalFree(Some(HLOCAL(text.0.cast()))) };
        }
        f.write_str(&shown)
    }
}
