use super::*;
use crate::computer::desktop::DesktopApp;
use crate::computer::desktop::tests::TempDir;
use std::path::PathBuf;

fn app(id: &str, exec: &str) -> DesktopApp {
    DesktopApp {
        id: id.into(),
        name: id.into(),
        path: PathBuf::new(),
        exec: Some(exec.into()),
        listed: true,
    }
}

fn installed() -> Vec<DesktopApp> {
    vec![
        app("org.gnome.TextEditor", "gnome-text-editor %U"),
        app("org.gnome.Calculator", "gnome-calculator"),
        app("org.xfce.mousepad", "mousepad %U"),
        app("my-app", "my-app"),
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
        identify(&editor, None, &installed()).0,
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
fn without_declared_identity_accessible_and_exe_names_are_matched() {
    let apps = installed();
    let plain = ProcessFacts {
        exe_name: Some("mousepad".into()),
        ..ProcessFacts::default()
    };
    assert_eq!(identify(&plain, Some("org.xfce.mousepad"), &apps).0, "org.xfce.mousepad");
    let editor = ProcessFacts {
        exe_name: Some("gnome-text-editor".into()),
        ..ProcessFacts::default()
    };
    assert_eq!(identify(&editor, Some("Text Editor"), &apps).0, "org.gnome.TextEditor");
    assert_eq!(identify(&plain, None, &apps).0, "org.xfce.mousepad");
    let unknown = ProcessFacts {
        exe_name: Some("xclock".into()),
        ..ProcessFacts::default()
    };
    let (id, entry) = identify(&unknown, None, &apps);
    assert_eq!((id.as_str(), entry), ("xclock", None));
}

fn office() -> Vec<DesktopApp> {
    vec![
        app("libreoffice-startcenter", "libreoffice %U"),
        app("libreoffice-writer", "libreoffice --writer %U"),
        app("libreoffice-calc", "libreoffice --calc %U"),
    ]
    .into_iter()
    .map(|mut entry| {
        entry.name = match entry.id.as_str() {
            "libreoffice-startcenter" => "LibreOffice".into(),
            "libreoffice-writer" => "LibreOffice Writer".into(),
            _ => "LibreOffice Calc".into(),
        };
        entry
    })
    .collect()
}

#[test]
fn a_suite_process_is_its_launcher_and_each_window_belongs_to_its_module() {
    let installed = office();
    let soffice = ProcessFacts {
        exe_name: Some("soffice.bin".into()),
        ..ProcessFacts::default()
    };
    assert_eq!(identify(&soffice, Some("soffice"), &installed).0, "libreoffice-startcenter");
    let family = family(&soffice, &installed);
    assert_eq!(family.len(), 3);
    assert_eq!(module_of("Untitled 1 — LibreOffice Writer", &family).unwrap().id, "libreoffice-writer");
    assert_eq!(module_of("Budget.ods — LibreOffice Calc", &family).unwrap().id, "libreoffice-calc");
    assert_eq!(module_of("Welcome to LibreOffice!", &family), None);
}
