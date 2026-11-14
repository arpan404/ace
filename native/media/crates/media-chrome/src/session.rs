// SPDX-License-Identifier: Apache-2.0
//! One headless Chrome running the encoder page: spawned with its own debugging pipe and
//! profile, the page opened over the pipe, and the page's two sockets. Dropping a session
//! closes the browser (gracefully, then by force) and removes its profile.

use crate::ChromeOptions;
use crate::cdp::Pipe;
use crate::page::Listener;
use crate::wire::{Chunk, Command, Notice, parse_chunk};
use media_codec::CodecError;
use serde::Deserialize;
use serde_json::json;
use std::net::{Shutdown, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use tungstenite::{Message, WebSocket};

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

pub struct Session {
    child: Child,
    pipe: Option<Pipe>,
    input: WebSocket<TcpStream>,
    output_stream: Option<TcpStream>,
    reader: Option<JoinHandle<()>>,
    events: Receiver<Event>,
    alive: Arc<AtomicBool>,
    profile: PathBuf,
    pub quantizer: bool,
}

fn backend(error: impl std::fmt::Display) -> CodecError {
    CodecError::Backend(error.to_string())
}

/// The command line: a headless browser with no TCP debugging port, no extensions or
/// background services, whose page keeps running unseen at normal priority.
pub fn chrome_args(profile: &std::path::Path, extra: &[String]) -> Vec<String> {
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
    args.extend(extra.iter().cloned());
    args
}

#[cfg(unix)]
fn spawn(
    options: &ChromeOptions,
    profile: &std::path::Path,
) -> Result<(Child, Pipe, Arc<AtomicBool>), CodecError> {
    use command_fds::{CommandFdExt, FdMapping};
    use std::os::fd::OwnedFd;
    let (chrome_reads, ours_writes) = std::io::pipe().map_err(backend)?;
    let (ours_reads, chrome_writes) = std::io::pipe().map_err(backend)?;
    let mut command = std::process::Command::new(&options.executable);
    command
        .args(chrome_args(profile, &options.extra_args))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .fd_mappings(vec![
            FdMapping {
                parent_fd: OwnedFd::from(chrome_reads),
                child_fd: 3,
            },
            FdMapping {
                parent_fd: OwnedFd::from(chrome_writes),
                child_fd: 4,
            },
        ])
        .map_err(backend)?;
    let child = command
        .spawn()
        .map_err(|error| CodecError::Backend(format!("Chrome failed to start: {error}")))?;
    // The child's ends close here, so Chrome exiting reads as end of file.
    drop(command);
    let alive = Arc::new(AtomicBool::new(true));
    let pipe = Pipe::new(Box::new(ours_writes), Box::new(ours_reads), alive.clone());
    Ok((child, pipe, alive))
}

#[cfg(not(unix))]
fn spawn(
    _options: &ChromeOptions,
    _profile: &std::path::Path,
) -> Result<(Child, Pipe, Arc<AtomicBool>), CodecError> {
    // Windows passes the pipe as inherited C runtime descriptors 3 and 4; that launcher is
    // still to be written (docs/media/plan.md, B4 notes).
    Err(CodecError::Unsupported(
        "the Chrome encoder's debugging pipe is not wired on this platform yet".into(),
    ))
}

impl Session {
    pub fn start(options: &ChromeOptions) -> Result<Self, CodecError> {
        let deadline = Instant::now() + options.startup_timeout;
        let listener = Listener::bind()?;
        let mut random = [0u8; 6];
        getrandom::fill(&mut random).map_err(backend)?;
        let tag: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let profile = options
            .profile_root
            .join(format!("chrome-encoder-{}-{tag}", std::process::id()));
        create_private_dir(&profile)?;
        let (mut child, mut pipe, alive) = match spawn(options, &profile) {
            Ok(spawned) => spawned,
            Err(error) => {
                let _ = std::fs::remove_dir_all(&profile);
                return Err(error);
            }
        };
        let opened = (|| {
            let left = deadline.saturating_duration_since(Instant::now());
            pipe.call(
                "Target.createTarget",
                json!({"url": listener.url(), "background": true}),
                left,
            )?;
            let alive_check = alive.clone();
            let sockets = listener.accept(deadline, &move || alive_check.load(Ordering::SeqCst))?;
            Ok::<_, CodecError>(sockets)
        })();
        let sockets = match opened {
            Ok(sockets) => sockets,
            Err(error) => {
                close_browser(&mut child, Some(&mut pipe));
                drop(pipe);
                let _ = std::fs::remove_dir_all(&profile);
                return Err(error);
            }
        };
        let output_stream = sockets.output.get_ref().try_clone().map_err(backend)?;
        let (sender, events) = channel();
        let reader_alive = alive.clone();
        let mut output = sockets.output;
        let (hello_sender, hello) = channel();
        let reader = std::thread::Builder::new()
            .name("media-chrome-output".into())
            .spawn(move || read_output(&mut output, &sender, &hello_sender, &reader_alive))
            .map_err(backend)?;
        let mut session = Self {
            child,
            pipe: Some(pipe),
            input: sockets.input,
            output_stream: Some(output_stream),
            reader: Some(reader),
            events,
            alive,
            profile,
            quantizer: false,
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
        self.alive.load(Ordering::SeqCst)
    }

    pub fn pid(&self) -> u32 {
        self.child.id()
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
            return Err(CodecError::Backend("Chrome is gone".into()));
        }
        self.input.send(message).map_err(|error| {
            self.alive.store(false, Ordering::SeqCst);
            CodecError::Backend(format!("encoder page went away: {error}"))
        })
    }

    pub fn try_event(&self) -> Option<Event> {
        self.events.try_recv().ok()
    }

    /// The next event, waiting at most until `deadline`.
    pub fn event_until(&self, deadline: Instant) -> Option<Event> {
        self.events
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .ok()
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        let _ = self.input.close(None);
        let _ = self.input.flush();
        close_browser(&mut self.child, self.pipe.as_mut());
        self.alive.store(false, Ordering::SeqCst);
        if let Some(stream) = self.output_stream.take() {
            let _ = stream.shutdown(Shutdown::Both);
        }
        let _ = self.input.get_ref().shutdown(Shutdown::Both);
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
        // Chrome has exited, so its pipe end is closed and the pipe's reader has ended.
        drop(self.pipe.take());
        remove_profile(&self.profile);
    }
}

/// `Browser.close`, then a kill if Chrome is still running after two seconds.
fn close_browser(child: &mut Child, pipe: Option<&mut Pipe>) {
    if matches!(child.try_wait(), Ok(None)) {
        if let Some(pipe) = pipe {
            let _ = pipe.call("Browser.close", json!({}), Duration::from_secs(1));
        }
        let deadline = Instant::now() + Duration::from_secs(2);
        while matches!(child.try_wait(), Ok(None)) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    if matches!(child.try_wait(), Ok(None)) {
        let _ = child.kill();
    }
    let _ = child.wait();
}

/// Chrome's helpers may still be writing for a moment after the browser exits.
fn remove_profile(profile: &std::path::Path) {
    for _ in 0..20 {
        if std::fs::remove_dir_all(profile).is_ok() || !profile.exists() {
            return;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

fn create_private_dir(path: &std::path::Path) -> Result<(), CodecError> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path).map_err(backend)
}

fn read_output(
    output: &mut WebSocket<TcpStream>,
    events: &Sender<Event>,
    hello: &Sender<bool>,
    alive: &AtomicBool,
) {
    loop {
        let message = match output.read() {
            Ok(message) => message,
            Err(_) => break,
        };
        let event = match message {
            Message::Binary(bytes) => match parse_chunk(&bytes) {
                Ok(chunk) => Event::Chunk(chunk),
                Err(_) => continue,
            },
            Message::Text(text) => {
                if let Ok(greeting) = serde_json::from_str::<Hello>(text.as_str()) {
                    let _ = hello.send(greeting.quantizer);
                    continue;
                }
                match serde_json::from_str::<Notice>(text.as_str()) {
                    Ok(Notice::Other) | Err(_) => continue,
                    Ok(notice) => Event::Notice(notice),
                }
            }
            Message::Close(_) => break,
            Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => continue,
        };
        if events.send(event).is_err() {
            break;
        }
    }
    alive.store(false, Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_command_line_has_a_pipe_and_no_port_and_keeps_extra_flags_last() {
        let args = chrome_args(std::path::Path::new("/tmp/p"), &["--no-sandbox".into()]);
        assert!(args.contains(&"--remote-debugging-pipe".to_string()));
        assert!(
            !args
                .iter()
                .any(|arg| arg.starts_with("--remote-debugging-port"))
        );
        assert!(args.contains(&"--user-data-dir=/tmp/p".to_string()));
        assert_eq!(args.last().map(String::as_str), Some("--no-sandbox"));
    }
}
