// SPDX-License-Identifier: Apache-2.0
//! The Claude session's tokio side (E3-claude.4): one lock over the wire, one ordered queue to
//! the facade, the read gate the child's pumps answer, and the child's ports. Every input - an
//! output chunk, a binding call, a timer - runs the one `ClaudeWire` method under `wire`'s lock,
//! hands each `Write` to the child's stdin in order, and publishes the rest as one batch, so two
//! inputs never interleave their events (ADR 0223 section 7 rules 3-4).

use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use crate::session::error::ClaudeError;
use crate::session::wire::{ClaudeWire, Effect, WireConfig};
use ace_adapter_api::bridge::{EventQueue, ReadGate, SessionErrorWire, SessionEvent};
use ace_supervisor::divert::{ChildPorts, OutputConsumer};
use ace_supervisor::errors::NodeIoError;
use ace_supervisor::spawn::{Delivered, OutputStream, RawExit};

/// The inherited-pipe cutoff: 1,000 ms after the leader's exit (`session.ts:120`, `:262`-`:266`).
const CUTOFF: &str = "cutoff";
const CUTOFF_MS: f64 = 1_000.0;

/// The variables the session adds to ace's environment (`session.ts:241`): ace's client-app
/// marker, and the session-state read the recorded 2.1.331 handshake shows the harness sets and
/// nothing else (claude-session.md Q3, `fixtures/claude/handshake-2.1.331/env-added.json`).
pub const SESSION_ENV: [(&str, &str); 2] = [
    ("CLAUDE_AGENT_SDK_CLIENT_APP", "ace/0.0.0"),
    ("CLAUDE_CODE_SDK_READS_SESSION_STATE", "1"),
];

/// The environment the child is spawned with: ace's own, and then the session's variables, so
/// ace's value wins over one a caller left in place (`{ ...env, … , CLAUDE_… : "1" }`).
pub fn session_env(base: impl IntoIterator<Item = (String, String)>) -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = base
        .into_iter()
        .filter(|(name, _)| !SESSION_ENV.iter().any(|(own, _)| own == name))
        .collect();
    env.extend(
        SESSION_ENV
            .iter()
            .map(|(name, value)| ((*name).to_owned(), (*value).to_owned())),
    );
    env
}

/// The message a session reports once for its exit (`session.ts:101`-`:109`, `:257`-`:268`): a
/// recorded failure wins, else the process's own end, which reads its code, then its signal,
/// then the shell's reason. An end with none of the three cannot happen today (node reports a
/// code or a signal), so the last arm names it rather than inventing one of them.
pub fn exit_message(failure: Option<&str>, exit: &RawExit, reason: Option<&str>) -> String {
    if let Some(message) = failure {
        return message.to_owned();
    }
    let end = match (&exit.code, &exit.signal) {
        (Some(code), _) => code.to_string(),
        (None, Some(signal)) => signal.clone(),
        (None, None) => reason.unwrap_or("unknown").to_owned(),
    };
    format!("Claude process exited: {end}")
}

/// One native Claude session's shared state. The binding holds it; the diverted child's
/// consumer is a clone of the same `Arc`.
pub struct ClaudeSessionCore {
    wire: Mutex<ClaudeWire>,
    queue: EventQueue,
    gate: ReadGate,
    ports: Arc<OnceLock<ChildPorts>>,
}

impl ClaudeSessionCore {
    pub fn new(config: WireConfig) -> Self {
        let gate = ReadGate::new();
        let queue = EventQueue::new(gate.clone());
        Self {
            wire: Mutex::new(ClaudeWire::new(config)),
            queue,
            gate,
            ports: Arc::new(OnceLock::new()),
        }
    }

    fn attach_gate(&self) {
        if let Some(ports) = self.ports.get() {
            self.gate.attach(ports.output.clone());
        }
    }

    pub fn queue(&self) -> &EventQueue {
        &self.queue
    }

    pub fn gate(&self) -> &ReadGate {
        &self.gate
    }

    pub fn ports(&self) -> &Arc<OnceLock<ChildPorts>> {
        &self.ports
    }

    /// One control request; its write goes to stdin and its `send`/`wire` frame follows the ack.
    pub fn control(&self, request_json: &str, id: u64) -> Result<(), ClaudeError> {
        let mut wire = self.lock();
        let effects = wire.control(request_json, id)?;
        self.commit(&mut wire, effects);
        Ok(())
    }

    /// One synchronous send: every message is admitted before the first write.
    pub fn send(&self, messages_json: &str, command_id: Option<&str>) -> Result<(), ClaudeError> {
        let mut wire = self.lock();
        let effects = wire.send(messages_json, command_id)?;
        self.commit(&mut wire, effects);
        Ok(())
    }

    pub fn peek_interaction(&self, id: &str) -> Option<String> {
        self.lock().peek_interaction(id)
    }

    pub fn answer_interaction(&self, id: &str, result_json: &str, resolution_json: &str) -> bool {
        let mut wire = self.lock();
        let (answered, effects) = wire.answer_interaction(id, result_json, resolution_json);
        self.commit(&mut wire, effects);
        answered
    }

    pub fn answer_hook(&self, request_id: &str, output_json: &str) {
        self.input(|wire| wire.answer_hook(request_id, output_json));
    }

    pub fn task_target(&self, spawn: &str) -> Option<String> {
        self.lock().task_target(spawn)
    }

    pub fn task_cascade(&self, spawn: Option<&str>) -> String {
        self.lock().task_cascade(spawn)
    }

    pub fn note(&self, json: &str) {
        self.input(|wire| wire.note(json));
    }

    /// `"cutoff"` closes both pumps; the wire's own notes timer runs in it.
    pub fn timer(&self, key: &str) {
        if key == CUTOFF {
            if let Some(ports) = self.ports.get() {
                ports.output.close(OutputStream::Stdout);
                ports.output.close(OutputStream::Stderr);
            }
            return;
        }
        self.input(|wire| wire.timer(key));
    }

    /// The close's own expiry: every pending interaction gets its default answer.
    pub fn expire(&self) {
        self.input(ClaudeWire::expire);
    }

    /// `q.close()`'s `input.close()`: EOF after every queued write, and no expiry writes.
    pub fn end_input(&self) {
        self.lock().end_input();
        if let Some(ports) = self.ports.get() {
            ports.stdin.end();
        }
    }

    /// No child will ever report (the spawn threw): answer what is pending, then `Drained`.
    pub fn abandon(&self) {
        let mut wire = self.lock();
        let mut effects = wire.expire();
        effects.extend(wire.finish());
        self.commit(&mut wire, effects);
    }

    /// One input: the wire's effects, the writes, then one publish, all under the wire's lock.
    /// A write the port refuses undoes its queue record first, so `write_refused` can latch.
    fn commit(&self, wire: &mut ClaudeWire, effects: Vec<Effect>) {
        let mut events = Vec::with_capacity(effects.len());
        for effect in effects {
            match effect {
                Effect::Write { wire: bytes } => {
                    let refused = match self.ports.get() {
                        Some(ports) => ports.stdin.write(bytes).is_err(),
                        None => true,
                    };
                    if refused {
                        push_events(&mut events, wire.write_refused());
                    }
                }
                Effect::Fatal { message } => events.push(SessionEvent::Fatal { message }),
                other => push_events(&mut events, std::iter::once(other)),
            }
        }
        if !events.is_empty() {
            self.queue.publish(events);
        }
    }

    fn input(&self, run: impl FnOnce(&mut ClaudeWire) -> Vec<Effect>) {
        let mut wire = self.lock();
        let effects = run(&mut wire);
        self.commit(&mut wire, effects);
    }

    /// The mutex is held only for state moves and queue pushes; a poisoned one is recovered,
    /// because a session must still deliver what it read.
    fn lock(&self) -> MutexGuard<'_, ClaudeWire> {
        self.wire.lock().unwrap_or_else(|error| error.into_inner())
    }
}

impl OutputConsumer for ClaudeSessionCore {
    fn output(&self, stream: OutputStream, bytes: Vec<u8>, delivered: Delivered) {
        self.attach_gate();
        match stream {
            OutputStream::Stdout => self.input(|wire| wire.stdout_bytes(&bytes)),
            OutputStream::Stderr => self.input(|wire| wire.stderr_bytes(&bytes)),
        }
        self.gate.answer(delivered);
    }

    fn end(&self, _stream: OutputStream) {
        // An end is not the barrier; only the supervisor's `close` is.
    }

    fn stdin_written(&self) {
        self.attach_gate();
        self.input(ClaudeWire::stdin_written);
    }

    fn stdin_error(&self, error: NodeIoError) {
        self.attach_gate();
        let message = stdin_message(&error);
        self.input(|wire| wire.stdin_error(&message));
    }

    fn exit(&self, _exit: RawExit) {
        self.attach_gate();
        self.gate.exited();
        self.queue.publish(vec![SessionEvent::ArmTimer {
            key: CUTOFF.to_owned(),
            ms: CUTOFF_MS,
        }]);
    }

    fn close(&self, _exit: RawExit) {
        self.attach_gate();
        // The terminal barrier. A child that ends before the cutoff cancels it.
        self.input(|wire| {
            let mut effects = vec![Effect::CancelTimer {
                key: CUTOFF.to_owned(),
            }];
            effects.extend(wire.finish());
            effects
        });
    }
}

/// The stdin failure's node message (`NodeIoError::to_json`'s `message`).
fn stdin_message(error: &NodeIoError) -> String {
    let json = error.to_json();
    ace_json::parse(&json)
        .ok()
        .and_then(|value| {
            value
                .as_object()
                .and_then(|map| map.get("message"))
                .and_then(|message| message.as_str().map(str::to_owned))
        })
        .unwrap_or_else(|| "write EPIPE".to_owned())
}

fn push_events(events: &mut Vec<SessionEvent>, effects: impl IntoIterator<Item = Effect>) {
    for effect in effects {
        if let Some(event) = event_of(effect) {
            events.push(event);
        }
    }
}

/// One wire effect as the queue carries it. A write never becomes an event: it reaches the
/// pipe, and `stdin_written` emits its `send` frame.
fn event_of(effect: Effect) -> Option<SessionEvent> {
    Some(match effect {
        Effect::Frame { dir, channel, text } => SessionEvent::Frame {
            seq: 0,
            dir,
            channel: channel.to_owned(),
            text,
        },
        Effect::Callback { name, json } => SessionEvent::Callback { name, json },
        Effect::Settle { id, result } => SessionEvent::Settle {
            id,
            result: result.map_err(settle_error),
        },
        Effect::ArmTimer { key, ms } => SessionEvent::ArmTimer { key, ms },
        Effect::CancelTimer { key } => SessionEvent::CancelTimer { key },
        Effect::Fatal { message } => SessionEvent::Fatal { message },
        Effect::Drained => SessionEvent::Drained,
        Effect::Write { .. } => return None,
    })
}

fn settle_error(error: ClaudeError) -> SessionErrorWire {
    SessionErrorWire {
        code: error.code(),
        message: error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn core() -> ClaudeSessionCore {
        ClaudeSessionCore::new(WireConfig {
            session_id: "session-1".to_owned(),
            root_key: "root".to_owned(),
            bearer: None,
            resume: false,
        })
    }

    fn clean_exit() -> RawExit {
        RawExit {
            code: Some(0),
            signal: None,
        }
    }

    /// A final line with no newline is delivered at the barrier, and `Drained` comes last.
    #[test]
    fn a_final_line_and_drained_arrive_at_the_close() {
        let core = core();
        core.input(|wire| wire.stdout_bytes(br#"{"type":"keep_alive"}"#));
        core.close(clean_exit());
        let events = core.queue().take_batch(256, 256 * 1024);
        assert!(
            events.iter().any(
                |event| matches!(event, SessionEvent::Frame { channel, .. } if channel == "sdk")
            )
        );
        assert!(matches!(events.last(), Some(SessionEvent::Drained)));
    }

    /// A fatal capture is published, and the close still settles and drains.
    #[test]
    fn a_fatal_is_followed_by_drained_at_the_close() {
        let core = core();
        let huge = format!(
            r#"{{"type":"keep_alive","data":"{}"}}"#,
            " ".repeat(1024 * 1024)
        );
        core.input(|wire| wire.stdout_bytes(format!("{huge}\n").as_bytes()));
        core.close(clean_exit());
        let events = core.queue().take_batch(512, 1024 * 1024);
        assert!(
            events
                .iter()
                .any(|event| matches!(event, SessionEvent::Fatal { .. }))
        );
        assert!(matches!(events.last(), Some(SessionEvent::Drained)));
    }

    /// The session's own variables are the last word on the child's environment.
    #[test]
    fn the_session_owns_its_two_variables_and_leaves_the_rest_alone() {
        let base = vec![
            ("PATH".to_owned(), "/usr/bin".to_owned()),
            (
                "CLAUDE_CODE_SDK_READS_SESSION_STATE".to_owned(),
                "0".to_owned(),
            ),
            ("HOME".to_owned(), "/home/person".to_owned()),
        ];
        let env = session_env(base);
        assert_eq!(
            env,
            vec![
                ("PATH".to_owned(), "/usr/bin".to_owned()),
                ("HOME".to_owned(), "/home/person".to_owned()),
                (
                    "CLAUDE_AGENT_SDK_CLIENT_APP".to_owned(),
                    "ace/0.0.0".to_owned()
                ),
                (
                    "CLAUDE_CODE_SDK_READS_SESSION_STATE".to_owned(),
                    "1".to_owned()
                ),
            ]
        );
    }

    /// A failure's text wins over the process's own end (`session.ts:257`-`:268`).
    #[test]
    fn a_recorded_failure_is_the_exit_message() {
        assert_eq!(
            exit_message(
                Some("Claude session state is unreadable"),
                &clean_exit(),
                None
            ),
            "Claude session state is unreadable"
        );
    }

    /// Without a failure the exit reports its code, else its signal, else the shell's reason.
    #[test]
    fn the_exit_message_reports_the_code_then_the_signal_then_the_reason() {
        let signalled = RawExit {
            code: None,
            signal: Some("SIGTERM".to_owned()),
        };
        let silent = RawExit {
            code: None,
            signal: None,
        };
        assert_eq!(
            exit_message(None, &clean_exit(), Some("stopped")),
            "Claude process exited: 0"
        );
        assert_eq!(
            exit_message(None, &signalled, Some("stopped")),
            "Claude process exited: SIGTERM"
        );
        assert_eq!(
            exit_message(None, &silent, Some("output-limit")),
            "Claude process exited: output-limit"
        );
    }

    /// A stop with no target is the TS's no-agent branch: every live task, certain
    /// (`session.ts:457`-`:460`).
    #[test]
    fn a_cascade_with_no_target_names_every_live_task() {
        let core = core();
        core.input(|wire| {
            wire.stdout_bytes(
                br#"{"type":"system","subtype":"task_started","task_id":"task-1","tool_use_id":"tool-1"}
"#,
            )
        });
        assert_eq!(
            core.task_cascade(None),
            r#"{"ids":["task-1"],"uncertain":false}"#
        );
        core.input(|wire| {
            wire.stdout_bytes(
                br#"{"type":"system","subtype":"task_started","task_id":"task-2","tool_use_id":"tool-2"}
"#,
            )
        });
        assert_eq!(
            core.task_cascade(None),
            r#"{"ids":["task-1","task-2"],"uncertain":false}"#
        );
        core.input(|wire| {
            wire.stdout_bytes(
                br#"{"type":"system","subtype":"task_notification","task_id":"task-1","status":"completed"}
"#,
            )
        });
        assert_eq!(
            core.task_cascade(None),
            r#"{"ids":["task-2"],"uncertain":false}"#
        );
    }
}

/// The shell against a real child: `cat` reads what the session writes and echoes it back, so
/// an acknowledged write is visible as the child's own output and the pipe's ends are real.
#[cfg(all(test, unix))]
mod child {
    // A test's setup failures are panics: the runtime, the child and every admitted write.
    #![allow(clippy::expect_used)]

    use super::*;
    use ace_adapter_api::frame::FrameDirection;
    use ace_supervisor::child::{SupervisedChild, spawn_child};
    use ace_supervisor::divert::{DivertTarget, Diverted};
    use ace_supervisor::signal::SignalName;
    use ace_supervisor::spawn::{EventSink, SpawnSpec, StdioMode};
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    /// The shell side of a diverted child receives nothing: its events are the session's.
    #[derive(Clone)]
    struct Silent;

    impl EventSink for Silent {
        fn output(&self, _stream: OutputStream, _bytes: Vec<u8>, delivered: Delivered) {
            delivered.taken(true);
        }
        fn end(&self, _stream: OutputStream) {}
        fn exit(&self, _exit: RawExit) {}
        fn close(&self, _exit: RawExit) {}
        fn stdin_written(&self) {}
        fn stdin_error(&self, _error: NodeIoError) {}
        fn hold_limit(&self) {}
        fn held(&self, _message: String) {}
    }

    /// The child's loop: copy every line back at once, so a write is visible as the child's own
    /// output without waiting for a buffer or for EOF.
    const ECHO: &str = "while IFS= read -r line; do printf '%s\\n' \"$line\"; done";

    /// The session and its real child, with every event it published kept in pull order.
    struct Child {
        core: Arc<ClaudeSessionCore>,
        child: SupervisedChild,
        /// Dropped last: the pumps and the reaper live on it.
        _runtime: tokio::runtime::Runtime,
        seen: Vec<Vec<SessionEvent>>,
    }

    impl Child {
        /// A real child as the session's: every line written to stdin comes back on stdout.
        fn open() -> Child {
            let core = Arc::new(ClaudeSessionCore::new(WireConfig {
                session_id: "session-1".to_owned(),
                root_key: "root".to_owned(),
                bearer: None,
                resume: false,
            }));
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .expect("runtime");
            let target = DivertTarget {
                consumer: Arc::clone(&core) as Arc<dyn OutputConsumer>,
                ports: Arc::clone(core.ports()),
            };
            let sink = Diverted::new(Silent, Arc::clone(&target.consumer));
            let child = spawn_child(&spec(), sink, runtime.handle(), Some(&target))
                .expect("spawn the echo child");
            Child {
                core,
                child,
                _runtime: runtime,
                seen: Vec::new(),
            }
        }

        /// Pulls the queue until an event matches, or nothing more arrives for ten seconds.
        fn wait(&mut self, done: impl Fn(&SessionEvent) -> bool) {
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                let batch = self.core.queue().take_batch(4096, 4 * 1024 * 1024);
                if !batch.is_empty() {
                    self.seen.push(batch);
                }
                if self.events().any(&done) || Instant::now() > deadline {
                    return;
                }
                std::thread::sleep(Duration::from_millis(5));
            }
        }

        /// Every event published so far, oldest first.
        fn events(&self) -> impl Iterator<Item = &SessionEvent> {
            self.seen.iter().flatten()
        }

        /// The frames the session sent, in the order they were written and acknowledged.
        fn sent(&self) -> Vec<(&str, &str)> {
            self.events()
                .filter_map(|event| match event {
                    SessionEvent::Frame {
                        dir: FrameDirection::Send,
                        channel,
                        text,
                        ..
                    } => Some((channel.as_str(), text.as_str())),
                    _ => None,
                })
                .collect()
        }
    }

    impl Drop for Child {
        fn drop(&mut self) {
            let _ = self.child.kill(SignalName::Kill);
        }
    }

    fn spec() -> SpawnSpec {
        SpawnSpec {
            command: "/bin/sh".to_owned(),
            args: vec!["-c".to_owned(), ECHO.to_owned()],
            cwd: None,
            env: Vec::new(),
            windows_verbatim: false,
            hide_window: true,
            contain: false,
            max_output_bytes: None,
            stdin: StdioMode::Piped,
            stdout: StdioMode::Piped,
            stderr: StdioMode::Piped,
        }
    }

    fn is_drained(event: &SessionEvent) -> bool {
        matches!(event, SessionEvent::Drained)
    }

    fn is_answer(event: &SessionEvent) -> bool {
        matches!(event,
            SessionEvent::Frame { dir: FrameDirection::Send, channel, text, .. }
                if channel == "wire" && text.contains("Claude request ended."))
    }

    /// A user line as the session writes one.
    fn message(uuid: &str, text: &str) -> String {
        format!(
            r#"{{"type":"user","uuid":"{uuid}","session_id":"session-1","parent_tool_use_id":null,"message":{{"role":"user","content":[{{"type":"text","text":"{text}"}}]}},"priority":"next"}}"#
        )
    }

    /// The ask the fake CLI sends when it needs a tool approved.
    const ASK: &str = r#"{"type":"control_request","request_id":"request-1","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"ls"}}}"#;

    /// `q.close()`'s order: the expiry's answer is written and acknowledged while stdin is open,
    /// ending input follows, the barrier's `Drained` comes last, and nothing is written after it.
    #[test]
    fn the_answer_is_written_before_input_ends_and_drained_comes_last() {
        let mut child = Child::open();
        child
            .core
            .input(|wire| wire.stdout_bytes(format!("{ASK}\n").as_bytes()));
        // expire(): every pending ask gets its default answer, written while stdin is open.
        child.core.expire();
        child.wait(is_answer);
        // end_input(): EOF after everything queued; a second expiry writes nothing.
        child.core.end_input();
        child.core.expire();
        // The child's own end is the terminal barrier; Drained follows the answer's frame.
        child.wait(is_drained);
        let events: Vec<&SessionEvent> = child.events().collect();
        let position =
            |want: &dyn Fn(&SessionEvent) -> bool| events.iter().position(|event| want(event));
        let lifecycle = position(&|event| {
            matches!(event, SessionEvent::Frame { channel, text, .. }
                if channel == "interaction_lifecycle" && text.contains(r#""state":"expired""#))
        });
        let answer = position(&is_answer);
        let drained = position(&|event| is_drained(event));
        assert!(
            lifecycle.is_some() && lifecycle < answer,
            "the lifecycle frame precedes the answer: {lifecycle:?} {answer:?}"
        );
        assert_eq!(drained, Some(events.len() - 1), "Drained is the last event");
        let written = child.sent();
        assert_eq!(
            written
                .iter()
                .filter(|(_, text)| text.contains("Claude request ended."))
                .count(),
            1,
            "one answer, and none after input ended: {written:?}"
        );
        assert!(
            written
                .iter()
                .any(|(channel, text)| *channel == "wire" && text.contains(r#""behavior":"deny""#)),
            "the expiry answered the CLI: {written:?}"
        );
    }

    /// Acknowledged writes are reported strictly in the order they were written: two user lines,
    /// then a control request.
    #[test]
    fn acknowledgements_are_reported_in_write_order() {
        let mut child = Child::open();
        let messages = format!("[{},{}]", message("u-1", "one"), message("u-2", "two"));
        child
            .core
            .send(&messages, Some("command-1"))
            .expect("send is admitted");
        child
            .core
            .control(r#"{"subtype":"mcp_status"}"#, 1)
            .expect("the control is written");
        child.wait(
            |event| matches!(event, SessionEvent::Frame { channel, .. } if channel == "wire"),
        );
        let sent = child.sent();
        assert_eq!(
            sent.iter()
                .take(3)
                .map(|(channel, _)| *channel)
                .collect::<Vec<_>>(),
            ["sdk", "sdk", "wire"],
            "one frame per acknowledged write, in write order: {sent:?}"
        );
        assert!(sent[0].1.contains("u-1"));
        assert!(sent[1].1.contains("u-2"));
        assert!(sent[2].1.contains("mcp_status"));
        // The child echoes the lines it read back on stdout, so the bytes reached its stdin.
        let read_back = |event: &SessionEvent| {
            matches!(event,
                SessionEvent::Frame { dir: FrameDirection::Recv, channel, text, .. }
                    if channel == "sdk" && text.contains(r#""text":"one""#))
        };
        child.wait(read_back);
        assert!(
            child.events().any(read_back),
            "the child read what was written"
        );
    }
}
