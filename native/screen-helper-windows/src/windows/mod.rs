#[cfg(test)]
mod automation_tests;
mod capture;
mod gpu;
mod gpu_readback;
mod ingest_pipe;
mod input;
mod pipe;
mod roles;
mod target;
pub mod trial;
mod uia;
mod video;
use crate::{
    codec::Request,
    errors::{Code, Error, Result},
    mailbox::Queued,
    media::{
        capability::Trial,
        config::StreamCodec,
        shell::{IngestShell, Sinks},
    },
    stream::Stream,
    tree::Query,
};
use capture::{Capture, Video};
use pipe::Writer;
use serde_json::Value;
use std::sync::{Arc, Mutex};
use target::Target;
use uia::Automation;
use windows::Win32::{System::WinRT::*, UI::HiDpi::*};
pub struct Host {
    startup: crate::inspection::Startup<Box<DesktopHost>>,
}
impl Host {
    /// `trial` runs only when the desktop is available: it is what the hello reports.
    pub fn open(endpoint: &str, trial: impl FnOnce() -> Trial) -> Result<Self> {
        Ok(Self {
            startup: crate::inspection::Startup::open(target::desktop_available(), || {
                DesktopHost::open(endpoint, trial()).map(Box::new)
            })?,
        })
    }
    pub fn command(&mut self, request: &Request) -> Result<Value> {
        match &mut self.startup {
            crate::inspection::Startup::Desktop(host) => host.command(request),
            crate::inspection::Startup::Inspection(host) => host.command(request),
        }
    }
}
struct DesktopHost {
    capture: Option<Capture>,
    target: Option<Target>,
    allowed: Vec<String>,
    stream: Option<Arc<Mutex<Stream>>>,
    /// The session's video route: the daemon's pipe or ace-media's ingest.
    shell: Option<IngestShell>,
    trial: Trial,
    writer: Writer,
    automation: Automation,
    _apartment: Apartment,
}
impl DesktopHost {
    pub fn open(endpoint: &str, trial: Trial) -> Result<Self> {
        eprintln!("{}", trial.summary());
        unsafe {
            SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)
                .map_err(|error| Error::from(error).context("SetProcessDpiAwarenessContext"))?;
        }
        let apartment = Apartment::new().map_err(|error| error.context("RoInitialize"))?;
        Ok(Self {
            capture: None,
            target: None,
            allowed: vec![],
            stream: None,
            shell: None,
            trial,
            writer: Writer::open(endpoint).map_err(|error| error.context("Create frame pipe"))?,
            automation: Automation::new()
                .map_err(|error| error.context("UI Automation initialization"))?,
            _apartment: apartment,
        })
    }
    fn target(&self) -> Result<&Target> {
        let target = self
            .target
            .as_ref()
            .ok_or_else(|| Error::new(Code::TargetGone, "No active target"))?;
        target.validate(&self.allowed)?;
        Ok(target)
    }
    pub fn command(&mut self, request: &Request) -> Result<Value> {
        match request.op.as_str() {
            "hello" => Ok(crate::inspection::capabilities_with(&self.trial)),
            "permissions" | "permissions.request" => {
                Ok(crate::inspection::permissions(target::desktop_available()))
            }
            "targets" => target::inventory(),
            "start" => {
                let target: Target = request.get("target")?;
                let allowed: Vec<String> = request.get("allowlist")?;
                let fps: u32 = request.get("fps")?;
                let session: String = request.get("sessionId")?;
                if allowed.len() > 64
                    || allowed.iter().any(|s| s.encode_utf16().count() > 256)
                    || !(1..=30).contains(&fps)
                    || session.is_empty()
                    || session.len() > 64
                    || !session
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
                {
                    return Err(Error::new(Code::Bounds, "Invalid start limits"));
                }
                target.validate(&allowed)?;
                if self.target.is_some() {
                    return Err(Error::new(Code::Busy, "One active target per host"));
                }
                let generation = capture_generation(request)?;
                let mut state = Stream::new(session, request.version, fps);
                state.generation(generation);
                let stream = Arc::new(Mutex::new(state));
                self.writer.activate(generation);
                let shell = self.ingest_shell(&stream);
                self.capture = Some(Capture::start(
                    target.clone(),
                    allowed.clone(),
                    stream.clone(),
                    self.writer.clone(),
                    self.video(&shell),
                )?);
                self.target = Some(target);
                self.allowed = allowed;
                self.stream = Some(stream);
                self.shell = Some(shell);
                self.automation.clear();
                Ok(Value::Null)
            }
            "stop" => {
                self.capture = None;
                if let Some(shell) = self.shell.take() {
                    shell.close();
                }
                self.writer.retire();
                self.target = None;
                self.stream = None;
                self.allowed.clear();
                self.automation.clear();
                Ok(Value::Null)
            }
            "watch" => {
                let active: bool = request.get("active")?;
                if active && self.capture.is_none() {
                    let target = self.target()?.clone();
                    let stream = self
                        .stream
                        .as_ref()
                        .ok_or_else(|| Error::new(Code::Internal, "Missing stream"))?
                        .clone();
                    let generation = capture_generation(request)?;
                    stream
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .generation(generation);
                    self.writer.activate(generation);
                    let shell = self
                        .shell
                        .clone()
                        .ok_or_else(|| Error::new(Code::Internal, "Missing video route"))?;
                    self.capture = Some(Capture::start(
                        target,
                        self.allowed.clone(),
                        stream,
                        self.writer.clone(),
                        self.video(&shell),
                    )?);
                } else if !active {
                    self.capture = None;
                    self.writer.retire();
                }
                Ok(Value::Null)
            }
            "stream.configure" => self.configure_stream(request),
            "stream.keyframe" => {
                self.live_stream()?
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .request_keyframe();
                self.refresh();
                Ok(Value::Null)
            }
            "stream.image" => {
                self.live_stream()?
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .request_image();
                self.refresh();
                Ok(Value::Null)
            }
            "ui.tree" => {
                let target = self.target()?.clone();
                self.check_requested_target(request, &target)?;
                serde_json::to_value(self.automation.tree(
                    &target,
                    request.get("maxDepth")?,
                    request.get("maxNodes")?,
                )?)
                .map_err(|e| Error::new(Code::Internal, e.to_string()))
            }
            "ui.find" => {
                let target = self.target()?.clone();
                let query: Query = request.get("query")?;
                self.automation.find(&target, &query, request.get("limit")?)
            }
            "ui.act" => {
                let target = self.target()?.clone();
                target.check_integrity()?;
                let reference: String = request.get("ref")?;
                let action: String = request.get("action")?;
                self.automation
                    .act(&target, &reference, &action, request.fields.get("value"))
            }
            "action" => {
                input::inject(self.target()?, &request.get("action")?)?;
                Ok(Value::Null)
            }
            "pointer.move" | "pointer.click" | "pointer.drag" | "key.press" | "text.type"
            | "scroll" => {
                let mut fields = request.fields.clone();
                fields.insert("kind".into(), Value::String(request.op.clone()));
                let action = serde_json::from_value(Value::Object(fields))
                    .map_err(|e| Error::new(Code::Bounds, e.to_string()))?;
                input::inject(self.target()?, &action)?;
                Ok(Value::Null)
            }
            "open.url" | "menu.press" => Err(Error::new(
                Code::NotSupported,
                "Background app operations are unavailable on Windows",
            )
            .phase("rejected-before-dispatch")),
            _ => Err(Error::new(Code::NotSupported, "Unknown command")),
        }
    }
    fn live_stream(&self) -> Result<Arc<Mutex<Stream>>> {
        self.stream
            .clone()
            .ok_or_else(|| Error::new(Code::TargetGone, "No active stream"))
    }
    fn refresh(&self) {
        if let Some(capture) = &self.capture {
            capture.refresh();
        }
    }
    /// media-mf's device for a capture, where the start-up trial found an H.264 MFT.
    fn video(&self, shell: &IngestShell) -> Video {
        let device = self
            .trial
            .h264()
            .then(media_mf::MfDevice::new)
            .and_then(|device| {
                device
                    .map_err(|error| eprintln!("screen video: D3D11 device: {error}"))
                    .ok()
            });
        Video {
            device,
            shell: shell.clone(),
        }
    }
    /// The session's route. Units on the daemon's path become frame packets there; a cut
    /// ingest connection is told to the daemon as a `stream.ingest` event.
    fn ingest_shell(&self, stream: &Arc<Mutex<Stream>>) -> IngestShell {
        let (legacy_stream, keyframe_stream, writer) =
            (stream.clone(), stream.clone(), self.writer.clone());
        let closed_stream = stream.clone();
        let session = stream
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .session_id()
            .to_string();
        let start = std::time::Instant::now();
        IngestShell::new(
            Box::new(|socket, server| ingest_pipe::dial(socket, server)),
            Sinks {
                legacy: Box::new(move |unit| {
                    let (packet, generation) = {
                        let stream = legacy_stream.lock().unwrap_or_else(|e| e.into_inner());
                        (stream.video_packet(unit), stream.capture_generation())
                    };
                    let Ok(packet) = packet else { return };
                    if writer.publish_video(generation, packet, unit.key) == Queued::WantKeyframe {
                        legacy_stream
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .request_keyframe();
                    }
                }),
                closed: Box::new(move |boundary| {
                    // Back on the daemon's pipe after a cut: that path starts at a keyframe.
                    closed_stream
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .request_keyframe();
                    crate::codec::event(&serde_json::json!({"event":"stream.ingest",
                        "sessionId":session,"state":"closed","boundary":boundary}));
                }),
                keyframe: Box::new(move || {
                    keyframe_stream
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .request_keyframe();
                }),
            },
            Box::new(move || start.elapsed().as_micros() as u64),
        )
    }
    /// `stream.configure`: H.264 only where the trial found an encoder, JPEG otherwise; video
    /// to the ingest pipe it names, or to the daemon's pipe.
    fn configure_stream(&mut self, request: &Request) -> Result<Value> {
        let configure = crate::media::config::parse(request)?;
        let stream = self.live_stream()?;
        let mut settings = configure.settings;
        if settings.codec == StreamCodec::H264 && !self.trial.h264() {
            settings.codec = StreamCodec::Jpeg;
        }
        stream
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            // Applied now on the capture clock: pictures captured before keep the old epoch.
            .configure(
                settings,
                configure.epoch,
                capture::counter_100ns().unwrap_or(0),
            );
        let shell = self
            .shell
            .clone()
            .ok_or_else(|| Error::new(Code::TargetGone, "No active stream"))?;
        let routed = shell.configure(configure.ingest).map_err(|error| {
            Error::new(
                Code::TargetGone,
                format!("Cannot connect to ace-media's ingest: {error}"),
            )
        })?;
        if routed.switched {
            // Each path starts at a keyframe, as on the Mac: a viewer never waits for one.
            stream
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .request_keyframe();
        }
        self.refresh();
        Ok(serde_json::json!({
            "codec": if settings.codec == StreamCodec::H264 { "h264" } else { "jpeg" },
            "ingest": if routed.ingesting { "on" } else { "off" },
            "switched": routed.switched,
            "boundary": routed.boundary,
        }))
    }
    fn check_requested_target(&self, request: &Request, active: &Target) -> Result<()> {
        let requested: Target = request.get("target")?;
        if requested.window_id != active.window_id
            || requested.kind != active.kind
            || requested.bundle_id != active.bundle_id
        {
            return Err(Error::new(
                Code::TargetGone,
                "Tree target differs from approved capture",
            ));
        }
        Ok(())
    }
}
impl Drop for DesktopHost {
    fn drop(&mut self) {
        self.capture = None;
    }
}
// Declared last in Host so all COM objects are released before apartment teardown.
struct Apartment;
impl Apartment {
    fn new() -> Result<Self> {
        unsafe {
            RoInitialize(RO_INIT_MULTITHREADED)?;
        }
        Ok(Self)
    }
}
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe {
            RoUninitialize();
        }
    }
}

fn capture_generation(request: &Request) -> Result<u64> {
    let generation = if request.fields.contains_key("captureGeneration") {
        request.get::<u64>("captureGeneration")?
    } else {
        1
    };
    if generation == 0 || generation > 9_007_199_254_740_991 {
        return Err(Error::new(Code::Bounds, "Invalid capture generation"));
    }
    Ok(generation)
}
