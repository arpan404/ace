// SPDX-License-Identifier: Apache-2.0
//! `scrcpy-server.ts`'s decisions, beside the code they name: the push, forward and spawn plan,
//! the forward's port, the greeting's name, and today's startup errors.

use super::*;

fn profile(video: bool) -> ServerProfile {
    ServerProfile {
        scid: 0x1234,
        max_size: 1280.0,
        bitrate: 8_000_000.0,
        fps: 60.0,
        video,
    }
}

#[test]
fn a_video_server_is_pushed_forwarded_and_spawned_with_todays_arguments_and_caps() {
    let plan = tunnel_plan(
        "emulator-5554",
        "/tools/scrcpy-server-v5.0.1",
        &profile(true),
        "5.0.1",
    );
    assert_eq!(plan.socket, "scrcpy_00001234");
    assert_eq!(plan.remote_jar, "/data/local/tmp/ace-scrcpy_00001234.jar");
    assert_eq!(
        plan.push,
        CommandPlan {
            args: vec![
                "push".to_string(),
                "/tools/scrcpy-server-v5.0.1".to_string(),
                "/data/local/tmp/ace-scrcpy_00001234.jar".to_string()
            ],
            max_bytes: 64 * 1024,
            timeout_ms: 60_000
        }
    );
    assert_eq!(
        plan.forward,
        CommandPlan {
            args: vec![
                "forward".to_string(),
                "tcp:0".to_string(),
                "localabstract:scrcpy_00001234".to_string()
            ],
            max_bytes: 4096,
            timeout_ms: 10_000
        }
    );
    assert_eq!(
        plan.spawn_args,
        vec![
            "-s".to_string(),
            "emulator-5554".to_string(),
            "shell".to_string(),
            "CLASSPATH=/data/local/tmp/ace-scrcpy_00001234.jar app_process / com.genymobile.scrcpy.Server 5.0.1 scid=00001234 log_level=warn video=true audio=false control=true tunnel_forward=true video_codec=h264 max_size=1280 video_bit_rate=8000000 max_fps=60 clipboard_autosync=false cleanup=true power_on=false stay_awake=false show_touches=false".to_string()
        ]
    );
    assert_eq!(plan.spawn_name, "device-scrcpy");
    assert_eq!(
        plan.remove_forward(4242),
        CommandPlan {
            args: vec![
                "forward".to_string(),
                "--remove".to_string(),
                "tcp:4242".to_string()
            ],
            max_bytes: 4096,
            timeout_ms: 5_000
        }
    );
}

#[test]
fn a_control_only_server_asks_for_no_video_arguments() {
    let plan = tunnel_plan("emulator-5554", "/jar", &profile(false), "5.0.1");
    let command = &plan.spawn_args[3];
    assert!(command.contains("video=false"));
    assert!(!command.contains("video_codec"));
    assert!(!command.contains("max_size"));
    assert!(!command.contains("video_bit_rate"));
    assert!(!command.contains("max_fps"));
}

#[test]
fn the_forward_port_is_the_number_adb_printed_or_nothing_usable() {
    assert_eq!(forward_port(" 1234\n"), Some(1234));
    assert_eq!(forward_port("1.0"), Some(1));
    assert_eq!(forward_port("1e3"), Some(1000));
    assert_eq!(forward_port("0"), None);
    assert_eq!(forward_port("65536"), None);
    assert_eq!(forward_port("abc"), None);
    assert_eq!(forward_port("  "), None);
}

#[test]
fn the_greeting_is_the_64_byte_name_cut_at_nul_and_the_bytes_after_it() {
    let mut meta = vec![b'P'; 64];
    meta[9..64].fill(0);
    meta.extend([1, 2, 3]);
    let read = greeting(&meta);
    assert_eq!(read.device_name, "PPPPPPPPP");
    assert_eq!(read.rest, vec![1, 2, 3]);
    // No NUL: the whole 64 bytes are the name.
    let full = greeting(&[b'N'; 64]);
    assert_eq!(full.device_name.len(), 64);
    assert!(full.rest.is_empty());
    // A short read still names what it can, and carries nothing after.
    let short = greeting(b"Pixel");
    assert_eq!(short.device_name, "Pixel");
    assert!(short.rest.is_empty());
}

#[test]
fn a_failure_to_start_names_the_servers_last_line_and_today_s_next_step() {
    let said = "first line\n  the device said no  \n";
    let error = did_not_start(said);
    match error {
        Error::Failed(failure) => {
            assert_eq!(failure.code, Code::CommandFailed);
            assert_eq!(
                failure.message,
                "scrcpy-server did not start:   the device said no"
            );
            assert_eq!(
                failure.hint,
                "Use an Android 5 or later device or emulator image, or stop other screen mirroring tools."
            );
        }
        other => panic!("unexpected error: {other}"),
    }
    match did_not_start("  ") {
        Error::Failed(failure) => assert_eq!(failure.message, "scrcpy-server did not start"),
        other => panic!("unexpected error: {other}"),
    }
    match closed_during_startup() {
        Error::Failed(failure) => {
            assert_eq!(failure.message, "scrcpy-server closed during startup");
            assert_eq!(failure.hint, "Start the device view again.");
        }
        other => panic!("unexpected error: {other}"),
    }
    match push_failed() {
        Error::Failed(failure) => {
            assert_eq!(
                failure.message,
                "Could not copy scrcpy-server to the device"
            )
        }
        other => panic!("unexpected error: {other}"),
    }
    match forward_failed() {
        Error::Failed(failure) => {
            assert_eq!(failure.message, "adb could not forward the scrcpy socket")
        }
        other => panic!("unexpected error: {other}"),
    }
}

#[test]
fn startup_has_one_deadline_and_each_step_gets_at_least_a_millisecond() {
    let deadline = startup_deadline(1_000.0, 10_000);
    assert_eq!(deadline, 11_000.0);
    assert_eq!(remaining_ms(deadline, 1_000.0), 10_000.0);
    assert_eq!(remaining_ms(deadline, 11_000.0), 1.0);
    assert_eq!(remaining_ms(deadline, 12_000.0), 1.0);
}
