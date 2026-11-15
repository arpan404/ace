use super::*;
use media_wire::frame::MediaFrame;
use std::sync::Mutex;
use tokio::net::UnixListener;

fn unit(sequence: u64) -> VideoUnit {
    VideoUnit {
        sequence,
        timestamp_ms: 1.,
        scale: 1.,
        width: 64,
        height: 64,
        key: sequence.is_multiple_of(5),
        codec: None,
        epoch: 3,
        captured_us: 0,
        payload: vec![0, 0, 0, 1, 0x65, sequence as u8],
    }
}

struct Harness {
    ingest: Ingest,
    legacy: Arc<Mutex<Vec<u64>>>,
    closed: Arc<Mutex<Vec<Option<u64>>>>,
    _dir: tempdir::Dir,
}

mod tempdir {
    pub struct Dir(pub std::path::PathBuf);
    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    pub fn new() -> Dir {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("ace-e2-ingest-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Dir(dir)
    }
}

fn harness() -> Harness {
    let legacy: Arc<Mutex<Vec<u64>>> = Arc::default();
    let closed: Arc<Mutex<Vec<Option<u64>>>> = Arc::default();
    let (l, c) = (legacy.clone(), closed.clone());
    let ingest = Ingest::spawn(
        Clock::start(),
        Outlets {
            legacy: Box::new(move |unit| l.lock().unwrap().push(unit.sequence)),
            keyframe: Arc::new(|| {}),
            closed: Box::new(move |boundary| c.lock().unwrap().push(boundary)),
        },
    );
    Harness {
        ingest,
        legacy,
        closed,
        _dir: tempdir::new(),
    }
}

impl Harness {
    fn listener(&self, name: &str) -> (UnixListener, Address) {
        let path = self._dir.0.join(name);
        let listener = UnixListener::bind(&path).unwrap();
        let address = Address {
            socket: path.to_string_lossy().into_owned(),
            token: zeroize::Zeroizing::new([7; 32]),
        };
        (listener, address)
    }
}

/// Every frame a connection carried, until the helper closed it.
async fn frames(listener: UnixListener) -> Vec<MediaFrame> {
    let (mut stream, _) = listener.accept().await.unwrap();
    let mut bytes = Vec::new();
    stream.read_to_end(&mut bytes).await.unwrap();
    let mut out = Vec::new();
    let mut rest = &bytes[..];
    while rest.len() >= 12 {
        let header = u16::from_be_bytes([rest[6], rest[7]]) as usize;
        let payload = u32::from_be_bytes(rest[8..12].try_into().unwrap()) as usize;
        let (one, tail) = rest.split_at(header + payload);
        out.push(MediaFrame::decode(one).unwrap());
        rest = tail;
    }
    out
}

fn sequences(frames: &[MediaFrame]) -> Vec<u64> {
    frames
        .iter()
        .filter(|f| f.kind == 1)
        .map(|f| u64::from_be_bytes(f.extension[4..12].try_into().unwrap()))
        .collect()
}

async fn settle() {
    tokio::time::sleep(Duration::from_millis(100)).await;
}

#[tokio::test(flavor = "current_thread")]
async fn route_flips_lose_and_repeat_nothing_and_each_replaced_path_ends_cleanly() {
    let h = harness();
    let (first, a) = h.listener("a.sock");
    let (second, b) = h.listener("b.sock");
    let first = tokio::spawn(frames(first));
    let second = tokio::spawn(frames(second));
    for n in 0..5 {
        h.ingest.unit(unit(n));
    }
    let moved = h.ingest.route(Some(a)).await.unwrap();
    assert_eq!(
        moved,
        Moved {
            switched: true,
            boundary: Some(4)
        }
    );
    for n in 5..12 {
        h.ingest.unit(unit(n));
    }
    let moved = h.ingest.route(Some(b)).await.unwrap();
    assert_eq!(
        moved,
        Moved {
            switched: true,
            boundary: Some(11)
        }
    );
    for n in 12..15 {
        h.ingest.unit(unit(n));
    }
    let moved = h.ingest.route(None).await.unwrap();
    assert_eq!(
        moved,
        Moved {
            switched: true,
            boundary: Some(14)
        }
    );
    for n in 15..17 {
        h.ingest.unit(unit(n));
    }
    let (a, b) = (first.await.unwrap(), second.await.unwrap());
    settle().await;
    assert_eq!(a.first().map(|f| f.kind), Some(5), "the hello goes first");
    assert_eq!(
        a.last().map(|f| f.kind),
        Some(4),
        "a planned switch ends with the end frame"
    );
    assert_eq!(b.last().map(|f| f.kind), Some(4));
    assert_eq!(sequences(&a), (5..12).collect::<Vec<_>>());
    let mut all = h.legacy.lock().unwrap().clone();
    all.extend(sequences(&a));
    all.extend(sequences(&b));
    all.sort_unstable();
    assert_eq!(
        all,
        (0..17).collect::<Vec<_>>(),
        "every unit once, none twice"
    );
    assert!(h.closed.lock().unwrap().is_empty());
}

#[tokio::test(flavor = "current_thread")]
async fn ace_media_dying_puts_video_back_on_the_daemons_socket_within_two_seconds() {
    let h = harness();
    let (listener, a) = h.listener("a.sock");
    let accepted = tokio::spawn(async move { listener.accept().await.unwrap().0 });
    h.ingest.route(Some(a)).await.unwrap();
    let peer = accepted.await.unwrap();
    h.ingest.unit(unit(0));
    h.ingest.unit(unit(1));
    settle().await;
    let died = Instant::now();
    drop(peer);
    while h.closed.lock().unwrap().is_empty() && died.elapsed() < Duration::from_secs(2) {
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert!(died.elapsed() < Duration::from_secs(2));
    assert_eq!(*h.closed.lock().unwrap(), vec![Some(1)]);
    h.ingest.unit(unit(2));
    settle().await;
    assert_eq!(*h.legacy.lock().unwrap(), vec![2]);
}

#[tokio::test(flavor = "current_thread")]
async fn a_socket_that_cannot_be_opened_leaves_video_on_the_daemons_socket() {
    let h = harness();
    let missing = Address {
        socket: h._dir.0.join("none.sock").to_string_lossy().into_owned(),
        token: zeroize::Zeroizing::new([0; 32]),
    };
    assert!(h.ingest.route(Some(missing)).await.is_err());
    h.ingest.unit(unit(0));
    settle().await;
    assert_eq!(*h.legacy.lock().unwrap(), vec![0]);
}

fn sized(sequence: u64, key: bool, bytes: usize) -> VideoUnit {
    VideoUnit {
        key,
        payload: vec![1; bytes],
        ..unit(sequence)
    }
}

#[tokio::test(flavor = "current_thread")]
async fn a_stalled_route_admits_a_bounded_backlog_then_drops_to_the_next_keyframe_and_asks_for_one()
{
    let legacy: Arc<Mutex<Vec<u64>>> = Arc::default();
    let asked = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let (l, a) = (legacy.clone(), asked.clone());
    let ingest = Ingest::spawn(
        Clock::start(),
        Outlets {
            legacy: Box::new(move |unit| l.lock().unwrap().push(unit.sequence)),
            keyframe: Arc::new(move || {
                a.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }),
            closed: Box::new(|_| {}),
        },
    );
    // Nothing awaits here, so the route's task can't run: routing is stalled while the
    // capture keeps producing 1 MiB units.
    let mib = 1024 * 1024;
    for n in 0..40 {
        ingest.unit(sized(n, n == 0 || n == 30, mib));
    }
    let admitted = 0..(ADMIT_LIMIT / mib) as u64;
    assert!(
        asked.load(std::sync::atomic::Ordering::SeqCst) >= 1,
        "a keyframe is asked for as soon as video is dropped"
    );
    settle().await;
    // What was admitted is routed, in order; nothing past the limit was kept, the keyframe at
    // 30 included, since routing was still stalled when it came.
    assert_eq!(
        *legacy.lock().unwrap(),
        admitted.clone().collect::<Vec<_>>()
    );
    // Routing caught up: deltas still wait for a keyframe, and the one asked for resumes video.
    ingest.unit(sized(40, false, mib));
    ingest.unit(sized(41, true, mib));
    ingest.unit(sized(42, false, mib));
    settle().await;
    let mut expected: Vec<u64> = admitted.collect();
    expected.extend([41, 42]);
    assert_eq!(*legacy.lock().unwrap(), expected);
}

#[tokio::test(flavor = "current_thread")]
async fn starting_and_stopping_captures_leaves_no_task_or_descriptor_behind() {
    let dir = tempdir::new();
    let path = dir.0.join("ingest.sock");
    let listener = UnixListener::bind(&path).unwrap();
    tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                return;
            };
            tokio::spawn(async move {
                let mut sink = Vec::new();
                let _ = stream.read_to_end(&mut sink).await;
            });
        }
    });
    let descriptors = || {
        std::fs::read_dir("/proc/self/fd")
            .map(|d| d.count())
            .unwrap_or(0)
    };
    // What the capture hands its route: its publisher, controls and wake socket.
    let held = Arc::new(());
    let cycle = |held: Arc<()>| {
        let (a, b, c) = (held.clone(), held.clone(), held);
        Ingest::spawn(
            Clock::start(),
            Outlets {
                legacy: Box::new(move |_| {
                    let _ = &a;
                }),
                keyframe: Arc::new(move || {
                    let _ = &b;
                }),
                closed: Box::new(move |_| {
                    let _ = &c;
                }),
            },
        )
    };
    let warm = cycle(held.clone());
    warm.close();
    drop(warm);
    settle().await;
    let before = descriptors();
    for n in 0..20 {
        let ingest = cycle(held.clone());
        let address = Address {
            socket: path.to_string_lossy().into_owned(),
            token: zeroize::Zeroizing::new([1; 32]),
        };
        ingest.route(Some(address)).await.unwrap();
        ingest.unit(unit(n));
        ingest.close();
        drop(ingest);
    }
    settle().await;
    settle().await;
    assert_eq!(
        Arc::strong_count(&held),
        1,
        "every route task ended and let go of its outlets"
    );
    assert!(
        descriptors() <= before,
        "{} descriptors, {} before",
        descriptors(),
        before
    );
}
