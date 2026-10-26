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
    use windows::core::{w, PCWSTR};
    use windows::Win32::{
        Foundation::*,
        Graphics::Gdi::*,
        System::LibraryLoader::GetModuleHandleW,
        UI::{
            HiDpi::{SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2},
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
    const FRONT: u32 = WM_APP + 1;
    const VALUES: u32 = WM_APP + 2;

    static PRESSES: AtomicU32 = AtomicU32::new(0);
    static MAIN: AtomicIsize = AtomicIsize::new(0);

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
                    let message = match line.trim() {
                        "front" => FRONT,
                        "values" => VALUES,
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
