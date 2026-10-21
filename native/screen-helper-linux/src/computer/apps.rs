//! Running apps from the AT-SPI registry, installed ones from `.desktop` files, and launching.
use crate::computer::bus::{Bus, Obj};
use crate::computer::desktop::{self, DesktopApp};
use crate::computer::element;
use crate::computer::error::{CuError, CuResult};
use crate::computer::identity::{self, Hints};
use crate::computer::xdisplay::XDisplay;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};

#[derive(Clone, Debug)]
pub struct RunningApp {
    pub obj: Obj,
    pub pid: u32,
    pub id: String,
    pub name: String,
    pub active: bool,
}

pub fn installed() -> Vec<DesktopApp> {
    desktop::scan(&desktop::application_dirs(&|name| std::env::var(name).ok()))
}

/// Apps with at least one window on the accessibility bus, this helper excluded.
pub async fn running(bus: &Bus, x: Option<&XDisplay>, installed: &[DesktopApp]) -> Vec<RunningApp> {
    let Ok(apps) = bus.applications().await else {
        return Vec::new();
    };
    let own = std::process::id();
    let x_windows = x.map(XDisplay::client_windows).unwrap_or_default();
    let reads = futures_util::future::join_all(apps.into_iter().map(|app| async move {
        let pid = bus.pid_of(&app.0).await?;
        let name = bus.string_prop(&app, "Accessible", "Name").await.unwrap_or_default();
        let windows = bus.children(&app).await.ok()?;
        let mut active = false;
        let mut any = false;
        for window in windows.iter().take(32) {
            if let Ok(window) = element::read(bus, window).await {
                if matches!(window.role.as_str(), "frame" | "dialog" | "alert" | "file chooser")
                    || (window.role == "window" && !window.name.trim().is_empty())
                {
                    any = true;
                    active |= window.states.active;
                }
            }
        }
        any.then_some((app, pid, name, active))
    }))
    .await;
    let mut running = Vec::new();
    for (obj, pid, name, active) in reads.into_iter().flatten() {
        if pid == own || running.iter().any(|r: &RunningApp| r.obj.0 == obj.0) {
            continue;
        }
        let window = x_windows.iter().find(|w| w.pid == Some(pid));
        let hints = Hints {
            gtk_application_id: window.and_then(|w| w.gtk_application_id.clone()),
            wm_class: window.map(|w| w.wm_class.clone()).unwrap_or_default(),
            accessible_name: Some(name.clone()).filter(|n| !n.is_empty()),
        };
        let facts = identity::read_process(Path::new("/proc"), pid);
        let (id, entry) = identity::identify(&facts, &hints, installed);
        let shown = entry
            .map(|e| e.name.clone())
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| if name.is_empty() { id.clone() } else { name.clone() });
        running.push(RunningApp {
            obj,
            pid,
            id,
            name: shown,
            active,
        });
    }
    running
}

/// Starts an installed app through `gio launch` (as a desktop launcher does), else its `Exec=`.
pub fn launch(app: &DesktopApp) -> CuResult<()> {
    let detach = |command: &mut Command| {
        command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        // SAFETY: setsid is async-signal-safe; the child leaves our session and process group.
        unsafe {
            command.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
    };
    let mut gio = Command::new("gio");
    gio.arg("launch").arg(&app.path);
    detach(&mut gio);
    if let Ok(mut child) = gio.spawn() {
        // gio exits once the app is started; reap it in the background.
        std::thread::spawn(move || {
            let _ = child.wait();
        });
        return Ok(());
    }
    let argv = desktop::exec_argv(app.exec.as_deref().unwrap_or_default());
    let (program, args) = argv.split_first().ok_or_else(|| {
        CuError::new(
            "launch_failed",
            format!("{} could not be opened: its desktop file has no command.", app.name),
        )
    })?;
    let mut command = Command::new(program);
    command.args(args);
    detach(&mut command);
    let mut child = command
        .spawn()
        .map_err(|e| CuError::new("launch_failed", format!("{} could not be opened: {e}.", app.name)))?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}
