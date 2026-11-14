// SPDX-License-Identifier: Apache-2.0
use super::*;
use std::io::{Read, Write};
use std::net::TcpListener;

/// A serve-sim that answers the first request with a head and half a record, then stalls with
/// the connection open.
fn stalling_serve_sim() -> (u16, std::thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap_or_else(|e| panic!("bind: {e}"));
    let port = listener.local_addr().map(|a| a.port()).unwrap_or_default();
    let thread = std::thread::spawn(move || {
        let Ok((mut socket, _)) = listener.accept() else {
            return;
        };
        let mut request = [0u8; 1024];
        let _ = socket.read(&mut request);
        let mut half =
            b"HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\n\r\n".to_vec();
        half.extend_from_slice(&100u32.to_be_bytes());
        half.extend_from_slice(&[1, 0x01, 0x64, 0x00]);
        let _ = socket.write_all(&half);
        // Held open: the reader's read never returns on its own.
        std::thread::sleep(Duration::from_secs(6));
    });
    (port, thread)
}

#[test]
fn a_serve_sim_that_stalls_before_its_first_keyframe_fails_the_source_in_time_for_the_fallback() {
    let (port, _server) = stalling_serve_sim();
    let (outputs, mut received) = mpsc::channel(16);
    let mut readers = Readers::new(outputs);
    let opened = Instant::now();
    readers.open("sim", 1, &format!("http://127.0.0.1:{port}/stream.avcc"));
    let failed = loop {
        match received.try_recv() {
            Ok((source, token, Output::Failed(reason))) => break Some((source, token, reason)),
            Ok(_) => {}
            Err(_) if opened.elapsed() > Duration::from_secs(4) => break None,
            Err(_) => std::thread::sleep(Duration::from_millis(10)),
        }
    };
    let Some((source, token, reason)) = failed else {
        panic!("the reader never gave up on a serve-sim that sent no keyframe");
    };
    assert_eq!((source.as_str(), token), ("sim", 1));
    assert!(reason.contains("keyframe"), "{reason}");
    // Soon enough that the daemon's own reader is back within the 2 s fallback.
    assert!(
        opened.elapsed() < Duration::from_millis(1_900),
        "{:?}",
        opened.elapsed()
    );
}

#[test]
fn records_past_the_byte_budget_are_dropped_to_the_next_keyframe_which_is_asked_for_once() {
    let mut gate = Admission::default();
    let limit = 1_000;
    assert_eq!(gate.admit(true, 400, 0, limit), Admit::Send);
    assert_eq!(gate.admit(false, 400, 400, limit), Admit::Send);
    // Past the budget: this delta and those after it would decode against nothing.
    assert_eq!(gate.admit(false, 400, 800, limit), Admit::DropAndAsk);
    assert_eq!(gate.admit(false, 10, 0, limit), Admit::Drop);
    assert_eq!(gate.admit(false, 10, 0, limit), Admit::Drop);
    // The next keyframe that fits starts the stream again.
    assert_eq!(gate.admit(true, 900, 200, limit), Admit::Drop);
    assert_eq!(gate.admit(true, 400, 0, limit), Admit::Send);
    assert_eq!(gate.admit(false, 10, 400, limit), Admit::Send);
}

#[test]
fn a_close_or_drain_is_taken_before_video_already_queued() {
    let (mailbox, control, data) = Mailbox::new();
    for _ in 0..1_000 {
        data.send(Message::Record(1, Record::Delta(vec![0; 64])))
            .ok();
    }
    control.send(Message::Close).ok();
    assert!(matches!(
        mailbox.next(Duration::from_millis(10)),
        Ok(Message::Close)
    ));
    assert!(matches!(
        mailbox.next(Duration::from_millis(10)),
        Ok(Message::Record(..))
    ));
}

#[test]
fn recovery_from_dropped_records_stays_open_until_a_replacement_starts() {
    let t0 = Instant::now();
    let at = |ms: u64| t0 + Duration::from_millis(ms);
    let mut recovery = Recovery::default();
    // Nothing dropped: nothing to open.
    assert!(!recovery.attempt(at(0), false));
    // The active subscription dropped records: a replacement opens at once.
    assert!(!recovery.gap(Origin::Active));
    assert!(recovery.attempt(at(0), false));
    // One is open: no other.
    assert!(!recovery.attempt(at(300), true));
    // Its first IDR didn't fit either: it is ended, not ignored, and replaced in turn.
    assert!(recovery.gap(Origin::Next));
    assert!(recovery.attempt(at(300), false));
    // A further gap from the active one changes nothing.
    assert!(!recovery.gap(Origin::Active));
    // A replacement started: recovery is over.
    recovery.started();
    assert!(!recovery.attempt(at(2_000), false));
}

#[test]
fn a_serve_sim_that_keeps_ending_replacements_is_retried_at_most_every_250_ms() {
    let t0 = Instant::now();
    let mut recovery = Recovery::default();
    recovery.gap(Origin::Active);
    // Each replacement is accepted and ended at once, every millisecond for a second.
    let opened = (0..1_000)
        .filter(|ms| recovery.attempt(t0 + Duration::from_millis(*ms), false))
        .count();
    assert_eq!(opened, 4, "at 0, 250, 500 and 750 ms");
    // A replacement that drops its IDR is ended at once, but the next waits its turn.
    assert!(recovery.gap(Origin::Next));
    assert!(!recovery.attempt(t0 + Duration::from_millis(800), false));
    assert!(recovery.attempt(t0 + Duration::from_millis(1_000), false));
}
