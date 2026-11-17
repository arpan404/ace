//! A bot's AppContainer SID granted or denied on an opened object (ADR 0167 decision 1). Every
//! change is made on an open handle, never on a path, so a link swapped into a name can't
//! redirect it, and is made by merging into the object's existing DACL so the person and the
//! system keep their access. Granting and removing the same SID twice does the same thing, so a
//! crash-recovery pass is safe to repeat.

use windows::Win32::Foundation::{ERROR_SUCCESS, HLOCAL, LocalFree, WIN32_ERROR};
use windows::Win32::Security::ACL;
use windows::Win32::Security::Authorization::{
    ACCESS_MODE, DENY_ACCESS, EXPLICIT_ACCESS_W, GRANT_ACCESS, GetSecurityInfo,
    NO_MULTIPLE_TRUSTEE, REVOKE_ACCESS, SE_KERNEL_OBJECT, SetEntriesInAclW, SetSecurityInfo,
    TRUSTEE_IS_SID, TRUSTEE_TYPE, TRUSTEE_W,
};
use windows::Win32::Security::{
    ACE_FLAGS, CONTAINER_INHERIT_ACE, DACL_SECURITY_INFORMATION, OBJECT_INHERIT_ACE,
    PSECURITY_DESCRIPTOR,
};
use windows::core::PWSTR;

use crate::fs::Object;
use crate::sid::Sid;

/// What a grant allows. The read and read-write masks leave out `WRITE_DAC` and `WRITE_OWNER`,
/// so a sandboxed command can't rewrite an ACL to open a denied place back up.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Access {
    /// Read and execute.
    Read,
    /// Read, write, execute and delete ("Modify"), but not changing the ACL or owner.
    Write,
    /// No access at all, placed as a deny ACE (credential places inside a granted folder).
    Deny,
}

const READ_EXECUTE: u32 = 0x1200A9;
const MODIFY: u32 = 0x1301BF;
const GENERIC_ALL: u32 = 0x1000_0000;

impl Access {
    fn mask(self) -> u32 {
        match self {
            Access::Read => READ_EXECUTE,
            Access::Write => MODIFY,
            Access::Deny => GENERIC_ALL,
        }
    }

    fn mode(self) -> ACCESS_MODE {
        match self {
            Access::Deny => DENY_ACCESS,
            _ => GRANT_ACCESS,
        }
    }
}

/// Grants `sid` `access` on `object`, merged into its DACL and inherited by everything under it.
pub fn grant(object: &Object, sid: &Sid, access: Access) -> std::io::Result<()> {
    let flags = if object.info()?.dir {
        ACE_FLAGS(CONTAINER_INHERIT_ACE.0 | OBJECT_INHERIT_ACE.0)
    } else {
        ACE_FLAGS(0)
    };
    apply(object, sid, access.mode(), access.mask(), flags)
}

/// Removes every ACE for `sid` from `object`'s DACL. A SID with none left is left as it was.
pub fn revoke(object: &Object, sid: &Sid) -> std::io::Result<()> {
    apply(object, sid, REVOKE_ACCESS, 0, ACE_FLAGS(0))
}

fn apply(
    object: &Object,
    sid: &Sid,
    mode: ACCESS_MODE,
    mask: u32,
    inherit: ACE_FLAGS,
) -> std::io::Result<()> {
    // The SID's own bytes stand in for the trustee name (the SID form reads it from there).
    let trustee = TRUSTEE_W {
        pMultipleTrustee: std::ptr::null_mut(),
        MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
        TrusteeForm: TRUSTEE_IS_SID,
        TrusteeType: TRUSTEE_TYPE(0),
        ptstrName: PWSTR(sid.as_psid().0.cast()),
    };
    let entry = EXPLICIT_ACCESS_W {
        grfAccessPermissions: mask,
        grfAccessMode: mode,
        grfInheritance: inherit,
        Trustee: trustee,
    };

    let mut descriptor = PSECURITY_DESCRIPTOR::default();
    let mut old: *mut ACL = std::ptr::null_mut();
    // SAFETY: a handle we own; the out-params are live locals. On ERROR_SUCCESS `descriptor` is
    // a LocalAlloc'd self-relative descriptor holding the DACL `old` points into; freed below.
    let read = unsafe {
        GetSecurityInfo(
            object.raw(),
            SE_KERNEL_OBJECT,
            DACL_SECURITY_INFORMATION,
            None,
            None,
            Some(&mut old),
            None,
            Some(&mut descriptor),
        )
    };
    check(read)?;

    let mut merged: *mut ACL = std::ptr::null_mut();
    // SAFETY: `entry` and its SID outlive the call; `old` is the current DACL (or null); on
    // success `merged` is a LocalAlloc'd ACL freed below.
    let built = unsafe {
        SetEntriesInAclW(
            Some(std::slice::from_ref(&entry)),
            if old.is_null() {
                None
            } else {
                Some(old.cast_const())
            },
            &mut merged,
        )
    };
    let set = (|| {
        check(built)?;
        // SAFETY: `merged` is the ACL just built; it is written as this object's DACL.
        let written = unsafe {
            SetSecurityInfo(
                object.raw(),
                SE_KERNEL_OBJECT,
                DACL_SECURITY_INFORMATION,
                None,
                None,
                Some(merged.cast_const()),
                None,
            )
        };
        check(written)
    })();

    if !merged.is_null() {
        // SAFETY: allocated by SetEntriesInAclW with LocalAlloc.
        unsafe { LocalFree(Some(HLOCAL(merged.cast()))) };
    }
    if !descriptor.is_invalid() {
        // SAFETY: allocated by GetSecurityInfo with LocalAlloc.
        unsafe { LocalFree(Some(HLOCAL(descriptor.0))) };
    }
    set
}

fn check(code: WIN32_ERROR) -> std::io::Result<()> {
    if code == ERROR_SUCCESS {
        Ok(())
    } else {
        Err(std::io::Error::from_raw_os_error(code.0 as i32))
    }
}
