//! AppContainer profiles: one per sandbox identity, with no capabilities.

use windows::Win32::Foundation::ERROR_ALREADY_EXISTS;
use windows::Win32::Security::FreeSid;
use windows::Win32::Security::Isolation::{
    CreateAppContainerProfile, DeleteAppContainerProfile, DeriveAppContainerSidFromAppContainerName,
};
use windows::core::{HRESULT, HSTRING};

use crate::sid::Sid;

/// The profile named `name` (made when missing), and its SID. It has no capabilities: no
/// network, no library folders, no devices.
pub fn ensure(name: &str, display: &str) -> std::io::Result<Sid> {
    let (name, display) = (HSTRING::from(name), HSTRING::from(display));
    // SAFETY: plain strings in; on success the SID is allocated by the call and freed below.
    let made = unsafe { CreateAppContainerProfile(&name, &display, &display, None) };
    let raw = match made {
        Ok(raw) => raw,
        Err(error) if error.code() == HRESULT::from_win32(ERROR_ALREADY_EXISTS.0) => {
            // SAFETY: as above; the SID is freed below.
            unsafe { DeriveAppContainerSidFromAppContainerName(&name) }.map_err(crate::io)?
        }
        Err(error) => return Err(crate::io(error)),
    };
    // SAFETY: `raw` is the valid SID the call returned.
    let sid = unsafe { Sid::copy(raw) };
    // SAFETY: both calls document freeing their SID with FreeSid.
    unsafe { FreeSid(raw) };
    sid
}

/// Deletes the profile named `name`. One that doesn't exist is already gone, which counts as
/// success so cleanup can treat "the profile is deleted" as a durable end state.
pub fn delete(name: &str) -> std::io::Result<()> {
    use windows::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_NOT_FOUND};

    // SAFETY: a plain string in.
    match unsafe { DeleteAppContainerProfile(&HSTRING::from(name)) } {
        Ok(()) => Ok(()),
        Err(error)
            if error.code() == HRESULT::from_win32(ERROR_FILE_NOT_FOUND.0)
                || error.code() == HRESULT::from_win32(ERROR_NOT_FOUND.0) =>
        {
            Ok(())
        }
        Err(error) => Err(crate::io(error)),
    }
}
