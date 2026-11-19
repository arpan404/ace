//! The process shell: a stdin thread that frames requests and answers `cancel` at once, and the
//! worker (this thread, in a COM multithreaded apartment) that runs every other op in order.
//! Stdin closing ends the process after the clipboard is put back.
use super::cancel::Cancellations;
use super::known::data_dir_arg;
use super::service::Service;
use super::wire::{error_line, ok_line, parse_line, LineFramer, RequestLine, REQUEST_LIMIT};
use serde_json::{json, Map, Value};
use std::io::{Read, Write};
use std::sync::{mpsc, Arc, Mutex};
use windows::Win32::{
    System::Com::{CoInitializeEx, COINIT_MULTITHREADED},
    UI::HiDpi::{SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2},
};

#[derive(Clone)]
struct Output {
    out: Arc<Mutex<std::io::Stdout>>,
}

impl Output {
    fn send(&self, line: &str) {
        let mut out = self.out.lock().unwrap_or_else(|e| e.into_inner());
        let _ = out.write_all(line.as_bytes());
        let _ = out.flush();
    }
}

fn read_stdin(
    output: Output,
    cancellations: Cancellations,
    sender: mpsc::Sender<(String, Map<String, Value>)>,
) {
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
                RequestLine::Invalid { id, message } => {
                    output.send(&error_line(&id, "bad_request", &message))
                }
                RequestLine::Request { id, body }
                    if body.get("op").and_then(Value::as_str) == Some("cancel") =>
                {
                    let target = body
                        .get("target")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    output.send(&ok_line(
                        &id,
                        json!({"cancelled": cancellations.cancel(target)}),
                    ));
                }
                RequestLine::Request { id, body } => {
                    cancellations.register(&id);
                    if sender.send((id, body)).is_err() {
                        return;
                    }
                }
            }
        }
    }
}

pub fn run() -> i32 {
    unsafe {
        // Element frames, window frames and input all in physical pixels on every monitor.
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    let output = Output {
        out: Arc::new(Mutex::new(std::io::stdout())),
    };
    let cancellations = Cancellations::default();
    let (sender, receiver) = mpsc::channel();
    {
        let output = output.clone();
        let cancellations = cancellations.clone();
        std::thread::spawn(move || read_stdin(output, cancellations, sender));
    }
    let mut service = Service::new(data_dir_arg(std::env::args().skip(1)));
    while let Ok((id, body)) = receiver.recv() {
        let check = cancellations.checkpoint(&id);
        let reply = match check.check() {
            Err(error) => Err(error),
            Ok(()) => service.handle(&body, &check),
        };
        cancellations.finish(&id);
        output.send(&match reply {
            Ok(result) => ok_line(&id, result),
            Err(error) => error_line(&id, error.code, &error.message),
        });
    }
    // Told to stop (stdin closed): release anything held and put the clipboard back.
    super::input::release_all();
    service.shutdown();
    0
}
