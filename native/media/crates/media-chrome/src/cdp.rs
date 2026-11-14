// SPDX-License-Identifier: Apache-2.0
//! Chrome's `--remote-debugging-pipe`: Chrome reads commands on its fd 3 and writes replies and
//! events on its fd 4, each a JSON message ended by a NUL byte. Only the browser target is
//! used: to open the encoder page and to close the browser.

use media_codec::CodecError;
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Read, Write};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, SyncSender, TrySendError, sync_channel};
use std::time::{Duration, Instant};

pub struct Pipe {
    writer: Box<dyn Write + Send>,
    replies: Receiver<Value>,
    next_id: u64,
}

/// The largest message read from Chrome; the browser target's replies are small.
const MAX_MESSAGE: usize = 1024 * 1024;
/// Replies not yet taken. Commands go one at a time, so more than this means Chrome is sending
/// replies nobody asked for: the browser is treated as gone.
pub const MAX_QUEUED_REPLIES: usize = 16;

impl Pipe {
    /// `alive` turns false when Chrome closes its end (it exited or crashed).
    pub fn new(
        writer: Box<dyn Write + Send>,
        reader: Box<dyn Read + Send>,
        alive: Arc<AtomicBool>,
    ) -> Self {
        let (sender, replies) = sync_channel(MAX_QUEUED_REPLIES);
        let thread_alive = alive.clone();
        let started = std::thread::Builder::new()
            .name("media-chrome-cdp".into())
            .spawn(move || read_messages(reader, &sender, &thread_alive));
        if started.is_err() {
            alive.store(false, Ordering::SeqCst);
        }
        // The reader is never joined: it ends at end of file, which closing the browser causes,
        // and nothing waits on it.
        Self {
            writer,
            replies,
            next_id: 0,
        }
    }

    /// Sends `method` and waits up to `timeout` for its reply's `result`.
    pub fn call(
        &mut self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, CodecError> {
        self.next_id += 1;
        let id = self.next_id;
        let mut message =
            serde_json::to_vec(&json!({"id": id, "method": method, "params": params}))
                .map_err(|error| CodecError::Backend(error.to_string()))?;
        message.push(0);
        self.writer
            .write_all(&message)
            .and_then(|()| self.writer.flush())
            .map_err(|error| CodecError::Backend(format!("Chrome's pipe closed: {error}")))?;
        let deadline = Instant::now() + timeout;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            let reply = match self.replies.recv_timeout(left) {
                Ok(reply) => reply,
                Err(RecvTimeoutError::Timeout) => return Err(CodecError::DeadlineExceeded),
                Err(RecvTimeoutError::Disconnected) => {
                    return Err(CodecError::Backend("Chrome's pipe closed".into()));
                }
            };
            if reply.get("id").and_then(Value::as_u64) != Some(id) {
                continue;
            }
            if let Some(error) = reply.get("error") {
                return Err(CodecError::Backend(format!("{method}: {error}")));
            }
            return Ok(reply.get("result").cloned().unwrap_or(Value::Null));
        }
    }
}

fn read_messages(reader: Box<dyn Read + Send>, replies: &SyncSender<Value>, alive: &AtomicBool) {
    let mut reader = BufReader::new(reader);
    let mut message = Vec::new();
    loop {
        message.clear();
        match (&mut reader)
            .take(MAX_MESSAGE as u64 + 1)
            .read_until(0, &mut message)
        {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        if message.last() != Some(&0) {
            // Over the limit, or cut off by Chrome exiting: either way the pipe is done.
            break;
        }
        message.pop();
        let Ok(value) = serde_json::from_slice::<Value>(&message) else {
            continue;
        };
        if value.get("id").is_some() {
            match replies.try_send(value) {
                Ok(()) => {}
                Err(TrySendError::Full(_) | TrySendError::Disconnected(_)) => break,
            }
        } else if value.get("method").and_then(Value::as_str) == Some("Inspector.targetCrashed")
            || value.get("method").and_then(Value::as_str) == Some("Target.targetCrashed")
        {
            alive.store(false, Ordering::SeqCst);
        }
    }
    alive.store(false, Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fake Chrome end: answers each command with `{"id", "result": {"echo": method}}`.
    #[test]
    fn replies_are_matched_by_id_and_eof_marks_the_browser_gone() -> Result<(), CodecError> {
        let (chrome_reads, ours_writes) =
            std::io::pipe().map_err(|e| CodecError::Backend(e.to_string()))?;
        let (ours_reads, mut chrome_writes) =
            std::io::pipe().map_err(|e| CodecError::Backend(e.to_string()))?;
        let fake = std::thread::spawn(move || {
            let mut input = BufReader::new(chrome_reads);
            let mut line = Vec::new();
            while input.read_until(0, &mut line).is_ok_and(|n| n > 0) {
                line.pop();
                let Ok(command) = serde_json::from_slice::<Value>(&line) else {
                    break;
                };
                line.clear();
                let event = b"{\"method\":\"Target.targetCreated\",\"params\":{}}\0";
                let reply = json!({"id": command["id"], "result": {"echo": command["method"]}});
                let mut bytes = serde_json::to_vec(&reply).unwrap_or_default();
                bytes.push(0);
                if chrome_writes.write_all(event).is_err()
                    || chrome_writes.write_all(&bytes).is_err()
                {
                    break;
                }
                if command["method"] == "Browser.close" {
                    break;
                }
            }
        });
        let alive = Arc::new(AtomicBool::new(true));
        let mut pipe = Pipe::new(Box::new(ours_writes), Box::new(ours_reads), alive.clone());
        let reply = pipe.call("Target.getTargets", json!({}), Duration::from_secs(5))?;
        assert_eq!(reply["echo"], "Target.getTargets");
        let reply = pipe.call("Browser.close", json!({}), Duration::from_secs(5))?;
        assert_eq!(reply["echo"], "Browser.close");
        let _ = fake.join();
        let deadline = Instant::now() + Duration::from_secs(5);
        while alive.load(Ordering::SeqCst) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(!alive.load(Ordering::SeqCst));
        assert!(
            pipe.call("Target.getTargets", json!({}), Duration::from_secs(1))
                .is_err()
        );
        Ok(())
    }
}
