//! Session connection state is separate from input-desktop availability.

/// WTSActive is 0. Other states, unknown queries and service session 0 cannot send input.
pub fn allows_input(session: u32, state: Option<i32>) -> bool {
    session != 0 && state == Some(0)
}

#[cfg(windows)]
pub fn active() -> bool {
    use windows::{
        core::PWSTR,
        Win32::System::{RemoteDesktop::*, Threading::GetCurrentProcessId},
    };
    unsafe {
        let mut session = 0;
        if ProcessIdToSessionId(GetCurrentProcessId(), &mut session).is_err() || session == 0 {
            return false;
        }
        let mut buffer = PWSTR::null();
        let mut bytes = 0;
        let result = WTSQuerySessionInformationW(
            WTS_CURRENT_SERVER_HANDLE,
            session,
            WTSConnectState,
            &mut buffer,
            &mut bytes,
        );
        let state = if result.is_ok()
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
        allows_input(session, state)
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
}
