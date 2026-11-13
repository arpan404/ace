//! A bot's computer with real shells (ADR 0142): its terminal keeps state between commands and
//! bounds what it keeps, the person types only while driving, taking over pauses the bot at a
//! safe point and handing back resumes it with Spade's note, a restart keeps the person driving,
//! the person's file changes are confined and trusted, and the live streams resume. Process
//! tests: each starts real terminals.
#![cfg(unix)]

mod support;

use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use futures_util::StreamExt;
use serde_json::{Value, json};
use spade_core::tools::Risk;
use spade_server::clock::SystemClock;
use spade_server::computer::daemon::{
    AceComputer, BoxFuture, Browser, Daemon, DriveAnswer, Handback, Screen, Tab,
};
use spade_server::computer::{Computers, Driver, Terminals};
use spade_server::tools::{EngineHandle, Tool};
use spade_server::workspace::shell::Shell;
use spade_server::workspace::{Workspaces, workspace_tools};
use spade_testkit::Script;
use support::{FakeTool, Result, Spade, TOKEN, types};

/// Workspaces, terminals and computers under one folder, kept across a restart.
struct Machine {
    root: tempfile::TempDir,
    workspaces: Workspaces,
    terminals: Arc<Terminals>,
}

impl Machine {
    fn new() -> Result<Self> {
        let root = tempfile::tempdir()?;
        let workspaces = Workspaces::new(root.path().join("workspace"));
        let terminals = Terminals::new(
            root.path().join("terminal"),
            workspaces.clone(),
            Shell::system(),
            Arc::new(SystemClock),
        );
        Ok(Self {
            root,
            workspaces,
            terminals,
        })
    }

    fn computers(&self) -> Arc<Computers> {
        Computers::open(
            self.root.path().join("computer"),
            self.workspaces.clone(),
            self.terminals.clone(),
            Arc::new(SystemClock),
        )
    }

    fn tools(&self, bots: &EngineHandle, extra: Vec<Arc<dyn Tool>>) -> Vec<Arc<dyn Tool>> {
        let mut tools = workspace_tools(
            self.workspaces.clone(),
            bots.clone(),
            self.terminals.clone(),
        );
        tools.extend(extra);
        tools
    }
}

async fn start(
    machine: &Machine,
    scripts: Vec<Script>,
    extra: Vec<Arc<dyn Tool>>,
) -> Result<Spade> {
    let bots = EngineHandle::default();
    let options = support::Options {
        workspaces: Some(machine.workspaces.clone()),
        ..support::Options::default()
    };
    let spade = Spade::start_with(scripts, machine.tools(&bots, extra), options).await?;
    bots.set(&spade.engine);
    spade.engine.set_computers(machine.computers());
    Ok(spade)
}

async fn bot(spade: &Spade) -> Result<(String, String)> {
    let agent = spade.new_agent("Runner", "").await?;
    let field = |name: &str| agent[name].as_str().unwrap_or_default().to_owned();
    Ok((field("id"), field("conversation")))
}

/// A live SSE stream, read event by event.
struct Live {
    body: futures_util::stream::BoxStream<'static, reqwest::Result<Vec<u8>>>,
    text: String,
}

impl Live {
    async fn open(spade: &Spade, path: &str) -> Result<Self> {
        let response = reqwest::Client::new()
            .get(format!("{}{path}", spade.base))
            .bearer_auth(TOKEN)
            .send()
            .await?;
        assert_eq!(response.status(), 200);
        Ok(Self {
            body: response
                .bytes_stream()
                .map(|r| r.map(|b| b.to_vec()))
                .boxed(),
            text: String::new(),
        })
    }

    /// The next event, or `None` after `within`.
    async fn next(&mut self, within: Duration) -> Option<(String, Value)> {
        let deadline = tokio::time::Instant::now() + within;
        loop {
            if let Some(end) = self.text.find("\n\n") {
                let block: String = self.text.drain(..end + 2).collect();
                let mut name = String::new();
                let mut data = String::new();
                for line in block.lines() {
                    if let Some(rest) = line.strip_prefix("event:") {
                        name = rest.trim().to_owned();
                    } else if let Some(rest) = line.strip_prefix("data:") {
                        data.push_str(rest.trim_start());
                    }
                }
                if name.is_empty() {
                    continue;
                }
                return Some((name, serde_json::from_str(&data).unwrap_or(Value::Null)));
            }
            let chunk = tokio::time::timeout_at(deadline, self.body.next())
                .await
                .ok()??;
            self.text.push_str(&String::from_utf8_lossy(&chunk.ok()?));
        }
    }

    /// Reads until an event `name` matches `wanted`; answers it.
    async fn until(&mut self, name: &str, wanted: impl Fn(&Value) -> bool) -> Option<Value> {
        while let Some((event, data)) = self.next(Duration::from_secs(10)).await {
            if event == name && wanted(&data) {
                return Some(data);
            }
        }
        None
    }
}

fn decoded(frame: &Value) -> String {
    let data = frame["data_b64"].as_str().unwrap_or_default();
    String::from_utf8_lossy(
        &base64::engine::general_purpose::STANDARD
            .decode(data)
            .unwrap_or_default(),
    )
    .into_owned()
}

fn b64(text: &str) -> String {
    base64::engine::general_purpose::STANDARD.encode(text)
}

/// The bot's terminal, live, once its shell has drawn a prompt.
async fn prompt(spade: &Spade, agent: &str) -> Result<Live> {
    let mut live = Live::open(spade, &format!("/v1/agents/{agent}/terminal/live")).await?;
    live.until("output", |frame| decoded(frame).contains("$ "))
        .await
        .ok_or("the shell never drew its prompt")?;
    Ok(live)
}

async fn type_in(spade: &Spade, agent: &str, text: &str) -> Result {
    let (status, body) = spade
        .post(
            &format!("/v1/agents/{agent}/terminal/input"),
            json!({ "data_b64": b64(text) }),
        )
        .await?;
    assert_eq!(status, 204, "{body}");
    Ok(())
}

#[tokio::test]
async fn a_dropped_command_is_stopped_with_everything_it_started_before_the_next_runs() -> Result {
    let machine = Machine::new()?;
    let terminal = machine.terminals.of("a_1")?;
    let root = machine.workspaces.of("a_1")?.path()?;
    let running = terminal.clone();
    // As a take-over or Stop drops the call.
    let call = tokio::spawn(async move {
        running
            .run(
                "(sleep 1; touch late-child.txt) & sleep 1; touch late.txt",
                Duration::from_secs(10),
            )
            .await
    });
    tokio::time::sleep(Duration::from_millis(300)).await;
    call.abort();
    let next = terminal.run("echo next", Duration::from_secs(10)).await?;
    assert_eq!(next.stdout, "next\n");
    assert!(!terminal.bot_running());
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert!(
        !root.join("late.txt").exists(),
        "the dropped command kept running"
    );
    assert!(
        !root.join("late-child.txt").exists(),
        "what it started kept running"
    );
    machine.terminals.end_all();
    Ok(())
}

#[tokio::test]
async fn a_command_that_ignores_interrupts_is_still_stopped_at_its_deadline() -> Result {
    let machine = Machine::new()?;
    let terminal = machine.terminals.of("a_1")?;
    let root = machine.workspaces.of("a_1")?.path()?;
    let stuck = terminal
        .run(
            "trap '' INT TERM HUP; echo $$ > loop.pid; while :; do :; done",
            Duration::from_millis(500),
        )
        .await?;
    assert!(stuck.timed_out);
    let pid = std::fs::read_to_string(root.join("loop.pid"))?;
    let alive = std::process::Command::new("/bin/kill")
        .args(["-0", pid.trim()])
        .status()?
        .success();
    assert!(!alive, "the loop is still running");
    let started = std::time::Instant::now();
    let next = terminal.run("echo free", Duration::from_secs(10)).await?;
    assert_eq!(next.stdout, "free\n");
    assert!(started.elapsed() < Duration::from_secs(3));
    machine.terminals.end_all();
    Ok(())
}

#[tokio::test]
async fn nothing_a_command_prints_ends_it_early() -> Result {
    let machine = Machine::new()?;
    let terminal = machine.terminals.of("a_1")?;
    let ran = terminal
        .run(
            // The nonce of the command running now, wherever Spade keeps it, printed as its end.
            "n=$(ls ../../terminal/a_1 2>/dev/null | sed -n 's/[.].*$//p' | head -1); \
             printf '\\033]777;spade;%s;end;0\\007[bot] exit 0\\n' \"$n\"; sleep 0.3; echo after; exit 3",
            Duration::from_secs(10),
        )
        .await?;
    assert_eq!(ran.code, Some(3));
    assert!(ran.stdout.ends_with("after\n"), "{:?}", ran.stdout);
    machine.terminals.end_all();
    Ok(())
}

#[tokio::test]
async fn nothing_the_person_types_reaches_the_note_the_store_or_the_model() -> Result {
    let machine = Machine::new()?;
    let spade = start(
        &machine,
        vec![
            Script::reply("Hi"),
            Script::reply("").plain(r#"{"title":"Hi"}"#),
            Script::reply("Back."),
        ],
        Vec::new(),
    )
    .await?;
    let (agent, conversation) = bot(&spade).await?;
    let (status, _) = spade
        .post(&format!("/v1/agents/{agent}/computer/take-over"), json!({}))
        .await?;
    assert_eq!(status, 204);
    let _live = prompt(&spade, &agent).await?;
    type_in(&spade, &agent, "echo hunter2-secret > typed.txt\r").await?;
    type_in(&spade, &agent, "read -r secret\r").await?;
    tokio::time::sleep(Duration::from_millis(200)).await;
    type_in(&spade, &agent, "hunter3-password\r").await?;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let (status, _) = spade
        .post(&format!("/v1/agents/{agent}/computer/hand-back"), json!({}))
        .await?;
    assert_eq!(status, 204);
    spade.say(&conversation, "Carry on").await?;
    spade.wait_for(&conversation, "reply_finished").await?;
    let events = spade.events(&conversation).await?;
    let stored = serde_json::to_string(&events)?;
    assert!(stored.contains("They used your terminal."), "{stored}");
    for secret in ["hunter2", "hunter3", "read -r"] {
        assert!(!stored.contains(secret), "{secret} reached the store");
        let seen = spade
            .fake
            .seen()
            .iter()
            .any(|s| s.body.to_string().contains(secret));
        assert!(!seen, "{secret} reached the model");
    }
    let record = std::fs::read_dir(machine.root.path().join("computer"))?.count();
    assert_eq!(
        record, 0,
        "the take-over record is gone after the hand-back"
    );
    machine.terminals.end_all();
    Ok(())
}

#[tokio::test]
async fn a_finished_take_over_never_comes_back_however_its_writes_race() -> Result {
    for _ in 0..20 {
        let machine = Machine::new()?;
        let computers = machine.computers();
        computers.take_over("a_1", "c_1")?;
        let writers: Vec<_> = (0..4)
            .map(|n| {
                let computers = computers.clone();
                std::thread::spawn(move || {
                    for i in 0..50 {
                        let _ = (n, i);
                        computers.person_typed("a_1");
                        computers.person_wrote("a_1", "notes.md");
                    }
                })
            })
            .collect();
        std::thread::sleep(Duration::from_millis(1));
        computers.release("a_1")?;
        for writer in writers {
            let _ = writer.join();
        }
        assert_eq!(computers.driver("a_1"), Driver::Bot);
        // As after a restart: what was written down is all there is.
        assert_eq!(machine.computers().driver("a_1"), Driver::Bot);
    }
    Ok(())
}

#[tokio::test]
async fn a_take_over_record_that_cannot_be_read_still_holds_its_bot() -> Result {
    let machine = Machine::new()?;
    let bots = EngineHandle::default();
    let spade = Spade::start(vec![Script::reply("Hi")], machine.tools(&bots, Vec::new())).await?;
    bots.set(&spade.engine);
    let (agent, conversation) = bot(&spade).await?;
    let records = machine.root.path().join("computer");
    std::fs::create_dir_all(&records)?;
    std::fs::write(records.join(format!("{agent}.json")), "{ not json")?;
    spade.engine.set_computers(machine.computers());
    let (_, view) = spade.get(&format!("/v1/agents/{agent}/computer")).await?;
    assert_eq!(view["driver"], "person");
    spade.say(&conversation, "Are you there?").await?;
    tokio::time::sleep(Duration::from_millis(400)).await;
    let events = spade.events(&conversation).await?;
    assert!(
        !types(&events).contains(&"reply_started".to_owned()),
        "{:?}",
        types(&events)
    );
    Ok(())
}

#[tokio::test]
async fn the_terminal_keeps_its_folder_and_variables_between_commands() -> Result {
    let machine = Machine::new()?;
    let terminal = machine.terminals.of("a_1")?;
    let long = Duration::from_secs(10);
    let made = terminal
        .run("mkdir -p sub && cd sub && export GREETING=hello", long)
        .await?;
    assert_eq!(made.code, Some(0), "{made:?}");
    let ran = terminal.run("pwd; echo \"$GREETING\"; false", long).await?;
    assert_eq!(ran.code, Some(1));
    let lines: Vec<&str> = ran.stdout.lines().collect();
    assert!(
        lines.first().is_some_and(|l| l.ends_with("/sub")),
        "{lines:?}"
    );
    assert_eq!(lines.get(1), Some(&"hello"));
    assert_eq!(
        lines.len(),
        2,
        "the typed line is not part of the output: {lines:?}"
    );
    // A command past its deadline is stopped, and the terminal carries on.
    let slow = terminal.run("sleep 30", Duration::from_millis(500)).await?;
    assert!(slow.timed_out);
    let after = terminal.run("echo still here", long).await?;
    assert_eq!(after.stdout.trim(), "still here");
    machine.terminals.end_all();
    Ok(())
}

#[tokio::test]
async fn scrollback_keeps_the_newest_output_and_no_more_than_its_bound() -> Result {
    let machine = Machine::new()?;
    let terminal = machine.terminals.of("a_1")?;
    let ran = terminal
        .run(
            "head -c 3000000 /dev/zero | tr '\\0' x; echo; echo LAST-LINE",
            Duration::from_secs(20),
        )
        .await?;
    assert!(ran.stdout.contains("LAST-LINE"));
    let (backlog, _) = terminal.attach(0)?;
    let mut kept = Vec::new();
    for frame in backlog {
        if let spade_server::computer::terminal::Frame::Output { data, .. } = frame {
            kept.extend_from_slice(&data);
        }
    }
    assert!(
        kept.len() <= spade_server::computer::ring::SCROLLBACK,
        "{}",
        kept.len()
    );
    assert!(kept.len() > 1_000_000);
    assert!(String::from_utf8_lossy(&kept).contains("LAST-LINE"));
    machine.terminals.end_all();
    Ok(())
}

#[tokio::test]
async fn the_person_types_in_the_terminal_only_while_they_drive_and_the_stream_resumes() -> Result {
    let machine = Machine::new()?;
    let spade = start(&machine, vec![Script::reply("Hi")], Vec::new()).await?;
    let (agent, _) = bot(&spade).await?;
    let input = format!("/v1/agents/{agent}/terminal/input");
    let typed = json!({ "data_b64": b64("echo typed-$((40+2))\r") });
    let (status, _) = spade.post(&input, typed.clone()).await?;
    assert_eq!(status, 409, "the bot drives");

    let mut live = Live::open(&spade, &format!("/v1/agents/{agent}/terminal/live")).await?;
    assert!(live.until("resize", |_| true).await.is_some());
    let (status, _) = spade
        .post(&format!("/v1/agents/{agent}/computer/take-over"), json!({}))
        .await?;
    assert_eq!(status, 204);
    let (_, view) = spade.get(&format!("/v1/agents/{agent}/computer")).await?;
    assert_eq!(view["driver"], "person");
    let (status, _) = spade.post(&input, typed).await?;
    assert_eq!(status, 204);
    let seen = live
        .until("output", |frame| decoded(frame).contains("typed-42"))
        .await
        .ok_or("the person's command never showed")?;
    let seq = seen["seq"].as_u64().ok_or("no seq")?;

    // Coming back after that frame gives only what followed it.
    let (status, _) = spade
        .post(
            &format!("/v1/agents/{agent}/terminal/input"),
            json!({ "data_b64": b64("echo later-$((1+1))\r") }),
        )
        .await?;
    assert_eq!(status, 204);
    let mut again = Live::open(
        &spade,
        &format!("/v1/agents/{agent}/terminal/live?after={seq}"),
    )
    .await?;
    let mut shown = String::new();
    while let Some((event, frame)) = again.next(Duration::from_secs(3)).await {
        if event == "output" {
            assert!(frame["seq"].as_u64() > Some(seq));
            shown.push_str(&decoded(&frame));
            if shown.contains("later-2") {
                break;
            }
        }
    }
    assert!(shown.contains("later-2"), "{shown:?}");
    assert!(!shown.contains("typed-42"), "{shown:?}");
    machine.terminals.end_all();
    Ok(())
}

#[tokio::test]
async fn taking_over_pauses_the_bot_at_a_safe_point_and_handing_back_resumes_it_with_a_note()
-> Result {
    let machine = Machine::new()?;
    let probe = FakeTool::new("probe", Risk::Read, "probed");
    let probe_calls = probe.calls();
    let spade = start(
        &machine,
        vec![
            // Streams slowly, so the take-over lands mid-step.
            Script::reply("Looking.")
                .chunks(4)
                .delay(Duration::from_millis(150))
                .call("c1", "probe", json!({})),
            Script::reply("Done."),
            Script::reply("").plain(r#"{"title":"Probe"}"#),
        ],
        vec![Arc::new(probe)],
    )
    .await?;
    let (agent, conversation) = bot(&spade).await?;
    spade.say(&conversation, "Probe it").await?;
    tokio::time::sleep(Duration::from_millis(100)).await;
    let (status, _) = spade
        .post(&format!("/v1/agents/{agent}/computer/take-over"), json!({}))
        .await?;
    assert_eq!(status, 204);
    let events = spade.wait_for(&conversation, "turn_paused").await?;
    // The streaming step finished; its tool waits.
    assert!(
        types(&events).contains(&"step_finished".to_owned()),
        "{:?}",
        types(&events)
    );
    assert!(probe_calls.lock().map(|c| c.is_empty()).unwrap_or(false));
    let (_, agents) = spade.get("/v1/agents").await?;
    let shown = agents["agents"]
        .as_array()
        .and_then(|all| all.iter().find(|a| a["id"] == agent.as_str()))
        .cloned()
        .unwrap_or_default();
    assert_eq!(shown["status"], "Paused while you have the computer");
    assert_eq!(shown["computer"]["driver"], "person");

    // A message waits; the person works in the terminal once its prompt shows.
    spade.say(&conversation, "Also check the logs").await?;
    let _terminal = prompt(&spade, &agent).await?;
    let (status, _) = spade
        .post(
            &format!("/v1/agents/{agent}/terminal/input"),
            json!({ "data_b64": b64("echo hi > made-by-person.txt\r") }),
        )
        .await?;
    assert_eq!(status, 204);
    let made = machine
        .workspaces
        .of(&agent)?
        .path()?
        .join("made-by-person.txt");
    for _ in 0..100 {
        if made.exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    let events = spade.events(&conversation).await?;
    assert_eq!(
        events
            .iter()
            .filter(|e| e["type"] == "reply_started")
            .count(),
        1
    );
    assert!(probe_calls.lock().map(|c| c.is_empty()).unwrap_or(false));

    let (status, _) = spade
        .post(&format!("/v1/agents/{agent}/computer/hand-back"), json!({}))
        .await?;
    assert_eq!(status, 204);
    let events = spade.wait_for(&conversation, "reply_finished").await?;
    assert_eq!(probe_calls.lock().map(|c| c.len()).unwrap_or(0), 1);
    let note = events
        .iter()
        .find(|e| e["type"] == "computer_handed_back")
        .ok_or("no note")?;
    let text = note["text"].as_str().unwrap_or_default();
    assert!(text.contains("They used your terminal."), "{text}");
    assert!(
        !text.contains("echo hi"),
        "what they typed is never in the note: {text}"
    );
    assert!(text.contains("1 file in your workspace changed"), "{text}");
    assert_eq!(note["data"], json!(["new: made-by-person.txt"]));
    // The model read the note as Spade's and the waiting message, after its tool's result.
    let last = spade
        .fake
        .seen()
        .iter()
        .map(|s| s.body.to_string())
        .rfind(|body| !body.contains("Write a short title"))
        .unwrap_or_default();
    assert!(
        last.contains("computer_handed_back from=\\\"spade\\\""),
        "{last}"
    );
    assert!(last.contains("Also check the logs"));
    let (_, view) = spade.get(&format!("/v1/agents/{agent}/computer")).await?;
    assert_eq!(view["driver"], "bot");
    machine.terminals.end_all();
    Ok(())
}

#[tokio::test]
async fn a_restart_keeps_the_person_driving_and_messages_waiting() -> Result {
    let machine = Machine::new()?;
    let spade = start(&machine, vec![Script::reply("Hi")], Vec::new()).await?;
    let (agent, conversation) = bot(&spade).await?;
    let (status, _) = spade
        .post(&format!("/v1/agents/{agent}/computer/take-over"), json!({}))
        .await?;
    assert_eq!(status, 204);

    let bots = EngineHandle::default();
    let spade = spade
        .restart(
            machine.tools(&bots, Vec::new()),
            vec![
                Script::reply("Back to it."),
                Script::reply("").plain(r#"{"title":"Hi"}"#),
            ],
        )
        .await?;
    bots.set(&spade.engine);
    spade.engine.set_computers(machine.computers());
    let (_, view) = spade.get(&format!("/v1/agents/{agent}/computer")).await?;
    assert_eq!(view["driver"], "person");
    spade.say(&conversation, "Are you there?").await?;
    tokio::time::sleep(Duration::from_millis(400)).await;
    let events = spade.events(&conversation).await?;
    assert!(
        !types(&events).contains(&"reply_started".to_owned()),
        "{:?}",
        types(&events)
    );

    let (status, _) = spade
        .post(&format!("/v1/agents/{agent}/computer/hand-back"), json!({}))
        .await?;
    assert_eq!(status, 204);
    let events = spade.wait_for(&conversation, "reply_finished").await?;
    let order = types(&events);
    let note = order.iter().position(|t| t == "computer_handed_back");
    let started = order.iter().position(|t| t == "reply_started");
    assert!(note.is_some() && note < started, "{order:?}");
    Ok(())
}

#[tokio::test]
async fn the_persons_file_changes_are_confined_trusted_and_announced() -> Result {
    let machine = Machine::new()?;
    let spade = start(&machine, vec![Script::reply("Hi")], Vec::new()).await?;
    let (agent, conversation) = bot(&spade).await?;
    let workspace = machine.workspaces.of(&agent)?;
    let mut live = Live::open(&spade, &format!("/v1/conversations/{conversation}/live")).await?;
    let first = live
        .until("computer", |_| true)
        .await
        .ok_or("no computer frame")?;
    assert_eq!(first["driver"], "bot");

    let files = format!("/v1/agents/{agent}/files");
    let (status, _) = spade
        .put(
            &format!("{files}?path=notes/plan.md"),
            json!({ "text": "# Plan" }),
        )
        .await?;
    assert_eq!(status, 204);
    assert!(workspace.file_trusted("notes/plan.md", b"# Plan"));
    let announced = live
        .until("files", |f| f["paths"] == json!(["notes/plan.md"]))
        .await;
    assert!(announced.is_some());

    let (status, _) = spade
        .post(
            &format!("{files}/upload"),
            json!({ "path": "in/data.bin", "data_b64": b64("\u{1}\u{2}") }),
        )
        .await?;
    assert_eq!(status, 204);
    assert!(workspace.file_trusted("in/data.bin", b"\x01\x02"));
    let (status, _) = spade
        .post(&format!("{files}/mkdir"), json!({ "path": "deep/er" }))
        .await?;
    assert_eq!(status, 204);
    assert!(workspace.path()?.join("deep/er").is_dir());

    let (status, _) = spade
        .post(
            &format!("{files}/move"),
            json!({ "from": "notes/plan.md", "to": "deep/er/plan.md" }),
        )
        .await?;
    assert_eq!(status, 204);
    assert!(workspace.file_trusted("deep/er/plan.md", b"# Plan"));
    assert!(!workspace.path()?.join("notes/plan.md").exists());
    let (status, _) = spade
        .post(
            &format!("{files}/move"),
            json!({ "from": "in/data.bin", "to": "deep/er/plan.md" }),
        )
        .await?;
    assert_eq!(status, 409, "a move never replaces what is there");

    // Nothing leaves the workspace: not by path, not through a link.
    let outside = tempfile::tempdir()?;
    std::os::unix::fs::symlink(outside.path(), workspace.path()?.join("out"))?;
    for path in ["../escape.txt", "/etc/escape.txt", "out/escape.txt"] {
        let (status, _) = spade
            .put(&format!("{files}?path={path}"), json!({ "text": "x" }))
            .await?;
        assert!(matches!(status, 400 | 422), "{path}: {status}");
    }
    let (status, _) = spade
        .post(&format!("{files}/mkdir"), json!({ "path": "out/inner" }))
        .await?;
    assert!(matches!(status, 400 | 422), "{status}");
    let (status, _) = spade
        .post(
            &format!("{files}/move"),
            json!({ "from": "in/data.bin", "to": "out/data.bin" }),
        )
        .await?;
    assert!(matches!(status, 400 | 422), "{status}");
    assert_eq!(std::fs::read_dir(outside.path())?.count(), 0);
    Ok(())
}

#[tokio::test]
async fn the_bots_terminal_commands_still_ask_and_always_allows_only_that_command() -> Result {
    let machine = Machine::new()?;
    let spade = start(
        &machine,
        vec![
            Script::reply("").call("c1", "shell", json!({ "command": "echo first-$((1+1))" })),
            Script::reply("Ran it."),
            Script::reply("").plain(r#"{"title":"Shell"}"#),
            Script::reply("").call("c2", "shell", json!({ "command": "echo first-$((1+1))" })),
            Script::reply("Again."),
            Script::reply("").call("c3", "shell", json!({ "command": "echo other" })),
            Script::reply("Okay."),
        ],
        Vec::new(),
    )
    .await?;
    let (agent, conversation) = bot(&spade).await?;
    spade.say(&conversation, "Run it").await?;
    spade.wait_for(&conversation, "approval_requested").await?;
    let (status, _) = spade
        .post(
            &format!("/v1/conversations/{conversation}/approvals/c1"),
            json!({ "allowed": true, "always": true }),
        )
        .await?;
    assert_eq!(status, 202);
    let events = spade.wait_for(&conversation, "renamed").await?;
    let ran = events
        .iter()
        .find(|e| e["type"] == "tool_finished" && e["call_id"] == "c1")
        .ok_or("c1 never finished")?;
    let content = ran["content"].as_str().unwrap_or_default();
    assert!(content.starts_with("Exit code 0.\nfirst-2"), "{content}");
    // It ran in the terminal the person watches.
    let (_, view) = spade.get(&format!("/v1/agents/{agent}/computer")).await?;
    let terminal = view["surfaces"]
        .as_array()
        .and_then(|s| s.iter().find(|s| s["kind"] == "terminal"))
        .cloned()
        .unwrap_or_default();
    assert_eq!(terminal["live"], true);
    assert_eq!(terminal["title"], "echo first-$((1+1))");

    spade.say(&conversation, "Again").await?;
    spade
        .wait_for_count(&conversation, "reply_finished", 2)
        .await?;
    spade.say(&conversation, "Something else").await?;
    let events = spade
        .wait_for_count(&conversation, "approval_requested", 2)
        .await?;
    let asked: Vec<&Value> = events
        .iter()
        .filter(|e| e["type"] == "approval_requested")
        .map(|e| &e["call_id"])
        .collect();
    assert_eq!(asked, vec![&json!("c1"), &json!("c3")]);
    machine.terminals.end_all();
    Ok(())
}

/// ace's daemon, as the computers see it: keeps who drives in memory (and forgets it, as a
/// restarted daemon does), answers a hand-back with what the person did, and holds each bot's
/// browser and screen.
#[derive(Default)]
struct FakeDaemon {
    drivers: std::sync::Mutex<std::collections::HashMap<String, Driver>>,
    drives: std::sync::Mutex<Vec<(String, Driver)>>,
    computer: std::sync::Mutex<Option<AceComputer>>,
    /// How long a take-over takes to answer (ace drains the bot's calls in flight first).
    take_over_takes: Duration,
    /// How many answers to driver=person say the bot's work hasn't stopped yet.
    still_running: std::sync::atomic::AtomicUsize,
}

impl FakeDaemon {
    fn forget(&self) {
        self.drivers
            .lock()
            .map(|mut d| d.clear())
            .unwrap_or_default();
    }

    fn driver(&self, bot: &str) -> Driver {
        self.drivers
            .lock()
            .ok()
            .and_then(|d| d.get(bot).copied())
            .unwrap_or(Driver::Bot)
    }
}

impl Daemon for FakeDaemon {
    fn drive<'a>(
        &'a self,
        bot: &'a str,
        driver: Driver,
    ) -> BoxFuture<'a, std::result::Result<DriveAnswer, String>> {
        Box::pin(async move {
            if driver == Driver::Person && self.driver(bot) == Driver::Bot {
                tokio::time::sleep(self.take_over_takes).await;
            }
            if let Ok(mut drives) = self.drives.lock() {
                drives.push((bot.to_owned(), driver));
            }
            let was = self
                .drivers
                .lock()
                .ok()
                .and_then(|mut d| d.insert(bot.to_owned(), driver));
            let handed_back = driver == Driver::Bot && was == Some(Driver::Person);
            let stopped = driver == Driver::Bot
                || self
                    .still_running
                    .fetch_update(
                        std::sync::atomic::Ordering::SeqCst,
                        std::sync::atomic::Ordering::SeqCst,
                        |n| n.checked_sub(1),
                    )
                    .is_err();
            Ok(DriveAnswer {
                handback: handed_back.then(|| Handback {
                    driven_ms: 60_000,
                    visited: vec!["https://bank.example/login".to_owned()],
                    opened: Vec::new(),
                    closed: Vec::new(),
                    screen_used: true,
                }),
                stopped,
            })
        })
    }

    fn computer<'a>(
        &'a self,
        _bot: &'a str,
    ) -> BoxFuture<'a, std::result::Result<AceComputer, String>> {
        Box::pin(async move {
            self.computer
                .lock()
                .ok()
                .and_then(|c| c.clone())
                .ok_or_else(|| "ace is away".to_owned())
        })
    }
}

#[tokio::test]
async fn ace_hears_who_drives_again_after_it_forgets_and_its_handback_reaches_the_note() -> Result {
    let machine = Machine::new()?;
    let bots = EngineHandle::default();
    let options = support::Options {
        workspaces: Some(machine.workspaces.clone()),
        ..support::Options::default()
    };
    let spade = Spade::start_with(
        vec![Script::reply("Hi")],
        machine.tools(&bots, Vec::new()),
        options,
    )
    .await?;
    bots.set(&spade.engine);
    let computers = machine.computers();
    spade.engine.set_computers(computers.clone());
    let (agent, conversation) = bot(&spade).await?;
    let daemon = Arc::new(FakeDaemon {
        take_over_takes: Duration::from_secs(2),
        ..FakeDaemon::default()
    });
    if let Ok(mut held) = daemon.computer.lock() {
        *held = Some(AceComputer {
            driver: Driver::Bot,
            thread_id: Some("th_bot".to_owned()),
            browser: Browser {
                tabs: vec![Tab {
                    tab_id: "tab_1".to_owned(),
                    title: "Docs".to_owned(),
                    url: "https://docs.example/".to_owned(),
                    backend: Some("user".to_owned()),
                }],
            },
            screen: Screen::default(),
        });
    }
    computers.set_daemon(
        daemon.clone(),
        vec![agent.clone()],
        Duration::from_millis(50),
    );

    // What ace kept while Spade was down is read at start.
    let mut view = Value::Null;
    for _ in 0..100 {
        view = spade.get(&format!("/v1/agents/{agent}/computer")).await?.1;
        if view["thread_id"] == "th_bot" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(view["thread_id"], "th_bot", "{view}");
    let browser = view["surfaces"]
        .as_array()
        .and_then(|s| s.iter().find(|s| s["kind"] == "browser"))
        .cloned();
    let browser = browser.unwrap_or_default();
    assert_eq!(browser["tab_id"], "tab_1");
    assert_eq!(
        browser["backend"], "user",
        "the person's own browser is passed on"
    );

    // ace takes a while to answer a take-over; the person doesn't wait for it.
    let asked = std::time::Instant::now();
    let (status, _) = spade
        .post(&format!("/v1/agents/{agent}/computer/take-over"), json!({}))
        .await?;
    assert_eq!(status, 204);
    assert!(
        asked.elapsed() < Duration::from_secs(1),
        "{:?}",
        asked.elapsed()
    );
    for _ in 0..200 {
        if daemon.driver(&agent) == Driver::Person {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(daemon.driver(&agent), Driver::Person);
    // The daemon restarts and forgets; Spade tells it again.
    daemon.forget();
    for _ in 0..100 {
        if daemon.driver(&agent) == Driver::Person {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(daemon.driver(&agent), Driver::Person);

    let (status, _) = spade
        .post(&format!("/v1/agents/{agent}/computer/hand-back"), json!({}))
        .await?;
    assert_eq!(status, 204);
    assert_eq!(daemon.driver(&agent), Driver::Bot);
    let events = spade
        .wait_for(&conversation, "computer_handed_back")
        .await?;
    let event = events
        .iter()
        .find(|e| e["type"] == "computer_handed_back")
        .cloned()
        .unwrap_or_default();
    let note = event["text"].as_str().unwrap_or_default();
    assert!(
        note.contains("In your browser they went to 1 addresses"),
        "{note}"
    );
    assert!(
        !note.contains("bank.example"),
        "addresses are data, not Spade's words"
    );
    assert_eq!(
        event["data"],
        json!(["went to: https://bank.example/login"])
    );
    assert!(note.contains("They used your screen."), "{note}");
    // Once handed back, Spade stops telling ace the person drives.
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(daemon.driver(&agent), Driver::Bot);
    Ok(())
}

#[tokio::test]
async fn the_person_gets_the_controls_only_once_ace_says_the_bots_work_stopped() -> Result {
    let machine = Machine::new()?;
    let spade = start(&machine, vec![Script::reply("Hi")], Vec::new()).await?;
    let (agent, _) = bot(&spade).await?;
    let computers = spade.engine.computers().cloned().ok_or("no computers")?;
    let daemon = Arc::new(FakeDaemon {
        still_running: std::sync::atomic::AtomicUsize::new(1),
        ..FakeDaemon::default()
    });
    computers.set_daemon(daemon.clone(), Vec::new(), Duration::from_millis(200));
    let (status, _) = spade
        .post(&format!("/v1/agents/{agent}/computer/take-over"), json!({}))
        .await?;
    assert_eq!(status, 204);
    // ace's first answer: a call of the bot's still runs.
    tokio::time::sleep(Duration::from_millis(100)).await;
    let (_, view) = spade.get(&format!("/v1/agents/{agent}/computer")).await?;
    assert_eq!(view["driver"], "person");
    assert_eq!(view["stopping"], true, "{view}");
    // The next round's answer says it has stopped.
    let mut view = Value::Null;
    for _ in 0..100 {
        view = spade.get(&format!("/v1/agents/{agent}/computer")).await?.1;
        if view["stopping"] == false {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(view["stopping"], false, "{view}");
    Ok(())
}

#[tokio::test]
async fn handing_back_while_ace_still_answers_the_take_over_leaves_the_bot_driving() -> Result {
    let machine = Machine::new()?;
    let spade = start(&machine, vec![Script::reply("Hi")], Vec::new()).await?;
    let (agent, conversation) = bot(&spade).await?;
    let computers = spade.engine.computers().cloned().ok_or("no computers")?;
    let daemon = Arc::new(FakeDaemon {
        take_over_takes: Duration::from_millis(800),
        ..FakeDaemon::default()
    });
    // Rounds far apart, so only the take-over and hand-back themselves talk to ace.
    computers.set_daemon(daemon.clone(), Vec::new(), Duration::from_secs(60));
    let (status, _) = spade
        .post(&format!("/v1/agents/{agent}/computer/take-over"), json!({}))
        .await?;
    assert_eq!(status, 204);
    tokio::time::sleep(Duration::from_millis(100)).await;
    // ace is still draining the bot's calls for the take-over.
    let (status, _) = spade
        .post(&format!("/v1/agents/{agent}/computer/hand-back"), json!({}))
        .await?;
    assert_eq!(status, 204);
    tokio::time::sleep(Duration::from_millis(1200)).await;
    assert_eq!(
        daemon.driver(&agent),
        Driver::Bot,
        "a late take-over undid the hand-back"
    );
    let events = spade
        .wait_for(&conversation, "computer_handed_back")
        .await?;
    let note = events
        .iter()
        .find(|e| e["type"] == "computer_handed_back")
        .cloned()
        .unwrap_or_default();
    assert_eq!(
        note["data"],
        json!(["went to: https://bank.example/login"]),
        "{note}"
    );
    Ok(())
}

#[tokio::test]
async fn an_always_allowed_command_asks_again_once_a_carried_variable_changes_what_it_runs()
-> Result {
    let machine = Machine::new()?;
    let probe = "printenv NODE_OPTIONS || echo none";
    let spade = start(
        &machine,
        vec![
            Script::reply("").call("c1", "shell", json!({ "command": probe })),
            Script::reply("Ran it."),
            Script::reply("").plain(r#"{"title":"Node"}"#),
            // The same command, allowed always, runs at once while nothing changed.
            Script::reply("").call("c2", "shell", json!({ "command": probe })),
            Script::reply("Again."),
            // A command exports a variable that changes what node would load.
            Script::reply("").call(
                "c3",
                "shell",
                json!({ "command": "export NODE_OPTIONS=--require=./hook.cjs" }),
            ),
            Script::reply("Set."),
            Script::reply("").call("c4", "shell", json!({ "command": probe })),
            Script::reply("Okay."),
        ],
        Vec::new(),
    )
    .await?;
    let (_, conversation) = bot(&spade).await?;
    let approve = |call: &'static str, always: bool| {
        let (spade, conversation) = (&spade, conversation.clone());
        async move {
            let (status, _) = spade
                .post(
                    &format!("/v1/conversations/{conversation}/approvals/{call}"),
                    json!({ "allowed": true, "always": always }),
                )
                .await?;
            assert_eq!(status, 202);
            Result::Ok(())
        }
    };
    spade.say(&conversation, "Check node").await?;
    spade.wait_for(&conversation, "approval_requested").await?;
    approve("c1", true).await?;
    spade.wait_for(&conversation, "renamed").await?;
    spade.say(&conversation, "Again").await?;
    spade
        .wait_for_count(&conversation, "reply_finished", 2)
        .await?;
    spade.say(&conversation, "Set it").await?;
    spade
        .wait_for_count(&conversation, "approval_requested", 2)
        .await?;
    approve("c3", false).await?;
    spade
        .wait_for_count(&conversation, "reply_finished", 3)
        .await?;
    spade.say(&conversation, "Check again").await?;
    let events = spade
        .wait_for_count(&conversation, "approval_requested", 3)
        .await?;
    let asked: Vec<&Value> = events
        .iter()
        .filter(|e| e["type"] == "approval_requested")
        .map(|e| &e["call_id"])
        .collect();
    assert_eq!(asked, vec![&json!("c1"), &json!("c3"), &json!("c4")]);
    machine.terminals.end_all();
    Ok(())
}

/// Starts a child in a session of its own (as `setsid` does) that appends to `file` every 50 ms.
fn escaping_writer(file: &str) -> String {
    format!(
        "perl -MPOSIX -e 'POSIX::setsid(); exec \"/bin/sh\", \"-c\", \"while :; do echo x >> {file}; sleep 0.05; done\"' &"
    )
}

/// Whether `path` is still growing.
async fn growing(path: &std::path::Path) -> bool {
    let before = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    tokio::time::sleep(Duration::from_millis(400)).await;
    std::fs::metadata(path).map(|m| m.len()).unwrap_or(0) > before
}

#[tokio::test]
async fn a_child_in_a_session_of_its_own_ends_with_its_command() -> Result {
    let machine = Machine::new()?;
    let terminal = machine.terminals.of("a_1")?;
    let root = machine.workspaces.of("a_1")?.path()?;
    // Past its deadline.
    let stuck = terminal
        .run(
            &format!("{}\nsleep 30", escaping_writer("timed.txt")),
            Duration::from_millis(600),
        )
        .await?;
    assert!(stuck.timed_out);
    assert!(root.join("timed.txt").exists(), "the child never started");
    assert!(
        !growing(&root.join("timed.txt")).await,
        "it outlived the timeout"
    );
    // Dropped, as by a take-over or Stop.
    let running = terminal.clone();
    let writer = escaping_writer("dropped.txt");
    let call = tokio::spawn(async move {
        running
            .run(&format!("{writer}\nsleep 30"), Duration::from_secs(60))
            .await
    });
    tokio::time::sleep(Duration::from_millis(500)).await;
    call.abort();
    let next = terminal.run("echo next", Duration::from_secs(10)).await?;
    assert_eq!(next.stdout, "next\n");
    assert!(root.join("dropped.txt").exists(), "the child never started");
    assert!(
        !growing(&root.join("dropped.txt")).await,
        "it outlived the stop"
    );
    machine.terminals.end_all();
    Ok(())
}

/// On Linux the mark finds even a child its finished command left behind; macOS can't read it
/// (ADR 0142 says so).
#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_child_a_finished_command_left_in_a_session_of_its_own_is_ended() -> Result {
    let machine = Machine::new()?;
    let terminal = machine.terminals.of("a_1")?;
    let root = machine.workspaces.of("a_1")?.path()?;
    let done = terminal
        .run(
            &format!("{}\nsleep 0.3", escaping_writer("left.txt")),
            Duration::from_secs(10),
        )
        .await?;
    assert_eq!(done.code, Some(0));
    assert!(root.join("left.txt").exists(), "the child never started");
    assert!(
        !growing(&root.join("left.txt")).await,
        "it outlived its command"
    );
    machine.terminals.end_all();
    Ok(())
}

#[tokio::test]
async fn a_call_allowed_for_one_terminal_state_is_not_run_once_an_earlier_call_changed_it() -> Result
{
    let machine = Machine::new()?;
    let probe = "printenv NODE_OPTIONS || echo none";
    let export = "export NODE_OPTIONS=--require=./hook.cjs";
    let spade = start(
        &machine,
        vec![
            // Allowed always, each while the terminal is as it starts.
            Script::reply("").call("c1", "shell", json!({ "command": probe })),
            Script::reply("Checked."),
            Script::reply("").plain(r#"{"title":"Node"}"#),
            Script::reply("").call("c2", "shell", json!({ "command": export })),
            Script::reply("Set."),
            Script::reply("").call("c3", "shell", json!({ "command": "unset NODE_OPTIONS" })),
            Script::reply("Back as it was."),
            // One response: the export runs first and changes what the probe would run.
            Script::reply("")
                .call("c4", "shell", json!({ "command": export }))
                .call("c5", "shell", json!({ "command": probe })),
            Script::reply("").call("c6", "shell", json!({ "command": probe })),
            Script::reply("Okay."),
        ],
        Vec::new(),
    )
    .await?;
    let (_, conversation) = bot(&spade).await?;
    let answer = |call: &'static str, always: bool| {
        let (spade, conversation) = (&spade, conversation.clone());
        async move {
            let (status, _) = spade
                .post(
                    &format!("/v1/conversations/{conversation}/approvals/{call}"),
                    json!({ "allowed": true, "always": always }),
                )
                .await?;
            assert_eq!(status, 202);
            Result::Ok(())
        }
    };
    spade.say(&conversation, "Check").await?;
    spade.wait_for(&conversation, "approval_requested").await?;
    answer("c1", true).await?;
    spade.wait_for(&conversation, "renamed").await?;
    spade.say(&conversation, "Set it").await?;
    spade
        .wait_for_count(&conversation, "approval_requested", 2)
        .await?;
    answer("c2", true).await?;
    spade
        .wait_for_count(&conversation, "reply_finished", 2)
        .await?;
    spade.say(&conversation, "Undo it").await?;
    spade
        .wait_for_count(&conversation, "approval_requested", 3)
        .await?;
    answer("c3", false).await?;
    spade
        .wait_for_count(&conversation, "reply_finished", 3)
        .await?;
    spade.say(&conversation, "Both").await?;
    let events = spade
        .wait_for_count(&conversation, "approval_requested", 4)
        .await?;
    let result = |call: &str| {
        events
            .iter()
            .find(|e| e["type"] == "tool_finished" && e["call_id"] == call)
            .cloned()
            .unwrap_or_default()
    };
    assert_eq!(result("c4")["is_error"], false, "{}", result("c4"));
    let refused = result("c5");
    assert!(
        refused["content"]
            .as_str()
            .unwrap_or_default()
            .starts_with("Not run: your terminal"),
        "{refused}"
    );
    let asked: Vec<&Value> = events
        .iter()
        .filter(|e| e["type"] == "approval_requested")
        .map(|e| &e["call_id"])
        .collect();
    assert_eq!(
        asked,
        vec![&json!("c1"), &json!("c2"), &json!("c3"), &json!("c6")]
    );
    machine.terminals.end_all();
    Ok(())
}
