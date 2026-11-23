// SPDX-License-Identifier: Apache-2.0
use super::*;
use crate::shell::watch::STALL_AFTER_MS;
use std::io::{Read, Write};
use std::net::TcpListener;

/// Short timings, so a test sees replacements and the give-up in well under a second.
const QUICK: Timings = Timings {
    first_key: Duration::from_millis(200),
    key: Duration::from_millis(400),
    give_up: Duration::from_millis(900),
};

/// VideoToolbox's avcC for the H.264 vector media-mp4 checks against.
fn avcc() -> Vec<u8> {
    let fixture = include_bytes!("../../../media-mp4/tests/vectors/h264.bin");
    let n = u32::from_be_bytes([fixture[0], fixture[1], fixture[2], fixture[3]]) as usize;
    fixture[4..4 + n].to_vec()
}

fn record(tag: u8, body: &[u8]) -> Vec<u8> {
    let mut out = ((body.len() + 1) as u32).to_be_bytes().to_vec();
    out.push(tag);
    out.extend_from_slice(body);
    out
}

/// One access unit of one NAL unit with a 4-byte length.
fn unit(first: u8) -> Vec<u8> {
    let nal = [first, 0x88, 0x84];
    let mut out = (nal.len() as u32).to_be_bytes().to_vec();
    out.extend_from_slice(&nal);
    out
}

/// A serve-sim stream: its head after `delay`, then a description, an IDR and a delta.
fn picture(delay: Duration) -> impl Fn(&mut std::net::TcpStream) + Send + Sync + 'static {
    move |socket| {
        let mut request = [0u8; 1024];
        let _ = socket.read(&mut request);
        std::thread::sleep(delay);
        let mut out = b"HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\n\r\n".to_vec();
        out.extend(record(1, &avcc()));
        out.extend(record(2, &unit(0x65)));
        out.extend(record(3, &unit(0x41)));
        let _ = socket.write_all(&out);
    }
}

/// A serve-sim that answers every connection with `answer`, then ends that stream.
fn serve_sim(
    answer: impl Fn(&mut std::net::TcpStream) + Send + Sync + 'static,
) -> (u16, Arc<AtomicUsize>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap_or_else(|e| panic!("bind: {e}"));
    let port = listener.local_addr().map(|a| a.port()).unwrap_or_default();
    let accepted = Arc::new(AtomicUsize::new(0));
    let counted = accepted.clone();
    let answer = Arc::new(answer);
    std::thread::spawn(move || {
        for socket in listener.incoming() {
            let Ok(mut socket) = socket else { return };
            counted.fetch_add(1, Ordering::AcqRel);
            let answer = answer.clone();
            std::thread::spawn(move || answer(&mut socket));
        }
    });
    (port, accepted)
}

/// What the reader of `port` sends within `within`: its keyframes, and its failure if any.
fn read_for(port: u16, within: Duration) -> (usize, Option<String>) {
    let (outputs, mut received) = mpsc::channel(64);
    let mut readers = Readers::with_timings(outputs, QUICK);
    readers.open("sim", 1, &format!("http://127.0.0.1:{port}/stream.avcc"), 0);
    let opened = Instant::now();
    let mut keys = 0;
    while opened.elapsed() < within {
        match received.try_recv() {
            Ok((_, _, Output::Unit(frame))) if frame.flags & 1 != 0 => keys += 1,
            Ok((_, _, Output::Failed(reason))) => return (keys, Some(reason)),
            Ok(_) => {}
            Err(_) => std::thread::sleep(Duration::from_millis(5)),
        }
    }
    readers.close(1, 0);
    (keys, None)
}

#[test]
fn a_serve_sim_stream_that_ends_is_read_again_and_the_picture_carries_on_at_its_next_keyframe() {
    let (port, _) = serve_sim(picture(Duration::ZERO));
    let (keys, failed) = read_for(port, Duration::from_millis(1_500));
    assert_eq!(failed, None);
    assert!(
        keys >= 3,
        "only {keys} keyframes: the stream wasn't read again"
    );
}

#[test]
fn a_serve_sim_slow_to_send_its_first_keyframe_is_asked_again_rather_than_given_up() {
    // Each stream answers past the first-keyframe deadline once; later ones answer at once.
    let slow = Arc::new(AtomicUsize::new(0));
    let answer = picture(Duration::ZERO);
    let (port, _) = serve_sim(move |socket| {
        if slow.fetch_add(1, Ordering::AcqRel) == 0 {
            let mut request = [0u8; 1024];
            let _ = socket.read(&mut request);
            std::thread::sleep(Duration::from_millis(600));
            return;
        }
        answer(socket);
    });
    let (keys, failed) = read_for(port, Duration::from_millis(800));
    assert_eq!(failed, None);
    assert!(keys >= 1, "no picture after a slow first stream");
}

#[test]
fn a_serve_sim_that_never_sends_a_keyframe_fails_the_source_once_its_give_up_passes() {
    let (port, accepted) = serve_sim(|socket| {
        let mut request = [0u8; 1024];
        let _ = socket.read(&mut request);
        let _ = socket.write_all(b"HTTP/1.1 200 OK\r\n\r\n");
        std::thread::sleep(Duration::from_secs(3));
    });
    let opened = Instant::now();
    let (keys, failed) = read_for(port, Duration::from_secs(3));
    let Some(reason) = failed else {
        panic!("the reader never gave up on a serve-sim that sent no keyframe");
    };
    assert_eq!(keys, 0);
    assert!(reason.contains("keyframe"), "{reason}");
    assert!(opened.elapsed() >= QUICK.give_up, "{:?}", opened.elapsed());
    assert!(
        opened.elapsed() < Duration::from_secs(2),
        "{:?}",
        opened.elapsed()
    );
    // Streams that sent nothing were replaced while it waited.
    assert!(accepted.load(Ordering::Acquire) >= 2);
}

#[test]
fn a_serve_sim_that_is_not_listening_fails_the_source_as_unreachable_once_its_give_up_passes() {
    let port = {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap_or_else(|e| panic!("bind: {e}"));
        listener.local_addr().map(|a| a.port()).unwrap_or_default()
    };
    let (_, failed) = read_for(port, Duration::from_secs(3));
    let Some(reason) = failed else {
        panic!("the reader never gave up on a serve-sim that isn't there");
    };
    assert!(reason.contains("unreachable"), "{reason}");
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

#[test]
fn a_reader_that_stops_turning_is_failed_at_its_deadline_and_counts_as_stuck() {
    let (port, _) = serve_sim(picture(Duration::ZERO));
    // Nobody takes its units: the reader blocks handing over its second one, inside one call.
    let (outputs, mut received) = mpsc::channel(1);
    let mut readers = Readers::with_timings(outputs, QUICK);
    readers.open("sim", 4, &format!("http://127.0.0.1:{port}/stream.avcc"), 0);
    std::thread::sleep(Duration::from_millis(300));

    assert!(readers.stalled(1_000).is_empty());
    assert!(
        readers.stalled(1_000 + STALL_AFTER_MS - 1).is_empty(),
        "within its deadline"
    );
    assert_eq!(
        readers.stalled(1_000 + STALL_AFTER_MS),
        vec![("sim".to_owned(), 4)]
    );
    assert!(!readers.has(4), "retired");
    assert_eq!(readers.stuck(1_000 + STALL_AFTER_MS), 1);

    // Its call returns once its units are taken, and it ends.
    let end = Instant::now() + Duration::from_secs(5);
    while readers.stuck(1_000_000) > 0 {
        assert!(Instant::now() < end, "the reader never exited");
        while received.try_recv().is_ok() {}
        std::thread::sleep(Duration::from_millis(10));
    }
}
