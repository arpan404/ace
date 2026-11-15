//! The C shell around PipeWire (`pipewire.c`), declared once for its two callers: the live
//! view's capture and the computer-use engine's looks.
use std::ffi::c_void;

/// One picture as the producer handed it over, valid only during the callback: mapped memory
/// (`bytes`), or a DMA-BUF (`dmabuf` set, `fd` its descriptor) the consumer imports.
#[repr(C)]
pub struct RawPicture {
    pub dmabuf: i32,
    pub bytes: *const u8,
    pub fd: i32,
    pub offset: u32,
    pub width: u32,
    pub height: u32,
    pub stride: i32,
    /// `SPA_VIDEO_FORMAT_*`.
    pub format: u32,
    pub modifier: u64,
    pub has_crop: i32,
    pub crop_x: i32,
    pub crop_y: i32,
    pub crop_w: u32,
    pub crop_h: u32,
}

impl RawPicture {
    /// The producer's crop region, when it sent one.
    pub fn crop(&self) -> Option<(i32, i32, u32, u32)> {
        (self.has_crop != 0).then_some((self.crop_x, self.crop_y, self.crop_w, self.crop_h))
    }

    /// The mapped pixels: `stride × (height − 1) + width × 4` bytes, checked by the shell.
    ///
    /// # Safety
    /// Only during the callback that received `self`, and only when `dmabuf` is 0.
    pub unsafe fn bytes(&self) -> Option<&[u8]> {
        if self.dmabuf != 0 || self.bytes.is_null() || self.stride <= 0 || self.height == 0 {
            return None;
        }
        let length = self.stride as usize * (self.height as usize - 1) + self.width as usize * 4;
        // SAFETY: the shell checked this range of the mapping, which lives for the callback.
        Some(unsafe { std::slice::from_raw_parts(self.bytes, length) })
    }
}

/// Called with each picture; returns 1 to keep the buffer until a newer one replaces it or
/// `ace_pw_redeliver` offers it again, 0 to give it back now.
pub type OnPicture = unsafe extern "C" fn(*mut c_void, *const RawPicture) -> i32;

unsafe extern "C" {
    /// Opens the portal's stream. With `dmabuf` set, DMA-BUFs are offered before shared memory.
    pub fn ace_pw_open(
        fd: i32,
        node: u32,
        stop_fd: i32,
        dmabuf: i32,
        callback: OnPicture,
        user: *mut c_void,
    ) -> *mut c_void;
    pub fn ace_pw_step(c: *mut c_void, timeout: i32) -> i32;
    pub fn ace_pw_destroy(c: *mut c_void);
    /// Offers the kept buffer again.
    pub fn ace_pw_redeliver(c: *mut c_void);
    /// Whether a buffer is held; one PipeWire removed never is.
    pub fn ace_pw_holding(c: *mut c_void) -> i32;
    /// Whether the producer chose DMA-BUFs.
    pub fn ace_pw_dmabuf(c: *mut c_void) -> i32;
    /// Tests only: offers the formats again (BGRx alone when `narrow`), so the stream
    /// negotiates again and PipeWire allocates every buffer anew.
    pub fn ace_pw_reallocate(c: *mut c_void, narrow: i32);
    /// Asks for shared memory from now on (a DMA-BUF this machine couldn't import).
    pub fn ace_pw_shared_memory_only(c: *mut c_void);
}
