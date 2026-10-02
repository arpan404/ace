use super::{gpu::Gpu, pipe::Writer, target::Target};
use crate::{
    errors::{Code, Error, Result},
    stream::Stream,
};
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
    arrived: bool,
    closed: bool,
    stop: bool,
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
    ) -> Result<Self> {
        target.validate(&allowlist)?;
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
            let resources = initialize(&target, &worker_signal);
            match resources {
                Ok((gpu, item, pool, session, frame_token, closed_token, size)) => {
                    let _ = ready_tx.send(Ok(()));
                    let result = run(
                        &worker_signal,
                        &pool,
                        &target,
                        &allowlist,
                        gpu,
                        stream,
                        writer,
                        size,
                    );
                    let _ = pool.RemoveFrameArrived(frame_token);
                    let _ = item.RemoveClosed(closed_token);
                    let _ = session.Close();
                    let _ = pool.Close();
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
}
type Resources = (
    Gpu,
    GraphicsCaptureItem,
    Direct3D11CaptureFramePool,
    GraphicsCaptureSession,
    windows::Foundation::EventRegistrationToken,
    windows::Foundation::EventRegistrationToken,
    SizeInt32,
);
fn initialize(target: &Target, signal: &Arc<(Mutex<Signal>, Condvar)>) -> Result<Resources> {
    let gpu = Gpu::new()?;
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
    let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
        &gpu.winrt,
        DirectXPixelFormat::B8G8R8A8UIntNormalized,
        2,
        size,
    )?;
    let session = pool.CreateCaptureSession(&item)?;
    let arrival = signal.clone();
    let frame_token = pool.FrameArrived(&TypedEventHandler::new(move |_, _| {
        let (lock, wake) = &*arrival;
        lock.lock().unwrap_or_else(|e| e.into_inner()).arrived = true;
        wake.notify_one();
        Ok(())
    }))?;
    let closed = signal.clone();
    let closed_token = item.Closed(&TypedEventHandler::new(move |_, _| {
        let (lock, wake) = &*closed;
        lock.lock().unwrap_or_else(|e| e.into_inner()).closed = true;
        wake.notify_one();
        Ok(())
    }))?;
    session.StartCapture()?;
    Ok((gpu, item, pool, session, frame_token, closed_token, size))
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
fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
        * 1000.0
}
fn run(
    signal: &Arc<(Mutex<Signal>, Condvar)>,
    pool: &Direct3D11CaptureFramePool,
    target: &Target,
    allowlist: &[String],
    mut gpu: Gpu,
    stream: Arc<Mutex<Stream>>,
    writer: Writer,
    mut pool_size: SizeInt32,
) -> Result<()> {
    let start = Instant::now();
    let epoch = now_ms();
    let clock = || epoch + start.elapsed().as_secs_f64() * 1000.0;
    loop {
        let (lock, wake) = &**signal;
        let mut state = lock.lock().unwrap_or_else(|e| e.into_inner());
        while !state.arrived && !state.stop && !state.closed {
            state = wake.wait(state).unwrap_or_else(|e| e.into_inner());
        }
        if state.stop {
            return Ok(());
        }
        if state.closed {
            return Err(Error::new(Code::TargetGone, "Capture item closed"));
        }
        let delay = stream
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .due_in(clock());
        if delay > 0.0 {
            let (next, _) = wake
                .wait_timeout(state, Duration::from_secs_f64((delay / 1000.0).min(1.0)))
                .unwrap_or_else(|e| e.into_inner());
            drop(next);
            continue;
        }
        state.arrived = false;
        drop(state);
        target.validate(allowlist)?;
        let mut newest: Option<Direct3D11CaptureFrame> = None;
        for _ in 0..2 {
            match pool.TryGetNextFrame() {
                Ok(frame) => {
                    if let Some(old) = newest.replace(frame) {
                        let _ = old.Close();
                    }
                }
                Err(error) if error.code().0 as u32 == 0x80004003 => break,
                Err(error) => return Err(error.into()),
            }
        }
        let Some(frame) = newest else {
            continue;
        };
        let size = frame.ContentSize()?;
        if size.Width <= 0 || size.Height <= 0 {
            frame.Close()?;
            continue;
        }
        let access: IDirect3DDxgiInterfaceAccess = frame.Surface()?.cast()?;
        let texture: ID3D11Texture2D = unsafe { access.GetInterface()? };
        if size != pool_size {
            frame.Close()?;
            pool.Recreate(
                &gpu.winrt,
                DirectXPixelFormat::B8G8R8A8UIntNormalized,
                2,
                size,
            )?;
            pool_size = size;
            continue;
        }
        let output = crate::coordinates::output_size(size.Width as u32, size.Height as u32)?;
        let scale = if target.kind == "window" {
            let map = target.mapping()?;
            output.0 as f64 / map.target.w * map.dpi as f64 / 96.0
        } else {
            output.0 as f64 / size.Width as f64
        };
        let (rgb, width, height) = gpu.read(&texture, size.Width as u32, size.Height as u32)?;
        let packet = stream.lock().unwrap_or_else(|e| e.into_inner()).frame(
            rgb,
            width,
            height,
            scale,
            clock(),
        )?;
        frame.Close()?;
        if let Some(packet) = packet {
            writer.publish(packet);
        }
    }
}
