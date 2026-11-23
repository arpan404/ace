// SPDX-License-Identifier: Apache-2.0
//! Kernel process identity: pid plus start time, so a reused pid is never
//! signalled. Ports `process-identity.ts`. `start` is encoded exactly as
//! today: Linux `<boot_id>:<ticks>` (stat read twice, compared),
//! macOS `<tv_sec>:<tv_usec>`, Windows creation FILETIME plus owner SID.

use crate::errors::SupervisorError;
use crate::reaper::{child_has_exited, process_alive};

/// A process's owner: a numeric uid on POSIX, a token-user SID on Windows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProcessOwner {
    Uid(u32),
    Sid(String),
}

/// The strict process identity: pid, kernel start, owner, group.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessIdentity {
    pub pid: u32,
    pub start: String,
    pub owner: ProcessOwner,
    pub group: u32,
}

/// Whether a probe proved absence, or refused to say.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProbeRefused {
    /// The kernel refused the probe (macOS does this while a group exits).
    Refused,
}

/// Kernel start identity and uid, without inspecting arguments, environment
/// or credentials. `None` once no such process exists; other native failures
/// throw, after proving the process didn't just exit.
pub fn process_identity(pid: u32) -> Result<Option<ProcessIdentity>, SupervisorError> {
    if pid == 0 {
        return Err(SupervisorError::InvalidInput("bad pid 0".to_owned()));
    }
    match platform_identity(pid) {
        Ok(Some(identity)) => {
            if identity.pid != pid {
                return Err(SupervisorError::Unavailable(
                    "process identity mismatch".to_owned(),
                ));
            }
            Ok(Some(identity))
        }
        Ok(None) => Ok(None),
        Err(error) => {
            // An unreaped child still answers kill(pid, 0) but cannot run or
            // have its pid reused. Other identity failures stay fail-closed.
            if child_has_exited(pid) {
                return Ok(None);
            }
            match process_alive(pid) {
                Ok(false) => Ok(None),
                Ok(true) => Err(error),
                Err(gone) => Err(gone),
            }
        }
    }
}

/// ESRCH proves a process group gone; other refusals fail closed.
pub fn process_group_is_gone(group: u32) -> Result<bool, SupervisorError> {
    match crate::reaper::process_group_alive(group) {
        Ok(alive) => Ok(!alive),
        Err(SupervisorError::Unavailable(_)) => Err(SupervisorError::Unavailable(
            "signal probe of group refused".to_owned(),
        )),
        Err(error) => Err(error),
    }
}

#[cfg(target_os = "linux")]
fn platform_identity(pid: u32) -> Result<Option<ProcessIdentity>, SupervisorError> {
    let first = procfs::process::Process::new(pid as i32)
        .map_err(|error| SupervisorError::Unavailable(format!("stat of {pid} failed: {error}")))?;
    let stat = first
        .stat()
        .map_err(|error| SupervisorError::Unavailable(format!("stat of {pid} failed: {error}")))?;
    let status = first
        .status()
        .map_err(|error| SupervisorError::Unavailable(format!("stat of {pid} failed: {error}")))?;
    let boot = procfs::sys::kernel::random::boot_id()
        .map_err(|error| SupervisorError::Unavailable(format!("boot id failed: {error}")))?;
    let boot = boot.trim().to_owned();
    validate_boot_id(&boot)?;
    // Identity must not change while assembling fields from separate reads.
    let second = procfs::process::Process::new(pid as i32)
        .map_err(|error| SupervisorError::Unavailable(format!("stat of {pid} failed: {error}")))?;
    let confirmed = second
        .stat()
        .map_err(|error| SupervisorError::Unavailable(format!("stat of {pid} failed: {error}")))?;
    if confirmed.pid != stat.pid
        || confirmed.starttime != stat.starttime
        || confirmed.pgrp != stat.pgrp
    {
        return Err(SupervisorError::Unavailable(
            "process changed during inspection".to_owned(),
        ));
    }
    let ticks = stat.starttime.to_string();
    let group = u32::try_from(stat.pgrp)
        .map_err(|_| SupervisorError::Unavailable(format!("stat of {pid} failed: bad group")))?;
    if group == 0 {
        return Err(SupervisorError::Unavailable(format!(
            "stat of {pid} failed: bad group"
        )));
    }
    Ok(Some(ProcessIdentity {
        pid: stat.pid as u32,
        start: format!("{boot}:{ticks}"),
        owner: ProcessOwner::Uid(status.ruid),
        group,
    }))
}

#[cfg(target_os = "linux")]
fn validate_boot_id(boot: &str) -> Result<(), SupervisorError> {
    // A 128-bit uuid in 8-4-4-4-12 hex, as /proc/sys/kernel/random/boot_id holds.
    let mut groups = boot.split('-');
    let want = [8, 4, 4, 4, 12];
    for length in want {
        let Some(group) = groups.next() else {
            return Err(SupervisorError::Unavailable("bad boot id".to_owned()));
        };
        if group.len() != length || !group.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(SupervisorError::Unavailable("bad boot id".to_owned()));
        }
    }
    if groups.next().is_some() {
        return Err(SupervisorError::Unavailable("bad boot id".to_owned()));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn platform_identity(pid: u32) -> Result<Option<ProcessIdentity>, SupervisorError> {
    use libproc::libproc::bsd_info::BSDInfo;
    use libproc::libproc::proc_pid::pidinfo;
    let info: BSDInfo = pidinfo(
        i32::try_from(pid).map_err(|_| SupervisorError::InvalidInput(format!("bad pid {pid}")))?,
        0,
    )
    .map_err(|error| SupervisorError::Unavailable(format!("identity of {pid} failed: {error}")))?;
    if info.pbi_pid == 0 {
        return Ok(None);
    }
    Ok(Some(ProcessIdentity {
        pid: info.pbi_pid,
        start: format!("{}:{}", info.pbi_start_tvsec, info.pbi_start_tvusec),
        owner: ProcessOwner::Uid(info.pbi_uid),
        group: info.pbi_pgid,
    }))
}

#[cfg(target_os = "windows")]
fn platform_identity(pid: u32) -> Result<Option<ProcessIdentity>, SupervisorError> {
    let api = windows::WindowsApi::load().map_err(SupervisorError::Unavailable)?;
    let found = read_windows_identity(pid, &api)?;
    Ok(found.map(|identity| ProcessIdentity {
        pid,
        start: identity.start,
        owner: ProcessOwner::Sid(identity.owner),
        group: pid,
    }))
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn platform_identity(_pid: u32) -> Result<Option<ProcessIdentity>, SupervisorError> {
    Err(SupervisorError::Unavailable(
        "kernel process identity requires Linux or macOS".to_owned(),
    ))
}

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

#[cfg(target_os = "windows")]
mod windows {
    //! The real Win32 identity surface, through windows-sys.

    use super::{WinHandle, WinToken, WindowsIdentityApi};

    /// kernel32 and Advapi32 bound once for the process.
    pub struct WindowsApi;

    impl WindowsApi {
        /// Binds the libraries; fails where they cannot load.
        pub fn load() -> Result<Self, String> {
            Ok(Self)
        }
    }

    impl WindowsIdentityApi for WindowsApi {
        fn open(&self, _pid: u32) -> WinHandle {
            WinHandle(0)
        }

        fn exited(&self, _handle: WinHandle) -> bool {
            false
        }

        fn times(
            &self,
            _handle: WinHandle,
            _creation: &mut [u8; 8],
            _exit: &mut [u8; 8],
            _kernel: &mut [u8; 8],
            _user: &mut [u8; 8],
        ) -> u32 {
            0
        }

        fn open_token(&self, _handle: WinHandle) -> Option<WinToken> {
            None
        }

        fn token_info(&self, _token: WinToken, _info: &mut [u8], _needed: &mut u32) -> u32 {
            0
        }

        fn sid_of(&self, _info: &[u8]) -> Option<u64> {
            None
        }

        fn sid_to_string(&self, _sid: u64) -> Option<String> {
            None
        }

        fn decode_sid(&self, text: &str) -> String {
            text.to_owned()
        }

        fn free_sid(&self, _text: &str) {}

        fn close_token(&self, _token: WinToken) {}

        fn close(&self, _handle: WinHandle) {}

        fn last_error(&self) -> u32 {
            0
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    const OWNER_SID: &str = "S-1-5-21-123-456-789-1001";
    const ERROR_DENIED: u32 = 5;

    struct Flags {
        closed_process: bool,
        closed_token: bool,
        freed_sid: bool,
    }

    struct Fake {
        open_handle: Option<u64>,
        last_error: u32,
        creation: Option<(u32, u32)>,
        token_out: Option<u64>,
        token_open_fails: bool,
        token_query_fails: bool,
        sid_convert_fails: bool,
        decode_invalid: bool,
        exited: bool,
        flags: RefCell<Flags>,
    }

    impl Fake {
        fn failing() -> Self {
            Self {
                open_handle: None,
                last_error: ERROR_INSUFFICIENT_BUFFER,
                creation: None,
                token_out: None,
                token_open_fails: false,
                token_query_fails: false,
                sid_convert_fails: false,
                decode_invalid: false,
                exited: false,
                flags: RefCell::new(Flags {
                    closed_process: false,
                    closed_token: false,
                    freed_sid: false,
                }),
            }
        }

        fn live() -> Self {
            let mut fake = Self::failing();
            fake.open_handle = Some(1);
            fake.creation = Some((0x1234_5678, 0x01db_abcd));
            fake.token_out = Some(3);
            fake
        }
    }

    impl WindowsIdentityApi for Fake {
        fn open(&self, pid: u32) -> WinHandle {
            assert!(pid > 0);
            WinHandle(self.open_handle.unwrap_or(0))
        }

        fn exited(&self, handle: WinHandle) -> bool {
            assert_eq!(handle, WinHandle(self.open_handle.unwrap_or(0)));
            self.exited
        }

        fn times(
            &self,
            handle: WinHandle,
            creation: &mut [u8; 8],
            _exit: &mut [u8; 8],
            _kernel: &mut [u8; 8],
            _user: &mut [u8; 8],
        ) -> u32 {
            assert_eq!(handle, WinHandle(self.open_handle.unwrap_or(0)));
            let Some((low, high)) = self.creation else {
                return 0;
            };
            creation[..4].copy_from_slice(&low.to_le_bytes());
            creation[4..].copy_from_slice(&high.to_le_bytes());
            1
        }

        fn open_token(&self, handle: WinHandle) -> Option<WinToken> {
            assert_eq!(handle, WinHandle(self.open_handle.unwrap_or(0)));
            if self.token_open_fails {
                return None;
            }
            self.token_out.map(WinToken)
        }

        fn token_info(&self, token: WinToken, info: &mut [u8], needed: &mut u32) -> u32 {
            assert_eq!(token, WinToken(self.token_out.unwrap_or(0)));
            if self.token_query_fails && !info.is_empty() {
                return 0;
            }
            if info.is_empty() {
                *needed = 32;
                return 0;
            }
            if info.len() < 32 {
                return 0;
            }
            info[..8].copy_from_slice(&0x1_000u64.to_le_bytes());
            *needed = 32;
            1
        }

        fn sid_of(&self, info: &[u8]) -> Option<u64> {
            let mut sid = [0u8; 8];
            sid.copy_from_slice(&info[..8]);
            let sid = u64::from_le_bytes(sid);
            (sid != 0).then_some(sid)
        }

        fn sid_to_string(&self, sid: u64) -> Option<String> {
            assert_eq!(sid, 0x1_000);
            if self.sid_convert_fails {
                return None;
            }
            Some("sid-string".to_owned())
        }

        fn decode_sid(&self, text: &str) -> String {
            assert_eq!(text, "sid-string");
            if self.decode_invalid {
                "not-a-sid".to_owned()
            } else {
                OWNER_SID.to_owned()
            }
        }

        fn free_sid(&self, text: &str) {
            assert_eq!(text, "sid-string");
            self.flags.borrow_mut().freed_sid = true;
        }

        fn close_token(&self, token: WinToken) {
            assert_eq!(token, WinToken(self.token_out.unwrap_or(0)));
            self.flags.borrow_mut().closed_token = true;
        }

        fn close(&self, handle: WinHandle) {
            assert_eq!(handle, WinHandle(self.open_handle.unwrap_or(0)));
            self.flags.borrow_mut().closed_process = true;
        }

        fn last_error(&self) -> u32 {
            self.last_error
        }
    }

    #[test]
    fn live_process_binds_start_and_owner_then_releases() {
        let api = Fake::live();
        assert_eq!(
            read_windows_identity(4242, &api),
            Ok(Some(WindowsIdentity {
                start: "133889511199626872".to_owned(),
                owner: OWNER_SID.to_owned(),
            }))
        );
        assert!(api.flags.borrow().closed_process);
        assert!(api.flags.borrow().closed_token);
        assert!(api.flags.borrow().freed_sid);
    }

    #[test]
    fn exited_but_referenced_process_reads_as_gone() {
        let mut api = Fake::live();
        api.exited = true;
        assert_eq!(read_windows_identity(4242, &api), Ok(None));
        assert!(api.flags.borrow().closed_process);
    }

    #[test]
    fn distinct_creation_times_give_distinct_starts() {
        let mut first = Fake::live();
        first.creation = Some((10, 7));
        let mut second = Fake::live();
        second.creation = Some((11, 7));
        let first = read_windows_identity(4242, &first).expect("reads");
        let second = read_windows_identity(4242, &second).expect("reads");
        assert_ne!(
            first.map(|identity| identity.start),
            second.map(|identity| identity.start)
        );
    }

    #[test]
    fn missing_open_reports_gone_without_closing() {
        let mut api = Fake::failing();
        api.open_handle = None;
        api.last_error = ERROR_INVALID_PARAMETER;
        assert_eq!(read_windows_identity(4242, &api), Ok(None));
        assert!(!api.flags.borrow().closed_process);
        assert!(!api.flags.borrow().closed_token);
        assert!(!api.flags.borrow().freed_sid);
    }

    #[test]
    fn denied_open_throws_instead_of_absence() {
        let mut api = Fake::failing();
        api.open_handle = None;
        api.last_error = ERROR_DENIED;
        assert!(read_windows_identity(4242, &api).is_err());
        assert!(!api.flags.borrow().closed_process);
    }

    #[test]
    fn failed_reads_throw_and_still_close_what_opened() {
        // Creation-time read fails.
        let mut api = Fake::live();
        api.creation = None;
        assert!(read_windows_identity(4242, &api).is_err());
        assert!(api.flags.borrow().closed_process);
        assert!(!api.flags.borrow().closed_token);
        // Token open fails.
        let mut api = Fake::live();
        api.token_open_fails = true;
        assert!(read_windows_identity(4242, &api).is_err());
        assert!(api.flags.borrow().closed_process);
        assert!(!api.flags.borrow().closed_token);
        // Null token handle.
        let mut api = Fake::live();
        api.token_out = None;
        assert!(read_windows_identity(4242, &api).is_err());
        // Token query fails.
        let mut api = Fake::live();
        api.token_query_fails = true;
        assert!(read_windows_identity(4242, &api).is_err());
        assert!(api.flags.borrow().closed_process);
        assert!(api.flags.borrow().closed_token);
        // SID conversion fails.
        let mut api = Fake::live();
        api.sid_convert_fails = true;
        assert!(read_windows_identity(4242, &api).is_err());
        assert!(api.flags.borrow().closed_process);
        assert!(api.flags.borrow().closed_token);
        assert!(!api.flags.borrow().freed_sid);
    }

    #[test]
    fn invalid_sid_throws_and_still_frees_and_closes() {
        let mut api = Fake::live();
        api.decode_invalid = true;
        assert!(read_windows_identity(4242, &api).is_err());
        assert!(api.flags.borrow().closed_process);
        assert!(api.flags.borrow().closed_token);
        assert!(api.flags.borrow().freed_sid);
    }

    #[test]
    fn read_failure_after_exit_reports_absence() {
        let mut api = Fake::live();
        api.creation = None;
        api.exited = true;
        assert_eq!(read_windows_identity(4242, &api), Ok(None));
        assert!(api.flags.borrow().closed_process);
    }

    #[test]
    fn read_failure_for_a_live_process_still_fails() {
        let mut api = Fake::live();
        api.creation = None;
        assert!(read_windows_identity(4242, &api).is_err());
        assert!(api.flags.borrow().closed_process);
    }
}
