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
}
struct Frames {
    publisher: Publisher,
    fps: u32,
    logical_width: u32,
    next: Instant,
    previous: Vec<u8>,
    rgb: Vec<u8>,
    failed: bool,
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
        let size = w as usize * h as usize * 4;
        let changed = frames.previous.len() != size
            || (0..h as usize).any(|y| {
                frames.previous[y * w as usize * 4..(y + 1) * w as usize * 4]
                    != source[y * stride as usize..y * stride as usize + w as usize * 4]
            });
        if !changed {
            return Ok(());
        }
        frames.previous.resize(size, 0);
        for y in 0..h as usize {
            frames.previous[y * w as usize * 4..(y + 1) * w as usize * 4].copy_from_slice(
                &source[y * stride as usize..y * stride as usize + w as usize * 4],
            );
        }
        let ratio = (3840f64 / f64::from(w)).min(2160f64 / f64::from(h)).min(1.);
        let ow = (f64::from(w) * ratio).floor().max(1.) as u32;
        let oh = (f64::from(h) * ratio).floor().max(1.) as u32;
        frames.rgb.resize(ow as usize * oh as usize * 3, 0);
        for y in 0..oh {
            for x in 0..ow {
                let from = (y * h / oh) as usize * stride as usize + (x * w / ow) as usize * 4;
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
        frames.publisher.frame(
            jpeg,
            ow,
            oh,
            f64::from(ow) / f64::from(frames.logical_width),
        )?;
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
        previous: Vec::new(),
        rgb: Vec::new(),
        failed: false,
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
