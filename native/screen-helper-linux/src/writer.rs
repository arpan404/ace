use crate::protocol::{Result, internal, packet};
use serde_json::json;
use std::{
    io::Write,
    os::unix::net::UnixStream,
    sync::{Arc, Condvar, Mutex},
    thread::JoinHandle,
};
/// Bytes of video units queued for the daemon's socket: a unit that doesn't fit is dropped,
/// keyframes too, and video resumes at the next keyframe that fits.
pub const VIDEO_LIMIT: usize = 8 * 1024 * 1024;

struct Queue {
    /// The newest still: an older one waiting is replaced, stills never queue up.
    latest: Option<Vec<u8>>,
    /// Video units, every one in order: a delta lost would leave the stream undecodable.
    video: std::collections::VecDeque<Vec<u8>>,
    video_bytes: usize,
    /// Past the limit: deltas are dropped until the next keyframe.
    skipping: bool,
    /// Video was dropped and no keyframe has been queued since: who to ask for one. Asked at
    /// once, and again (once per drop) when the queue has drained to half, since a still
    /// desktop sends nothing unless asked.
    recover: Option<Arc<dyn Fn() + Send + Sync>>,
    rearmed: bool,
    closed: bool,
}
#[derive(Clone)]
pub struct Publisher {
    queue: Arc<(Mutex<Queue>, Condvar)>,
    session: String,
    sequence: Arc<std::sync::atomic::AtomicU64>,
}
impl Publisher {
    /// Publishes a picture taken at `at` (Unix milliseconds, when its buffer arrived, not when
    /// it was encoded), for capture `generation` when the daemon gave one.
    pub fn frame(
        &self,
        jpeg: Vec<u8>,
        width: u32,
        height: u32,
        scale: f64,
        at: f64,
        generation: Option<u64>,
    ) -> Result<()> {
        let seq = self
            .sequence
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let mut header = json!({"version":2,"sessionId":self.session,"sequence":seq,"seq":seq,"timestamp":at,"ts":at,"width":width,"height":height,"scale":scale,"codec":"jpeg","bytes":jpeg.len()});
        if let Some(generation) = generation {
            header["captureGeneration"] = json!(generation);
        }
        let bytes = packet(&header, &jpeg)?;
        let (lock, ready) = &*self.queue;
        let mut q = lock.lock().map_err(internal)?;
        if q.closed {
            return Err(internal("Frame endpoint closed"));
        }
        q.latest = Some(bytes);
        ready.notify_one();
        Ok(())
    }

    /// The next frame sequence, shared by stills and video.
    pub fn next_sequence(&self) -> u64 {
        self.sequence
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    }

    pub fn session(&self) -> &str {
        &self.session
    }

    /// Queues one video packet in order, within [`VIDEO_LIMIT`] bytes. A unit that doesn't fit
    /// is dropped, keyframes included, and video resumes at the next keyframe that fits:
    /// `recover` (the capture's keyframe request) is called on the first drop and again once
    /// the queue drains, until a keyframe is queued. `Ok(false)` when this unit was dropped.
    pub fn video(
        &self,
        packet: Vec<u8>,
        keyframe: bool,
        recover: &Arc<dyn Fn() + Send + Sync>,
    ) -> Result<bool> {
        let (lock, ready) = &*self.queue;
        let mut q = lock.lock().map_err(internal)?;
        if q.closed {
            return Err(internal("Frame endpoint closed"));
        }
        let fits = q.video_bytes + packet.len() <= VIDEO_LIMIT || q.video.is_empty();
        if !fits || (q.skipping && !keyframe) {
            q.skipping = true;
            q.rearmed = true;
            let first = q.recover.is_none();
            if first {
                q.recover = Some(recover.clone());
            }
            drop(q);
            if first {
                recover();
            }
            return Ok(false);
        }
        if keyframe {
            q.skipping = false;
            q.recover = None;
        }
        q.video_bytes += packet.len();
        q.video.push_back(packet);
        ready.notify_one();
        Ok(true)
    }
}
pub struct Writer {
    queue: Arc<(Mutex<Queue>, Condvar)>,
    socket: UnixStream,
    worker: Option<JoinHandle<()>>,
}
impl Writer {
    pub fn open(socket: UnixStream) -> Result<Self> {
        // No write timeout: a daemon that is busy for a while must not end the session. Only
        // the newest packet waits, so memory stays bounded, and closing shuts the socket,
        // which ends a blocked write.
        let mut stream = socket.try_clone().map_err(internal)?;
        let queue = Arc::new((
            Mutex::new(Queue {
                latest: None,
                video: Default::default(),
                video_bytes: 0,
                skipping: false,
                recover: None,
                rearmed: false,
                closed: false,
            }),
            Condvar::new(),
        ));
        let q = queue.clone();
        let worker = std::thread::spawn(move || {
            let (lock, ready) = &*q;
            loop {
                let mut state = match lock.lock() {
                    Ok(s) => s,
                    Err(_) => break,
                };
                while state.latest.is_none() && state.video.is_empty() && !state.closed {
                    state = match ready.wait(state) {
                        Ok(s) => s,
                        Err(_) => return,
                    };
                }
                if state.closed {
                    break;
                }
                // Video first, in order; a still waits behind the units already queued.
                let bytes = match state.video.pop_front() {
                    Some(unit) => {
                        state.video_bytes -= unit.len();
                        Some(unit)
                    }
                    None => state.latest.take(),
                };
                // Drained to half with a keyframe still owed: ask again, once per drop.
                let again = (state.video_bytes <= VIDEO_LIMIT / 2 && state.rearmed)
                    .then(|| state.recover.clone())
                    .flatten();
                if again.is_some() {
                    state.rearmed = false;
                }
                drop(state);
                if let Some(again) = again {
                    again();
                }
                if let Some(bytes) = bytes {
                    if stream.write_all(&bytes).is_err() {
                        if let Ok(mut s) = lock.lock() {
                            s.closed = true;
                        }
                        let _ = stream.shutdown(std::net::Shutdown::Both);
                        break;
                    }
                }
            }
        });
        Ok(Self {
            queue,
            socket,
            worker: Some(worker),
        })
    }
    pub fn publisher(&self, session: String) -> Publisher {
        Publisher {
            queue: self.queue.clone(),
            session,
            sequence: Arc::new(std::sync::atomic::AtomicU64::new(0)),
        }
    }
    pub fn abort_socket(&self) -> Result<UnixStream> {
        self.socket.try_clone().map_err(internal)
    }
}
impl Drop for Writer {
    fn drop(&mut self) {
        let (lock, ready) = &*self.queue;
        if let Ok(mut q) = lock.lock() {
            q.closed = true;
            q.latest = None;
            q.video.clear();
        }
        ready.notify_one();
        let _ = self.socket.shutdown(std::net::Shutdown::Both);
        if let Some(w) = self.worker.take() {
            let _ = w.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{VIDEO_LIMIT, Writer};
    use std::io::Read;
    use std::os::unix::net::UnixStream;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    /// Packets read until the socket stays quiet: (keyframe?, bytes) each.
    fn drain(peer: &mut UnixStream) -> Vec<bool> {
        peer.set_read_timeout(Some(Duration::from_millis(300)))
            .unwrap();
        let mut bytes = Vec::new();
        let mut chunk = vec![0u8; 1 << 20];
        while let Ok(n) = peer.read(&mut chunk) {
            if n == 0 {
                break;
            }
            bytes.extend_from_slice(&chunk[..n]);
        }
        let mut keys = Vec::new();
        let mut rest = &bytes[..];
        while rest.len() >= 4 {
            let length = u32::from_be_bytes(rest[..4].try_into().unwrap()) as usize;
            let header: serde_json::Value = serde_json::from_slice(&rest[4..4 + length]).unwrap();
            let payload = header["bytes"].as_u64().unwrap() as usize;
            keys.push(header["keyframe"] == true);
            rest = &rest[4 + length + payload..];
        }
        keys
    }

    fn unit(key: bool, mib: usize) -> Vec<u8> {
        let payload = vec![1u8; mib << 20];
        let header = serde_json::json!({"codec": "h264", "keyframe": key, "bytes": payload.len()});
        crate::protocol::packet(&header, &payload).unwrap()
    }

    #[test]
    fn a_blocked_daemon_socket_holds_a_bounded_queue_even_of_keyframes_and_asks_again_once_it_drains()
     {
        let (ours, mut peer) = UnixStream::pair().unwrap();
        let writer = Writer::open(ours).unwrap();
        let publisher = writer.publisher("s1".into());
        let asked = Arc::new(AtomicUsize::new(0));
        let a = asked.clone();
        let recover: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
            a.fetch_add(1, Ordering::SeqCst);
        });
        // The daemon reads nothing: every unit is a 1 MiB keyframe, far past the budget.
        for _ in 0..24 {
            publisher.video(unit(true, 1), true, &recover).unwrap();
        }
        assert_eq!(
            asked.load(Ordering::SeqCst),
            1,
            "a keyframe is asked for once when video is dropped"
        );
        let taken = drain(&mut peer);
        // What reached the socket: the budget, plus what the kernel buffered and one in flight.
        assert!(
            taken.len() <= VIDEO_LIMIT / (1 << 20) + 3,
            "{} MiB queued for a blocked socket",
            taken.len()
        );
        // Drained: the recovery is asked for again, once, though no unit came since.
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(
            asked.load(Ordering::SeqCst),
            2,
            "asked again once the queue had room"
        );
        drop(writer);
    }
}
