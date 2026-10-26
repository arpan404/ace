//! `window` steps and `activate`. Window steps act on the chosen window without activating it
//! where Windows allows (minimize, restore, raise, move and resize do; maximizing brings the
//! window forward). `activate` is the explicit step that takes the person's focus.
use super::act::{int, text, Actor, Step};
use super::apps;
use super::capture;
use super::desktop;
use super::error::{CuError, CuResult};
use super::geometry::{outer_for_frame, physical};
use super::outline::Rect;
use std::time::{Duration, Instant};
use windows::Win32::{
    Foundation::*,
    System::Threading::{AttachThreadInput, GetCurrentThreadId},
    UI::{HiDpi::GetDpiForWindow, Input::KeyboardAndMouse::SetFocus, WindowsAndMessaging::*},
};

impl Actor<'_> {
    pub fn window_op(&mut self, step: &Step) -> CuResult<String> {
        let hwnd = self.session.hwnd()?;
        let op = text(step, "op").unwrap_or_default();
        let name = self.session.name.clone();
        let failed = |e: windows::core::Error| {
            CuError::new(
                "action_failed",
                format!("Windows refused the window {op}: {e}"),
            )
        };
        unsafe {
            match op {
                "close" => {
                    PostMessageW(hwnd, WM_CLOSE, WPARAM(0), LPARAM(0)).map_err(failed)?;
                    Ok(format!("asked {name}'s window to close"))
                }
                "minimize" => {
                    let _ = ShowWindowAsync(hwnd, SW_SHOWMINNOACTIVE);
                    Ok(format!("minimized {name}'s window"))
                }
                "restore" => {
                    if IsZoomed(hwnd).as_bool() {
                        PostMessageW(hwnd, WM_SYSCOMMAND, WPARAM(SC_RESTORE as usize), LPARAM(0)).map_err(failed)?;
                    } else {
                        let _ = ShowWindowAsync(hwnd, SW_SHOWNOACTIVATE);
                    }
                    Ok(format!("restored {name}'s window"))
                }
                "zoom" => {
                    PostMessageW(hwnd, WM_SYSCOMMAND, WPARAM(SC_MAXIMIZE as usize), LPARAM(0)).map_err(failed)?;
                    Ok(format!("maximized {name}'s window"))
                }
                "fullscreen" => Err(CuError::new(
                    "not_supported",
                    "Windows has no general full screen for app windows. Use zoom to maximize, or the app's own full-screen command (often in its View menu).",
                )),
                "raise" => {
                    SetWindowPos(hwnd, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE).map_err(failed)?;
                    Ok(format!("raised {name}'s window without activating it"))
                }
                "move" | "resize" => {
                    if IsIconic(hwnd).as_bool() || IsZoomed(hwnd).as_bool() {
                        return Err(CuError::new(
                            "action_failed",
                            "The window is minimized or maximized; restore it first.",
                        ));
                    }
                    let visible = capture::frame(hwnd).ok_or_else(|| CuError::new("no_window", "The window has no size."))?;
                    let outer = capture::outer(hwnd).unwrap_or(visible);
                    // Points from the main display's top-left, at that display's scale.
                    let main_dpi = {
                        let primary = windows::Win32::Graphics::Gdi::MonitorFromPoint(POINT { x: 0, y: 0 }, windows::Win32::Graphics::Gdi::MONITOR_DEFAULTTOPRIMARY);
                        let (mut x, mut y) = (96u32, 96u32);
                        let _ = windows::Win32::UI::HiDpi::GetDpiForMonitor(
                            primary,
                            windows::Win32::UI::HiDpi::MDT_EFFECTIVE_DPI,
                            &mut x,
                            &mut y,
                        );
                        x
                    };
                    let dpi = GetDpiForWindow(hwnd);
                    let frame = if op == "move" {
                        Rect {
                            x: physical(int(step, "x").unwrap_or(0) as f64, main_dpi),
                            y: physical(int(step, "y").unwrap_or(0) as f64, main_dpi),
                            ..visible
                        }
                    } else {
                        Rect {
                            w: physical(int(step, "width").unwrap_or(1) as f64, dpi),
                            h: physical(int(step, "height").unwrap_or(1) as f64, dpi),
                            ..visible
                        }
                    };
                    let target = outer_for_frame(frame, outer, visible);
                    SetWindowPos(
                        hwnd,
                        None,
                        target.x.round() as i32,
                        target.y.round() as i32,
                        target.w.round() as i32,
                        target.h.round() as i32,
                        SWP_NOZORDER | SWP_NOACTIVATE,
                    )
                    .map_err(failed)?;
                    Ok(if op == "move" {
                        format!("moved {name}'s window to {},{}", int(step, "x").unwrap_or(0), int(step, "y").unwrap_or(0))
                    } else {
                        format!("resized {name}'s window to {}×{}", int(step, "width").unwrap_or(0), int(step, "height").unwrap_or(0))
                    })
                }
                other => Err(CuError::new("bad_action", format!("Unknown window op \"{other}\"."))),
            }
        }
    }

    /// Brings the app's window to the front and gives it the keyboard. Windows lets only the
    /// foreground thread do this, so the helper briefly joins that thread's input.
    pub fn activate(&mut self) -> CuResult<String> {
        let hwnd = self.session.hwnd()?;
        if !desktop::input_on_default_desktop() {
            return Err(desktop::locked_error());
        }
        let name = self.session.name.clone();
        unsafe {
            if IsIconic(hwnd).as_bool() {
                let _ = ShowWindow(hwnd, SW_RESTORE);
            }
            if !SetForegroundWindow(hwnd).as_bool() || !apps::is_foreground(hwnd) {
                let front = GetForegroundWindow();
                let theirs = GetWindowThreadProcessId(front, None);
                let ours = GetCurrentThreadId();
                let joined = theirs != 0
                    && theirs != ours
                    && AttachThreadInput(ours, theirs, true).as_bool();
                let _ = BringWindowToTop(hwnd);
                let _ = SetForegroundWindow(hwnd);
                let _ = SetFocus(hwnd);
                if joined {
                    let _ = AttachThreadInput(ours, theirs, false);
                }
            }
        }
        let started = Instant::now();
        while started.elapsed() < Duration::from_millis(1_000) {
            if apps::is_foreground(hwnd) {
                self.activity.pause(Duration::from_millis(60), self.check)?;
                return Ok(format!("brought {name} to the front"));
            }
            self.activity.pause(Duration::from_millis(25), self.check)?;
        }
        Err(CuError::new(
            "activate_failed",
            format!("Windows did not let ace bring {name} to the front (another app may hold the foreground). Use controls by id, which work in the background, or ask the person to click {name}."),
        ))
    }
}
