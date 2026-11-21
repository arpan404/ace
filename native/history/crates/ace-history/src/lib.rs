// SPDX-License-Identifier: Apache-2.0

//! `ace-history`, the daemon's saved-history reader (ADR 0206): the reader worker's messages,
//! framed over stdin and stdout. One thread reads frames, one serves lists and reads from its own
//! connection while a scan or import runs, and the main thread runs one operation at a time.

mod archive;
mod cancel;
mod catalog;
mod error;
mod fsread;
mod import;
mod json;
mod options;
mod paths;
mod scan;
mod server;
mod session;
mod setup;
mod snapshot;
mod transport;

use std::io::Read;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;

use history_wire::{Decoder, Frame, Inbound, Request};
use serde_json::json;

use cancel::Cancel;
use transport::Out;

/// A request for the main thread, with the bodies its message carried.
pub(crate) struct Op {
    pub id: i64,
    pub request: Result<Request, String>,
    pub bodies: Vec<Vec<u8>>,
}

pub(crate) enum ToMain {
    Init(serde_json::Value),
    Op(Op),
}

fn watch_parent() {
    let Some(pid) = std::env::var("ACE_HISTORY_READER_PARENT")
        .ok()
        .and_then(|p| p.parse::<i32>().ok())
    else {
        return;
    };
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(std::time::Duration::from_millis(250));
            if !setup::process_alive(pid) {
                std::process::exit(1);
            }
        }
    });
}

/// Serve the daemon until stdin closes. Returns the exit code.
pub fn run() -> i32 {
    let out = Out::new();
    let fault = out.clone();
    std::panic::set_hook(Box::new(move |info| {
        let message = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| (*s).to_owned())
            .or_else(|| info.payload().downcast_ref::<String>().cloned());
        let message = format!(
            "The history reader failed: {}",
            message.unwrap_or_else(|| "panic".to_owned())
        );
        fault.send(&json!({ "fault": { "message": message } }), &[], 0);
        std::process::exit(70);
    }));
    watch_parent();
    let cancel = Cancel::new();
    let busy = Arc::new(AtomicBool::new(false));
    let (to_main, from_stdin) = mpsc::channel::<ToMain>();
    let (to_reads, reads) = mpsc::channel::<Op>();
    {
        let (cancel, busy, out) = (cancel.clone(), busy.clone(), out.clone());
        std::thread::spawn(move || read_stdin(&cancel, &busy, &out, &to_main, &to_reads));
    }
    server::serve(&out, &cancel, &busy, &from_stdin, reads)
}

fn read_stdin(
    cancel: &Cancel,
    busy: &AtomicBool,
    out: &Out,
    to_main: &mpsc::Sender<ToMain>,
    to_reads: &mpsc::Sender<Op>,
) {
    let mut stdin = std::io::stdin().lock();
    let mut decoder = Decoder::new();
    let mut chunk = vec![0u8; 64 * 1024];
    let mut bodies: Vec<Vec<u8>> = Vec::new();
    loop {
        let read = match stdin.read(&mut chunk) {
            // The daemon is gone: nothing can use this reader any more.
            Ok(0) | Err(_) => std::process::exit(0),
            Ok(read) => read,
        };
        decoder.push(&chunk[..read]);
        loop {
            let frame = match decoder.poll() {
                Ok(Some(frame)) => frame,
                Ok(None) => break,
                Err(history_wire::WireError::TooLarge(_)) => std::process::exit(1),
                Err(_) => continue,
            };
            let text = match frame {
                Frame::Body { bytes, .. } => {
                    bodies.push(bytes);
                    continue;
                }
                Frame::Json(text) => text,
            };
            let carried = std::mem::take(&mut bodies);
            match Inbound::parse(&text) {
                Inbound::Init(options) => {
                    let _ = to_main.send(ToMain::Init(options));
                }
                Inbound::Cancel => cancel.cancel(),
                Inbound::Unknown => {}
                Inbound::Envelope { id, request } => {
                    if matches!(request, Ok(Request::List { .. } | Request::Get { .. })) {
                        let _ = to_reads.send(Op {
                            id,
                            request,
                            bodies: carried,
                        });
                    } else if busy.swap(true, Ordering::SeqCst) {
                        out.error(id, "History operation already in progress");
                    } else {
                        let _ = to_main.send(ToMain::Op(Op {
                            id,
                            request,
                            bodies: carried,
                        }));
                    }
                }
            }
        }
    }
}
