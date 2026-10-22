//! Which app a process is: its desktop-file id. Read from the process when it says (the
//! launcher's `GIO_LAUNCHED_DESKTOP_FILE`, a Flatpak's `/.flatpak-info`, the systemd scope
//! the session put it in), else matched through window and accessibility names against the
//! installed `.desktop` files, else its executable name.
use crate::computer::desktop::DesktopApp;
use std::path::Path;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ProcessFacts {
    pub launched_desktop_file: Option<String>,
    pub flatpak_id: Option<String>,
    pub cgroup_unit: Option<String>,
    pub exe_name: Option<String>,
}

/// What the desktop and accessibility say about the process's windows.
#[derive(Clone, Debug, Default)]
pub struct Hints {
    pub gtk_application_id: Option<String>,
    pub wm_class: Vec<String>,
    pub accessible_name: Option<String>,
}

/// Reads the facts under a proc root (`/proc` in production, a temp folder in tests).
pub fn read_process(proc_root: &Path, pid: u32) -> ProcessFacts {
    let dir = proc_root.join(pid.to_string());
    let mut facts = ProcessFacts::default();
    if let Ok(environ) = std::fs::read(dir.join("environ")) {
        let vars: Vec<(String, String)> = environ
            .split(|b| *b == 0)
            .filter_map(|entry| {
                let entry = String::from_utf8_lossy(entry);
                entry.split_once('=').map(|(k, v)| (k.to_owned(), v.to_owned()))
            })
            .collect();
        let get = |name: &str| vars.iter().find(|(k, _)| k == name).map(|(_, v)| v.clone());
        // Children inherit the variable; it names this process only when its pid matches.
        if get("GIO_LAUNCHED_DESKTOP_FILE_PID").is_none_or(|p| p == pid.to_string()) {
            facts.launched_desktop_file = get("GIO_LAUNCHED_DESKTOP_FILE")
                .and_then(|file| Path::new(&file).file_stem().map(|s| s.to_string_lossy().into_owned()));
        }
    }
    if let Ok(info) = std::fs::read_to_string(dir.join("root/.flatpak-info")) {
        facts.flatpak_id = flatpak_id(&info);
    }
    if let Ok(cgroup) = std::fs::read_to_string(dir.join("cgroup")) {
        facts.cgroup_unit = cgroup
            .lines()
            .filter_map(|line| line.rsplit(':').next())
            .filter_map(|path| path.rsplit('/').next())
            .find(|unit| unit.starts_with("app-") || unit.starts_with("app.") || unit.starts_with("snap."))
            .map(str::to_owned);
    }
    facts.exe_name = std::fs::read_link(dir.join("exe"))
        .ok()
        .and_then(|exe| exe.file_name().map(|n| n.to_string_lossy().into_owned()))
        .map(|name| name.trim_end_matches(" (deleted)").to_owned());
    facts
}

pub fn flatpak_id(info: &str) -> Option<String> {
    let mut in_application = false;
    for line in info.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_application = line == "[Application]";
        } else if in_application {
            if let Some(name) = line.strip_prefix("name=") {
                return Some(name.trim().to_owned()).filter(|n| !n.is_empty());
            }
        }
    }
    None
}

fn unescape(unit: &str) -> String {
    unit.replace("\\x2d", "-").replace("\\x2e", ".").replace("\\x5f", "_")
}

/// The app id inside a systemd unit name: `app-gnome-org.gnome.TextEditor-4242.scope`,
/// `app-org.gnome.TextEditor@x.service`, `app-flatpak-org.gimp.GIMP-1.scope`. An installed id
/// found in it wins; otherwise a reverse-DNS-looking part.
pub fn unit_app_id(unit: &str, installed: &[DesktopApp]) -> Option<String> {
    let unit = unescape(unit);
    let body = unit.strip_prefix("app-")?;
    let body = body
        .strip_suffix(".scope")
        .or_else(|| body.strip_suffix(".service"))
        .unwrap_or(body);
    let body = body.split('@').next().unwrap_or(body);
    let mut best: Option<&DesktopApp> = None;
    for app in installed {
        let bounded = |at: usize| {
            let end = at + app.id.len();
            (at == 0 || body.as_bytes()[at - 1] == b'-') && (end == body.len() || body.as_bytes()[end] == b'-')
        };
        if body.match_indices(app.id.as_str()).any(|(at, _)| bounded(at))
            && best.is_none_or(|b| app.id.len() > b.id.len())
        {
            best = Some(app);
        }
    }
    if let Some(app) = best {
        return Some(app.id.clone());
    }
    let mut parts: Vec<&str> = body.split('-').collect();
    if parts.len() > 1 && parts.last().is_some_and(|p| p.chars().all(|c| c.is_ascii_hexdigit())) {
        parts.pop();
    }
    if parts.len() > 1 && !parts[0].contains('.') {
        parts.remove(0);
    }
    let id = parts.join("-");
    id.contains('.').then_some(id)
}

/// The app's id and its desktop entry, when installed.
pub fn identify<'a>(
    facts: &ProcessFacts,
    hints: &Hints,
    installed: &'a [DesktopApp],
) -> (String, Option<&'a DesktopApp>) {
    let by_id = |id: &str| installed.iter().find(|app| app.id.eq_ignore_ascii_case(id));
    let declared = facts
        .launched_desktop_file
        .clone()
        .or_else(|| facts.flatpak_id.clone())
        .or_else(|| {
            facts
                .cgroup_unit
                .as_deref()
                .and_then(|unit| unit_app_id(unit, installed))
        })
        .or_else(|| hints.gtk_application_id.clone());
    if let Some(id) = declared {
        let app = by_id(&id);
        return (app.map(|a| a.id.clone()).unwrap_or(id), app);
    }
    if let Some(app) = hints.accessible_name.as_deref().and_then(by_id) {
        return (app.id.clone(), Some(app));
    }
    for class in &hints.wm_class {
        let class = class.to_lowercase();
        let found = installed.iter().find(|app| {
            app.wm_class.as_deref().is_some_and(|w| w.to_lowercase() == class)
                || app.id.to_lowercase() == class
                || app.short_id() == class
        });
        if let Some(app) = found {
            return (app.id.clone(), Some(app));
        }
    }
    if let Some(exe) = &facts.exe_name {
        let found = installed
            .iter()
            .filter(|app| app.exec_name().as_deref() == Some(exe.as_str()))
            .min_by_key(|app| (!app.listed, app.id.len()));
        if let Some(app) = found {
            return (app.id.clone(), Some(app));
        }
        return (exe.clone(), None);
    }
    (hints.accessible_name.clone().unwrap_or_default(), None)
}

#[cfg(test)]
#[path = "identity_tests.rs"]
mod tests;
