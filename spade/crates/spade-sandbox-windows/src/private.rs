//! Folders and files only their owner can open (ADR 0214: Spade's sealed sign-ins). Each is
//! created with a protected DACL granting the owner and the system full access and nobody else,
//! set at creation, so no byte is ever written under a looser one, whatever the folder it is in
//! would pass on.

use std::os::windows::io::{FromRawHandle, OwnedHandle};
use std::path::Path;

use windows::Win32::Foundation::{ERROR_ALREADY_EXISTS, HLOCAL, LocalFree};
use windows::Win32::Security::Authorization::{
    ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows::Win32::Security::{PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES};
use windows::Win32::Storage::FileSystem::{
    CREATE_NEW, CreateDirectoryW, CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_GENERIC_WRITE,
    FILE_SHARE_MODE,
};
use windows::core::{HSTRING, PCWSTR};

/// The owner and the system, full access, inherited by what is made inside; nothing from above.
const OWNER_ONLY: &str = "D:P(A;OICI;FA;;;OW)(A;OICI;FA;;;SY)";

/// An owned owner-only descriptor, freed on drop.
struct OwnerOnly(PSECURITY_DESCRIPTOR);

impl OwnerOnly {
    fn new() -> std::io::Result<Self> {
        let mut descriptor = PSECURITY_DESCRIPTOR::default();
        // SAFETY: a NUL-terminated string in; on success `descriptor` is a LocalAlloc'd
        // self-relative descriptor, freed in `Drop`.
        unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                &HSTRING::from(OWNER_ONLY),
                SDDL_REVISION_1,
                &mut descriptor,
                None,
            )
        }
        .map_err(crate::io)?;
        Ok(Self(descriptor))
    }

    fn attributes(&self) -> SECURITY_ATTRIBUTES {
        SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: self.0.0,
            bInheritHandle: false.into(),
        }
    }
}

impl Drop for OwnerOnly {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            // SAFETY: allocated by ConvertStringSecurityDescriptorToSecurityDescriptorW.
            unsafe { LocalFree(Some(HLOCAL(self.0.0))) };
        }
    }
}

/// Makes the folder `path` with an owner-only DACL. One already there is left as it is.
pub fn create_dir(path: &Path) -> std::io::Result<()> {
    let security = OwnerOnly::new()?;
    let attributes = security.attributes();
    let name = crate::wide(path.as_os_str());
    // SAFETY: `name` is NUL-terminated and `attributes` points at a live descriptor; both outlive
    // the call.
    let made = unsafe { CreateDirectoryW(PCWSTR(name.as_ptr()), Some(&attributes)) };
    match made {
        Ok(()) => Ok(()),
        Err(error) if error.code() == ERROR_ALREADY_EXISTS.to_hresult() => Ok(()),
        Err(error) => Err(crate::io(error)),
    }
}

/// Makes the new file `path` with an owner-only DACL, open for writing and shared with nobody;
/// fails if it exists.
pub fn create_new_file(path: &Path) -> std::io::Result<std::fs::File> {
    let security = OwnerOnly::new()?;
    let attributes = security.attributes();
    let name = crate::wide(path.as_os_str());
    // SAFETY: `name` is NUL-terminated and `attributes` points at a live descriptor; both outlive
    // the call. The handle is checked and owned below.
    let handle = unsafe {
        CreateFileW(
            PCWSTR(name.as_ptr()),
            FILE_GENERIC_WRITE.0,
            FILE_SHARE_MODE(0),
            Some(&attributes),
            CREATE_NEW,
            FILE_ATTRIBUTE_NORMAL,
            None,
        )
    }
    .map_err(crate::io)?;
    // SAFETY: a fresh handle this file now owns alone.
    let owned = unsafe { OwnedHandle::from_raw_handle(handle.0) };
    Ok(std::fs::File::from(owned))
}
