//! The process shell: a stdin thread that frames requests and answers `cancel` at once, and
//! one serial worker that runs every other op.
use crate::computer::cancel::Cancellations;
use crate::computer::service::Service;
use crate::computer::wire::{LineFramer, REQUEST_LIMIT, RequestLine, error_line, ok_line, parse_line};
use serde_json::{Map, Value, json};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

#[derive(Clone)]
pub struct Output {
    out: Arc<Mutex<std::io::Stdout>>,
}

impl Output {
    fn send(&self, line: &str) {
        let mut out = match self.out.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        let _ = out.write_all(line.as_bytes());
        let _ = out.flush();
    }
}

enum Message {
    Request { id: String, body: Map<String, Value> },
    End,
}

fn read_stdin(output: Output, cancellations: Cancellations, sender: tokio::sync::mpsc::UnboundedSender<Message>) {
    let mut framer = LineFramer::new(REQUEST_LIMIT);
    let mut stdin = std::io::stdin().lock();
    let mut buffer = vec![0u8; 65_536];
    loop {
        let count = match stdin.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(count) => count,
        };
        for framed in framer.feed(&buffer[..count]) {
            match parse_line(&framed) {
                RequestLine::Blank => {}
                RequestLine::Invalid { id, message } => output.send(&error_line(&id, "bad_request", &message)),
                RequestLine::Request { id, body } if body.get("op").and_then(Value::as_str) == Some("cancel") => {
                    let target = body.get("target").and_then(Value::as_str).unwrap_or_default();
                    output.send(&ok_line(&id, json!({"cancelled": cancellations.cancel(target)})));
                }
                RequestLine::Request { id, body } => {
                    cancellations.register(&id);
                    if sender.send(Message::Request { id, body }).is_err() {
                        return;
                    }
                }
            }
        }
    }
    let _ = sender.send(Message::End);
}

/// `--data-dir <dir>`: where screen-sharing restore tokens are kept (the daemon passes
/// `<ACE_HOME>/screen`).
fn data_dir(args: impl Iterator<Item = String>) -> Option<std::path::PathBuf> {
    crate::computer::wire::data_dir_arg(args)
}

pub async fn run() -> i32 {
    let output = Output {
        out: Arc::new(Mutex::new(std::io::stdout())),
    };
    let cancellations = Cancellations::default();
    let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
    {
        let output = output.clone();
        let cancellations = cancellations.clone();
        std::thread::spawn(move || read_stdin(output, cancellations, sender));
    }
    let mut service = Service::new(cancellations.clone(), data_dir(std::env::args().skip(1)));
    while let Some(message) = receiver.recv().await {
        let Message::Request { id, body } = message else { break };
        let check = cancellations.checkpoint(&id);
        let reply = match check.check() {
            Err(error) => Err(error),
            Ok(()) => service.handle(&body, &check).await,
        };
        cancellations.finish(&id);
        output.send(&match reply {
            Ok(result) => ok_line(&id, result),
            Err(error) => error_line(&id, error.code, &error.message),
        });
    }
    0
}
