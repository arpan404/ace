//! One frame from a portal PipeWire stream, then the stream closes: computer use never keeps
//! a capture running. Uses the C shell in `pipewire.c`.
use crate::computer::image::Rgb;
use std::ffi::c_void;
use std::os::fd::{IntoRawFd, OwnedFd};
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

struct Grab {
    frame: Option<Rgb>,
    failed: Option<String>,
    /// The open stream, to read the frame's crop region from.
    capture: *mut c_void,
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

unsafe extern "C" fn on_frame(user: *mut c_void, bytes: *const u8, w: u32, h: u32, stride: i32, format: u32) {
    // SAFETY: the C shell passes our Grab and a buffer it validated, synchronously on this thread.
    let grab = unsafe { &mut *user.cast::<Grab>() };
    if grab.frame.is_some() || grab.failed.is_some() || stride <= 0 || h == 0 {
        return;
    }
    let source = unsafe { std::slice::from_raw_parts(bytes, stride as usize * (h as usize - 1) + w as usize * 4) };
    match to_rgb(source, w, h, stride as usize, format) {
        Ok(frame) => {
            let (mut x, mut y, mut cw, mut ch) = (0, 0, 0, 0);
            // SAFETY: the stream is open; the crop belongs to the buffer being delivered.
            let cropped = unsafe { ace_pw_crop(grab.capture, &mut x, &mut y, &mut cw, &mut ch) } == 1;
            grab.frame = Some(if cropped { crop(frame, x, y, cw, ch) } else { frame });
        }
        Err(error) => grab.failed = Some(error),
    }
}

/// Connects to the portal's PipeWire remote, waits for the first frame and closes the stream.
pub fn grab(remote: OwnedFd, node: u32, timeout: Duration) -> Result<Rgb, String> {
    let mut pipe = [0i32; 2];
    // SAFETY: pipe fills two fds; both are closed below.
    if unsafe { libc::pipe(pipe.as_mut_ptr()) } != 0 {
        return Err("no pipe".into());
    }
    let mut grab = Grab {
        frame: None,
        failed: None,
        capture: std::ptr::null_mut(),
    };
    let capture = unsafe {
        ace_pw_open(
            remote.into_raw_fd(),
            node,
            pipe[0],
            on_frame,
            (&mut grab as *mut Grab).cast(),
        )
    };
    grab.capture = capture;
    let result = if capture.is_null() {
        Err("PipeWire is not available (install libpipewire-0.3)".to_owned())
    } else {
        let deadline = Instant::now() + timeout;
        loop {
            if grab.frame.is_some() || grab.failed.is_some() {
                break;
            }
            if Instant::now() > deadline {
                grab.failed = Some(NO_FRAME.into());
                break;
            }
            if unsafe { ace_pw_step(capture, 100) } < 0 {
                grab.failed = Some("the stream failed".into());
                break;
            }
        }
        unsafe { ace_pw_destroy(capture) };
        match (grab.frame.take(), grab.failed.take()) {
            (Some(frame), _) => Ok(frame),
            (None, Some(error)) => Err(error),
            (None, None) => Err("no frame".into()),
        }
    };
    unsafe {
        libc::close(pipe[0]);
        libc::close(pipe[1]);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::{Rgb, crop, to_rgb};

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
}
