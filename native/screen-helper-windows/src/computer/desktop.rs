//! The desktop around the engine: whether input can reach the normal desktop (not the sign-in,
//! lock or UAC secure desktop), whether an app runs above ace's integrity level, and watching
//! the person's own keyboard and mouse while a batch runs.
use super::error::CuError;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use windows::Win32::{
    Foundation::*,
    Security::*,
    System::{LibraryLoader::GetModuleHandleW, StationsAndDesktops::*, Threading::*},
    UI::{Input::KeyboardAndMouse::*, WindowsAndMessaging::*},
};

/// True when the input desktop is the normal one. The lock screen, sign-in and UAC prompts
/// run on other desktops, where ace never sends input.
pub fn input_on_default_desktop() -> bool {
    unsafe {
        let Ok(desktop) = OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_READOBJECTS)
        else {
            return false;
        };
        let mut name = [0u16; 128];
        let read = GetUserObjectInformationW(
            HANDLE(desktop.0),
            UOI_NAME,
            Some(name.as_mut_ptr().cast()),
            (name.len() * 2) as u32,
            None,
        );
        let _ = CloseDesktop(desktop);
        if read.is_err() {
            return false;
        }
        let end = name.iter().position(|c| *c == 0).unwrap_or(name.len());
        String::from_utf16_lossy(&name[..end]).eq_ignore_ascii_case("default")
    }
}

pub fn locked_error() -> CuError {
    CuError::new(
        "screen_locked",
        "Windows is locked or showing a secure screen (sign-in or an administrator prompt), so ace sends no input. Controls by id may still work; otherwise wait until the person unlocks, then look again.",
    )
}

fn integrity_of(process: HANDLE) -> Option<u32> {
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(process, TOKEN_QUERY, &mut token).ok()?;
        let mut size = 0u32;
        let _ = GetTokenInformation(token, TokenIntegrityLevel, None, 0, &mut size);
        let mut buffer = vec![0u8; size.max(64) as usize];
        let read = GetTokenInformation(
            token,
            TokenIntegrityLevel,
            Some(buffer.as_mut_ptr().cast()),
            buffer.len() as u32,
            &mut size,
        );
        let _ = CloseHandle(token);
        read.ok()?;
        let label = &*(buffer.as_ptr() as *const TOKEN_MANDATORY_LABEL);
        let sid = label.Label.Sid;
        let count = *GetSidSubAuthorityCount(sid);
        if count == 0 {
            return None;
        }
        Some(*GetSidSubAuthority(sid, u32::from(count) - 1))
    }
}

/// Whether the process runs above ace's own integrity level (as administrator while ace does
/// not). Windows then blocks ace's input and most of UI Automation (UIPI). A process whose
/// token ace may not even read counts as above.
pub fn elevated_above_us(pid: u32) -> bool {
    static OURS: OnceLock<Option<u32>> = OnceLock::new();
    let ours = *OURS.get_or_init(|| integrity_of(unsafe { GetCurrentProcess() }));
    let Some(ours) = ours else { return false };
    let theirs = unsafe {
        match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
            Ok(process) => {
                let level = integrity_of(process);
                let _ = CloseHandle(process);
                level
            }
            // Not even its basic facts are readable: treat it as out of reach.
            Err(_) => return true,
        }
    };
    theirs.is_none_or(|level| level > ours)
}

pub fn elevated_error(app: &str) -> CuError {
    CuError::new(
        "app_elevated",
        format!("{app} runs as administrator, and Windows blocks ace (which does not) from reading or controlling it. Ask the person to do this step, or to run {app} without administrator rights."),
    )
}

static EPOCH: OnceLock<Instant> = OnceLock::new();
/// Milliseconds after EPOCH (plus one, so zero means never) of the person's last input.
static LAST_PERSON_INPUT: AtomicU64 = AtomicU64::new(0);
static ESCAPES: AtomicU32 = AtomicU32::new(0);
static WATCHING: OnceLock<()> = OnceLock::new();
/// Tests only: count input other programs synthesize as the person's, so a test can stand in
/// for the person. Never set by the daemon; it only makes the engine more cautious.
static COUNT_INJECTED: OnceLock<bool> = OnceLock::new();

/// Tags the helper's own synthesized input (`dwExtraInfo`), so the watch never takes it for
/// the person's.
pub const OWN_INPUT: usize = 0x00ac_e0c0;

fn stamp() {
    let epoch = *EPOCH.get_or_init(Instant::now);
    LAST_PERSON_INPUT.store(epoch.elapsed().as_millis() as u64 + 1, Ordering::Relaxed);
}

/// Whether an event comes from the person: real input, or (in tests) anyone else's injection.
fn persons(injected: bool, extra: usize) -> bool {
    !injected || (extra != OWN_INPUT && *COUNT_INJECTED.get().unwrap_or(&false))
}

unsafe extern "system" fn keyboard(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let info = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
        if persons(info.flags.0 & LLKHF_INJECTED.0 != 0, info.dwExtraInfo) {
            stamp();
            if info.vkCode == u32::from(VK_ESCAPE.0)
                && (wparam.0 as u32 == WM_KEYDOWN || wparam.0 as u32 == WM_SYSKEYDOWN)
            {
                ESCAPES.fetch_add(1, Ordering::Relaxed);
            }
        }
    }
    CallNextHookEx(None, code, wparam, lparam)
}

unsafe extern "system" fn mouse(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let info = &*(lparam.0 as *const MSLLHOOKSTRUCT);
        if persons(info.flags & LLMHF_INJECTED != 0, info.dwExtraInfo) {
            stamp();
        }
    }
    CallNextHookEx(None, code, wparam, lparam)
}

/// Starts watching the person's keyboard and mouse for the rest of the helper's life, so input
/// just before a batch counts too. Low-level hooks see input to every app; the hook thread
/// only records times. It never stops early, so nothing waits on it.
pub fn watch_person() {
    WATCHING.get_or_init(|| {
        COUNT_INJECTED.get_or_init(|| {
            std::env::var("ACE_COMPUTER_COUNT_INJECTED_INPUT").is_ok_and(|v| v == "1")
        });
        let (ready, started) = std::sync::mpsc::channel();
        std::thread::spawn(move || unsafe {
            let instance = GetModuleHandleW(None)
                .map(|m| HINSTANCE(m.0))
                .unwrap_or_default();
            let hooks = [
                SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard), instance, 0).ok(),
                SetWindowsHookExW(WH_MOUSE_LL, Some(mouse), instance, 0).ok(),
            ];
            let _ = ready.send(());
            let mut message = MSG::default();
            while GetMessageW(&mut message, None, 0, 0).as_bool() {
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
            for hook in hooks.into_iter().flatten() {
                let _ = UnhookWindowsHookEx(hook);
            }
        });
        let _ = started.recv_timeout(Duration::from_secs(2));
    });
}

/// How many times the person has pressed Escape; a batch stops when this moves.
pub fn escapes() -> u32 {
    ESCAPES.load(Ordering::Relaxed)
}

/// How long ago the person last used the keyboard or mouse, as the hooks saw it. Only real
/// input counts: the system's last-input time also includes input other programs (and UI
/// Automation proxies) synthesize, so it is not used.
pub fn since_person_input() -> Option<Duration> {
    let hooked = LAST_PERSON_INPUT.load(Ordering::Relaxed);
    (hooked > 0).then(|| {
        let epoch = *EPOCH.get_or_init(Instant::now);
        epoch
            .elapsed()
            .saturating_sub(Duration::from_millis(hooked - 1))
    })
}

/// Whether the person used the keyboard or mouse in the last `window`.
pub fn person_input_within(window: Duration) -> bool {
    since_person_input().is_some_and(|age| age < window)
}
