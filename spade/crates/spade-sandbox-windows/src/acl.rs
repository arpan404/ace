//! A bot's AppContainer SID granted or denied on an opened object (ADR 0167 decision 1). Every
//! change is made on an open handle, never on a path, so a link swapped into a name can't
//! redirect it, and is made by merging into the object's existing DACL so the person and the
//! system keep their access. Granting and removing the same SID twice does the same thing, so a
//! crash-recovery pass is safe to repeat.

use windows::Win32::Foundation::{ERROR_SUCCESS, HLOCAL, LocalFree, WIN32_ERROR};
use windows::Win32::Security::ACL;
use windows::Win32::Security::Authorization::{
    ACCESS_MODE, EXPLICIT_ACCESS_W, GRANT_ACCESS, GetSecurityInfo, NO_MULTIPLE_TRUSTEE,
    REVOKE_ACCESS, SE_FILE_OBJECT, SetEntriesInAclW, SetSecurityInfo, TRUSTEE_IS_SID, TRUSTEE_TYPE,
    TRUSTEE_W,
};
use windows::Win32::Security::{
    ACE_FLAGS, CONTAINER_INHERIT_ACE, DACL_SECURITY_INFORMATION, OBJECT_INHERIT_ACE,
    OBJECT_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, UNPROTECTED_DACL_SECURITY_INFORMATION,
};
use windows::core::PWSTR;

/// A trustee naming `sid` by its own bytes (the SID form reads the name pointer as a `PSID`).
fn trustee(sid: &Sid) -> TRUSTEE_W {
    TRUSTEE_W {
        pMultipleTrustee: std::ptr::null_mut(),
        MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
        TrusteeForm: TRUSTEE_IS_SID,
        TrusteeType: TRUSTEE_TYPE(0),
        ptstrName: PWSTR(sid.as_psid().0.cast()),
    }
}

/// Writing the DACL propagates inheritable ACEs down to existing children (`UNPROTECTED` keeps
/// the object inheriting too), so revoking a parent's inheritable ACE removes the inherited copies
/// on its descendants.
fn unprotected() -> OBJECT_SECURITY_INFORMATION {
    OBJECT_SECURITY_INFORMATION(
        DACL_SECURITY_INFORMATION.0 | UNPROTECTED_DACL_SECURITY_INFORMATION.0,
    )
}

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
}

const READ_EXECUTE: u32 = 0x1200A9;
const MODIFY: u32 = 0x1301BF;

impl Access {
    fn mask(self) -> u32 {
        match self {
            Access::Read => READ_EXECUTE,
            Access::Write => MODIFY,
        }
    }
}

/// Sets `sid`'s access on `object` to exactly `access`: the SID's previous allow ACEs on this
/// object are removed first, then the one new ACE is added, so a folder changed from read-write to
/// read-only no longer keeps Modify. On a directory the ACE is inheritable, and the write
/// propagates it to existing children. Spade only ever calls this on folders it owns under its own
/// data directory, never on the person's folders.
pub fn grant(object: &Object, sid: &Sid, access: Access) -> std::io::Result<()> {
    let inherit = if object.info()?.dir {
        ACE_FLAGS(CONTAINER_INHERIT_ACE.0 | OBJECT_INHERIT_ACE.0)
    } else {
        ACE_FLAGS(0)
    };
    // Two writes, not one: a REVOKE and a GRANT for the same trustee in a single `SetEntriesInAcl`
    // net out to an empty allow. First remove the SID's old ACEs, then add exactly the new one,
    // propagating the inheritable ACE to existing children.
    revoke(object, sid)?;
    apply(
        object,
        &[entry(sid, GRANT_ACCESS, access.mask(), inherit)],
        unprotected(),
    )
}

/// Removes every ACE for `sid` from `object`'s DACL, and (on a directory) propagates the removal
/// to the inherited copies on its descendants. A SID with none left is left as it was.
pub fn revoke(object: &Object, sid: &Sid) -> std::io::Result<()> {
    apply(
        object,
        &[entry(sid, REVOKE_ACCESS, 0, ACE_FLAGS(0))],
        unprotected(),
    )
}

/// One explicit-access entry for `sid`.
fn entry(sid: &Sid, mode: ACCESS_MODE, mask: u32, inherit: ACE_FLAGS) -> EXPLICIT_ACCESS_W {
    EXPLICIT_ACCESS_W {
        grfAccessPermissions: mask,
        grfAccessMode: mode,
        grfInheritance: inherit,
        Trustee: trustee(sid),
    }
}

/// One ACE as scanning sees it.
struct Ace {
    allow: bool,
    inherited: bool,
    mask: u32,
}

/// Reads `object`'s DACL and calls `f` for every ACE naming `sid`, returning the first `Some`.
fn scan<T>(
    object: &Object,
    sid: &Sid,
    mut f: impl FnMut(Ace) -> Option<T>,
) -> std::io::Result<Option<T>> {
    use windows::Win32::Foundation::{HLOCAL, LocalFree};
    use windows::Win32::Security::{ACE_HEADER, ACL, EqualSid, GetAce, INHERITED_ACE, PSID};

    // `ACCESS_ALLOWED_ACE_TYPE` as the one byte an ACE header stores.
    const ALLOW_TYPE: u8 = 0;

    let mut descriptor = PSECURITY_DESCRIPTOR::default();
    let mut dacl: *mut ACL = std::ptr::null_mut();
    // SAFETY: a handle we own; out-params are live locals. On success `descriptor` is a
    // LocalAlloc'd descriptor holding the DACL `dacl` points into; freed below.
    let read = unsafe {
        GetSecurityInfo(
            object.raw(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            None,
            None,
            Some(&mut dacl),
            None,
            Some(&mut descriptor),
        )
    };
    let result = (|| {
        check(read)?;
        if dacl.is_null() {
            return Ok(None);
        }
        // SAFETY: `dacl` is a valid ACL from the call above.
        let count = unsafe { (*dacl).AceCount };
        for index in 0..u32::from(count) {
            let mut ace: *mut core::ffi::c_void = std::ptr::null_mut();
            // SAFETY: `dacl` is valid and `index` is in range; `ace` receives a pointer into it.
            if unsafe { GetAce(dacl, index, &mut ace) }.is_err() {
                continue;
            }
            // Allow and deny ACEs share the layout: an `ACE_HEADER`, then a `u32` mask, then the
            // SID. Read the header for the type/flags, the mask after it, and the SID after that.
            // SAFETY: `ace` points at a valid ACE at least as large as its header.
            let header = unsafe { *ace.cast::<ACE_HEADER>() };
            // SAFETY: the mask is the dword right after the header.
            let mask = unsafe { *ace.cast::<u8>().add(size_of::<ACE_HEADER>()).cast::<u32>() };
            // SAFETY: the SID follows the mask.
            let sid_ptr = unsafe {
                ace.cast::<u8>()
                    .add(size_of::<ACE_HEADER>() + size_of::<u32>())
            };
            // SAFETY: both are valid SIDs.
            if unsafe { EqualSid(PSID(sid_ptr.cast()), sid.as_psid()) }.is_err() {
                continue;
            }
            let item = Ace {
                allow: header.AceType == ALLOW_TYPE,
                inherited: header.AceFlags & INHERITED_ACE.0 as u8 != 0,
                mask,
            };
            if let Some(found) = f(item) {
                return Ok(Some(found));
            }
        }
        Ok(None)
    })();
    if !descriptor.is_invalid() {
        // SAFETY: allocated by GetSecurityInfo with LocalAlloc.
        unsafe { LocalFree(Some(HLOCAL(descriptor.0))) };
    }
    result
}

/// Whether `object`'s DACL has any ACE naming `sid` (for tests and recovery checks).
pub fn granted(object: &Object, sid: &Sid) -> std::io::Result<bool> {
    Ok(scan(object, sid, |_| Some(()))?.is_some())
}

/// The mask of `sid`'s own (non-inherited) allow ACE on `object`, if it has one. Tests use this to
/// check a grant was reconciled to exact rights (not merged with an older one).
pub fn allow_mask(object: &Object, sid: &Sid) -> std::io::Result<Option<u32>> {
    scan(object, sid, |ace| {
        (ace.allow && !ace.inherited).then_some(ace.mask)
    })
}

/// Whether `object` has any ACE for `sid` that was inherited from a parent (for tests).
pub fn inherited(object: &Object, sid: &Sid) -> std::io::Result<bool> {
    Ok(scan(object, sid, |ace| ace.inherited.then_some(()))?.is_some())
}

fn apply(
    object: &Object,
    entries: &[EXPLICIT_ACCESS_W],
    info: OBJECT_SECURITY_INFORMATION,
) -> std::io::Result<()> {
    let mut descriptor = PSECURITY_DESCRIPTOR::default();
    let mut old: *mut ACL = std::ptr::null_mut();
    // SAFETY: a handle we own; the out-params are live locals. On ERROR_SUCCESS `descriptor` is
    // a LocalAlloc'd self-relative descriptor holding the DACL `old` points into; freed below.
    let read = unsafe {
        GetSecurityInfo(
            object.raw(),
            SE_FILE_OBJECT,
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
    // SAFETY: `entries` and their SIDs outlive the call; `old` is the current DACL (or null); on
    // success `merged` is a LocalAlloc'd ACL freed below.
    let built = unsafe {
        SetEntriesInAclW(
            Some(entries),
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
        // SAFETY: `merged` is the ACL just built; it is written as this object's DACL, treated as
        // a file object so inheritable ACEs propagate to existing children.
        let written = unsafe {
            SetSecurityInfo(
                object.raw(),
                SE_FILE_OBJECT,
                info,
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
