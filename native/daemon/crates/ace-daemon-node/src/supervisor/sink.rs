// SPDX-License-Identifier: Apache-2.0
//! The bindings' event sink: the shell's threadsafe function, alone for a
//! normal child, or behind a diverted child's Rust consumer (E3.0b). The
//! routing itself lives in `ace_supervisor::divert::Diverted`.

use ace_supervisor::divert::Diverted;
use ace_supervisor::errors::NodeIoError;
use ace_supervisor::spawn::{Delivered, EventSink, OutputStream, RawExit};
use napi::bindgen_prelude::{FnArgs, Uint8Array};
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use std::sync::Arc;

/// The shell's event listener: `(kind, data)`; for output it returns
/// whether its stream wants more.
pub(super) type Events = ThreadsafeFunction<FnArgs<(String, Uint8Array)>, Option<bool>>;

/// The shell's listener behind a cloneable sink.
#[derive(Clone)]
pub(super) struct TsfnSink {
    events: Arc<Events>,
}

impl TsfnSink {
    pub(super) fn new(events: Events) -> Self {
        Self {
            events: Arc::new(events),
        }
    }

    fn send(&self, kind: &str, data: Vec<u8>) {
        let _ = self.events.call(
            Ok(FnArgs::from((kind.to_owned(), Uint8Array::new(data)))),
            ThreadsafeFunctionCallMode::NonBlocking,
        );
    }
}

fn exit_json(exit: &RawExit) -> Vec<u8> {
    let code = exit
        .code
        .map_or_else(|| "null".to_owned(), |code| code.to_string());
    let signal = exit
        .signal
        .as_ref()
        .map_or_else(|| "null".to_owned(), |signal| format!("\"{signal}\""));
    format!("{{\"code\":{code},\"signal\":{signal}}}").into_bytes()
}

impl EventSink for TsfnSink {
    fn output(&self, stream: OutputStream, bytes: Vec<u8>, delivered: Delivered) {
        let kind = match stream {
            OutputStream::Stdout => "stdout",
            OutputStream::Stderr => "stderr",
        };
        // The answer runs on the JS thread right after the listener; a
        // listener that throws stays an uncaught exception.
        let _ = self.events.call_with_return_value(
            Ok(FnArgs::from((kind.to_owned(), Uint8Array::new(bytes)))),
            ThreadsafeFunctionCallMode::NonBlocking,
            move |more, _env| {
                let more = more?;
                delivered.taken(more.unwrap_or(true));
                Ok(())
            },
        );
    }

    fn end(&self, stream: OutputStream) {
        let kind = match stream {
            OutputStream::Stdout => "stdout-end",
            OutputStream::Stderr => "stderr-end",
        };
        self.send(kind, Vec::new());
    }

    fn exit(&self, exit: RawExit) {
        self.send("exit", exit_json(&exit));
    }

    fn close(&self, exit: RawExit) {
        self.send("close", exit_json(&exit));
    }

    fn stdin_written(&self) {
        self.send("stdin-written", Vec::new());
    }

    fn stdin_error(&self, error: NodeIoError) {
        self.send("stdin-error", error.to_json().into_bytes());
    }

    fn hold_limit(&self) {
        self.send("hold-limit", Vec::new());
    }

    fn held(&self, message: String) {
        self.send("held", message.into_bytes());
    }
}

/// A spawn's sink: the shell alone, or a diverted child's consumer first.
#[derive(Clone)]
pub(super) enum Sink {
    Shell(TsfnSink),
    Diverted(Diverted<TsfnSink>),
}

impl EventSink for Sink {
    fn output(&self, stream: OutputStream, bytes: Vec<u8>, delivered: Delivered) {
        match self {
            Self::Shell(shell) => shell.output(stream, bytes, delivered),
            Self::Diverted(sink) => sink.output(stream, bytes, delivered),
        }
    }

    fn end(&self, stream: OutputStream) {
        match self {
            Self::Shell(shell) => shell.end(stream),
            Self::Diverted(sink) => sink.end(stream),
        }
    }

    fn exit(&self, exit: RawExit) {
        match self {
            Self::Shell(shell) => shell.exit(exit),
            Self::Diverted(sink) => sink.exit(exit),
        }
    }

    fn close(&self, exit: RawExit) {
        match self {
            Self::Shell(shell) => shell.close(exit),
            Self::Diverted(sink) => sink.close(exit),
        }
    }

    fn stdin_written(&self) {
        match self {
            Self::Shell(shell) => shell.stdin_written(),
            Self::Diverted(sink) => sink.stdin_written(),
        }
    }

    fn stdin_error(&self, error: NodeIoError) {
        match self {
            Self::Shell(shell) => shell.stdin_error(error),
            Self::Diverted(sink) => sink.stdin_error(error),
        }
    }

    fn hold_limit(&self) {
        match self {
            Self::Shell(shell) => shell.hold_limit(),
            Self::Diverted(sink) => sink.hold_limit(),
        }
    }

    fn held(&self, message: String) {
        match self {
            Self::Shell(shell) => shell.held(message),
            Self::Diverted(sink) => sink.held(message),
        }
    }
}
