//! Session-local physical input, sampled only when cowork needs a lease decision.
use windows::Win32::System::SystemInformation::GetTickCount;
use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};

pub fn idle_ms() -> Option<u32> {
    let mut input = LASTINPUTINFO {
        cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
        dwTime: 0,
    };
    unsafe {
        if !GetLastInputInfo(&mut input).as_bool() {
            return None;
        }
        // Both values are 32-bit uptime ticks; subtraction must survive their wraparound.
        Some(GetTickCount().wrapping_sub(input.dwTime))
    }
}
