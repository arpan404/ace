//! Naming an app: exact id or name first, then a single partial match. Pure.
//!
//! An app's id (`bundleId` on the wire) is its AppUserModelID when it is a packaged app
//! (`Microsoft.WindowsCalculator_8wekyb3d8bbwe!App`), and otherwise its executable's file name
//! in lower case (`notepad.exe`). The Start menu's entries resolve to the same ids, so a running
//! app and its Start entry are one app.
use super::error::{CuError, CuResult};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Candidate {
    pub id: String,
    pub name: String,
    pub running: bool,
}

/// Parts of Windows itself that show windows but are not apps an agent may operate: the shell's
/// surfaces (taskbar, Start, search, notifications, lock screen), input and frame hosts, and
/// the desktop window manager. Matched on the id, case-insensitive.
pub fn is_system_component(id: &str) -> bool {
    const EXECUTABLES: &[&str] = &[
        "shellexperiencehost.exe",
        "startmenuexperiencehost.exe",
        "searchhost.exe",
        "searchapp.exe",
        "searchui.exe",
        "textinputhost.exe",
        "lockapp.exe",
        "applicationframehost.exe",
        "dwm.exe",
        "csrss.exe",
        "winlogon.exe",
        "sihost.exe",
        "ctfmon.exe",
        "widgets.exe",
        "widgetboard.exe",
        "shellhost.exe",
        "systemsettingsbroker.exe",
        "runtimebroker.exe",
        "taskhostw.exe",
        "smartscreen.exe",
    ];
    const PACKAGES: &[&str] = &[
        "microsoft.windows.shellexperiencehost_",
        "microsoft.windows.startmenuexperiencehost_",
        "microsoft.windows.search_",
        "microsoft.windows.cortana_",
        "microsoftwindows.client.cbs_",
        "microsoftwindows.client.core_",
        "microsoft.lockapp_",
        "microsoft.windows.lockapp_",
        "microsoftwindows.lkg.",
        "microsoft.windowsinputexperience_",
        "microsoftwindows.inputapp_",
    ];
    let id = id.trim().to_lowercase();
    !id.is_empty()
        && (EXECUTABLES.contains(&id.as_str()) || PACKAGES.iter().any(|p| id.starts_with(p)))
}

pub fn system_component_message(name: &str) -> String {
    format!(
        "{name} is part of Windows itself (its taskbar, Start, search or another shell surface), not an app computer use operates. Name an app instead; screen_apps lists them."
    )
}

/// The id a Win32 app is known by: its executable's file name in lower case.
pub fn executable_id(path: &str) -> String {
    path.rsplit(['\\', '/'])
        .next()
        .unwrap_or(path)
        .trim()
        .to_lowercase()
}

/// A readable name for an executable without a Start entry or version description.
pub fn executable_name(id: &str) -> String {
    let stem = id.strip_suffix(".exe").unwrap_or(id);
    let mut chars = stem.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => id.to_owned(),
    }
}

fn exact(candidate: &Candidate, wanted: &str) -> bool {
    let id = candidate.id.to_lowercase();
    id == wanted
        || candidate.name.to_lowercase() == wanted
        || id.strip_suffix(".exe") == Some(wanted)
        || id
            .split('!')
            .next()
            .is_some_and(|family| family == wanted || family.split('_').next() == Some(wanted))
            && id.contains('!')
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
            "Name an app, e.g. \"Notepad\", \"notepad.exe\" or \"Microsoft.WindowsCalculator_8wekyb3d8bbwe!App\".",
        ));
    }
    if is_system_component(&wanted) {
        return Err(CuError::new(
            "app_not_allowed",
            system_component_message(query.trim()),
        ));
    }
    // An exact name wins even when another entry for the same app came first (a Start
    // shortcut that opens a folder also points at explorer.exe).
    if let Some(found) = candidates
        .iter()
        .filter(|c| !is_system_component(&c.id))
        .find(|c| c.name.to_lowercase() == wanted)
    {
        let running = candidates
            .iter()
            .any(|c| c.running && c.id.eq_ignore_ascii_case(&found.id));
        return Ok(Candidate {
            running,
            ..found.clone()
        });
    }
    let mut unique: Vec<&Candidate> = Vec::new();
    for candidate in candidates {
        if is_system_component(&candidate.id) {
            continue;
        }
        if !unique
            .iter()
            .any(|c| c.id.eq_ignore_ascii_case(&candidate.id))
        {
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
    let matches: Vec<&Candidate> = unique
        .iter()
        .copied()
        .filter(|c| partial(c, &wanted))
        .collect();
    // Several matches where exactly one is running: that is the one the model sees.
    let running: Vec<&Candidate> = matches.iter().copied().filter(|c| c.running).collect();
    match (matches.as_slice(), running.as_slice()) {
        ([], _) => Err(CuError::new(
            "app_not_found",
            format!(
                "No running or Start menu app matches \"{query}\". Call screen_apps with a shorter query to see what is installed, or pass the full path of an .exe."
            ),
        )),
        ([only], _) | (_, [only]) => Ok((*only).clone()),
        (many, _) => {
            let listed: Vec<String> = many
                .iter()
                .take(12)
                .map(|c| format!("{} ({})", c.name, c.id))
                .collect();
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
pub fn listing(
    query: Option<&str>,
    running: &[Candidate],
    installed: &[Candidate],
) -> Vec<Candidate> {
    let wanted = query
        .map(|q| q.trim().to_lowercase())
        .filter(|q| !q.is_empty());
    let matches = |c: &Candidate| wanted.as_ref().is_none_or(|w| partial(c, w));
    let mut rows: Vec<Candidate> = Vec::new();
    for candidate in running {
        if !is_system_component(&candidate.id)
            && matches(candidate)
            && !rows
                .iter()
                .any(|r| r.id.eq_ignore_ascii_case(&candidate.id))
        {
            rows.push(candidate.clone());
        }
    }
    if wanted.is_some() {
        let mut extra = 0;
        for candidate in installed {
            if extra >= 50 {
                break;
            }
            if !is_system_component(&candidate.id)
                && matches(candidate)
                && !rows
                    .iter()
                    .any(|r| r.id.eq_ignore_ascii_case(&candidate.id))
            {
                rows.push(Candidate {
                    running: false,
                    ..candidate.clone()
                });
                extra += 1;
            }
        }
    }
    rows
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app(id: &str, name: &str, running: bool) -> Candidate {
        Candidate {
            id: id.into(),
            name: name.into(),
            running,
        }
    }

    fn apps() -> Vec<Candidate> {
        vec![
            app("notepad.exe", "Notepad", true),
            app(
                "microsoft.windowscalculator_8wekyb3d8bbwe!app",
                "Calculator",
                false,
            ),
            app("code.exe", "Visual Studio Code", false),
            app("notepad.exe", "Notepad", false),
            app("winword.exe", "Word", false),
            app("wordpad.exe", "WordPad", false),
        ]
    }

    #[test]
    fn exact_names_ids_and_executable_stems_resolve() {
        assert_eq!(resolve("notepad", &apps()).unwrap().id, "notepad.exe");
        assert!(resolve("Notepad", &apps()).unwrap().running);
        assert_eq!(resolve("NOTEPAD.EXE", &apps()).unwrap().id, "notepad.exe");
        assert_eq!(
            resolve("calculator", &apps()).unwrap().id,
            "microsoft.windowscalculator_8wekyb3d8bbwe!app"
        );
        assert_eq!(
            resolve("Microsoft.WindowsCalculator", &apps())
                .unwrap()
                .name,
            "Calculator"
        );
        assert_eq!(resolve("studio", &apps()).unwrap().id, "code.exe");
    }

    #[test]
    fn an_exact_name_finds_its_app_behind_another_entry_with_the_same_id() {
        let entries = vec![
            app("explorer.exe", "Windows Software Development Kit", false),
            app("explorer.exe", "File Explorer", false),
            app("explorer.exe", "Windows Explorer", true),
        ];
        let found = resolve("file explorer", &entries).unwrap();
        assert_eq!(
            (found.id.as_str(), found.name.as_str()),
            ("explorer.exe", "File Explorer")
        );
        assert!(found.running);
    }

    #[test]
    fn several_partial_matches_are_listed_for_the_model() {
        let error = resolve("wor", &apps()).unwrap_err();
        assert_eq!(error.code, "app_ambiguous");
        assert!(error.message.contains("Word (winword.exe)"));
        assert!(error.message.contains("WordPad (wordpad.exe)"));
        assert_eq!(resolve("zzz", &apps()).unwrap_err().code, "app_not_found");
    }

    #[test]
    fn shell_surfaces_are_never_targets() {
        let error = resolve("SearchHost.exe", &apps()).unwrap_err();
        assert_eq!(error.code, "app_not_allowed");
        let shell = vec![app("startmenuexperiencehost.exe", "Start", true)];
        assert_eq!(resolve("start", &shell).unwrap_err().code, "app_not_found");
        assert!(is_system_component(
            "Microsoft.Windows.ShellExperienceHost_cw5n1h2txyewy!App"
        ));
        assert!(!is_system_component("explorer.exe"));
    }

    #[test]
    fn listings_show_running_apps_and_search_installed_ones_by_query() {
        let running = vec![app("notepad.exe", "Notepad", true)];
        let installed = apps();
        assert_eq!(listing(None, &running, &installed).len(), 1);
        let found = listing(Some("note"), &running, &installed);
        assert_eq!(found.len(), 1);
        assert!(found[0].running);
        let words = listing(Some("word"), &running, &installed);
        assert_eq!(
            words.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
            ["winword.exe", "wordpad.exe"]
        );
    }

    #[test]
    fn executables_are_known_by_their_lowercase_file_name() {
        assert_eq!(
            executable_id(r"C:\Windows\System32\NOTEPAD.EXE"),
            "notepad.exe"
        );
        assert_eq!(executable_name("computer_fixture.exe"), "Computer_fixture");
    }
}
