//! One picture of one window, on request. PrintWindow with PW_RENDERFULLCONTENT asks the window
//! to draw itself (DirectComposition and GPU content included), so covered windows and windows
//! behind others still capture. Nothing is held between pictures: no capture session, no GPU
//! resources, no idle cost.
use super::image::looks_blank;
use super::outline::Rect;
use windows::Win32::{
    Foundation::*,
    Graphics::{Dwm::*, Gdi::*},
    Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS},
    UI::WindowsAndMessaging::*,
};

pub struct Picture {
    pub width: u32,
    pub height: u32,
    pub stride: usize,
    pub bgra: Vec<u8>,
}

const PW_RENDERFULLCONTENT: u32 = 2;
/// Larger windows are refused rather than allocated (4 bytes per pixel).
const MAX_PIXELS: i64 = 40_000_000;

/// The window's visible frame on the screen, without the invisible resize borders.
pub fn frame(hwnd: HWND) -> Option<Rect> {
    let mut rect = RECT::default();
    unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            (&mut rect as *mut RECT).cast(),
            std::mem::size_of::<RECT>() as u32,
        )
        .ok()
        .or_else(|| GetWindowRect(hwnd, &mut rect).ok())?;
    }
    let (w, h) = (rect.right - rect.left, rect.bottom - rect.top);
    (w > 0 && h > 0).then(|| Rect {
        x: f64::from(rect.left),
        y: f64::from(rect.top),
        w: f64::from(w),
        h: f64::from(h),
    })
}

/// The window rect SetWindowPos uses, invisible borders included.
pub fn outer(hwnd: HWND) -> Option<Rect> {
    let mut rect = RECT::default();
    unsafe { GetWindowRect(hwnd, &mut rect) }.ok()?;
    Some(Rect {
        x: f64::from(rect.left),
        y: f64::from(rect.top),
        w: f64::from(rect.right - rect.left),
        h: f64::from(rect.bottom - rect.top),
    })
}

struct Canvas {
    screen: HDC,
    memory: HDC,
    bitmap: HBITMAP,
    previous: HGDIOBJ,
    bits: *mut u8,
    width: i32,
    height: i32,
}

impl Canvas {
    fn new(width: i32, height: i32) -> Option<Self> {
        unsafe {
            let screen = GetDC(None);
            let memory = CreateCompatibleDC(screen);
            let info = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: width,
                    // Negative: top row first.
                    biHeight: -height,
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };
            let mut bits = std::ptr::null_mut();
            let Ok(bitmap) = CreateDIBSection(memory, &info, DIB_RGB_COLORS, &mut bits, None, 0)
            else {
                let _ = DeleteDC(memory);
                ReleaseDC(None, screen);
                return None;
            };
            let previous = SelectObject(memory, bitmap);
            Some(Self {
                screen,
                memory,
                bitmap,
                previous,
                bits: bits.cast(),
                width,
                height,
            })
        }
    }

    fn crop(&self, x: i32, y: i32, width: i32, height: i32) -> Picture {
        let stride = self.width as usize * 4;
        let (width, height) = (width.min(self.width - x), height.min(self.height - y));
        let mut bgra = Vec::with_capacity(width as usize * height as usize * 4);
        for row in 0..height {
            let source = unsafe {
                std::slice::from_raw_parts(
                    self.bits.add((row + y) as usize * stride + x as usize * 4),
                    width as usize * 4,
                )
            };
            bgra.extend_from_slice(source);
        }
        Picture {
            width: width as u32,
            height: height as u32,
            stride: width as usize * 4,
            bgra,
        }
    }
}

impl Drop for Canvas {
    fn drop(&mut self) {
        unsafe {
            SelectObject(self.memory, self.previous);
            let _ = DeleteObject(self.bitmap);
            let _ = DeleteDC(self.memory);
            ReleaseDC(None, self.screen);
        }
    }
}

/// Whether nothing covers the window's frame: sampled points all hit the window itself.
pub fn uncovered(hwnd: HWND, frame: Rect) -> bool {
    let root = |point: POINT| unsafe { GetAncestor(WindowFromPoint(point), GA_ROOT) };
    [(0.5, 0.5), (0.1, 0.1), (0.9, 0.1), (0.1, 0.9), (0.9, 0.9)]
        .iter()
        .all(|(fx, fy)| {
            root(POINT {
                x: (frame.x + frame.w * fx) as i32,
                y: (frame.y + frame.h * fy) as i32,
            }) == hwnd
        })
}

/// Captures the window's visible frame. Errors are written for the model.
pub fn window(hwnd: HWND, app: &str) -> Result<(Picture, Rect), String> {
    unsafe {
        if IsIconic(hwnd).as_bool() {
            return Err("The window is minimized, so it can't be captured. Use the outline, or a window restore step.".into());
        }
        if IsHungAppWindow(hwnd).as_bool() {
            return Err(format!(
                "{app} is not responding, so its window can't be drawn right now."
            ));
        }
    }
    let visible = frame(hwnd).ok_or("The window has no size to capture.")?;
    let whole = outer(hwnd).unwrap_or(visible);
    let (width, height) = (whole.w as i32, whole.h as i32);
    if width <= 0 || height <= 0 || width > 16_384 || height > 16_384 {
        return Err("The window has no size to capture.".into());
    }
    if i64::from(width) * i64::from(height) > MAX_PIXELS {
        return Err("The window is too large to capture; use the outline, or resize it.".into());
    }
    // PrintWindow waits for the app to draw; a stuck app must not stall the helper, so it
    // runs on its own thread, which owns every GDI object it uses.
    let raw = hwnd.0 as isize;
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = sender.send(render(HWND(raw as *mut _), visible, whole));
    });
    match receiver.recv_timeout(std::time::Duration::from_secs(3)) {
        Ok(Some(picture)) => Ok((picture, visible)),
        Ok(None) => Err(format!("{app} draws its window in a way Windows can't capture while it is covered. Use the outline, or add activate first and take the screenshot again.")),
        Err(_) => Err(format!("{app} did not draw its window within 3 seconds. Use the outline, or try again.")),
    }
}

/// Draws the window into a bitmap and crops its visible frame; None when nothing usable came.
fn render(hwnd: HWND, visible: Rect, whole: Rect) -> Option<Picture> {
    let (width, height) = (whole.w as i32, whole.h as i32);
    let canvas = Canvas::new(width, height)?;
    let printed = unsafe {
        PrintWindow(
            hwnd,
            canvas.memory,
            PRINT_WINDOW_FLAGS(PW_RENDERFULLCONTENT),
        )
        .as_bool()
    };
    let x = ((visible.x - whole.x) as i32).clamp(0, width - 1);
    let y = ((visible.y - whole.y) as i32).clamp(0, height - 1);
    let w = (visible.w as i32).min(width - x);
    let h = (visible.h as i32).min(height - y);
    let picture = canvas.crop(x, y, w, h);
    if printed
        && !looks_blank(
            &picture.bgra,
            picture.stride,
            (picture.width, picture.height),
        )
    {
        return Some(picture);
    }
    // Some GPU-drawn windows print black. When the window is on screen and uncovered, the
    // screen itself shows exactly it.
    if uncovered(hwnd, visible) {
        let copied = unsafe {
            BitBlt(
                canvas.memory,
                0,
                0,
                w,
                h,
                canvas.screen,
                visible.x as i32,
                visible.y as i32,
                SRCCOPY | CAPTUREBLT,
            )
        };
        if copied.is_ok() {
            let picture = canvas.crop(0, 0, w, h);
            if !looks_blank(
                &picture.bgra,
                picture.stride,
                (picture.width, picture.height),
            ) {
                return Some(picture);
            }
        }
    }
    None
}
