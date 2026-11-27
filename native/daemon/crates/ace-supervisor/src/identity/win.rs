// SPDX-License-Identifier: Apache-2.0
//! Windows identity: creation FILETIME and token-user SID, read through an
//! injected Win32 surface so the cases run on every platform.

use crate::errors::SupervisorError;

/// Creation start and token-user SID for one pid, or `None` when no such
/// process exists. Mirrors `readWindowsProcessIdentity` with an injected
/// Win32 surface, so the (b) cases run anywhere.
pub fn read_windows_identity<A: WindowsIdentityApi>(
    pid: u32,
    api: &A,
) -> Result<Option<WindowsIdentity>, SupervisorError> {
    if pid == 0 {
        return Err(SupervisorError::InvalidInput("bad pid 0".to_owned()));
    }
    let handle = api.open(pid);
    if handle.is_null() {
        if api.last_error() == ERROR_INVALID_PARAMETER {
            return Ok(None);
        }
        return Err(SupervisorError::Unavailable(
            "kernel process identity unavailable".to_owned(),
        ));
    }
    let outcome = read_windows_inner(pid, api, handle);
    api.close(handle);
    match outcome {
        Ok(identity) => Ok(identity),
        Err(error) => {
            // Exit can race any read while the handle keeps the object alive.
            if api.exited(handle) {
                Ok(None)
            } else {
                Err(error)
            }
        }
    }
}

/// A proven Windows process: creation start and owner SID string.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowsIdentity {
    pub start: String,
    pub owner: String,
}

fn read_windows_inner<A: WindowsIdentityApi>(
    _pid: u32,
    api: &A,
    handle: WinHandle,
) -> Result<Option<WindowsIdentity>, SupervisorError> {
    // Any open handle keeps an exited process openable.
    if api.exited(handle) {
        return Ok(None);
    }
    let mut creation = [0u8; 8];
    let mut exit = [0u8; 8];
    let mut kernel = [0u8; 8];
    let mut user = [0u8; 8];
    if api.times(handle, &mut creation, &mut exit, &mut kernel, &mut user) == 0 {
        return Err(SupervisorError::Unavailable(
            "kernel process identity unavailable".to_owned(),
        ));
    }
    let start = u64::from_le_bytes(creation).to_string();
    let token = api.open_token(handle).ok_or_else(|| {
        SupervisorError::Unavailable("kernel process identity unavailable".to_owned())
    })?;
    let owner = read_windows_token(api, token);
    api.close_token(token);
    let owner = owner?;
    Ok(owner.map(|owner| WindowsIdentity {
        start: start.clone(),
        owner,
    }))
}

fn read_windows_token<A: WindowsIdentityApi>(
    api: &A,
    token: WinToken,
) -> Result<Option<String>, SupervisorError> {
    // The first call with no buffer reports the size TOKEN_USER needs.
    let mut needed = 0u32;
    if api.token_info(token, &mut [], &mut needed) != 0 {
        return Err(SupervisorError::Unavailable(
            "kernel process identity unavailable".to_owned(),
        ));
    }
    if api.last_error() != ERROR_INSUFFICIENT_BUFFER {
        return Err(SupervisorError::Unavailable(
            "kernel process identity unavailable".to_owned(),
        ));
    }
    if needed == 0 || needed > 4096 {
        return Err(SupervisorError::Unavailable(
            "kernel process identity unavailable".to_owned(),
        ));
    }
    let mut info = vec![0u8; needed as usize];
    let mut again = 0u32;
    if api.token_info(token, &mut info, &mut again) == 0 {
        return Err(SupervisorError::Unavailable(
            "kernel process identity unavailable".to_owned(),
        ));
    }
    let sid = api.sid_of(&info).ok_or_else(|| {
        SupervisorError::Unavailable("kernel process identity unavailable".to_owned())
    })?;
    let text = api.sid_to_string(sid).ok_or_else(|| {
        SupervisorError::Unavailable("kernel process identity unavailable".to_owned())
    })?;
    let decoded = api.decode_sid(&text);
    api.free_sid(&text);
    if !crate::wintree::valid_sid(&decoded) {
        return Err(SupervisorError::Unavailable(
            "kernel process identity unavailable".to_owned(),
        ));
    }
    Ok(Some(decoded))
}

/// An opaque process handle; null opens nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WinHandle(pub u64);

impl WinHandle {
    /// Whether the open proved absence.
    pub fn is_null(&self) -> bool {
        self.0 == 0
    }
}

/// An opaque token handle; null opens nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WinToken(pub u64);

/// The raw Win32 surface behind identity. Tests inject a fake; production
/// binds kernel32 and Advapi32 through windows-sys.
pub trait WindowsIdentityApi {
    /// Opens the process with query and sync rights; null on failure.
    fn open(&self, pid: u32) -> WinHandle;
    /// Whether the process has exited, while the handle keeps it openable.
    fn exited(&self, handle: WinHandle) -> bool;
    /// GetProcessTimes into four FILETIME buffers; zero on failure.
    fn times(
        &self,
        handle: WinHandle,
        creation: &mut [u8; 8],
        exit: &mut [u8; 8],
        kernel: &mut [u8; 8],
        user: &mut [u8; 8],
    ) -> u32;
    /// Opens the process token; `None` on failure.
    fn open_token(&self, handle: WinHandle) -> Option<WinToken>;
    /// GetTokenInformation for TOKEN_USER; zero on failure, `needed` set.
    fn token_info(&self, token: WinToken, info: &mut [u8], needed: &mut u32) -> u32;
    /// The SID at the start of TOKEN_USER, if one is there.
    fn sid_of(&self, info: &[u8]) -> Option<u64>;
    /// Converts the SID to a string; `None` on failure.
    fn sid_to_string(&self, sid: u64) -> Option<String>;
    /// Decodes the converted string; frees it after.
    fn decode_sid(&self, text: &str) -> String;
    /// Frees a converted SID string.
    fn free_sid(&self, text: &str);
    /// Closes a token handle.
    fn close_token(&self, token: WinToken);
    /// Closes a process handle.
    fn close(&self, handle: WinHandle);
    /// The last Win32 error, read right after the call that failed.
    fn last_error(&self) -> u32;
}

/// No such process, and "size the buffer first".
pub const ERROR_INVALID_PARAMETER: u32 = 87;
/// "Size the buffer first" for the token query.
pub const ERROR_INSUFFICIENT_BUFFER: u32 = 122;
