//! Naming an app: exact id or name first, then a single partial match. Pure.
use crate::computer::error::{CuError, CuResult};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Candidate {
    pub id: String,
    pub name: String,
    pub running: bool,
}

/// Parts of the desktop itself (shells, compositors, portals, bars, launchers, lock screens,
/// input methods, accessibility and settings daemons, polkit agents). They show windows on the
/// accessibility bus but are not apps an agent may operate. Matched on a desktop id or an
/// executable name, case-insensitive, with any `.desktop` suffix ignored.
pub fn is_system_component(name: &str) -> bool {
    const EXACT: &[&str] = &[
        "gnome-shell",
        "org.gnome.shell",
        "org.gnome.shell.extensions",
        "mutter-x11-frames",
        "plasmashell",
        "org.kde.plasmashell",
        // Plasma's launcher, session, splash, lock screen, clipboard and background services.
        "krunner",
        "org.kde.krunner",
        "ksmserver",
        "ksplashqml",
        "org.kde.ksplashqml",
        "kscreenlocker_greet",
        "klipper",
        "org.kde.klipper",
        "kactivitymanagerd",
        "kaccess",
        "kscreen_osd_service",
        "org_kde_powerdevil",
        "xembedsniproxy",
        "gmenudbusmenuproxy",
        "xwaylandvideobridge",
        "org.kde.xwaylandvideobridge",
        "xwayland",
        "gnome-shell-calendar-server",
        "evolution-alarm-notify",
        "org.gnome.evolution-alarm-notify",
        "waybar",
        "mako",
        "swaync",
        "hyprpaper",
        "hypridle",
        "hyprlock",
        "walker",
        "wofi",
        "rofi",
        "fuzzel",
        "tofi",
        "swaybg",
        "swaylock",
        "swayidle",
        "lxpolkit",
    ];
    const PREFIXES: &[&str] = &[
        "kwin",
        "org.kde.kwin",
        "kded",
        "org.kde.kded",
        "kglobalaccel",
        "org.kde.kglobalaccel",
        "kiod",
        "org.kde.kiod",
        "xdg-desktop-portal",
        "org.freedesktop.impl.portal",
        "at-spi",
        "ibus",
        "org.freedesktop.ibus",
        "gsd-",
        "org.gnome.settingsdaemon",
    ];
    let name = name.trim().to_lowercase();
    let name = name.strip_suffix(".desktop").unwrap_or(&name);
    !name.is_empty()
        && (EXACT.contains(&name) || PREFIXES.iter().any(|prefix| name.starts_with(prefix)) || name.contains("polkit"))
}

pub fn system_component_message(name: &str) -> String {
    format!(
        "{name} is part of the desktop itself (its shell, a portal or a system service), not an app computer use operates. Name an app instead; screen_apps lists them."
    )
}

fn exact(candidate: &Candidate, wanted: &str) -> bool {
    let id = candidate.id.to_lowercase();
    id == wanted || candidate.name.to_lowercase() == wanted || id.rsplit('.').next() == Some(wanted) && id.contains('.')
}

fn partial(candidate: &Candidate, wanted: &str) -> bool {
    candidate.name.to_lowercase().contains(wanted) || candidate.id.to_lowercase().contains(wanted)
}

/// Running apps are listed before installed ones; an app both running and installed is one
/// candidate (its running entry).
pub fn resolve(query: &str, candidates: &[Candidate]) -> CuResult<Candidate> {
    let wanted = query.trim().to_lowercase();
    if wanted.is_empty() {
        return Err(CuError::new(
            "app_not_found",
            "Name an app, e.g. \"Calculator\" or \"org.gnome.TextEditor\".",
        ));
    }
    if is_system_component(&wanted) {
        return Err(CuError::new("app_not_allowed", system_component_message(query.trim())));
    }
    let mut unique: Vec<&Candidate> = Vec::new();
    for candidate in candidates {
        if is_system_component(&candidate.id) {
            continue;
        }
        if !unique.iter().any(|c| c.id == candidate.id) {
            unique.push(candidate);
        }
    }
    if let Some(found) = unique
        .iter()
        .find(|c| c.running && exact(c, &wanted))
        .or_else(|| unique.iter().find(|c| exact(c, &wanted)))
    {
        return Ok((*found).clone());
    }
    let matches: Vec<&&Candidate> = unique.iter().filter(|c| partial(c, &wanted)).collect();
    match matches.as_slice() {
        [] => Err(CuError::new(
            "app_not_found",
            format!(
                "No installed app matches \"{query}\". Call screen_apps with a shorter query to see what is installed."
            ),
        )),
        [only] => Ok((**only).clone()),
        many => {
            let listed: Vec<String> = many.iter().take(12).map(|c| format!("{} ({})", c.name, c.id)).collect();
            Err(CuError::new(
                "app_ambiguous",
                format!(
                    "\"{query}\" matches several apps: {}. Pass the exact name or app id.",
                    listed.join(", ")
                ),
            ))
        }
    }
}

/// `apps {query}`: running apps that match, then up to 50 installed ones (none without a query).
pub fn listing(query: Option<&str>, running: &[Candidate], installed: &[Candidate]) -> Vec<Candidate> {
    let wanted = query.map(|q| q.trim().to_lowercase()).unwrap_or_default();
    let matches = |c: &Candidate| !is_system_component(&c.id) && (wanted.is_empty() || partial(c, &wanted));
    let mut rows: Vec<Candidate> = running.iter().filter(|c| matches(c)).cloned().collect();
    if wanted.is_empty() {
        return rows;
    }
    let mut extra: Vec<Candidate> = installed
        .iter()
        .filter(|c| matches(c) && !running.iter().any(|r| r.id == c.id))
        .cloned()
        .collect();
    extra.sort_by_key(|c| c.name.to_lowercase());
    extra.dedup_by(|a, b| a.id == b.id);
    rows.extend(extra.into_iter().take(50));
    rows
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate(id: &str, name: &str, running: bool) -> Candidate {
        Candidate {
            id: id.into(),
            name: name.into(),
            running,
        }
    }

    fn world() -> Vec<Candidate> {
        vec![
            candidate("org.gnome.Calculator", "Calculator", true),
            candidate("org.gnome.TextEditor", "Text Editor", false),
            candidate("org.xfce.mousepad", "Mousepad", false),
            candidate("org.gnome.Calculator", "Calculator", false),
        ]
    }

    #[test]
    fn exact_ids_names_and_short_ids_resolve_case_insensitively() {
        assert_eq!(resolve("calculator", &world()).unwrap().id, "org.gnome.Calculator");
        assert!(resolve("calculator", &world()).unwrap().running);
        assert_eq!(
            resolve("ORG.GNOME.TEXTEDITOR", &world()).unwrap().id,
            "org.gnome.TextEditor"
        );
        assert_eq!(resolve("texteditor", &world()).unwrap().id, "org.gnome.TextEditor");
    }

    #[test]
    fn a_single_partial_match_resolves_and_several_are_listed() {
        assert_eq!(resolve("mouse", &world()).unwrap().id, "org.xfce.mousepad");
        let error = resolve("org.gnome", &world()).unwrap_err();
        assert_eq!(error.code, "app_ambiguous");
        assert!(
            error
                .message
                .contains("Calculator (org.gnome.Calculator), Text Editor (org.gnome.TextEditor)")
        );
        assert_eq!(resolve("photoshop", &world()).unwrap_err().code, "app_not_found");
    }

    #[test]
    fn desktop_shells_portals_bars_and_agents_are_not_apps() {
        for name in [
            "gnome-shell",
            "org.gnome.Shell.desktop",
            "mutter-x11-frames",
            "plasmashell",
            "kwin_wayland",
            "kwin_x11",
            "krunner",
            "org.kde.krunner.desktop",
            "kded6",
            "org.kde.kded6",
            "kglobalacceld",
            "ksmserver",
            "ksplashqml",
            "kscreenlocker_greet",
            "klipper",
            "xembedsniproxy",
            "xdg-desktop-portal-gnome",
            "Xwayland",
            "at-spi2-registryd",
            "ibus-daemon",
            "gnome-shell-calendar-server",
            "evolution-alarm-notify",
            "gsd-media-keys",
            "polkit-gnome-authentication-agent-1",
            "hyprpolkitagent",
            "waybar",
            "mako",
            "swaync",
            "hyprpaper",
            "hypridle",
            "hyprlock",
            "walker",
            "wofi",
            "rofi",
            "swaybg",
        ] {
            assert!(is_system_component(name), "{name}");
        }
        for name in [
            "org.gnome.Calculator",
            "firefox",
            "org.kde.kate",
            "org.kde.kcalc",
            "org.kde.dolphin",
            "org.kde.kwrite",
            "code",
            "Mako Studio Pro",
        ] {
            assert!(!is_system_component(name), "{name}");
        }
    }

    #[test]
    fn the_shell_is_refused_by_name_and_left_out_of_listings() {
        let mut apps = world();
        apps.push(candidate("gnome-shell", "gnome-shell", true));
        let refused = resolve("GNOME-Shell", &apps).unwrap_err();
        assert_eq!(refused.code, "app_not_allowed");
        assert!(refused.message.contains("part of the desktop itself"));
        // A partial query never lands on it either.
        assert_eq!(resolve("shell", &apps).unwrap_err().code, "app_not_found");
        let running = vec![
            candidate("gnome-shell", "gnome-shell", true),
            candidate("org.gnome.Calculator", "Calculator", true),
        ];
        assert_eq!(listing(None, &running, &[]).len(), 1);
    }

    #[test]
    fn listing_shows_installed_apps_only_for_a_query() {
        let running = vec![candidate("org.gnome.Calculator", "Calculator", true)];
        let installed = world()
            .into_iter()
            .map(|c| Candidate { running: false, ..c })
            .collect::<Vec<_>>();
        assert_eq!(listing(None, &running, &installed).len(), 1);
        let found = listing(Some("o"), &running, &installed);
        assert_eq!(
            found.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
            vec!["org.gnome.Calculator", "org.xfce.mousepad", "org.gnome.TextEditor"]
        );
    }
}
