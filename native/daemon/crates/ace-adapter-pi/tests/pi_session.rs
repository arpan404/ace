// SPDX-License-Identifier: Apache-2.0
//! Pi's Rust session against a real child process, through the supervisor, with the fake Pi
//! CLI (`src/bin/fake-pi.rs`, ported from `packages/adapter-pi/src/testing/fake-pi.ts`).
//!
//! Cases moved from `packages/adapter-pi/src/session.process.test.ts`, one for one:
//! - "explicit native resume reloads the saved session before any prompt"
//! - "steering and follow-up carry native delivery while Unicode separators stay in text"
//! - "selection answers use native offered labels and cannot be sent twice"
//! - "timed dialogs expire without withdrawing unrelated editor input"
//! - "generic confirmation is a yes/no question and replies with native confirmed"
//! - "interrupt clears native queued continuation before aborting"
//! - "opening failure revokes the injected ace MCP lease"
//! - "a Pi that exits on startup has said why on stderr before the open fails"
//!
//! plus the close, the crash, the launch arguments, resume identity and the stop plan.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use ace_adapter_api::{
    AdapterApiError, CloseReason, Delivery, InterruptTarget, Session, SessionExit,
};
use ace_adapter_pi::session::launch::PiLaunchInput;
use ace_adapter_pi::session::reference::{
    SessionReference, load_session_reference, save_session_reference,
};
use ace_adapter_pi::session::{
    Abort, Clock, ManualTimer, PiLease, PiSession, PiSessionError, PiSessionOpen, open_pi_session,
};
use ace_json::Value;
use ace_protocol::generated::{
    ContentPart, ContentPartInvocation, ContentPartKind, InteractionResolution,
};

type TestResult = Result<(), Box<dyn std::error::Error>>;

/// A fixed clock, as the TypeScript harness injects `now: () => 0`.
struct FixedClock;

impl Clock for FixedClock {
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

/// Everything the observer saw, in the order it saw it.
#[derive(Clone)]
enum Logged {
    Frame(ObservedFrame),
    Identity(String),
    Fatal,
    Exit(SessionExit),
}

#[derive(Default, Clone)]
struct Record {
    log: Vec<Logged>,
}

impl From<Vec<Logged>> for Record {
    fn from(log: Vec<Logged>) -> Self {
        Record { log }
    }
}

impl Record {
    fn frames(&self) -> Vec<&ObservedFrame> {
        self.log
            .iter()
            .filter_map(|entry| match entry {
                Logged::Frame(frame) => Some(frame),
                _ => None,
            })
            .collect()
    }

    fn exits(&self) -> Vec<&SessionExit> {
        self.log
            .iter()
            .filter_map(|entry| match entry {
                Logged::Exit(exit) => Some(exit),
                _ => None,
            })
            .collect()
    }

    fn identity(&self) -> Option<&str> {
        self.log.iter().find_map(|entry| match entry {
            Logged::Identity(id) => Some(id.as_str()),
            _ => None,
        })
    }

    fn sends(&self, kind: &str) -> Vec<&Value> {
        self.frames()
            .into_iter()
            .filter(|frame| {
                frame.dir == ace_adapter_api::FrameDirection::Send
                    && frame.data.get("type").and_then(Value::as_str) == Some(kind)
            })
            .map(|frame| &frame.data)
            .collect()
    }

    fn recv(&self, kind: &str, id: Option<&str>) -> Option<&ObservedFrame> {
        self.frames().into_iter().find(|frame| {
            frame.dir == ace_adapter_api::FrameDirection::Recv
                && frame.data.get("type").and_then(Value::as_str) == Some(kind)
                && id.is_none_or(|id| frame.data.get("id").and_then(Value::as_str) == Some(id))
        })
    }
}

#[derive(Default)]
struct Observer {
    state: Mutex<Record>,
    changed: Condvar,
}

impl Observer {
    fn note(&self, update: impl FnOnce(&mut Record)) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        update(&mut state);
        drop(state);
        self.changed.notify_all();
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

    fn record(&self) -> Record {
        self.state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .log
            .clone()
            .into()
    }
}

impl ace_adapter_api::SessionObserver for Observer {
    fn frame(&self, frame: ace_adapter_api::SessionFrame) {
        let data = ace_json::parse(frame.data.get()).unwrap_or(Value::Null);
        self.note(|state| {
            state.log.push(Logged::Frame(ObservedFrame {
                dir: frame.dir,
                channel: frame.channel,
                data,
            }))
        });
    }

    fn identity(&self, native_session_id: &str) {
        self.note(|state| {
            state
                .log
                .push(Logged::Identity(native_session_id.to_owned()))
        });
    }

    fn fatal(&self, _message: &str) {
        self.note(|state| state.log.push(Logged::Fatal));
    }

    fn exit(&self, exit: SessionExit) {
        self.note(|state| state.log.push(Logged::Exit(exit)));
    }
}

struct Harness {
    home: PathBuf,
    runtime: tokio::runtime::Runtime,
    observer: Arc<Observer>,
    timer: Arc<ManualTimer>,
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
            timer: Arc::new(ManualTimer::default()),
        })
    }

    fn open(
        &self,
        env: Vec<(String, String)>,
        resume: Option<String>,
        launch: impl FnOnce(&mut PiLaunchInput),
        config_root: Option<PathBuf>,
    ) -> Result<PiSession, PiSessionError> {
        let open = self.open_input(env, resume, launch, config_root, None, Abort::new());
        self.runtime
            .block_on(open_pi_session(open, self.runtime.handle()))
    }

    /// One open's inputs, assembled the way every case builds them.
    fn open_input(
        &self,
        env: Vec<(String, String)>,
        resume: Option<String>,
        launch: impl FnOnce(&mut PiLaunchInput),
        config_root: Option<PathBuf>,
        lease: Option<PiLease>,
        cancel: Abort,
    ) -> PiSessionOpen {
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
        PiSessionOpen {
            launch: input,
            root_key: "root".to_owned(),
            control_secret: "a".repeat(64),
            lease,
            reference_dir: self.home.join("references"),
            config_root: config_root.unwrap_or_else(|| self.home.join("config")),
            nonce: "session".to_owned(),
            process_id: "rust-pi-process".to_owned(),
            resume,
            observer: Arc::clone(&self.observer) as Arc<dyn ace_adapter_api::SessionObserver>,
            clock: Arc::new(FixedClock),
            timer: Arc::clone(&self.timer) as Arc<dyn ace_adapter_pi::session::Timer>,
            cancel,
            max_output_bytes: None,
        }
    }

    /// An open with a lease whose end is counted, for the revocation cases.
    fn open_with_lease(
        &self,
        env: Vec<(String, String)>,
        resume: Option<String>,
        launch: impl FnOnce(&mut PiLaunchInput),
        config_root: Option<PathBuf>,
    ) -> (Result<PiSession, PiSessionError>, Arc<AtomicU64>) {
        let ended = Arc::new(AtomicU64::new(0));
        let flag = Arc::clone(&ended);
        let open = self.open_input(
            env,
            resume,
            launch,
            config_root,
            Some(PiLease::new(
                "http://127.0.0.1:1/mcp".to_owned(),
                "c".repeat(64),
                move || {
                    flag.fetch_add(1, Ordering::SeqCst);
                },
            )),
            Abort::new(),
        );
        (
            self.runtime
                .block_on(open_pi_session(open, self.runtime.handle())),
            ended,
        )
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
        "{{\"type\":\"session\",\"version\":3,\"id\":\"{id}\",\"cwd\":\"{cwd}\"}}\n\
         {{\"type\":\"message\",\"id\":\"root-user\",\"parentId\":null,\"message\":{{\"role\":\"user\",\"content\":\"first question\"}}}}\n"
    )
}

fn text(value: &str) -> Vec<ContentPart> {
    vec![ContentPart::Text {
        source: None,
        text: value.to_owned(),
    }]
}

fn mention(name: &str, arguments: &str) -> ContentPart {
    ContentPart::Mention {
        arguments: arguments.to_owned(),
        entry_id: format!("entry-{name}"),
        icon: None,
        invocation: Some(ContentPartInvocation::Slash {
            name: name.to_owned(),
        }),
        kind: ContentPartKind::Command,
        name: name.to_owned(),
        title: None,
        values: serde_json::Map::new(),
    }
}

fn send_parts(
    harness: &Harness,
    session: &PiSession,
    parts: &[ContentPart],
    delivery: Delivery,
) -> Result<(), AdapterApiError> {
    harness
        .runtime
        .block_on(session.send(ace_adapter_api::SendInput {
            input: parts,
            delivery,
            command_id: None,
            origin: None,
            fence: None,
        }))
}

fn send(
    harness: &Harness,
    session: &PiSession,
    value: &str,
    delivery: Delivery,
) -> Result<(), AdapterApiError> {
    send_parts(harness, session, &text(value), delivery)
}

fn question(id: &str, answers: &[&str]) -> InteractionResolution {
    let mut map = serde_json::Map::new();
    map.insert(
        id.to_owned(),
        serde_json::Value::Array(
            answers
                .iter()
                .map(|answer| serde_json::Value::String((*answer).to_owned()))
                .collect(),
        ),
    );
    InteractionResolution::Question {
        answers: map,
        dismissed: None,
        feedback: None,
    }
}

/// A child that ignores SIGTERM, as a dev server the agent started can.
fn ignoring_script() -> String {
    "trap '' TERM; sleep 60".to_owned()
}

fn descendant_pid(
    harness: &Harness,
    observer: &Observer,
) -> Result<u32, Box<dyn std::error::Error>> {
    let file = harness.home.join("descendant.pid");
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if let Ok(text) = std::fs::read_to_string(&file)
            && let Ok(pid) = text.trim().parse::<u32>()
        {
            return Ok(pid);
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let _ = observer;
    Err("the descendant never started".into())
}

fn alive(pid: u32) -> bool {
    std::process::Command::new("kill")
        .arg("-0")
        .arg(pid.to_string())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn wait_gone(pid: u32, ms: u64) -> bool {
    let deadline = Instant::now() + Duration::from_millis(ms);
    while Instant::now() < deadline {
        if !alive(pid) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    !alive(pid)
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
    assert!(harness.observer.record().sends("prompt").is_empty());
    let record = harness.observer.record();
    let switches = record.sends("switch_session");
    assert_eq!(switches.len(), 1);
    assert_eq!(
        switches[0].get("sessionPath").and_then(Value::as_str),
        Some(resumed.to_string_lossy().as_ref())
    );
    assert_eq!(
        record.identity().map(str::len),
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
            |state| state
                .recv("extension_ui_request", Some("input-proof"))
                .is_some(),
            5_000
        ),
        "no input-proof frame"
    );
    send(&harness, &session, "again", Delivery::Queue)?;
    assert!(
        harness.observer.wait(
            |state| state
                .frames()
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
    let record = harness.observer.record();
    let streaming: Vec<&str> = record
        .sends("prompt")
        .iter()
        .filter_map(|frame| frame.get("streamingBehavior").and_then(Value::as_str))
        .collect();
    assert_eq!(streaming, vec!["steer", "followUp"]);
    let reply = record.recv("message_end", None).ok_or("no message_end")?;
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

/// "selection answers use native offered labels and cannot be sent twice".
#[test]
fn selection_answers_use_native_offered_labels_and_cannot_be_sent_twice() -> TestResult {
    let harness = Harness::new("select")?;
    let session = harness.open(Vec::new(), None, |_| {}, None)?;
    send(&harness, &session, "dialogs", Delivery::Queue)?;
    assert!(
        harness.observer.wait(
            |state| state.recv("extension_ui_request", Some("select")).is_some(),
            5_000
        ),
        "no select dialog"
    );
    let unknown = harness
        .runtime
        .block_on(session.resolve("select".to_owned(), question("select", &["9"])))
        .err()
        .ok_or("an unknown selection was accepted")?;
    assert!(unknown.to_string().contains("Unknown Pi selection"));
    harness
        .runtime
        .block_on(session.resolve("select".to_owned(), question("select", &["1"])))?;
    assert!(
        harness.observer.wait(
            |state| state.frames().iter().any(|frame| {
                frame.dir == ace_adapter_api::FrameDirection::Recv
                    && frame.data.get("id").and_then(Value::as_str) == Some("answer-proof")
                    && frame
                        .data
                        .get("message")
                        .and_then(Value::as_str)
                        .and_then(|message| ace_json::parse(message).ok())
                        .and_then(|value| {
                            value
                                .get("value")
                                .and_then(Value::as_str)
                                .map(str::to_owned)
                        })
                        .as_deref()
                        == Some("Spaces")
            }),
            5_000
        ),
        "the selection answer never reached Pi"
    );
    let again = harness
        .runtime
        .block_on(session.resolve("select".to_owned(), question("select", &["0"])))
        .err()
        .ok_or("a dialog was answered twice")?;
    assert!(again.to_string().contains("no longer pending"));
    harness.close(&session)?;
    Ok(())
}

/// "timed dialogs expire without withdrawing unrelated editor input".
#[test]
fn timed_dialogs_expire_without_withdrawing_unrelated_editor_input() -> TestResult {
    let harness = Harness::new("timed")?;
    let session = harness.open(Vec::new(), None, |_| {}, None)?;
    send(&harness, &session, "dialogs", Delivery::Queue)?;
    assert!(
        harness.observer.wait(
            |state| state.recv("extension_ui_request", Some("timed")).is_some(),
            5_000
        ),
        "no timed dialog"
    );
    // The wire armed the dialog's 25 ms expiry through the injected timer.
    assert!(harness.timer.armed().contains(&25.0));
    harness.timer.fire_all();
    assert!(
        harness.observer.wait(
            |state| state.frames().iter().any(|frame| {
                frame.data.get("type").and_then(Value::as_str) == Some("dialog_expired")
            }),
            5_000
        ),
        "the expiry note never arrived"
    );
    let expired = harness
        .runtime
        .block_on(session.resolve("timed".to_owned(), question("timed", &["late"])))
        .err()
        .ok_or("an expired dialog was answered")?;
    assert!(expired.to_string().contains("no longer pending"));
    harness.runtime.block_on(session.resolve(
        "editor".to_owned(),
        question("editor", &["new passenger\ntext"]),
    ))?;
    harness.close(&session)?;
    Ok(())
}

/// "generic confirmation is a yes/no question and replies with native confirmed".
#[test]
fn generic_confirmation_is_a_yes_no_question_and_replies_with_native_confirmed() -> TestResult {
    let harness = Harness::new("confirm")?;
    let session = harness.open(Vec::new(), None, |_| {}, None)?;
    send(&harness, &session, "dialogs", Delivery::Queue)?;
    assert!(
        harness.observer.wait(
            |state| state
                .recv("extension_ui_request", Some("confirm"))
                .is_some(),
            5_000
        ),
        "no confirm dialog"
    );
    harness
        .runtime
        .block_on(session.resolve("confirm".to_owned(), question("confirm", &["no"])))?;
    assert!(
        harness.observer.wait(
            |state| state.frames().iter().any(|frame| {
                frame.dir == ace_adapter_api::FrameDirection::Recv
                    && frame.data.get("id").and_then(Value::as_str) == Some("answer-proof")
                    && frame
                        .data
                        .get("message")
                        .and_then(Value::as_str)
                        .and_then(|message| ace_json::parse(message).ok())
                        .and_then(|value| value.get("confirmed").and_then(Value::as_bool))
                        == Some(false)
            }),
            5_000
        ),
        "the confirmation never reached Pi"
    );
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
            |state| state.frames().iter().any(|frame| {
                frame.dir == ace_adapter_api::FrameDirection::Recv
                    && frame.data.get("id").and_then(Value::as_str) == Some("abort-proof")
                    && frame.data.get("message").and_then(Value::as_str) == Some("queue cleared")
            }),
            5_000
        ),
        "the interrupt never cleared the queue"
    );
    // The order is read from the frames the session actually wrote.
    let record = harness.observer.record();
    let order: Vec<&str> = record
        .frames()
        .into_iter()
        .filter(|frame| frame.dir == ace_adapter_api::FrameDirection::Send)
        .filter_map(|frame| frame.data.get("type").and_then(Value::as_str))
        .filter(|kind| ["clear_queue", "abort", "abort_bash"].contains(kind))
        .collect();
    assert_eq!(order, vec!["clear_queue", "abort", "abort_bash"]);
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
        AdapterApiError::InputRejected(message) => assert_eq!(message, "No model"),
        other => return Err(format!("wrong error: {other}").into()),
    }
    harness.close(&session)?;
    Ok(())
}

/// A refusal after the first of two commands is never retryable: the first one ran.
#[test]
fn a_second_command_refused_mid_send_is_not_retryable() -> TestResult {
    let harness = Harness::new("two-commands")?;
    let session = harness.open(Vec::new(), None, |_| {}, None)?;
    let parts = vec![mention("review", "the diff"), mention("refuse", "")];
    let error = send_parts(&harness, &session, &parts, Delivery::Queue)
        .err()
        .ok_or("the second refusal was not reported")?;
    assert!(
        matches!(error, AdapterApiError::Transport(_)),
        "a refusal after acceptance must stay uncertain, got {error}"
    );
    assert!(!error.retryable());
    // Exactly the first command reached Pi.
    let record = harness.observer.record();
    assert_eq!(record.sends("prompt").len(), 2, "two prompts were written");
    let first = record.sends("prompt")[0]
        .get("message")
        .and_then(Value::as_str)
        .ok_or("no first message")?;
    assert!(
        first.starts_with("/review the diff\n\nMessage context:\n"),
        "the first command did not reach Pi: {first}"
    );
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
    let record = harness.observer.record();
    let exits = record.exits();
    assert_eq!(exits.len(), 1, "one exit notice");
    assert!(exits[0].deliberate);
    assert_eq!(exits[0].message, "Pi process stopped, code null");
    // The terminal barrier holds: the notice is the last thing the observer hears.
    assert!(
        matches!(record.log.last(), Some(Logged::Exit(_))),
        "a frame arrived after the exit notice"
    );
    let error = send(&harness, &session, "late", Delivery::Queue).err();
    assert!(
        error
            .map(|error| error.to_string().contains("Pi session closed"))
            .unwrap_or(false),
        "a closed session must refuse a send"
    );
    Ok(())
}

/// A close whose drain lands while the closer waits still returns (the lost-wakeup race).
#[test]
fn a_close_completes_repeatedly_while_the_drain_lands() -> TestResult {
    for round in 0..12 {
        let harness = Harness::new(&format!("drain-race-{round}"))?;
        let session = harness.open(Vec::new(), None, |_| {}, None)?;
        send(&harness, &session, "hello", Delivery::Queue)?;
        let started = Instant::now();
        harness.close(&session)?;
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "close hung in round {round}"
        );
    }
    Ok(())
}

/// A crash mid-turn: stderr, then the exit, and the exit is not deliberate.
#[test]
fn a_crash_mid_turn_reports_the_exit_after_its_stderr() -> TestResult {
    let harness = Harness::new("crash")?;
    let session = harness.open(
        vec![("FAKE_PI_CRASH_MID_TURN".to_owned(), "1".to_owned())],
        None,
        |_| {},
        None,
    )?;
    let _ = send(&harness, &session, "hello", Delivery::Queue);
    assert!(
        harness.observer.wait(
            |state| !state.exits().is_empty()
                && state.frames().iter().any(|frame| {
                    frame.dir == ace_adapter_api::FrameDirection::Stderr
                        && frame.data.as_str() == Some("synthetic crash mid-turn")
                }),
            5_000
        ),
        "the exit or its stderr never arrived"
    );
    // The observer's one log holds the order: the stderr frame precedes the exit.
    let record = harness.observer.record();
    let stderr_at = record
        .log
        .iter()
        .position(|entry| {
            matches!(entry, Logged::Frame(frame)
                if frame.dir == ace_adapter_api::FrameDirection::Stderr)
        })
        .ok_or("no stderr frame")?;
    let exit_at = record
        .log
        .iter()
        .position(|entry| matches!(entry, Logged::Exit(_)))
        .ok_or("no exit")?;
    assert!(stderr_at < exit_at, "the exit came before its stderr");
    let exits = record.exits();
    assert_eq!(exits[0].message, "Pi process exit, code 3");
    assert!(!exits[0].deliberate);
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
        .record()
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
    assert_eq!(
        &args[1..],
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
        &SessionReference {
            path: resumed.to_string_lossy().to_string(),
            id: "resumed-native".to_owned(),
        },
    )?;
    let session = harness.open(Vec::new(), Some(stored), |_| {}, None)?;
    assert_eq!(session.native_session_file(), resumed.to_string_lossy());
    harness.close(&session)?;
    Ok(())
}

/// Resume refuses a session whose own id is not the stored one (`FAKE_PI_WRONG_ID`).
#[test]
fn resume_refuses_a_session_whose_id_changed() -> TestResult {
    let harness = Harness::new("wrong-id")?;
    let resumed = harness.home.join("resumed.jsonl");
    let error = harness
        .open(
            vec![("FAKE_PI_WRONG_ID".to_owned(), "1".to_owned())],
            Some(resumed.to_string_lossy().to_string()),
            |_| {},
            None,
        )
        .err()
        .ok_or("a replaced identity resumed")?;
    assert!(
        matches!(
            error,
            PiSessionError::History(ace_adapter_pi::session::history::PiHistoryError::Identity)
        ),
        "unexpected error: {error}"
    );
    Ok(())
}

/// "opening failure revokes the injected ace MCP lease".
#[test]
fn an_opening_failure_revokes_the_injected_ace_mcp_lease() -> TestResult {
    let harness = Harness::new("lease")?;
    let (result, ended) = harness.open_with_lease(
        vec![("FAKE_PI_LOAD_FAILURE".to_owned(), "1".to_owned())],
        None,
        |_| {},
        None,
    );
    let error = result.err().ok_or("the open succeeded")?;
    assert!(matches!(
        error,
        PiSessionError::Uncertain(_) | PiSessionError::Refused(_)
    ));
    assert_eq!(
        ended.load(Ordering::SeqCst),
        1,
        "the lease ended exactly once"
    );
    assert!(!harness.home.join("config").join("ace-mcp-lease").exists());
    Ok(())
}

/// Every refusal before the spawn revokes the lease, as `session.ts:108`–`:122` does.
#[test]
fn the_lease_ends_on_every_refusal_before_the_spawn() -> TestResult {
    let harness = Harness::new("lease-refusals")?;

    // A release below the floor.
    let (result, ended) = harness.open_with_lease(
        Vec::new(),
        None,
        |input| {
            input.version = Some("0.84.4".to_owned());
        },
        None,
    );
    assert!(matches!(result.err(), Some(PiSessionError::Cli(_))));
    assert_eq!(ended.load(Ordering::SeqCst), 1, "too-old version");

    // A saved reference that does not exist.
    let missing = harness.home.join("missing.jsonl");
    let (result, ended) = harness.open_with_lease(
        Vec::new(),
        Some(missing.to_string_lossy().to_string()),
        |_| {},
        None,
    );
    assert!(matches!(
        result.err(),
        Some(PiSessionError::History(
            ace_adapter_pi::session::history::PiHistoryError::Missing
        ))
    ));
    assert_eq!(ended.load(Ordering::SeqCst), 1, "missing reference");

    // A credential directory that cannot be made.
    let unreachable = harness.home.join("does-not-exist").join("config");
    let (result, ended) = harness.open_with_lease(Vec::new(), None, |_| {}, Some(unreachable));
    assert!(matches!(result.err(), Some(PiSessionError::Config(_))));
    assert_eq!(ended.load(Ordering::SeqCst), 1, "configuration IO error");

    // A permission mode Pi cannot run.
    let (result, ended) = harness.open_with_lease(
        Vec::new(),
        None,
        |input| {
            input.permission_mode = Some("plan".to_owned());
        },
        None,
    );
    assert!(matches!(
        result.err(),
        Some(PiSessionError::Launch(
            ace_adapter_pi::session::launch::PiLaunchError::PermissionMode(_)
        ))
    ));
    assert_eq!(ended.load(Ordering::SeqCst), 1, "unknown permission mode");
    Ok(())
}

/// The close kills a descendant that ignores SIGTERM: the group, not only the leader.
#[test]
fn a_close_kills_a_descendant_that_ignores_sigterm() -> TestResult {
    let harness = Harness::new("descendant")?;
    let session = harness.open(
        vec![("FAKE_PI_DESCENDANT_SCRIPT".to_owned(), ignoring_script())],
        None,
        |_| {},
        None,
    )?;
    send(&harness, &session, "spawn-child", Delivery::Queue)?;
    let pid = descendant_pid(&harness, &harness.observer)?;
    assert!(alive(pid), "the descendant never ran");
    harness.close(&session)?;
    assert!(
        wait_gone(pid, 5_000),
        "a descendant that ignores SIGTERM outlived the close"
    );
    Ok(())
}

/// A natural exit kills what the leader left behind, as `killGroupOnExit` does.
#[test]
fn a_natural_exit_kills_the_descendants() -> TestResult {
    let harness = Harness::new("natural-exit")?;
    let session = harness.open(
        vec![
            ("FAKE_PI_DESCENDANT_SCRIPT".to_owned(), ignoring_script()),
            ("FAKE_PI_SPAWN_THEN_EXIT".to_owned(), "1".to_owned()),
        ],
        None,
        |_| {},
        None,
    )?;
    let _ = send(&harness, &session, "spawn-child", Delivery::Queue);
    let pid = descendant_pid(&harness, &harness.observer)?;
    assert!(
        harness
            .observer
            .wait(|state| !state.exits().is_empty(), 5_000),
        "the exit never arrived"
    );
    assert!(
        wait_gone(pid, 5_000),
        "a descendant outlived the leader's own exit"
    );
    // The exit was the child's own, not a close ace asked for.
    let record = harness.observer.record();
    assert!(!record.exits()[0].deliberate);
    Ok(())
}

/// The stored reference of a session is readable by the next open (the round trip the engine
/// relies on when it resumes a thread).
#[test]
fn a_saved_reference_loads_for_the_next_open() -> TestResult {
    let harness = Harness::new("reference-round-trip")?;
    let session = harness.open(Vec::new(), None, |_| {}, None)?;
    let stored = session.native_session_id().to_owned();
    harness.close(&session)?;
    let loaded = load_session_reference(&harness.home.join("references"), &stored)?;
    assert_eq!(loaded.id, "native");
    let next = harness.open(Vec::new(), Some(stored), |_| {}, None)?;
    assert_eq!(next.native_session_file(), loaded.path);
    harness.close(&next)?;
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
    assert!(matches!(error, AdapterApiError::SteerTargetLost(_)));
    assert!(harness.observer.record().sends("prompt").is_empty());
    harness.close(&session)?;
    Ok(())
}

/// A session opened with the cancel signal already aborted leaves no child and no lease.
#[test]
fn an_aborted_cancel_signal_refuses_the_open_and_ends_the_lease() -> TestResult {
    let harness = Harness::new("cancel")?;
    let ended = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&ended);
    let cancel = Abort::new();
    cancel.abort();
    let open = PiSessionOpen {
        launch: PiLaunchInput {
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
            ],
            extension_path: "/ace/extension.ts".to_owned(),
            ..PiLaunchInput::default()
        },
        root_key: "root".to_owned(),
        control_secret: "d".repeat(64),
        lease: Some(PiLease::new(
            "http://127.0.0.1:1/mcp".to_owned(),
            "e".repeat(64),
            move || {
                flag.store(true, Ordering::SeqCst);
            },
        )),
        reference_dir: harness.home.join("references"),
        config_root: harness.home.join("config"),
        nonce: "cancel".to_owned(),
        process_id: "rust-pi-process".to_owned(),
        resume: None,
        observer: Arc::clone(&harness.observer) as Arc<dyn ace_adapter_api::SessionObserver>,
        clock: Arc::new(FixedClock),
        timer: Arc::clone(&harness.timer) as Arc<dyn ace_adapter_pi::session::Timer>,
        cancel,
        max_output_bytes: None,
    };
    let error = harness
        .runtime
        .block_on(open_pi_session(open, harness.runtime.handle()))
        .err()
        .ok_or("the open succeeded")?;
    assert!(matches!(error, PiSessionError::Cancelled));
    assert!(ended.load(Ordering::SeqCst));
    Ok(())
}

/// A cancel that arrives while Pi is answering the handshake returns at once and stops the
/// child: an open the engine abandoned leaves nothing running (`ctx.signal`, `session.ts:62`).
#[test]
fn an_open_cancelled_while_pi_answers_late_returns_at_once_and_stops_the_child() -> TestResult {
    let harness = Harness::new("cancel-mid-open")?;
    let marker = harness.home.join("busy");
    let cancel = Abort::new();
    let ended = Arc::new(AtomicU64::new(0));
    let flag = Arc::clone(&ended);
    let open = harness.open_input(
        vec![
            ("FAKE_PI_SLOW_STATE_MS".to_owned(), "3000".to_owned()),
            (
                "FAKE_PI_SLOW_STATE_MARKER".to_owned(),
                marker.to_string_lossy().to_string(),
            ),
        ],
        None,
        |_| {},
        None,
        Some(PiLease::new(
            "http://127.0.0.1:1/mcp".to_owned(),
            "f".repeat(64),
            move || {
                flag.fetch_add(1, Ordering::SeqCst);
            },
        )),
        cancel.clone(),
    );
    let runtime = harness.runtime.handle().clone();
    let child_runtime = runtime.clone();
    let running = runtime.spawn(async move { open_pi_session(open, &child_runtime).await });
    // Pi has the request and is holding the reply: the open is genuinely mid-handshake.
    let deadline = Instant::now() + Duration::from_secs(5);
    while !marker.exists() {
        if Instant::now() >= deadline {
            return Err("Pi never reached its delayed reply".into());
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    cancel.abort();
    let at = Instant::now();
    let joined = harness
        .runtime
        .block_on(async { tokio::time::timeout(Duration::from_secs(2), running).await });
    let result = joined.map_err(|_| "the cancelled open did not return")??;
    assert!(
        matches!(result.err(), Some(PiSessionError::Cancelled)),
        "the cancelled open did not refuse"
    );
    assert!(
        at.elapsed() < Duration::from_secs(2),
        "the open waited for Pi's late reply"
    );
    assert_eq!(ended.load(Ordering::SeqCst), 1, "the lease ended");
    assert!(
        !harness.home.join("config").join("session").exists(),
        "the private configuration survived"
    );
    assert!(
        harness
            .observer
            .wait(|state| !state.exits().is_empty(), 5_000),
        "the child was never stopped"
    );
    Ok(())
}

/// A cooperative child exits on SIGTERM, so the stop returns at once and never reaches the
/// grace's SIGKILL. Holding the group across the poll made every close wait the full 1,000 ms.
#[test]
fn a_cooperative_close_returns_long_before_the_grace() -> TestResult {
    let harness = Harness::new("cooperative-close")?;
    let session = harness.open(Vec::new(), None, |_| {}, None)?;
    send(&harness, &session, "hello", Delivery::Queue)?;
    let started = Instant::now();
    harness.close(&session)?;
    assert!(
        started.elapsed() < Duration::from_millis(300),
        "the close waited for the grace: {:?}",
        started.elapsed()
    );
    assert_eq!(harness.observer.record().exits().len(), 1, "no exit notice");
    Ok(())
}

/// "MCP bearer echoes are redacted before raw frames and lease ends on close": the fake answers
/// a prompt with the injected lease bearer, the wire redacts it, and the close ends the lease.
#[test]
fn a_lease_bearer_is_redacted_before_frames_and_ends_on_close() -> TestResult {
    let harness = Harness::new("lease-success")?;
    let (opened, ended) = harness.open_with_lease(Vec::new(), None, |_| {}, None);
    let session = opened?;
    send(&harness, &session, "env-proof", Delivery::Queue)?;
    assert!(
        harness.observer.wait(
            |state| state
                .frames()
                .iter()
                .any(|frame| ace_json::to_string(&frame.data).contains("<ACE_LEASE>")),
            5_000
        ),
        "the echoed bearer never reached the frames"
    );
    let frames: Vec<String> = harness
        .observer
        .record()
        .frames()
        .iter()
        .map(|frame| ace_json::to_string(&frame.data))
        .collect();
    let joined = frames.join("\n");
    assert!(
        !joined.contains(&"c".repeat(64)),
        "a frame carried the lease bearer"
    );
    harness.close(&session)?;
    assert_eq!(
        ended.load(Ordering::SeqCst),
        1,
        "the close did not end the lease"
    );
    Ok(())
}

/// A Pi that forks a detached background child, then a close: the exit listener kills the
/// group, and close waits for confirmed emptiness rather than only the pipe drain
/// (`process.ts:299`–`:319`).
#[test]
fn a_close_waits_for_a_detached_descendant_and_returns_only_when_it_is_gone() -> TestResult {
    let harness = Harness::new("detached-close")?;
    let session = harness.open(
        vec![("FAKE_PI_DESCENDANT_SCRIPT".to_owned(), ignoring_script())],
        None,
        |_| {},
        None,
    )?;
    send(&harness, &session, "spawn-detached", Delivery::Queue)?;
    let pid = descendant_pid(&harness, &harness.observer)?;
    assert!(alive(pid), "the detached descendant never ran");
    harness.close(&session)?;
    assert!(
        !alive(pid),
        "the detached descendant was still running when close returned"
    );
    Ok(())
}
