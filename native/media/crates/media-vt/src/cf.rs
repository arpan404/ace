// SPDX-License-Identifier: Apache-2.0
//! Small CoreFoundation and VTSession helpers shared by the sessions.
#![allow(unsafe_code)]
use media_codec::CodecError;
use objc2_core_foundation::{
    CFBoolean, CFDictionary, CFNumber, CFRetained, CFString, CFType, kCFAllocatorDefault,
};
use objc2_core_media::{CMTime, kCMTimeInvalid};
use objc2_video_toolbox::{VTSession, VTSessionCopyProperty, VTSessionSetProperty};
use std::ffi::c_void;
use std::ptr::NonNull;

pub(crate) fn check(status: i32, operation: &str) -> Result<(), CodecError> {
    if status == 0 {
        Ok(())
    } else {
        Err(CodecError::Backend(format!(
            "VideoToolbox {operation} failed ({status})"
        )))
    }
}

pub(crate) fn number(value: i64) -> CFRetained<CFNumber> {
    CFNumber::new_i64(value)
}

pub(crate) fn float(value: f64) -> CFRetained<CFNumber> {
    CFNumber::new_f64(value)
}

pub(crate) fn boolean(value: bool) -> &'static CFBoolean {
    CFBoolean::new(value)
}

/// A string-keyed dictionary of CF values.
pub(crate) fn dictionary(entries: &[(&CFString, &CFType)]) -> CFRetained<CFDictionary> {
    let keys: Vec<&CFString> = entries.iter().map(|(key, _)| *key).collect();
    let values: Vec<&CFType> = entries.iter().map(|(_, value)| *value).collect();
    let typed: CFRetained<CFDictionary<CFString, CFType>> =
        CFDictionary::from_slices(&keys, &values);
    // SAFETY: Erasing the generic key/value types of a CFDictionary is a no-op;
    // CF dictionaries are untyped at run time.
    unsafe { CFRetained::cast_unchecked(typed) }
}

/// A dictionary of one `key: true` entry, e.g. a hardware specification.
pub(crate) fn flag_dictionary(key: &CFString) -> CFRetained<CFDictionary> {
    dictionary(&[(key, boolean(true).as_ref())])
}

/// Whether `dictionary[key]` is `kCFBooleanTrue`.
pub(crate) fn flag(dictionary: &CFDictionary, key: &CFString) -> bool {
    // SAFETY: A +0 lookup with a CFString key; the value is borrowed only here.
    unsafe {
        let value = dictionary.value((key as *const CFString).cast());
        value
            .cast::<CFType>()
            .as_ref()
            .and_then(|v| v.downcast_ref::<CFBoolean>())
            .is_some_and(CFBoolean::as_bool)
    }
}

pub(crate) fn set(
    session: &VTSession,
    key: &CFString,
    value: &CFType,
    what: &str,
) -> Result<(), CodecError> {
    // SAFETY: Each caller passes a value of the type the key documents.
    check(
        unsafe { VTSessionSetProperty(session, key, Some(value)) },
        what,
    )
}

/// A boolean session property, or `None` when the session doesn't report it.
pub(crate) fn copy_bool(session: &VTSession, key: &CFString) -> Option<bool> {
    let mut out: *const CFType = std::ptr::null();
    // SAFETY: The out pointer receives a +1 CF object or stays null.
    let status = unsafe {
        VTSessionCopyProperty(
            session,
            key,
            kCFAllocatorDefault,
            (&raw mut out).cast::<c_void>(),
        )
    };
    let value = NonNull::new(out.cast_mut())?;
    // SAFETY: Copy returns an owned reference (the create rule).
    let value: CFRetained<CFType> = unsafe { CFRetained::from_raw(value) };
    if status != 0 {
        return None;
    }
    value.downcast_ref::<CFBoolean>().map(CFBoolean::as_bool)
}

pub(crate) fn time_us(us: u64) -> CMTime {
    // SAFETY: CMTimeMake has no preconditions.
    unsafe { CMTime::new(i64::try_from(us).unwrap_or(i64::MAX), 1_000_000) }
}

pub(crate) fn invalid_time() -> CMTime {
    // SAFETY: Reading an immutable framework constant.
    unsafe { kCMTimeInvalid }
}

pub(crate) fn us_from_time(time: CMTime) -> u64 {
    if time.timescale <= 0 || time.value < 0 {
        return 0;
    }
    let value = i128::from(time.value) * 1_000_000 / i128::from(time.timescale);
    u64::try_from(value).unwrap_or(u64::MAX)
}
