//! Installed apps from `.desktop` files in the XDG data dirs. The desktop-file id
//! (`org.gnome.TextEditor`) is an app's identity, like a bundle id on macOS.
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DesktopApp {
    pub id: String,
    pub name: String,
    pub path: PathBuf,
    pub exec: Option<String>,
    pub wm_class: Option<String>,
    /// Shown in menus: not NoDisplay or Hidden.
    pub listed: bool,
}

impl DesktopApp {
    /// The executable's file name, from `Exec=`.
    pub fn exec_name(&self) -> Option<String> {
        let argv = exec_argv(self.exec.as_deref()?);
        let program = argv.iter().find(|arg| !arg.contains('=') && *arg != "env")?;
        Path::new(program).file_name().map(|n| n.to_string_lossy().into_owned())
    }

    /// The id's last dotted part, lowercased: `texteditor` for `org.gnome.TextEditor`.
    pub fn short_id(&self) -> String {
        self.id.rsplit('.').next().unwrap_or(&self.id).to_lowercase()
    }
}

/// Reads the `[Desktop Entry]` group. None for anything that is not an application.
pub fn parse(id: &str, path: &Path, text: &str) -> Option<DesktopApp> {
    let mut in_entry = false;
    let (mut name, mut exec, mut wm_class, mut kind) = (None, None, None, None);
    let mut listed = true;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_entry = line == "[Desktop Entry]";
            continue;
        }
        if !in_entry || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let value = value.trim().to_owned();
        match key.trim() {
            "Name" => name = Some(value),
            "Exec" => exec = Some(value),
            "StartupWMClass" => wm_class = Some(value),
            "Type" => kind = Some(value),
            "NoDisplay" | "Hidden" if value.eq_ignore_ascii_case("true") => listed = false,
            _ => {}
        }
    }
    if kind.as_deref() != Some("Application") {
        return None;
    }
    Some(DesktopApp {
        id: id.to_owned(),
        name: name.unwrap_or_else(|| id.to_owned()),
        path: path.to_owned(),
        exec,
        wm_class,
        listed,
    })
}

/// `applications` folders in priority order: `$XDG_DATA_HOME`, then each `$XDG_DATA_DIRS`.
pub fn application_dirs(env: &dyn Fn(&str) -> Option<String>) -> Vec<PathBuf> {
    let set = |name: &str| env(name).filter(|v| !v.is_empty());
    let home = set("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| set("HOME").map(|h| Path::new(&h).join(".local/share")));
    let shared = set("XDG_DATA_DIRS").unwrap_or_else(|| "/usr/local/share:/usr/share".into());
    home.into_iter()
        .chain(shared.split(':').filter(|d| !d.is_empty()).map(PathBuf::from))
        .map(|dir| dir.join("applications"))
        .collect()
}

/// Every application entry; an id found in an earlier folder hides later ones.
pub fn scan(dirs: &[PathBuf]) -> Vec<DesktopApp> {
    let mut apps: Vec<DesktopApp> = Vec::new();
    for dir in dirs {
        let mut found = Vec::new();
        collect(dir, dir, 3, &mut found);
        for (id, path) in found {
            if apps.iter().any(|app| app.id == id) {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&path) else {
                continue;
            };
            if let Some(app) = parse(&id, &path, &text) {
                apps.push(app);
            }
        }
    }
    apps
}

fn collect(base: &Path, dir: &Path, depth: u32, out: &mut Vec<(String, PathBuf)>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if depth > 0 {
                collect(base, &path, depth - 1, out);
            }
            continue;
        }
        let Some(relative) = path.strip_prefix(base).ok().and_then(|p| p.to_str()) else {
            continue;
        };
        if let Some(stem) = relative.strip_suffix(".desktop") {
            out.push((stem.replace('/', "-"), path.clone()));
        }
    }
}

/// `Exec=` split into arguments, quotes removed and field codes (`%f`, `%U`…) dropped.
pub fn exec_argv(exec: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    let mut started = false;
    let mut chars = exec.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' => {
                quoted = !quoted;
                started = true;
            }
            '\\' if quoted => {
                if let Some(next) = chars.next() {
                    current.push(next);
                }
            }
            '%' => match chars.next() {
                Some('%') => current.push('%'),
                _ => {}
            },
            c if c.is_whitespace() && !quoted => {
                if started || !current.is_empty() {
                    args.push(std::mem::take(&mut current));
                }
                started = false;
            }
            c => current.push(c),
        }
    }
    if started || !current.is_empty() {
        args.push(current);
    }
    args.retain(|a| !a.is_empty());
    args
}

#[cfg(test)]
#[path = "desktop_tests.rs"]
pub(crate) mod tests;
