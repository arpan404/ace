//! Chromium and the apps built on it (Chrome, Brave, Edge, Vivaldi, and Electron apps such as
//! VS Code, Slack, Discord, Obsidian). On Linux they expose their accessibility tree only when
//! started with `--force-renderer-accessibility`: the session's `org.a11y.Status` and the GNOME
//! screen-reader settings leave them with a bare window. So ace starts them with that switch, and
//! says plainly when one is already running without it.
use crate::computer::desktop::{DesktopApp, exec_argv};
use std::path::{Path, PathBuf};

pub const FLAG: &str = "--force-renderer-accessibility";

/// Program names (or the app id a Flatpak runs) of Chromium-based apps whose binary can't be
/// inspected: wrappers in a snap or a Flatpak sandbox.
const KNOWN: [&str; 30] = [
    "chromium",
    "chromium-browser",
    "google-chrome",
    "google-chrome-stable",
    "google-chrome-beta",
    "google-chrome-unstable",
    "brave",
    "brave-browser",
    "microsoft-edge",
    "microsoft-edge-stable",
    "vivaldi",
    "vivaldi-stable",
    "opera",
    "code",
    "code-insiders",
    "codium",
    "cursor",
    "slack",
    "discord",
    "signal-desktop",
    "obsidian",
    "element-desktop",
    "teams-for-linux",
    "com.google.chrome",
    "org.chromium.chromium",
    "com.brave.browser",
    "com.microsoft.edge",
    "com.visualstudio.code",
    "com.slack.slack",
    "com.discordapp.discord",
];

/// Files every Chromium build ships beside its binary.
fn is_chromium_dir(dir: &Path) -> bool {
    dir.join("resources.pak").is_file()
        && (dir.join("v8_context_snapshot.bin").is_file() || dir.join("snapshot_blob.bin").is_file())
}

/// The program a desktop entry runs, past `env VAR=…`, and for `flatpak run` the app id.
pub fn program_names(exec: &str) -> Vec<String> {
    let argv = exec_argv(exec);
    let mut args = argv.iter().skip_while(|arg| *arg == "env" || arg.contains('='));
    let Some(program) = args.next() else { return Vec::new() };
    let name = Path::new(program)
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let mut names = vec![name.clone()];
    if name == "flatpak" {
        if let Some(id) = args.skip_while(|arg| *arg == "run" || arg.starts_with("--")).next() {
            names.push(id.to_lowercase());
        }
    }
    names
}

fn resolve(program: &str) -> Option<PathBuf> {
    let path = Path::new(program);
    if path.is_absolute() {
        return std::fs::canonicalize(path).ok();
    }
    std::env::var_os("PATH")?
        .to_string_lossy()
        .split(':')
        .map(|dir| Path::new(dir).join(program))
        .find(|candidate| candidate.is_file())
        .and_then(|found| std::fs::canonicalize(found).ok())
}

/// Whether an installed app is Chromium-based: a known name, or its binary (or the launcher
/// script's parent folder, as VS Code's `bin/code`) sits in a Chromium build.
pub fn is_chromium_app(app: &DesktopApp) -> bool {
    let Some(exec) = app.exec.as_deref() else { return false };
    if program_names(exec).iter().any(|name| KNOWN.contains(&name.as_str())) {
        return true;
    }
    let argv = exec_argv(exec);
    let Some(program) = argv.iter().find(|arg| *arg != "env" && !arg.contains('=')) else {
        return false;
    };
    resolve(program)
        .and_then(|binary| binary.parent().map(Path::to_path_buf))
        .is_some_and(|dir| is_chromium_dir(&dir) || dir.parent().is_some_and(is_chromium_dir))
}

/// Whether a running process is Chromium-based, from its executable's folder.
pub fn is_chromium_process(proc_root: &Path, pid: u32) -> bool {
    std::fs::read_link(proc_root.join(pid.to_string()).join("exe"))
        .ok()
        .and_then(|exe| exe.parent().map(is_chromium_dir))
        .unwrap_or(false)
}

/// Whether the process was started with the accessibility switch. Chromium rewrites its process
/// title, so its arguments may read as one space-separated string.
pub fn has_flag(proc_root: &Path, pid: u32) -> bool {
    std::fs::read(proc_root.join(pid.to_string()).join("cmdline"))
        .map(|cmdline| cmdline.split(|b| *b == 0 || *b == b' ').any(|arg| arg == FLAG.as_bytes()))
        .unwrap_or(false)
}

/// What the agent is told about a Chromium-based app running without accessibility.
pub fn inaccessible_note(name: &str) -> String {
    format!(
        "{name} was started without accessibility, so ace sees only its window, not its tabs, pages or controls. Ask the person to quit {name} (all its windows); screen_state then reopens it with accessibility on."
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launchers_snaps_and_flatpaks_of_chromium_apps_are_recognized_by_name() {
        assert_eq!(program_names("/usr/bin/google-chrome-stable %U"), vec!["google-chrome-stable"]);
        assert_eq!(
            program_names("env BAMF_DESKTOP_FILE_HINT=/x.desktop /snap/bin/chromium %U"),
            vec!["chromium"]
        );
        assert_eq!(
            program_names("/usr/bin/flatpak run --branch=stable --command=code com.visualstudio.code --new-window %F"),
            vec!["flatpak", "com.visualstudio.code"]
        );
        let app = |exec: &str| DesktopApp {
            id: "x".into(),
            name: "X".into(),
            path: PathBuf::new(),
            exec: Some(exec.into()),
            listed: true,
        };
        assert!(is_chromium_app(&app("/usr/bin/flatpak run com.slack.Slack")));
        assert!(is_chromium_app(&app("code --new-window %F")));
        assert!(!is_chromium_app(&app("gnome-text-editor %U")));
    }

    #[test]
    fn a_running_build_is_chromium_by_its_files_and_has_the_switch_only_when_started_with_it() {
        let root = std::env::temp_dir().join(format!("ace-chromium-{}", std::process::id()));
        let build = root.join("opt/app");
        std::fs::create_dir_all(&build).unwrap();
        for file in ["resources.pak", "v8_context_snapshot.bin", "app"] {
            std::fs::write(build.join(file), b"").unwrap();
        }
        let proc = root.join("proc");
        for (pid, args) in [
            ("10", &b"app\0--force-renderer-accessibility\0"[..]),
            ("11", &b"app\0--incognito\0"[..]),
            // A rewritten process title.
            ("13", &b"/opt/app/app --force-renderer-accessibility\0"[..]),
        ] {
            std::fs::create_dir_all(proc.join(pid)).unwrap();
            std::os::unix::fs::symlink(build.join("app"), proc.join(pid).join("exe")).unwrap();
            std::fs::write(proc.join(pid).join("cmdline"), args).unwrap();
        }
        assert!(is_chromium_process(&proc, 10));
        assert!(has_flag(&proc, 10));
        assert!(!has_flag(&proc, 11));
        assert!(has_flag(&proc, 13));
        assert!(!is_chromium_process(&proc, 12));
        std::fs::remove_dir_all(root).unwrap();
    }
}
