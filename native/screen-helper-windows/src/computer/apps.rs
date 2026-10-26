//! Running apps, from the desktop's top-level windows. An app is identified by its packaged
//! AppUserModelID, or by its executable's file name (see `catalog`). Store apps drawn inside
//! ApplicationFrameHost belong to the process of the CoreWindow inside the frame.
use super::catalog::{executable_id, executable_name, is_system_component};
use std::collections::HashMap;
use windows::core::PWSTR;
use windows::Win32::{
    Foundation::*,
    Graphics::Dwm::*,
    Storage::{FileSystem::*, Packaging::Appx::GetApplicationUserModelId},
    System::Threading::*,
    UI::WindowsAndMessaging::*,
};

#[derive(Clone, Debug)]
pub struct Identity {
    pub id: String,
    pub path: Option<String>,
}

#[derive(Clone, Debug)]
pub struct TopWindow {
    pub hwnd: HWND,
    /// The process that draws the window's content (the app's own, also for frame-hosted apps).
    pub pid: u32,
    pub app: String,
    pub path: Option<String>,
    pub title: String,
    pub minimized: bool,
    /// On another virtual desktop.
    pub other_desktop: bool,
}

#[derive(Clone, Debug)]
pub struct RunningApp {
    pub id: String,
    pub path: Option<String>,
    pub pids: Vec<u32>,
    pub active: bool,
}

fn wide_to_string(buffer: &[u16]) -> String {
    let end = buffer.iter().position(|c| *c == 0).unwrap_or(buffer.len());
    String::from_utf16_lossy(&buffer[..end])
}

pub fn process_path(pid: u32) -> Option<String> {
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buffer = vec![0u16; 32_768];
        let mut length = buffer.len() as u32;
        let read = QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            PWSTR(buffer.as_mut_ptr()),
            &mut length,
        );
        let _ = CloseHandle(process);
        read.ok()?;
        Some(String::from_utf16_lossy(&buffer[..length as usize]))
    }
}

fn package_app_id(pid: u32) -> Option<String> {
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut length = 0u32;
        let _ = GetApplicationUserModelId(process, &mut length, PWSTR::null());
        let id = if length > 0 && length < 1024 {
            let mut buffer = vec![0u16; length as usize];
            let status =
                GetApplicationUserModelId(process, &mut length, PWSTR(buffer.as_mut_ptr()));
            (status == ERROR_SUCCESS).then(|| wide_to_string(&buffer))
        } else {
            None
        };
        let _ = CloseHandle(process);
        id.filter(|id| !id.is_empty())
    }
}

/// Process identities, read once per pid for the life of the cache.
#[derive(Default)]
pub struct Identities {
    known: HashMap<u32, Option<Identity>>,
}

impl Identities {
    pub fn of(&mut self, pid: u32) -> Option<Identity> {
        self.known
            .entry(pid)
            .or_insert_with(|| {
                let path = process_path(pid);
                let id = package_app_id(pid).or_else(|| path.as_deref().map(executable_id))?;
                Some(Identity { id, path })
            })
            .clone()
    }
}

fn class_of(hwnd: HWND) -> String {
    let mut buffer = [0u16; 256];
    let length = unsafe { GetClassNameW(hwnd, &mut buffer) }.max(0) as usize;
    String::from_utf16_lossy(&buffer[..length])
}

pub fn title_of(hwnd: HWND) -> String {
    let mut buffer = [0u16; 512];
    // InternalGetWindowText never sends a message, so a hung app can't stall it.
    let length = unsafe { InternalGetWindowText(hwnd, &mut buffer) }.max(0) as usize;
    String::from_utf16_lossy(&buffer[..length])
}

pub fn pid_of(hwnd: HWND) -> u32 {
    let mut pid = 0;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    pid
}

fn cloaked(hwnd: HWND) -> u32 {
    let mut value = 0u32;
    let _ = unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED,
            (&mut value as *mut u32).cast(),
            std::mem::size_of::<u32>() as u32,
        )
    };
    value
}

const DWM_CLOAKED_SHELL: u32 = 0x2;

unsafe extern "system" fn collect(hwnd: HWND, data: LPARAM) -> BOOL {
    let list = &mut *(data.0 as *mut Vec<HWND>);
    list.push(hwnd);
    BOOL::from(list.len() < 4096)
}

/// The content process of a frame-hosted (UWP) window: its CoreWindow child's process.
fn frame_content_pid(hwnd: HWND) -> Option<u32> {
    let mut children: Vec<HWND> = Vec::new();
    unsafe {
        let _ = EnumChildWindows(
            hwnd,
            Some(collect),
            LPARAM((&mut children as *mut Vec<HWND>) as isize),
        );
    }
    let host = pid_of(hwnd);
    children
        .into_iter()
        .filter(|child| class_of(*child) == "Windows.UI.Core.CoreWindow")
        .map(pid_of)
        .find(|pid| *pid != host)
}

/// The desktop's app windows, front to back.
pub fn top_windows(identities: &mut Identities) -> Vec<TopWindow> {
    let mut handles: Vec<HWND> = Vec::new();
    unsafe {
        let _ = EnumWindows(
            Some(collect),
            LPARAM((&mut handles as *mut Vec<HWND>) as isize),
        );
    }
    let own = std::process::id();
    let mut windows = Vec::new();
    for hwnd in handles {
        unsafe {
            if !IsWindowVisible(hwnd).as_bool() {
                continue;
            }
            let style = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
            if style & WS_EX_TOOLWINDOW.0 != 0 && style & WS_EX_APPWINDOW.0 == 0 {
                continue;
            }
        }
        let class = class_of(hwnd);
        if matches!(
            class.as_str(),
            "Shell_TrayWnd"
                | "Shell_SecondaryTrayWnd"
                | "Progman"
                | "WorkerW"
                | "Windows.UI.Core.CoreWindow"
        ) {
            continue;
        }
        let cloak = cloaked(hwnd);
        // Cloaked by the app or an owner (suspended Store apps) rather than by the shell
        // for another virtual desktop: not something the person sees.
        if cloak & !DWM_CLOAKED_SHELL != 0 {
            continue;
        }
        let minimized = unsafe { IsIconic(hwnd) }.as_bool();
        let title = title_of(hwnd);
        if title.trim().is_empty() && !minimized {
            continue;
        }
        let mut pid = pid_of(hwnd);
        if pid == own {
            continue;
        }
        if class == "ApplicationFrameWindow" {
            match frame_content_pid(hwnd) {
                Some(content) => pid = content,
                None => continue,
            }
        }
        let Some(identity) = identities.of(pid) else {
            continue;
        };
        if is_system_component(&identity.id) {
            continue;
        }
        windows.push(TopWindow {
            hwnd,
            pid,
            app: identity.id,
            path: identity.path,
            title,
            minimized,
            other_desktop: cloak & DWM_CLOAKED_SHELL != 0,
        });
    }
    windows
}

/// The window the person is using, as its top-level root.
pub fn foreground() -> HWND {
    unsafe { GetAncestor(GetForegroundWindow(), GA_ROOTOWNER) }
}

pub fn is_foreground(hwnd: HWND) -> bool {
    let front = unsafe { GetForegroundWindow() };
    !front.is_invalid()
        && (front == hwnd
            || unsafe { GetAncestor(front, GA_ROOTOWNER) }
                == unsafe { GetAncestor(hwnd, GA_ROOTOWNER) })
}

/// Running apps in window order, front-most first.
pub fn running(windows: &[TopWindow]) -> Vec<RunningApp> {
    let front = foreground();
    let mut apps: Vec<RunningApp> = Vec::new();
    for window in windows {
        let active = unsafe { GetAncestor(window.hwnd, GA_ROOTOWNER) } == front;
        match apps
            .iter_mut()
            .find(|a| a.id.eq_ignore_ascii_case(&window.app))
        {
            Some(app) => {
                app.active |= active;
                if !app.pids.contains(&window.pid) {
                    app.pids.push(window.pid);
                }
            }
            None => apps.push(RunningApp {
                id: window.app.clone(),
                path: window.path.clone(),
                pids: vec![window.pid],
                active,
            }),
        }
    }
    apps
}

/// An executable's own description ("Notepad"), from its version resource.
pub fn file_description(path: &str) -> Option<String> {
    let wide: Vec<u16> = path.encode_utf16().chain(Some(0)).collect();
    let file = windows::core::PCWSTR(wide.as_ptr());
    unsafe {
        let size = GetFileVersionInfoSizeW(file, None);
        if size == 0 || size > 4 * 1024 * 1024 {
            return None;
        }
        let mut data = vec![0u8; size as usize];
        GetFileVersionInfoW(file, 0, size, data.as_mut_ptr().cast()).ok()?;
        let mut pointer = std::ptr::null_mut();
        let mut length = 0u32;
        let translation: Vec<u16> = "\\VarFileInfo\\Translation"
            .encode_utf16()
            .chain(Some(0))
            .collect();
        if !VerQueryValueW(
            data.as_ptr().cast(),
            windows::core::PCWSTR(translation.as_ptr()),
            &mut pointer,
            &mut length,
        )
        .as_bool()
            || length < 4
        {
            return None;
        }
        let pair = std::slice::from_raw_parts(pointer as *const u16, 2);
        let key = format!(
            "\\StringFileInfo\\{:04x}{:04x}\\FileDescription",
            pair[0], pair[1]
        );
        let key: Vec<u16> = key.encode_utf16().chain(Some(0)).collect();
        if !VerQueryValueW(
            data.as_ptr().cast(),
            windows::core::PCWSTR(key.as_ptr()),
            &mut pointer,
            &mut length,
        )
        .as_bool()
            || length == 0
        {
            return None;
        }
        let text = std::slice::from_raw_parts(pointer as *const u16, length as usize);
        let description = wide_to_string(text).trim().to_owned();
        (!description.is_empty() && description.chars().count() <= 80).then_some(description)
    }
}

/// A readable name for a running app without a Start entry.
pub fn fallback_name(id: &str, path: Option<&str>) -> String {
    path.and_then(file_description)
        .unwrap_or_else(|| executable_name(id))
}
