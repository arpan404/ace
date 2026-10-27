//! Running apps from the AT-SPI registry, installed ones from `.desktop` files, and launching.
use crate::computer::bus::{Bus, Obj};
use crate::computer::desktop::{self, DesktopApp};
use crate::computer::element;
use crate::computer::error::{CuError, CuResult};
use crate::computer::identity;
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
    /// A suite module sharing its process (LibreOffice Writer in `soffice.bin`): the module's
    /// name, which ends the titles of its windows.
    pub title_hint: Option<String>,
}

pub fn installed() -> Vec<DesktopApp> {
    desktop::scan(&desktop::application_dirs(&|name| std::env::var(name).ok()))
}

/// The app an accessible application belongs to, from its process and accessible name.
pub fn process_app_id(pid: u32, accessible_name: Option<&str>, installed: &[DesktopApp]) -> String {
    identity::identify(&identity::read_process(Path::new("/proc"), pid), accessible_name, installed).0
}

/// Apps with at least one window on the accessibility bus, this helper excluded.
pub async fn running(bus: &Bus, installed: &[DesktopApp]) -> Vec<RunningApp> {
    let Ok(apps) = bus.applications().await else {
        return Vec::new();
    };
    let own = std::process::id();
    let reads = futures_util::future::join_all(apps.into_iter().map(|app| async move {
        let pid = bus.pid_of(&app.0).await?;
        let name = bus.string_prop(&app, "Accessible", "Name").await.unwrap_or_default();
        let windows = bus.children(&app).await.ok()?;
        let mut active = false;
        let mut titles = Vec::new();
        for window in windows.iter().take(32) {
            if let Ok(window) = element::read(bus, window).await {
                if matches!(window.role.as_str(), "frame" | "dialog" | "alert" | "file chooser")
                    || (window.role == "window" && !window.name.trim().is_empty())
                {
                    active |= window.states.active;
                    titles.push((window.name.clone(), window.states.active));
                }
            }
        }
        (!titles.is_empty()).then_some((app, pid, name, active, titles))
    }))
    .await;
    let mut running = Vec::new();
    for (obj, pid, name, active, titles) in reads.into_iter().flatten() {
        if pid == own || running.iter().any(|r: &RunningApp| r.obj.0 == obj.0) {
            continue;
        }
        let facts = identity::read_process(Path::new("/proc"), pid);
        let accessible_name = Some(name.as_str()).filter(|n| !n.is_empty());
        let (id, entry) = identity::identify(&facts, accessible_name, installed);
        // The desktop's own shell, portals, bars and agents are not apps to operate.
        let system = crate::computer::catalog::is_system_component;
        if system(&id) || facts.exe_name.as_deref().is_some_and(system) {
            continue;
        }
        // A suite lists each module that has a window, all in the one process.
        let family = identity::family(&facts, installed);
        let mut modules: Vec<(&DesktopApp, bool)> = Vec::new();
        if family.len() > 1 {
            for (title, window_active) in &titles {
                if let Some(module) = identity::module_of(title, &family) {
                    match modules.iter_mut().find(|(m, _)| m.id == module.id) {
                        Some((_, seen)) => *seen |= *window_active,
                        None => modules.push((module, *window_active)),
                    }
                }
            }
        }
        if !modules.is_empty() {
            for (module, module_active) in modules {
                running.push(RunningApp {
                    obj: obj.clone(),
                    pid,
                    id: module.id.clone(),
                    name: module.name.clone(),
                    active: module_active,
                    title_hint: Some(module.name.clone()),
                });
            }
            continue;
        }
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
            title_hint: None,
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
    // Chromium-based apps need a switch on their command line; gio can't add one.
    let chromium = crate::computer::chromium::is_chromium_app(app);
    let mut gio = Command::new("gio");
    gio.arg("launch").arg(&app.path);
    detach(&mut gio);
    if !chromium && let Ok(mut child) = gio.spawn() {
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
    if chromium {
        command.arg(crate::computer::chromium::FLAG);
    }
    // As gio does, so the app is known by its desktop file.
    command.env("GIO_LAUNCHED_DESKTOP_FILE", &app.path);
    detach(&mut command);
    let mut child = command
        .spawn()
        .map_err(|e| CuError::new("launch_failed", format!("{} could not be opened: {e}.", app.name)))?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

/// A process of `entry` that is running but not on the accessibility bus: started before
/// accessibility was on for the session (Firefox reads it only at start). Opening the app again
/// would only reach that process.
pub fn inaccessible_process(entry: &DesktopApp, installed: &[DesktopApp]) -> Option<u32> {
    let uid = unsafe { libc::getuid() };
    let own = std::process::id();
    let entries = std::fs::read_dir("/proc").ok()?;
    entries.flatten().find_map(|entry_dir| {
        let pid: u32 = entry_dir.file_name().to_string_lossy().parse().ok()?;
        if pid == own {
            return None;
        }
        let meta = std::fs::metadata(entry_dir.path()).ok()?;
        if std::os::unix::fs::MetadataExt::uid(&meta) != uid {
            return None;
        }
        let facts = identity::read_process(Path::new("/proc"), pid);
        facts.exe_name.as_ref()?;
        (identity::identify(&facts, None, installed).0 == entry.id).then_some(pid)
    })
}

/// An app process younger than this may still be joining the accessibility bus.
pub const STARTING: std::time::Duration = std::time::Duration::from_secs(20);

/// How long ago a process started, from its `stat` start time and the system's uptime.
pub fn process_age(proc_root: &Path, pid: u32) -> Option<std::time::Duration> {
    let stat = std::fs::read_to_string(proc_root.join(pid.to_string()).join("stat")).ok()?;
    let uptime = std::fs::read_to_string(proc_root.join("uptime")).ok()?;
    let ticks = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
    age_from(&stat, &uptime, u64::try_from(ticks).ok().filter(|t| *t > 0)?)
}

/// The age from `/proc/<pid>/stat` (start time is field 22, in clock ticks since boot; the
/// command name before it may hold spaces and parentheses) and `/proc/uptime` (seconds).
pub fn age_from(stat: &str, uptime: &str, ticks_per_second: u64) -> Option<std::time::Duration> {
    let after_name = &stat[stat.rfind(')')? + 1..];
    let start_ticks: u64 = after_name.split_whitespace().nth(19)?.parse().ok()?;
    let up: f64 = uptime.split_whitespace().next()?.parse().ok()?;
    let started = start_ticks as f64 / ticks_per_second as f64;
    Some(std::time::Duration::from_secs_f64((up - started).max(0.0)))
}

/// Why an app that runs can't be seen, for the agent.
pub fn inaccessible_error(entry: &DesktopApp, pid: u32) -> CuError {
    let name = &entry.name;
    let message = if crate::computer::chromium::is_chromium_process(Path::new("/proc"), pid) {
        crate::computer::chromium::inaccessible_note(name)
    } else {
        format!(
            "{name} is running but was started before accessibility was on for this session, so ace can't see its windows. Ask the person to quit {name} (all its windows); screen_state then reopens it and can see it."
        )
    };
    CuError::new("app_inaccessible", message)
}

#[cfg(test)]
mod tests {
    use super::age_from;
    use std::time::Duration;

    #[test]
    fn a_process_age_comes_from_its_start_time_even_when_its_name_holds_parentheses() {
        // Field 22 (start time) is 1_000 ticks at 100 per second: started 10 s after boot.
        let fields: Vec<String> = (3..=21).map(|n| n.to_string()).collect();
        let stat = format!("4242 (Web (Content) x) S {} 1000 0 0", fields[1..].join(" "));
        assert_eq!(age_from(&stat, "25.50 99.00\n", 100), Some(Duration::from_millis(15_500)));
        assert_eq!(age_from("garbage", "25.50 99.00", 100), None);
    }
}
