use crate::{
    policy::DamageGate,
    protocol::{Fault, Result, internal},
    x11::{Window, X11},
};
use std::{
    os::fd::AsRawFd,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Instant,
};
use x11rb::protocol::composite::ConnectionExt as _;
use x11rb::protocol::damage::ConnectionExt as _;
use x11rb::protocol::shm::ConnectionExt as _;
use x11rb::{
    connection::Connection,
    protocol::{Event, xproto::*},
    protocol::{composite, damage},
};
struct SharedMemory {
    ptr: *mut libc::c_void,
    size: usize,
    segment: u32,
    conn: Arc<X11>,
}
impl SharedMemory {
    fn new(conn: Arc<X11>, size: usize) -> Result<Self> {
        let segment = conn.conn.generate_id().map_err(internal)?;
        // SAFETY: allocation is private, size bounded by validated geometry; IPC_RMID is set after X attach.
        let id = unsafe { libc::shmget(libc::IPC_PRIVATE, size, libc::IPC_CREAT | 0o600) };
        if id < 0 {
            return Err(internal(std::io::Error::last_os_error()));
        }
        let ptr = unsafe { libc::shmat(id, std::ptr::null(), 0) };
        if ptr == (-1isize as *mut libc::c_void) {
            unsafe {
                libc::shmctl(id, libc::IPC_RMID, std::ptr::null_mut());
            }
            return Err(internal(std::io::Error::last_os_error()));
        }
        let attached = conn
            .conn
            .shm_attach(segment, id as u32, false)
            .map_err(internal)
            .and_then(|cookie| cookie.check().map_err(internal));
        unsafe {
            libc::shmctl(id, libc::IPC_RMID, std::ptr::null_mut());
        }
        if let Err(e) = attached {
            unsafe {
                libc::shmdt(ptr);
            }
            return Err(e);
        }
        Ok(Self {
            ptr,
            size,
            segment,
            conn,
        })
    }
    fn bytes(&self) -> &[u8] {
        unsafe { std::slice::from_raw_parts(self.ptr.cast::<u8>(), self.size) }
    }
}
impl Drop for SharedMemory {
    fn drop(&mut self) {
        let _ = self.conn.conn.shm_detach(self.segment);
        let _ = self.conn.conn.flush();
        unsafe {
            libc::shmdt(self.ptr);
        }
    }
}

pub fn capture(
    window: Window,
    fps: u32,
    stop: Arc<AtomicBool>,
    wake_fd: i32,
    mut publish: impl FnMut(Vec<u8>, u32, u32, f64) -> Result<()>,
) -> Result<()> {
    let x = Arc::new(X11::connect()?);
    let damage_id = x.conn.generate_id().map_err(internal)?;
    x.conn
        .damage_create(damage_id, window.id, damage::ReportLevel::NON_EMPTY)
        .map_err(internal)?
        .check()
        .map_err(internal)?;
    x.conn
        .change_window_attributes(
            window.id,
            &ChangeWindowAttributesAux::new().event_mask(EventMask::STRUCTURE_NOTIFY),
        )
        .map_err(internal)?
        .check()
        .map_err(internal)?;
    x.conn.flush().map_err(internal)?;
    let mut memory: Option<SharedMemory> = None;
    let mut scaled: Option<crate::x11_scale::Scaled> = None;
    x.conn
        .composite_redirect_window(window.id, composite::Redirect::AUTOMATIC)
        .map_err(internal)?
        .check()
        .map_err(internal)?;
    let mut backing: Option<(u32, u16, u16)> = None;
    let mut rgb = Vec::new();
    let mut previous: Option<(u32, u32, u64)> = None;
    let mut gate = DamageGate::new(fps);
    let start = Instant::now();
    let result = (|| {
        while !stop.load(Ordering::Acquire) {
            while let Some(event) = x.conn.poll_for_event().map_err(internal)? {
                match event {
                    Event::DamageNotify(_) | Event::ConfigureNotify(_) | Event::MapNotify(_) => {
                        gate.damage()
                    }
                    Event::DestroyNotify(_) => {
                        return Err(Fault::new("target_gone", "Capture target closed"));
                    }
                    _ => {}
                }
            }
            let now = start.elapsed();
            if gate.take(now) {
                let live = x.window(window.id)?;
                if live.pid != window.pid || live.identity != window.identity {
                    return Err(Fault::new("target_gone", "Capture target replaced"));
                }
                let w = live.bounds.w as u32;
                let h = live.bounds.h as u32;
                if w == 0
                    || h == 0
                    || w > 8192
                    || h > 8192
                    || u64::from(w) * u64::from(h) > 16_777_216
                {
                    return Err(Fault::new(
                        "bounds",
                        "Capture geometry exceeds 16 megapixels",
                    ));
                }
                let geometry = x
                    .conn
                    .get_geometry(window.id)
                    .map_err(internal)?
                    .reply()
                    .map_err(internal)?;
                let format = x
                    .conn
                    .setup()
                    .pixmap_formats
                    .iter()
                    .find(|f| f.depth == geometry.depth)
                    .ok_or_else(|| Fault::new("not_supported", "Unknown pixel format"))?;
                if format.bits_per_pixel != 32 {
                    return Err(Fault::new(
                        "not_supported",
                        "X11 capture requires 32-bit pixels",
                    ));
                }
                let ratio = (3840f64 / f64::from(w)).min(2160f64 / f64::from(h)).min(1.);
                let out_w = (f64::from(w) * ratio).floor().max(1.) as u32;
                let out_h = (f64::from(h) * ratio).floor().max(1.) as u32;
                let attributes = x
                    .conn
                    .get_window_attributes(window.id)
                    .map_err(internal)?
                    .reply()
                    .map_err(internal)?;
                if backing.is_none_or(|(_, bw, bh)| bw != w as u16 || bh != h as u16) {
                    scaled = None;
                    if let Some((old, _, _)) = backing.take() {
                        let _ = x.conn.free_pixmap(old);
                    }
                    let pixmap = x.conn.generate_id().map_err(internal)?;
                    x.conn
                        .composite_name_window_pixmap(window.id, pixmap)
                        .map_err(internal)?
                        .check()
                        .map_err(internal)?;
                    backing = Some((pixmap, w as u16, h as u16));
                }
                let source = backing.ok_or_else(|| internal("Missing capture pixmap"))?.0;
                // Reset damage before capture, so updates during read/encode remain pending.
                x.conn
                    .damage_subtract(damage_id, 0u32, 0u32)
                    .map_err(internal)?
                    .check()
                    .map_err(internal)?;
                let (drawable, visual_id) = if (out_w, out_h) != (w, h) {
                    let size = (w as u16, h as u16, out_w as u16, out_h as u16);
                    if scaled.as_ref().is_none_or(|s| s.size != size) {
                        scaled = Some(crate::x11_scale::Scaled::new(
                            x.clone(),
                            source,
                            attributes.visual,
                            (w as u16, h as u16),
                            (out_w as u16, out_h as u16),
                        )?);
                    }
                    let scaled = scaled
                        .as_ref()
                        .ok_or_else(|| internal("Missing scaled capture"))?;
                    (scaled.render()?, scaled.visual)
                } else {
                    scaled = None;
                    (source, attributes.visual)
                };
                let size = out_w as usize * out_h as usize * 4;
                if memory.as_ref().is_none_or(|m| m.size != size) {
                    memory = Some(SharedMemory::new(x.clone(), size)?);
                }
                let m = memory
                    .as_ref()
                    .ok_or_else(|| internal("Missing XShm memory"))?;
                x.conn
                    .shm_get_image(
                        drawable,
                        0,
                        0,
                        out_w as u16,
                        out_h as u16,
                        !0,
                        ImageFormat::Z_PIXMAP.into(),
                        m.segment,
                        0,
                    )
                    .map_err(internal)?
                    .reply()
                    .map_err(internal)?;
                let visual = x
                    .conn
                    .setup()
                    .roots
                    .iter()
                    .flat_map(|s| &s.allowed_depths)
                    .flat_map(|d| &d.visuals)
                    .find(|v| v.visual_id == visual_id)
                    .copied()
                    .ok_or_else(|| Fault::new("not_supported", "Unknown visual"))?;
                rgb.resize(out_w as usize * out_h as usize * 3, 0);
                for oy in 0..out_h {
                    for ox in 0..out_w {
                        let offset = (oy * out_w + ox) as usize * 4;
                        let bytes: [u8; 4] =
                            m.bytes()[offset..offset + 4].try_into().map_err(internal)?;
                        let pixel = if x.conn.setup().image_byte_order == ImageOrder::LSB_FIRST {
                            u32::from_le_bytes(bytes)
                        } else {
                            u32::from_be_bytes(bytes)
                        };
                        for (c, mask) in [visual.red_mask, visual.green_mask, visual.blue_mask]
                            .into_iter()
                            .enumerate()
                        {
                            let max = mask >> mask.trailing_zeros();
                            rgb[(oy * out_w + ox) as usize * 3 + c] =
                                (((pixel & mask) >> mask.trailing_zeros()) * 255 / max) as u8;
                        }
                    }
                }
                let mut digest = 14695981039346656037u64;
                for byte in &rgb {
                    digest = (digest ^ u64::from(*byte)).wrapping_mul(1099511628211);
                }
                if previous != Some((out_w, out_h, digest)) {
                    previous = Some((out_w, out_h, digest));
                    let mut jpeg = Vec::new();
                    jpeg_encoder::Encoder::new(&mut jpeg, 75)
                        .encode(
                            &rgb,
                            out_w as u16,
                            out_h as u16,
                            jpeg_encoder::ColorType::Rgb,
                        )
                        .map_err(internal)?;
                    publish(jpeg, out_w, out_h, f64::from(out_w) / f64::from(w))?;
                }
            }
            let timeout = gate
                .wait(start.elapsed())
                .map(|d| d.as_millis().min(i32::MAX as u128) as i32)
                .unwrap_or(-1);
            let mut fds = [
                libc::pollfd {
                    fd: x.conn.stream().as_raw_fd(),
                    events: libc::POLLIN,
                    revents: 0,
                },
                libc::pollfd {
                    fd: wake_fd,
                    events: libc::POLLIN,
                    revents: 0,
                },
            ];
            // No polling timer while idle. A stop pipe wakes the blocked capture.
            let n = unsafe { libc::poll(fds.as_mut_ptr(), 2, timeout) };
            if n < 0 && std::io::Error::last_os_error().kind() != std::io::ErrorKind::Interrupted {
                return Err(internal(std::io::Error::last_os_error()));
            }
        }
        Ok(())
    })();
    drop(scaled);
    if let Some((pixmap, _, _)) = backing {
        let _ = x.conn.free_pixmap(pixmap);
    }
    let _ = x
        .conn
        .composite_unredirect_window(window.id, composite::Redirect::AUTOMATIC);
    let _ = x.conn.damage_destroy(damage_id);
    result
}
