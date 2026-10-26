use crate::{
    protocol::{Result, internal},
    writer::Publisher,
};
use std::{
    ffi::c_void,
    os::fd::{IntoRawFd, OwnedFd},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
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

/// A rectangle of a buffer in its pixels: left, top, width, height.
pub type Region = (u32, u32, u32, u32);

/// The part of a `w`×`h` buffer a picture shows: the producer's crop region, clamped to the
/// buffer; the whole buffer without one or when the region is empty. GNOME sends a shared
/// window in a monitor-sized buffer, marking the window's own buffer at (0, 0) as the crop
/// (mutter `meta_screen_cast_window_stream_src_get_videocrop`); pointer input on the stream is
/// relative to that same window buffer, so a cropped picture's points are the stream's.
pub fn visible_region(w: u32, h: u32, crop: Option<(i32, i32, u32, u32)>) -> Region {
    let Some((x, y, cw, ch)) = crop else {
        return (0, 0, w, h);
    };
    let left = (x.max(0) as u32).min(w);
    let top = (y.max(0) as u32).min(h);
    let width = cw.min(w - left);
    let height = ch.min(h - top);
    if width == 0 || height == 0 {
        return (0, 0, w, h);
    }
    (left, top, width, height)
}

/// What the runtime tells the capture thread: whether anyone is watching, the capture
/// generation the pictures belong to, and a request to publish the current picture now.
pub struct Control {
    pub watching: AtomicBool,
    pub generation: AtomicU64,
    pub refresh: AtomicBool,
}
impl Control {
    pub fn new(generation: u64) -> Self {
        Self {
            watching: AtomicBool::new(true),
            generation: AtomicU64::new(generation),
            refresh: AtomicBool::new(false),
        }
    }
}

/// A buffer not yet published: kept until the frame rate allows or someone watches again.
/// The desktop sends a buffer only when the screen changes, so dropping it would leave the
/// picture without its last change for as long as the screen stays still.
#[derive(Default)]
struct Pending {
    bytes: Vec<u8>,
    width: u32,
    height: u32,
    stride: usize,
    format: u32,
    crop: Option<(i32, i32, u32, u32)>,
    /// When the buffer arrived, in Unix milliseconds: the picture's time, not its encoding's.
    at: f64,
}

/// The last picture published, to send again when someone starts watching a still screen.
struct Published {
    jpeg: Vec<u8>,
    width: u32,
    height: u32,
    scale: f64,
    at: f64,
}

/// How long the capture loop may wait for the next buffer: until the frame rate allows the
/// one that is waiting, or for ever when none waits or nobody watches. In milliseconds, -1
/// without a limit.
pub fn wait_ms(watching: bool, waiting: bool, refresh: bool, until_due: Duration) -> i32 {
    if !watching {
        return -1;
    }
    if refresh {
        return 0;
    }
    if !waiting {
        return -1;
    }
    until_due.as_millis().min(1000) as i32
}

struct Frames {
    publisher: Publisher,
    fps: u32,
    logical_width: u32,
    next: Instant,
    previous: crate::frame_identity::FrameIdentity,
    rgb: Vec<u8>,
    failed: bool,
    /// The open stream, to read each buffer's crop region from.
    capture: *mut c_void,
    /// The newest buffer's size in stream points (width << 32 | height), for input bounds.
    shown: Arc<AtomicU64>,
    control: Arc<Control>,
    pending: Option<Pending>,
    /// A published buffer's copy, reused for the next so frames don't allocate.
    spare: Vec<u8>,
    last: Option<Published>,
}

fn unix_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.)
        .unwrap_or(0.)
}

impl Frames {
    /// What a `rw`×`rh` region of a `w`-wide buffer shows, in logical points. A logical width
    /// of 0 is unknown (the portal gave none): one point per pixel.
    fn logical(&self, w: u32, rw: u32, rh: u32) -> (f64, f64) {
        let logical_width = if self.logical_width == 0 { w } else { self.logical_width };
        (
            f64::from(rw) * f64::from(logical_width) / f64::from(w),
            f64::from(rh) * f64::from(logical_width) / f64::from(w),
        )
    }

    /// The newest buffer's size in stream points, for input bounds: kept as buffers arrive,
    /// whether or not anyone watches, so the person's input is checked against what is there.
    fn note_shown(&self, w: u32, h: u32, crop: Option<(i32, i32, u32, u32)>) {
        let (_, _, rw, rh) = visible_region(w, h, crop);
        let (wide, high) = self.logical(w, rw, rh);
        self.shown.store(
            ((wide.round() as u64) << 32) | (high.round() as u64 & 0xffff_ffff),
            Ordering::Release,
        );
    }

    fn generation(&self) -> Option<u64> {
        Some(self.control.generation.load(Ordering::Acquire)).filter(|g| *g > 0)
    }

    /// Converts, encodes and publishes one buffer. `force` publishes it even when its pixels
    /// are those already published (someone started watching again).
    fn publish(&mut self, buffer: &Pending, force: bool) -> Result<()> {
        let (w, h, stride, format) = (buffer.width, buffer.height, buffer.stride, buffer.format);
        let source = &buffer.bytes;
        if !self.previous.update(source, w, h, stride, format) && !force {
            return Ok(());
        }
        let (left, top, rw, rh) = visible_region(w, h, buffer.crop);
        let ratio = (3840f64 / f64::from(rw)).min(2160f64 / f64::from(rh)).min(1.);
        let ow = (f64::from(rw) * ratio).floor().max(1.) as u32;
        let oh = (f64::from(rh) * ratio).floor().max(1.) as u32;
        self.rgb.resize(ow as usize * oh as usize * 3, 0);
        for y in 0..oh {
            for x in 0..ow {
                let from = (top + y * rh / oh) as usize * stride + (left + x * rw / ow) as usize * 4;
                let to = (y * ow + x) as usize * 3;
                // SPA_VIDEO_FORMAT_RGBx=7, BGRx=8, RGBA=11, BGRA=12.
                let rgb = match format {
                    7 | 11 => [source[from], source[from + 1], source[from + 2]],
                    8 | 12 => [source[from + 2], source[from + 1], source[from]],
                    _ => return Err(internal("Unsupported PipeWire pixel format")),
                };
                self.rgb[to..to + 3].copy_from_slice(&rgb);
            }
        }
        let mut jpeg = Vec::new();
        jpeg_encoder::Encoder::new(&mut jpeg, 75)
            .encode(&self.rgb, ow as u16, oh as u16, jpeg_encoder::ColorType::Rgb)
            .map_err(internal)?;
        let (logical_shown, _) = self.logical(w, rw, rh);
        let scale = f64::from(ow) / logical_shown;
        self.publisher
            .frame(jpeg.clone(), ow, oh, scale, buffer.at, self.generation())?;
        self.last = Some(Published {
            jpeg,
            width: ow,
            height: oh,
            scale,
            at: buffer.at,
        });
        self.next = Instant::now() + Duration::from_nanos(1_000_000_000 / u64::from(self.fps.max(1)));
        Ok(())
    }

    /// After each loop step: publishes the waiting buffer once the frame rate allows, and
    /// the current picture at once when someone starts watching.
    fn catch_up(&mut self) -> Result<()> {
        if !self.control.watching.load(Ordering::Acquire) {
            return Ok(());
        }
        if self.control.refresh.swap(false, Ordering::AcqRel) {
            if let Some(pending) = self.pending.take() {
                let published = self.publish(&pending, true);
                self.spare = pending.bytes;
                return published;
            }
            if let Some(last) = &self.last {
                let generation = self.generation();
                return self
                    .publisher
                    .frame(last.jpeg.clone(), last.width, last.height, last.scale, last.at, generation);
            }
            return Ok(());
        }
        if Instant::now() >= self.next {
            if let Some(pending) = self.pending.take() {
                let published = self.publish(&pending, false);
                self.spare = pending.bytes;
                return published;
            }
        }
        Ok(())
    }

    fn wait(&self) -> i32 {
        wait_ms(
            self.control.watching.load(Ordering::Acquire),
            self.pending.is_some(),
            self.control.refresh.load(Ordering::Acquire),
            self.next.saturating_duration_since(Instant::now()),
        )
    }
}

unsafe extern "C" fn on_frame(
    user: *mut c_void,
    bytes: *const u8,
    w: u32,
    h: u32,
    stride: i32,
    format: u32,
) {
    // The C shell validates the mapped buffer range and calls synchronously on this thread.
    let frames = unsafe { &mut *user.cast::<Frames>() };
    if frames.failed {
        return;
    }
    let at = unix_ms();
    let source = unsafe { std::slice::from_raw_parts(bytes, stride as usize * h as usize) };
    let (mut cx, mut cy, mut cw, mut ch) = (0, 0, 0, 0);
    // SAFETY: the stream is open; the crop belongs to the buffer being delivered.
    let cropped = !frames.capture.is_null()
        && unsafe { ace_pw_crop(frames.capture, &mut cx, &mut cy, &mut cw, &mut ch) } == 1;
    // The buffer goes back to the desktop after this call: keep a copy of it.
    let mut pending = frames.pending.take().unwrap_or_else(|| Pending {
        bytes: std::mem::take(&mut frames.spare),
        ..Pending::default()
    });
    pending.bytes.clear();
    pending.bytes.extend_from_slice(source);
    pending.width = w;
    pending.height = h;
    pending.stride = stride as usize;
    pending.format = format;
    pending.crop = cropped.then_some((cx, cy, cw, ch));
    pending.at = at;
    frames.note_shown(w, h, pending.crop);
    let watching = frames.control.watching.load(Ordering::Acquire);
    if !watching || Instant::now() < frames.next {
        // Published once the frame rate allows, or when someone watches again.
        frames.pending = Some(pending);
        return;
    }
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| frames.publish(&pending, false)));
    frames.spare = pending.bytes;
    if !matches!(result, Ok(Ok(()))) {
        frames.failed = true;
    }
}
pub fn capture(
    fd: OwnedFd,
    node: u32,
    fps: u32,
    logical_width: u32,
    stop_fd: i32,
    stop: Arc<AtomicBool>,
    publisher: Publisher,
    shown: Arc<AtomicU64>,
    control: Arc<Control>,
) -> Result<()> {
    let mut frames = Frames {
        publisher,
        fps,
        logical_width,
        next: Instant::now(),
        previous: crate::frame_identity::FrameIdentity::default(),
        rgb: Vec::new(),
        failed: false,
        capture: std::ptr::null_mut(),
        shown,
        control,
        pending: None,
        spare: Vec::new(),
        last: None,
    };
    let c = unsafe {
        ace_pw_open(
            fd.into_raw_fd(),
            node,
            stop_fd,
            on_frame,
            (&mut frames as *mut Frames).cast(),
        )
    };
    if c.is_null() {
        return Err(internal(
            "Cannot initialize PipeWire; install libpipewire-0.3 and check portal stream",
        ));
    }
    // Frames arrive only from `ace_pw_step` below, on this thread, after this is set.
    frames.capture = c;
    let result = (|| {
        while !stop.load(Ordering::Acquire) {
            // Wakes for a buffer, the runtime's wake byte (watch, stop), or a waiting buffer
            // coming due.
            if unsafe { ace_pw_step(c, frames.wait()) } < 0 || frames.failed {
                return Err(internal("PipeWire capture failed"));
            }
            let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| frames.catch_up()));
            if !matches!(caught, Ok(Ok(()))) {
                return Err(internal("PipeWire capture failed"));
            }
        }
        Ok(())
    })();
    unsafe {
        ace_pw_destroy(c);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::{visible_region, wait_ms};
    use std::time::Duration;

    #[test]
    fn a_waiting_buffer_wakes_the_loop_when_due_and_nothing_waits_without_one() {
        // A change arrived too soon: wait only until the frame rate allows it.
        assert_eq!(wait_ms(true, true, false, Duration::from_millis(40)), 40);
        assert_eq!(wait_ms(true, true, false, Duration::ZERO), 0);
        // Nothing waiting, or nobody watching: sleep until the desktop sends something.
        assert_eq!(wait_ms(true, false, false, Duration::from_millis(40)), -1);
        assert_eq!(wait_ms(false, true, false, Duration::from_millis(40)), -1);
        // Someone started watching: publish now.
        assert_eq!(wait_ms(true, false, true, Duration::from_millis(40)), 0);
    }

    #[test]
    fn a_window_inside_a_monitor_sized_buffer_is_shown_alone() {
        // GNOME 50: Calculator's 410×666 buffer (window and shadow) in a 1280×800 one.
        assert_eq!(visible_region(1280, 800, Some((0, 0, 410, 666))), (0, 0, 410, 666));
        assert_eq!(visible_region(1280, 800, Some((25, 25, 360, 616))), (25, 25, 360, 616));
    }

    #[test]
    fn a_buffer_without_a_usable_crop_is_shown_whole() {
        assert_eq!(visible_region(1280, 800, None), (0, 0, 1280, 800));
        assert_eq!(visible_region(1280, 800, Some((10, 10, 0, 40))), (0, 0, 1280, 800));
        assert_eq!(visible_region(1280, 800, Some((1280, 0, 50, 50))), (0, 0, 1280, 800));
    }

    #[test]
    fn a_crop_reaching_past_the_buffer_is_clamped_to_it() {
        assert_eq!(visible_region(800, 600, Some((-5, 500, 900, 300))), (0, 500, 800, 100));
    }
}
