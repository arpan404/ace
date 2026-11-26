// SPDX-License-Identifier: Apache-2.0
//! The shell against a real child: `sh` echoes every line it reads, so an acknowledged write is
//! visible as the child's own output and the pipe's ends are the supervisor's.

// A test's setup failures are panics: the runtime, the child and every admitted write.
#![allow(clippy::expect_used)]

use super::*;
use ace_adapter_api::frame::FrameDirection;
use ace_supervisor::child::{SupervisedChild, spawn_child};
use ace_supervisor::divert::{DivertTarget, Diverted};
use ace_supervisor::signal::SignalName;
use ace_supervisor::spawn::{EventSink, SpawnSpec, StdioMode};
use std::sync::Arc;
use std::time::Duration;

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

    /// Pulls the queue until an event matches. The wait is the queue's own: it sleeps on the
    /// publish that wakes it, never on a timer, and a stalled session still ends it.
    fn wait(&mut self, done: impl Fn(&SessionEvent) -> bool) {
        let core = Arc::clone(&self.core);
        let runtime = &self._runtime;
        let seen = &mut self.seen;
        loop {
            let batch = core.queue().take_batch(4096, 4 * 1024 * 1024);
            if !batch.is_empty() {
                seen.push(batch);
            }
            if seen.iter().flatten().any(&done) {
                return;
            }
            let arrived = runtime.block_on(async {
                tokio::time::timeout(Duration::from_secs(10), core.queue().wait())
                    .await
                    .is_ok()
            });
            if !arrived {
                return;
            }
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

/// A close with a pending ask answers it while stdin is open (`session.ts:101`-`:109`,
/// `:257`-`:268`): the default answer reaches the child, then input ends and `Drained` is
/// last.
#[test]
fn a_close_answers_a_pending_ask_while_stdin_is_open() {
    let mut child = Child::open();
    child
        .core
        .input(|wire| wire.stdout_bytes(format!("{ASK}\n").as_bytes()));
    child.core.close();
    // The child echoes what it reads, so an answer in its output proves the close wrote it
    // to an open pipe.
    let echoed = |event: &SessionEvent| {
        matches!(event,
            SessionEvent::Frame { dir: FrameDirection::Recv, channel, text, .. }
                if channel == "wire" && text.contains("Claude request ended."))
    };
    child.wait(echoed);
    assert!(
        child.events().any(echoed),
        "the close wrote the answer to the child"
    );
    child.wait(is_drained);
    let events: Vec<&SessionEvent> = child.events().collect();
    let position =
        |want: &dyn Fn(&SessionEvent) -> bool| events.iter().position(|event| want(event));
    let lifecycle = position(&|event| {
        matches!(event, SessionEvent::Frame { channel, text, .. }
            if channel == "interaction_lifecycle" && text.contains(r#""state":"expired""#))
    });
    let answer = position(&|event| {
        matches!(event,
        SessionEvent::Frame { dir: FrameDirection::Send, channel, text, .. }
            if channel == "wire" && text.contains("Claude request ended."))
    });
    let drained = position(&|event| is_drained(event));
    assert!(
        lifecycle.is_some() && lifecycle < answer,
        "the lifecycle frame precedes the answer: {lifecycle:?} {answer:?}"
    );
    assert_eq!(drained, Some(events.len() - 1), "Drained is the last event");
}

/// A send after the close's input end is refused before it writes, so a dead pipe never
/// latches the session (`input.ts:13`-`:37`, `session.ts:413`-`:419`).
#[test]
fn a_send_after_input_ended_is_refused_and_writes_nothing() {
    let mut child = Child::open();
    child.core.end_input();
    let late = child
        .core
        .send(&format!("[{}]", message("u-late", "late")), None);
    assert!(
        matches!(late, Err(ClaudeError::Refused(_))),
        "the send is refused: {late:?}"
    );
    child.core.close();
    child.wait(is_drained);
    assert!(
        !child
            .events()
            .any(|event| matches!(event, SessionEvent::Fatal { .. })),
        "no stdin failure latched the session"
    );
    assert!(
        !child.events().any(|event| matches!(
            event,
            SessionEvent::Frame { text, .. } if text.contains("u-late")
        )),
        "nothing was written after input ended"
    );
}

/// Inputs never interleave their writes with the close: a send either queues its lines under
/// the close's turn or is refused by the state, so no write reaches the ended pipe. The state
/// stays readable throughout, because no input holds it across its writes or publish.
#[test]
fn sends_racing_the_close_never_write_after_input_ends() {
    let mut child = Child::open();
    let core = Arc::clone(&child.core);
    let writers: Vec<_> = (0..4)
        .map(|worker| {
            let core = Arc::clone(&core);
            std::thread::spawn(move || {
                for round in 0..50 {
                    let messages =
                        format!("[{}]", message(&format!("u-{worker}-{round}"), "noise"));
                    if core.send(&messages, None).is_err() {
                        // Closed: every later send is refused the same way.
                        return;
                    }
                }
            })
        })
        .collect();
    // Readable while they write: the state is not held across a write or a publish.
    assert!(child.core.task_cascade(None).starts_with(r#"{"ids":[]"#));
    std::thread::sleep(Duration::from_millis(2));
    child.core.close();
    for writer in writers {
        writer.join().expect("a writer finishes");
    }
    child.wait(is_drained);
    assert!(
        !child
            .events()
            .any(|event| matches!(event, SessionEvent::Fatal { .. })),
        "no send wrote into the ended pipe"
    );
    let mut written: Vec<&str> = child
        .sent()
        .into_iter()
        .filter(|(channel, _)| *channel == "sdk")
        .map(|(_, text)| text)
        .collect();
    let admitted = written.len();
    written.sort_unstable();
    written.dedup();
    assert_eq!(
        written.len(),
        admitted,
        "every acknowledged send appears once"
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
    child.wait(|event| matches!(event, SessionEvent::Frame { channel, .. } if channel == "wire"));
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
