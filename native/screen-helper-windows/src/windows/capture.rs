use super::{
    gpu::Gpu,
    pipe::Writer,
    target::Target,
    video::{Captured, VideoEncoder},
};
use crate::{
    capture_wait::{Pending, Wait},
    errors::{Code, Error, Result},
    media::shell::IngestShell,
    stream::Stream,
};
use std::sync::atomic::{AtomicU32, Ordering};
use std::{
    sync::{Arc, Condvar, Mutex},
    thread::JoinHandle,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use windows::{
    core::Interface,
    Foundation::TypedEventHandler,
    Graphics::{Capture::*, DirectX::DirectXPixelFormat, SizeInt32},
    Win32::{
        Graphics::Direct3D11::ID3D11Texture2D,
        System::WinRT::{
            Direct3D11::IDirect3DDxgiInterfaceAccess,
            Graphics::Capture::IGraphicsCaptureItemInterop,
        },
    },
};
#[derive(Default)]
struct Signal {
    pending: Pending,
    closed: bool,
    stop: bool,
    /// Use the last picture again now (video starting, a keyframe or a still asked for, on a
    /// screen that may not change).
    refresh: bool,
    /// The privacy epoch held when the newest picture arrived.
    epoch: u32,
}
/// Live video's side of a capture: media-mf's device (absent where the start-up trial found
/// no H.264 MFT, which leaves the session on JPEG) and the route its units take.
pub struct Video {
    pub device: Option<media_mf::MfDevice>,
    pub shell: IngestShell,
}
pub struct Capture {
    signal: Arc<(Mutex<Signal>, Condvar)>,
    worker: Option<JoinHandle<()>>,
}
impl Capture {
    pub fn start(
        target: Target,
        allowlist: Vec<String>,
        stream: Arc<Mutex<Stream>>,
        writer: Writer,
        video: Video,
    ) -> Result<Self> {
        target.validate(&allowlist)?;
        let epoch = stream
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .epoch_handle();
        if !GraphicsCaptureSession::IsSupported()? {
            return Err(Error::new(Code::NotSupported, "WGC unavailable"));
        }
        let signal = Arc::new((Mutex::new(Signal::default()), Condvar::new()));
        let worker_signal = signal.clone();
        let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel(1);
        let worker = std::thread::spawn(move || {
            let initialized = unsafe {
                windows::Win32::System::WinRT::RoInitialize(
                    windows::Win32::System::WinRT::RO_INIT_MULTITHREADED,
                )
            };
            if let Err(error) = initialized {
                let _ = ready_tx.send(Err(error.into()));
                return;
            }
            let resources = initialize(&target, &worker_signal, video.device.as_ref(), epoch);
            match resources {
                Ok((gpu, item, mut feed, closed_token, epoch)) => {
                    let _ = ready_tx.send(Ok(()));
                    let result = run(
                        &worker_signal,
                        &epoch,
                        &mut feed,
                        &item,
                        &target,
                        &allowlist,
                        gpu,
                        stream,
                        writer,
                        video,
                    );
                    let _ = item.RemoveClosed(closed_token);
                    feed.close();
                    if let Err(error) = result {
                        eprintln!("screen capture: {error}");
                        std::process::exit(1);
                    }
                }
                Err(error) => {
                    let _ = ready_tx.send(Err(error));
                }
            }
            unsafe {
                windows::Win32::System::WinRT::RoUninitialize();
            }
        });
        match ready_rx.recv() {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                let _ = worker.join();
                return Err(error);
            }
            Err(_) => {
                let _ = worker.join();
                return Err(Error::new(Code::Internal, "Capture worker ended"));
            }
        }
        Ok(Self {
            signal,
            worker: Some(worker),
        })
    }
    /// Wakes capture to use its last picture again, for a screen that may not change.
    pub fn refresh(&self) {
        let (lock, wake) = &*self.signal;
        lock.lock().unwrap_or_else(|e| e.into_inner()).refresh = true;
        wake.notify_one();
    }
}
type Resources = (
    Gpu,
    GraphicsCaptureItem,
    Feed,
    windows::Foundation::EventRegistrationToken,
    Arc<AtomicU32>,
);
/// One frame pool at one size and the capture session filling it.
struct Feed {
    pool: Direct3D11CaptureFramePool,
    session: GraphicsCaptureSession,
    token: windows::Foundation::EventRegistrationToken,
    size: SizeInt32,
}
impl Feed {
    fn open(
        gpu: &Gpu,
        item: &GraphicsCaptureItem,
        signal: &Arc<(Mutex<Signal>, Condvar)>,
        size: SizeInt32,
        epoch: &Arc<AtomicU32>,
    ) -> Result<Self> {
        let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
            &gpu.winrt,
            DirectXPixelFormat::B8G8R8A8UIntNormalized,
            2,
            size,
        )?;
        let session = pool.CreateCaptureSession(item)?;
        let arrival = signal.clone();
        let epoch = epoch.clone();
        let token = pool.FrameArrived(&TypedEventHandler::new(move |_, _| {
            let (lock, wake) = &*arrival;
            let mut state = lock.lock().unwrap_or_else(|e| e.into_inner());
            state.pending.arrived();
            // Stamped at capture: the epoch when the picture arrived, not when it is encoded.
            state.epoch = epoch.load(Ordering::SeqCst);
            drop(state);
            wake.notify_one();
            Ok(())
        }))?;
        session.StartCapture()?;
        Ok(Self {
            pool,
            session,
            token,
            size,
        })
    }
    fn close(&self) {
        let _ = self.pool.RemoveFrameArrived(self.token);
        let _ = self.session.Close();
        let _ = self.pool.Close();
    }
}
fn initialize(
    target: &Target,
    signal: &Arc<(Mutex<Signal>, Condvar)>,
    device: Option<&media_mf::MfDevice>,
    epoch: Arc<AtomicU32>,
) -> Result<Resources> {
    let gpu = match device {
        Some(device) => Gpu::shared(device)?,
        None => Gpu::new()?,
    };
    let interop: IGraphicsCaptureItemInterop =
        windows::core::factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()?;
    let item: GraphicsCaptureItem = unsafe {
        if target.kind == "window" {
            interop.CreateForWindow(target.window()?)?
        } else {
            interop.CreateForMonitor(target.monitor()?)?
        }
    };
    let size = item.Size()?;
    crate::coordinates::output_size(size.Width as u32, size.Height as u32)?;
    let closed = signal.clone();
    let closed_token = item.Closed(&TypedEventHandler::new(move |_, _| {
        let (lock, wake) = &*closed;
        lock.lock().unwrap_or_else(|e| e.into_inner()).closed = true;
        wake.notify_one();
        Ok(())
    }))?;
    let feed = match Feed::open(&gpu, &item, signal, size, &epoch) {
        Ok(feed) => feed,
        Err(error) => {
            let _ = item.RemoveClosed(closed_token);
            return Err(error);
        }
    };
    Ok((gpu, item, feed, closed_token, epoch))
}
impl Drop for Capture {
    fn drop(&mut self) {
        let (lock, wake) = &*self.signal;
        lock.lock().unwrap_or_else(|e| e.into_inner()).stop = true;
        wake.notify_one();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
/// The performance counter in 100 ns units, the clock of a frame's SystemRelativeTime.
fn counter_100ns() -> Option<i64> {
    use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};
    let (mut count, mut frequency) = (0i64, 0i64);
    unsafe {
        QueryPerformanceCounter(&mut count).ok()?;
        QueryPerformanceFrequency(&mut frequency).ok()?;
    }
    (frequency > 0).then(|| (i128::from(count) * 10_000_000 / i128::from(frequency)) as i64)
}
fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
        * 1000.0
}
/// The picture kept from the last frame, for a refresh on a screen that hasn't changed.
struct Kept {
    texture: ID3D11Texture2D,
    size: (u32, u32),
    scale_per_pixel: f64,
    captured: f64,
    epoch: u32,
}
#[allow(clippy::too_many_arguments)]
fn run(
    signal: &Arc<(Mutex<Signal>, Condvar)>,
    epoch: &Arc<AtomicU32>,
    feed: &mut Feed,
    item: &GraphicsCaptureItem,
    target: &Target,
    allowlist: &[String],
    mut gpu: Gpu,
    stream: Arc<Mutex<Stream>>,
    writer: Writer,
    video: Video,
) -> Result<()> {
    let start = Instant::now();
    let unix = now_ms();
    let clock = || unix + start.elapsed().as_secs_f64() * 1000.0;
    let mut last_captured = 0.0;
    let mut encoder: Option<VideoEncoder> = None;
    let mut kept: Option<Kept> = None;
    let mut logged = false;
    let lock_stream = || stream.lock().unwrap_or_else(|e| e.into_inner());
    loop {
        let (lock, wake) = &**signal;
        let mut state = lock.lock().unwrap_or_else(|e| e.into_inner());
        let refresh = loop {
            if state.stop {
                return Ok(());
            }
            if state.closed {
                return Err(Error::new(Code::TargetGone, "Capture item closed"));
            }
            if std::mem::take(&mut state.refresh) {
                break true;
            }
            let delay = lock_stream().due_in(clock());
            match state.pending.next(delay) {
                Wait::Idle => {
                    state = wake.wait(state).unwrap_or_else(|e| e.into_inner());
                }
                Wait::After(delay) => {
                    let (next, _) = wake
                        .wait_timeout(state, Duration::from_secs_f64((delay / 1000.0).min(1.0)))
                        .unwrap_or_else(|e| e.into_inner());
                    state = next;
                }
                Wait::Frame => break false,
            }
        };
        let arrived_epoch = state.epoch;
        drop(state);
        target.validate(allowlist)?;
        let mut newest: Option<Direct3D11CaptureFrame> = None;
        // TryGetNextFrame returns null when the pool is empty:
        // https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.direct3d11captureframepool.trygetnextframe
        // The windows-rs 0.58 projection surfaces S_OK/null as Err with code S_OK (0)
        // via Type::from_abi -> Error::empty(); E_POINTER is also tolerated below.
        // This empty-pool recognition applies only to this dequeue loop.
        for _ in 0..2 {
            match feed.pool.TryGetNextFrame() {
                Ok(frame) => {
                    if let Some(old) = newest.replace(frame) {
                        let _ = old.Close();
                    }
                }
                Err(error) if error.code().0 == 0 || error.code().0 as u32 == 0x80004003 => break,
                Err(error) => return Err(error.into()),
            }
        }
        if let Some(frame) = newest {
            let size = frame.ContentSize()?;
            if size.Width <= 0 || size.Height <= 0 {
                frame.Close()?;
                continue;
            }
            if size != feed.size {
                frame.Close()?;
                // A new pool at the new size, with a new session: recreating the pool in place
                // drops the frames it queued, and capture only sends another frame when the
                // window changes again, so a window that finished repainting first would keep
                // its old size in live view. A new session always sends a first frame.
                feed.close();
                *feed = Feed::open(&gpu, item, signal, size, epoch)?;
                continue;
            }
            let surface = frame
                .Surface()
                .map_err(|e| Error::from(e).context("frame-surface"))?;
            let access: IDirect3DDxgiInterfaceAccess = surface
                .cast()
                .map_err(|e| Error::from(e).context("surface-cast-access"))?;
            let texture: ID3D11Texture2D = unsafe {
                access
                    .GetInterface()
                    .map_err(|e| Error::from(e).context("surface-getinterface-texture2d"))?
            };
            let captured_100ns = frame.SystemRelativeTime().map(|time| time.Duration).ok();
            // A GPU copy into the ring: the frame goes back to capture at once.
            let copy = gpu.keep(&texture)?;
            frame.Close()?;
            let now = clock();
            // The header's ts is when the picture was taken, not when it was read.
            let captured = match (captured_100ns, counter_100ns()) {
                (Some(frame_time), Some(counter)) => {
                    crate::stream::captured_at(now, counter, frame_time, last_captured)
                }
                _ => now,
            };
            let (width, height) = (size.Width as u32, size.Height as u32);
            let scale_per_pixel = if target.kind == "window" {
                let map = target.mapping()?;
                map.dpi as f64 / 96.0 / map.target.w
            } else {
                1.0 / width as f64
            };
            kept = Some(Kept {
                texture: copy,
                size: (width, height),
                scale_per_pixel,
                captured,
                epoch: arrived_epoch,
            });
        } else if !refresh {
            continue;
        }
        let Some(picture) = kept.as_ref() else {
            continue;
        };
        let now = clock();
        let (settings, due, image) = {
            let mut stream = lock_stream();
            let settings = stream.video().filter(|_| video.device.is_some());
            let due = settings.is_some() && (refresh || stream.video_due(now));
            (settings, due, stream.take_image())
        };
        if let (Some(settings), true) = (settings, due) {
            encode(
                &mut encoder,
                &mut logged,
                &video,
                &stream,
                picture,
                settings,
                now,
            )?;
        }
        if settings.is_none() || image {
            still(
                &mut gpu,
                &stream,
                &writer,
                &video.shell,
                picture,
                now,
                image,
            )?;
            if settings.is_none() {
                last_captured = picture.captured;
            }
        } else {
            last_captured = picture.captured;
        }
    }
}

/// Encodes the kept picture and routes its units. An encoder that fails is replaced on the
/// next picture; the session keeps going.
fn encode(
    encoder: &mut Option<VideoEncoder>,
    logged: &mut bool,
    video: &Video,
    stream: &Arc<Mutex<Stream>>,
    picture: &Kept,
    settings: crate::media::config::StreamSettings,
    now: f64,
) -> Result<()> {
    let Some(device) = &video.device else {
        return Ok(());
    };
    if encoder.is_none() {
        match VideoEncoder::new(device.clone()) {
            Ok(created) => *encoder = Some(created),
            Err(error) => {
                eprintln!("screen video: {error}");
                return Ok(());
            }
        }
    }
    let Some(active) = encoder.as_mut() else {
        return Ok(());
    };
    let force = stream
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take_keyframe();
    let (width, _) =
        crate::media::config::encode_size(picture.size, (settings.max_width, settings.max_height));
    let age_us = ((now - picture.captured).max(0.0) * 1000.0) as u64;
    let captured = Captured {
        captured_us: video.shell.now_us().saturating_sub(age_us),
        timestamp_ms: picture.captured,
        scale: picture.scale_per_pixel * width as f64,
        epoch: picture.epoch,
    };
    let raw = windows::core::Interface::as_raw(&picture.texture);
    match unsafe { active.encode(raw, picture.size, settings, captured, force) } {
        Ok(units) => {
            if !units.is_empty() && !*logged {
                *logged = true;
                let copies = active.last_copies();
                eprintln!(
                    "screen video: {} MFT, {} staging readback(s) and {} upload(s) per frame",
                    if active.hardware() {
                        "hardware"
                    } else {
                        "software"
                    },
                    copies.readbacks,
                    copies.uploads
                );
            }
            for mut unit in units {
                unit.sequence = stream
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .next_sequence();
                video.shell.publish(&unit);
            }
        }
        Err(error) => {
            eprintln!("screen video: {error}");
            *encoder = None;
            *logged = false;
            stream
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .request_keyframe();
        }
    }
    Ok(())
}

/// A JPEG still of the kept picture on the daemon's pipe: every changed picture while no
/// viewer watches as video, one on request while one does.
fn still(
    gpu: &mut Gpu,
    stream: &Arc<Mutex<Stream>>,
    writer: &Writer,
    shell: &IngestShell,
    picture: &Kept,
    now: f64,
    forced: bool,
) -> Result<()> {
    let (rgb, width, height) = gpu.read(&picture.texture, picture.size.0, picture.size.1)?;
    let scale = picture.scale_per_pixel * width as f64;
    let (packet, sequence, generation) = {
        let mut stream = stream.lock().unwrap_or_else(|e| e.into_inner());
        if forced {
            stream.refresh();
        }
        let sequence = stream.sequence();
        let packet = stream.frame_at(rgb, width, height, scale, now, picture.captured)?;
        (packet, sequence, stream.capture_generation())
    };
    if let Some(packet) = packet {
        shell.legacy_still(sequence, || writer.publish(generation, packet));
    }
    Ok(())
}
