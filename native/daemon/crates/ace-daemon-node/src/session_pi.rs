// SPDX-License-Identifier: Apache-2.0
//! The Pi session binding (E3-pi.2): the Rust core behind the facade's calls.
//! Values cross as JSON text; the session's events go out through the shared
//! `SessionPort`, one ordered batch at a time (E3.0c).

// napi-derive registers exports only outside test builds, so in the lib test
// target every export reads as unused.
#![cfg_attr(test, allow(dead_code))]

use std::sync::Arc;

use ace_adapter_api::bridge::ReadGate;
use ace_adapter_pi::session::io::{COMMAND_REFUSED, PiSessionCore};
use ace_adapter_pi::session::{PiError, PiWireConfig};
use ace_json::{JsString, Map, Value};
use ace_supervisor::divert::{DivertTarget, OutputConsumer};
use napi::threadsafe_function::ThreadsafeFunction;
use napi::{Env, Status};
use napi_derive::napi;

use crate::session_bridge::SessionPort;
use crate::supervisor::child::NativeOutputTarget;

/// The facade's callback: one encoded batch of `[[kind, ...fields], ...]`.
type Events = ThreadsafeFunction<String, ()>;

/// The synthetic runtime's secrets, as the facade read them at open.
#[derive(serde::Deserialize)]
struct ConfigJson {
    control_secret: String,
    #[serde(default)]
    lease_bearer: Option<String>,
}

/// One native Pi session: the wire core and its port to JavaScript.
#[napi]
pub struct PiSessionNative {
    core: Arc<PiSessionCore>,
    port: SessionPort,
}

#[napi]
impl PiSessionNative {
    #[napi(constructor, catch_unwind)]
    pub fn new(config_json: String, events: Events) -> napi::Result<Self> {
        let config: ConfigJson = serde_json::from_str(&config_json).map_err(input_error)?;
        let core = Arc::new(PiSessionCore::new(PiWireConfig {
            control_secret: config.control_secret,
            lease_bearer: config.lease_bearer,
        }));
        let port = SessionPort::new(events, core.queue().clone(), core.gate().clone())?;
        Ok(Self { core, port })
    }

    /// The sink the facade spawns the child with: its pipes belong to this session.
    #[napi(catch_unwind)]
    pub fn output_target(&self) -> NativeOutputTarget {
        let consumer: Arc<dyn OutputConsumer> = self.core.clone();
        NativeOutputTarget::new(DivertTarget {
            consumer,
            ports: Arc::clone(self.core.ports()),
        })
    }

    /// Refusals throw an Error with code `ACE_PI_COMMAND_REFUSED`; nothing else throws.
    #[napi(catch_unwind)]
    pub fn request(
        &self,
        env: Env,
        command: String,
        params_json: String,
        id: u32,
    ) -> napi::Result<()> {
        let params = object(&params_json, "Pi command parameters")?;
        match self.core.request(&command, &params, u64::from(id)) {
            Ok(()) => Ok(()),
            Err(error) => Err(refuse(&env, error)),
        }
    }

    /// A dialog answer; `resume_after` resumes deadlines inside the wire.
    #[napi(catch_unwind)]
    pub fn write(
        &self,
        env: Env,
        data_json: String,
        id: u32,
        resume_after: bool,
    ) -> napi::Result<()> {
        let data = object(&data_json, "Pi dialog answer")?;
        match self.core.write(&data, u64::from(id), resume_after) {
            Ok(()) => Ok(()),
            Err(error) => Err(refuse(&env, error)),
        }
    }

    #[napi(catch_unwind)]
    pub fn note(&self, json: String) {
        self.core.note(&json);
    }

    #[napi(catch_unwind)]
    pub fn timer(&self, key: String) {
        self.core.timer(&key);
    }

    /// The dialog's raw JSON text, or undefined when it is no longer pending.
    #[napi(catch_unwind)]
    pub fn peek_dialog(&self, id: String) -> Option<String> {
        let id = dialog_id(&id)?;
        self.core.peek_dialog(&id)
    }

    /// The resolve reservation: true for the one caller that took the dialog.
    #[napi(catch_unwind)]
    pub fn take_dialog(&self, id: String) -> bool {
        match dialog_id(&id) {
            Some(id) => self.core.take_dialog(&id),
            None => false,
        }
    }

    #[napi(catch_unwind)]
    pub fn dialog_count(&self) -> u32 {
        self.core.dialog_count() as u32
    }

    #[napi(catch_unwind)]
    pub fn expect_rollback(&self, id: String) {
        self.core.expect_rollback(id);
    }

    #[napi(catch_unwind)]
    pub fn rollback_result(&self) -> Option<bool> {
        self.core.rollback_result()
    }

    #[napi(catch_unwind)]
    pub fn clear_rollback(&self) {
        self.core.clear_rollback();
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
        self.gate().undrain();
    }

    /// No child will ever report (the spawn threw): close the wire and publish
    /// `Drained` now, so every promise and timer settles.
    #[napi(catch_unwind)]
    pub fn abandon(&self) {
        self.core.abandon();
    }
}

impl PiSessionNative {
    fn gate(&self) -> &ReadGate {
        self.core.gate()
    }
}

/// A JSON object argument, as the wire's methods take it.
fn object(text: &str, what: &str) -> napi::Result<Map> {
    match ace_json::parse(text) {
        Ok(Value::Object(map)) => Ok(map),
        _ => Err(napi::Error::from_reason(format!(
            "{what} is not a JSON object"
        ))),
    }
}

/// A dialog id as the facade sends it: `JSON.stringify(id)`, so a lone
/// surrogate survives the crossing as escaped text and stays its own id.
fn dialog_id(text: &str) -> Option<JsString> {
    match ace_json::parse(text) {
        Ok(Value::String(id)) => Some(id),
        _ => None,
    }
}

/// Throws `message` as an Error whose `code` names the kind, then hands the
/// wrapper a pending exception so nothing replaces it.
fn refuse(env: &Env, error: PiError) -> napi::Error {
    let message = error.to_string();
    let _ = env.throw_error(&message, Some(COMMAND_REFUSED));
    napi::Error::new(Status::PendingException, message)
}

fn input_error(error: serde_json::Error) -> napi::Error {
    napi::Error::from_reason(error.to_string())
}
