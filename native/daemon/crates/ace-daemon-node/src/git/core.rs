// SPDX-License-Identifier: Apache-2.0
//! The core binding (G2): values in, raw bytes or JSON out, never logic.
//! Runs Git CLI execution, deadlines, cancellation, diagnostics, and cleanup
//! on the daemon's shared tokio runtime (`crate::supervisor::runtime()`).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use ace_git::core::cli::{
    ExecuteRawOptions, GitCliConfig, GitCliCore, StdinCommand, verify_git_version,
};
use ace_git::core::deadline::validate_timeout_ms;
use ace_git::core::error::{GitError, GitErrorCode};
use ace_git::core::lease::{LeasePorts, LeaseState, global_leases};
use ace_git::core::spawn::{
    ProcessPorts, SupervisorSpawner, TokioScheduler, default_platform, running_children,
};
use napi::bindgen_prelude::{FnArgs, Uint8Array};
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use tokio::sync::mpsc;

use super::bridge::{
    JsCleanupSupervisorPort, JsGroupPort, JsLeasePorts, JsLocatorPort, JsScheduler, JsSpawner,
    JsStreamCallbacks, PortCallFn, PortHub, parse_git_error_code,
};
use super::wire::{self, Frame};
use super::{caught, failed, unwind};

/// Settle callback for `executeRaw`: `(error, metaJson, stdoutBytes) => void`.
type RawSettle = ThreadsafeFunction<FnArgs<(String, Uint8Array)>>;
/// Settle callback for string JSON results: `(error, json) => void`.
type JsonSettle = ThreadsafeFunction<String>;

/// Probes the core path (kept for G0 smoke compatibility).
#[napi(catch_unwind)]
pub fn git_core_probe(op: String) -> napi::Result<String> {
    caught("git core probe", || {
        ace_git::core::cli::probe(&op).map(|()| "ok".to_owned())
    })
}

/// Validates a `timeoutMs` option using the core's exact bounds.
#[napi(catch_unwind)]
pub fn git_validate_timeout(ms: Option<f64>) -> napi::Result<f64> {
    caught("git validate timeout", || {
        validate_timeout_ms(ms)
            .map(|v| v as f64)
            .map_err(ace_git::error::Error::from)
    })
}

/// Verifies `git --version` stdout bytes using the core's exact parser.
#[napi(catch_unwind)]
pub fn git_verify_version(stdout: Uint8Array, binary: String) -> napi::Result<()> {
    caught("git verify version", || {
        verify_git_version(stdout.as_ref(), &binary).map_err(ace_git::error::Error::from)
    })
}

/// Native core handle owned by one `GitCli` instance when `ACE_GIT=core` is on.
#[napi]
pub struct NativeGitCore {
    core: Arc<GitCliCore>,
    hub: Arc<PortHub>,
    runtime: tokio::runtime::Handle,
    stdin_senders: Arc<Mutex<HashMap<u64, mpsc::UnboundedSender<StdinCommand>>>>,
    /// The process-wide lease state and the ports its operations ask the shell for.
    leases: Arc<LeaseState>,
    lease_ports: Arc<JsLeasePorts>,
}

/// One core config frame, read with `ace-json` like every other JS value.
#[derive(Default)]
struct CoreConfig {
    binary: Option<String>,
    timeout_ms: Option<f64>,
    platform: Option<String>,
    use_js_spawn: bool,
    use_js_scheduler: bool,
    use_js_signal_group: bool,
    use_js_group_alive: bool,
    use_js_locate_git: bool,
    use_js_cleanup_supervisor: bool,
    lease_evidence: bool,
    lease_wait_ms: Option<u64>,
}

impl CoreConfig {
    fn parse(json: &str) -> Option<Self> {
        let map = wire::object(json)?;
        Some(Self {
            binary: wire::string(&map, "binary"),
            timeout_ms: wire::number(&map, "timeoutMs"),
            platform: wire::string(&map, "platform"),
            use_js_spawn: wire::flag(&map, "useJsSpawn"),
            use_js_scheduler: wire::flag(&map, "useJsScheduler"),
            use_js_signal_group: wire::flag(&map, "useJsSignalGroup"),
            use_js_group_alive: wire::flag(&map, "useJsGroupAlive"),
            use_js_locate_git: wire::flag(&map, "useJsLocateGit"),
            use_js_cleanup_supervisor: wire::flag(&map, "useJsCleanupSupervisor"),
            lease_evidence: wire::flag(&map, "leaseEvidence"),
            lease_wait_ms: wire::count(&map, "leaseWaitMs"),
        })
    }
}

/// One `executeRaw` request frame (`ExecuteRawJson`).
struct ExecuteRawRequest {
    cwd: String,
    args: Vec<String>,
    binary: Option<String>,
    env: Vec<(String, String)>,
    write: bool,
    strip_askpass: bool,
    execution_disabled: bool,
    allow_failure: bool,
    capture_bytes: Option<u64>,
    timeout_ms: Option<f64>,
    stop_at_capture: bool,
    stop_after_ms: Option<f64>,
    bounded: bool,
    has_input: bool,
    stream_stdin: bool,
    stream_stdout: bool,
    stream_stderr: bool,
    leases_json: String,
    aborted_before_dispatch: bool,
}

impl ExecuteRawRequest {
    fn parse(json: &str) -> Option<Self> {
        let map = wire::object(json)?;
        Some(Self {
            cwd: wire::string(&map, "cwd")?,
            args: wire::strings(&map, "args")?,
            binary: wire::string(&map, "binary"),
            env: wire::pairs(&map, "env").unwrap_or_default(),
            write: wire::flag(&map, "write"),
            strip_askpass: wire::flag(&map, "stripAskpass"),
            execution_disabled: wire::flag(&map, "executionDisabled"),
            allow_failure: wire::flag(&map, "allowFailure"),
            capture_bytes: wire::count(&map, "captureBytes"),
            timeout_ms: wire::number(&map, "timeoutMs"),
            stop_at_capture: wire::flag(&map, "stopAtCapture"),
            stop_after_ms: wire::number(&map, "stopAfterMs"),
            bounded: wire::flag(&map, "bounded"),
            has_input: wire::flag(&map, "hasInput"),
            stream_stdin: wire::flag(&map, "streamStdin"),
            stream_stdout: wire::flag(&map, "streamStdout"),
            stream_stderr: wire::flag(&map, "streamStderr"),
            leases_json: wire::string(&map, "leasesJson").unwrap_or_else(empty_array_json),
            aborted_before_dispatch: wire::flag(&map, "abortedBeforeDispatch"),
        })
    }
}

/// A millisecond count as the core's unsigned budget, as Node's timer reads it.
fn milliseconds(value: f64) -> u64 {
    if value.is_finite() && value > 0.0 {
        value.round() as u64
    } else {
        0
    }
}

fn empty_array_json() -> String {
    "[]".to_owned()
}

#[napi]
impl NativeGitCore {
    #[napi(constructor, catch_unwind)]
    pub fn new(config_json: String, on_port: PortCallFn) -> napi::Result<Self> {
        let cfg = CoreConfig::parse(&config_json).ok_or_else(|| {
            failed(ace_git::error::Error::from(GitError::new(
                GitErrorCode::InvalidArgument,
                "invalid core config",
            )))
        })?;
        let runtime = crate::supervisor::runtime()?.handle().clone();
        let hub = Arc::new(PortHub::new(on_port));
        let mut ports = ProcessPorts::native(runtime.clone());
        ports.platform = cfg
            .platform
            .unwrap_or_else(|| default_platform().to_owned());
        if cfg.use_js_spawn {
            ports.spawner = Arc::new(JsSpawner {
                hub: Arc::clone(&hub),
            });
        } else {
            ports.spawner = Arc::new(SupervisorSpawner::new(runtime.clone()));
        }
        if cfg.use_js_scheduler {
            ports.scheduler = Arc::new(JsScheduler {
                hub: Arc::clone(&hub),
            });
        } else {
            ports.scheduler = Arc::new(TokioScheduler::new(runtime.clone()));
        }
        if cfg.use_js_signal_group {
            ports.signal_group_override = Some(Arc::new(JsGroupPort {
                hub: Arc::clone(&hub),
            }));
        }
        if cfg.use_js_group_alive {
            ports.group_alive_override = Some(Arc::new(JsGroupPort {
                hub: Arc::clone(&hub),
            }));
        }
        if cfg.use_js_locate_git {
            ports.locate_git = Some(Arc::new(JsLocatorPort {
                hub: Arc::clone(&hub),
            }));
        }
        if cfg.use_js_cleanup_supervisor {
            ports.cleanup_supervisor = Some(Arc::new(JsCleanupSupervisorPort {
                hub: Arc::clone(&hub),
            }));
        }
        let pid_hub = Arc::clone(&hub);
        ports.pid_hook = Some(Arc::new(move |pid, alive| {
            pid_hub.notify_pid(pid, alive);
        }));
        let ack_hub = Arc::clone(&hub);
        ports.stdin_ack_hook = Some(Arc::new(move |call_id, bytes| {
            ack_hub.emit(
                format!("{{\"op\":\"stdin_ack\",\"callId\":{call_id},\"bytes\":{bytes}}}"),
                Vec::new(),
            );
        }));

        // The lease operations wait through the same scheduler the process layer uses.
        let lease_scheduler = Arc::clone(&ports.scheduler);
        let core = GitCliCore::new(
            GitCliConfig {
                configured_binary: cfg.binary,
                timeout_ms: cfg.timeout_ms,
            },
            Arc::new(ports),
        )
        .map_err(|e| failed(ace_git::error::Error::from(e)))?;
        let lease_ports = Arc::new(JsLeasePorts {
            hub: Arc::clone(&hub),
            scheduler: lease_scheduler,
            evidence: cfg.lease_evidence,
            wait_ms: cfg.lease_wait_ms.unwrap_or(60_000),
        });
        Ok(Self {
            core: Arc::new(core),
            hub,
            runtime,
            stdin_senders: Arc::new(Mutex::new(HashMap::new())),
            leases: Arc::clone(global_leases()),
            lease_ports,
        })
    }

    #[napi(catch_unwind)]
    pub fn execute_raw(
        &self,
        req_json: String,
        input: Option<Uint8Array>,
        settle: RawSettle,
    ) -> napi::Result<f64> {
        let req = ExecuteRawRequest::parse(&req_json).ok_or_else(|| {
            failed(ace_git::error::Error::from(GitError::new(
                GitErrorCode::InvalidArgument,
                "invalid executeRaw request",
            )))
        })?;
        // A per-call timeout and work budget are the caller's numbers; TS only
        // bounds the constructor's default, so a 0 ms budget stays valid here.
        let timeout_ms = req.timeout_ms.map(milliseconds);
        let stop_after_ms = req.stop_after_ms.map(milliseconds);

        let (call_id, cancel) = self.core.register_cancel();
        let stdin_rx = if req.stream_stdin {
            let (tx, rx) = mpsc::unbounded_channel();
            if let Ok(mut map) = self.stdin_senders.lock() {
                map.insert(call_id, tx);
            }
            Some(rx)
        } else {
            None
        };

        let callbacks = if req.stream_stdout || req.stream_stderr {
            Some(Arc::new(JsStreamCallbacks {
                hub: Arc::clone(&self.hub),
                call_id,
            })
                as Arc<dyn ace_git::core::cli::StreamCallbacks>)
        } else {
            None
        };

        let opts = ExecuteRawOptions {
            cwd: req.cwd,
            args: req.args,
            binary: req.binary,
            env: req.env,
            write: req.write,
            strip_askpass: req.strip_askpass,
            execution_disabled: req.execution_disabled,
            allow_failure: req.allow_failure,
            capture_bytes: req.capture_bytes.map(|n| n as usize),
            timeout_ms,
            stop_at_capture: req.stop_at_capture,
            stop_after_ms,
            bounded: req.bounded,
            has_input: req.has_input,
            input: input.map(|u| u.as_ref().to_vec()),
            stdin_rx,
            stream_stdout: req.stream_stdout,
            stream_stderr: req.stream_stderr,
            callbacks,
            leases_json: req.leases_json,
            aborted_before_dispatch: req.aborted_before_dispatch,
        };

        let core = Arc::clone(&self.core);
        let senders = Arc::clone(&self.stdin_senders);
        self.runtime.spawn(async move {
            let outcome = core.execute_raw(opts, call_id, cancel).await;
            if let Ok(mut map) = senders.lock() {
                map.remove(&call_id);
            }
            match outcome {
                Ok(out) => {
                    let mut frame = Frame::new()
                        .text("stderr", &out.stderr)
                        .integer("exitCode", out.exit_code as i64)
                        .boolean("truncated", out.truncated);
                    if let Some(stopped) = out.stopped {
                        frame = frame.text("stopped", stopped.as_str());
                    }
                    if let Some(cleanup_id) = out.cleanup_id {
                        frame = frame.number("cleanupId", cleanup_id);
                    }
                    if let Some(pid) = out.cleanup_group_pid {
                        frame = frame.number("cleanupGroupPid", pid as u64);
                    }
                    let meta = frame.json();
                    let _ = settle.call(
                        Ok(FnArgs::from((meta, Uint8Array::new(out.stdout)))),
                        ThreadsafeFunctionCallMode::NonBlocking,
                    );
                }
                Err(err) => {
                    let _ = settle.call(
                        Err(failed(ace_git::error::Error::from(err))),
                        ThreadsafeFunctionCallMode::NonBlocking,
                    );
                }
            }
        });

        Ok(call_id as f64)
    }

    #[napi(catch_unwind)]
    pub fn write_stdin(&self, call_id: f64, chunk: Uint8Array) -> napi::Result<()> {
        let id = call_id as u64;
        if let Ok(map) = self.stdin_senders.lock()
            && let Some(tx) = map.get(&id)
        {
            let _ = tx.send(StdinCommand::Write(chunk.as_ref().to_vec()));
        }
        Ok(())
    }

    #[napi(catch_unwind)]
    pub fn end_stdin(&self, call_id: f64) -> napi::Result<()> {
        let id = call_id as u64;
        if let Ok(map) = self.stdin_senders.lock()
            && let Some(tx) = map.get(&id)
        {
            let _ = tx.send(StdinCommand::End);
        }
        Ok(())
    }

    #[napi(catch_unwind)]
    pub fn fail_stdin(
        &self,
        call_id: f64,
        code: Option<String>,
        errno: Option<String>,
        message: String,
    ) -> napi::Result<()> {
        let id = call_id as u64;
        let err = if let Some(errno) = errno {
            GitError::filesystem(errno, message)
        } else {
            let err_code = code
                .as_deref()
                .and_then(parse_git_error_code)
                .unwrap_or(GitErrorCode::GitFailed);
            GitError::new(err_code, message)
        };
        if let Ok(map) = self.stdin_senders.lock()
            && let Some(tx) = map.get(&id)
        {
            let _ = tx.send(StdinCommand::Error(err));
        }
        Ok(())
    }

    #[napi(catch_unwind)]
    pub fn abort_call(&self, call_id: f64) -> napi::Result<()> {
        self.core.abort_call(call_id as u64);
        Ok(())
    }

    #[napi(catch_unwind)]
    pub fn await_cleanup(&self, cleanup_id: f64, settle: JsonSettle) -> napi::Result<()> {
        let id = cleanup_id as u64;
        let cleanups = Arc::clone(&self.core.cleanups);
        self.runtime.spawn(async move {
            let entry = cleanups.wait(id).await;
            let result_json = entry.result.to_json_string();
            let group_json = entry
                .group_pid
                .map_or_else(|| "null".to_owned(), |p| p.to_string());
            let json = format!("{{\"result\":{result_json},\"groupPid\":{group_json}}}");
            let _ = settle.call(Ok(json), ThreadsafeFunctionCallMode::NonBlocking);
        });
        Ok(())
    }

    #[napi(catch_unwind)]
    pub fn pause(&self, milliseconds: f64, settle: JsonSettle) -> napi::Result<()> {
        let ms = if milliseconds.is_finite() && milliseconds >= 0.0 {
            milliseconds as u64
        } else {
            0
        };
        let core = Arc::clone(&self.core);
        self.runtime.spawn(async move {
            match core.pause(ms).await {
                Ok(()) => {
                    let _ =
                        settle.call(Ok("ok".to_owned()), ThreadsafeFunctionCallMode::NonBlocking);
                }
                Err(err) => {
                    let _ = settle.call(
                        Err(failed(ace_git::error::Error::from(err))),
                        ThreadsafeFunctionCallMode::NonBlocking,
                    );
                }
            }
        });
        Ok(())
    }

    #[napi(catch_unwind)]
    pub fn close(&self, settle: JsonSettle) -> napi::Result<()> {
        let core = Arc::clone(&self.core);
        self.runtime.spawn(async move {
            core.close().await;
            let _ = settle.call(Ok("ok".to_owned()), ThreadsafeFunctionCallMode::NonBlocking);
        });
        Ok(())
    }

    #[napi(catch_unwind)]
    pub fn active_calls(&self) -> napi::Result<f64> {
        Ok(self.core.active_calls() as f64)
    }

    #[napi(catch_unwind)]
    pub fn running_children(&self) -> napi::Result<Vec<u32>> {
        Ok(running_children().snapshot())
    }

    #[napi(catch_unwind)]
    pub fn job_alive(&self, pid: u32) -> napi::Result<bool> {
        Ok(self.core.job_alive(pid))
    }

    #[napi(catch_unwind)]
    pub fn set_resolved_binary(&self, binary: Option<String>) -> napi::Result<()> {
        self.core.set_resolved_binary(binary);
        Ok(())
    }

    #[napi(catch_unwind)]
    pub fn reply_port(&self, req_id: f64, reply_json: String) -> napi::Result<()> {
        self.hub.reply(req_id as u64, reply_json);
        Ok(())
    }

    #[napi(catch_unwind)]
    pub fn push_spawn_event(
        &self,
        spawn_id: f64,
        kind: String,
        payload_json: String,
        chunk: Option<Uint8Array>,
    ) -> napi::Result<()> {
        self.hub.push_spawn_event(
            spawn_id as u64,
            &kind,
            &payload_json,
            chunk.map(|u| u.as_ref().to_vec()),
        );
        Ok(())
    }

    #[napi(catch_unwind)]
    pub fn fire_timer(&self, timer_id: f64) -> napi::Result<()> {
        self.hub.fire_timer(timer_id as u64);
        Ok(())
    }

    /// Runs one lease operation (`mutationState`, `assertMutationAvailable`,
    /// `clearStaleLeases`, `heal`, `healAll`, `recoverCleanup`) in the core.
    #[napi(catch_unwind)]
    pub fn lease_op(&self, op: String, args_json: String, settle: JsonSettle) -> napi::Result<()> {
        let Some(args) = wire::object(&args_json) else {
            return Err(failed(ace_git::error::Error::from(GitError::new(
                GitErrorCode::InvalidArgument,
                "invalid lease request",
            ))));
        };
        let ports = Arc::clone(&self.lease_ports);
        let leases = Arc::clone(&self.leases);
        self.runtime.spawn(async move {
            let outcome = ace_git::core::lease::ops::run(
                &op,
                &args,
                ports.as_ref() as &dyn LeasePorts,
                leases.registry(),
            )
            .await;
            match outcome {
                Ok(json) => {
                    let _ = settle.call(Ok(json), ThreadsafeFunctionCallMode::NonBlocking);
                }
                Err(error) => {
                    let _ = settle.call(
                        Err(failed(ace_git::error::Error::from(error))),
                        ThreadsafeFunctionCallMode::NonBlocking,
                    );
                }
            }
        });
        Ok(())
    }
}

/// Ensures `unwind` stays wired into this module's helper surface.
#[allow(dead_code)]
fn _keep_unwind() -> napi::Error {
    unwind("git core")
}
