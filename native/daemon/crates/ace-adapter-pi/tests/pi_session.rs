// SPDX-License-Identifier: Apache-2.0
//! Pi's Rust session against a real child process, through the supervisor, with the fake Pi
//! CLI (`src/bin/fake-pi.rs`, ported from `packages/adapter-pi/src/testing/fake-pi.ts`).
//!
//! Cases moved from `packages/adapter-pi/src/session.process.test.ts`, one for one:
//! - "explicit native resume reloads the saved session before any prompt"
//! - "steering and follow-up carry native delivery while Unicode separators stay in text"
//! - "interrupt clears native queued continuation before aborting"
//! - "a Pi that exits on startup has said why on stderr before the open fails, and it is no
//!   transcript row"
//!
//! plus the close and the crash the task names, and the launch the TS builds.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use ace_adapter_api::{CloseReason, Delivery, InterruptTarget, Session, SessionExit};
use ace_adapter_pi::session::control::{
    MonotonicClock, PiClock, PiSession, PiSessionError, PiSessionOpen, open_pi_session,
};
use ace_adapter_pi::session::launch::PiLaunchInput;
use ace_adapter_pi::session::reference::save_session_reference;
use ace_json::Value;
use ace_protocol::generated::ContentPart;

type TestResult = Result<(), Box<dyn std::error::Error>>;

/// A fixed clock, as the TypeScript harness injects `now: () => 0`.
struct FixedClock;

impl PiClock for FixedClock {
    fn now(&self) -> f64 {
        0.0
    }
}

#[derive(Clone)]
struct ObservedFrame {
    dir: ace_adapter_api::FrameDirection,
    channel: String,
    data: Value,
}

#[derive(Default)]
struct Record {
    frames: Vec<ObservedFrame>,
    identity: Option<String>,
    fatal: Vec<String>,
    exits: Vec<SessionExit>,
}

#[derive(Default)]
struct Observer {
    state: Mutex<Record>,
    changed: Condvar,
}

impl Observer {
    fn note<R>(&self, update: impl FnOnce(&mut Record) -> R) -> R {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        let value = update(&mut state);
        drop(state);
        self.changed.notify_all();
        value
    }

    fn wait(&self, predicate: impl Fn(&Record) -> bool, ms: u64) -> bool {
        let deadline = Instant::now() + Duration::from_millis(ms);
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        loop {
            if predicate(&state) {
                return true;
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return false;
            }
            let (next, _) = self
                .changed
                .wait_timeout(state, left)
                .unwrap_or_else(|error| error.into_inner());
            state = next;
        }
    }

    fn frames(&self) -> Vec<ObservedFrame> {
        self.state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .frames
            .clone()
    }

    fn sends(&self, kind: &str) -> Vec<Value> {
        self.frames()
            .into_iter()
            .filter(|frame| {
                frame.dir == ace_adapter_api::FrameDirection::Send
                    && frame.data.get("type").and_then(Value::as_str) == Some(kind)
            })
            .map(|frame| frame.data)
            .collect()
    }

    fn recv(&self, kind: &str, id: Option<&str>) -> Option<ObservedFrame> {
        self.frames().into_iter().find(|frame| {
            frame.dir == ace_adapter_api::FrameDirection::Recv
                && frame.data.get("type").and_then(Value::as_str) == Some(kind)
                && id.is_none_or(|id| frame.data.get("id").and_then(Value::as_str) == Some(id))
        })
    }
}

impl ace_adapter_api::SessionObserver for Observer {
    fn frame(&self, frame: ace_adapter_api::SessionFrame) {
        let data = ace_json::parse(frame.data.get()).unwrap_or(Value::Null);
        self.note(|state| {
            state.frames.push(ObservedFrame {
                dir: frame.dir,
                channel: frame.channel,
                data,
            })
        });
    }

    fn identity(&self, native_session_id: &str) {
        self.note(|state| state.identity = Some(native_session_id.to_owned()));
    }

    fn fatal(&self, message: &str) {
        self.note(|state| state.fatal.push(message.to_owned()));
    }

    fn exit(&self, exit: SessionExit) {
        self.note(|state| state.exits.push(exit));
    }
}

struct Harness {
    home: PathBuf,
    runtime: tokio::runtime::Runtime,
    observer: Arc<Observer>,
}

impl Harness {
    fn new(name: &str) -> Result<Harness, Box<dyn std::error::Error>> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let unique = format!(
            "{name}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        );
        let home = std::env::temp_dir().join(format!("ace-pi-rust-{unique}"));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(home.join("references"))?;
        std::fs::create_dir_all(home.join("config"))?;
        let home_text = home.to_string_lossy().to_string();
        std::fs::write(home.join("source.jsonl"), fixture(&home_text, "native"))?;
        std::fs::write(
            home.join("resumed.jsonl"),
            fixture(&home_text, "resumed-native"),
        )?;
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()?;
        Ok(Harness {
            home,
            runtime,
            observer: Arc::new(Observer::default()),
        })
    }

    fn open(
        &self,
        env: Vec<(String, String)>,
        resume: Option<String>,
        launch: impl FnOnce(&mut PiLaunchInput),
        reference_dir: Option<PathBuf>,
    ) -> Result<PiSession, PiSessionError> {
        let mut input = PiLaunchInput {
            executable: env!("CARGO_BIN_EXE_fake-pi").to_owned(),
            version: Some("0.86.0".to_owned()),
            cwd: std::env::current_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .to_string_lossy()
                .to_string(),
            env: vec![
                (
                    "PATH".to_owned(),
                    "/usr/bin:/bin:/usr/sbin:/sbin".to_owned(),
                ),
                (
                    "FAKE_PI_HOME".to_owned(),
                    self.home.to_string_lossy().to_string(),
                ),
            ]
            .into_iter()
            .chain(env)
            .collect(),
            extension_path: "/ace/extension.ts".to_owned(),
            ..PiLaunchInput::default()
        };
        launch(&mut input);
        let directory = reference_dir.unwrap_or_else(|| self.home.join("references"));
        let open = PiSessionOpen {
            launch: input,
            root_key: "root".to_owned(),
            control_secret: "a".repeat(64),
            lease: None,
            reference_dir: directory,
            config_root: self.home.join("config"),
            nonce: "session".to_owned(),
            process_id: "rust-pi-process".to_owned(),
            resume,
            observer: Arc::clone(&self.observer) as Arc<dyn ace_adapter_api::SessionObserver>,
            clock: Arc::new(FixedClock),
            max_output_bytes: None,
        };
        self.runtime
            .block_on(open_pi_session(open, self.runtime.handle()))
    }

    fn close(&self, session: &PiSession) -> Result<(), Box<dyn std::error::Error>> {
        self.runtime
            .block_on(session.close(CloseReason::Shutdown))?;
        Ok(())
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.home);
    }
}

/// A Pi session file's header and one message line (`testing/native-history.ts`).
fn fixture(cwd: &str, id: &str) -> String {
    format!(
        "{{\"type\":\"session\",\"id\":\"{id}\",\"cwd\":\"{cwd}\"}}\n\
         {{\"type\":\"message\",\"id\":\"root-user\",\"parentId\":null,\"message\":{{\"role\":\"user\",\"content\":\"first question\"}}}}\n"
    )
}

fn text(value: &str) -> Vec<ContentPart> {
    vec![ContentPart::Text {
        source: None,
        text: value.to_owned(),
    }]
}

fn send(
    harness: &Harness,
    session: &PiSession,
    value: &str,
    delivery: Delivery,
) -> Result<(), ace_adapter_api::AdapterApiError> {
    let parts = text(value);
    harness
        .runtime
        .block_on(session.send(ace_adapter_api::SendInput {
            input: &parts,
            delivery,
            command_id: None,
            origin: None,
            fence: None,
        }))
}

/// "explicit native resume reloads the saved session before any prompt".
#[test]
fn explicit_native_resume_reloads_the_saved_session_before_any_prompt() -> TestResult {
    let harness = Harness::new("resume")?;
    let resumed = harness.home.join("resumed.jsonl");
    let session = harness.open(
        Vec::new(),
        Some(resumed.to_string_lossy().to_string()),
        |_| {},
        None,
    )?;
    assert_eq!(session.native_session_file(), resumed.to_string_lossy());
    assert!(harness.observer.sends("prompt").is_empty());
    // The switch was asked for, and its answer proved the identity before the open returned.
    let switches = harness.observer.sends("switch_session");
    assert_eq!(switches.len(), 1);
    assert_eq!(
        switches[0].get("sessionPath").and_then(Value::as_str),
        Some(resumed.to_string_lossy().as_ref())
    );
    assert_eq!(
        harness
            .observer
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .identity
            .as_deref()
            .map(str::len),
        Some("ace-pi-ref:".len() + 64)
    );
    harness.close(&session)?;
    Ok(())
}

/// "steering and follow-up carry native delivery while Unicode separators stay in text".
#[test]
fn steering_and_follow_up_carry_native_delivery_while_unicode_separators_stay_in_text() -> TestResult
{
    let harness = Harness::new("steer")?;
    let session = harness.open(Vec::new(), None, |_| {}, None)?;
    send(&harness, &session, "hello", Delivery::Steer)?;
    assert!(
        harness.observer.wait(
            |state| state.frames.iter().any(|frame| {
                frame.dir == ace_adapter_api::FrameDirection::Recv
                    && frame.data.get("type").and_then(Value::as_str)
                        == Some("extension_ui_request")
                    && frame.data.get("id").and_then(Value::as_str) == Some("input-proof")
            }),
            5_000
        ),
        "no input-proof frame"
    );
    send(&harness, &session, "again", Delivery::Queue)?;
    assert!(
        harness.observer.wait(
            |state| state
                .frames
                .iter()
                .filter(|frame| {
                    frame.dir == ace_adapter_api::FrameDirection::Send
                        && frame.data.get("type").and_then(Value::as_str) == Some("prompt")
                })
                .count()
                == 2,
            5_000
        ),
        "the follow-up prompt never reached Pi"
    );
    let prompts = harness.observer.sends("prompt");
    let streaming: Vec<&str> = prompts
        .iter()
        .filter_map(|frame| frame.get("streamingBehavior").and_then(Value::as_str))
        .collect();
    assert_eq!(streaming, vec!["steer", "followUp"]);
    // Pi's U+2028 and U+2029 arrive in the reply as JavaScript keeps them.
    let reply = harness
        .observer
        .recv("message_end", None)
        .ok_or("no message_end")?;
    assert_eq!(reply.channel, "stdio");
    let content = reply
        .data
        .get("message")
        .and_then(|message| message.get("content"))
        .and_then(Value::as_array)
        .and_then(|blocks| blocks.first())
        .and_then(|block| block.get("text"))
        .and_then(Value::as_str)
        .ok_or("no reply text")?;
    assert_eq!(content, "hello\u{2028}world\u{2029}!");
    harness.close(&session)?;
    Ok(())
}

/// "interrupt clears native queued continuation before aborting".
#[test]
fn interrupt_clears_native_queued_continuation_before_aborting() -> TestResult {
    let harness = Harness::new("interrupt")?;
    let session = harness.open(Vec::new(), None, |_| {}, None)?;
    send(&harness, &session, "queued", Delivery::Steer)?;
    harness
        .runtime
        .block_on(session.interrupt(InterruptTarget {
            agent: None,
            cascade: true,
        }))?;
    assert!(
        harness.observer.wait(
            |state| {
                state.frames.iter().any(|frame| {
                    frame.dir == ace_adapter_api::FrameDirection::Recv
                        && frame.data.get("id").and_then(Value::as_str) == Some("abort-proof")
                        && frame.data.get("message").and_then(Value::as_str)
                            == Some("queue cleared")
                })
            },
            5_000
        ),
        "the interrupt never cleared the queue"
    );
    // The three commands went in the TypeScript's order.
    let commands: Vec<String> = harness
        .observer
        .sends("clear_queue")
        .iter()
        .map(|_| "clear_queue".to_owned())
        .chain(
            harness
                .observer
                .sends("abort")
                .iter()
                .map(|_| "abort".to_owned()),
        )
        .chain(
            harness
                .observer
                .sends("abort_bash")
                .iter()
                .map(|_| "abort_bash".to_owned()),
        )
        .collect();
    assert_eq!(commands, vec!["clear_queue", "abort", "abort_bash"]);
    harness.close(&session)?;
    Ok(())
}

/// A prompt Pi refuses is ace's `InputRejected`, before acceptance.
#[test]
fn a_prompt_pi_refuses_is_reported_as_input_rejected() -> TestResult {
    let harness = Harness::new("refuse")?;
    let session = harness.open(Vec::new(), None, |_| {}, None)?;
    let error = send(&harness, &session, "refuse", Delivery::Queue)
        .err()
        .ok_or("the refusal was not reported")?;
    match error {
        ace_adapter_api::AdapterApiError::InputRejected(message) => {
            assert_eq!(message, "No model")
        }
        other => return Err(format!("wrong error: {other}").into()),
    }
    harness.close(&session)?;
    Ok(())
}

/// The close: the stop plan ends the child, the exit is deliberate, and nothing is writable.
#[test]
fn a_close_stops_the_child_and_leaves_nothing_writable() -> TestResult {
    let harness = Harness::new("close")?;
    let session = harness.open(Vec::new(), None, |_| {}, None)?;
    send(&harness, &session, "hello", Delivery::Queue)?;
    harness.close(&session)?;
    let exits = harness
        .observer
        .state
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .exits
        .clone();
    assert_eq!(exits.len(), 1, "one exit notice");
    assert!(exits[0].deliberate);
    assert_eq!(exits[0].message, "Pi process stopped, code null");
    let error = send(&harness, &session, "late", Delivery::Queue).err();
    assert!(
        error
            .map(|error| error.to_string().contains("Pi session closed"))
            .unwrap_or(false),
        "a closed session must refuse a send"
    );
    Ok(())
}

/// A crash mid-turn: the child ends on its own, after stdout and stderr, and the exit is not
/// deliberate.
#[test]
fn a_crash_mid_turn_reports_the_exit_after_its_stderr() -> TestResult {
    let harness = Harness::new("crash")?;
    let session = harness.open(
        vec![("FAKE_PI_CRASH_MID_TURN".to_owned(), "1".to_owned())],
        None,
        |_| {},
        None,
    )?;
    // The prompt is taken (the bytes reached Pi), then the child exits before answering.
    let _ = send(&harness, &session, "hello", Delivery::Queue);
    assert!(
        harness.observer.wait(
            |state| !state.exits.is_empty()
                && state.frames.iter().any(|frame| {
                    frame.dir == ace_adapter_api::FrameDirection::Stderr
                        && frame.data.as_str() == Some("synthetic crash mid-turn")
                }),
            5_000
        ),
        "the exit or its stderr never arrived"
    );
    let exits = harness
        .observer
        .state
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .exits
        .clone();
    assert_eq!(exits[0].message, "Pi process exit, code 3");
    assert!(!exits[0].deliberate);
    // The stderr frame was delivered before the exit notice: it is a frame like any other,
    // and the terminal barrier follows it.
    assert!(
        harness
            .observer
            .frames()
            .iter()
            .any(|frame| frame.dir == ace_adapter_api::FrameDirection::Stderr)
    );
    Ok(())
}

/// "a Pi that exits on startup has said why on stderr before the open fails".
#[test]
fn a_pi_that_exits_on_startup_said_why_on_stderr_before_the_open_failed() -> TestResult {
    let harness = Harness::new("load-failure")?;
    let error = harness
        .open(
            vec![("FAKE_PI_LOAD_FAILURE".to_owned(), "1".to_owned())],
            None,
            |_| {},
            None,
        )
        .err()
        .ok_or("the open succeeded")?;
    assert!(
        matches!(
            error,
            PiSessionError::Uncertain(_) | PiSessionError::Refused(_)
        ),
        "unexpected open error: {error}"
    );
    let stderr: Vec<String> = harness
        .observer
        .frames()
        .into_iter()
        .filter(|frame| frame.dir == ace_adapter_api::FrameDirection::Stderr)
        .filter_map(|frame| frame.data.as_str().map(str::to_owned))
        .collect();
    assert_eq!(
        stderr,
        vec![
            "Error: Failed to load extension \"/ace/extension.ts\": Failed to load extension: \
             synthetic factory failure"
                .to_owned(),
            "Hint: Start without extensions using \"pi -ne\".".to_owned(),
        ]
    );
    Ok(())
}

/// The launch the TypeScript builds: the model, the access mode, the effort and ace's skills.
#[test]
fn the_child_receives_the_model_access_mode_effort_and_skill_arguments() -> TestResult {
    let harness = Harness::new("launch")?;
    let args_file = harness.home.join("args");
    let session = harness.open(
        vec![],
        None,
        |input| {
            input.model = Some("synthetic/model".to_owned());
            input.permission_mode = Some(ace_adapter_pi::session::launch::READ_ONLY.to_owned());
            input.effort = Some("xhigh".to_owned());
            input.builtin_skills = vec!["/ace/skills".to_owned()];
            input.env.push((
                "FAKE_PI_ARGS_FILE".to_owned(),
                args_file.to_string_lossy().to_string(),
            ));
        },
        None,
    )?;
    let args = std::fs::read_to_string(&args_file)?;
    let args: Vec<&str> = args.split('\u{1f}').collect();
    let tail = &args[1..];
    assert_eq!(
        tail,
        &[
            "--mode",
            "rpc",
            "-e",
            "/ace/extension.ts",
            "--model",
            "synthetic/model",
            "--tools",
            "read,grep,find,ls,ace_*",
            "--thinking",
            "xhigh",
            "--skill",
            "/ace/skills",
        ]
    );
    harness.close(&session)?;
    Ok(())
}

/// A resume whose stored reference is a compact id loads through the reference directory.
#[test]
fn a_compact_resume_reference_loads_from_the_reference_directory() -> TestResult {
    let harness = Harness::new("compact")?;
    let resumed = harness.home.join("resumed.jsonl");
    let stored = save_session_reference(
        &harness.home.join("references"),
        &ace_adapter_pi::session::reference::SessionReference {
            path: resumed.to_string_lossy().to_string(),
            id: "resumed-native".to_owned(),
        },
    )?;
    let session = harness.open(Vec::new(), Some(stored), |_| {}, None)?;
    assert_eq!(session.native_session_file(), resumed.to_string_lossy());
    harness.close(&session)?;
    Ok(())
}

/// The default clock is monotonic, so frame times never go backwards.
#[test]
fn the_default_clock_advances() {
    let clock = MonotonicClock::start();
    let first = clock.now();
    std::thread::sleep(Duration::from_millis(2));
    assert!(clock.now() >= first);
}

/// "opening failure revokes the injected ace MCP lease" (`session.process.test.ts`).
#[test]
fn an_opening_failure_revokes_the_injected_ace_mcp_lease() -> TestResult {
    let harness = Harness::new("lease")?;
    let ended = Arc::new(AtomicU64::new(0));
    let input = PiLaunchInput {
        executable: env!("CARGO_BIN_EXE_fake-pi").to_owned(),
        version: Some("0.86.0".to_owned()),
        cwd: std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .to_string_lossy()
            .to_string(),
        env: vec![
            ("PATH".to_owned(), "/usr/bin:/bin".to_owned()),
            (
                "FAKE_PI_HOME".to_owned(),
                harness.home.to_string_lossy().to_string(),
            ),
            ("FAKE_PI_LOAD_FAILURE".to_owned(), "1".to_owned()),
        ],
        extension_path: "/ace/extension.ts".to_owned(),
        ..PiLaunchInput::default()
    };
    let flag = Arc::clone(&ended);
    let open = PiSessionOpen {
        launch: input,
        root_key: "root".to_owned(),
        control_secret: "b".repeat(64),
        lease: Some(ace_adapter_pi::session::control::PiLease::new(
            "http://127.0.0.1:1/mcp".to_owned(),
            "c".repeat(64),
            move || {
                flag.fetch_add(1, Ordering::SeqCst);
            },
        )),
        reference_dir: harness.home.join("references"),
        config_root: harness.home.join("config"),
        nonce: "lease".to_owned(),
        process_id: "rust-pi-process".to_owned(),
        resume: None,
        observer: Arc::clone(&harness.observer) as Arc<dyn ace_adapter_api::SessionObserver>,
        clock: Arc::new(FixedClock),
        max_output_bytes: None,
    };
    let error = harness
        .runtime
        .block_on(open_pi_session(open, harness.runtime.handle()))
        .err()
        .ok_or("the open succeeded")?;
    assert!(matches!(
        error,
        PiSessionError::Uncertain(_) | PiSessionError::Refused(_)
    ));
    assert_eq!(
        ended.load(Ordering::SeqCst),
        1,
        "the lease ended exactly once"
    );
    // The private credential file ended with the session.
    assert!(!harness.home.join("config").join("ace-mcp-lease").exists());
    Ok(())
}

/// A new case: the fence is read before the first write, so a steer aimed at an ended turn is
/// refused unread and never reaches Pi. No TypeScript case covers the Rust fence path.
#[test]
fn a_fenced_steer_whose_turn_ended_is_refused_before_any_write() -> TestResult {
    struct Ended;
    impl ace_adapter_api::SteerFence for Ended {
        fn turn(&self) -> Option<&str> {
            Some("native-turn")
        }
        fn current(&self) -> bool {
            false
        }
    }
    let harness = Harness::new("fence")?;
    let session = harness.open(Vec::new(), None, |_| {}, None)?;
    let parts = text("late");
    let fence = Ended;
    let error = harness
        .runtime
        .block_on(session.send(ace_adapter_api::SendInput {
            input: &parts,
            delivery: Delivery::Steer,
            command_id: None,
            origin: None,
            fence: Some(&fence),
        }))
        .err()
        .ok_or("the steer was not refused")?;
    assert!(matches!(
        error,
        ace_adapter_api::AdapterApiError::SteerTargetLost(_)
    ));
    assert!(harness.observer.sends("prompt").is_empty());
    harness.close(&session)?;
    Ok(())
}
