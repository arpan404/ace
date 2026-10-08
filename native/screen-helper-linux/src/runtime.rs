use crate::{
    accessibility::Accessibility,
    policy::{Backend, backend},
    portal::Portal,
    protocol::{Fault, Request, Result, internal, reply, valid_id},
    writer::Writer,
    x11::{Window, X11},
};
use serde_json::{Value, json};
use std::{
    io::Write,
    os::fd::{AsRawFd, OwnedFd},
    os::unix::net::UnixStream,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread::JoinHandle,
};
use tokio::io::{AsyncBufReadExt, BufReader};

pub(crate) struct Capture {
    stop: Arc<AtomicBool>,
    wake: UnixStream,
    worker: Option<JoinHandle<()>>,
}
impl Drop for Capture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        let _ = self.wake.write_all(&[1]);
        if let Some(w) = self.worker.take() {
            let _ = w.join();
        }
    }
}
pub(crate) struct Runtime {
    pub(crate) x: Option<X11>,
    pub(crate) portal: Option<Portal>,
    pub(crate) ui: Option<Accessibility>,
    pub(crate) window: Option<Window>,
    pub(crate) ui_active: bool,
    pub(crate) view_only: bool,
    target: Option<crate::protocol::Target>,
    pub(crate) capture: Option<Capture>,
    pub(crate) writer: Writer,
}
impl Runtime {
    fn capabilities(&self) -> Value {
        if let Some(portal) = &self.portal {
            return portal.capabilities(self.ui.is_some());
        }
        let ui = self.ui.is_some();
        json!({"version":2,"platform":"linux-x11","capture":{"windows":true,"displays":false,"changeDriven":true},"input":{"pointer":true,"keyboard":true,"scroll":true,"text":ui},"uiTree":ui,"semanticActions":if ui {vec!["press","focus","setValue","scroll","expand","select"]} else {vec![]},"codecs":["jpeg"],"permissions":{"screen":"granted","input":"granted"}})
    }
    async fn stop(&mut self) -> Result<Value> {
        self.capture.take();
        self.window = None;
        self.target = None;
        self.ui_active = false;
        self.view_only = false;
        if let Some(ui) = &mut self.ui {
            ui.clear();
        }
        if let Some(p) = &mut self.portal {
            p.stop().await?;
        }
        Ok(json!({}))
    }
    async fn start(&mut self, r: &Request) -> Result<Value> {
        if self.capture.is_some() {
            return Err(Fault::new("busy", "Only one capture session can be active"));
        }
        let target = r
            .target
            .as_ref()
            .ok_or_else(|| Fault::new("bounds", "Missing target"))?;
        let session = r
            .session_id
            .clone()
            .filter(|s| valid_id(s))
            .ok_or_else(|| Fault::new("bounds", "Invalid session id"))?;
        let fps = r.fps.unwrap_or(10);
        let (read, wake) = UnixStream::pair().map_err(internal)?;
        let stop = Arc::new(AtomicBool::new(false));
        let cancelled = stop.clone();
        let socket = self.writer.abort_socket()?;
        let worker = if let Some(x) = &self.x {
            let window = x.target(target, &r.allowlist)?;
            // Focus remains an asynchronous WM decision; each input verifies the active window.
            x.focus(&window)?;
            if let Some(ui) = &mut self.ui {
                match ui.scope(window.pid, &window.bounds).await {
                    Ok(()) => self.ui_active = true,
                    Err(e) => eprintln!("AT-SPI target: {e}"),
                }
            }
            let publisher = self.writer.publisher(session);
            self.window = Some(window.clone());
            std::thread::spawn(move || {
                let _read = read;
                if let Err(e) = crate::x11_capture::capture(
                    window,
                    fps,
                    cancelled,
                    _read.as_raw_fd(),
                    |jpeg, w, h, scale| publisher.frame(jpeg, w, h, scale),
                ) {
                    eprintln!("capture: {e}");
                    let _ = socket.shutdown(std::net::Shutdown::Both);
                }
            })
        } else {
            let p = self.portal.as_mut().ok_or_else(|| internal("No backend"))?;
            if target.kind != "window" && target.kind != "display" {
                return Err(Fault::new(
                    "not_supported",
                    "Wayland target must be window or display; chooser selects actual source",
                ));
            }
            // Portal chooser is the only trustworthy source identity. Do not claim supplied ids are enforced.
            if target.kind == "window"
                && !target
                    .bundle_id
                    .as_ref()
                    .is_some_and(|id| r.allowlist.contains(id))
            {
                return Err(Fault::new(
                    "permission_denied",
                    "Application approval required before portal consent",
                ));
            }
            let fd: OwnedFd = p.start(target.kind == "window").await?;
            self.view_only = target.kind == "display";
            if !self.view_only {
                if let (Some(ui), Some(identity)) = (&mut self.ui, &target.bundle_id) {
                    match ui.scope_application(identity).await {
                        Ok(()) => self.ui_active = true,
                        Err(e) => eprintln!("AT-SPI target: {e}"),
                    }
                }
            }
            let publisher = self.writer.publisher(session);
            let node = p.node;
            let logical_width = p.size.0;
            std::thread::spawn(move || {
                let _read = read;
                if let Err(e) = crate::pipewire::capture(
                    fd,
                    node,
                    fps,
                    logical_width,
                    _read.as_raw_fd(),
                    cancelled,
                    publisher,
                ) {
                    eprintln!("capture: {e}");
                    let _ = socket.shutdown(std::net::Shutdown::Both);
                }
            })
        };
        self.target = Some(target.clone());
        self.capture = Some(Capture {
            stop,
            wake,
            worker: Some(worker),
        });
        Ok(json!({"capabilities":self.capabilities()}))
    }
    async fn command(&mut self, r: &Request) -> Result<Value> {
        match r.op.as_str() {
            "hello" => Ok(self.capabilities()),
            "permissions" => Ok(
                json!({"screenRecording":self.x.is_some() || self.portal.is_some(),"accessibility":self.x.is_some() || self.portal.as_ref().is_some_and(|p|p.session.is_some())}),
            ),
            "targets" => {
                if let Some(x) = &self.x {
                    x.inventory()
                } else {
                    Ok(json!({"windows":[],"displays":[],"chooserRequired":true}))
                }
            }
            "start" => self.start(r).await,
            "stop" => self.stop().await,
            "ui.tree" => {
                crate::policy::scoped_target(r.target.as_ref(), self.target.as_ref())?;
                self.check_ui()?;
                self.ui
                    .as_mut()
                    .ok_or_else(|| Fault::new("not_supported", "AT-SPI bus unavailable"))?
                    .tree(r.max_depth.unwrap_or(8), r.max_nodes.unwrap_or(128))
                    .await
            }
            "ui.find" => {
                self.check_ui()?;
                self.ui
                    .as_mut()
                    .ok_or_else(|| Fault::new("not_supported", "AT-SPI bus unavailable"))?
                    .find(
                        r.query
                            .as_ref()
                            .ok_or_else(|| Fault::new("bounds", "Missing query"))?,
                        r.limit.unwrap_or(32),
                    )
                    .await
            }
            "ui.act" => {
                self.check_input()?;
                self.check_ui()?;
                let action = r
                    .action
                    .as_ref()
                    .and_then(Value::as_str)
                    .ok_or_else(|| Fault::new("bounds", "Missing action"))?;
                let bounds = self
                    .ui
                    .as_mut()
                    .ok_or_else(|| Fault::new("not_supported", "AT-SPI unavailable"))?
                    .act(
                        r.reference
                            .as_deref()
                            .ok_or_else(|| Fault::new("bounds", "Missing ref"))?,
                        action,
                        r.value.as_deref(),
                    )
                    .await?;
                if let Some(b) = bounds {
                    let w = self
                        .window
                        .as_ref()
                        .ok_or_else(|| Fault::new("not_supported", "No safe fallback target"))?;
                    let live = self
                        .x
                        .as_ref()
                        .ok_or_else(|| internal("No X11 target"))?
                        .check(w)?;
                    let (x, y) = crate::policy::element_center(&b, &live.bounds)?;
                    self.click(x, y, "left").await?;
                    Ok(json!({"fallback":true,"method":"pointer.click"}))
                } else {
                    Ok(json!({"fallback":false,"method":"atspi"}))
                }
            }
            "action" => self.legacy(r).await,
            "pointer.move" | "pointer.click" | "pointer.drag" | "key.press" | "text.type"
            | "scroll" => self.input(r).await,
            "open.url" | "menu.press" => Err(Fault::new(
                "not_supported",
                "Background app operations are unavailable on Linux",
            )
            .phase("rejected-before-dispatch")),
            _ => Err(Fault::new("not_supported", "Unknown command")),
        }
    }
    pub(crate) fn check_input(&self) -> Result<()> {
        if self.capture.is_none() {
            return Err(Fault::new("target_gone", "No capture session"));
        }
        if self.view_only {
            return Err(Fault::new(
                "permission_denied",
                "Display capture is view-only",
            ));
        }
        if let (Some(x), Some(w)) = (&self.x, &self.window) {
            x.check(w)?;
        }
        Ok(())
    }
    pub(crate) fn check_ui(&self) -> Result<()> {
        if !self.ui_active {
            return Err(Fault::new(
                "not_supported",
                "No unambiguous approved accessibility target",
            ));
        }
        if let (Some(x), Some(w)) = (&self.x, &self.window) {
            let live = x.window(w.id)?;
            if live.pid != w.pid || live.identity != w.identity {
                return Err(Fault::new("target_gone", "Accessibility target replaced"));
            }
        }
        Ok(())
    }
}

pub async fn run() -> Result<()> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let mut endpoint = None;
    let mut selection = None;
    let mut token_path = None;
    let mut i = 0;
    while i < args.len() {
        let value = args
            .get(i + 1)
            .ok_or_else(|| Fault::new("bounds", "Missing argument value"))?;
        match args[i].as_str() {
            "--endpoint" => endpoint = Some(value.clone()),
            "--socket" => endpoint = Some(format!("unix:{value}")),
            "--backend" => selection = Some(value.clone()),
            "--restore-token" => token_path = Some(PathBuf::from(value)),
            _ => return Err(Fault::new("bounds", "Unknown argument")),
        }
        i += 2;
    }
    let selected = backend(
        selection.as_deref(),
        std::env::var("WAYLAND_DISPLAY").ok().as_deref(),
        std::env::var("DISPLAY").ok().as_deref(),
    )?;
    let path = endpoint
        .as_deref()
        .and_then(|v| v.strip_prefix("unix:"))
        .ok_or_else(|| Fault::new("bounds", "Expected --endpoint unix:/path"))?;
    let writer = Writer::open(crate::endpoint::connect(std::path::Path::new(path))?)?;
    let ui = match Accessibility::connect().await {
        Ok(u) => Some(u),
        Err(e) => {
            eprintln!("AT-SPI unavailable: {e}");
            None
        }
    };
    let (x, portal) = match selected {
        Backend::X11 => (Some(X11::connect()?), None),
        Backend::Wayland => {
            let path = token_path.ok_or_else(|| {
                Fault::new(
                    "bounds",
                    "Wayland requires --restore-token in the ace data directory",
                )
            })?;
            (None, Some(Portal::connect(path).await?))
        }
    };
    let mut runtime = Runtime {
        x,
        portal,
        ui,
        window: None,
        ui_active: false,
        view_only: false,
        target: None,
        capture: None,
        writer,
    };
    let mut input = BufReader::new(tokio::io::stdin());
    let mut line = Vec::new();
    loop {
        line.clear();
        // fill_buf avoids allocating an unbounded command before checking its limit.
        loop {
            let bytes = input.fill_buf().await.map_err(internal)?;
            if bytes.is_empty() {
                break;
            }
            let end = bytes
                .iter()
                .position(|b| *b == b'\n')
                .map(|i| i + 1)
                .unwrap_or(bytes.len());
            if line.len() + end > 64 * 1024 {
                return Err(Fault::new("bounds", "Command exceeds 64 KiB"));
            }
            let newline = bytes[end - 1] == b'\n';
            line.extend_from_slice(&bytes[..end]);
            input.consume(end);
            if newline {
                break;
            }
        }
        if line.is_empty() {
            break;
        }
        let r = Request::parse(&line)?;
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(if r.op == "start" { 130 } else { 10 }),
            runtime.command(&r),
        )
        .await;
        let result = match result {
            Ok(result) => result,
            Err(_) => {
                if r.op == "start" {
                    let _ = tokio::time::timeout(std::time::Duration::from_secs(5), runtime.stop())
                        .await;
                }
                Err(Fault::new("timeout", "Command timed out"))
            }
        };
        let mut response = reply(&r, result);
        let mut bytes = serde_json::to_vec(&response).map_err(internal)?;
        if bytes.len() > 64 * 1024 {
            response = reply(
                &r,
                Err(Fault::new(
                    "bounds",
                    "Reply exceeds 64 KiB; reduce tree caps",
                )),
            );
            bytes = serde_json::to_vec(&response).map_err(internal)?;
        }
        bytes.push(b'\n');
        std::io::stdout().write_all(&bytes).map_err(internal)?;
    }
    runtime.stop().await?;
    Ok(())
}
