// SPDX-License-Identifier: Apache-2.0
//! The image process's stdout (ADR 0201): one writer thread behind a queue bounded in bytes. An
//! answer whose image would take the queue past its bound is not queued; the server sends a
//! `busy` refusal in its place, so a slow reader costs jobs, never the process.
use std::collections::VecDeque;
use std::io::Write;
use std::sync::{Arc, Condvar, Mutex};

/// Answer bytes waiting for the daemon to read them.
pub const OUTPUT_BYTES: usize = 48 * 1024 * 1024;

#[derive(Default)]
struct State {
    frames: VecDeque<Vec<u8>>,
    bytes: usize,
    closed: bool,
    failed: bool,
}

pub struct Output {
    shared: Arc<(Mutex<State>, Condvar)>,
    limit: usize,
    writer: Option<std::thread::JoinHandle<()>>,
}

impl Output {
    pub fn spawn(mut sink: impl Write + Send + 'static, limit: usize) -> std::io::Result<Self> {
        let shared: Arc<(Mutex<State>, Condvar)> = Arc::default();
        let state = shared.clone();
        let writer = std::thread::Builder::new()
            .name("ace-media-image-out".into())
            .spawn(move || {
                let (lock, ready) = &*state;
                loop {
                    let frame = {
                        let Ok(mut s) = lock.lock() else { return };
                        loop {
                            if let Some(frame) = s.frames.pop_front() {
                                break frame;
                            }
                            if s.closed {
                                return;
                            }
                            s = match ready.wait(s) {
                                Ok(s) => s,
                                Err(_) => return,
                            };
                        }
                    };
                    let written = sink.write_all(&frame).and_then(|()| sink.flush());
                    if let Ok(mut s) = lock.lock() {
                        s.bytes -= frame.len();
                        if written.is_err() {
                            s.failed = true;
                            return;
                        }
                    }
                }
            })?;
        Ok(Self {
            shared,
            limit,
            writer: Some(writer),
        })
    }

    /// Queues a frame if it fits the bound; false (and nothing queued) when it doesn't.
    pub fn push(&self, frame: Vec<u8>) -> bool {
        let (lock, ready) = &*self.shared;
        let Ok(mut s) = lock.lock() else { return false };
        if s.bytes + frame.len() > self.limit {
            return false;
        }
        s.bytes += frame.len();
        s.frames.push_back(frame);
        ready.notify_one();
        true
    }

    /// Queues a small frame (a refusal) whatever the bound: refusals are a few hundred bytes,
    /// and at most one stands for each job the server holds.
    pub fn push_small(&self, frame: Vec<u8>) {
        let (lock, ready) = &*self.shared;
        if let Ok(mut s) = lock.lock() {
            s.bytes += frame.len();
            s.frames.push_back(frame);
            ready.notify_one();
        }
    }

    /// Whether a write to the daemon failed: the server then exits.
    pub fn failed(&self) -> bool {
        self.shared.0.lock().map_or(true, |s| s.failed)
    }

    /// Writes what is queued, then stops the writer.
    pub fn finish(mut self) {
        if let Ok(mut s) = self.shared.0.lock() {
            s.closed = true;
        }
        self.shared.1.notify_all();
        if let Some(writer) = self.writer.take() {
            let _ = writer.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    /// A reader that takes nothing until the test lets it.
    struct Held(mpsc::Receiver<()>, mpsc::Sender<Vec<u8>>);
    impl Write for Held {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            let _ = self.0.recv();
            let _ = self.1.send(buf.to_vec());
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn an_answer_past_the_byte_bound_is_not_queued_while_small_refusals_still_go_out()
    -> std::io::Result<()> {
        let (go, held) = mpsc::channel();
        let (sent, out) = mpsc::channel();
        let output = Output::spawn(Held(held, sent), 100)?;
        assert!(output.push(vec![1; 60]));
        assert!(
            !output.push(vec![2; 60]),
            "a frame past the bound was queued"
        );
        output.push_small(vec![3; 10]);
        for _ in 0..2 {
            let _ = go.send(());
        }
        output.finish();
        assert_eq!(
            out.try_iter().collect::<Vec<_>>(),
            [vec![1; 60], vec![3; 10]]
        );
        Ok(())
    }
}
