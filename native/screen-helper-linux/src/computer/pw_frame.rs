//! Pictures from a portal PipeWire stream, read through the C shell in `pipewire.c`. A
//! `Watch` reads the stream on its own thread and always holds the latest frame, so a look
//! can take the picture the desktop last sent even when it sent it before the look began.
use crate::computer::image::Rgb;
use std::ffi::c_void;
use std::os::fd::{IntoRawFd, OwnedFd};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
unsafe extern "C" {
    fn ace_pw_open(
        fd: i32,
        node: u32,
        stop_fd: i32,
        callback: unsafe extern "C" fn(*mut c_void, *const u8, u32, u32, i32, u32),
        user: *mut c_void,
    ) -> *mut c_void;
    fn ace_pw_step(c: *mut c_void, timeout: i32) -> i32;
    fn ace_pw_destroy(c: *mut c_void);
    fn ace_pw_crop(c: *mut c_void, x: *mut i32, y: *mut i32, w: *mut u32, h: *mut u32) -> i32;
}

/// The stream opened but sent no picture before the deadline.
pub const NO_FRAME: &str = "no frame arrived in time";

/// The newest frame as the producer sent it; converted to RGB only when a look takes it.
struct Raw {
    bytes: Vec<u8>,
    width: u32,
    height: u32,
    stride: usize,
    format: u32,
    crop: Option<(i32, i32, u32, u32)>,
}

/// A picture, and where in it the window's opaque body sits (`opaque_box`).
pub struct Picture {
    pub rgb: Rgb,
    pub opaque: Option<Bounds>,
}

/// left, top, width, height in picture pixels.
pub type Bounds = (u32, u32, u32, u32);

impl Raw {
    fn picture(&self) -> Result<Picture, String> {
        let frame = to_rgb(&self.bytes, self.width, self.height, self.stride, self.format)?;
        let region = crate::pipewire::visible_region(self.width, self.height, self.crop);
        let opaque = opaque_box(&self.bytes, self.stride, self.format, region);
        let rgb = match self.crop {
            Some((x, y, w, h)) => crop(frame, x, y, w, h),
            None => frame,
        };
        Ok(Picture { rgb, opaque })
    }
}

/// The window's opaque body inside a frame with alpha, relative to `region` (the part of the
/// buffer the picture shows): the first and last fully opaque pixels along the region's middle
/// row and column. A GTK window's stream includes its client-side shadow, which is translucent
/// and not even on all sides (Adwaita's falls further below than above), so the body can't be
/// assumed centred. `None` for formats without alpha (RGBx, BGRx) or no opaque pixel there.
pub fn opaque_box(source: &[u8], stride: usize, format: u32, region: Bounds) -> Option<Bounds> {
    if !matches!(format, 11 | 12) {
        return None;
    }
    let (left, top, width, height) = region;
    if width == 0 || height == 0 {
        return None;
    }
    let alpha = |x: u32, y: u32| {
        source
            .get((top + y) as usize * stride + (left + x) as usize * 4 + 3)
            .copied()
            .unwrap_or(0)
    };
    let span = |len: u32, at: &dyn Fn(u32) -> u8| {
        let first = (0..len).find(|&i| at(i) == 255)?;
        let last = (0..len).rev().find(|&i| at(i) == 255)?;
        Some((first, last + 1 - first))
    };
    let (x, w) = span(width, &|x| alpha(x, height / 2))?;
    let (y, h) = span(height, &|y| alpha(width / 2, y))?;
    Some((x, y, w, h))
}

#[derive(Default)]
struct State {
    latest: Option<Raw>,
    failed: Option<String>,
    ended: bool,
}

struct Shared {
    state: Mutex<State>,
    changed: Condvar,
    stop: AtomicBool,
    /// The stream ends once this passes without a look; each look moves it on.
    idle_until: Mutex<Instant>,
    idle: Duration,
}

/// What the stream thread hands the C callback.
struct Pump {
    shared: Arc<Shared>,
    capture: *mut c_void,
}

/// A portal stream read on its own thread until dropped or left unused for `idle`.
pub struct Watch {
    shared: Arc<Shared>,
    thread: Option<JoinHandle<()>>,
}

impl Watch {
    pub fn start(remote: OwnedFd, node: u32, idle: Duration) -> Self {
        let shared = Arc::new(Shared {
            state: Mutex::new(State::default()),
            changed: Condvar::new(),
            stop: AtomicBool::new(false),
            idle_until: Mutex::new(Instant::now() + idle),
            idle,
        });
        let pump = shared.clone();
        let thread = std::thread::Builder::new()
            .name("ace-screencast".into())
            .spawn(move || run(remote, node, pump));
        let thread = match thread {
            Ok(thread) => Some(thread),
            Err(_) => {
                finish(&shared, Some("no thread for the stream".into()));
                None
            }
        };
        Self { shared, thread }
    }

    /// The desktop's latest picture, waiting up to `timeout` for a first one. `Err(NO_FRAME)`:
    /// none has come yet and the stream is still open.
    pub fn latest(&self, timeout: Duration) -> Result<Picture, String> {
        if let Ok(mut until) = self.shared.idle_until.lock() {
            *until = Instant::now() + self.shared.idle;
        }
        let state = self.shared.state.lock().map_err(|_| "the stream failed".to_owned())?;
        let (state, _) = self
            .shared
            .changed
            .wait_timeout_while(state, timeout, |s| s.latest.is_none() && s.failed.is_none() && !s.ended)
            .map_err(|_| "the stream failed".to_owned())?;
        match (&state.latest, &state.failed) {
            (Some(raw), _) => raw.picture(),
            (None, Some(error)) => Err(error.clone()),
            (None, None) if state.ended => Err("the stream ended".into()),
            (None, None) => Err(NO_FRAME.into()),
        }
    }

    /// The stream closed (failed, or unused for too long); a later look needs a new one.
    pub fn ended(&self) -> bool {
        self.shared.state.lock().map_or(true, |s| s.ended)
    }
}

impl Drop for Watch {
    fn drop(&mut self) {
        self.shared.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// The part of a frame the producer marked valid (a window inside a monitor-sized buffer),
/// clamped to the frame.
pub fn crop(frame: Rgb, x: i32, y: i32, w: u32, h: u32) -> Rgb {
    let (left, top, width, height) =
        crate::pipewire::visible_region(frame.width, frame.height, Some((x, y, w, h)));
    if (left, top, width, height) == (0, 0, frame.width, frame.height) {
        return frame;
    }
    let mut pixels = Vec::with_capacity(width as usize * height as usize * 3);
    for row in top..top + height {
        let start = (row as usize * frame.width as usize + left as usize) * 3;
        pixels.extend_from_slice(&frame.pixels[start..start + width as usize * 3]);
    }
    Rgb { width, height, pixels }
}

/// Converts a mapped SPA video buffer to RGB. Formats: RGBx=7, BGRx=8, RGBA=11, BGRA=12.
pub fn to_rgb(source: &[u8], w: u32, h: u32, stride: usize, format: u32) -> Result<Rgb, String> {
    let order = match format {
        7 | 11 => [0, 1, 2],
        8 | 12 => [2, 1, 0],
        other => return Err(format!("unsupported pixel format {other}")),
    };
    if stride < w as usize * 4 || source.len() < stride * (h as usize - 1) + w as usize * 4 {
        return Err("short frame".into());
    }
    let mut pixels = Vec::with_capacity(w as usize * h as usize * 3);
    for row in 0..h as usize {
        let line = &source[row * stride..row * stride + w as usize * 4];
        for px in line.chunks_exact(4) {
            pixels.extend_from_slice(&[px[order[0]], px[order[1]], px[order[2]]]);
        }
    }
    Ok(Rgb {
        width: w,
        height: h,
        pixels,
    })
}

fn finish(shared: &Shared, failed: Option<String>) {
    if let Ok(mut state) = shared.state.lock() {
        if state.failed.is_none() {
            state.failed = failed;
        }
        state.ended = true;
    }
    shared.changed.notify_all();
}

unsafe extern "C" fn on_frame(user: *mut c_void, bytes: *const u8, w: u32, h: u32, stride: i32, format: u32) {
    // SAFETY: the C shell passes our Pump and a buffer it validated, synchronously on the
    // stream thread, while `run` keeps the Pump alive.
    let pump = unsafe { &*user.cast::<Pump>() };
    if stride <= 0 || h == 0 || w == 0 {
        return;
    }
    let length = stride as usize * (h as usize - 1) + w as usize * 4;
    let source = unsafe { std::slice::from_raw_parts(bytes, length) };
    let (mut x, mut y, mut cw, mut ch) = (0, 0, 0, 0);
    // SAFETY: the stream is open; the crop belongs to the buffer being delivered.
    let cropped = unsafe { ace_pw_crop(pump.capture, &mut x, &mut y, &mut cw, &mut ch) } == 1;
    let raw = Raw {
        bytes: source.to_vec(),
        width: w,
        height: h,
        stride: stride as usize,
        format,
        crop: cropped.then_some((x, y, cw, ch)),
    };
    if let Ok(mut state) = pump.shared.state.lock() {
        state.latest = Some(raw);
    }
    pump.shared.changed.notify_all();
}

/// The stream thread: connects to the portal's PipeWire remote and reads it until stopped,
/// failed, or left unused.
fn run(remote: OwnedFd, node: u32, shared: Arc<Shared>) {
    let mut pipe = [0i32; 2];
    // SAFETY: pipe fills two fds; both are closed below.
    if unsafe { libc::pipe(pipe.as_mut_ptr()) } != 0 {
        finish(&shared, Some("no pipe".into()));
        return;
    }
    let mut pump = Pump {
        shared: shared.clone(),
        capture: std::ptr::null_mut(),
    };
    let capture = unsafe { ace_pw_open(remote.into_raw_fd(), node, pipe[0], on_frame, (&mut pump as *mut Pump).cast()) };
    pump.capture = capture;
    let failed = if capture.is_null() {
        Some("PipeWire is not available (install libpipewire-0.3)".to_owned())
    } else {
        let mut failed = None;
        while !shared.stop.load(Ordering::Relaxed)
            && shared.idle_until.lock().map_or(false, |until| Instant::now() < *until)
        {
            if unsafe { ace_pw_step(capture, 100) } < 0 {
                failed = Some("the stream failed".to_owned());
                break;
            }
        }
        unsafe { ace_pw_destroy(capture) };
        failed
    };
    unsafe {
        libc::close(pipe[0]);
        libc::close(pipe[1]);
    }
    finish(&shared, failed);
}

#[cfg(test)]
mod tests {
    use super::{Rgb, crop, opaque_box, to_rgb};

    #[test]
    fn a_window_inside_a_larger_buffer_is_cut_out_and_kept_inside_it() {
        // 3×2 frame; pixel value = its index.
        let frame = Rgb {
            width: 3,
            height: 2,
            pixels: (0..18).collect(),
        };
        let window = crop(frame, 1, 1, 5, 5);
        assert_eq!((window.width, window.height), (2, 1));
        assert_eq!(window.pixels, vec![12, 13, 14, 15, 16, 17]);
        let whole = Rgb {
            width: 3,
            height: 2,
            pixels: (0..18).collect(),
        };
        assert_eq!(crop(whole, 0, 0, 3, 2).pixels.len(), 18);
    }

    #[test]
    fn bgr_frames_with_padded_rows_become_rgb() {
        // 2×1 BGRx with a 12-byte stride (4 bytes of row padding).
        let source = [10, 20, 30, 0, 40, 50, 60, 0, 9, 9, 9, 9];
        let frame = to_rgb(&source, 2, 1, 12, 8).unwrap();
        assert_eq!(frame.pixels, vec![30, 20, 10, 60, 50, 40]);
        assert!(to_rgb(&source, 2, 1, 12, 99).is_err());
    }

    #[test]
    fn the_opaque_body_is_found_inside_a_translucent_shadow_deeper_below() {
        // 8×10 BGRA buffer in a 40-byte stride; the window region is its left 7×9. Body opaque
        // at x 2..5, y 1..6; the shadow around it translucent, deeper below; outside, clear.
        let (stride, height) = (40usize, 10u32);
        let mut source = vec![0u8; stride * height as usize];
        for y in 0..9u32 {
            for x in 0..7u32 {
                let body = (2..5).contains(&x) && (1..6).contains(&y);
                source[y as usize * stride + x as usize * 4 + 3] = if body { 255 } else { 40 };
            }
        }
        assert_eq!(opaque_box(&source, stride, 12, (0, 0, 7, 9)), Some((2, 1, 3, 5)));
        // Relative to a region that starts inside the buffer.
        assert_eq!(opaque_box(&source, stride, 12, (1, 1, 6, 8)), Some((1, 0, 3, 5)));
        // RGBx/BGRx carry no alpha; a clear frame has no body.
        assert_eq!(opaque_box(&source, stride, 8, (0, 0, 7, 9)), None);
        assert_eq!(opaque_box(&vec![0u8; stride * 10], stride, 11, (0, 0, 7, 9)), None);
    }
}
