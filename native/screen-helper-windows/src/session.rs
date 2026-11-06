//! Connection and input-desktop facts must both authorize desktop initialization.
use crate::errors::{Code, Error, Result};

/// WTSActive is 0. Other states, unknown queries and service session 0 cannot send input.
pub fn allows_input(session: u32, state: Option<i32>) -> bool {
    session != 0 && state == Some(0)
}

pub fn desktop_access(session: u32, state: Option<i32>, default_desktop: bool) -> Result<()> {
    if session == 0 {
        return Err(Error::new(Code::PermissionDenied, "Windows session 0 cannot access the person's desktop. Run ace in your signed-in session, not as a service in session 0."));
    }
    if !allows_input(session, state) {
        return Err(Error::new(Code::Busy, "Windows session is not actively connected. Sign in or reconnect to this session, then retry."));
    }
    if !default_desktop {
        return Err(Error::new(Code::Busy, "Windows input desktop is unavailable. Unlock the workstation and dismiss any UAC prompt, then retry."));
    }
    Ok(())
}

#[cfg(windows)]
pub fn current_access() -> Result<()> {
    use windows::{
        core::PWSTR,
        Win32::{
            Foundation::HANDLE,
            System::{RemoteDesktop::*, StationsAndDesktops::*, Threading::GetCurrentProcessId},
        },
    };
    unsafe {
        let mut session = 0;
        ProcessIdToSessionId(GetCurrentProcessId(), &mut session)
            .map_err(|error| Error::from(error).context("Read Windows session id"))?;
        let mut buffer = PWSTR::null();
        let mut bytes = 0;
        let query = WTSQuerySessionInformationW(
            WTS_CURRENT_SERVER_HANDLE,
            session,
            WTSConnectState,
            &mut buffer,
            &mut bytes,
        );
        let state = if query.is_ok()
            && !buffer.is_null()
            && bytes as usize >= std::mem::size_of::<WTS_CONNECTSTATE_CLASS>()
        {
            Some(std::ptr::read_unaligned(buffer.0.cast::<WTS_CONNECTSTATE_CLASS>()).0)
        } else {
            None
        };
        if !buffer.is_null() {
            WTSFreeMemory(buffer.0.cast());
        }
        if !allows_input(session, state) {
            return desktop_access(session, state, false);
        }
        let default_desktop =
            match OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_READOBJECTS) {
                Ok(desktop) => {
                    let mut name = [0u16; 128];
                    let read = GetUserObjectInformationW(
                        HANDLE(desktop.0),
                        UOI_NAME,
                        Some(name.as_mut_ptr().cast()),
                        (name.len() * 2) as u32,
                        None,
                    );
                    let _ = CloseDesktop(desktop);
                    let end = name.iter().position(|c| *c == 0).unwrap_or(name.len());
                    read.is_ok()
                        && String::from_utf16_lossy(&name[..end]).eq_ignore_ascii_case("default")
                }
                Err(_) => false,
            };
        desktop_access(session, state, default_desktop)
    }
}

#[cfg(test)]
mod tests {
    use super::allows_input;
    #[test]
    fn connected_console_and_rdp_sessions_allow_input_but_disconnected_sessions_do_not() {
        for session in [1, 5, 42] {
            assert!(allows_input(session, Some(0)));
        }
        assert!(!allows_input(0, Some(0)));
        for state in 1..=9 {
            assert!(!allows_input(5, Some(state)));
        }
        assert!(!allows_input(5, None));
    }
    #[test]
    fn desktop_startup_requires_an_active_user_session_and_its_input_desktop() {
        use super::desktop_access;
        for (session, state, desktop, reason) in [
            (0, Some(0), true, "session 0"),
            (1, Some(4), true, "reconnect"),
            (1, None, true, "reconnect"),
            (1, Some(0), false, "Unlock"),
        ] {
            assert!(desktop_access(session, state, desktop)
                .unwrap_err()
                .message
                .contains(reason));
        }
        for session in [1, 5, 42] {
            assert!(desktop_access(session, Some(0), true).is_ok());
        }
    }
}
