// SPDX-License-Identifier: Apache-2.0
//! The Claude session binding (E3-claude.4 step 2): the Rust core behind the native facade's
//! calls. Values cross as JSON text; the session's events go out through the shared
//! `SessionPort`, one ordered batch at a time (E3.0c).

// napi-derive registers exports only outside test builds, so in the lib test target every export
// reads as unused.
#![cfg_attr(test, allow(dead_code))]

use std::sync::Arc;

use ace_adapter_claude::session::error::ClaudeError;
use ace_adapter_claude::session::io::ClaudeSessionCore;
use ace_adapter_claude::session::wire::WireConfig;
use ace_json::Value;
use ace_supervisor::divert::{DivertTarget, OutputConsumer};
use agent_stream_json::launch::{Launch, SessionStart, args};
use napi::threadsafe_function::ThreadsafeFunction;
use napi::{Env, Status};
use napi_derive::napi;

use crate::session_bridge::SessionPort;
use crate::supervisor::child::NativeOutputTarget;

/// The facade's callback: one encoded batch of `[[kind, ...fields], ...]`.
type Events = ThreadsafeFunction<String, ()>;

/// What the facade read at open: the session id, the interaction root, the MCP bearer and
/// whether this is a resume. The hook ids arrive with the initialize the wire writes.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfigJson {
    session_id: String,
    #[serde(default)]
    root_key: String,
    #[serde(default)]
    bearer: Option<String>,
    #[serde(default)]
    resume: bool,
}

/// One native Claude session: the wire core and its port to JavaScript.
#[napi]
pub struct ClaudeSessionNative {
    core: Arc<ClaudeSessionCore>,
    port: SessionPort,
}

#[napi]
impl ClaudeSessionNative {
    #[napi(constructor, catch_unwind)]
    pub fn new(config_json: String, events: Events) -> napi::Result<Self> {
        let config: ConfigJson = serde_json::from_str(&config_json).map_err(input_error)?;
        let core = Arc::new(ClaudeSessionCore::new(WireConfig {
            session_id: config.session_id,
            root_key: config.root_key,
            bearer: config.bearer,
            resume: config.resume,
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

    /// `agent_stream_json::args` over the launch JSON the facade built from the session context.
    #[napi(catch_unwind)]
    pub fn launch_args(&self, launch_json: String) -> napi::Result<Vec<String>> {
        let launch = launch(&launch_json)?;
        Ok(args(&launch))
    }

    /// One control request: a refusal throws with its code, nothing else throws.
    #[napi(catch_unwind)]
    pub fn control(&self, env: Env, request_json: String, id: u32) -> napi::Result<()> {
        match self.core.control(&request_json, u64::from(id)) {
            Ok(()) => Ok(()),
            Err(error) => Err(refuse(&env, error)),
        }
    }

    /// One synchronous send; a throw is the facade's `InputRejected` or a plain error.
    #[napi(catch_unwind)]
    pub fn send(
        &self,
        env: Env,
        messages_json: String,
        command_id: Option<String>,
    ) -> napi::Result<()> {
        match self.core.send(&messages_json, command_id.as_deref()) {
            Ok(()) => Ok(()),
            Err(error) => Err(refuse(&env, error)),
        }
    }

    #[napi(catch_unwind)]
    pub fn peek_interaction(&self, id: String) -> Option<String> {
        self.core.peek_interaction(&id)
    }

    /// True for the one caller that answered it.
    #[napi(catch_unwind)]
    pub fn answer_interaction(
        &self,
        id: String,
        result_json: String,
        resolution_json: String,
    ) -> bool {
        self.core
            .answer_interaction(&id, &result_json, &resolution_json)
    }

    #[napi(catch_unwind)]
    pub fn answer_hook(&self, request_id: String, output_json: String) {
        self.core.answer_hook(&request_id, &output_json);
    }

    /// The resolved task as JSON (`id`, `spawn`, `parent`, `live`, `run`, `route`), or null.
    #[napi(catch_unwind)]
    pub fn task_target(&self, spawn: String) -> Option<String> {
        self.core.task_target(&spawn)
    }

    /// `{ids, uncertain}` for a stop's cascade.
    #[napi(catch_unwind)]
    pub fn task_cascade(&self, spawn: Option<String>) -> String {
        self.core.task_cascade(spawn.as_deref())
    }

    #[napi(catch_unwind)]
    pub fn note(&self, json: String) {
        self.core.note(&json);
    }

    #[napi(catch_unwind)]
    pub fn timer(&self, key: String) {
        self.core.timer(&key);
    }

    /// `q.close()`'s input close: EOF after every queued write.
    #[napi(catch_unwind)]
    pub fn end_input(&self) {
        self.core.end_input();
    }

    /// The close's expiry: every pending interaction gets its default answer.
    #[napi(catch_unwind)]
    pub fn expire(&self) {
        self.core.expire();
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
        self.core.gate().undrain();
    }

    /// No child will ever report (the spawn threw): expire, drain, and publish `Drained` now.
    #[napi(catch_unwind)]
    pub fn abandon(&self) {
        self.core.abandon();
    }
}

/// The facade's `Launch`, as the JSON it builds from `configurationOptions` and `ctx`.
fn launch(text: &str) -> napi::Result<Launch> {
    let value = ace_json::parse(text).map_err(|_| bad("Claude launch"))?;
    let map = value
        .as_object()
        .ok_or_else(|| bad("Claude launch is not an object"))?;
    let session = map
        .get("session")
        .and_then(Value::as_object)
        .ok_or_else(|| bad("Claude launch names no session"))?;
    let session_id = string(session.get("sessionId"));
    let session = match string(session.get("kind")).as_str() {
        "new" => SessionStart::New { session_id },
        "resume" => SessionStart::Resume { session_id },
        "fork" => SessionStart::Fork {
            source: string(session.get("source")),
            at: session.get("at").and_then(Value::as_str).map(str::to_owned),
            session_id,
        },
        _ => return Err(bad("Claude launch has no known session kind")),
    };
    let list = |key: &str| {
        map.get(key).and_then(Value::as_array).map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_owned))
                .collect::<Vec<_>>()
        })
    };
    let extra = map
        .get("extra")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|pair| {
                    let pair = pair.as_array()?;
                    let name = pair.first()?.as_str()?.to_owned();
                    let value = pair.get(1).and_then(Value::as_str).map(str::to_owned);
                    Some((name, value))
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Ok(Launch {
        session,
        model: optional(map.get("model")),
        effort: optional(map.get("effort")),
        permission_mode: optional(map.get("permissionMode")),
        allow_dangerously_skip_permissions: flag(map.get("allowDangerouslySkipPermissions")),
        setting_sources: list("settingSources"),
        strict_mcp_config: flag(map.get("strictMcpConfig")),
        mcp_config: optional(map.get("mcpConfig")),
        plugin_dirs: list("pluginDirs").unwrap_or_default(),
        include_partial_messages: flag(map.get("includePartialMessages")),
        include_hook_events: flag(map.get("includeHookEvents")),
        extra,
    })
}

fn string(value: Option<&Value>) -> String {
    value.and_then(Value::as_str).unwrap_or_default().to_owned()
}

fn optional(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(str::to_owned)
}

fn flag(value: Option<&Value>) -> bool {
    value == Some(&Value::Bool(true))
}

/// Throws `message` as an Error whose `code` names the kind, then hands the wrapper a pending
/// exception so nothing replaces it.
fn refuse(env: &Env, error: ClaudeError) -> napi::Error {
    let message = error.to_string();
    let _ = env.throw_error(&message, Some(error.code()));
    napi::Error::new(Status::PendingException, message)
}

fn bad(what: &str) -> napi::Error {
    napi::Error::from_reason(format!("{what} is not valid JSON"))
}

fn input_error(error: serde_json::Error) -> napi::Error {
    napi::Error::from_reason(error.to_string())
}
