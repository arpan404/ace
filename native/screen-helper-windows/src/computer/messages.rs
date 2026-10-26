//! Messages to other apps' windows. Every send has a timeout and gives up on a hung app, so a
//! stuck window costs at most two seconds and never stalls the helper (or its cancel).
use windows::Win32::{Foundation::*, UI::WindowsAndMessaging::*};

/// Sends a message and waits up to two seconds for the answer; None when the app did not answer.
pub fn send(hwnd: HWND, message: u32, wparam: usize, lparam: isize) -> Option<isize> {
    send_within(hwnd, message, wparam, lparam, 2_000)
}

pub fn send_within(
    hwnd: HWND,
    message: u32,
    wparam: usize,
    lparam: isize,
    ms: u32,
) -> Option<isize> {
    let mut result = 0usize;
    let answered = unsafe {
        SendMessageTimeoutW(
            hwnd,
            message,
            WPARAM(wparam),
            LPARAM(lparam),
            SMTO_ABORTIFHUNG | SMTO_BLOCK,
            ms,
            Some(&mut result),
        )
    };
    (answered.0 != 0).then_some(result as isize)
}

/// Waits until the app has handled everything sent or posted to it so far (it answers a
/// WM_NULL only after them), up to `ms`. False when it is still busy.
pub fn drained(hwnd: HWND, ms: u32) -> bool {
    send_within(hwnd, WM_NULL, 0, 0, ms).is_some()
}
