//! The Windows system calls behind Spade's sandbox (ADR 0167 decision 1, amendment 1). Each
//! module wraps one kind of object in a safe API; `spade-sandbox`, which forbids `unsafe`, holds
//! the policy and calls these. Empty on other systems.

#[cfg(windows)]
pub mod acl;
#[cfg(windows)]
pub mod event;
#[cfg(windows)]
pub mod fs;
#[cfg(windows)]
pub mod job;
#[cfg(windows)]
pub mod launch;
#[cfg(windows)]
pub mod pipe;
#[cfg(windows)]
pub mod profile;
#[cfg(windows)]
pub mod sid;

/// A Windows error as an `io::Error`.
#[cfg(windows)]
pub(crate) fn io(error: windows::core::Error) -> std::io::Error {
    std::io::Error::from_raw_os_error(error.code().0 & 0xFFFF)
}

/// `text` as a NUL-terminated wide string.
#[cfg(windows)]
pub(crate) fn wide(text: &std::ffi::OsStr) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    text.encode_wide().chain(std::iter::once(0)).collect()
}
