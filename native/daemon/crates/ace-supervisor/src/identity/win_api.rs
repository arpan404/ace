// SPDX-License-Identifier: Apache-2.0
//! The real Win32 identity surface, through windows-sys. Handles cross
//! the trait as integers and become `HANDLE` pointers only here; every
//! call into Win32 is an `unsafe` block that says why it holds.

use super::{WinHandle, WinToken, WindowsIdentityApi};
use windows_sys::Win32::Foundation::{
    CloseHandle, FILETIME, GetLastError, HANDLE, HLOCAL, LocalFree,
};
use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
use windows_sys::Win32::Security::{GetTokenInformation, TOKEN_QUERY, TokenUser};
use windows_sys::Win32::System::Threading::{
    GetProcessTimes, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
    PROCESS_SYNCHRONIZE, WaitForSingleObject,
};

const WAIT_OBJECT_0: u32 = 0;

/// kernel32 and Advapi32, linked by windows-sys.
pub struct WindowsApi;

impl WindowsApi {
    /// The libraries are linked at build time; this never fails.
    pub fn load() -> Result<Self, String> {
        Ok(Self)
    }
}

fn handle(raw: u64) -> HANDLE {
    raw as usize as HANDLE
}

fn filetime(buffer: &[u8; 8]) -> FILETIME {
    FILETIME {
        dwLowDateTime: u32::from_le_bytes([buffer[0], buffer[1], buffer[2], buffer[3]]),
        dwHighDateTime: u32::from_le_bytes([buffer[4], buffer[5], buffer[6], buffer[7]]),
    }
}

fn split_time(value: &FILETIME) -> [u8; 8] {
    let mut out = [0u8; 8];
    out[..4].copy_from_slice(&value.dwLowDateTime.to_le_bytes());
    out[4..].copy_from_slice(&value.dwHighDateTime.to_le_bytes());
    out
}

impl WindowsIdentityApi for WindowsApi {
    fn open(&self, pid: u32) -> WinHandle {
        // SAFETY: OpenProcess takes plain values and returns a handle
        // or null; the caller closes a non-null one through `close`.
        let opened = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                0,
                pid,
            )
        };
        WinHandle(opened as usize as u64)
    }

    fn exited(&self, opened: WinHandle) -> bool {
        // SAFETY: `opened` is a live process handle from `open` with
        // SYNCHRONIZE; a zero timeout only polls it.
        unsafe { WaitForSingleObject(handle(opened.0), 0) == WAIT_OBJECT_0 }
    }

    fn times(
        &self,
        opened: WinHandle,
        creation: &mut [u8; 8],
        exit: &mut [u8; 8],
        kernel: &mut [u8; 8],
        user: &mut [u8; 8],
    ) -> u32 {
        let mut created = filetime(creation);
        let mut exited = filetime(exit);
        let mut kernel_time = filetime(kernel);
        let mut user_time = filetime(user);
        // SAFETY: `opened` is a live process handle with query rights,
        // and the four FILETIMEs are owned locals the call fills.
        let result = unsafe {
            GetProcessTimes(
                handle(opened.0),
                &mut created,
                &mut exited,
                &mut kernel_time,
                &mut user_time,
            )
        };
        if result != 0 {
            *creation = split_time(&created);
            *exit = split_time(&exited);
            *kernel = split_time(&kernel_time);
            *user = split_time(&user_time);
        }
        result as u32
    }

    fn open_token(&self, opened: WinHandle) -> Option<WinToken> {
        let mut token: HANDLE = std::ptr::null_mut();
        // SAFETY: `opened` is a live process handle; `token` is an
        // owned local the call writes; a non-null token is closed once
        // through `close_token`.
        if unsafe { OpenProcessToken(handle(opened.0), TOKEN_QUERY, &mut token) } == 0 {
            return None;
        }
        (!token.is_null()).then_some(WinToken(token as usize as u64))
    }

    fn token_info(&self, token: WinToken, info: &mut [u8], needed: &mut u32) -> u32 {
        let mut size: u32 = 0;
        let buffer = if info.is_empty() {
            std::ptr::null_mut()
        } else {
            info.as_mut_ptr().cast::<core::ffi::c_void>()
        };
        let length = u32::try_from(info.len()).unwrap_or(u32::MAX);
        // SAFETY: `token` is a live token handle with TOKEN_QUERY;
        // `buffer` is null with length 0 (the sizing call) or points at
        // `info`, which is `length` bytes long and outlives the call.
        let result =
            unsafe { GetTokenInformation(handle(token.0), TokenUser, buffer, length, &mut size) };
        *needed = size;
        result as u32
    }

    fn sid_of(&self, info: &[u8]) -> Option<u64> {
        if info.len() < 8 {
            return None;
        }
        // The SID pointer is TOKEN_USER's first field: 4 bytes on
        // 32-bit processes, 8 above. It points into `info` itself.
        #[cfg(target_pointer_width = "32")]
        let sid = u64::from(u32::from_le_bytes([info[0], info[1], info[2], info[3]]));
        #[cfg(not(target_pointer_width = "32"))]
        let sid = u64::from_le_bytes([
            info[0], info[1], info[2], info[3], info[4], info[5], info[6], info[7],
        ]);
        (sid != 0).then_some(sid)
    }

    /// Converts the SID the kernel holds to its string form.
    fn sid_to_string(&self, sid: u64) -> Option<String> {
        let mut text: *mut u16 = std::ptr::null_mut();
        // SAFETY: `sid` points at the SID inside the TOKEN_USER buffer
        // the caller still holds; `text` is an owned local the call sets
        // to a LocalAlloc'd string.
        if unsafe { ConvertSidToStringSidW(sid as usize as *mut core::ffi::c_void, &mut text) } == 0
            || text.is_null()
        {
            return None;
        }
        // SAFETY: ConvertSidToStringSidW allocated a NUL-terminated
        // UTF-16 string and handed ownership to the caller; it stays
        // valid until the LocalFree below.
        let owned = unsafe {
            let mut length = 0;
            while *text.add(length) != 0 {
                length += 1;
            }
            String::from_utf16_lossy(std::slice::from_raw_parts(text, length))
        };
        // SAFETY: `text` came from ConvertSidToStringSidW, which is
        // freed with LocalFree; this runs exactly once per conversion.
        unsafe {
            LocalFree(text as HLOCAL);
        }
        Some(owned)
    }

    fn decode_sid(&self, text: &str) -> String {
        text.to_owned()
    }

    fn free_sid(&self, _text: &str) {}

    fn close_token(&self, token: WinToken) {
        // SAFETY: `token` came from `open_token` and is closed once.
        unsafe {
            CloseHandle(handle(token.0));
        }
    }

    fn close(&self, opened: WinHandle) {
        // SAFETY: `opened` came from `open` and is closed once.
        unsafe {
            CloseHandle(handle(opened.0));
        }
    }

    fn last_error(&self) -> u32 {
        // SAFETY: GetLastError only reads this thread's error slot.
        unsafe { GetLastError() }
    }
}
