#[cfg(test)]
mod automation_tests;
mod capture;
mod gpu;
mod input;
mod pipe;
mod roles;
mod target;
mod uia;
use crate::{
    codec::Request,
    errors::{Code, Error, Result},
    stream::Stream,
    tree::Query,
};
use capture::Capture;
use pipe::Writer;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use target::Target;
use uia::Automation;
use windows::Win32::{System::WinRT::*, UI::HiDpi::*};
pub struct Host {
    capture: Option<Capture>,
    target: Option<Target>,
    allowed: Vec<String>,
    stream: Option<Arc<Mutex<Stream>>>,
    writer: Writer,
    automation: Automation,
    _apartment: Apartment,
}
impl Host {
    pub fn open(endpoint: &str) -> Result<Self> {
        unsafe {
            SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)?;
        }
        let apartment = Apartment::new()?;
        Ok(Self {
            capture: None,
            target: None,
            allowed: vec![],
            stream: None,
            writer: Writer::open(endpoint)?,
            automation: Automation::new()?,
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
            "hello" => {
                target::desktop_available()?;
                Ok(json!({"version":2,"platform":"windows",
                "capture":{"windows":true,"displays":true,"changeDriven":true},
                "input":{"pointer":true,"keyboard":true,"scroll":true,"text":true},
                "uiTree":true,"semanticActions":["press","focus","setValue","scroll","expand","select"],
                "codecs":["jpeg"],"permissions":{"screen":"n/a","input":"granted"}}))
            }
            "permissions" => {
                target::desktop_available()?;
                Ok(if request.version == 1 {
                    json!({"screenRecording":true,"accessibility":true})
                } else {
                    json!({"screen":"n/a","input":"granted"})
                })
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
                self.capture = Some(Capture::start(
                    target.clone(),
                    allowed.clone(),
                    stream.clone(),
                    self.writer.clone(),
                )?);
                self.target = Some(target);
                self.allowed = allowed;
                self.stream = Some(stream);
                self.automation.clear();
                Ok(Value::Null)
            }
            "stop" => {
                self.capture = None;
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
                    self.capture = Some(Capture::start(
                        target,
                        self.allowed.clone(),
                        stream,
                        self.writer.clone(),
                    )?);
                } else if !active {
                    self.capture = None;
                    self.writer.retire();
                }
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
impl Drop for Host {
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
