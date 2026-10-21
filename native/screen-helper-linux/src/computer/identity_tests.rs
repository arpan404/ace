use super::*;
use crate::computer::desktop::DesktopApp;
use crate::computer::desktop::tests::TempDir;
use std::path::PathBuf;

fn app(id: &str, exec: &str, wm_class: Option<&str>) -> DesktopApp {
    DesktopApp {
        id: id.into(),
        name: id.into(),
        path: PathBuf::new(),
        exec: Some(exec.into()),
        wm_class: wm_class.map(str::to_owned),
        listed: true,
    }
}

fn installed() -> Vec<DesktopApp> {
    vec![
        app(
            "org.gnome.TextEditor",
            "gnome-text-editor %U",
            Some("gnome-text-editor"),
        ),
        app("org.gnome.Calculator", "gnome-calculator", None),
        app("org.xfce.mousepad", "mousepad %U", None),
        app("my-app", "my-app", None),
    ]
}

#[test]
fn the_launchers_desktop_file_names_the_process_only_when_its_pid_matches() {
    let proc = TempDir::new("proc");
    proc.write("42/environ", "HOME=/h\0GIO_LAUNCHED_DESKTOP_FILE=/usr/share/applications/org.gnome.Calculator.desktop\0GIO_LAUNCHED_DESKTOP_FILE_PID=42\0");
    proc.write("43/environ", "GIO_LAUNCHED_DESKTOP_FILE=/usr/share/applications/org.gnome.Calculator.desktop\0GIO_LAUNCHED_DESKTOP_FILE_PID=42\0");
    assert_eq!(
        read_process(&proc.0, 42).launched_desktop_file.as_deref(),
        Some("org.gnome.Calculator")
    );
    assert_eq!(read_process(&proc.0, 43).launched_desktop_file, None);
}

#[test]
fn flatpak_and_systemd_scopes_name_the_app() {
    let proc = TempDir::new("proc");
    proc.write("7/root/.flatpak-info", "[Application]\nname=org.gimp.GIMP\nruntime=x\n");
    proc.write(
        "7/cgroup",
        "0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-flatpak-org.gimp.GIMP-1234.scope\n",
    );
    proc.write(
        "8/cgroup",
        "0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-gnome-org.gnome.TextEditor-4242.scope\n",
    );
    let flatpak = read_process(&proc.0, 7);
    assert_eq!(flatpak.flatpak_id.as_deref(), Some("org.gimp.GIMP"));
    let editor = read_process(&proc.0, 8);
    assert_eq!(
        identify(&editor, &Hints::default(), &installed()).0,
        "org.gnome.TextEditor"
    );
}

#[test]
fn unit_names_yield_installed_ids_even_with_dashes() {
    let apps = installed();
    assert_eq!(
        unit_app_id("app-gnome-my\\x2dapp-99.scope", &apps).as_deref(),
        Some("my-app")
    );
    assert_eq!(
        unit_app_id("app-org.gnome.Calculator@abc.service", &apps).as_deref(),
        Some("org.gnome.Calculator")
    );
    assert_eq!(
        unit_app_id("app-kde-org.kde.dolphin-1a2b.scope", &apps).as_deref(),
        Some("org.kde.dolphin")
    );
    assert_eq!(unit_app_id("session-6.scope", &apps), None);
}

#[test]
fn without_declared_identity_window_and_exe_names_are_matched() {
    let apps = installed();
    let plain = ProcessFacts {
        exe_name: Some("mousepad".into()),
        ..ProcessFacts::default()
    };
    let accessible = Hints {
        accessible_name: Some("org.xfce.mousepad".into()),
        ..Hints::default()
    };
    assert_eq!(identify(&plain, &accessible, &apps).0, "org.xfce.mousepad");
    let window = Hints {
        wm_class: vec!["gnome-text-editor".into()],
        ..Hints::default()
    };
    let editor = ProcessFacts {
        exe_name: Some("gnome-text-editor".into()),
        ..ProcessFacts::default()
    };
    assert_eq!(identify(&editor, &window, &apps).0, "org.gnome.TextEditor");
    assert_eq!(identify(&plain, &Hints::default(), &apps).0, "org.xfce.mousepad");
    let unknown = ProcessFacts {
        exe_name: Some("xclock".into()),
        ..ProcessFacts::default()
    };
    let (id, entry) = identify(&unknown, &Hints::default(), &apps);
    assert_eq!((id.as_str(), entry), ("xclock", None));
}

#[test]
fn the_gtk_application_id_is_trusted_over_name_matching() {
    let hints = Hints {
        gtk_application_id: Some("org.gnome.Calculator".into()),
        wm_class: vec!["gnome-text-editor".into()],
        ..Hints::default()
    };
    assert_eq!(
        identify(&ProcessFacts::default(), &hints, &installed()).0,
        "org.gnome.Calculator"
    );
}
