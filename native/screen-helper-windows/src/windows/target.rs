use crate::{
    coordinates::{Bounds, Mapping},
    errors::{Code, Error, Result},
};
use serde::Deserialize;
use serde_json::{json, Value};
use windows::{
    core::PWSTR,
    Win32::{
        Foundation::*,
        Graphics::{Dwm::*, Gdi::*},
        System::{StationsAndDesktops::*, Threading::*},
        UI::{HiDpi::*, WindowsAndMessaging::*},
    },
};
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub kind: String,
    pub window_id: Option<u64>,
    pub display_id: Option<u64>,
    pub bundle_id: Option<String>,
    pub bundle_ids: Option<Vec<String>>,
}
impl Target {
    pub fn window(&self) -> Result<HWND> {
        if self.kind != "window" {
            return Err(Error::new(Code::NotSupported, "Window target required"));
        }
        let id = self
            .window_id
            .filter(|v| *v > 0 && *v <= 9_007_199_254_740_991)
            .ok_or_else(|| Error::new(Code::Bounds, "Invalid window id"))?;
        let hwnd = HWND(id as usize as *mut _);
        if !unsafe { IsWindow(hwnd) }.as_bool() {
            return Err(Error::new(Code::TargetGone, "Window closed"));
        }
        Ok(hwnd)
    }
    pub fn monitor(&self) -> Result<HMONITOR> {
        let id = self
            .display_id
            .ok_or_else(|| Error::new(Code::Bounds, "Missing display"))?;
        let monitor = HMONITOR(id as usize as *mut _);
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if !unsafe { GetMonitorInfoW(monitor, &mut info) }.as_bool() {
            return Err(Error::new(Code::TargetGone, "Display removed"));
        }
        Ok(monitor)
    }
    pub fn validate(&self, allowlist: &[String]) -> Result<()> {
        desktop_available()?;
        if self.kind == "window" {
            let hwnd = self.window()?;
            let identity = identity(hwnd)?;
            if self.bundle_id.as_ref() != Some(&identity) || !allowlist.contains(&identity) {
                return Err(Error::new(
                    Code::PermissionDenied,
                    "Executable approval required",
                ));
            }
        } else if self.kind == "display" {
            self.monitor()?;
            let identity = format!("monitor:{}", self.display_id.unwrap_or(0));
            if !allowlist.contains(&identity)
                || self.bundle_ids.as_ref().is_none_or(|v| v != &[identity])
            {
                return Err(Error::new(
                    Code::PermissionDenied,
                    "Whole-monitor approval required",
                ));
            }
        } else {
            return Err(Error::new(
                Code::NotSupported,
                "Windows supports window or monitor targets",
            ));
        }
        Ok(())
    }
    pub fn mapping(&self) -> Result<Mapping> {
        let hwnd = self.window()?;
        let target = bounds(hwnd)?;
        let desktop = unsafe {
            Bounds {
                x: GetSystemMetrics(SM_XVIRTUALSCREEN) as f64,
                y: GetSystemMetrics(SM_YVIRTUALSCREEN) as f64,
                w: GetSystemMetrics(SM_CXVIRTUALSCREEN) as f64,
                h: GetSystemMetrics(SM_CYVIRTUALSCREEN) as f64,
            }
        };
        Ok(Mapping {
            target,
            desktop,
            dpi: unsafe { GetDpiForWindow(hwnd) },
        })
    }
    pub fn foreground(&self) -> Result<()> {
        desktop_available()?;
        let hwnd = self.window()?;
        if unsafe { GetForegroundWindow() } != hwnd {
            return Err(Error::new(
                Code::Busy,
                "Target must be foreground for input",
            ));
        }
        Ok(())
    }
}
pub fn bounds(hwnd: HWND) -> Result<Bounds> {
    let mut rect = RECT::default();
    unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            (&mut rect as *mut RECT).cast(),
            std::mem::size_of::<RECT>() as u32,
        )?;
    }
    Ok(rect_bounds(rect))
}
fn rect_bounds(rect: RECT) -> Bounds {
    Bounds {
        x: rect.left as f64,
        y: rect.top as f64,
        w: (rect.right - rect.left) as f64,
        h: (rect.bottom - rect.top) as f64,
    }
}
pub fn identity(hwnd: HWND) -> Result<String> {
    unsafe {
        let mut pid = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)?;
        let mut buffer = vec![0u16; 32768];
        let mut length = buffer.len() as u32;
        let result = QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            PWSTR(buffer.as_mut_ptr()),
            &mut length,
        );
        let _ = CloseHandle(process);
        result?;
        Ok(String::from_utf16_lossy(&buffer[..length as usize]).to_lowercase())
    }
}
pub fn desktop_available() -> Result<()> {
    unsafe {
        let desktop = OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_READOBJECTS)
            .map_err(|_| Error::new(Code::Busy, "Secure or unavailable input desktop"))?;
        let mut name = [0u16; 128];
        let result = GetUserObjectInformationW(
            HANDLE(desktop.0),
            UOI_NAME,
            Some(name.as_mut_ptr().cast()),
            (name.len() * 2) as u32,
            None,
        );
        let _ = CloseDesktop(desktop);
        result?;
        let end = name.iter().position(|c| *c == 0).unwrap_or(name.len());
        if !String::from_utf16_lossy(&name[..end]).eq_ignore_ascii_case("default") {
            return Err(Error::new(Code::Busy, "Secure desktop or UAC active"));
        }
        Ok(())
    }
}
pub fn inventory() -> Result<Value> {
    desktop_available()?;
    let mut windows = Vec::<Value>::new();
    let mut displays = Vec::<Value>::new();
    unsafe {
        EnumWindows(
            Some(enum_window),
            LPARAM((&mut windows as *mut Vec<Value>) as isize),
        )?;
        if !EnumDisplayMonitors(
            None,
            None,
            Some(enum_monitor),
            LPARAM((&mut displays as *mut Vec<Value>) as isize),
        )
        .as_bool()
        {
            return Err(windows::core::Error::from_win32().into());
        }
    }
    Ok(json!({"windows":windows,"displays":displays}))
}
unsafe extern "system" fn enum_window(hwnd: HWND, data: LPARAM) -> BOOL {
    let windows = &mut *(data.0 as *mut Vec<Value>);
    if windows.len() >= 2048 {
        return false.into();
    }
    if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
        return true.into();
    }
    if let (Ok(identity), Ok(b)) = (identity(hwnd), bounds(hwnd)) {
        if b.w <= 0.0 || b.h <= 0.0 {
            return true.into();
        }
        let mut title = [0u16; 1025];
        let len = GetWindowTextW(hwnd, &mut title).max(0) as usize;
        windows.push(json!({"windowId":hwnd.0 as usize,"bundleId":identity,"title":String::from_utf16_lossy(&title[..len]),
            "bounds":{"x":b.x,"y":b.y,"width":b.w,"height":b.h}}));
    }
    true.into()
}
unsafe extern "system" fn enum_monitor(
    monitor: HMONITOR,
    _: HDC,
    rect: *mut RECT,
    data: LPARAM,
) -> BOOL {
    let displays = &mut *(data.0 as *mut Vec<Value>);
    if displays.len() < 64 {
        let b = rect_bounds(*rect);
        displays.push(
            json!({"displayId":monitor.0 as usize,"width":b.w,"height":b.h,
            "bounds":{"x":b.x,"y":b.y,"width":b.w,"height":b.h}}),
        );
    }
    true.into()
}
