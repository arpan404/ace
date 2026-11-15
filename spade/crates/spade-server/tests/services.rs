//! Owned services and the waits that need real edges (ADR 0160), with small real child
//! processes, a real file and a real local HTTP server: a service outlives its call, wakes a bot
//! waiting on its line or its exit, is stopped with its whole group, and starts again after a
//! restart only when marked `keep`; a file wait fires on the OS's file event; a URL wait on a
//! loopback server answering. Process tests: each starts real shells.

#![cfg(unix)]

mod support;

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use spade_server::clock::Ids;
use spade_server::services::Services;
use spade_server::tools::{EngineHandle, Tool, service_tools};
use spade_server::workspace::Workspaces;
use spade_server::workspace::shell::Shell;
use spade_testkit::Script;
use support::{Options, Result, Spade};

fn title() -> Script {
    Script::reply("").plain(r#"{"title":"Dev server"}"#)
}

/// Who reviews the bot's held calls (ADR 0163).
#[derive(Clone, Copy)]
enum Reviewer {
    /// The fake model, answering in script order: each `service_start` step is followed by an
    /// [`approve`] script.
    Fake,
    /// One that can't be reached, so the person is asked.
    Unreachable,
}

/// The reviewer's approval of the step before it.
fn approve() -> Script {
    Script::reply("").plain(r#"{"verdict":"approve","reason":"Starts its own service."}"#)
}

fn options(workspaces: &Workspaces, reviewer: Reviewer) -> Options {
    Options {
        workspaces: Some(workspaces.clone()),
        reviewer: match reviewer {
            Reviewer::Fake => None,
            Reviewer::Unreachable => Some(support::UNREACHABLE_REVIEWER.to_owned()),
        },
        ..Options::default()
    }
}

/// Spade with the service tools on `workspaces`; the services, for the test to stop as Spade does.
async fn start(
    scripts: Vec<Script>,
    workspaces: &Workspaces,
    reviewer: Reviewer,
) -> Result<(Spade, Arc<Services>)> {
    start_on(scripts, options(workspaces, reviewer)).await
}

/// [`start`] with `options`.
async fn start_on(scripts: Vec<Script>, options: Options) -> Result<(Spade, Arc<Services>)> {
    let workspaces = options.workspaces.clone().ok_or("no workspaces")?;
    let bots = EngineHandle::default();
    let services = Services::new(workspaces, Shell::system(), bots.clone());
    let tools: Vec<Arc<dyn Tool>> = service_tools(&services);
    let spade = Spade::start_with(scripts, tools, options).await?;
    bots.set(&spade.engine);
    spade.engine.set_services(services.clone());
    Ok((spade, services))
}

struct Bot {
    id: String,
    conversation: String,
    folder: PathBuf,
}

async fn told(spade: &Spade, workspaces: &Workspaces, text: &str) -> Result<Bot> {
    let agent = spade.new_agent("Runner", "").await?;
    let field = |name: &str| agent[name].as_str().unwrap_or_default().to_owned();
    let (id, conversation) = (field("id"), field("conversation"));
    let folder = workspaces.of(&id)?.path()?;
    spade.say(&conversation, text).await?;
    spade.wait_for(&conversation, "reply_finished").await?;
    Ok(Bot {
        id,
        conversation,
        folder,
    })
}

fn last_prompt(spade: &Spade) -> String {
    spade
        .fake
        .seen()
        .iter()
        .rev()
        .find(|s| s.body["stream"] == true)
        .map(|s| s.body["messages"].to_string())
        .unwrap_or_default()
}

fn alive(pid: &str) -> bool {
    std::process::Command::new("kill")
        .args(["-0", pid.trim()])
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

async fn eventually(what: &str, check: impl Fn() -> bool) -> Result {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !check() {
        if Instant::now() > deadline {
            return Err(format!("never: {what}").into());
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    Ok(())
}

async fn services_of(spade: &Spade, bot: &Bot) -> Result<Vec<Value>> {
    let (_, body) = spade
        .get(&format!("/v1/agents/{}/services", bot.id))
        .await?;
    Ok(body["services"].as_array().cloned().unwrap_or_default())
}

#[tokio::test]
async fn a_service_outlives_its_call_wakes_the_bot_on_its_line_and_stops_with_its_group() -> Result
{
    let dir = tempfile::tempdir()?;
    let workspaces = Workspaces::new(dir.path());
    let command = "echo $$ > pid.txt; echo starting; sleep 1; echo 'ready on 3000'; exec sleep 60";
    let (spade, _services) = start(
        vec![
            Script::reply("").call(
                "s1",
                "service_start",
                json!({ "name": "web", "command": command }),
            ),
            approve(),
            Script::reply("").call(
                "s2",
                "wait_for",
                json!({ "condition": { "kind": "service_line", "service": "web",
                                       "pattern": "ready on \\d+" },
                        "reason": "the dev server" }),
            ),
            Script::reply("Waiting for the server."),
            title(),
            Script::reply("The server is up."),
        ],
        &workspaces,
        Reviewer::Fake,
    )
    .await?;
    let bot = told(&spade, &workspaces, "Start the dev server").await?;
    let events = spade
        .wait_for_count(&bot.conversation, "reply_finished", 2)
        .await?;
    let fired = events
        .iter()
        .find(|e| e["type"] == "wake_fired")
        .cloned()
        .unwrap_or_default();
    assert_eq!(fired["data"], json!(["ready on 3000"]));
    let prompt = last_prompt(&spade);
    assert!(
        prompt.contains("service web printed a matching line"),
        "{prompt}"
    );
    assert!(
        prompt.contains("<wake_data untrusted=\\\"true\\\">"),
        "{prompt}"
    );

    // The turns are over and it still runs, its output kept.
    let listed = services_of(&spade, &bot).await?;
    assert_eq!(listed[0]["name"], "web");
    assert_eq!(listed[0]["state"], "running");
    let (_, logs) = spade
        .get(&format!("/v1/agents/{}/services/web/logs", bot.id))
        .await?;
    let lines: Vec<&str> = logs["lines"]
        .as_array()
        .map(|l| l.iter().filter_map(|l| l["text"].as_str()).collect())
        .unwrap_or_default();
    assert_eq!(lines, ["starting", "ready on 3000"]);
    let pid = std::fs::read_to_string(bot.folder.join("pid.txt"))?;
    assert!(alive(&pid));
    let shown = spade.get("/v1/agents").await?.1;
    let row = shown["agents"]
        .as_array()
        .and_then(|a| a.iter().find(|a| a["id"] == bot.id.as_str()).cloned())
        .unwrap_or_default();
    assert_eq!(
        row["state"], "idle",
        "a running service is not work in progress"
    );
    assert_eq!(row["services"], 1);

    let (status, _) = spade
        .post(
            &format!("/v1/conversations/{}/stop", bot.conversation),
            json!({}),
        )
        .await?;
    assert!(status < 300);
    eventually("the service's process ended", || !alive(&pid)).await?;
    assert_eq!(services_of(&spade, &bot).await?[0]["state"], "stopped");
    Ok(())
}

#[tokio::test]
async fn a_service_that_exits_wakes_the_bot_waiting_on_its_exit_with_its_code() -> Result {
    let dir = tempfile::tempdir()?;
    let workspaces = Workspaces::new(dir.path());
    let (spade, _services) = start(
        vec![
            Script::reply("").call(
                "s1",
                "service_start",
                json!({ "name": "build", "command": "sleep 1; exit 3" }),
            ),
            approve(),
            Script::reply("").call(
                "s2",
                "wait_for",
                json!({ "condition": { "kind": "service_exit", "service": "build" },
                        "reason": "the build" }),
            ),
            Script::reply("Waiting."),
            title(),
            Script::reply("The build failed."),
        ],
        &workspaces,
        Reviewer::Fake,
    )
    .await?;
    let bot = told(&spade, &workspaces, "Build it").await?;
    spade
        .wait_for_count(&bot.conversation, "reply_finished", 2)
        .await?;
    assert!(last_prompt(&spade).contains("service build exited with code 3"));
    let listed = services_of(&spade, &bot).await?;
    assert_eq!(listed[0]["state"], "exited");
    assert_eq!(listed[0]["exit_code"], 3);
    Ok(())
}

#[tokio::test]
async fn only_a_service_marked_keep_starts_again_after_a_restart() -> Result {
    let dir = tempfile::tempdir()?;
    let workspaces = Workspaces::new(dir.path());
    let (spade, services) = start(
        vec![
            Script::reply("")
                .call(
                    "s1",
                    "service_start",
                    json!({ "name": "keeper", "command": "exec sleep 60", "keep": true }),
                )
                .call(
                    "s2",
                    "service_start",
                    json!({ "name": "temp", "command": "exec sleep 60" }),
                ),
            approve(),
            approve(),
            Script::reply("Started both."),
            title(),
        ],
        &workspaces,
        Reviewer::Fake,
    )
    .await?;
    let bot = told(&spade, &workspaces, "Start both").await?;
    // Spade closes: its processes go with it.
    services.stop_everything();
    let bots = EngineHandle::default();
    let again = Services::new(workspaces.clone(), Shell::system(), bots.clone());
    let spade = spade
        .restart_with(
            service_tools(&again),
            Vec::new(),
            options(&workspaces, Reviewer::Fake),
        )
        .await?;
    bots.set(&spade.engine);
    spade.engine.set_services(again.clone());

    let listed = services_of(&spade, &bot).await?;
    let state = |name: &str| {
        listed
            .iter()
            .find(|s| s["name"] == name)
            .map(|s| (s["state"].clone(), s["restarts"].clone()))
    };
    assert_eq!(state("keeper"), Some((json!("running"), json!(1))));
    assert_eq!(state("temp").map(|s| s.0), Some(json!("lost")));

    let (status, _) = spade
        .delete(&format!("/v1/agents/{}/services/keeper", bot.id))
        .await?;
    assert_eq!(status, 204);
    assert_eq!(
        services_of(&spade, &bot)
            .await?
            .iter()
            .filter(|s| s["state"] == "running")
            .count(),
        0
    );
    Ok(())
}

#[tokio::test]
async fn starting_a_service_is_held_like_a_shell_command_and_asks_when_unreviewed() -> Result {
    let dir = tempfile::tempdir()?;
    let workspaces = Workspaces::new(dir.path());
    let (spade, _services) = start(
        vec![
            Script::reply("").call(
                "s1",
                "service_start",
                json!({ "name": "web", "command": "exec sleep 60" }),
            ),
            Script::reply("Asked."),
            title(),
        ],
        &workspaces,
        Reviewer::Unreachable,
    )
    .await?;
    let agent = spade.new_agent("Runner", "").await?;
    let conversation = agent["conversation"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    spade.say(&conversation, "Start it").await?;
    let events = spade.wait_for(&conversation, "approval_requested").await?;
    let asked = events
        .iter()
        .find(|e| e["type"] == "approval_requested")
        .cloned()
        .unwrap_or_default();
    assert_eq!(asked["name"], "service_start");
    assert_eq!(asked["scope"], "exec sleep 60\n[in ]");
    assert!(!events.iter().any(|e| e["type"] == "service_started"));
    Ok(())
}

#[tokio::test]
async fn a_file_wait_fires_when_the_file_changes() -> Result {
    let dir = tempfile::tempdir()?;
    let workspaces = Workspaces::new(dir.path());
    let (spade, _services) = start(
        vec![
            Script::reply("").call(
                "w1",
                "wait_for",
                json!({ "condition": { "kind": "file", "path": "out/result.txt" },
                        "reason": "the export" }),
            ),
            Script::reply("Waiting for the export."),
            title(),
            Script::reply("The export is in."),
        ],
        &workspaces,
        Reviewer::Fake,
    )
    .await?;
    let bot = told(&spade, &workspaces, "Wait for the export").await?;
    std::fs::create_dir_all(bot.folder.join("out"))?;
    std::fs::write(bot.folder.join("out/result.txt"), "done")?;
    spade
        .wait_for_count(&bot.conversation, "reply_finished", 2)
        .await?;
    assert!(last_prompt(&spade).contains("What you waited for happened: out/result.txt changed."));
    Ok(())
}

#[tokio::test]
async fn a_url_wait_polls_only_loopback_and_fires_when_it_answers() -> Result {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("http://{}/health", listener.local_addr()?);
    tokio::spawn(async move {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        while let Ok((mut socket, _)) = listener.accept().await {
            let mut buffer = [0u8; 1024];
            let _ = socket.read(&mut buffer).await;
            let _ = socket
                .write_all(b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n")
                .await;
        }
    });
    let dir = tempfile::tempdir()?;
    let workspaces = Workspaces::new(dir.path());
    let (spade, _services) = start(
        vec![
            Script::reply("").call(
                "w0",
                "wait_for",
                json!({ "condition": { "kind": "url", "url": "https://example.com" }, "reason": "x" }),
            ),
            Script::reply("").call(
                "w1",
                "wait_for",
                json!({ "condition": { "kind": "url", "url": url }, "reason": "the server" }),
            ),
            Script::reply("Waiting for the server."),
            title(),
            Script::reply("It answers."),
        ],
        &workspaces,
        Reviewer::Fake,
    )
    .await?;
    let bot = told(&spade, &workspaces, "Tell me when it is up").await?;
    // It answers at once, so the note may steer the open turn or open the next: either way the
    // bot reads it once.
    let events = spade.wait_for(&bot.conversation, "wake_fired").await?;
    let refused = events
        .iter()
        .find(|e| e["type"] == "tool_finished" && e["call_id"] == "w0")
        .cloned()
        .unwrap_or_default();
    assert_eq!(refused["is_error"], true);
    let note = format!("{url} answered 204");
    eventually("the bot read the note", || {
        spade
            .fake
            .seen()
            .iter()
            .any(|s| s.body["messages"].to_string().contains(&note))
    })
    .await?;
    Ok(())
}

/// Counting ids, but every service's id is `s_web`, so a script can name it.
struct KnownServiceId(AtomicU64);

impl Ids for KnownServiceId {
    fn next(&self, prefix: &str) -> String {
        if prefix == "s" {
            return "s_web".to_owned();
        }
        format!("{prefix}_{}", self.0.fetch_add(1, Ordering::SeqCst) + 1)
    }
}

#[tokio::test]
async fn waits_on_a_service_named_by_its_id_fire_on_its_line_and_its_exit() -> Result {
    let dir = tempfile::tempdir()?;
    let workspaces = Workspaces::new(dir.path());
    let (spade, _services) = start_on(
        vec![
            Script::reply("").call(
                "s1",
                "service_start",
                json!({ "name": "web", "command": "sleep 1; echo ready; sleep 1; exit 4" }),
            ),
            approve(),
            Script::reply("").call(
                "s2",
                "wait_for",
                json!({ "condition": { "kind": "service_line", "service": "s_web",
                                       "pattern": "ready" },
                        "reason": "the server" }),
            ),
            Script::reply("Waiting for it to be ready."),
            title(),
            Script::reply("").call(
                "s3",
                "wait_for",
                json!({ "condition": { "kind": "service_exit", "service": "s_web" },
                        "reason": "the server's end" }),
            ),
            Script::reply("Waiting for it to end."),
            Script::reply("It ended."),
        ],
        Options {
            ids: Some(Arc::new(KnownServiceId(AtomicU64::new(0)))),
            ..options(&workspaces, Reviewer::Fake)
        },
    )
    .await?;
    let bot = told(&spade, &workspaces, "Run the server").await?;
    let events = spade
        .wait_for_count(&bot.conversation, "reply_finished", 2)
        .await?;
    assert!(
        last_prompt(&spade).contains("service web printed a matching line"),
        "the line wait never fired"
    );
    let set: Vec<&Value> = events.iter().filter(|e| e["type"] == "wake_set").collect();
    assert_eq!(set[0]["condition"]["service"], "web", "{set:?}");
    spade
        .wait_for_count(&bot.conversation, "reply_finished", 3)
        .await?;
    assert!(
        last_prompt(&spade).contains("service web exited with code 4"),
        "the exit wait never fired"
    );
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_service_asked_for_as_the_person_presses_stop_never_runs_on() -> Result {
    let dir = tempfile::tempdir()?;
    let workspaces = Workspaces::new(dir.path());
    let (spade, _services) = start(
        vec![
            Script::reply("").call(
                "s1",
                "service_start",
                json!({ "name": "web", "command": "echo $$ > pid.txt; exec sleep 60" }),
            ),
            approve(),
            Script::reply("Started."),
            title(),
        ],
        &workspaces,
        Reviewer::Fake,
    )
    .await?;
    // The service is held after it was asked for, until the stop is in.
    let reached = Arc::new(tokio::sync::Notify::new());
    let (go, wait) = std::sync::mpsc::channel::<()>();
    let wait = std::sync::Mutex::new(wait);
    let at = reached.clone();
    spade.engine.hold_registrations(Arc::new(move |what, _| {
        if what != "service" {
            return;
        }
        at.notify_one();
        if let Ok(wait) = wait.lock() {
            let _ = wait.recv_timeout(Duration::from_secs(10));
        }
    }));
    let agent = spade.new_agent("Runner", "").await?;
    let field = |name: &str| agent[name].as_str().unwrap_or_default().to_owned();
    let (id, conversation) = (field("id"), field("conversation"));
    let folder = workspaces.of(&id)?.path()?;
    spade.say(&conversation, "Run the server").await?;
    tokio::time::timeout(Duration::from_secs(10), reached.notified()).await?;
    let (status, _) = spade
        .post(&format!("/v1/conversations/{conversation}/stop"), json!({}))
        .await?;
    assert!(status < 300);
    go.send(())?;
    let bot = Bot {
        id,
        conversation,
        folder,
    };
    let deadline = Instant::now() + Duration::from_secs(10);
    while bot_state(&spade, &bot).await? != "idle" {
        if Instant::now() > deadline {
            return Err("the bot never went idle".into());
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    let running = services_of(&spade, &bot)
        .await?
        .iter()
        .filter(|s| s["state"] == "running")
        .count();
    assert_eq!(running, 0, "a service from the stopped reply runs on");
    if let Ok(pid) = std::fs::read_to_string(bot.folder.join("pid.txt")) {
        assert!(!alive(&pid), "its process runs on");
    }
    Ok(())
}

async fn bot_state(spade: &Spade, bot: &Bot) -> Result<String> {
    let (_, body) = spade.get("/v1/agents").await?;
    Ok(body["agents"]
        .as_array()
        .and_then(|a| a.iter().find(|a| a["id"] == bot.id.as_str()))
        .and_then(|a| a["state"].as_str())
        .unwrap_or_default()
        .to_owned())
}
