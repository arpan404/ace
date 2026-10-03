use crate::protocol::{Result, internal, packet};
use serde_json::json;
use std::{
    io::Write,
    os::unix::net::UnixStream,
    sync::{Arc, Condvar, Mutex},
    thread::JoinHandle,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
struct Queue {
    latest: Option<Vec<u8>>,
    closed: bool,
}
#[derive(Clone)]
pub struct Publisher {
    queue: Arc<(Mutex<Queue>, Condvar)>,
    session: String,
    sequence: Arc<std::sync::atomic::AtomicU64>,
}
impl Publisher {
    pub fn frame(&self, jpeg: Vec<u8>, width: u32, height: u32, scale: f64) -> Result<()> {
        let seq = self
            .sequence
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(internal)?
            .as_secs_f64()
            * 1000.;
        let header = json!({"version":2,"sessionId":self.session,"sequence":seq,"seq":seq,"timestamp":ts,"ts":ts,"width":width,"height":height,"scale":scale,"codec":"jpeg","bytes":jpeg.len()});
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
}
pub struct Writer {
    queue: Arc<(Mutex<Queue>, Condvar)>,
    socket: UnixStream,
    worker: Option<JoinHandle<()>>,
}
impl Writer {
    pub fn open(socket: UnixStream) -> Result<Self> {
        let mut stream = socket.try_clone().map_err(internal)?;
        stream
            .set_write_timeout(Some(Duration::from_secs(2)))
            .map_err(internal)?;
        let queue = Arc::new((
            Mutex::new(Queue {
                latest: None,
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
                while state.latest.is_none() && !state.closed {
                    state = match ready.wait(state) {
                        Ok(s) => s,
                        Err(_) => return,
                    };
                }
                if state.closed {
                    break;
                }
                let bytes = state.latest.take();
                drop(state);
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
        }
        ready.notify_one();
        let _ = self.socket.shutdown(std::net::Shutdown::Both);
        if let Some(w) = self.worker.take() {
            let _ = w.join();
        }
    }
}
