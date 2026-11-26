// SPDX-License-Identifier: Apache-2.0
//! The program tests: the real `ace-daemon` binary on a brand-new, empty home.
//! Every run uses a fresh temporary HOME and ACE_HOME (never `~/.ace`), an empty
//! stub directory first on PATH, and stops the daemon by signal or `POST /v1/stop`.

mod support;

use std::time::Duration;

use support::{Home, request, token_is_64_hex};

/// `cli-start.process.test.ts`: a fresh home starts, listens, and writes every
/// file the CLI reads; a second start is refused as lock-held; SIGTERM stops it in
/// order and leaves a stopped run marker.
#[test]
fn a_fresh_home_starts_listens_and_stops_in_order() {
    let home = Home::new("lifecycle");
    let mut daemon = home.start(true);
    let endpoint = daemon.ready(&home);

    // Every file a client or the CLI reads, with the same contents.
    let token = home.token();
    assert!(token_is_64_hex(&token), "the token is 64 hex characters");
    let host = std::fs::read_to_string(home.ace_home.join("host-id")).unwrap_or_default();
    assert!(!host.is_empty(), "the host id is written");
    assert!(home.ace_home.join("daemon-lock.sqlite").exists());
    let marker = std::fs::read_to_string(home.ace_home.join("ace-format.json")).unwrap_or_default();
    assert!(marker.contains("\"format\":\"ace-v1\""));
    let run = std::fs::read_to_string(home.ace_home.join("daemon-run.json")).unwrap_or_default();
    assert!(run.contains("\"state\":\"running\""));
    assert!(home.ace_home.join("events.sqlite").exists());

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for name in ["daemon-token", "daemon-endpoint"] {
            let mode = std::fs::metadata(home.ace_home.join(name))
                .map(|meta| meta.permissions().mode())
                .unwrap_or(0);
            assert_eq!(mode & 0o777, 0o600, "{name} is private");
        }
    }

    let (status, body) = request(&endpoint, "GET", "/v1/status", &token, "");
    assert_eq!(status, 200, "status is answered: {body}");
    assert!(body.contains("\"running\":true"));
    let (unknown, body) = request(&endpoint, "GET", "/v1/nothing", &token, "");
    assert_eq!(unknown, 404);
    assert!(body.contains("Unknown endpoint"));
    let (unauthenticated, _) = request(&endpoint, "GET", "/v1/status", "", "");
    assert_eq!(unauthenticated, 403);

    // A second start on the same home refuses with the CLI's lock-held code (7).
    let mut second = home.start(false);
    let status = second.wait(Duration::from_secs(10));
    assert_eq!(status.code(), Some(7));
    assert!(second.output().contains("Another daemon owns it"));

    // SIGTERM: the endpoint goes, the run marker says stopped, and the exit is clean.
    let status = daemon.terminate();
    assert_eq!(status.code(), Some(0), "a signal stops the daemon cleanly");
    assert!(!home.ace_home.join("daemon-endpoint").exists());
    assert!(!home.ace_home.join("daemon-lock").exists());
    let run = std::fs::read_to_string(home.ace_home.join("daemon-run.json")).unwrap_or_default();
    assert!(run.contains("\"state\":\"stopped\""));
    assert!(run.contains("\"signal\":\"SIGTERM\""));
    let log = std::fs::read_to_string(home.ace_home.join("logs/ace.jsonl")).unwrap_or_default();
    assert!(log.contains("\"message\":\"Daemon stopping\""));
    assert!(log.contains("\"message\":\"Daemon listening\""));
}

/// `cli-stop.process.test.ts`: `POST /v1/stop` answers with a receipt, the receipt
/// leaves `pending`, and the process exits 0 with the endpoints retired.
#[test]
fn a_stop_request_is_answered_by_receipt_and_the_process_exits() {
    let home = Home::new("stop");
    let mut daemon = home.start(false);
    let endpoint = daemon.ready(&home);
    let token = home.token();
    let (status, body) = request(&endpoint, "POST", "/v1/stop", &token, "{}");
    assert_eq!(status, 200, "the stop is accepted: {body}");
    assert!(body.contains("\"stopping\":true"));
    assert!(body.contains("\"receiptId\":"));
    let status = daemon.wait(Duration::from_secs(15));
    assert_eq!(status.code(), Some(0));
    let receipt =
        std::fs::read_to_string(home.ace_home.join("daemon-shutdown.json")).unwrap_or_default();
    assert!(receipt.contains("\"state\":\"succeeded\""), "{receipt}");
    assert!(!home.ace_home.join("daemon-endpoint").exists());
    let run = std::fs::read_to_string(home.ace_home.join("daemon-run.json")).unwrap_or_default();
    assert!(run.contains("\"source\":\"stop-request\""));
    let log = std::fs::read_to_string(home.ace_home.join("logs/ace.jsonl")).unwrap_or_default();
    assert!(log.contains("\"source\":\"stop-request\""));
}

/// `daemon-lock.process.test.ts`: a daemon killed while holding the lock leaves it
/// free, and the next start opens the same home.
#[test]
fn a_killed_daemon_leaves_the_lock_free_for_the_next_start() {
    let home = Home::new("kill");
    let mut daemon = home.start(false);
    let _endpoint = daemon.ready(&home);
    if let Some(child) = &mut daemon.child {
        let _ = child.kill();
        let _ = child.wait();
    }
    daemon.child = None;
    // A crashed daemon leaves its endpoint file behind (it is retired only by an
    // orderly stop), so the next start's own write is what readiness waits for.
    let _ = std::fs::remove_file(home.ace_home.join("daemon-endpoint"));
    let mut next = home.start(false);
    let endpoint = next.ready(&home);
    assert!(endpoint.starts_with("http://127.0.0.1:"));
    let status = next.terminate();
    let output = next.output();
    assert_eq!(status.code(), Some(0), "status {status:?}: {output}");
}

/// A fresh home asked for LAN remote access makes its pinned identity with
/// OpenSSL, starts the TLS listener, and publishes the URL and fingerprint the
/// launcher reads (`tls-identity.process.test.ts`, `network.test.ts`).
#[test]
fn a_lan_start_makes_its_identity_and_publishes_the_fingerprint() {
    let home = Home::new("lan");
    let mut daemon = home.start_with(true, &[("ACE_LISTEN", "lan"), ("ACE_REMOTE_PORT", "0")]);
    let _endpoint = daemon.ready(&home);
    let started = daemon.started();
    let remote = started.get("remoteUrl").and_then(serde_json::Value::as_str);
    let fingerprint = started
        .get("fingerprint")
        .and_then(serde_json::Value::as_str);
    let Some(remote) = remote else {
        panic!("a LAN start publishes a remote URL: {started}");
    };
    assert!(remote.starts_with("wss://"), "{remote}");
    assert!(
        fingerprint.is_some_and(|value| value.len() == 64),
        "the pinned fingerprint is published: {started}"
    );
    assert!(home.ace_home.join("tls/cert.pem").exists());
    assert!(home.ace_home.join("tls/key.pem").exists());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(home.ace_home.join("tls/key.pem"))
            .map(|meta| meta.permissions().mode())
            .unwrap_or(0);
        assert_eq!(mode & 0o777, 0o600);
    }
    let status = daemon.terminate();
    assert_eq!(status.code(), Some(0), "{}", daemon.output());
}
