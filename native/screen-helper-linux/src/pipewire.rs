use crate::{
    protocol::{Result, internal},
    writer::Publisher,
};
use std::{
    ffi::c_void,
    os::fd::{IntoRawFd, OwnedFd},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
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
    if frames.failed || Instant::now() < frames.next {
        return;
    }
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let source = unsafe { std::slice::from_raw_parts(bytes, stride as usize * h as usize) };
        if !frames
            .previous
            .update(source, w, h, stride as usize, format)
        {
            return Ok(());
        }
        let (mut cx, mut cy, mut cw, mut ch) = (0, 0, 0, 0);
        // SAFETY: the stream is open; the crop belongs to the buffer being delivered.
        let cropped =
            !frames.capture.is_null()
                && unsafe { ace_pw_crop(frames.capture, &mut cx, &mut cy, &mut cw, &mut ch) } == 1;
        let (left, top, rw, rh) = visible_region(w, h, cropped.then_some((cx, cy, cw, ch)));
        let ratio = (3840f64 / f64::from(rw)).min(2160f64 / f64::from(rh)).min(1.);
        let ow = (f64::from(rw) * ratio).floor().max(1.) as u32;
        let oh = (f64::from(rh) * ratio).floor().max(1.) as u32;
        frames.rgb.resize(ow as usize * oh as usize * 3, 0);
        for y in 0..oh {
            for x in 0..ow {
                let from = (top + y * rh / oh) as usize * stride as usize
                    + (left + x * rw / ow) as usize * 4;
                let to = (y * ow + x) as usize * 3;
                // SPA_VIDEO_FORMAT_RGBx=7, BGRx=8, RGBA=11, BGRA=12.
                let rgb = match format {
                    7 | 11 => [source[from], source[from + 1], source[from + 2]],
                    8 | 12 => [source[from + 2], source[from + 1], source[from]],
                    _ => return Err(internal("Unsupported PipeWire pixel format")),
                };
                frames.rgb[to..to + 3].copy_from_slice(&rgb);
            }
        }
        let mut jpeg = Vec::new();
        jpeg_encoder::Encoder::new(&mut jpeg, 75)
            .encode(
                &frames.rgb,
                ow as u16,
                oh as u16,
                jpeg_encoder::ColorType::Rgb,
            )
            .map_err(internal)?;
        // Picture pixels per logical point of what it shows.
        // A logical width of 0 is unknown (the portal gave none): one point per pixel.
        let logical_width = if frames.logical_width == 0 { w } else { frames.logical_width };
        let logical_shown = f64::from(rw) * f64::from(logical_width) / f64::from(w);
        frames
            .publisher
            .frame(jpeg, ow, oh, f64::from(ow) / logical_shown)?;
        frames.next = Instant::now() + Duration::from_nanos(1_000_000_000 / u64::from(frames.fps));
        Ok(())
    }));
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
            if unsafe { ace_pw_step(c, -1) } < 0 || frames.failed {
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
    use super::visible_region;

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
