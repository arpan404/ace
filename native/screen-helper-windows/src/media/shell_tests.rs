use super::*;
use media_wire::frame::MediaFrame;
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;

use std::time::Instant;
use zeroize::Zeroizing;

struct UnixLink(UnixStream);
impl Link for UnixLink {
    fn write_all(&mut self, bytes: &[u8]) -> io::Result<()> {
        self.0.write_all(bytes)
    }
    fn alive(&mut self) -> bool {
        let mut byte = [0u8; 1];
        let _ = self.0.set_nonblocking(true);
        let open = !matches!(self.0.read(&mut byte), Ok(0));
        let _ = self.0.set_nonblocking(false);
        open
    }
}
struct Shut(UnixStream);
impl Cancel for Shut {
    fn cancel(&self) {
        let _ = self.0.shutdown(std::net::Shutdown::Both);
    }
}

/// A listener standing in for ace-media's ingest, and what the shell reports.
struct Harness {
    path: PathBuf,
    listener: std::os::unix::net::UnixListener,
    closed: Arc<Mutex<Vec<Option<u64>>>>,
    shell: IngestShell,
}

fn harness(name: &str) -> Harness {
    let path = std::env::temp_dir().join(format!("e1-{name}-{}.sock", std::process::id()));
    let _ = std::fs::remove_file(&path);
    let listener = std::os::unix::net::UnixListener::bind(&path).unwrap();
    let closed = Arc::new(Mutex::new(Vec::new()));
    let c = closed.clone();
    let start = Instant::now();
    let shell = IngestShell::new(
        Box::new(|socket, _| {
            let stream = UnixStream::connect(socket)?;
            let cancel: Arc<dyn Cancel> = Arc::new(Shut(stream.try_clone()?));
            Ok((Box::new(UnixLink(stream)) as Box<dyn Link>, cancel))
        }),
        Sinks {
            closed: Box::new(move |boundary| c.lock().unwrap().push(boundary)),
            keyframe: Box::new(|| {}),
        },
        Box::new(move || start.elapsed().as_micros() as u64),
    );
    Harness {
        path,
        listener,
        closed,
        shell,
    }
}

impl Harness {
    fn address(&self) -> Address {
        Address {
            socket: self.path.to_string_lossy().into_owned(),
            token: Zeroizing::new([3; 32]),
        }
    }
}

fn unit(sequence: u64, key: bool) -> VideoUnit {
    VideoUnit {
        sequence,
        timestamp_ms: 1.0,
        scale: 1.0,
        width: 64,
        height: 64,
        key,
        codec: key.then(|| "avc1.42001F".into()),
        epoch: 1,
        captured_us: 0,
        payload: vec![0, 0, 0, 1, if key { 0x65 } else { 0x41 }],
    }
}

/// Every frame the reader got until the connection closed: (kind, stamp sequence).
fn read_all(mut stream: UnixStream) -> Vec<(u8, Option<u64>)> {
    let mut bytes = Vec::new();
    stream.read_to_end(&mut bytes).unwrap();
    let mut frames = Vec::new();
    let mut rest = &bytes[..];
    while rest.len() >= 12 {
        let header = u16::from_be_bytes([rest[6], rest[7]]) as usize;
        let payload = u32::from_be_bytes(rest[8..12].try_into().unwrap()) as usize;
        let frame = MediaFrame::decode(&rest[..header + payload]).unwrap();
        let sequence = (frame.extension.len() >= 12)
            .then(|| u64::from_be_bytes(frame.extension[4..12].try_into().unwrap()));
        frames.push((frame.kind, sequence));
        rest = &rest[header + payload..];
    }
    frames
}

#[test]
fn units_before_and_after_an_ingest_go_nowhere_and_the_ingest_gets_every_unit_between() {
    let h = harness("flip");
    h.shell.publish(&unit(0, true));
    h.shell.publish(&unit(1, false));
    let routed = h.shell.configure(Some(h.address()), None).unwrap();
    assert_eq!(
        routed,
        Routed {
            switched: true,
            boundary: None,
            ingesting: true
        }
    );
    let (server, _) = h.listener.accept().unwrap();
    for sequence in 2..50 {
        h.shell.publish(&unit(sequence, sequence == 2));
    }
    let back = h.shell.configure(None, None).unwrap();
    assert_eq!(
        back,
        Routed {
            switched: true,
            boundary: Some(49),
            ingesting: false
        }
    );
    h.shell.publish(&unit(50, true));
    // The old path got its hello, every unit, then the end frame, and was closed.
    let frames = read_all(server);
    assert_eq!(frames.first(), Some(&(5, None)));
    assert_eq!(frames.last(), Some(&(4, None)));
    let ingested: Vec<u64> = frames.iter().filter_map(|f| f.1).collect();
    assert_eq!(ingested, (2..50).collect::<Vec<_>>());
    assert!(h.closed.lock().unwrap().is_empty());
}

#[test]
fn ace_media_going_away_stops_video_and_is_told_within_the_poll() {
    let h = harness("gone");
    h.shell.configure(Some(h.address()), None).unwrap();
    let (server, _) = h.listener.accept().unwrap();
    h.shell.publish(&unit(0, true));
    drop(server);
    let started = Instant::now();
    while h.closed.lock().unwrap().is_empty() {
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "not noticed within 2 s"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(*h.closed.lock().unwrap(), vec![Some(0)]);
    assert!(!h.shell.ingesting());
}

#[test]
fn a_connection_that_cannot_open_leaves_video_stopped() {
    let h = harness("refused");
    let mut address = h.address();
    address.socket.push_str(".missing");
    assert!(h.shell.configure(Some(address), None).is_err());
    assert!(!h.shell.ingesting());
}

/// A link like a Windows pipe to a reader that stopped reading: the first write goes through,
/// later ones block until cancelled, and a cancel (like `CancelIoEx`) only ends a write that
/// is already in progress, never one that starts after it.
struct Stalled {
    state: Arc<(Mutex<StallState>, std::sync::Condvar)>,
}
#[derive(Default)]
struct StallState {
    writes: u32,
    in_write: bool,
    cancelled_in_write: bool,
    first_written: bool,
    release_first: bool,
}
impl Link for Stalled {
    fn write_all(&mut self, _: &[u8]) -> io::Result<()> {
        let (lock, wake) = &*self.state;
        let mut state = lock.lock().unwrap();
        state.writes += 1;
        if state.writes == 1 {
            // The hello: written, then held so the test can cut between two writes.
            state.first_written = true;
            wake.notify_all();
            while !state.release_first {
                state = wake.wait(state).unwrap();
            }
            return Ok(());
        }
        state.in_write = true;
        while !state.cancelled_in_write {
            let (next, timeout) = wake.wait_timeout(state, Duration::from_secs(5)).unwrap();
            state = next;
            if timeout.timed_out() {
                state.in_write = false;
                return Err(io::Error::other("still blocked after 5 s"));
            }
        }
        state.in_write = false;
        Err(io::Error::other("cancelled"))
    }
    fn alive(&mut self) -> bool {
        true
    }
}
struct StallCancel(
    Arc<(Mutex<StallState>, std::sync::Condvar)>,
    Arc<std::sync::atomic::AtomicU32>,
);
impl Cancel for StallCancel {
    fn cancel(&self) {
        self.1.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let (lock, wake) = &*self.0;
        let mut state = lock.lock().unwrap();
        if state.in_write {
            state.cancelled_in_write = true;
        }
        wake.notify_all();
    }
}

#[test]
fn a_cut_between_two_writes_still_ends_the_next_write_and_drops_the_queue() {
    let state = Arc::new((Mutex::new(StallState::default()), std::sync::Condvar::new()));
    let cancels = Arc::new(std::sync::atomic::AtomicU32::new(0));
    let (link_state, cancel_state, counted) = (state.clone(), state.clone(), cancels.clone());
    let closed = Arc::new(Mutex::new(Vec::new()));
    let c = closed.clone();
    let start = Instant::now();
    let shell = IngestShell::new(
        Box::new(move |_, _| {
            let cancel: Arc<dyn Cancel> =
                Arc::new(StallCancel(cancel_state.clone(), counted.clone()));
            Ok((
                Box::new(Stalled {
                    state: link_state.clone(),
                }) as Box<dyn Link>,
                cancel,
            ))
        }),
        Sinks {
            closed: Box::new(move |boundary| c.lock().unwrap().push(boundary)),
            keyframe: Box::new(|| {}),
        },
        Box::new(move || start.elapsed().as_micros() as u64),
    );
    let address = Address {
        socket: "stalled".into(),
        token: Zeroizing::new([1; 32]),
    };
    shell.configure(Some(address), None).unwrap();
    for sequence in 0..20 {
        shell.publish(&unit(sequence, sequence == 0));
    }
    // The pump is between the hello and the next write: cut now, then let it go on.
    {
        let (lock, wake) = &*state;
        let mut s = lock.lock().unwrap();
        while !s.first_written {
            s = wake.wait(s).unwrap();
        }
    }
    shell.close();
    {
        let (lock, wake) = &*state;
        lock.lock().unwrap().release_first = true;
        wake.notify_all();
    }
    // Whatever was queued is dropped: at most the one write already starting may begin, and it
    // ends well inside a second.
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        let s = state.0.lock().unwrap();
        if !s.in_write && s.writes <= 2 && Instant::now() > start + Duration::from_millis(300) {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the pump is still blocked: {} writes, in write {}",
            s.writes,
            s.in_write
        );
        drop(s);
        std::thread::sleep(Duration::from_millis(10));
    }
    std::thread::sleep(Duration::from_millis(300));
    let s = state.0.lock().unwrap();
    assert!(
        s.writes <= 2,
        "queued writes went on after the cut: {}",
        s.writes
    );
    assert!(!s.in_write);
}

/// A link whose reader stops before the end: the final flush blocks until it is cancelled, and
/// a cancel only ends a flush already in progress.
struct StuckFlush {
    state: Arc<(Mutex<FlushState>, std::sync::Condvar)>,
}
#[derive(Default)]
struct FlushState {
    flushing: bool,
    cancelled: bool,
    returned: bool,
}
impl Link for StuckFlush {
    fn write_all(&mut self, _: &[u8]) -> io::Result<()> {
        Ok(())
    }
    fn alive(&mut self) -> bool {
        true
    }
    fn finish(&mut self) {
        let (lock, wake) = &*self.state;
        let mut state = lock.lock().unwrap();
        state.flushing = true;
        wake.notify_all();
        let deadline = Instant::now() + Duration::from_secs(8);
        while !state.cancelled && Instant::now() < deadline {
            state = wake
                .wait_timeout(state, Duration::from_millis(50))
                .unwrap()
                .0;
        }
        state.flushing = false;
        state.returned = true;
        wake.notify_all();
    }
}
struct FlushCancel(Arc<(Mutex<FlushState>, std::sync::Condvar)>);
impl Cancel for FlushCancel {
    fn cancel(&self) {
        let (lock, wake) = &*self.0;
        let mut state = lock.lock().unwrap();
        if state.flushing {
            state.cancelled = true;
        }
        wake.notify_all();
    }
}

#[test]
fn a_finish_whose_reader_stopped_reading_is_cancelled_past_its_deadline() {
    let state = Arc::new((Mutex::new(FlushState::default()), std::sync::Condvar::new()));
    let (link_state, cancel_state) = (state.clone(), state.clone());
    let start = Instant::now();
    let shell = IngestShell::new(
        Box::new(move |_, _| {
            let cancel: Arc<dyn Cancel> = Arc::new(FlushCancel(cancel_state.clone()));
            Ok((
                Box::new(StuckFlush {
                    state: link_state.clone(),
                }) as Box<dyn Link>,
                cancel,
            ))
        }),
        Sinks {
            closed: Box::new(|_| {}),
            keyframe: Box::new(|| {}),
        },
        Box::new(move || start.elapsed().as_micros() as u64),
    );
    let address = Address {
        socket: "stuck".into(),
        token: Zeroizing::new([1; 32]),
    };
    shell.configure(Some(address), None).unwrap();
    shell.publish(&unit(0, true));
    // Back to the daemon's path: the old connection writes its end frame, then flushes, and
    // its reader never takes the bytes.
    shell.configure(None, None).unwrap();
    let flushed = Instant::now();
    loop {
        let s = state.0.lock().unwrap();
        if s.returned {
            break;
        }
        assert!(
            flushed.elapsed() < FINISH_LIMIT + Duration::from_secs(2),
            "the flush was never cancelled (flushing {})",
            s.flushing
        );
        drop(s);
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(
        state.0.lock().unwrap().cancelled,
        "it ended by its own timeout, not a cancel"
    );
}
