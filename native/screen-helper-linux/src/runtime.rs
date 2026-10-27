use crate::{
    accessibility::Accessibility,
    policy::wayland_session,
    portal::{Choice, Portal},
    protocol::{Fault, Request, Result, internal, reply, valid_id},
    writer::Writer,
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
use std::time::Duration;

pub(crate) struct Capture {
    stop: Arc<AtomicBool>,
    wake: UnixStream,
    worker: Option<JoinHandle<()>>,
    control: Arc<crate::pipewire::Control>,
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
    pub(crate) portal: Portal,
    pub(crate) ui: Option<Accessibility>,
    pub(crate) ui_active: bool,
    pub(crate) view_only: bool,
    target: Option<crate::protocol::Target>,
    pub(crate) capture: Option<Capture>,
    pub(crate) writer: Writer,
}
impl Runtime {
    fn capabilities(&self) -> Value {
        self.portal.capabilities(self.ui.is_some())
    }
    async fn stop(&mut self) -> Result<Value> {
        self.capture.take();
        self.target = None;
        self.ui_active = false;
        self.view_only = false;
        if let Some(ui) = &mut self.ui {
            ui.clear();
        }
        self.portal.stop().await?;
        Ok(json!({}))
    }
    /// Whether anyone watches: nobody, and new pictures wait unencoded; someone again, and the
    /// current picture is published at once under the new generation.
    fn watch(&mut self, r: &Request) -> Result<Value> {
        let active = r.active.ok_or_else(|| Fault::new("bounds", "Missing active"))?;
        let capture = self
            .capture
            .as_mut()
            .ok_or_else(|| Fault::new("target_gone", "No capture session"))?;
        if let Some(generation) = r.capture_generation {
            capture.control.generation.store(generation, Ordering::Release);
        }
        capture.control.watching.store(active, Ordering::Release);
        if active {
            capture.control.refresh.store(true, Ordering::Release);
        }
        // Wakes the capture loop, which may be waiting for the desktop's next buffer.
        let _ = capture.wake.write_all(&[1]);
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
        let control = Arc::new(crate::pipewire::Control::new(r.capture_generation.unwrap_or(0)));
        let capture_control = control.clone();
        let (read, wake) = UnixStream::pair().map_err(internal)?;
        let stop = Arc::new(AtomicBool::new(false));
        let cancelled = stop.clone();
        let socket = self.writer.abort_socket()?;
        let worker = {
            let p = &mut self.portal;
            let choice = match target.kind.as_str() {
                "chooser" => Choice::Any,
                "window" => Choice::Window,
                "display" => Choice::Display,
                _ => {
                    return Err(Fault::new(
                        "not_supported",
                        "Wayland target must be chosen in the sharing dialog",
                    ));
                }
            };
            // Portal chooser is the only trustworthy source identity. Do not claim supplied ids are enforced.
            if choice == Choice::Window
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
            let fd: OwnedFd = p.start(choice, target.restore.unwrap_or(true)).await?;
            self.view_only = p.picked.as_ref().is_none_or(|picked| picked.display);
            // The app the person picked, as the desktop recorded it, else the one asked for.
            let scope = p
                .picked
                .as_ref()
                .and_then(|picked| picked.app.as_ref().map(|app| app.app_id.clone()))
                .or_else(|| target.bundle_id.clone().filter(|_| choice == Choice::Window));
            if !self.view_only {
                if let (Some(ui), Some(identity)) = (&mut self.ui, &scope) {
                    match ui.scope_application(identity).await {
                        Ok(()) => self.ui_active = true,
                        Err(e) => eprintln!("AT-SPI target: {e}"),
                    }
                }
            }
            let publisher = self.writer.publisher(session);
            let p = &self.portal;
            let node = p.node;
            let logical_width = p.size.0;
            let shown = p.shown.clone();
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
                    shown,
                    capture_control,
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
            control,
        });
        let picked = self
            .portal
            .picked
            .as_ref()
            .map(crate::portal_choice::Picked::json);
        Ok(json!({"capabilities":self.capabilities(),"picked":picked}))
    }
    async fn command(&mut self, r: &Request) -> Result<Value> {
        match r.op.as_str() {
            "hello" => Ok(self.capabilities()),
            "permissions" => Ok(
                json!({"screenRecording":true,"accessibility":self.portal.session.is_some()}),
            ),
            "targets" => {
                // Nothing to list: the sharing dialog on this desktop picks the source.
                let p = &self.portal;
                let policy = crate::policy::portal_policy(&p.offer, p.route());
                Ok(json!({"windows":[],"displays":[],"chooser":{"windows":policy.windows,"displays":policy.displays}}))
            }
            "start" => self.start(r).await,
            "watch" => self.watch(r),
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
                self.check_input(false)?;
                self.check_ui()?;
                let action = r
                    .action
                    .as_ref()
                    .and_then(Value::as_str)
                    .ok_or_else(|| Fault::new("bounds", "Missing action"))?;
                self.ui
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
                Ok(json!({"fallback":false,"method":"atspi"}))
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
    /// Input may go to the session. A shared screen takes only the person's input: they chose
    /// it in the sharing dialog, which grants control of the desktop.
    pub(crate) fn check_input(&self, person: bool) -> Result<()> {
        if self.capture.is_none() {
            return Err(Fault::new("target_gone", "No capture session"));
        }
        if self.view_only && !person {
            return Err(Fault::new(
                "permission_denied",
                "A shared screen takes only the person's input",
            ));
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
        Ok(())
    }
}

pub async fn run() -> Result<()> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let mut endpoint = None;
    let mut token_path = None;
    let mut i = 0;
    while i < args.len() {
        let value = args
            .get(i + 1)
            .ok_or_else(|| Fault::new("bounds", "Missing argument value"))?;
        match args[i].as_str() {
            "--endpoint" => endpoint = Some(value.clone()),
            "--socket" => endpoint = Some(format!("unix:{value}")),
            "--restore-token" => token_path = Some(PathBuf::from(value)),
            _ => return Err(Fault::new("bounds", "Unknown argument")),
        }
        i += 2;
    }
    wayland_session(
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
    let path = token_path.ok_or_else(|| {
        Fault::new(
            "bounds",
            "Wayland requires --restore-token in the ace data directory",
        )
    })?;
    let portal = Portal::connect(path).await?;
    let mut runtime = Runtime {
        portal,
        ui,
        ui_active: false,
        view_only: false,
        target: None,
        capture: None,
        writer,
    };
    let mut lines = crate::command_lines::spawn(tokio::io::stdin());
    let mut queued = std::collections::VecDeque::new();
    loop {
        let r = match queued.pop_front() {
            Some(r) => r,
            None => match lines.recv().await {
                Some(r) => r?,
                None => break,
            },
        };
        if r.op != "start" {
            let drag = Duration::from_millis(r.duration_ms.unwrap_or(0).min(10_000));
            let result = tokio::time::timeout(Duration::from_secs(10) + drag, runtime.command(&r))
                .await
                .unwrap_or_else(|_| Err(Fault::new("timeout", "Command timed out")));
            respond(&r, result)?;
            continue;
        }
        // A start can wait up to two minutes for the person; a stop meanwhile cancels it.
        let mut cancel: Option<Option<Request>> = None;
        let outcome = {
            let started = tokio::time::timeout(Duration::from_secs(130), runtime.command(&r));
            tokio::pin!(started);
            loop {
                tokio::select! {
                    outcome = &mut started => break Some(outcome),
                    next = lines.recv(), if cancel.is_none() => match next {
                        Some(Ok(next)) if next.op == "stop" => { cancel = Some(Some(next)); break None; }
                        Some(Ok(next)) => queued.push_back(next),
                        Some(Err(error)) => return Err(error),
                        None => { cancel = Some(None); break None; }
                    },
                }
            }
        };
        let result = match outcome {
            Some(Ok(result)) => result,
            Some(Err(_)) | None => {
                let _ = tokio::time::timeout(Duration::from_secs(5), runtime.stop()).await;
                Err(if outcome.is_none() {
                    Fault::new("denied", "Sharing was cancelled")
                } else {
                    Fault::new("timeout", "Command timed out")
                })
            }
        };
        respond(&r, result)?;
        match cancel {
            Some(Some(stop)) => {
                let result = runtime.command(&stop).await;
                respond(&stop, result)?;
            }
            Some(None) => break,
            None => {}
        }
    }
    runtime.stop().await?;
    Ok(())
}

/// Writes one reply line, replacing a reply over 64 KiB with a bounds error.
fn respond(r: &Request, result: Result<Value>) -> Result<()> {
    let mut response = reply(r, result);
    let mut bytes = serde_json::to_vec(&response).map_err(internal)?;
    if bytes.len() > 64 * 1024 {
        response = reply(
            r,
            Err(Fault::new(
                "bounds",
                "Reply exceeds 64 KiB; reduce tree caps",
            )),
        );
        bytes = serde_json::to_vec(&response).map_err(internal)?;
    }
    bytes.push(b'\n');
    std::io::stdout().write_all(&bytes).map_err(internal)
}
