//! An owned Win32 window for real-Windows computer-use tests: a menu bar with shortcuts, a
//! button, single- and multi-line edits, a check box, a combo box and a list box, all plain
//! Win32 controls that UI Automation reaches through its standard proxies. It prints one JSON
//! line when ready and one per event, and answers `values` and `front` on stdin, so tests check
//! effects without trusting the engine's own reading.
//!
//! `computer_fixture [--title <title>] [--front]`
//!
//! It is a windowed (GUI-subsystem) program like the apps agents start; its JSON lines go to
//! the stdout its parent passes it.
#![cfg_attr(windows, windows_subsystem = "windows")]

#[cfg(windows)]
mod fixture {
    use std::io::{BufRead, Write};
    use std::sync::atomic::{AtomicIsize, AtomicU32, Ordering};
    use std::sync::Mutex;
    use windows::core::{w, PCWSTR};
    use windows::Win32::{
        Foundation::*,
        Graphics::Gdi::*,
        System::LibraryLoader::GetModuleHandleW,
        System::{DataExchange::*, Memory::*, Threading::*},
        UI::{
            HiDpi::{SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2},
            Input::KeyboardAndMouse::*,
            WindowsAndMessaging::*,
        },
    };

    const NAME: i32 = 203;
    const PRESS: i32 = 201;
    const PRESSED: i32 = 202;
    const NOTES: i32 = 204;
    const FEATURE: i32 = 205;
    const COLOR: i32 = 206;
    const ITEMS: i32 = 207;
    const STATUS: i32 = 208;
    const NEW: u32 = 101;
    const SAVE: u32 = 102;
    const CLEAR: u32 = 104;
    const GRAB: i32 = 209;
    const FRONT: u32 = WM_APP + 1;
    const VALUES: u32 = WM_APP + 2;
    const RENAME: u32 = WM_APP + 3;
    const MODAL: u32 = WM_APP + 4;
    const CLOSE_MODAL: u32 = WM_APP + 5;
    const NUDGE: u32 = WM_APP + 6;
    const CLIP: u32 = WM_APP + 7;
    const PASTE_MODE: u32 = WM_APP + 8;
    const HANG: u32 = WM_APP + 9;
    const SECOND: u32 = WM_APP + 10;

    static PRESSES: AtomicU32 = AtomicU32::new(0);
    static MAIN: AtomicIsize = AtomicIsize::new(0);
    static MODAL_WINDOW: AtomicIsize = AtomicIsize::new(0);
    static SECOND_EDIT: AtomicIsize = AtomicIsize::new(0);
    static NOTES_PROC: AtomicIsize = AtomicIsize::new(0);
    /// How the notes field pastes: 0 as usual, 1 then copies text of its own, 2 slowly.
    static PASTE: AtomicU32 = AtomicU32::new(0);
    /// The argument of the last stdin command that takes one.
    static ARGUMENT: Mutex<String> = Mutex::new(String::new());

    fn argument() -> String {
        ARGUMENT.lock().map(|a| a.clone()).unwrap_or_default()
    }

    unsafe fn set_clipboard(owner: HWND, text: &str) {
        if OpenClipboard(owner).is_err() {
            return;
        }
        let _ = EmptyClipboard();
        let units: Vec<u16> = text.encode_utf16().chain(Some(0)).collect();
        if let Ok(memory) = GlobalAlloc(GMEM_MOVEABLE, units.len() * 2) {
            let target = GlobalLock(memory);
            if !target.is_null() {
                std::ptr::copy_nonoverlapping(units.as_ptr(), target.cast(), units.len());
                let _ = GlobalUnlock(memory);
                let _ = SetClipboardData(13, HANDLE(memory.0));
            }
        }
        let _ = CloseClipboard();
    }

    unsafe fn clipboard_text(owner: HWND) -> String {
        if OpenClipboard(owner).is_err() {
            return String::new();
        }
        let mut text = String::new();
        if let Ok(handle) = GetClipboardData(13) {
            let memory = HGLOBAL(handle.0);
            let source = GlobalLock(memory) as *const u16;
            if !source.is_null() {
                let mut length = 0;
                while *source.add(length) != 0 && length < 4096 {
                    length += 1;
                }
                text = String::from_utf16_lossy(std::slice::from_raw_parts(source, length));
                let _ = GlobalUnlock(memory);
            }
        }
        let _ = CloseClipboard();
        text
    }

    /// The notes field's paste, slowed down or followed by a copy of the fixture's own.
    unsafe extern "system" fn notes(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        let previous: WNDPROC = std::mem::transmute(NOTES_PROC.load(Ordering::Relaxed));
        if message == WM_PASTE && PASTE.load(Ordering::Relaxed) == 2 {
            std::thread::sleep(std::time::Duration::from_millis(3_000));
        }
        let result = CallWindowProcW(previous, hwnd, message, wparam, lparam);
        if message == WM_PASTE && PASTE.load(Ordering::Relaxed) == 1 {
            set_clipboard(hwnd, "fixture copy");
        }
        result
    }

    /// Takes the foreground the way some apps do on their own.
    unsafe fn grab(hwnd: HWND) {
        let front = GetForegroundWindow();
        let theirs = GetWindowThreadProcessId(front, None);
        let ours = GetCurrentThreadId();
        let joined =
            theirs != 0 && theirs != ours && AttachThreadInput(ours, theirs, true).as_bool();
        let _ = BringWindowToTop(hwnd);
        let _ = SetForegroundWindow(hwnd);
        if joined {
            let _ = AttachThreadInput(ours, theirs, false);
        }
        say(serde_json::json!({"event": "grabbed", "front": GetForegroundWindow() == hwnd}));
    }

    fn say(line: serde_json::Value) {
        let mut out = std::io::stdout().lock();
        let _ = writeln!(out, "{line}");
        let _ = out.flush();
    }

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(Some(0)).collect()
    }

    unsafe fn child(
        parent: HWND,
        class: PCWSTR,
        text: &str,
        style: u32,
        id: i32,
        rect: (i32, i32, i32, i32),
    ) -> HWND {
        let text = wide(text);
        CreateWindowExW(
            WINDOW_EX_STYLE(0),
            class,
            PCWSTR(text.as_ptr()),
            WINDOW_STYLE(style) | WS_CHILD | WS_VISIBLE,
            rect.0,
            rect.1,
            rect.2,
            rect.3,
            parent,
            HMENU(id as isize as *mut _),
            GetModuleHandleW(None)
                .map(|m| HINSTANCE(m.0))
                .unwrap_or_default(),
            None,
        )
        .unwrap_or_default()
    }

    unsafe fn text_of(hwnd: HWND) -> String {
        let length = GetWindowTextLengthW(hwnd).max(0) as usize;
        let mut buffer = vec![0u16; length + 1];
        let read = GetWindowTextW(hwnd, &mut buffer).max(0) as usize;
        String::from_utf16_lossy(&buffer[..read])
    }

    unsafe fn item(parent: HWND, id: i32) -> HWND {
        GetDlgItem(parent, id).unwrap_or_default()
    }

    unsafe fn set_text(hwnd: HWND, text: &str) {
        let text = wide(text);
        let _ = SetWindowTextW(hwnd, PCWSTR(text.as_ptr()));
    }

    unsafe fn values(hwnd: HWND) -> serde_json::Value {
        let combo = item(hwnd, COLOR);
        let selected = SendMessageW(combo, CB_GETCURSEL, WPARAM(0), LPARAM(0)).0;
        let mut color = vec![0u16; 64];
        let length = if selected >= 0 {
            SendMessageW(
                combo,
                CB_GETLBTEXT,
                WPARAM(selected as usize),
                LPARAM(color.as_mut_ptr() as isize),
            )
            .0
        } else {
            0
        };
        serde_json::json!({
            "values": {
                "name": text_of(item(hwnd, NAME)),
                "notes": text_of(item(hwnd, NOTES)),
                "checked": SendMessageW(item(hwnd, FEATURE), BM_GETCHECK, WPARAM(0), LPARAM(0)).0 == 1,
                "color": String::from_utf16_lossy(&color[..length.max(0) as usize]),
                "item": SendMessageW(item(hwnd, ITEMS), LB_GETCURSEL, WPARAM(0), LPARAM(0)).0,
                "status": text_of(item(hwnd, STATUS)),
                "pressed": PRESSES.load(Ordering::Relaxed),
                "front": GetForegroundWindow() == hwnd,
                "clip": clipboard_text(hwnd),
                "second": text_of(HWND(SECOND_EDIT.load(Ordering::Relaxed) as *mut _)),
                "rows": (0..SendMessageW(item(hwnd, ITEMS), LB_GETCOUNT, WPARAM(0), LPARAM(0)).0).map(|i| {
                    let mut row = vec![0u16; 64];
                    let n = SendMessageW(item(hwnd, ITEMS), LB_GETTEXT, WPARAM(i as usize), LPARAM(row.as_mut_ptr() as isize)).0;
                    String::from_utf16_lossy(&row[..n.max(0) as usize])
                }).collect::<Vec<_>>(),
            }
        })
    }

    unsafe extern "system" fn window(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        match message {
            WM_COMMAND => {
                let id = (wparam.0 & 0xFFFF) as u32;
                let code = ((wparam.0 >> 16) & 0xFFFF) as u32;
                match id {
                    i if i == PRESS as u32 && code == BN_CLICKED => {
                        let count = PRESSES.fetch_add(1, Ordering::Relaxed) + 1;
                        set_text(item(hwnd, PRESSED), &format!("Pressed {count}"));
                        say(serde_json::json!({"event": "pressed", "count": count}));
                    }
                    i if i == FEATURE as u32 && code == BN_CLICKED => {
                        let on =
                            SendMessageW(item(hwnd, FEATURE), BM_GETCHECK, WPARAM(0), LPARAM(0)).0
                                == 1;
                        say(serde_json::json!({"event": "feature", "on": on}));
                    }
                    i if i == GRAB as u32 && code == BN_CLICKED => {
                        SetTimer(hwnd, 1, 300, None);
                    }
                    NEW => {
                        set_text(item(hwnd, STATUS), "New document");
                        say(serde_json::json!({"event": "command", "name": "new"}));
                    }
                    SAVE => {
                        set_text(item(hwnd, STATUS), "Saved");
                        say(serde_json::json!({"event": "command", "name": "save"}));
                    }
                    CLEAR => {
                        set_text(item(hwnd, NOTES), "");
                        say(serde_json::json!({"event": "command", "name": "clear"}));
                    }
                    _ => {}
                }
                LRESULT(0)
            }
            FRONT => {
                let _ = SetForegroundWindow(hwnd);
                say(serde_json::json!({"front": GetForegroundWindow() == hwnd}));
                LRESULT(0)
            }
            VALUES => {
                say(values(hwnd));
                LRESULT(0)
            }
            WM_TIMER => {
                let _ = KillTimer(hwnd, 1);
                grab(hwnd);
                LRESULT(0)
            }
            RENAME => {
                // The second row now shows other content, as a recycled virtual row would.
                let list = item(hwnd, ITEMS);
                SendMessageW(list, LB_DELETESTRING, WPARAM(1), LPARAM(0));
                let text = wide("Zwei");
                SendMessageW(
                    list,
                    LB_INSERTSTRING,
                    WPARAM(1),
                    LPARAM(text.as_ptr() as isize),
                );
                say(serde_json::json!({"event": "renamed"}));
                LRESULT(0)
            }
            MODAL => {
                let modal = CreateWindowExW(
                    WS_EX_DLGMODALFRAME,
                    w!("STATIC"),
                    w!("Ace Modal"),
                    WS_POPUP | WS_CAPTION | WS_SYSMENU,
                    200,
                    200,
                    300,
                    120,
                    hwnd,
                    None,
                    None,
                    None,
                )
                .unwrap_or_default();
                let _ = ShowWindow(modal, SW_SHOWNOACTIVATE);
                let _ = EnableWindow(hwnd, false);
                MODAL_WINDOW.store(modal.0 as isize, Ordering::Relaxed);
                say(serde_json::json!({"event": "modal"}));
                LRESULT(0)
            }
            CLOSE_MODAL => {
                let _ = EnableWindow(hwnd, true);
                let _ = DestroyWindow(HWND(MODAL_WINDOW.swap(0, Ordering::Relaxed) as *mut _));
                say(serde_json::json!({"event": "modal-closed"}));
                LRESULT(0)
            }
            NUDGE => {
                // Input another program synthesizes, standing in for the person in tests.
                let key = |up: bool| INPUT {
                    r#type: INPUT_KEYBOARD,
                    Anonymous: INPUT_0 {
                        ki: KEYBDINPUT {
                            wVk: VK_SHIFT,
                            dwFlags: if up {
                                KEYEVENTF_KEYUP
                            } else {
                                KEYBD_EVENT_FLAGS(0)
                            },
                            ..Default::default()
                        },
                    },
                };
                SendInput(
                    &[key(false), key(true)],
                    std::mem::size_of::<INPUT>() as i32,
                );
                say(serde_json::json!({"event": "nudged"}));
                LRESULT(0)
            }
            CLIP => {
                set_clipboard(hwnd, &argument());
                say(serde_json::json!({"event": "clip"}));
                LRESULT(0)
            }
            PASTE_MODE => {
                PASTE.store(
                    match argument().as_str() {
                        "copy" => 1,
                        "slow" => 2,
                        _ => 0,
                    },
                    Ordering::Relaxed,
                );
                say(serde_json::json!({"event": "paste-mode"}));
                LRESULT(0)
            }
            HANG => {
                say(serde_json::json!({"event": "hanging"}));
                let ms = argument().parse::<u64>().unwrap_or(6_000);
                std::thread::sleep(std::time::Duration::from_millis(ms));
                LRESULT(0)
            }
            SECOND => {
                let second = CreateWindowExW(
                    WINDOW_EX_STYLE(0),
                    w!("STATIC"),
                    w!("Ace Second"),
                    WS_OVERLAPPEDWINDOW,
                    760,
                    120,
                    360,
                    160,
                    None,
                    None,
                    None,
                    None,
                )
                .unwrap_or_default();
                let edit = child(second, w!("EDIT"), "", WS_BORDER.0, 400, (10, 10, 300, 24));
                let _ = ShowWindow(second, SW_SHOWNOACTIVATE);
                let _ = SetFocus(edit);
                SECOND_EDIT.store(edit.0 as isize, Ordering::Relaxed);
                say(serde_json::json!({"event": "second"}));
                LRESULT(0)
            }
            WM_DESTROY => {
                PostQuitMessage(0);
                LRESULT(0)
            }
            _ => DefWindowProcW(hwnd, message, wparam, lparam),
        }
    }

    unsafe fn menu() -> HMENU {
        let bar = CreateMenu().unwrap_or_default();
        let file = CreatePopupMenu().unwrap_or_default();
        let _ = AppendMenuW(file, MF_STRING, NEW as usize, w!("&New\tCtrl+N"));
        let _ = AppendMenuW(file, MF_STRING, SAVE as usize, w!("&Save\tCtrl+S"));
        let edit = CreatePopupMenu().unwrap_or_default();
        let _ = AppendMenuW(
            edit,
            MF_STRING,
            CLEAR as usize,
            w!("&Clear Notes\tCtrl+Shift+L"),
        );
        let _ = AppendMenuW(bar, MF_POPUP, file.0 as usize, w!("&File"));
        let _ = AppendMenuW(bar, MF_POPUP, edit.0 as usize, w!("&Edit"));
        bar
    }

    unsafe fn accelerators() -> HACCEL {
        let table = [
            ACCEL {
                fVirt: FCONTROL | FVIRTKEY,
                key: u16::from(b'N'),
                cmd: NEW as u16,
            },
            ACCEL {
                fVirt: FCONTROL | FVIRTKEY,
                key: u16::from(b'S'),
                cmd: SAVE as u16,
            },
            ACCEL {
                fVirt: FCONTROL | FSHIFT | FVIRTKEY,
                key: u16::from(b'L'),
                cmd: CLEAR as u16,
            },
        ];
        CreateAcceleratorTableW(&table).unwrap_or_default()
    }

    pub fn main() {
        let args: Vec<String> = std::env::args().collect();
        let title = args
            .iter()
            .position(|a| a == "--title")
            .and_then(|i| args.get(i + 1))
            .cloned()
            .unwrap_or_else(|| "Ace Computer Fixture".into());
        let front = args.iter().any(|a| a == "--front");
        unsafe {
            let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
            let instance = GetModuleHandleW(None)
                .map(|m| HINSTANCE(m.0))
                .unwrap_or_default();
            let class = WNDCLASSW {
                lpfnWndProc: Some(window),
                hInstance: instance,
                lpszClassName: w!("AceComputerFixture"),
                hbrBackground: HBRUSH((COLOR_WINDOW.0 + 1) as isize as *mut _),
                hCursor: LoadCursorW(None, IDC_ARROW).unwrap_or_default(),
                ..Default::default()
            };
            RegisterClassW(&class);
            let title = wide(&title);
            let hwnd = CreateWindowExW(
                WINDOW_EX_STYLE(0),
                w!("AceComputerFixture"),
                PCWSTR(title.as_ptr()),
                WS_OVERLAPPEDWINDOW,
                120,
                120,
                640,
                380,
                None,
                menu(),
                instance,
                None,
            )
            .unwrap_or_default();
            let edit_style = (WS_BORDER.0 | WS_TABSTOP.0) | ES_AUTOHSCROLL as u32;
            child(hwnd, w!("STATIC"), "Name:", 0, 300, (12, 14, 60, 20));
            child(hwnd, w!("EDIT"), "", edit_style, NAME, (80, 10, 220, 24));
            child(
                hwnd,
                w!("BUTTON"),
                "Press me",
                WS_TABSTOP.0 | BS_PUSHBUTTON as u32,
                PRESS,
                (310, 8, 110, 28),
            );
            child(
                hwnd,
                w!("STATIC"),
                "Pressed 0",
                0,
                PRESSED,
                (430, 14, 160, 20),
            );
            child(hwnd, w!("STATIC"), "Notes:", 0, 301, (12, 46, 60, 20));
            child(
                hwnd,
                w!("EDIT"),
                "alpha beta gamma beta",
                edit_style | WS_VSCROLL.0 | (ES_MULTILINE | ES_AUTOVSCROLL | ES_WANTRETURN) as u32,
                NOTES,
                (80, 44, 340, 80),
            );
            child(
                hwnd,
                w!("BUTTON"),
                "Enable feature",
                WS_TABSTOP.0 | BS_AUTOCHECKBOX as u32,
                FEATURE,
                (80, 132, 200, 24),
            );
            child(hwnd, w!("STATIC"), "Color:", 0, 302, (12, 168, 60, 20));
            let combo = child(
                hwnd,
                w!("COMBOBOX"),
                "",
                WS_TABSTOP.0 | CBS_DROPDOWNLIST as u32 | WS_VSCROLL.0,
                COLOR,
                (80, 164, 160, 200),
            );
            for color in ["Red", "Green", "Blue"] {
                let text = wide(color);
                SendMessageW(
                    combo,
                    CB_ADDSTRING,
                    WPARAM(0),
                    LPARAM(text.as_ptr() as isize),
                );
            }
            SendMessageW(combo, CB_SETCURSEL, WPARAM(0), LPARAM(0));
            let list = child(
                hwnd,
                w!("LISTBOX"),
                "",
                WS_TABSTOP.0 | WS_BORDER.0 | LBS_NOTIFY as u32,
                ITEMS,
                (260, 164, 160, 90),
            );
            for entry in ["One", "Two", "Three"] {
                let text = wide(entry);
                SendMessageW(
                    list,
                    LB_ADDSTRING,
                    WPARAM(0),
                    LPARAM(text.as_ptr() as isize),
                );
            }
            child(hwnd, w!("STATIC"), "Ready", 0, STATUS, (80, 270, 300, 20));
            child(
                hwnd,
                w!("BUTTON"),
                "Grab focus",
                WS_TABSTOP.0 | BS_PUSHBUTTON as u32,
                GRAB,
                (430, 132, 160, 28),
            );
            let notes_edit = item(hwnd, NOTES);
            NOTES_PROC.store(
                SetWindowLongPtrW(notes_edit, GWLP_WNDPROC, notes as *const () as isize),
                Ordering::Relaxed,
            );
            let _ = ShowWindow(
                hwnd,
                if front {
                    SW_SHOWNORMAL
                } else {
                    SW_SHOWNOACTIVATE
                },
            );
            if front {
                let _ = SetForegroundWindow(hwnd);
            }
            MAIN.store(hwnd.0 as isize, Ordering::Relaxed);
            say(serde_json::json!({
                "ready": true,
                "pid": std::process::id(),
                "hwnd": hwnd.0 as usize,
                "front": GetForegroundWindow() == hwnd,
            }));
            std::thread::spawn(|| {
                for line in std::io::stdin().lock().lines() {
                    let Ok(line) = line else { break };
                    let (command, rest) = line.trim().split_once(' ').unwrap_or((line.trim(), ""));
                    if let Ok(mut argument) = ARGUMENT.lock() {
                        *argument = rest.to_owned();
                    }
                    let message = match command {
                        "front" => FRONT,
                        "values" => VALUES,
                        "rename" => RENAME,
                        "modal" => MODAL,
                        "close-modal" => CLOSE_MODAL,
                        "nudge" => NUDGE,
                        "clip" => CLIP,
                        "paste-mode" => PASTE_MODE,
                        "hang" => HANG,
                        "second" => SECOND,
                        "quit" => WM_CLOSE,
                        _ => continue,
                    };
                    let hwnd = HWND(MAIN.load(Ordering::Relaxed) as *mut _);
                    let _ = PostMessageW(hwnd, message, WPARAM(0), LPARAM(0));
                }
            });
            let table = accelerators();
            let mut message = MSG::default();
            while GetMessageW(&mut message, None, 0, 0).as_bool() {
                if TranslateAcceleratorW(hwnd, table, &message) != 0 {
                    continue;
                }
                if IsDialogMessageW(hwnd, &message).as_bool() {
                    continue;
                }
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
    }
}

#[cfg(windows)]
fn main() {
    fixture::main();
}

#[cfg(not(windows))]
fn main() {
    eprintln!("The computer-use fixture is a Windows program.");
}
