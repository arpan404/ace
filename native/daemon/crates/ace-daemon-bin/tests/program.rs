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

/// `access-cors.server.process.test.ts` and `devices-access.server.process.test.ts`:
/// the access routes issue a pairing link, redeem it, mint a ticket, list the
/// paired device, and revoke it — all over the real daemon's HTTP.
#[test]
fn the_access_routes_pair_a_device_mint_a_ticket_and_revoke_it() {
    let home = Home::new("access");
    let mut daemon = home.start_with(true, &[("ACE_LISTEN", "lan"), ("ACE_REMOTE_PORT", "0")]);
    let endpoint = daemon.ready(&home);
    let token = home.token();

    let (status, body) = request(&endpoint, "POST", "/v1/pairings", &token, "{}");
    assert_eq!(status, 200, "{body}");
    let issued: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
    let code = issued
        .get("url")
        .and_then(serde_json::Value::as_str)
        .and_then(|url| url.split("code=").nth(1))
        .and_then(|rest| rest.split('&').next())
        .unwrap_or_default()
        .to_owned();
    assert!(!code.is_empty(), "the link carries its code: {issued}");
    let origin = issued
        .get("url")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    assert!(
        origin.starts_with("https://"),
        "a pairing link is HTTPS: {origin}"
    );

    let (status, body) = request(
        &endpoint,
        "POST",
        "/v1/pair",
        "",
        &format!("{{\"code\":\"{code}\",\"name\":\"Phone\"}}"),
    );
    assert_eq!(status, 200, "{body}");
    let paired: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
    let device_token = paired
        .get("token")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let device_id = paired
        .get("device")
        .and_then(|device| device.get("id"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_owned();
    assert!(token_is_64_hex(&device_token));
    assert!(!device_id.is_empty());

    let (status, body) = request(&endpoint, "POST", "/v1/tickets", &device_token, "");
    assert_eq!(status, 200, "{body}");
    let ticket: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
    assert!(
        ticket
            .get("ticket")
            .and_then(serde_json::Value::as_str)
            .is_some_and(token_is_64_hex),
        "{ticket}"
    );

    let (status, body) = request(&endpoint, "GET", "/v1/devices", &token, "");
    assert_eq!(status, 200, "{body}");
    let devices: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
    assert!(
        devices
            .as_array()
            .is_some_and(|items| items.iter().any(|item| {
                item.get("id").and_then(serde_json::Value::as_str) == Some(device_id.as_str())
            })),
        "the paired device is listed: {devices}"
    );

    let (status, body) = request(
        &endpoint,
        "DELETE",
        &format!("/v1/devices/{device_id}"),
        &token,
        "",
    );
    assert_eq!(status, 200, "{body}");
    assert!(body.contains("\"revoked\":true"));

    // A second redemption code is single use: the same code opens nothing.
    let (status, _) = request(
        &endpoint,
        "POST",
        "/v1/pair",
        "",
        &format!("{{\"code\":\"{code}\",\"name\":\"Phone\"}}"),
    );
    assert_eq!(status, 401);
    let status = daemon.terminate();
    assert_eq!(status.code(), Some(0));
}

/// `pairing-issue.ts`: without remote access there is no address to pair with.
#[test]
fn issuing_a_pairing_link_is_refused_when_remote_access_is_off() {
    let home = Home::new("pairing-off");
    let mut daemon = home.start(false);
    let endpoint = daemon.ready(&home);
    let token = home.token();
    let (status, body) = request(&endpoint, "POST", "/v1/pairings", &token, "{}");
    assert_eq!(status, 409, "{body}");
    assert!(body.contains("Turn on remote access"));
    let status = daemon.terminate();
    assert_eq!(status.code(), Some(0));
}

/// `fleet-access.server.process.test.ts` "The same ceiling holds on the HTTP
/// route": a paired credential may grant only the scopes it holds. Admin does not
/// imply projects or accounts (ADR 0070).
#[test]
fn a_pairing_link_cannot_grant_scopes_the_creator_does_not_hold() {
    let home = Home::new("scope-ceiling");
    let mut daemon = home.start_with(true, &[("ACE_LISTEN", "lan"), ("ACE_REMOTE_PORT", "0")]);
    let endpoint = daemon.ready(&home);
    let token = home.token();
    let (status, body) = request(
        &endpoint,
        "POST",
        "/v1/pairings",
        &token,
        "{\"scopes\":[\"admin\"]}",
    );
    assert_eq!(status, 200, "{body}");
    let issued: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
    let code = issued
        .get("url")
        .and_then(serde_json::Value::as_str)
        .and_then(|url| url.split("code=").nth(1))
        .and_then(|rest| rest.split('&').next())
        .unwrap_or_default()
        .to_owned();
    let (status, body) = request(
        &endpoint,
        "POST",
        "/v1/pair",
        "",
        &format!("{{\"code\":\"{code}\",\"name\":\"Manager\"}}"),
    );
    assert_eq!(status, 200, "{body}");
    let paired: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
    let admin_token = paired
        .get("token")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_owned();

    // An admin-only device cannot mint the person's projects or accounts.
    let (status, body) = request(
        &endpoint,
        "POST",
        "/v1/pairings",
        &admin_token,
        "{\"scopes\":[\"projects\"]}",
    );
    assert_eq!(status, 403, "{body}");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|value| value
                .get("error")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)),
        Some("You can't grant Projects: this device doesn't have it.".to_owned())
    );
    let (status, body) = request(
        &endpoint,
        "POST",
        "/v1/pairings",
        &admin_token,
        "{\"scopes\":[\"admin\"]}",
    );
    assert_eq!(status, 200, "{body}");
    // Admin carries read and operate, as `allows_scopes` says.
    let (status, body) = request(
        &endpoint,
        "POST",
        "/v1/pairings",
        &admin_token,
        "{\"scopes\":[\"read\"]}",
    );
    assert_eq!(status, 200, "{body}");

    // `/v1/status` is open to any admin, not only the host token.
    let (status, body) = request(&endpoint, "GET", "/v1/status", &admin_token, "");
    assert_eq!(status, 200, "{body}");
    let status = daemon.terminate();
    assert_eq!(status.code(), Some(0));
}

/// `access-http.ts:35`–`:50`: a body over 16 KiB is refused while it streams, not
/// collected first; the daemon stays up.
#[test]
fn an_oversized_body_is_refused_at_its_limit() {
    let home = Home::new("body-limit");
    let mut daemon = home.start(false);
    let endpoint = daemon.ready(&home);
    let token = home.token();
    let huge = "x".repeat(512 * 1024);
    let pair_body = format!("{{\"code\":\"abc\",\"name\":\"Phone\",\"padding\":\"{huge}\"}}");
    let (status, body) = request(&endpoint, "POST", "/v1/pair", "", &pair_body);
    assert_eq!(status, 413, "{body}");
    assert!(body.contains("Request too large"));
    let stop_body = format!("{{\"padding\":\"{huge}\"}}");
    let (status, body) = request(&endpoint, "POST", "/v1/stop", &token, &stop_body);
    assert_eq!(status, 413, "{body}");
    // The daemon is still serving.
    let (status, _) = request(&endpoint, "GET", "/v1/status", &token, "");
    assert_eq!(status, 200);
    let status = daemon.terminate();
    assert_eq!(status.code(), Some(0));
}

/// `remote.ts`: a device name's bound is code points, not bytes, and a bad
/// `ttlMs`, `installId` or `standingKey` is a 400.
#[test]
fn pairing_bodies_follow_the_protocol_bounds() {
    let home = Home::new("pair-bounds");
    let mut daemon = home.start_with(true, &[("ACE_LISTEN", "lan"), ("ACE_REMOTE_PORT", "0")]);
    let endpoint = daemon.ready(&home);
    let token = home.token();
    let code_of = |body: &str| -> String {
        let issued: serde_json::Value = serde_json::from_str(body).unwrap_or_default();
        issued
            .get("url")
            .and_then(serde_json::Value::as_str)
            .and_then(|url| url.split("code=").nth(1))
            .and_then(|rest| rest.split('&').next())
            .unwrap_or_default()
            .to_owned()
    };
    let (status, body) = request(&endpoint, "POST", "/v1/pairings", &token, "{}");
    assert_eq!(status, 200);
    let code = code_of(&body);
    let name = "漢".repeat(100);
    let (status, body) = request(
        &endpoint,
        "POST",
        "/v1/pair",
        "",
        &format!("{{\"code\":\"{code}\",\"name\":\"{name}\"}}"),
    );
    assert_eq!(status, 200, "{body}");
    let paired: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
    assert_eq!(
        paired
            .get("device")
            .and_then(|device| device.get("name"))
            .and_then(serde_json::Value::as_str)
            .map(|name| name.chars().count()),
        Some(100)
    );

    let (status, _) = request(
        &endpoint,
        "POST",
        "/v1/pairings",
        &token,
        "{\"ttlMs\":\"1h\"}",
    );
    assert_eq!(status, 400);
    let (status, body) = request(&endpoint, "POST", "/v1/pairings", &token, "{}");
    assert_eq!(status, 200);
    let code = code_of(&body);
    let (status, _) = request(
        &endpoint,
        "POST",
        "/v1/pair",
        "",
        &format!("{{\"code\":\"{code}\",\"name\":\"Phone\",\"installId\":\"bad\"}}"),
    );
    assert_eq!(status, 400);
    let (status, body) = request(&endpoint, "POST", "/v1/pairings", &token, "{}");
    assert_eq!(status, 200);
    let code = code_of(&body);
    let (status, _) = request(
        &endpoint,
        "POST",
        "/v1/pair",
        "",
        &format!("{{\"code\":\"{code}\",\"name\":\"Phone\",\"standingKey\":\"short\"}}"),
    );
    assert_eq!(status, 400);
    let status = daemon.terminate();
    assert_eq!(status.code(), Some(0));
}

/// `access-cors.server.process.test.ts`: an allowlisted Origin gets the CORS
/// headers and a 204 preflight; a foreign one is `403 Origin not allowed`.
#[test]
fn cors_admits_the_desktop_origin_and_refuses_a_foreign_one() {
    let home = Home::new("cors");
    let mut daemon = home.start(false);
    let endpoint = daemon.ready(&home);
    for (origin, status) in [("app://ace", 204), ("https://attacker.example", 403)] {
        let text = support::exchange_headers(
            &endpoint,
            "OPTIONS",
            "/v1/status",
            "",
            "",
            &[("Origin", origin), ("Access-Control-Request-Method", "GET")],
        );
        let code = text
            .split_whitespace()
            .nth(1)
            .and_then(|code| code.parse::<u16>().ok())
            .unwrap_or(0);
        assert_eq!(code, status, "{origin}: {text}");
        if status == 204 {
            assert!(
                text.to_ascii_lowercase()
                    .contains(&format!("access-control-allow-origin: {origin}")),
                "{text}"
            );
        }
    }
    let status = daemon.terminate();
    assert_eq!(status.code(), Some(0));
}

/// `home-backup-log.ts`: a fresh start says where the old data went, and leaves a
/// README in the backup.
#[test]
fn a_fresh_start_is_logged_and_backed_up() {
    let home = Home::new("fresh-log");
    let _ = std::fs::create_dir_all(&home.ace_home);
    let _ = std::fs::write(home.ace_home.join("old.txt"), "old data");
    let mut daemon = home.start(false);
    let _endpoint = daemon.ready(&home);
    let backup = std::path::PathBuf::from(format!("{}-v0", home.ace_home.display()));
    assert!(
        backup.join("old.txt").exists(),
        "the old data was moved aside"
    );
    assert!(
        backup.join("README.txt").exists(),
        "the backup explains itself"
    );
    let log = std::fs::read_to_string(home.ace_home.join("logs/ace.jsonl")).unwrap_or_default();
    assert!(
        log.contains("Started with a fresh data home; the old data was backed up"),
        "{log}"
    );
    assert!(log.contains("\"backup\""), "{log}");
    let status = daemon.terminate();
    assert_eq!(status.code(), Some(0));
}
