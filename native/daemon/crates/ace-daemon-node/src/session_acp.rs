// SPDX-License-Identifier: Apache-2.0
//! The ACP session binding (E3-acp.3): the Rust core behind the facade's calls.
//! Values cross as JSON text; the session's events go out through the shared
//! `SessionPort`, one ordered batch at a time (E3.0c).

// napi-derive registers exports only outside test builds, so in the lib test
// target every export reads as unused.
#![cfg_attr(test, allow(dead_code))]

use std::sync::Arc;

use ace_adapter_acp::session::io::AcpSessionCore;
use ace_adapter_acp::session::{
    AcpCoreConfig, AcpSessionQuirks, CompatibilityProfile, Fence, InputSend, McpConfig, ProfileFit,
    ResumeTarget, SessionQuirksKind,
};
use ace_adapter_api::bridge::ReadGate;
use ace_adapter_api::session::{CloseReason, Delivery, InputSource, SteerFence};
use ace_json::{Map, Value};
use ace_supervisor::divert::{DivertTarget, OutputConsumer};
use ace_supervisor::peer::Timeout;
use napi::threadsafe_function::ThreadsafeFunction;
use napi_derive::napi;

use crate::session_bridge::SessionPort;
use crate::supervisor::child::NativeOutputTarget;

/// The facade's callback: one encoded batch of `[[kind, ...fields], ...]`.
type Events = ThreadsafeFunction<String, ()>;

/// The open's configuration, as the facade read it. JSON that the core keeps as data
/// (`clientMeta`, `profile`, `mcp`) crosses as text.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfigJson {
    thread_id: String,
    cwd: String,
    kind: String,
    #[serde(default)]
    command: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    experimental: bool,
    #[serde(default)]
    client_meta: String,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    profile: Option<String>,
    #[serde(default)]
    profile_fit: Option<String>,
    #[serde(default)]
    resume: Option<String>,
    #[serde(default)]
    permission_mode: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    effort: Option<String>,
    #[serde(default)]
    mcp: Option<String>,
    /// The peer's request deadline in ms (`null` leaves requests without one).
    #[serde(default)]
    timeout_ms: Option<f64>,
}

/// The MCP inputs, as `McpConfig` takes them (`session.ts:417`-`:437`).
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct McpJson {
    #[serde(default)]
    http_servers: Vec<serde_json::Value>,
    #[serde(default)]
    stdio_servers: Vec<serde_json::Value>,
    #[serde(default)]
    configured_servers: Vec<serde_json::Value>,
    #[serde(default)]
    secrets: Vec<String>,
    #[serde(default)]
    instructions: Option<String>,
    #[serde(default)]
    developer_instructions: Option<String>,
}

/// One native ACP session: the core and its port to JavaScript.
#[napi]
pub struct AcpSessionNative {
    core: Arc<AcpSessionCore>,
    port: SessionPort,
}

#[napi]
impl AcpSessionNative {
    #[napi(constructor, catch_unwind)]
    pub fn new(config_json: String, events: Events) -> napi::Result<Self> {
        let config: ConfigJson = serde_json::from_str(&config_json).map_err(input_error)?;
        let core = Arc::new(AcpSessionCore::new(core_config(config)?));
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

    /// `initialize` and `session/new|load|resume` (`session.ts:383`-`:495`), settling `id`
    /// with the open's result or its failure.
    #[napi(catch_unwind)]
    pub fn open(&self, id: u32) {
        self.core.start_open(u64::from(id));
    }

    /// One JSON-RPC request for the facade (the sign-in retry's `authenticate`).
    #[napi(catch_unwind)]
    pub fn request(
        &self,
        method: String,
        params_json: String,
        id: u32,
        timeout_ms: Option<f64>,
        default_timeout: bool,
    ) -> napi::Result<()> {
        let params = json_or_null(&params_json, "ACP request parameters")?;
        let timeout = match (timeout_ms, default_timeout) {
            (Some(ms), _) => Timeout::After(ms),
            (None, true) => Timeout::Default,
            (None, false) => Timeout::Disabled,
        };
        match self
            .core
            .request(&method, params.as_ref(), u64::from(id), timeout)
        {
            Ok(()) => Ok(()),
            Err(error) => Err(refuse(error.message())),
        }
    }

    /// One `send` (`session.ts:591`): `{input, delivery, commandId, origin, fence}`.
    #[napi(catch_unwind)]
    pub fn send(&self, send_json: String, id: u32) -> napi::Result<()> {
        let value = parse(&send_json, "ACP send")?;
        send(&self.core, &value, u64::from(id))
    }

    /// One `interrupt` (`session.ts:856`): `{agent, cascade}`, settling `id` once its
    /// frames are published.
    #[napi(catch_unwind)]
    pub fn interrupt(&self, target_json: String, id: u32) -> napi::Result<()> {
        let value = parse(&target_json, "ACP interrupt target")?;
        let map = value.as_object().cloned().unwrap_or_default();
        let target = ace_adapter_api::session::InterruptTarget {
            agent: map.get("agent").and_then(Value::as_str).map(str::to_owned),
            cascade: map.get("cascade").and_then(Value::as_bool).unwrap_or(false),
        };
        self.core.interrupt(target, u64::from(id));
        Ok(())
    }

    /// One `resolve` (`session.ts:820`): `{key, resolution}`, settling `id`.
    #[napi(catch_unwind)]
    pub fn resolve(&self, resolve_json: String, id: u32) -> napi::Result<()> {
        let value = parse(&resolve_json, "ACP interaction answer")?;
        let map = value.as_object().cloned().unwrap_or_default();
        let key = map.get("key").and_then(Value::as_str).unwrap_or("");
        let resolution = map
            .get("resolution")
            .cloned()
            .unwrap_or(Value::Object(Map::new()));
        self.core.resolve(key, &resolution, u64::from(id));
        Ok(())
    }

    /// `setModel` (`session.ts:572`), settling `id`.
    #[napi(catch_unwind)]
    pub fn set_model(&self, id: u32, model: String) {
        self.core.set_model(u64::from(id), &model);
    }

    /// `setMode` (`session.ts:587`), settling `id`.
    #[napi(catch_unwind)]
    pub fn set_mode(&self, id: u32, mode: String) {
        self.core.set_mode(u64::from(id), &mode);
    }

    /// `stopTask` (`session.ts:898`): ACP has no per-task control, settling `id` with that.
    #[napi(catch_unwind)]
    pub fn stop_task(&self, task: String, id: u32) {
        self.core.stop_task(&task, u64::from(id));
    }

    /// `close` (`session.ts:901`): the session's teardown; the stop plan stays the facade's.
    #[napi(catch_unwind)]
    pub fn close(&self, reason: String) {
        self.core.close_session(match reason.as_str() {
            "idle" => CloseReason::Idle,
            "user" => CloseReason::User,
            _ => CloseReason::Shutdown,
        });
    }

    /// The mode the session reports running (`session.ts:522`).
    #[napi(catch_unwind)]
    pub fn permission_mode(&self) -> Option<String> {
        self.core.permission_mode()
    }

    #[napi(catch_unwind)]
    pub fn timer(&self, key: String) {
        self.core.timer(&key);
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

    /// No child will ever report (the spawn threw): close the session and publish
    /// `Drained` now, so every promise settles.
    #[napi(catch_unwind)]
    pub fn abandon(&self) {
        self.core.abandon();
    }
}

impl AcpSessionNative {
    fn gate(&self) -> &ReadGate {
        self.core.gate()
    }
}

/// The core's configuration, built from what the facade read at open.
fn core_config(config: ConfigJson) -> napi::Result<AcpCoreConfig> {
    let kind = match config.kind.as_str() {
        "antigravity" => SessionQuirksKind::Antigravity,
        "extension" => SessionQuirksKind::Extension,
        "generic" => SessionQuirksKind::Generic,
        other => {
            return Err(napi::Error::from_reason(format!(
                "ACP session quirks kind is unknown: {other}"
            )));
        }
    };
    let client_meta = match ace_json::parse(&config.client_meta) {
        Ok(Value::Object(map)) => map,
        Err(error) => return Err(napi::Error::from_reason(error.to_string())),
        _ => Map::new(),
    };
    let profile = match config.profile.as_deref() {
        Some(text) => Some(serde_json_profile(text)?),
        None => None,
    };
    let profile_fit = match config.profile_fit.as_deref() {
        Some("verified") => Some(ProfileFit::Verified),
        Some("compatible") => Some(ProfileFit::Compatible),
        _ => None,
    };
    let mcp = match config.mcp.as_deref() {
        Some(text) => Some(mcp_config(text)?),
        None => None,
    };
    let mut core = AcpCoreConfig::new(
        config.thread_id,
        config.cwd,
        AcpSessionQuirks {
            kind,
            command: config.command,
            args: config.args,
            experimental: config.experimental,
            client_meta,
        },
    );
    core.version = config.version;
    core.profile = profile;
    core.profile_fit = profile_fit;
    core.resume = config
        .resume
        .filter(|id| !id.is_empty())
        .map(|id| ResumeTarget {
            native_session_id: id,
        });
    core.permission_mode = config.permission_mode;
    core.model = config.model;
    core.effort = config.effort;
    core.mcp = mcp;
    core.peer_config.timeout_ms = config.timeout_ms;
    Ok(core)
}

fn serde_json_profile(text: &str) -> napi::Result<CompatibilityProfile> {
    serde_json::from_str(text).map_err(input_error)
}

fn mcp_config(text: &str) -> napi::Result<McpConfig> {
    let mcp: McpJson = serde_json::from_str(text).map_err(input_error)?;
    Ok(McpConfig {
        http_servers: values(mcp.http_servers)?,
        stdio_servers: values(mcp.stdio_servers)?,
        configured_servers: values(mcp.configured_servers)?,
        secrets: mcp.secrets,
        instructions: mcp.instructions,
        developer_instructions: mcp.developer_instructions,
    })
}

fn values(input: Vec<serde_json::Value>) -> napi::Result<Vec<Value>> {
    input
        .into_iter()
        .map(|value| {
            ace_json::parse(&value.to_string())
                .map_err(|error| napi::Error::from_reason(error.to_string()))
        })
        .collect()
}

/// One `send` as the core takes it: the input, its delivery and the engine's fence. The
/// core finishes with the borrow inside the call, so the facade's copy lives here.
fn send(core: &AcpSessionCore, value: &Value, operation: u64) -> napi::Result<()> {
    let map = value.as_object().cloned().unwrap_or_default();
    let input: Vec<Value> = map
        .get("input")
        .and_then(Value::as_array)
        .map(|parts| parts.to_vec())
        .unwrap_or_default();
    let delivery = match map.get("delivery").and_then(Value::as_str) {
        Some("steer") => Delivery::Steer,
        Some("queue") => Delivery::Queue,
        other => {
            return Err(napi::Error::from_reason(format!(
                "ACP send delivery is unknown: {other:?}"
            )));
        }
    };
    let origin = match map.get("origin").and_then(Value::as_str) {
        Some("ace") => Some(InputSource::Ace),
        Some("agent") => Some(InputSource::Agent),
        _ => None,
    };
    let fence = map.get("fence").and_then(Value::as_object).map(|fence| {
        let turn = fence.get("turn").and_then(Value::as_str).map(str::to_owned);
        let current = fence
            .get("current")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        Fence::new(Arc::new(SnapshotFence { turn, current }))
    });
    let command_id = map
        .get("commandId")
        .and_then(Value::as_str)
        .map(str::to_owned);
    core.send(InputSend {
        operation,
        input: &input,
        delivery,
        command_id: command_id.as_deref(),
        origin,
        fence,
    });
    Ok(())
}

/// The engine's fence as the facade read it in the same synchronous step
/// (`assertSteerTarget`, `engine-api/src/index.ts:106`). A queued steer is admitted on that
/// answer: the native facade cannot ask the engine again from the session's queue.
struct SnapshotFence {
    turn: Option<String>,
    current: bool,
}

impl SteerFence for SnapshotFence {
    fn turn(&self) -> Option<&str> {
        self.turn.as_deref()
    }

    fn current(&self) -> bool {
        self.current
    }
}

fn parse(text: &str, what: &str) -> napi::Result<Value> {
    ace_json::parse(text).map_err(|_| napi::Error::from_reason(format!("{what} is not JSON")))
}

/// A request's parameters: `null` means "no params".
fn json_or_null(text: &str, what: &str) -> napi::Result<Option<Value>> {
    match ace_json::parse(text) {
        Ok(Value::Null) => Ok(None),
        Ok(value) => Ok(Some(value)),
        Err(_) => Err(napi::Error::from_reason(format!("{what} is not JSON"))),
    }
}

fn refuse(message: &str) -> napi::Error {
    napi::Error::from_reason(message.to_owned())
}

fn input_error(error: serde_json::Error) -> napi::Error {
    napi::Error::from_reason(error.to_string())
}
