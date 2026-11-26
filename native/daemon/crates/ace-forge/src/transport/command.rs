// SPDX-License-Identifier: Apache-2.0
#![allow(clippy::expect_used)]
//! The runner (`command.ts`): one run of the person's host CLI per request, through
//! `ace-supervisor`, so its tree is contained. No stderr, argv, environment value or raw
//! error leaves this boundary except the bounded, redacted diagnostic window the HTTP
//! projections read (ADR 0224 §8a): the reply is 4 MiB and 30 s by default, a tail keeps its
//! newest 16 KiB, and a network failure is recognised privately.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use ace_redaction::EnvironmentMatcher;
use ace_supervisor::child::{SupervisedChild, spawn_child};
use ace_supervisor::signal::SignalName;
use ace_supervisor::spawn::{Delivered, EventSink, OutputStream, RawExit, SpawnSpec, StdioMode};
use regex::Regex;
use tokio::sync::{Notify, oneshot};

use crate::transport::error::{ForgeError, Kind};
use crate::transport::mutation::MutationDispatch;
use crate::transport::tail::{LogTail, StderrWindow};

/// Default reply bound: 4 MiB.
pub const MAX_BYTES: usize = 4_194_304;
/// Default request deadline: 30 s.
pub const TIMEOUT_MS: f64 = 30_000.0;
/// Default tail kept by `mode: "tail"`: 16 KiB.
pub const TAIL_BYTES: usize = 16_384;

/// Network failures as `gh` and `git` print them; matched privately, never forwarded.
static NETWORK_FAILURE: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
    Regex::new(r"(?i)error connecting to|could not resolve host|no such host|dial tcp|connection refused|connection reset|network is unreachable|i/o timeout|tls handshake timeout|timed out while")
        .expect("the network-failure pattern compiles")
});

/// What the reply must keep: the whole stdout, or only its newest bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Json,
    Tail,
}

/// A caller's abort signal, shared with the run that must stop.
#[derive(Debug, Default)]
pub struct Cancellation {
    cancelled: AtomicBool,
    notify: Notify,
}

impl Cancellation {
    /// A fresh, uncancelled signal.
    pub fn new() -> Arc<Cancellation> {
        Arc::new(Cancellation::default())
    }

    /// Aborts every run holding this signal.
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }

    /// Whether the caller already aborted.
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    /// Resolves when the caller aborts.
    pub async fn cancelled(&self) {
        if self.is_cancelled() {
            return;
        }
        self.notify.notified().await;
    }
}

/// One request: the CLI, its arguments, stdin, what to keep and who may stop it.
#[derive(Clone)]
pub struct CommandRequest {
    pub command: String,
    pub args: Vec<String>,
    pub input: Option<String>,
    pub mode: Mode,
    pub tail_bytes: Option<usize>,
    pub cancellation: Option<Arc<Cancellation>>,
    /// Admission's journal and the dispatch record a write turns on.
    pub dispatch: Option<Arc<MutationDispatch>>,
}

impl CommandRequest {
    /// A request that keeps the whole reply.
    pub fn new(command: impl Into<String>, args: impl Into<Vec<String>>) -> CommandRequest {
        CommandRequest {
            command: command.into(),
            args: args.into(),
            input: None,
            mode: Mode::Json,
            tail_bytes: None,
            cancellation: None,
            dispatch: None,
        }
    }

    /// JSON (or any body) written to the CLI's stdin.
    pub fn with_input(mut self, input: impl Into<String>) -> CommandRequest {
        self.input = Some(input.into());
        self
    }

    /// Keep only the newest `bytes`.
    pub fn tailing(mut self, bytes: usize) -> CommandRequest {
        self.mode = Mode::Tail;
        self.tail_bytes = Some(bytes);
        self
    }

    /// The caller's abort signal.
    pub fn cancellable(mut self, cancellation: Arc<Cancellation>) -> CommandRequest {
        self.cancellation = Some(cancellation);
        self
    }

    /// The write's dispatch record.
    pub fn dispatched(mut self, dispatch: Arc<MutationDispatch>) -> CommandRequest {
        self.dispatch = Some(dispatch);
        self
    }

    /// Whether a caller aborted this request before it ran.
    pub fn aborted(&self) -> bool {
        self.cancellation
            .as_ref()
            .is_some_and(|cancellation| cancellation.is_cancelled())
    }
}

/// tea's and bkt's parsed HTTP status and (tea's) pagination or quota headers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpProjection {
    pub status: u16,
    pub headers: Vec<(String, String)>,
}

/// One run's reply.
#[derive(Debug, Clone, PartialEq)]
pub struct CommandResult {
    pub code: Option<i32>,
    pub stdout: String,
    pub truncated: bool,
    pub identity_changed: bool,
    pub http: Option<HttpProjection>,
    /// The CLI reported a network failure (DNS, refused, timed out).
    pub unreachable: bool,
}

/// A runner: the port every host request goes through. A test or the store may supply its
/// own; the default is the supervised one below.
pub trait Runner: Send + Sync {
    /// Runs one request, or fails with the category the caller publishes.
    fn run<'a>(
        &'a self,
        request: CommandRequest,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<CommandResult, ForgeError>> + Send + 'a>,
    >;
}

/// What a supervised runner is built with.
#[derive(Debug, Clone)]
pub struct RunnerOptions {
    pub cwd: Option<String>,
    /// Added to the daemon's own environment (after it).
    pub env: Vec<(String, String)>,
    pub timeout_ms: f64,
    pub max_bytes: usize,
}

impl Default for RunnerOptions {
    fn default() -> RunnerOptions {
        RunnerOptions {
            cwd: None,
            env: Vec::new(),
            timeout_ms: TIMEOUT_MS,
            max_bytes: MAX_BYTES,
        }
    }
}

/// The runner's construction refused its limits, as the TypeScript's `RangeError` does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("Invalid command limits")]
pub struct InvalidLimits;

/// The runner every host request uses: one supervised CLI process per request.
pub struct SupervisedRunner {
    options: RunnerOptions,
    runtime: tokio::runtime::Handle,
}

impl SupervisedRunner {
    /// 4 MiB, 30 s and the daemon's environment, with the CLI prompts disabled.
    pub fn new(
        runtime: tokio::runtime::Handle,
        options: RunnerOptions,
    ) -> Result<SupervisedRunner, InvalidLimits> {
        if options.max_bytes == 0 || !options.timeout_ms.is_finite() || options.timeout_ms <= 0.0 {
            return Err(InvalidLimits);
        }
        Ok(SupervisedRunner { options, runtime })
    }

    /// The child's whole environment, as the TypeScript builds it: the daemon's own, the
    /// runner's additions, prompts disabled, and `GH_DEBUG`/`DEBUG` removed.
    fn environment(&self) -> Vec<(String, String)> {
        // Node's `process.env` reads a non-UTF-8 value lossily; `vars()` would panic.
        let mut env: Vec<(String, String)> = std::env::vars_os()
            .map(|(name, value)| {
                (
                    name.to_string_lossy().into_owned(),
                    value.to_string_lossy().into_owned(),
                )
            })
            .collect();
        for (name, value) in &self.options.env {
            set(&mut env, name, value);
        }
        for (name, value) in [
            ("GH_PROMPT_DISABLED", "1"),
            ("GH_PAGER", "cat"),
            ("GIT_TERMINAL_PROMPT", "0"),
            ("GCM_INTERACTIVE", "never"),
        ] {
            set(&mut env, name, value);
        }
        env.retain(|(name, _)| name != "GH_DEBUG" && name != "DEBUG");
        env
    }
}

/// Sets `name` in place, or appends it: the last value wins, as the object spread does.
fn set(env: &mut Vec<(String, String)>, name: &str, value: &str) {
    match env.iter_mut().find(|(key, _)| key == name) {
        Some(entry) => entry.1 = value.to_owned(),
        None => env.push((name.to_owned(), value.to_owned())),
    }
}

/// The credential-bearing environment values a CLI can echo as a bare value (ADR 0224 §8a):
/// only names `@ace/redaction` calls secret, so `PATH`/`HOME` never become patterns.
pub fn credential_environment(env: &[(String, String)]) -> EnvironmentMatcher {
    let values: Vec<&str> = env
        .iter()
        .filter(|(name, value)| !value.is_empty() && ace_redaction::is_secret_key(name))
        .map(|(_, value)| value.as_str())
        .collect();
    EnvironmentMatcher::new(&values)
}

impl Runner for SupervisedRunner {
    fn run<'a>(
        &'a self,
        request: CommandRequest,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<CommandResult, ForgeError>> + Send + 'a>,
    > {
        Box::pin(self.run_inner(request))
    }
}

impl SupervisedRunner {
    async fn run_inner(&self, request: CommandRequest) -> Result<CommandResult, ForgeError> {
        if request.aborted() {
            return Err(ForgeError::not_dispatched(Kind::Cancelled));
        }
        let env = self.environment();
        let environment = credential_environment(&env);
        let tail_bytes = request.tail_bytes.unwrap_or(TAIL_BYTES);
        let tail = match request.mode {
            Mode::Tail => Some(
                LogTail::new(tail_bytes)
                    .ok_or_else(|| ForgeError::not_dispatched(Kind::Cli))?
                    .with_environment(environment.clone()),
            ),
            Mode::Json => None,
        };
        let capture = Arc::new(Capture {
            state: std::sync::Mutex::new(CaptureState {
                stdout: Vec::new(),
                stderr: StderrWindow::default(),
                tail,
                too_large: false,
            }),
            close: std::sync::Mutex::new(None),
            leader_exit: std::sync::Mutex::new(None),
            overflow: Notify::new(),
            max_bytes: self.options.max_bytes,
        });
        let (close_tx, close_rx) = oneshot::channel();
        *capture.close.lock().expect("capture close lock") = Some(close_tx);
        let (exit_tx, exit_rx) = oneshot::channel();
        *capture.leader_exit.lock().expect("leader exit lock") = Some(exit_tx);
        let spec = SpawnSpec {
            command: request.command.clone(),
            args: request.args.clone(),
            cwd: self.options.cwd.clone(),
            env,
            windows_verbatim: false,
            hide_window: true,
            contain: true,
            max_output_bytes: None,
            stdin: StdioMode::Piped,
            stdout: StdioMode::Piped,
            stderr: StdioMode::Piped,
        };
        if let Some(dispatch) = &request.dispatch {
            dispatch.prepare();
        }
        let spawned = spawn_child(&spec, Sink(capture.clone()), &self.runtime, None);
        let child = match spawned {
            Ok(child) => child,
            Err(error) => {
                // Only an exec failure proves nothing started; a later setup failure leaves
                // the write uncertain (`command.ts:120-128`).
                let dispatched = !matches!(
                    error,
                    ace_supervisor::errors::SupervisorError::SpawnFailed { .. }
                );
                return Err(ForgeError {
                    kind: Kind::Cli,
                    retry_at: None,
                    dispatched: Some(!dispatched),
                    receipt: None,
                    status: None,
                });
            }
        };
        if let Some(dispatch) = &request.dispatch {
            dispatch.record();
        }
        if let Some(input) = &request.input {
            // gh exits when it does not want stdin; the TypeScript ignores that too.
            let _ = child.write_stdin(input.as_bytes().to_vec());
        }
        child.end_stdin();
        let deadline = Duration::from_millis(self.options.timeout_ms as u64);
        let stop = |child: &SupervisedChild| {
            // The CLI starts a session of its own: the group is what ends its tree.
            let _ = child.signal_group(SignalName::Kill);
            child.kill(SignalName::Kill);
        };
        let cancelled = async {
            match &request.cancellation {
                Some(cancellation) => cancellation.cancelled().await,
                None => std::future::pending::<()>().await,
            }
        };
        let overflow = async {
            loop {
                if capture.state.lock().expect("capture state lock").too_large {
                    return;
                }
                capture.overflow.notified().await;
            }
        };
        let mut close = close_rx;
        let exit = tokio::select! {
            exit = &mut close => exit,
            _ = exit_rx => {
                // The leader ended with its own code; its descendants must not hold the
                // request open, so the group ends with it.
                stop(&child);
                (&mut close).await
            }
            _ = tokio::time::sleep(deadline) => {
                stop(&child);
                return Err(ForgeError::new(Kind::Cli));
            }
            _ = cancelled => {
                stop(&child);
                return Err(ForgeError::new(Kind::Cancelled));
            }
            _ = overflow => {
                stop(&child);
                return Err(ForgeError::new(Kind::Limit));
            }
        };
        let mut state = capture.state.lock().expect("capture state lock");
        let (stdout, truncated) = match state.tail.take() {
            Some(tail) => tail.finish(),
            None => (String::from_utf8_lossy(&state.stdout).into_owned(), false),
        };
        let diagnostics = state.stderr.diagnostics(Some(&environment));
        let code = exit
            .ok()
            .and_then(|inner| inner.ok())
            .and_then(|exit| exit.code);
        let http = if request.command == "tea" {
            tea_http(&diagnostics)
        } else if request.command == "bkt" && code != Some(0) {
            bkt_http(&diagnostics)
        } else {
            None
        };
        let unreachable = code != Some(0) && NETWORK_FAILURE.is_match(&diagnostics);
        Ok(CommandResult {
            code,
            stdout,
            truncated,
            identity_changed: false,
            http,
            unreachable,
        })
    }
}

/// What the sink collects between events.
struct CaptureState {
    stdout: Vec<u8>,
    stderr: StderrWindow,
    tail: Option<LogTail>,
    too_large: bool,
}

/// The shared sink the supervisor's pumps deliver to.
struct Capture {
    state: std::sync::Mutex<CaptureState>,
    close: std::sync::Mutex<Option<oneshot::Sender<Result<RawExit, ()>>>>,
    leader_exit: std::sync::Mutex<Option<oneshot::Sender<()>>>,
    overflow: Notify,
    max_bytes: usize,
}

/// The sink handle `spawn_child` clones.
#[derive(Clone)]
struct Sink(Arc<Capture>);

impl EventSink for Sink {
    fn output(&self, stream: OutputStream, bytes: Vec<u8>, delivered: Delivered) {
        delivered.taken(true);
        let mut state = self.0.state.lock().expect("capture state lock");
        match stream {
            OutputStream::Stderr => state.stderr.accept(&bytes),
            OutputStream::Stdout => match state.tail.as_mut() {
                Some(tail) => tail.write(&bytes),
                None => {
                    state.stdout.extend_from_slice(&bytes);
                    if state.stdout.len() > self.0.max_bytes {
                        state.too_large = true;
                        drop(state);
                        self.0.overflow.notify_waiters();
                    }
                }
            },
        }
    }

    fn end(&self, _stream: OutputStream) {}

    fn exit(&self, _exit: RawExit) {
        // The leader is gone: its group may outlive it through a descendant holding a pipe,
        // exactly as node's runner kills the group on `exit` (`command.ts:103`).
        if let Some(exit) = self.0.leader_exit.lock().expect("leader exit lock").take() {
            let _ = exit.send(());
        }
    }

    fn close(&self, exit: RawExit) {
        if let Some(close) = self.0.close.lock().expect("capture close lock").take() {
            let _ = close.send(Ok(exit));
        }
    }

    fn stdin_written(&self) {}

    fn stdin_error(&self, _error: ace_supervisor::errors::NodeIoError) {}

    fn hold_limit(&self) {}

    fn held(&self, _message: String) {}
}

/// tea `--include` writes HTTP metadata to stderr: keep a narrow nonsecret projection.
fn tea_http(stderr: &str) -> Option<HttpProjection> {
    static STATUS: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
        Regex::new(r"^HTTP/[\d.]+ (\d{3})[^\r\n]*\r?\n([\s\S]*?)(?:\r?\n\r?\n|$)")
            .expect("the tea status pattern compiles")
    });
    let captures = STATUS.captures(stderr)?;
    let status: u16 = captures.get(1)?.as_str().parse().ok()?;
    let mut headers = Vec::new();
    for line in captures.get(2)?.as_str().split_inclusive('\n') {
        let line = line.trim_end_matches(['\r', '\n']);
        let Some(colon) = line.find(':') else {
            continue;
        };
        let name = line[..colon].to_ascii_lowercase();
        let value = line[colon + 1..].trim();
        if ["x-total-count", "retry-after", "x-ratelimit-remaining"].contains(&name.as_str())
            && !value.is_empty()
            && value.len() <= 15
            && value.bytes().all(|byte| byte.is_ascii_digit())
        {
            headers.push((name, value.to_owned()));
        }
    }
    Some(HttpProjection { status, headers })
}

/// bkt prints a non-2xx reply as `Error: <status> <reason>[: message]`.
fn bkt_http(stderr: &str) -> Option<HttpProjection> {
    static STATUS: std::sync::LazyLock<Regex> =
        std::sync::LazyLock::new(|| Regex::new(r"^Error: ([1-5]\d{2}) ").expect("compiles"));
    let status: u16 = STATUS.captures(stderr)?.get(1)?.as_str().parse().ok()?;
    Some(HttpProjection {
        status,
        headers: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::{
        Cancellation, CommandRequest, HttpProjection, Mode, Runner, RunnerOptions,
        SupervisedRunner, bkt_http, credential_environment, tea_http,
    };
    use crate::transport::error::Kind;

    fn runner(timeout_ms: f64, max_bytes: usize) -> SupervisedRunner {
        SupervisedRunner::new(
            tokio::runtime::Handle::current(),
            RunnerOptions {
                timeout_ms,
                max_bytes,
                env: vec![
                    ("GH_DEBUG".to_owned(), "api".to_owned()),
                    ("DEBUG".to_owned(), "*".to_owned()),
                ],
                ..RunnerOptions::default()
            },
        )
        .expect("valid limits")
    }

    fn python(script: &str) -> CommandRequest {
        CommandRequest::new("python3", vec!["-c".to_owned(), script.to_owned()])
    }

    #[test]
    fn construction_refuses_invalid_limits() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let handle = runtime.handle().clone();
        assert!(
            SupervisedRunner::new(
                handle.clone(),
                RunnerOptions {
                    max_bytes: 0,
                    ..RunnerOptions::default()
                }
            )
            .is_err()
        );
        assert!(
            SupervisedRunner::new(
                handle,
                RunnerOptions {
                    timeout_ms: 0.0,
                    ..RunnerOptions::default()
                }
            )
            .is_err()
        );
    }

    #[test]
    fn the_child_gets_the_prompt_free_environment_and_no_debug() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        runtime.block_on(async {
            let result = runner(5_000.0, 4_194_304)
                .run(python(
                    "import os;print('%s|%s|%s|%s|%s' % (os.environ.get('GH_PROMPT_DISABLED'), os.environ.get('GH_PAGER'), os.environ.get('GIT_TERMINAL_PROMPT'), os.environ.get('GCM_INTERACTIVE'), os.environ.get('GH_DEBUG')))",
                ))
                .await
                .expect("runs");
            assert_eq!(result.stdout.trim(), "1|cat|0|never|None");
            assert_eq!(result.code, Some(0));
            assert!(!result.truncated);
        });
    }

    #[test]
    fn the_reply_bound_stops_an_oversized_output() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        runtime.block_on(async {
            let error = runner(5_000.0, 64)
                .run(python("print('x' * 4096)"))
                .await
                .expect_err("over the bound");
            assert_eq!(error.kind, Kind::Limit);
        });
    }

    #[test]
    fn the_deadline_stops_a_hung_cli() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        runtime.block_on(async {
            let error = runner(200.0, 4_194_304)
                .run(python("import time;time.sleep(5)"))
                .await
                .expect_err("times out");
            assert_eq!(error.kind, Kind::Cli);
        });
    }

    #[test]
    fn an_aborted_caller_runs_nothing() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        runtime.block_on(async {
            let cancellation = Cancellation::new();
            cancellation.cancel();
            let error = runner(5_000.0, 4_194_304)
                .run(python("print('never')").cancellable(cancellation))
                .await
                .expect_err("cancelled");
            assert_eq!(error.kind, Kind::Cancelled);
            assert_eq!(error.dispatched, Some(false));
        });
    }

    #[test]
    fn a_tail_keeps_the_newest_lines_and_redacts_them() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        runtime.block_on(async {
            let result = runner(5_000.0, 4_194_304)
                .run(
                    python("import sys;sys.stdout.write('old\\n' * 2000 + 'ghp_12345678901234567890\\nlast\\n')")
                        .tailing(128),
                )
                .await
                .expect("runs");
            assert_eq!(result.code, Some(0));
            assert!(result.truncated);
            assert!(result.stdout.ends_with("[REDACTED]\nlast\n"), "{}", result.stdout);
            assert!(!result.stdout.contains("ghp_"));
        });
    }

    #[test]
    fn a_stderr_network_failure_is_recognised_and_never_returned() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        runtime.block_on(async {
            let result = runner(5_000.0, 4_194_304)
                .run(python(
                    "import sys;sys.stderr.write('fatal: could not resolve host: github.com\\n');sys.exit(1)",
                ))
                .await
                .expect("a nonzero exit is a result");
            assert_eq!(result.code, Some(1));
            assert!(result.unreachable);
            assert_eq!(result.stdout, "");
        });
    }

    #[test]
    fn a_descendant_holding_stdout_does_not_hold_the_request_open() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        runtime.block_on(async {
            let started = std::time::Instant::now();
            let result = runner(3_000.0, 4_194_304)
                .run(python(
                    "import subprocess,sys;subprocess.Popen(['sleep','5']);print('done')",
                ))
                .await
                .expect("the CLI exited");
            assert_eq!(result.code, Some(0));
            assert_eq!(result.stdout.trim(), "done");
            // The deadline is 3 s; an Ok result proves the group was killed on exit rather
            // than the request waiting for the descendant (no timing bound: shared machine).
            let _ = started;
        });
    }

    #[test]
    fn stdin_is_delivered_and_the_cli_reads_it_whole() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        runtime.block_on(async {
            let result = runner(5_000.0, 4_194_304)
                .run(python("import sys;print(sys.stdin.read().upper())").with_input("hello"))
                .await
                .expect("runs");
            assert_eq!(result.stdout.trim(), "HELLO");
        });
    }

    #[test]
    fn tea_headers_keep_only_the_narrow_numeric_projection() {
        let status = tea_http(
            "HTTP/2.0 403 Forbidden\r\nX-Total-Count: 5\r\nRetry-After: 30\r\nX-RateLimit-Remaining: 0\r\nAuthorization: Bearer secret\r\n\r\n{\"message\":\"x\"}",
        )
        .expect("a status");
        assert_eq!(status.status, 403);
        assert_eq!(
            status.headers,
            vec![
                ("x-total-count".to_owned(), "5".to_owned()),
                ("retry-after".to_owned(), "30".to_owned()),
                ("x-ratelimit-remaining".to_owned(), "0".to_owned()),
            ]
        );
        assert_eq!(
            tea_http("not http"),
            None,
            "a reply without a status line has no projection"
        );
        let _: HttpProjection = status;
    }

    #[test]
    fn bkt_reports_only_a_non_2xx_status() {
        assert_eq!(
            bkt_http("Error: 404 Not Found: repo missing").map(|http| http.status),
            Some(404)
        );
        assert_eq!(bkt_http("Error: something else"), None);
    }

    #[test]
    fn only_secret_environment_names_become_patterns() {
        let matcher = credential_environment(&[
            ("PATH".to_owned(), "/usr/bin".to_owned()),
            ("GH_TOKEN".to_owned(), "opaque-gh-token".to_owned()),
            ("HOME".to_owned(), "/Users/person".to_owned()),
        ]);
        assert_eq!(matcher.values().len(), 1);
        assert!(!matcher.is_empty());
    }

    #[test]
    fn a_request_remembers_its_mode_and_input() {
        let cancellation = Cancellation::new();
        let request = CommandRequest::new("gh", vec!["api".to_owned()])
            .with_input("{}")
            .tailing(32)
            .cancellable(cancellation);
        assert_eq!(request.mode, Mode::Tail);
        assert_eq!(request.tail_bytes, Some(32));
        assert_eq!(request.input.as_deref(), Some("{}"));
        assert!(!request.aborted());
    }
}
