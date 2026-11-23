// SPDX-License-Identifier: Apache-2.0

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
