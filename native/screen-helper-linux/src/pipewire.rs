use crate::{
    media::{
        encoder::{Captured, Input},
        pixels::{SPA_BGRA, SPA_RGBA},
        select::{DmaBufUse, dmabuf_use},
        stream::encode_size,
        video::{Stamp, StreamControl, Video, VideoSink},
    },
    pipewire_ffi::{
        RawPicture, ace_pw_destroy, ace_pw_dmabuf, ace_pw_holding, ace_pw_open, ace_pw_redeliver,
        ace_pw_shared_memory_only, ace_pw_step,
    },
    protocol::{Result, internal},
    writer::Publisher,
};
use media_codec::PixelFormat;
use std::{
    ffi::c_void,
    os::fd::{BorrowedFd, IntoRawFd, OwnedFd},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

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

/// The last still published, to send again when someone starts watching a still screen.
struct Published {
    /// The visible region of the buffer it was made of: a still of another is stale.
    region: Region,
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

/// When and under which epoch the held buffer arrived: a picture is stamped at capture, not
/// when it is encoded or sent.
#[derive(Clone, Copy, Default)]
struct Arrival {
    at: f64,
    us: u64,
    epoch: u32,
}

/// One buffer's pixels on the CPU, borrowed from the mapping or from a readback.
struct Pixels<'a> {
    bytes: &'a [u8],
    width: u32,
    height: u32,
    stride: usize,
    format: u32,
    crop: Option<(i32, i32, u32, u32)>,
}

struct Frames {
    publisher: Publisher,
    /// Stills' frame rate while nobody watches as video.
    fps: u32,
    logical_width: u32,
    next: Instant,
    previous: crate::frame_identity::FrameIdentity,
    rgb: Vec<u8>,
    failed: bool,
    /// The open stream, to offer the held buffer again.
    capture: *mut c_void,
    /// The newest buffer's size in stream points (width << 32 | height), for input bounds.
    shown: Arc<AtomicU64>,
    control: Arc<Control>,
    video: Video,
    /// The held buffer hasn't been published yet.
    fresh: bool,
    /// The next delivery is the held buffer offered again, not a new one.
    redelivering: bool,
    arrival: Arrival,
    last: Option<Published>,
    /// Video ran at the last step: leaving it publishes the current picture as a still at once,
    /// so a viewer on stills isn't left waiting for the desktop to change.
    was_video: bool,
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
        let logical_width = if self.logical_width == 0 {
            w
        } else {
            self.logical_width
        };
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

    /// Whether the C shell holds a buffer: it keeps the newest, so a keyframe, a still or
    /// someone starting to watch can encode the picture again without waiting for the desktop.
    /// PipeWire may remove it (a new format or new buffers); then nothing is held, and the
    /// picture it was is gone with it.
    fn holding(&self) -> bool {
        // SAFETY: the stream is open, on this thread (null before it opens).
        !self.capture.is_null() && unsafe { ace_pw_holding(self.capture) } != 0
    }

    fn watching(&self) -> bool {
        self.control.watching.load(Ordering::Acquire)
    }

    fn due(&self) -> bool {
        Instant::now() >= self.next
    }

    /// Converts, encodes and publishes one still. `force` publishes it even when its pixels
    /// are those already published (someone started watching again, or a still was asked for).
    fn publish(&mut self, buffer: &Pixels<'_>, at: f64, force: bool) -> Result<()> {
        let (w, h, stride, format) = (buffer.width, buffer.height, buffer.stride, buffer.format);
        let source = buffer.bytes;
        // What the picture shows is its visible region: a crop that moves over unchanged
        // pixels is a new picture, and a change outside it is none.
        let region = visible_region(w, h, buffer.crop);
        if !self.previous.update(source, stride, format, region) && !force {
            return Ok(());
        }
        let (left, top, rw, rh) = region;
        let ratio = (3840f64 / f64::from(rw))
            .min(2160f64 / f64::from(rh))
            .min(1.);
        let ow = (f64::from(rw) * ratio).floor().max(1.) as u32;
        let oh = (f64::from(rh) * ratio).floor().max(1.) as u32;
        self.rgb.resize(ow as usize * oh as usize * 3, 0);
        for y in 0..oh {
            for x in 0..ow {
                let from =
                    (top + y * rh / oh) as usize * stride + (left + x * rw / ow) as usize * 4;
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
            .encode(
                &self.rgb,
                ow as u16,
                oh as u16,
                jpeg_encoder::ColorType::Rgb,
            )
            .map_err(internal)?;
        let (logical_shown, _) = self.logical(w, rw, rh);
        let scale = f64::from(ow) / logical_shown;
        self.publisher
            .frame(jpeg.clone(), ow, oh, scale, at, self.generation())?;
        self.last = Some(Published {
            region,
            jpeg,
            width: ow,
            height: oh,
            scale,
            at,
        });
        Ok(())
    }

    /// A still of `raw`: its mapping, or one readback of a DMA-BUF. `false` when a DMA-BUF
    /// couldn't be read, and the stream should move to shared memory.
    fn still(&mut self, raw: &RawPicture, force: bool) -> Result<bool> {
        let at = self.arrival.at;
        if raw.dmabuf == 0 {
            // SAFETY: during the callback, for mapped memory.
            let Some(bytes) = (unsafe { raw.bytes() }) else {
                return Ok(true);
            };
            let pixels = Pixels {
                bytes,
                width: raw.width,
                height: raw.height,
                stride: raw.stride as usize,
                format: raw.format,
                crop: raw.crop(),
            };
            return self.publish(&pixels, at, force).map(|()| true);
        }
        let Some(captured) = captured(raw, 0) else {
            return Ok(false);
        };
        let Some((picture, cropped)) = self.video.read_back(&captured) else {
            return Ok(false);
        };
        let size = picture.size();
        let format = match picture.format() {
            PixelFormat::Bgra8 => SPA_BGRA,
            PixelFormat::Rgba8 => SPA_RGBA,
            _ => return Ok(false),
        };
        let plane = &picture.planes()[0];
        let pixels = Pixels {
            bytes: &plane.data,
            width: size.width,
            height: size.height,
            stride: plane.stride,
            format,
            crop: if cropped { None } else { raw.crop() },
        };
        self.publish(&pixels, at, force).map(|()| true)
    }

    /// One buffer from the desktop, or the held one offered again. Returns whether the C shell
    /// keeps holding it.
    fn picture(&mut self, raw: &RawPicture) -> Result<bool> {
        if !std::mem::take(&mut self.redelivering) {
            self.fresh = true;
            // The arrival's epoch is resolved once, against the epochs' application times on
            // the same clock, and kept through every redelivery of this buffer.
            let us = self.video.now_us();
            self.arrival = Arrival {
                at: unix_ms(),
                us,
                epoch: self.video.control.epoch_at(us),
            };
        }
        self.note_shown(raw.width, raw.height, raw.crop());
        // The window moved or resized inside its buffer: the cached still shows the old region.
        let region = visible_region(raw.width, raw.height, raw.crop());
        if self.last.as_ref().is_some_and(|last| last.region != region) {
            self.last = None;
        }
        let watching = self.watching();
        if let Some(settings) = self.video.active(watching) {
            let key = self.video.take_key();
            if (self.fresh && self.due()) || key {
                self.encode(raw, &settings, key);
                self.fresh = false;
                self.next = Instant::now()
                    + Duration::from_nanos(1_000_000_000 / u64::from(settings.fps.max(1)));
            }
            if self.video.control.take_still() && !self.still(raw, true)? {
                self.shared_memory();
            }
            self.video.drain();
            return Ok(true);
        }
        let refresh = self.control.refresh.swap(false, Ordering::AcqRel);
        let still = self.video.control.take_still();
        if watching && ((self.fresh && self.due()) || refresh || still) {
            if !self.still(raw, refresh || still)? {
                self.shared_memory();
                return Ok(false);
            }
            self.fresh = false;
            self.next =
                Instant::now() + Duration::from_nanos(1_000_000_000 / u64::from(self.fps.max(1)));
        }
        Ok(true)
    }

    fn encode(
        &mut self,
        raw: &RawPicture,
        settings: &crate::media::stream::StreamSettings,
        key: bool,
    ) {
        let pts = self.video.pts(self.arrival.us);
        let Some(captured) = captured(raw, pts) else {
            return;
        };
        // A DMA-BUF whose crop the encoder can't apply never reaches it: the stream moves to
        // shared memory, where only the region is copied out (`media::select::dmabuf_use`).
        if raw.dmabuf != 0
            && self.video.backend().is_none_or(|backend| {
                dmabuf_use(backend, (raw.width, raw.height), captured.region) != DmaBufUse::Encode
            })
        {
            self.shared_memory();
            return;
        }
        let (_, _, rw, rh) = captured.region;
        let size = encode_size(rw, rh, settings);
        let (logical_shown, _) = self.logical(raw.width, rw, rh);
        let stamp = Stamp {
            pts_us: pts,
            timestamp: self.arrival.at,
            scale: f64::from(size.width) / logical_shown,
            epoch: self.arrival.epoch,
        };
        if self.video.encode(&captured, settings, stamp, key).is_err() && raw.dmabuf != 0 {
            // A DMA-BUF this device couldn't take: the desktop sends shared memory instead.
            self.shared_memory();
        }
    }

    fn shared_memory(&mut self) {
        if !self.capture.is_null() {
            // SAFETY: the stream is open, on this thread.
            unsafe { ace_pw_shared_memory_only(self.capture) };
        }
    }

    /// After each loop step: hands on units that came back, and offers the held buffer again
    /// when it is due, a keyframe or still is owed, or someone starts watching.
    fn catch_up(&mut self) -> Result<()> {
        self.video.drain();
        if !self.holding() {
            // PipeWire took the held buffer back (renegotiation): its picture can't be sent.
            self.fresh = false;
        }
        let watching = self.watching();
        let video = self.video.active(watching).is_some();
        if std::mem::replace(&mut self.was_video, video) && !video && watching {
            self.control.refresh.store(true, Ordering::Release);
        }
        let owed = if self.video.active(watching).is_some() {
            (self.fresh && self.due())
                || self.video.control.key_owed()
                || self.video.control.still_owed()
        } else {
            watching
                && ((self.fresh && self.due())
                    || self.control.refresh.load(Ordering::Acquire)
                    || self.video.control.still_owed())
        };
        if owed && self.holding() && !self.capture.is_null() {
            self.redelivering = true;
            // SAFETY: the stream is open, on this thread; it calls `on_frame` synchronously.
            unsafe { ace_pw_redeliver(self.capture) };
            self.redelivering = false;
            return Ok(());
        }
        if !self.holding() && self.control.refresh.swap(false, Ordering::AcqRel) {
            if let Some(last) = &self.last {
                let generation = self.generation();
                return self.publisher.frame(
                    last.jpeg.clone(),
                    last.width,
                    last.height,
                    last.scale,
                    last.at,
                    generation,
                );
            }
        }
        Ok(())
    }

    fn wait(&self) -> i32 {
        let watching = self.watching();
        if self.video.active(watching).is_some() {
            let control = &self.video.control;
            if self.holding() && (control.key_owed() || control.still_owed()) {
                return 0;
            }
            if self.video.waiting() {
                return 5;
            }
            if !self.holding() || !self.fresh {
                return -1;
            }
            return self
                .next
                .saturating_duration_since(Instant::now())
                .as_millis()
                .min(1000) as i32;
        }
        let refresh =
            self.control.refresh.load(Ordering::Acquire) || self.video.control.still_owed();
        wait_ms(
            watching,
            self.holding() && self.fresh,
            refresh && (self.holding() || self.last.is_some()),
            self.next.saturating_duration_since(Instant::now()),
        )
    }
}

/// The callback's picture as the encoder takes it; `None` when it carries nothing readable.
fn captured(raw: &RawPicture, pts_us: u64) -> Option<Captured<'_>> {
    let input = if raw.dmabuf != 0 {
        if raw.fd < 0 || raw.stride <= 0 {
            return None;
        }
        // SAFETY: the fd is the buffer's, open for the callback that received `raw`.
        let fd = unsafe { BorrowedFd::borrow_raw(raw.fd) };
        Input::DmaBuf {
            fd,
            offset: raw.offset,
            stride: raw.stride as u32,
            modifier: raw.modifier,
        }
    } else {
        // SAFETY: during the callback, for mapped memory.
        let bytes = unsafe { raw.bytes() }?;
        Input::Shared {
            bytes,
            stride: raw.stride as usize,
        }
    };
    Some(Captured {
        input,
        format: raw.format,
        width: raw.width,
        height: raw.height,
        region: visible_region(raw.width, raw.height, raw.crop()),
        pts_us,
    })
}

unsafe extern "C" fn on_frame(user: *mut c_void, raw: *const RawPicture) -> i32 {
    // The C shell validates the buffer and calls synchronously on this thread.
    let frames = unsafe { &mut *user.cast::<Frames>() };
    if frames.failed || raw.is_null() {
        return 0;
    }
    let raw = unsafe { &*raw };
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| frames.picture(raw)));
    let keep = match result {
        Ok(Ok(keep)) => keep,
        _ => {
            frames.failed = true;
            false
        }
    };
    i32::from(keep)
}

/// Units into the capture's ingest route, in capture order; the sequence is shared with stills.
pub struct RouteSink {
    pub publisher: Publisher,
    pub ingest: crate::media::ingest::Ingest,
}

impl VideoSink for RouteSink {
    fn unit(&mut self, unit: media_ingest::VideoUnit) -> bool {
        self.ingest.unit(unit);
        true
    }
    fn next_sequence(&mut self) -> u64 {
        self.publisher.next_sequence()
    }
}

/// What a capture needs beyond the stream: where stills and video go, and the controls the
/// runtime holds.
pub struct Outputs {
    pub publisher: Publisher,
    pub shown: Arc<AtomicU64>,
    pub control: Arc<Control>,
    pub stream: Arc<StreamControl>,
    pub ingest: crate::media::ingest::Ingest,
    pub clock: crate::media::ingest::Clock,
    /// The encoder video opens, from the trials; `None` offers stills only.
    pub encoder: Option<(
        media_wire::capability::Backend,
        Option<media_chrome::ChromeOptions>,
    )>,
}

pub fn capture(
    fd: OwnedFd,
    node: u32,
    fps: u32,
    logical_width: u32,
    stop_fd: i32,
    stop: Arc<AtomicBool>,
    outputs: Outputs,
) -> Result<()> {
    let Outputs {
        publisher,
        shown,
        control,
        stream,
        ingest,
        clock,
        encoder,
    } = outputs;
    // Built here: the encoder lives on this thread (a GL context is current only on it).
    let sink = RouteSink {
        publisher: publisher.clone(),
        ingest,
    };
    let mut video = Video::new(stream, encoder, Box::new(sink), clock);
    // An encoder that imports DMA-BUFs opens now, on this thread, so the stream offers them.
    let dmabuf = video.open_for_dmabuf();
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
        video,
        fresh: false,
        redelivering: false,
        arrival: Arrival::default(),
        last: None,
        was_video: false,
    };
    let c = unsafe {
        ace_pw_open(
            fd.into_raw_fd(),
            node,
            stop_fd,
            i32::from(dmabuf),
            on_frame,
            (&mut frames as *mut Frames).cast(),
        )
    };
    if c.is_null() {
        frames.video.close();
        return Err(internal(
            "Cannot initialize PipeWire; install libpipewire-0.3 and check portal stream",
        ));
    }
    // Frames arrive only from `ace_pw_step` below, on this thread, after this is set.
    frames.capture = c;
    let mut reported_dmabuf = false;
    // Debug builds only: renegotiate buffers this often (ms), for tests of buffers removed while
    // one is held. Release builds never read it.
    let reallocate = cfg!(debug_assertions)
        .then(|| {
            std::env::var("ACE_SCREEN_TEST_REALLOCATE_MS")
                .ok()?
                .parse::<u64>()
                .ok()
        })
        .flatten()
        .map(Duration::from_millis);
    let mut reallocated = (Instant::now(), 0);
    let result = (|| {
        while !stop.load(Ordering::Acquire) {
            // Wakes for a buffer, the runtime's wake byte (watch, configure, stop), or the held
            // buffer coming due.
            if unsafe { ace_pw_step(c, frames.wait()) } < 0 || frames.failed {
                return Err(internal("PipeWire capture failed"));
            }
            // SAFETY: the stream is open, on this thread.
            let on_dmabuf = unsafe { ace_pw_dmabuf(c) } != 0;
            if on_dmabuf != reported_dmabuf {
                reported_dmabuf = on_dmabuf;
                eprintln!(
                    "capture: {}",
                    if on_dmabuf {
                        "DMA-BUF"
                    } else {
                        "shared memory"
                    }
                );
            }
            if let Some(every) = reallocate
                && frames.last.is_some()
                && reallocated.0.elapsed() >= every
            {
                reallocated = (Instant::now(), 1 - reallocated.1);
                // SAFETY: the stream is open, on this thread.
                unsafe { crate::pipewire_ffi::ace_pw_reallocate(c, reallocated.1) };
            }
            let caught =
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| frames.catch_up()));
            if !matches!(caught, Ok(Ok(()))) {
                return Err(internal("PipeWire capture failed"));
            }
        }
        Ok(())
    })();
    unsafe {
        ace_pw_destroy(c);
    }
    frames.video.close();
    result
}

/// The stream control the runtime keeps for `stream.configure`.
pub type Stream = Arc<StreamControl>;

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
        assert_eq!(
            visible_region(1280, 800, Some((0, 0, 410, 666))),
            (0, 0, 410, 666)
        );
        assert_eq!(
            visible_region(1280, 800, Some((25, 25, 360, 616))),
            (25, 25, 360, 616)
        );
    }

    #[test]
    fn a_buffer_without_a_usable_crop_is_shown_whole() {
        assert_eq!(visible_region(1280, 800, None), (0, 0, 1280, 800));
        assert_eq!(
            visible_region(1280, 800, Some((10, 10, 0, 40))),
            (0, 0, 1280, 800)
        );
        assert_eq!(
            visible_region(1280, 800, Some((1280, 0, 50, 50))),
            (0, 0, 1280, 800)
        );
    }

    #[test]
    fn a_crop_reaching_past_the_buffer_is_clamped_to_it() {
        assert_eq!(
            visible_region(800, 600, Some((-5, 500, 900, 300))),
            (0, 500, 800, 100)
        );
    }
}
