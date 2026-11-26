// SPDX-License-Identifier: Apache-2.0
//! `openPiSession` (`session.ts:56`–`:505`) in Rust: the version gate, the resume reference, the
//! private configuration, the launch and spawn, then the extension check and the identity.
//!
//! The lease is held by a `LeaseGuard` before the first fallible step, so every refusal on the
//! way out revokes it exactly as the TypeScript's `lease?.end()` calls do.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use ace_adapter_api::SessionObserver;
use ace_json::{JsString, Map, Value};
use ace_supervisor::divert::OutputConsumer;
use tokio::runtime::Handle;

use super::clock::{Clock, Timer};
use super::config::{ConfigError, write_private_config};
use super::error::PiError;
use super::history::PiHistoryError;
use super::inner::{Inner, SessionConsumer, drain};
use super::io::PiSessionCore;
use super::launch::{PiLaunchError, PiLaunchInput, pi_launch};
use super::lease::{LeaseGuard, PiLease};
use super::methods::PiSession;
use super::reference::{
    CheckedReference, SessionReference, checked_session_reference, encode_session_reference,
    load_session_reference, save_session_reference,
};
use super::signal::Abort;
use super::version::{PiCliError, require_readable_pi};
use super::wire::PiWireConfig;

/// Everything one open needs. The daemon supplies discovery's path and version, the person's
/// environment, the reference directory, the engine's observer and its timers.
pub struct PiSessionOpen {
    pub launch: PiLaunchInput,
    /// `ctx.rootKey ?? "root"`.
    pub root_key: String,
    /// The control secret `io.secret()` makes: one per session, 64 hex characters.
    pub control_secret: String,
    pub lease: Option<PiLease>,
    pub reference_dir: PathBuf,
    /// Where the private credential directory is made (the temp directory).
    pub config_root: PathBuf,
    /// One per session; names the private directory so two opens never collide.
    pub nonce: String,
    /// `io.processKey()`: the identity the translator namespaces Pi's keys with.
    pub process_id: String,
    /// `ctx.resume.nativeSessionId`: the stored reference to resume.
    pub resume: Option<String>,
    pub observer: Arc<dyn SessionObserver>,
    pub clock: Arc<dyn Clock>,
    pub timer: Arc<dyn Timer>,
    /// `ctx.signal`: an open aborted before it returns leaves no child and no lease behind.
    pub cancel: Abort,
    /// `maxOutputBytes`: undefined for sessions, as today.
    pub max_output_bytes: Option<u64>,
}

/// Why an open or a session method failed. Provider-derived strings only cross as the wire's
/// own messages; a CLI refusal keeps the facts the TypeScript carries on its error object.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PiSessionError {
    #[error("Pi session closed")]
    Closed,
    #[error("Pi history operation in progress")]
    Control,
    #[error("ace Pi extension did not load")]
    Extension,
    #[error("Pi session cancelled")]
    Cancelled,
    #[error("{0}")]
    Cli(#[from] PiCliError),
    #[error("{0}")]
    Launch(#[from] PiLaunchError),
    #[error("{0}")]
    History(#[from] PiHistoryError),
    #[error("{0}")]
    Config(#[from] ConfigError),
    #[error("{0}")]
    Dialog(#[from] super::resolve::PiDialogError),
    #[error("{0}")]
    Input(#[from] crate::input::PiInputError),
    #[error("{0}")]
    Command(#[from] super::command::PiCommandError),
    #[error("Pi could not start: {0}")]
    Spawn(String),
    #[error("Pi process supervision: {0}")]
    Supervisor(String),
    #[error("Invalid Pi state")]
    State,
    #[error("Pi session identity changed")]
    Identity,
    #[error("{0}")]
    Refused(String),
    #[error("{0}")]
    Uncertain(String),
}

impl PiSessionError {
    pub(crate) fn from_pi(error: PiError) -> Self {
        match error {
            PiError::Refused(kind) => PiSessionError::Refused(kind.to_string()),
            PiError::Uncertain(kind) => PiSessionError::Uncertain(kind.to_string()),
        }
    }

    /// A settlement as the queue carries it (`io.rs:282`–`:293`): the code decides the side.
    pub(crate) fn from_wire(error: ace_adapter_api::bridge::SessionErrorWire) -> Self {
        if error.code == super::io::COMMAND_REFUSED {
            PiSessionError::Refused(error.message)
        } else {
            // `ACE_PI_UNCERTAIN`, and an unknown code, are plain errors today: never a refusal.
            PiSessionError::Uncertain(error.message)
        }
    }

    /// A session method's error: a refusal proves nothing ran, anything else stays uncertain.
    pub(crate) fn into_adapter(self) -> ace_adapter_api::AdapterApiError {
        use ace_adapter_api::AdapterApiError;
        match self {
            PiSessionError::Refused(message) => AdapterApiError::InputRejected(message),
            PiSessionError::History(error) => AdapterApiError::InputRejected(error.to_string()),
            PiSessionError::Dialog(error) => AdapterApiError::InputRejected(error.to_string()),
            PiSessionError::Input(error) => AdapterApiError::InputRejected(error.to_string()),
            PiSessionError::Command(error) => AdapterApiError::InputRejected(error.to_string()),
            other => AdapterApiError::Transport(other.to_string()),
        }
    }

    /// A CLI refusal's typed facts (`CliTooOldError.code`), for the daemon's error surface.
    pub fn code(&self) -> Option<&'static str> {
        match self {
            PiSessionError::Cli(error) => Some(error.code()),
            _ => None,
        }
    }

    /// The heading a failed open shows (`CliTooOldError.title`).
    pub fn title(&self) -> Option<&'static str> {
        match self {
            PiSessionError::Cli(error) => Some(error.title()).filter(|title| !title.is_empty()),
            _ => None,
        }
    }

    /// The release discovery read, when the refusal is about a version.
    pub fn installed(&self) -> Option<&str> {
        match self {
            PiSessionError::Cli(PiCliError::TooOld { installed, .. }) => Some(installed),
            _ => None,
        }
    }

    /// The oldest release ace supports, when the refusal is about a version.
    pub fn required(&self) -> Option<&str> {
        match self {
            PiSessionError::Cli(PiCliError::TooOld { required, .. })
            | PiSessionError::Cli(PiCliError::Unreadable { required }) => Some(required),
            _ => None,
        }
    }
}

/// A state reply's fields (`native.ts:24`–`:30`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PiState {
    pub(crate) session_file: String,
    pub(crate) session_id: String,
}

/// `openPiSession` (`session.ts:56`).
pub async fn open_pi_session(
    open: PiSessionOpen,
    runtime: &Handle,
) -> Result<PiSession, PiSessionError> {
    // Ends the lease on every refusal, exactly as `lease?.end()` does today; the guard exists
    // before the first check, so an open cancelled at the start revokes it too.
    let mut lease = LeaseGuard::new(open.lease);
    check_cancelled(&open.cancel)?;
    require_readable_pi(open.launch.version.as_deref())?;
    let resume = match &open.resume {
        Some(value) => Some(load_session_reference(&open.reference_dir, value)?),
        None => None,
    };
    check_cancelled(&open.cancel)?;
    let content = config_content_for(
        &open.control_secret,
        lease.peek(),
        open.launch.permission_mode.as_deref(),
    );
    let config = write_private_config(
        &open.config_root,
        &open.nonce,
        &content,
        Some(Path::new(&open.launch.cwd)),
    )?;
    // The spawn's environment names the file just written.
    let mut launch_input = open.launch.clone();
    launch_input.session_file = config.path.to_string_lossy().to_string();
    let launch = match pi_launch(&launch_input) {
        Ok(launch) => launch,
        Err(error) => {
            config.remove();
            return Err(error.into());
        }
    };

    let lease_bearer = lease.peek().map(|lease| lease.bearer.clone());
    let core = Arc::new(PiSessionCore::new(PiWireConfig {
        control_secret: open.control_secret.clone(),
        lease_bearer,
    }));
    let exit = Arc::new(super::shell::ChildExit::default());
    let inner = Arc::new(Inner::new(
        Arc::clone(&core),
        Arc::clone(&exit),
        Arc::clone(&open.observer),
        Arc::clone(&open.clock),
        Arc::clone(&open.timer),
        runtime.clone(),
        config,
        lease.take(),
    ));
    let consumer: Arc<dyn OutputConsumer> = Arc::new(SessionConsumer {
        inner: Arc::clone(&inner),
    });
    let ports = Arc::clone(core.ports());
    let child = match super::shell::PiChild::spawn(
        &launch,
        consumer,
        ports,
        runtime,
        open.max_output_bytes,
    ) {
        Ok(child) => Arc::new(child),
        Err(error) => {
            // No child will ever report: close the wire so its port releases, clean up, fail.
            core.abandon();
            inner.release();
            return Err(PiSessionError::Spawn(error.to_string()));
        }
    };
    let started = open.clock.now();
    inner.spawned(Arc::clone(&child), started);
    runtime.spawn(drain(Arc::clone(&inner)));

    // An abort during the handshake returns at once rather than after Pi's reply: the child is
    // stopped below, so a thread switched away mid-open leaves nothing running. The TypeScript
    // aborts its `ctx.signal` the same way (`session.ts:62`).
    let opened = async {
        let mut note = Map::with_capacity(2);
        note.insert("type", Value::from("started"));
        note.insert("processId", Value::from(open.process_id.as_str()));
        core.note(&ace_json::to_string(&Value::Object(note)));
        verify_extension(&inner, &open.launch.extension_path).await?;
        if let Some(resume) = &resume {
            restore(&inner, resume).await?;
        }
        let state = get_state(&inner).await?;
        let reference = SessionReference {
            path: state.session_file.clone(),
            id: state.session_id.clone(),
        };
        let native_id = save_session_reference(&open.reference_dir, &reference)?;
        check_cancelled(&open.cancel)?;
        open.observer.identity(&native_id);
        Ok::<_, PiSessionError>((state, native_id))
    };
    let opened = tokio::select! {
        result = opened => result,
        () = open.cancel.wait() => Err(PiSessionError::Cancelled),
    };
    match opened {
        Ok((state, native_id)) => {
            // The abort listener lives for the session (`native-session.ts:381`-`:391`,
            // `session.ts:206`-`:212`): a thread switched away after its open must not leave Pi
            // and its MCP lease running. A weak handle keeps the signal from owning the session.
            let weak = Arc::downgrade(&inner);
            open.cancel.on_abort(Box::new(move || {
                if let Some(inner) = weak.upgrade() {
                    inner.fatal();
                }
            }));
            Ok(PiSession::new(
                inner,
                native_id,
                state.session_file,
                open.root_key,
                open.control_secret,
                open.launch.model,
                open.launch.effort,
            ))
        }
        Err(error) => {
            // A child exists here, so its close (or the cutoff) brings Drained after the stop.
            if !inner.closing.load(std::sync::atomic::Ordering::Acquire) {
                let _ = inner.stop_process().await;
                inner.await_drained().await;
            }
            let close = inner.close(false).await.err();
            if let Some(close) = close {
                inner.note_stop_failed(&close.to_string());
            }
            Err(error)
        }
    }
}

fn check_cancelled(cancel: &Abort) -> Result<(), PiSessionError> {
    if cancel.aborted() {
        return Err(PiSessionError::Cancelled);
    }
    Ok(())
}

/// `JSON.stringify({controlSecret, mcp?, readOnly?})`, key order included.
pub(crate) fn config_content_for(
    secret: &str,
    lease: Option<&PiLease>,
    mode: Option<&str>,
) -> String {
    let mut map = Map::with_capacity(3);
    map.insert("controlSecret", Value::String(JsString::from(secret)));
    if let Some(lease) = lease {
        let mut mcp = Map::with_capacity(2);
        mcp.insert("url", Value::String(JsString::from(lease.url.as_str())));
        mcp.insert(
            "bearer",
            Value::String(JsString::from(lease.bearer.as_str())),
        );
        map.insert("mcp", Value::Object(mcp));
    }
    // Read-only keeps `ace_*` in Pi's allowlist; the extension then offers only read tools.
    if mode == Some(super::launch::READ_ONLY) {
        map.insert("readOnly", Value::Bool(true));
    }
    ace_json::to_string(&Value::Object(map))
}

/// `verifyExtension` (`session.ts:172`–`:185`): the extension's own command must be listed.
async fn verify_extension(inner: &Inner, extension_path: &str) -> Result<(), PiSessionError> {
    let data = inner.request("get_commands", &Map::new()).await?;
    let value = ace_json::parse(&data).map_err(|_| PiSessionError::State)?;
    let commands = value
        .get("commands")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let found = commands.iter().any(|command| {
        command.get("name").and_then(Value::as_str) == Some("ace-rollback")
            && command.get("source").and_then(Value::as_str) == Some("extension")
            && command
                .get("sourceInfo")
                .and_then(|info| info.get("path"))
                .and_then(Value::as_str)
                == Some(extension_path)
    });
    if found {
        Ok(())
    } else {
        Err(PiSessionError::Extension)
    }
}

pub(crate) async fn get_state(inner: &Inner) -> Result<PiState, PiSessionError> {
    let data = inner.request("get_state", &Map::new()).await?;
    parse_state(&data)
}

pub(crate) fn parse_state(data: &str) -> Result<PiState, PiSessionError> {
    let value = ace_json::parse(data).map_err(|_| PiSessionError::State)?;
    let text = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .map(str::to_owned)
    };
    Ok(PiState {
        session_file: text("sessionFile").ok_or(PiSessionError::State)?,
        session_id: text("sessionId").ok_or(PiSessionError::State)?,
    })
}

/// `restore` (`session.ts:335`–`:345`): load the saved session, then prove Pi kept its identity.
async fn restore(inner: &Inner, reference: &CheckedReference) -> Result<(), PiSessionError> {
    checked_session_reference(&encode_session_reference(&SessionReference {
        path: reference.path.clone(),
        id: reference.id.clone(),
    })?)?;
    let mut params = Map::with_capacity(1);
    params.insert("sessionPath", Value::from(reference.path.as_str()));
    let data = inner.request("switch_session", &params).await?;
    let value = ace_json::parse(&data).map_err(|_| PiSessionError::State)?;
    match value.get("cancelled").and_then(Value::as_bool) {
        Some(false) => {}
        _ => return Err(PiHistoryError::CancelledSwitch.into()),
    }
    let state = get_state(inner).await?;
    if state.session_file != reference.path || state.session_id != reference.id {
        return Err(PiHistoryError::Identity.into());
    }
    checked_session_reference(&encode_session_reference(&SessionReference {
        path: reference.path.clone(),
        id: reference.id.clone(),
    })?)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::lease::PiLease;

    #[test]
    fn the_private_config_is_written_in_the_typescripts_key_order() {
        let lease = PiLease::new("http://127.0.0.1:1/mcp".to_owned(), "b".repeat(64), || {});
        assert_eq!(
            config_content_for("a", Some(&lease), Some(crate::session::launch::READ_ONLY)),
            format!(
                "{{\"controlSecret\":\"a\",\"mcp\":{{\"url\":\"http://127.0.0.1:1/mcp\",\"bearer\":\"{}\"}},\"readOnly\":true}}",
                "b".repeat(64)
            )
        );
        assert_eq!(
            config_content_for("a", None, None),
            "{\"controlSecret\":\"a\"}"
        );
    }

    #[test]
    fn a_cli_refusal_keeps_its_typed_facts_for_the_daemon() {
        let error = PiSessionError::Cli(PiCliError::TooOld {
            installed: "0.84.4".to_owned(),
            required: "0.85.1".to_owned(),
        });
        assert_eq!(error.code(), Some("cli_too_old"));
        assert_eq!(error.title(), Some("Update Pi"));
        assert_eq!(error.installed(), Some("0.84.4"));
        assert_eq!(error.required(), Some("0.85.1"));
        let unreadable = PiSessionError::Cli(PiCliError::Unreadable {
            required: "0.85.1".to_owned(),
        });
        assert_eq!(unreadable.code(), Some("cli_unsupported"));
        assert_eq!(unreadable.title(), None);
        assert_eq!(unreadable.required(), Some("0.85.1"));
    }

    #[test]
    fn a_state_reply_missing_a_field_is_refused_and_present_ones_are_read() {
        assert_eq!(
            parse_state(
                "{\"sessionFile\":\"/tmp/a.jsonl\",\"sessionId\":\"native\",\"isStreaming\":false}"
            ),
            Ok(PiState {
                session_file: "/tmp/a.jsonl".to_owned(),
                session_id: "native".to_owned(),
            })
        );
        assert_eq!(
            parse_state("{\"sessionFile\":\"/tmp/a.jsonl\"}").unwrap_err(),
            PiSessionError::State
        );
    }
}
