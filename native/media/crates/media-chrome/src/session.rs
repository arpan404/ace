// SPDX-License-Identifier: Apache-2.0
//! One headless Chrome running the encoder page: spawned with its own debugging pipe and
//! profile, the page opened over the pipe, and the page's two sockets.
//!
//! - **Cleanup.** The moment Chrome exists it is owned by a guard (`Owned`) that closes it
//!   (gracefully, then the whole process tree by force) and removes its profile, on every path:
//!   a failed start, a crash, or a normal drop.
//! - **Bounds.** What the page sends and nobody has taken yet is bounded in events and bytes;
//!   past either bound the session ends, as it does for a protocol error.

use crate::ChromeOptions;
use crate::cdp::Pipe;
use crate::page::Listener;
use crate::process::Browser;
use crate::wire::{Chunk, Command, Notice, parse_chunk};
use crate::{process, profiles};
use media_codec::CodecError;
use serde::Deserialize;
use serde_json::json;
use std::net::{Shutdown, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{
    Receiver, RecvTimeoutError, SyncSender, TrySendError, channel, sync_channel,
};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime};
use tungstenite::{Message, WebSocket};

/// Events from the page not yet taken by the encoder.
pub const MAX_QUEUED_EVENTS: usize = 256;
/// Bytes of chunks not yet taken by the encoder.
pub const MAX_QUEUED_BYTES: usize = 64 * 1024 * 1024;

pub enum Event {
    Chunk(Chunk),
    Notice(Notice),
}

/// What the page reports once both sockets are open.
#[derive(Deserialize)]
#[serde(tag = "t", rename = "hello")]
struct Hello {
    quantizer: bool,
}

/// Why a session ended, when it was ended on purpose (a bound or protocol limit).
type Reason = Arc<Mutex<Option<String>>>;

/// The browser process and its profile; dropping it closes the one and removes the other.
struct Owned {
    browser: Browser,
    pipe: Option<Pipe>,
    profile: PathBuf,
}

impl Drop for Owned {
    fn drop(&mut self) {
        if !self.browser.exited() {
            if let Some(pipe) = self.pipe.as_mut() {
                let _ = pipe.call("Browser.close", json!({}), Duration::from_secs(1));
            }
            self.browser.wait(Duration::from_secs(2));
        }
        // Helpers can outlive the browser for a moment; the whole tree goes.
        self.browser.kill_tree();
        self.browser.wait(Duration::from_secs(2));
        drop(self.pipe.take());
        remove_profile(&self.profile);
    }
}

pub struct Session {
    input: WebSocket<TcpStream>,
    output_stream: Option<TcpStream>,
    reader: Option<JoinHandle<()>>,
    events: Receiver<(Event, usize)>,
    queued_bytes: Arc<AtomicUsize>,
    alive: Arc<AtomicBool>,
    reason: Reason,
    pub quantizer: bool,
    // Last, so it drops after the sockets are closed and the reader has ended.
    owned: Owned,
}

fn backend(error: impl std::fmt::Display) -> CodecError {
    CodecError::Backend(error.to_string())
}

/// The whole command line. Nothing is taken from callers: the sandbox, web security, the
/// debugging transport and the profile are never theirs to change. A headless browser with no
/// TCP debugging port, no extensions or background services, whose page keeps running unseen
/// at normal priority.
pub fn chrome_args(profile: &Path) -> Vec<String> {
    let mut args = vec![
        "--headless=new".to_string(),
        "--remote-debugging-pipe".into(),
        format!("--user-data-dir={}", profile.display()),
        "--no-first-run".into(),
        "--no-default-browser-check".into(),
        "--no-startup-window".into(),
        "--disable-extensions".into(),
        "--disable-component-update".into(),
        "--disable-sync".into(),
        "--disable-default-apps".into(),
        "--disable-background-networking".into(),
        "--disable-background-timer-throttling".into(),
        "--disable-renderer-backgrounding".into(),
        "--disable-backgrounding-occluded-windows".into(),
        "--disable-features=PMProcessPriorityPolicy".into(),
        "--disable-audio-output".into(),
    ];
    if cfg!(target_os = "macos") {
        args.push("--use-mock-keychain".into());
    }
    if cfg!(target_os = "linux") {
        args.push("--password-store=basic".into());
    }
    args
}

impl Session {
    pub fn start(options: &ChromeOptions) -> Result<Self, CodecError> {
        let deadline = Instant::now() + options.startup_timeout;
        profiles::reclaim(&options.profile_root, SystemTime::now());
        let listener = Listener::bind()?;
        let profile = profiles::create(&options.profile_root, std::process::id())?;
        let (browser, writer, reader) =
            match process::spawn(&options.executable, chrome_args(&profile)) {
                Ok(spawned) => spawned,
                Err(error) => {
                    remove_profile(&profile);
                    return Err(error);
                }
            };
        let alive = Arc::new(AtomicBool::new(true));
        // From here on every early return closes Chrome and removes the profile.
        let mut owned = Owned {
            pipe: Some(Pipe::new(writer, reader, alive.clone())),
            browser,
            profile,
        };
        let left = deadline.saturating_duration_since(Instant::now());
        owned
            .pipe
            .as_mut()
            .ok_or_else(|| CodecError::Backend("no pipe".into()))?
            .call(
                "Target.createTarget",
                json!({"url": listener.url(), "background": true}),
                left,
            )?;
        let sockets = {
            let browser = &owned.browser;
            let alive = &alive;
            listener.accept(deadline, &move || {
                alive.load(Ordering::SeqCst) && !browser.exited()
            })?
        };
        let output_stream = sockets.output.get_ref().try_clone().map_err(backend)?;
        let (sender, events) = sync_channel(MAX_QUEUED_EVENTS);
        let (hello_sender, hello) = channel();
        let queued_bytes = Arc::new(AtomicUsize::new(0));
        let reason: Reason = Arc::new(Mutex::new(None));
        let mut output = sockets.output;
        let shared = Shared {
            events: sender,
            hello: hello_sender,
            alive: alive.clone(),
            queued_bytes: queued_bytes.clone(),
            reason: reason.clone(),
            stream: output_stream.try_clone().map_err(backend)?,
        };
        let reader = std::thread::Builder::new()
            .name("media-chrome-output".into())
            .spawn(move || read_output(&mut output, &shared))
            .map_err(backend)?;
        let mut session = Self {
            input: sockets.input,
            output_stream: Some(output_stream),
            reader: Some(reader),
            events,
            queued_bytes,
            alive,
            reason,
            quantizer: false,
            owned,
        };
        let left = deadline.saturating_duration_since(Instant::now());
        session.quantizer = match hello.recv_timeout(left) {
            Ok(quantizer) => quantizer,
            Err(RecvTimeoutError::Timeout) => return Err(CodecError::DeadlineExceeded),
            Err(RecvTimeoutError::Disconnected) => {
                return Err(CodecError::Backend(
                    "the encoder page closed while starting".into(),
                ));
            }
        };
        Ok(session)
    }

    pub fn alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst) && !self.owned.browser.exited()
    }

    /// Why the session ended, if it ended.
    pub fn end_reason(&self) -> String {
        self.reason
            .lock()
            .ok()
            .and_then(|reason| reason.clone())
            .unwrap_or_else(|| "Chrome exited".into())
    }

    pub fn pid(&self) -> u32 {
        self.owned.browser.pid()
    }

    pub fn command(&mut self, command: &Command) -> Result<(), CodecError> {
        let text = serde_json::to_string(command).map_err(backend)?;
        self.send(Message::text(text))
    }

    pub fn picture(&mut self, message: Vec<u8>) -> Result<(), CodecError> {
        self.send(Message::binary(message))
    }

    fn send(&mut self, message: Message) -> Result<(), CodecError> {
        if !self.alive() {
            return Err(CodecError::Backend(self.end_reason()));
        }
        self.input.send(message).map_err(|error| {
            self.alive.store(false, Ordering::SeqCst);
            CodecError::Backend(format!("encoder page went away: {error}"))
        })
    }

    fn taken(&self, (event, cost): (Event, usize)) -> Event {
        self.queued_bytes.fetch_sub(cost, Ordering::SeqCst);
        event
    }

    pub fn try_event(&self) -> Option<Event> {
        self.events.try_recv().ok().map(|item| self.taken(item))
    }

    /// The next event, waiting at most until `deadline`.
    pub fn event_until(&self, deadline: Instant) -> Option<Event> {
        self.events
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .ok()
            .map(|item| self.taken(item))
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        let _ = self.input.close(None);
        let _ = self.input.flush();
        self.alive.store(false, Ordering::SeqCst);
        if let Some(stream) = self.output_stream.take() {
            let _ = stream.shutdown(Shutdown::Both);
        }
        let _ = self.input.get_ref().shutdown(Shutdown::Both);
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
        // `owned` drops next: the browser closes and its profile goes.
    }
}

/// Chrome's helpers may still be writing for a moment after the browser exits.
fn remove_profile(profile: &Path) {
    for _ in 0..20 {
        if std::fs::remove_dir_all(profile).is_ok() || !profile.exists() {
            return;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

/// What the output reader shares with the session.
struct Shared {
    events: SyncSender<(Event, usize)>,
    hello: std::sync::mpsc::Sender<bool>,
    alive: Arc<AtomicBool>,
    queued_bytes: Arc<AtomicUsize>,
    reason: Reason,
    stream: TcpStream,
}

impl Shared {
    fn end(&self, why: String) {
        if let Ok(mut reason) = self.reason.lock() {
            reason.get_or_insert(why);
        }
        self.alive.store(false, Ordering::SeqCst);
        let _ = self.stream.shutdown(Shutdown::Both);
    }

    /// Queues one event within both bounds; false when the session had to end.
    fn queue(&self, event: Event, cost: usize) -> bool {
        let queued = self.queued_bytes.fetch_add(cost, Ordering::SeqCst) + cost;
        if queued > MAX_QUEUED_BYTES {
            self.end(format!(
                "the encoder page sent more than {MAX_QUEUED_BYTES} bytes nobody took"
            ));
            return false;
        }
        match self.events.try_send((event, cost)) {
            Ok(()) => true,
            Err(TrySendError::Full(_)) => {
                self.end(format!(
                    "the encoder page sent more than {MAX_QUEUED_EVENTS} events nobody took"
                ));
                false
            }
            Err(TrySendError::Disconnected(_)) => false,
        }
    }
}

fn read_output(output: &mut WebSocket<TcpStream>, shared: &Shared) {
    loop {
        let message = match output.read() {
            Ok(message) => message,
            Err(tungstenite::Error::Capacity(error)) => {
                shared.end(format!("the encoder page broke a protocol limit: {error}"));
                break;
            }
            Err(_) => break,
        };
        let (event, cost) = match message {
            Message::Binary(bytes) => match parse_chunk(&bytes) {
                Ok(chunk) => (Event::Chunk(chunk), bytes.len()),
                Err(error) => {
                    shared.end(error.to_string());
                    break;
                }
            },
            Message::Text(text) => {
                if let Ok(greeting) = serde_json::from_str::<Hello>(text.as_str()) {
                    let _ = shared.hello.send(greeting.quantizer);
                    continue;
                }
                match serde_json::from_str::<Notice>(text.as_str()) {
                    Ok(Notice::Other) | Err(_) => continue,
                    Ok(notice) => (Event::Notice(notice), 0),
                }
            }
            Message::Close(_) => break,
            Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => continue,
        };
        if !shared.queue(event, cost) {
            break;
        }
    }
    shared.alive.store(false, Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_command_line_never_weakens_the_sandbox_or_opens_a_debugging_port() {
        let args = chrome_args(Path::new("/tmp/p"));
        assert!(args.contains(&"--remote-debugging-pipe".to_string()));
        assert_eq!(
            args.iter()
                .filter(|arg| arg.starts_with("--user-data-dir"))
                .collect::<Vec<_>>(),
            [&"--user-data-dir=/tmp/p".to_string()]
        );
        for forbidden in [
            "--no-sandbox",
            "--disable-web-security",
            "--remote-debugging-port",
            "--remote-debugging-address",
            "--disable-setuid-sandbox",
            "--allow-running-insecure-content",
            "--load-extension",
        ] {
            assert!(
                !args.iter().any(|arg| arg.starts_with(forbidden)),
                "{forbidden}"
            );
        }
    }
}
