// SPDX-License-Identifier: Apache-2.0
//! The Cursor session binding (E3-cursor.3): the Rust session behind the facade's calls. Values
//! cross as JSON text; the session's events go out through the shared `SessionPort`, one ordered
//! batch at a time (E3.0c).

// napi-derive registers exports only outside test builds, so in the lib test
// target every export reads as unused.
#![cfg_attr(test, allow(dead_code))]

use std::sync::Arc;

use ace_adapter_api::bridge::ReadGate;
use ace_adapter_api::bridge::queue::SessionErrorWire;
use ace_adapter_api::session::{CloseReason, Delivery};
use ace_adapter_cursor::session::commands::CursorOpen;
use ace_adapter_cursor::session::core::CursorSessionConfig;
use ace_adapter_cursor::session::envelope::limits;
use ace_adapter_cursor::session::io::CursorSessionShell;
use ace_json::{Map, Value};
use ace_supervisor::divert::{DivertTarget, OutputConsumer};
use napi::threadsafe_function::ThreadsafeFunction;
use napi_derive::napi;

use crate::session_bridge::SessionPort;
use crate::supervisor::child::NativeOutputTarget;

/// The facade's callback: one encoded batch of `[[kind, ...fields], ...]`.
type Events = ThreadsafeFunction<String, ()>;

/// One native Cursor session: the shell and its port to JavaScript.
#[napi]
pub struct CursorSessionNative {
    shell: Arc<CursorSessionShell>,
    port: SessionPort,
}

#[napi]
impl CursorSessionNative {
    #[napi(constructor, catch_unwind)]
    pub fn new(config_json: String, events: Events) -> napi::Result<Self> {
        let value = parse(&config_json, "Cursor session configuration")?;
        let limits = limits(value.get("limits").unwrap_or(&Value::Null)).map_err(input_error)?;
        let generation = text(&value, "generation").ok_or_else(|| {
            napi::Error::from_reason("Cursor session configuration has no generation")
        })?;
        let instance_id = text(&value, "instanceId").unwrap_or_default();
        let root_key = text(&value, "rootKey").unwrap_or_else(|| String::from("root"));
        // The capability catalogs are the facade's data; the core emits them on an open frame.
        let capabilities = text(&value, "capabilities").unwrap_or_else(|| String::from("{}"));
        let shell = Arc::new(CursorSessionShell::new(CursorSessionConfig {
            generation,
            instance_id,
            root_key,
            limits,
            capabilities,
        }));
        let port = SessionPort::new(events, shell.queue().clone(), shell.gate().clone())?;
        Ok(Self { shell, port })
    }

    /// The sink the facade spawns the child with: its pipes belong to this session.
    #[napi(catch_unwind)]
    pub fn output_target(&self) -> NativeOutputTarget {
        let consumer: Arc<dyn OutputConsumer> = self.shell.clone();
        NativeOutputTarget::new(DivertTarget {
            consumer,
            ports: Arc::clone(self.shell.ports()),
        })
    }

    /// `host.request("open", ...)` and the recovery snapshot (`session.ts:195`-`:217`).
    #[napi(catch_unwind)]
    pub fn open(
        &self,
        id: u32,
        open_json: String,
        snapshot_json: Option<String>,
    ) -> napi::Result<()> {
        let value = parse(&open_json, "Cursor open request")?;
        let snapshot = match snapshot_json {
            Some(text) => Some(parse(&text, "Cursor recovery snapshot")?),
            None => None,
        };
        let cwd = text(&value, "cwd").unwrap_or_default();
        let thread_id = text(&value, "threadId").unwrap_or_default();
        let model = text(&value, "model");
        let model_params = value.get("modelParams").cloned();
        let native_session_id = text(&value, "nativeSessionId");
        let recover = value.get("recover").cloned();
        let permission_mode = text(&value, "permissionMode");
        let instructions = text(&value, "instructions");
        let mcp = value.get("mcp").map(|mcp| {
            (
                text(mcp, "url").unwrap_or_default(),
                text(mcp, "bearer").unwrap_or_default(),
            )
        });
        let open = CursorOpen {
            cwd: cwd.as_str(),
            thread_id: thread_id.as_str(),
            checkpoint_generation: value
                .get("checkpointGeneration")
                .and_then(Value::as_f64)
                .map(|generation| generation as u64),
            model: model.as_deref(),
            model_params: model_params.as_ref(),
            native_session_id: native_session_id.as_deref(),
            recover: recover.as_ref(),
            permission_mode: permission_mode.as_deref(),
            auto_review: value
                .get("autoReviewAvailable")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            mcp: mcp
                .as_ref()
                .map(|(url, bearer)| (url.as_str(), bearer.as_str())),
            instructions: instructions.as_deref(),
        };
        self.shell.open(u64::from(id), open, snapshot);
        Ok(())
    }

    /// `configure` (`session.ts:222`-`:229`), settling `id`.
    #[napi(catch_unwind)]
    pub fn configure(
        &self,
        id: u32,
        model: String,
        model_params_json: Option<String>,
    ) -> napi::Result<()> {
        let params = match model_params_json {
            Some(text) => Some(parse(&text, "Cursor model parameters")?),
            None => None,
        };
        if !self.shell.configure(u64::from(id), &model, params.as_ref()) {
            return Err(napi::Error::from_reason("Cursor configure was refused"));
        }
        Ok(())
    }

    /// `send` (`session.ts:230`-`:284`): the refusal is thrown; otherwise `id` settles later.
    #[napi(catch_unwind)]
    pub fn send(&self, send_json: String, id: u32, steer_lost: bool) -> napi::Result<()> {
        let value = parse(&send_json, "Cursor send")?;
        let input = value
            .get("input")
            .cloned()
            .unwrap_or(Value::Array(ace_json::Array::new()));
        let delivery = match text(&value, "delivery").as_deref() {
            Some("steer") => Delivery::Steer,
            _ => Delivery::Queue,
        };
        let send = CursorSendJson {
            input,
            delivery,
            command_id: text(&value, "commandId"),
            operation_id: text(&value, "operationId"),
            steer_lost,
        };
        match self.shell.send(
            u64::from(id),
            ace_adapter_cursor::session::commands::CursorSend {
                command_id: send.command_id.as_deref(),
                operation_id: send.operation_id.as_deref(),
                input: &send.input,
                delivery: send.delivery,
                steer_lost: send.steer_lost,
            },
        ) {
            None => Ok(()),
            Some(error) => Err(refuse(error)),
        }
    }

    /// `interrupt` (`session.ts:285`-`:303`), settling `id`.
    #[napi(catch_unwind)]
    pub fn interrupt(&self, id: u32, agent: Option<String>, cascade: bool) -> napi::Result<()> {
        match self
            .shell
            .interrupt(u64::from(id), agent.as_deref(), cascade)
        {
            None => Ok(()),
            Some(error) => Err(refuse(error)),
        }
    }

    /// `close` (`session.ts:182`-`:194`), settling `id`.
    #[napi(catch_unwind)]
    pub fn close(&self, id: u32, reason: String) {
        self.shell.close(
            u64::from(id),
            match reason.as_str() {
                "idle" => CloseReason::Idle,
                "user" => CloseReason::User,
                _ => CloseReason::Shutdown,
            },
        );
    }

    /// The facade answered the exit port (`session.ts:156`-`:181`).
    #[napi(catch_unwind)]
    pub fn exit(
        &self,
        code: Option<i32>,
        signal: Option<String>,
        reason: String,
        detail: Option<String>,
        stop_cause: Option<String>,
    ) {
        self.shell.exit(
            code.map(i64::from),
            signal.as_deref(),
            &reason,
            detail.as_deref(),
            stop_cause.as_deref(),
        );
    }

    /// The facade answered a port: `"host-output"` with the redacted text, `"stop"` with nothing.
    #[napi(catch_unwind)]
    pub fn note(&self, name: String, text: Option<String>) {
        self.shell.note(&name, text.as_deref());
    }

    /// `onFrame` resolved for the session's number `seq`.
    #[napi(catch_unwind)]
    pub fn committed(&self, seq: f64) {
        self.shell.committed(seq as u64);
    }

    /// `onFrame` rejected for the session's number `seq`, with the facade's redacted reason.
    #[napi(catch_unwind)]
    pub fn refused(&self, seq: f64, reason: String) {
        self.shell.refused(seq as u64, &reason);
    }

    #[napi(catch_unwind)]
    pub fn written(&self, ticket: f64) {
        self.shell.written(ticket as u64);
    }

    #[napi(catch_unwind)]
    pub fn timer(&self, key: String) {
        self.shell.timer(&key);
    }

    #[napi(catch_unwind)]
    pub fn set_paused(&self, paused: bool) {
        self.port.set_paused(paused);
    }

    #[napi(catch_unwind)]
    pub fn fail(&self) {
        self.port.fail();
    }

    #[napi(catch_unwind)]
    pub fn drain(&self) {
        self.port.drain();
    }

    /// A close whose stop failed: the gate's state before the drain comes back.
    #[napi(catch_unwind)]
    pub fn undrain(&self) {
        gate(&self.shell).undrain();
    }

    /// No child will ever report (the spawn threw): settle every promise now.
    #[napi(catch_unwind)]
    pub fn abandon(&self) {
        self.shell.abandon();
    }
}

fn gate(shell: &CursorSessionShell) -> &ReadGate {
    shell.gate()
}

struct CursorSendJson {
    input: Value,
    delivery: Delivery,
    command_id: Option<String>,
    operation_id: Option<String>,
    steer_lost: bool,
}

fn parse(text: &str, what: &str) -> napi::Result<Value> {
    ace_json::parse(text).map_err(|error| napi::Error::from_reason(format!("{what}: {error}")))
}

fn text(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .filter(|text| !text.is_empty())
}

fn input_error(error: impl std::fmt::Display) -> napi::Error {
    napi::Error::from_reason(error.to_string())
}

/// The engine-api class the facade throws for a refusal (`InputRejected` first, then
/// `SteerTargetLost`), carried as the code the bridge maps.
fn refuse(error: SessionErrorWire) -> napi::Error {
    let mut body = Map::with_capacity(2);
    body.insert("code", Value::from(error.code));
    body.insert("message", Value::from(error.message.as_str()));
    napi::Error::from_reason(Value::Object(body).to_json())
}
