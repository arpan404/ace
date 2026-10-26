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
            Err(_) => return false,
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
static WATCH_THREAD: AtomicU32 = AtomicU32::new(0);

fn stamp() {
    let epoch = *EPOCH.get_or_init(Instant::now);
    LAST_PERSON_INPUT.store(epoch.elapsed().as_millis() as u64 + 1, Ordering::Relaxed);
}

unsafe extern "system" fn keyboard(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let info = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
        if info.flags.0 & LLKHF_INJECTED.0 == 0 {
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
        if info.flags & LLMHF_INJECTED == 0 {
            stamp();
        }
    }
    CallNextHookEx(None, code, wparam, lparam)
}

/// Watches the person's real keyboard and mouse (injected input is told apart by the system)
/// for as long as it lives: one batch. Low-level hooks see input to every app, so the watch
/// runs only while the agent acts.
pub struct PersonWatch {
    thread: Option<std::thread::JoinHandle<()>>,
    escapes: u32,
}

impl PersonWatch {
    pub fn start() -> Self {
        let escapes = ESCAPES.load(Ordering::Relaxed);
        let (ready, started) = std::sync::mpsc::channel();
        let thread = std::thread::spawn(move || unsafe {
            // Make sure the thread has a message queue before anyone posts WM_QUIT to it.
            let mut message = MSG::default();
            let _ = PeekMessageW(&mut message, None, 0, 0, PM_NOREMOVE);
            WATCH_THREAD.store(GetCurrentThreadId(), Ordering::Relaxed);
            let instance = GetModuleHandleW(None)
                .map(|m| HINSTANCE(m.0))
                .unwrap_or_default();
            let hooks = [
                SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard), instance, 0).ok(),
                SetWindowsHookExW(WH_MOUSE_LL, Some(mouse), instance, 0).ok(),
            ];
            let _ = ready.send(());
            while GetMessageW(&mut message, None, 0, 0).as_bool() {
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
            for hook in hooks.into_iter().flatten() {
                let _ = UnhookWindowsHookEx(hook);
            }
        });
        let _ = started.recv_timeout(Duration::from_secs(2));
        Self {
            thread: Some(thread),
            escapes,
        }
    }

    /// The person pressed Escape since the watch started.
    pub fn escaped(&self) -> bool {
        ESCAPES.load(Ordering::Relaxed) != self.escapes
    }
}

impl Drop for PersonWatch {
    fn drop(&mut self) {
        let thread = WATCH_THREAD.swap(0, Ordering::Relaxed);
        if thread != 0 {
            unsafe {
                let _ = PostThreadMessageW(thread, WM_QUIT, WPARAM(0), LPARAM(0));
            }
        }
        if let Some(handle) = self.thread.take() {
            let _ = handle.join();
        }
    }
}

/// How long ago the person last used the keyboard or mouse, as far as the helper can tell:
/// the hooks while a batch runs, and the system's last-input time otherwise (minus the
/// helper's own injections).
pub fn since_person_input(injected_tick: Option<u32>) -> Option<Duration> {
    let hooked = LAST_PERSON_INPUT.load(Ordering::Relaxed);
    let from_hooks = (hooked > 0).then(|| {
        let epoch = *EPOCH.get_or_init(Instant::now);
        epoch
            .elapsed()
            .saturating_sub(Duration::from_millis(hooked - 1))
    });
    let mut info = LASTINPUTINFO {
        cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
        dwTime: 0,
    };
    let from_system = unsafe { GetLastInputInfo(&mut info) }
        .as_bool()
        .then(|| {
            let now = unsafe { windows::Win32::System::SystemInformation::GetTickCount() };
            (!super::timing::own_input(info.dwTime, injected_tick))
                .then(|| Duration::from_millis(u64::from(now.wrapping_sub(info.dwTime))))
        })
        .flatten();
    match (from_hooks, from_system) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (a, b) => a.or(b),
    }
}
