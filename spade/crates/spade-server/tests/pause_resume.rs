//! What Pause holds and Resume gives back (ADR 0200 §6.1), through the real engine and API on the
//! scripted endpoint: the services Pause stopped start again the moment the bot resumes, after a
//! restart in between too, with no turn needed; and a wake met while the bot is paused whose
//! write fails never fires while paused and is never lost: it lands once storage recovers, holds
//! through a restart, and fires once on Resume. Process tests: real shells and a real local page.

#![cfg(unix)]

mod support;

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use spade_server::clock::Ids;
use spade_server::services::Services;
use spade_server::tools::{EngineHandle, Tool, service_tools};
use spade_server::workspace::Workspaces;
use spade_server::workspace::shell::Shell;
use spade_testkit::Script;
use support::{Options, Result, Spade, types};

/// Ids that never repeat a first run's, so a restarted engine never reuses one.
struct LaterIds(AtomicU64);

impl Ids for LaterIds {
    fn next(&self, prefix: &str) -> String {
        format!("{prefix}_later_{}", self.0.fetch_add(1, Ordering::SeqCst))
    }
}

fn later(from: u64) -> Option<Arc<dyn Ids>> {
    Some(Arc::new(LaterIds(AtomicU64::new(from))))
}

fn title() -> Script {
    Script::reply("").plain(r#"{"title":"Runner"}"#)
}

/// The reviewer's approval of the step before it.
fn approve() -> Script {
    Script::reply("").plain(r#"{"verdict":"approve","reason":"Starts its own service."}"#)
}

fn count(events: &[Value], kind: &str) -> usize {
    events.iter().filter(|e| e["type"] == kind).count()
}

/// Waits until `test` holds, looking every 20 ms for up to 10 s.
async fn until<F, Fut>(what: &str, test: F) -> Result
where
    F: Fn() -> Fut,
    Fut: Future<Output = Result<bool>>,
{
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if test().await? {
            return Ok(());
        }
        if Instant::now() > deadline {
            return Err(format!("never: {what}").into());
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

async fn act(spade: &Spade, agent: &str, action: &str) -> Result<Value> {
    let (status, body) = spade
        .post(&format!("/v1/agents/{agent}/{action}"), json!({}))
        .await?;
    assert_eq!(status, 200, "{action}: {body}");
    Ok(body)
}

/// A new bot told `text`, once its first reply ended: its id and conversation.
async fn told(spade: &Spade, text: &str) -> Result<(String, String)> {
    let agent = spade.new_agent("Runner", "").await?;
    let field = |name: &str| agent[name].as_str().unwrap_or_default().to_owned();
    let (id, conversation) = (field("id"), field("conversation"));
    spade.say(&conversation, text).await?;
    spade.wait_for(&conversation, "reply_finished").await?;
    Ok((id, conversation))
}

/// Each service of `agent` by name: its state and how often it started again.
async fn services(spade: &Spade, agent: &str) -> Result<Vec<(String, Value, Value)>> {
    let (status, body) = spade.get(&format!("/v1/agents/{agent}/services")).await?;
    assert_eq!(status, 200, "{body}");
    let mut listed: Vec<(String, Value, Value)> = body["services"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|s| {
            let name = s["name"].as_str().unwrap_or_default().to_owned();
            (name, s["state"].clone(), s["restarts"].clone())
        })
        .collect();
    listed.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(listed)
}

fn states(listed: &[(String, Value, Value)]) -> Vec<(&str, &Value)> {
    listed.iter().map(|(n, s, _)| (n.as_str(), s)).collect()
}

#[tokio::test]
async fn resume_starts_the_services_pause_stopped_at_once_after_a_restart_too() -> Result {
    let dir = tempfile::tempdir()?;
    let workspaces = Workspaces::new(dir.path());
    // The fake model reviews the bot's held calls, approving each in script order.
    let options = |ids| Options {
        workspaces: Some(workspaces.clone()),
        reviewer: None,
        ids,
        ..Options::default()
    };
    let bots = EngineHandle::default();
    let first = Services::new(workspaces.clone(), Shell::system(), bots.clone());
    let spade = Spade::start_with(
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
        service_tools(&first) as Vec<Arc<dyn Tool>>,
        options(None),
    )
    .await?;
    bots.set(&spade.engine);
    spade.engine.set_services(first.clone());
    let (agent, conversation) = told(&spade, "Start both").await?;
    let running = json!("running");
    assert_eq!(
        states(&services(&spade, &agent).await?),
        vec![("keeper", &running), ("temp", &running)]
    );

    act(&spade, &agent, "pause").await?;
    let stopped = json!("stopped");
    assert_eq!(
        states(&services(&spade, &agent).await?),
        vec![("keeper", &stopped), ("temp", &stopped)],
        "Pause stops them"
    );

    // Spade restarts while the bot is paused: neither starts again by itself, kept or not.
    first.stop_everything();
    let bots = EngineHandle::default();
    let again = Services::new(workspaces.clone(), Shell::system(), bots.clone());
    let spade = spade
        .restart_with(service_tools(&again), Vec::new(), options(later(1)))
        .await?;
    bots.set(&spade.engine);
    spade.engine.set_services(again.clone());
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(
        states(&services(&spade, &agent).await?),
        vec![("keeper", &stopped), ("temp", &stopped)],
        "still paused after the restart"
    );

    // Resume starts both again now, without a turn of the bot's.
    let resumed = act(&spade, &agent, "resume").await?;
    assert_eq!(resumed["changed"], true);
    let listed = services(&spade, &agent).await?;
    assert_eq!(
        listed,
        vec![
            ("keeper".to_owned(), running.clone(), json!(1)),
            ("temp".to_owned(), running.clone(), json!(1)),
        ]
    );
    let events = spade.events(&conversation).await?;
    assert_eq!(count(&events, "reply_started"), 1, "{:?}", types(&events));

    // Paused and resumed again: each starts once more, never twice at a time.
    act(&spade, &agent, "pause").await?;
    act(&spade, &agent, "resume").await?;
    assert_eq!(act(&spade, &agent, "resume").await?["changed"], false);
    let listed = services(&spade, &agent).await?;
    assert_eq!(
        listed,
        vec![
            ("keeper".to_owned(), running.clone(), json!(2)),
            ("temp".to_owned(), running, json!(2)),
        ]
    );
    again.stop_everything();
    Ok(())
}

/// A local page that answers `503` until `up` is set, then `200` exactly once, then `503` again:
/// a condition that is met once and never again. `served` is set once it answered `200`.
async fn once_up() -> Result<(String, Arc<AtomicBool>, Arc<AtomicBool>)> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("http://{}/ready", listener.local_addr()?);
    let up = Arc::new(AtomicBool::new(false));
    let served = Arc::new(AtomicBool::new(false));
    let (up_at, served_at) = (up.clone(), served.clone());
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let mut request = [0_u8; 2048];
            let _ = socket.read(&mut request).await;
            let ok = up_at.load(Ordering::SeqCst) && !served_at.swap(true, Ordering::SeqCst);
            let status = if ok {
                "200 OK"
            } else {
                "503 Service Unavailable"
            };
            let answer =
                format!("HTTP/1.1 {status}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
            let _ = socket.write_all(answer.as_bytes()).await;
        }
    });
    Ok((url, up, served))
}

/// Makes the database refuse every write of the paused bots' setting until [`allow`].
fn refuse_pauses(database: &Path) -> Result {
    let connection = spade_store::Store::connect(database)?;
    connection.execute_batch(
        "CREATE TRIGGER refuse_pause_insert BEFORE INSERT ON settings \
         WHEN NEW.key = 'paused_bots' BEGIN SELECT RAISE(ABORT, 'refused for a test'); END; \
         CREATE TRIGGER refuse_pause_update BEFORE UPDATE ON settings \
         WHEN NEW.key = 'paused_bots' BEGIN SELECT RAISE(ABORT, 'refused for a test'); END;",
    )?;
    Ok(())
}

fn allow_pauses(database: &Path) -> Result {
    let connection = spade_store::Store::connect(database)?;
    connection
        .execute_batch("DROP TRIGGER refuse_pause_insert; DROP TRIGGER refuse_pause_update;")?;
    Ok(())
}

/// The wakes the stored pause of `agent` holds.
fn stored_held(spade: &Spade, agent: &str) -> Result<usize> {
    let connection = spade_store::Store::connect(spade.database())?;
    let raw: String = connection
        .query_row(
            "SELECT value FROM settings WHERE key = 'paused_bots'",
            [],
            |row| row.get(0),
        )
        .unwrap_or_default();
    let stored: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
    Ok(stored[agent]["held"].as_array().map_or(0, Vec::len))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_wake_met_while_paused_whose_write_fails_is_kept_and_fires_once_on_resume() -> Result {
    let (url, up, served) = once_up().await?;
    let spade = Spade::start_with(
        vec![
            Script::reply("").call(
                "c1",
                "wait_for",
                json!({ "condition": { "kind": "url", "url": url },
                        "reason": "the build server answers" }),
            ),
            Script::reply("Waiting for the build server."),
            title(),
        ],
        Vec::new(),
        Options::default(),
    )
    .await?;
    let (agent, conversation) = told(&spade, "Tell me when the build server is up").await?;
    act(&spade, &agent, "pause").await?;

    // The page answers its one 200 while the bot is paused and the pause can't be written.
    refuse_pauses(&spade.database())?;
    up.store(true, Ordering::SeqCst);
    until("the page answered its one 200", || async {
        Ok(served.load(Ordering::SeqCst))
    })
    .await?;
    tokio::time::sleep(Duration::from_millis(600)).await;
    spade.engine.kick_wakes();
    let events = spade.events(&conversation).await?;
    assert_eq!(count(&events, "wake_fired"), 0, "{:?}", types(&events));
    assert_eq!(stored_held(&spade, &agent)?, 0, "the write was refused");
    let (_, wakes) = spade.get(&format!("/v1/agents/{agent}/wakes")).await?;
    assert_eq!(
        wakes["wakes"].as_array().map(Vec::len),
        Some(1),
        "the wait stays open: {wakes}"
    );

    // Storage recovers: the met wake lands in the pause on its own.
    allow_pauses(&spade.database())?;
    until("the met wake is stored with the pause", || async {
        Ok(stored_held(&spade, &agent)? == 1)
    })
    .await?;
    let events = spade.events(&conversation).await?;
    assert_eq!(count(&events, "wake_fired"), 0, "{:?}", types(&events));

    // A restart before Resume: the page never answers again, so only what was kept wakes it.
    let spade = spade
        .restart_with(
            Vec::new(),
            vec![Script::reply("The build server is up.")],
            Options {
                ids: later(1),
                ..Options::default()
            },
        )
        .await?;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let events = spade.events(&conversation).await?;
    assert_eq!(count(&events, "wake_fired"), 0, "{:?}", types(&events));

    assert_eq!(act(&spade, &agent, "resume").await?["changed"], true);
    let events = spade
        .wait_for_count(&conversation, "reply_finished", 2)
        .await?;
    let fired: Vec<&Value> = events
        .iter()
        .filter(|e| e["type"] == "wake_fired")
        .collect();
    assert_eq!(fired.len(), 1, "{:?}", types(&events));
    assert_eq!(fired[0]["cause"], "condition");
    Ok(())
}
