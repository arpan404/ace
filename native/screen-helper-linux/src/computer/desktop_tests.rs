use super::*;
use std::path::PathBuf;

/// A fresh folder under the system temp dir, removed when dropped.
pub struct TempDir(pub PathBuf);
impl TempDir {
    pub fn new(name: &str) -> Self {
        let unique = format!(
            "ace-computer-{name}-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        );
        let path = std::env::temp_dir().join(unique);
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
    pub fn write(&self, relative: &str, text: &str) -> PathBuf {
        let path = self.0.join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, text).unwrap();
        path
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

const EDITOR: &str = "[Desktop Entry]\nName=Text Editor\nExec=gnome-text-editor %U\nType=Application\nStartupWMClass=gnome-text-editor\n[Desktop Action new-window]\nName=New Window\n";

#[test]
fn user_entries_hide_system_entries_with_the_same_id() {
    let home = TempDir::new("home");
    let system = TempDir::new("system");
    system.write("applications/org.gnome.TextEditor.desktop", EDITOR);
    home.write(
        "applications/org.gnome.TextEditor.desktop",
        &EDITOR.replace("Name=Text Editor", "Name=My Editor"),
    );
    system.write(
        "applications/kde/org.kde.kate.desktop",
        "[Desktop Entry]\nName=Kate\nType=Application\nExec=kate\n",
    );
    system.write(
        "applications/hidden.desktop",
        "[Desktop Entry]\nName=Helper\nType=Application\nNoDisplay=true\n",
    );
    system.write("applications/link.desktop", "[Desktop Entry]\nName=Site\nType=Link\n");
    let env = |name: &str| match name {
        "XDG_DATA_HOME" => Some(home.0.to_string_lossy().into_owned()),
        "XDG_DATA_DIRS" => Some(system.0.to_string_lossy().into_owned()),
        _ => None,
    };
    let apps = scan(&application_dirs(&env));
    let editor = apps.iter().find(|a| a.id == "org.gnome.TextEditor").unwrap();
    assert_eq!(editor.name, "My Editor");
    assert_eq!(editor.exec_name().as_deref(), Some("gnome-text-editor"));
    assert!(apps.iter().any(|a| a.id == "kde-org.kde.kate"));
    assert!(!apps.iter().find(|a| a.id == "hidden").unwrap().listed);
    assert!(!apps.iter().any(|a| a.id == "link"));
}

#[test]
fn data_dirs_default_to_the_spec_locations() {
    let env = |name: &str| (name == "HOME").then(|| "/home/me".to_owned());
    assert_eq!(
        application_dirs(&env),
        vec![
            PathBuf::from("/home/me/.local/share/applications"),
            PathBuf::from("/usr/local/share/applications"),
            PathBuf::from("/usr/share/applications"),
        ]
    );
}

#[test]
fn exec_lines_lose_field_codes_and_keep_quoted_arguments() {
    assert_eq!(exec_argv("gnome-calculator %U"), vec!["gnome-calculator"]);
    assert_eq!(
        exec_argv(r#""/opt/My App/run" --name "a \"b\"" 100%%"#),
        vec!["/opt/My App/run", "--name", "a \"b\"", "100%"]
    );
    assert_eq!(
        exec_argv("env FOO=1 /usr/bin/app %f"),
        vec!["env", "FOO=1", "/usr/bin/app"]
    );
    let app = DesktopApp {
        id: "x".into(),
        name: "X".into(),
        path: PathBuf::new(),
        exec: Some("env FOO=1 /usr/bin/app %f".into()),
        listed: true,
    };
    assert_eq!(app.exec_name().as_deref(), Some("app"));
}
