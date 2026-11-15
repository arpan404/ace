// SPDX-License-Identifier: Apache-2.0
//! What a local process that isn't a producer can do to the real binary before it presents a
//! valid hello: not much, not for long, and nothing that stops real producers.
#![cfg(unix)]
mod support;

use media_wire::control::Status;
use serde_json::json;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::time::{Duration, Instant};
use support::*;

/// How long until the peer closes the connection, reading and discarding what it sends.
fn closed_after(stream: &mut impl Read, limit: Duration) -> Option<Duration> {
    let started = Instant::now();
    let mut buf = [0u8; 4096];
    while started.elapsed() < limit {
        match stream.read(&mut buf) {
            Ok(0) | Err(_) if started.elapsed() < limit => return Some(started.elapsed()),
            _ => {}
        }
    }
    None
}

fn unix(path: &str) -> UnixStream {
    let Ok(stream) = UnixStream::connect(path) else {
        panic!("ingest socket refused the connection");
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(4)));
    stream
}

#[test]
fn refuses_a_runtime_directory_other_users_could_reach() {
    let mut media = Media::spawn("open-dir");
    let _ = std::fs::set_permissions(&media.dir, std::fs::Permissions::from_mode(0o755));
    let dir = media.dir.to_string_lossy().into_owned();
    media.send(
        json!({ "type": "init", "protocol": 1, "version": "x", "runtimeDir": dir, "dataDir": dir,
                "settings": { "recordings": "legacy", "stills": "legacy", "encode": "legacy",
                "delivery": "legacy" } }),
        &SECRET,
    );
    assert_eq!(media.exits_within(Duration::from_secs(2)), Some(1));
    let entries = std::fs::read_dir(&media.dir)
        .map(|d| d.count())
        .unwrap_or(0);
    assert_eq!(entries, 0, "no socket was created");
}

#[test]
fn a_connection_that_never_sends_a_valid_hello_is_closed_and_real_producers_still_connect() {
    let mut media = Media::spawn("limits");
    let (control, ingest, port) = media.start();
    let Some(_priority) = lane(&control, 1, SECRET) else {
        panic!("priority lane refused");
    };
    let Some(_egress) = lane(&control, 2, SECRET) else {
        panic!("egress lane refused");
    };

    // Announcing a large first frame is refused from its header alone.
    let mut big = unix(&ingest);
    let _ = big.write_all(&media_frame(1, 1, vec![0; 64 * 1024])[..12]);
    let refused = closed_after(&mut big, Duration::from_secs(1));
    assert!(refused.is_some(), "a large first frame is refused at once");

    // Silent connections fill the pending slots; one more is closed at once, and the silent
    // ones are closed at the hello deadline.
    let mut silent: Vec<UnixStream> = (0..16).map(|_| unix(&ingest)).collect();
    std::thread::sleep(Duration::from_millis(100));
    let mut extra = unix(&ingest);
    let shut = closed_after(&mut extra, Duration::from_millis(1500));
    assert!(
        shut.is_some_and(|d| d < Duration::from_millis(500)),
        "over the cap: {shut:?}"
    );
    let waited = closed_after(&mut silent[0], Duration::from_secs(4));
    assert!(
        waited.is_some_and(|d| d < Duration::from_millis(2500)),
        "hello deadline: {waited:?}"
    );

    // A WebSocket client that keeps sending without a hello runs out of budget.
    let Ok(mut flood) = TcpStream::connect(("127.0.0.1", port as u16)) else {
        panic!("websocket port refused the connection");
    };
    let _ = flood.set_write_timeout(Some(Duration::from_secs(3)));
    let started = Instant::now();
    let junk = vec![b'a'; 4096];
    while flood.write_all(&junk).is_ok() && started.elapsed() < Duration::from_secs(3) {}
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "pre-auth bytes are bounded"
    );

    // Slots come back: a real producer still streams.
    drop(silent);
    std::thread::sleep(Duration::from_millis(100));
    open_source(&mut media, "s1", 1, 5);
    let mut producer = unix(&ingest);
    let _ = producer.write_all(&media_frame(5, 0, vec![5; 32]));
    let _ = producer.write_all(&media_frame(1, 1, vec![0; 100]));
    assert_eq!(status_of(media.read()), ("s1".into(), Status::Playing));
}
