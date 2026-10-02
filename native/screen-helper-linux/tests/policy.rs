use ace_screen_helper_linux::{
    policy::{Backend, DamageGate, backend, point, portal_policy},
    portal::{read_token, save_token},
    protocol::{Request, packet},
};
use serde_json::json;
use std::{os::unix::fs::PermissionsExt, time::Duration};
#[test]
fn wayland_is_selected_even_when_xwayland_is_available() {
    assert_eq!(
        backend(None, Some("wayland-0"), Some(":1")).unwrap(),
        Backend::Wayland
    );
    assert_eq!(
        backend(Some("x11"), Some("wayland-0"), Some(":1")).unwrap(),
        Backend::X11
    );
    assert!(
        backend(None, Some(""), None)
            .unwrap_err()
            .message
            .contains("headless")
    );
    assert!(backend(Some("wayland"), None, Some(":1")).is_err());
}
#[test]
fn unchanged_targets_sleep_without_a_timer_and_damage_is_coalesced_at_the_fps_cap() {
    let mut gate = DamageGate::new(10);
    assert!(gate.take(Duration::ZERO));
    assert_eq!(gate.wait(Duration::ZERO), None);
    assert!(!gate.take(Duration::from_secs(60)));
    gate.damage();
    gate.damage();
    assert!(!gate.take(Duration::from_millis(99)));
    assert_eq!(
        gate.wait(Duration::from_millis(99)),
        Some(Duration::from_millis(1))
    );
    assert!(gate.take(Duration::from_millis(100)));
    assert_eq!(gate.wait(Duration::from_millis(100)), None);
}
#[test]
fn coordinates_reject_edges_nonfinite_values_and_negative_positions() {
    assert_eq!(point(99., 79., 100, 80).unwrap(), (99., 79.));
    for (x, y) in [
        (100., 1.),
        (1., 80.),
        (-1., 1.),
        (f64::NAN, 1.),
        (1., f64::INFINITY),
    ] {
        assert_eq!(point(x, y, 100, 80).unwrap_err().code, "bounds");
    }
}
#[test]
fn portal_support_and_persistence_follow_advertised_versions_and_device_masks() {
    let old = portal_policy(1, 1, 1);
    assert!(!old.windows);
    assert!(old.displays);
    assert!(old.keyboard);
    assert!(!old.pointer);
    assert!(!old.persistent);
    let new = portal_policy(3, 2, 2);
    assert!(new.windows);
    assert!(new.pointer);
    assert!(!new.keyboard);
    assert!(new.persistent);
}
#[test]
fn malformed_commands_cannot_start_capture_or_exceed_the_memory_bound() {
    assert!(Request::parse(br#"{"version":2,"id":"a","op":"start","fps":31}"#).is_err());
    assert!(Request::parse(br#"{"version":3,"id":"a","op":"hello"}"#).is_err());
    assert!(Request::parse(br#"{"version":2,"id":"../escape","op":"hello"}"#).is_err());
    assert!(Request::parse(&vec![b' '; 65537]).is_err());
    assert_eq!(
        Request::parse(br#"{"version":1,"id":"a","op":"permissions","future":true}"#)
            .unwrap()
            .op,
        "permissions"
    );
}
#[test]
fn frame_packets_preserve_jpeg_and_refuse_unbounded_headers() {
    let packet = packet(&json!({"codec":"jpeg","bytes":3}), &[1, 2, 3]).unwrap();
    let n = u32::from_be_bytes(packet[..4].try_into().unwrap()) as usize;
    assert_eq!(&packet[4 + n..], &[1, 2, 3]);
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&packet[4..4 + n]).unwrap()["bytes"],
        3
    );
    assert!(
        ace_screen_helper_linux::protocol::packet(&json!({"oversize":"x".repeat(4096)}), &[1])
            .is_err()
    );
}
#[test]
fn restore_tokens_are_rotated_privately_and_insecure_files_are_rejected() {
    let directory = std::env::temp_dir().join(format!("ace-portal-test-{}", std::process::id()));
    let path = directory.join("restore");
    let _ = std::fs::remove_dir_all(&directory);
    assert_eq!(read_token(&path).unwrap(), None);
    save_token(&path, "first").unwrap();
    assert_eq!(read_token(&path).unwrap().as_deref(), Some("first"));
    save_token(&path, "replacement").unwrap();
    assert_eq!(read_token(&path).unwrap().as_deref(), Some("replacement"));
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert!(read_token(&path).is_err());
    std::fs::remove_file(&path).unwrap();
    std::os::unix::fs::symlink("/etc/passwd", &path).unwrap();
    assert!(read_token(&path).is_err());
    std::fs::remove_dir_all(directory).unwrap();
}
#[test]
fn tree_limits_prune_children_and_byte_heavy_nodes_instead_of_collecting_history() {
    use ace_screen_helper_linux::traversal::Budget;
    let mut b = Budget::new(0, 1).unwrap();
    assert!(b.admit(256));
    assert!(!b.descend(0, 100));
    assert!(b.truncated);
    let mut b = Budget::new(8, 2).unwrap();
    assert!(b.admit(256));
    assert!(b.descend(0, 1));
    assert!(b.admit(256));
    assert!(!b.admit(256));
    assert!(b.truncated);
    let mut b = Budget::new(32, 512).unwrap();
    assert!(b.admit(60 * 1024 - 100));
    assert!(!b.admit(101));
    assert!(b.truncated);
    assert!(Budget::new(33, 1).is_err());
    assert!(Budget::new(1, 0).is_err());
    assert!(Budget::new(1, 513).is_err());
}

#[test]
fn semantic_fallback_uses_current_window_origin_and_refuses_an_outside_element() {
    use ace_screen_helper_linux::{accessibility::Bounds, policy::element_center};
    let window = Bounds { x: 200, y: 100, w: 400, h: 300 };
    let element = Bounds { x: 240, y: 120, w: 80, h: 40 };
    assert_eq!(element_center(&element, &window).unwrap(), (80., 40.));
    let moved = Bounds { x: 300, y: 100, w: 400, h: 300 };
    assert_eq!(element_center(&element, &moved).unwrap_err().code, "bounds");
}
#[test]
fn accessibility_queries_cannot_silently_use_a_different_target() {
    use ace_screen_helper_linux::{protocol::Target, policy::scoped_target};
    let target = Target { kind: "window".into(), window_id: Some(1), display_id: None,
        bundle_id: Some("approved".into()), bundle_ids: vec![] };
    let different = Target { window_id: Some(2), ..target.clone() };
    assert!(scoped_target(Some(&target), Some(&target)).is_ok());
    assert!(scoped_target(None, Some(&target)).is_ok());
    assert_eq!(scoped_target(Some(&different), Some(&target)).unwrap_err().code, "target_gone");
    assert!(scoped_target(Some(&target), None).is_err());
}
#[test]
fn frame_connection_rejects_public_directories_and_symlink_endpoints() {
    use ace_screen_helper_linux::endpoint;
    let directory = std::env::temp_dir().join(format!("ace-endpoint-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&directory);
    std::fs::create_dir(&directory).unwrap();
    std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).unwrap();
    let path = directory.join("frame.sock");
    let listener = std::os::unix::net::UnixListener::bind(&path).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    let stream = endpoint::connect(&path).unwrap();
    let (peer, _) = listener.accept().unwrap();
    drop(stream); drop(peer);
    std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(endpoint::connect(&path).unwrap_err().code, "permission_denied");
    std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).unwrap();
    let link = directory.join("link");
    std::os::unix::fs::symlink(&path, &link).unwrap();
    assert_eq!(endpoint::connect(&link).unwrap_err().code, "permission_denied");
    drop(listener);
    std::fs::remove_dir_all(directory).unwrap();
}
