// SPDX-License-Identifier: Apache-2.0
//! `boot` and `shutdown`: which command boots or powers off a device, or the refusal that stops
//! it. The shell still owns the emulator process, its console port and the waits for adb.

use super::commands::native_id;
use super::emulator::boot_args;
use super::{Error, Platform, Refusal, Step, StepKind};

/// The first and last emulator console ports ace gives a boot.
const FIRST_PORT: u16 = 5554;
const LAST_PORT: u16 = 5682;

/// A Simulator boot: boot it unless it already is, then show its window without taking focus.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct IosBoot {
    pub boot: bool,
    pub show: Vec<String>,
}

/// `Simulators.boot`: the UDID must name a Simulator; a booted one only needs its window shown.
pub fn ios_boot(id: &str, booted: bool) -> Result<IosBoot, Error> {
    let udid = native_id(id, Platform::Ios)?;
    Ok(IosBoot {
        boot: !booted,
        show: vec![
            "-g".to_string(),
            "-a".to_string(),
            "Simulator".to_string(),
            "--args".to_string(),
            "-CurrentDeviceUDID".to_string(),
            udid,
        ],
    })
}

/// What the shell knows when it asks to boot an emulator.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct AndroidFacts {
    pub avd: String,
    /// adb serials already connected (`emulator-5554` and so on).
    pub used_serials: Vec<String>,
    /// Console ports an ace-started emulator already holds.
    pub taken_ports: Vec<u16>,
    /// Emulators already spawned.
    pub running: usize,
    pub pending: bool,
    pub closed: bool,
    pub emulator_found: bool,
    pub platform: String,
    pub arch: Option<String>,
    pub window: bool,
    pub gpu: Option<String>,
}

/// An emulator boot: its console port, the command line ace spawns, and the adb steps that wait
/// for the device and for its boot to complete.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct AndroidBoot {
    pub port: u16,
    pub serial: String,
    pub args: Vec<String>,
    pub steps: Vec<Step>,
}

/// `AndroidPlatform.boot`'s decisions: at most four emulators, an SDK that has the emulator,
/// the first free console port, and today's wait commands.
pub fn android_boot(facts: &AndroidFacts) -> Result<AndroidBoot, Error> {
    if facts.closed {
        return Err(Refusal::word("deviceServiceClosed").into());
    }
    if !facts.emulator_found {
        return Err(
            if facts.platform == "linux" && facts.arch.as_deref() == Some("arm64") {
                Refusal::word("armEmulatorNote").into()
            } else {
                Refusal::word("androidEmulatorMissing").into()
            },
        );
    }
    if facts.pending || facts.running >= 4 {
        return Err(Refusal::word("androidBootBusy").into());
    }
    let mut port = FIRST_PORT;
    while facts
        .used_serials
        .iter()
        .any(|serial| serial == &format!("emulator-{port}"))
        || facts.taken_ports.contains(&port)
    {
        port += 2;
    }
    if port > LAST_PORT {
        return Err(Refusal::word("androidPortLimit").into());
    }
    let serial = format!("emulator-{port}");
    Ok(AndroidBoot {
        port,
        serial,
        args: boot_args(
            &facts.avd,
            port,
            facts.window,
            &facts.platform,
            facts.gpu.as_deref(),
        ),
        steps: vec![
            Step::new(StepKind::Adb, vec!["wait-for-device".to_string()])
                .with_max_bytes(4096)
                .with_timeout(120_000),
            Step::new(
                StepKind::Adb,
                vec![
                    "shell".to_string(),
                    // The program is one raw argument, as TS passes it: adb hands it to the
                    // device's shell, which runs the loop. Quoting it would make the loop a
                    // command name.
                    "while [ \"$(getprop sys.boot_completed)\" != 1 ]; do sleep 1; done"
                        .to_string(),
                ],
            )
            .with_max_bytes(4096)
            .with_timeout(120_000),
        ],
    })
}

/// `shutdown`: a Simulator's `simctl shutdown`, or an emulator's console kill followed by the
/// power-off that decides it. A phone is refused by its name, so the shell keeps that refusal.
pub fn shutdown(platform: Platform) -> Vec<Step> {
    match platform {
        Platform::Ios => vec![Step::new(StepKind::Simctl, vec!["shutdown".to_string()])],
        Platform::Android => vec![
            Step::new(
                StepKind::Adb,
                ["emu", "kill"]
                    .iter()
                    .map(|part| part.to_string())
                    .collect(),
            ),
            Step::new(
                StepKind::Adb,
                ["shell", "reboot", "-p"]
                    .iter()
                    .map(|part| part.to_string())
                    .collect(),
            )
            .with_max_bytes(4096)
            .with_timeout(10_000),
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const UDID: &str = "11111111-1111-4111-8111-111111111111";

    fn facts() -> AndroidFacts {
        AndroidFacts {
            avd: "Pixel_API_35".to_string(),
            used_serials: vec!["emulator-5554".to_string()],
            taken_ports: Vec::new(),
            running: 0,
            pending: false,
            closed: false,
            emulator_found: true,
            platform: "darwin".to_string(),
            arch: Some("arm64".to_string()),
            window: false,
            gpu: None,
        }
    }

    #[test]
    fn a_booted_simulator_only_needs_its_window_shown() {
        let boot = ios_boot(&format!("ios:{UDID}"), true).expect("booted");
        assert!(!boot.boot);
        assert_eq!(
            boot.show,
            vec![
                "-g",
                "-a",
                "Simulator",
                "--args",
                "-CurrentDeviceUDID",
                UDID
            ]
        );
        assert!(
            ios_boot(&format!("ios:{UDID}"), false)
                .expect("shutdown")
                .boot
        );
    }

    #[test]
    fn an_emulator_takes_the_first_free_console_port_and_waits_for_boot() {
        let boot = android_boot(&facts()).expect("boot");
        assert_eq!(boot.port, 5556);
        assert_eq!(boot.serial, "emulator-5556");
        assert_eq!(boot.args[0], "-avd");
        assert_eq!(boot.args[2], "-port");
        assert_eq!(boot.args[3], "5556");
        assert_eq!(boot.steps.len(), 2);
        assert_eq!(boot.steps[0].kind, StepKind::Adb);
        assert_eq!(boot.steps[0].args[0], "wait-for-device");
        assert!(boot.steps[1].args[1].contains("sys.boot_completed"));
    }

    #[test]
    fn the_boot_wait_passes_the_program_to_the_device_shell_unquoted() {
        // TS (`android-platform.ts`) passes `shell` followed by the raw program; adb hands that
        // one argument to the device's shell, which runs the loop. Quoting it makes the whole
        // loop a command name the device cannot find.
        let boot = android_boot(&facts()).expect("boot");
        assert_eq!(
            boot.steps[1].args,
            vec![
                "shell".to_string(),
                "while [ \"$(getprop sys.boot_completed)\" != 1 ]; do sleep 1; done".to_string(),
            ]
        );
    }

    #[test]
    fn a_pending_or_full_emulator_set_is_refused_before_a_port_is_taken() {
        let mut pending = facts();
        pending.pending = true;
        assert_eq!(
            android_boot(&pending).expect_err("pending").to_string(),
            "busy: Emulator process limit or boot already in progress"
        );
        let mut full = facts();
        full.running = 4;
        assert_eq!(
            android_boot(&full).expect_err("full").to_string(),
            "busy: Emulator process limit or boot already in progress"
        );
        let mut no_ports = facts();
        no_ports.taken_ports = (5554..=5682).step_by(2).collect();
        assert_eq!(
            android_boot(&no_ports).expect_err("ports").to_string(),
            "limit: No emulator console port available"
        );
    }

    #[test]
    fn an_arm64_linux_host_without_an_emulator_gets_the_note_that_explains_it() {
        let mut linux = facts();
        linux.platform = "linux".to_string();
        linux.emulator_found = false;
        assert!(matches!(
            android_boot(&linux).expect_err("arm"),
            Error::Refused(refusal) if refusal.code.as_str() == "not_supported"
        ));
        let mut darwin = facts();
        darwin.emulator_found = false;
        assert_eq!(
            android_boot(&darwin).expect_err("missing").to_string(),
            "sdk_missing: The Android Emulator was not found"
        );
    }

    #[test]
    fn shutdown_keeps_todays_commands_on_both_platforms() {
        let ios = shutdown(Platform::Ios);
        assert_eq!(ios[0].kind, StepKind::Simctl);
        assert_eq!(ios[0].args, vec!["shutdown"]);
        let android = shutdown(Platform::Android);
        assert_eq!(android[0].kind, StepKind::Adb);
        assert_eq!(android[0].args, vec!["emu", "kill"]);
        assert_eq!(android[1].args, vec!["shell", "reboot", "-p"]);
    }
}
