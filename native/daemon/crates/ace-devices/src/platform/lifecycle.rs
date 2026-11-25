// SPDX-License-Identifier: Apache-2.0
//! `platform.ts`'s package lifecycle: install, open an app, open a URL and configure a device,
//! decided as the exact SDK commands `DevicePlatform` runs today. Refusals keep today's
//! `DeviceError` code, message and hint; nothing here touches a device.

use serde::{Deserialize, Serialize};

use super::budget::{INSTALL_TIMEOUT_MS, RESOLVE_ACTIVITY_MAX_BYTES};
use super::commands::adb_shell;
use super::{Error, Platform, Refusal, Step, StepKind};

/// The longest path, app id or URL a device operation takes (`Text.max(4096)`).
const TEXT_MAX: usize = 4096;
/// The longest bundle id or package/activity name (`AppId.max(256)`).
const APP_ID_MAX: usize = 256;

/// JavaScript counts UTF-16 units, so the caps do too.
fn units(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `Text`: 1 to 4096 UTF-16 units, no NUL. `None` when the value is not text a device takes.
fn text(value: &str) -> Option<&str> {
    if value.is_empty() || units(value) > TEXT_MAX || value.contains('\0') {
        return None;
    }
    Some(value)
}

fn is_app_id(value: &str) -> bool {
    let mut parts = value.splitn(2, '/');
    let Some(package) = parts.next() else {
        return false;
    };
    let activity = parts.next();
    let package_ok = !package.is_empty()
        && package
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-'));
    let activity_ok = activity.is_none_or(|activity| {
        !activity.is_empty()
            && activity.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'$' | b'-')
            })
    });
    package_ok && activity_ok
}

fn has_scheme(value: &str) -> bool {
    let Some((scheme, rest)) = value.split_once(':') else {
        return false;
    };
    let mut bytes = scheme.bytes();
    let Some(first) = bytes.next() else {
        return false;
    };
    let _ = rest;
    first.is_ascii_alphabetic()
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'.' | b'-'))
}

/// node's `extname`: the dot suffix of the last path component, empty when there is none.
fn extname(path: &str) -> &str {
    let name = path.rsplit(['/', '\\']).next().unwrap_or_default();
    match name.rfind('.') {
        Some(0) | None => "",
        Some(at) => &name[at..],
    }
}

/// `install`: `simctl install` of a Simulator-built `.app`, or `adb install -r` of an `.apk`,
/// under the ten-minute install budget.
pub fn install(platform: Platform, path: &str) -> Result<Vec<Step>, Error> {
    let Some(path) = text(path) else {
        return Err(Refusal::word("installPathInvalid").into());
    };
    if !std::path::Path::new(path).is_absolute() {
        return Err(Refusal::word("installPathRelative").into());
    }
    match platform {
        Platform::Ios => {
            if extname(path) != ".app" {
                return Err(Refusal::word("installSimulatorApp").into());
            }
            Ok(vec![
                Step::new(
                    StepKind::Simctl,
                    vec!["install".to_string(), path.to_string()],
                )
                .with_timeout(INSTALL_TIMEOUT_MS),
            ])
        }
        Platform::Android => {
            if extname(path) != ".apk" {
                return Err(Refusal::word("installAndroidApk").into());
            }
            Ok(vec![
                Step::new(
                    StepKind::Adb,
                    vec!["install".to_string(), "-r".to_string(), path.to_string()],
                )
                .with_timeout(INSTALL_TIMEOUT_MS),
            ])
        }
    }
}

/// An app launch: the commands that run, and the lookup whose output names the component.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct OpenApp {
    pub steps: Vec<Step>,
    /// `cmd package resolve-activity`: the shell runs it, then asks again with its output.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolve: Option<Step>,
}

/// `openApp`: `simctl launch`, an Android component launch, or the launcher activity an
/// Android package resolves to. `resolved` is `resolve-activity`'s output on the second call.
pub fn open_app(platform: Platform, app: &str, resolved: Option<&str>) -> Result<OpenApp, Error> {
    let Some(app) = text(app) else {
        return Err(Refusal::word("appIdInvalid").into());
    };
    if units(app) > APP_ID_MAX || !is_app_id(app) {
        return Err(Refusal::word("appIdInvalid").into());
    }
    match platform {
        Platform::Ios => Ok(OpenApp {
            steps: vec![Step::new(
                StepKind::Simctl,
                vec!["launch".to_string(), app.to_string()],
            )],
            resolve: None,
        }),
        Platform::Android if app.contains('/') => Ok(OpenApp {
            steps: vec![start_activity(app)],
            resolve: None,
        }),
        Platform::Android => match resolved {
            None => Ok(OpenApp {
                steps: Vec::new(),
                resolve: Some(
                    Step::new(
                        StepKind::Adb,
                        adb_shell(&[
                            "cmd".to_string(),
                            "package".to_string(),
                            "resolve-activity".to_string(),
                            "--brief".to_string(),
                            "-a".to_string(),
                            "android.intent.action.MAIN".to_string(),
                            "-c".to_string(),
                            "android.intent.category.LAUNCHER".to_string(),
                            app.to_string(),
                        ]),
                    )
                    .with_max_bytes(RESOLVE_ACTIVITY_MAX_BYTES),
                ),
            }),
            Some(output) => {
                let Some(component) = output.split('\n').find(|line| line.contains('/')) else {
                    return Err(Refusal::word("appNotLaunchable").into());
                };
                if units(component) > APP_ID_MAX || !is_app_id(component) {
                    return Err(Refusal::word("appNotLaunchable").into());
                }
                Ok(OpenApp {
                    steps: vec![start_activity(component)],
                    resolve: None,
                })
            }
        },
    }
}

fn start_activity(component: &str) -> Step {
    Step::new(
        StepKind::Adb,
        adb_shell(&[
            "am".to_string(),
            "start".to_string(),
            "-n".to_string(),
            component.to_string(),
        ]),
    )
}

/// `openUrl`: `simctl openurl`, or an `ACTION_VIEW` intent; the URL is data, never shell text.
pub fn open_url(platform: Platform, url: &str) -> Result<Vec<Step>, Error> {
    let Some(url) = text(url) else {
        return Err(Refusal::word("urlInvalid").into());
    };
    if !has_scheme(url) {
        return Err(Refusal::word("urlInvalid").into());
    }
    match platform {
        Platform::Ios => Ok(vec![Step::new(
            StepKind::Simctl,
            vec!["openurl".to_string(), url.to_string()],
        )]),
        Platform::Android => Ok(vec![Step::new(
            StepKind::Adb,
            adb_shell(&[
                "am".to_string(),
                "start".to_string(),
                "-a".to_string(),
                "android.intent.action.VIEW".to_string(),
                "-d".to_string(),
                url.to_string(),
            ]),
        )]),
    }
}

/// A point as `DeviceSettings.location` carries it.
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct LatLng {
    pub latitude: f64,
    pub longitude: f64,
}

/// `configure`'s settings, already decoded by the protocol schema.
#[derive(Debug, Clone, Deserialize)]
pub struct Settings {
    #[serde(default)]
    pub appearance: Option<String>,
    #[serde(default)]
    pub location: Option<LatLng>,
    #[serde(default)]
    pub locale: Option<String>,
}

fn js_number(value: f64) -> String {
    let mut out = String::new();
    ace_json::write_number(&mut out, value);
    out
}

/// `configure`: appearance and location, in today's order; a locale is refused before either
/// runs, and a phone's location is refused because only an emulator's can be set.
pub fn configure(
    platform: Platform,
    settings: &Settings,
    physical: bool,
) -> Result<Vec<Step>, Error> {
    if settings.locale.is_some() {
        return Err(Refusal::word("localeUnsupported").into());
    }
    let mut steps = Vec::new();
    match platform {
        Platform::Ios => {
            if let Some(appearance) = &settings.appearance {
                steps.push(Step::new(
                    StepKind::Simctl,
                    vec![
                        "ui".to_string(),
                        "appearance".to_string(),
                        appearance.clone(),
                    ],
                ));
            }
            if let Some(location) = &settings.location {
                steps.push(Step::new(
                    StepKind::Simctl,
                    vec![
                        "location".to_string(),
                        "set".to_string(),
                        format!(
                            "{},{}",
                            js_number(location.latitude),
                            js_number(location.longitude)
                        ),
                    ],
                ));
            }
        }
        Platform::Android => {
            if let Some(appearance) = &settings.appearance {
                let night = if appearance == "dark" { "yes" } else { "no" };
                steps.push(Step::new(
                    StepKind::Adb,
                    adb_shell(&[
                        "cmd".to_string(),
                        "uimode".to_string(),
                        "night".to_string(),
                        night.to_string(),
                    ]),
                ));
            }
            if let Some(location) = &settings.location {
                if physical {
                    return Err(Refusal::word("locationPhysical").into());
                }
                steps.push(Step::new(
                    StepKind::Adb,
                    vec![
                        "emu".to_string(),
                        "geo".to_string(),
                        "fix".to_string(),
                        js_number(location.longitude),
                        js_number(location.latitude),
                    ],
                ));
            }
        }
    }
    Ok(steps)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(step: &Step) -> String {
        step.args.join(" ")
    }

    fn settings(js: &str) -> Settings {
        serde_json::from_str(js).expect("settings")
    }

    /// The ten-minute budget spelled here, so a changed production constant fails these tests.
    const INSTALL_BUDGET_FOR_TEST: u64 = 600_000;

    #[test]
    fn a_simulator_installs_a_built_app_under_the_ten_minute_budget() {
        let steps = install(Platform::Ios, "/tmp/Example.app").expect("install");
        assert_eq!(steps[0].kind, StepKind::Simctl);
        assert_eq!(args(&steps[0]), "install /tmp/Example.app");
        assert_eq!(steps[0].timeout_ms, Some(INSTALL_BUDGET_FOR_TEST));
    }

    #[test]
    fn an_ipa_or_a_relative_path_is_refused_before_simctl_runs() {
        let ipa = install(Platform::Ios, "/tmp/Example.ipa").expect_err("ipa");
        assert!(matches!(ipa, Error::Refused(Refusal { code, hint, .. })
                if code.as_str() == "not_supported" && hint.contains("Simulator")));
        let relative = install(Platform::Android, "Example.apk").expect_err("relative");
        assert!(matches!(relative, Error::Refused(Refusal { message, .. })
                if message == "Device install path must be absolute"));
        let traversal = install(Platform::Android, "/tmp/Example.apk\0").expect_err("nul");
        assert!(matches!(traversal, Error::Refused(Refusal { message, .. })
                if message == "Device install path is not valid"));
    }

    #[test]
    fn an_android_install_replaces_the_package_on_the_emulators_transport() {
        let steps = install(Platform::Android, "/tmp/Example.apk").expect("install");
        assert_eq!(steps[0].kind, StepKind::Adb);
        assert_eq!(args(&steps[0]), "install -r /tmp/Example.apk");
        assert_eq!(steps[0].timeout_ms, Some(INSTALL_BUDGET_FOR_TEST));
    }

    #[test]
    fn a_simulator_app_launches_by_its_bundle_id() {
        let open = open_app(Platform::Ios, "dev.example", None).expect("launch");
        assert!(open.resolve.is_none());
        assert_eq!(args(&open.steps[0]), "launch dev.example");
    }

    #[test]
    fn an_android_component_launches_and_a_package_resolves_first() {
        let component =
            open_app(Platform::Android, "dev.example/.MainActivity", None).expect("component");
        assert_eq!(
            args(&component.steps[0]),
            "shell 'am' 'start' '-n' 'dev.example/.MainActivity'"
        );

        let resolve = open_app(Platform::Android, "dev.example", None).expect("resolve");
        assert!(resolve.steps.is_empty());
        let lookup = resolve.resolve.expect("lookup step");
        assert_eq!(lookup.max_bytes, Some(RESOLVE_ACTIVITY_MAX_BYTES));
        assert!(args(&lookup).starts_with("shell 'cmd' 'package' 'resolve-activity' '--brief'"));

        let started = open_app(
            Platform::Android,
            "dev.example",
            Some("dev.example/.MainActivity\n"),
        )
        .expect("started");
        assert_eq!(
            args(&started.steps[0]),
            "shell 'am' 'start' '-n' 'dev.example/.MainActivity'"
        );
    }

    #[test]
    fn an_app_with_no_launchable_activity_is_refused_rather_than_launched_blank() {
        for output in ["", "no activity found\n", "dev.example/not an activity\n"] {
            let refused =
                open_app(Platform::Android, "dev.example", Some(output)).expect_err(output);
            assert!(
                matches!(refused, Error::Refused(Refusal { code, .. }) if code.as_str() == "not_found")
            );
        }
    }

    #[test]
    fn a_resolved_activity_longer_than_the_256_unit_app_id_is_not_launched() {
        let component = format!("{}/.{}", "a".repeat(256), "b".repeat(256));
        let refused = open_app(Platform::Android, "dev.example", Some(&component))
            .expect_err("over 256 units");
        assert!(matches!(refused, Error::Refused(Refusal { message, .. })
                if message == "Android app has no launchable activity"));
    }

    #[test]
    fn an_app_id_the_protocol_does_not_take_is_refused() {
        for app in [
            "",
            "dev example",
            "dev.example/activity with space",
            "a".repeat(257).as_str(),
        ] {
            let refused = open_app(Platform::Ios, app, None).expect_err(app);
            assert!(matches!(refused, Error::Refused(Refusal { message, .. })
                    if message == "Device app identifier is not valid"));
        }
    }

    #[test]
    fn a_url_is_data_the_emulator_shell_never_interprets() {
        let url = "example://inbox; /usr/bin/touch /tmp/marker";
        let steps = open_url(Platform::Android, url).expect("open");
        assert_eq!(
            args(&steps[0]),
            format!("shell 'am' 'start' '-a' 'android.intent.action.VIEW' '-d' '{url}'")
        );
    }

    #[test]
    fn a_url_without_a_scheme_is_refused() {
        for url in ["", "inbox ://x", "/tmp/x", "1example:x"] {
            let refused = open_url(Platform::Ios, url).expect_err(url);
            assert!(
                matches!(refused, Error::Refused(Refusal { code, .. }) if code.as_str() == "invalid_data")
            );
        }
    }

    #[test]
    fn a_locale_is_refused_before_appearance_or_location_runs() {
        let refused = configure(
            Platform::Ios,
            &settings(r#"{"locale":"fr-FR","appearance":"dark"}"#),
            false,
        )
        .expect_err("locale");
        assert!(
            matches!(refused, Error::Refused(Refusal { hint, .. }) if hint.contains("Settings"))
        );
    }

    #[test]
    fn a_simulator_sets_appearance_then_a_location_the_way_simctl_spells_it() {
        let steps = configure(
            Platform::Ios,
            &settings(r#"{"appearance":"dark","location":{"latitude":41,"longitude":-87}}"#),
            false,
        )
        .expect("configure");
        assert_eq!(steps.len(), 2);
        assert_eq!(args(&steps[0]), "ui appearance dark");
        assert_eq!(args(&steps[1]), "location set 41,-87");
        assert_eq!(steps[1].kind, StepKind::Simctl);
    }

    #[test]
    fn an_emulator_sets_night_mode_and_its_location_by_console() {
        let steps = configure(
            Platform::Android,
            &settings(r#"{"appearance":"dark","location":{"latitude":41.5,"longitude":-87.25}}"#),
            false,
        )
        .expect("configure");
        assert_eq!(args(&steps[0]), "shell 'cmd' 'uimode' 'night' 'yes'");
        assert_eq!(args(&steps[1]), "emu geo fix -87.25 41.5");
        assert_eq!(steps[1].kind, StepKind::Adb);
    }

    #[test]
    fn a_phones_location_is_refused_after_appearance_would_have_run() {
        let refused = configure(
            Platform::Android,
            &settings(r#"{"appearance":"light","location":{"latitude":1,"longitude":2}}"#),
            true,
        )
        .expect_err("physical");
        assert!(matches!(refused, Error::Refused(Refusal { message, .. })
                if message == "Only an emulator's location can be set"));
    }

    #[test]
    fn extname_matches_nodes_for_packages_and_dotfiles() {
        assert_eq!(extname("/tmp/Example.app"), ".app");
        assert_eq!(extname("/tmp/.hidden"), "");
        assert_eq!(extname("/tmp/dir.d/Example"), "");
        assert_eq!(extname("Example.apk"), ".apk");
    }
}
