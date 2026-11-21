//! A paused bot moves to another machine (ADR 0187, ADR 0200 §6.1) with its pause: it arrives
//! paused, its wake met while paused still held, its routine's slot held and a message that
//! waited still waiting; nothing of it fires there, through a restart too, until the person
//! resumes it there, and then each fires once. Two Spades with the fake fleet between them, and
//! a real local page as the wake's condition.

mod support;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use spade_testkit::Script;
use support::fleet::{Fleet, machine, move_bot, move_ends, restart_scripted};
use support::{Result, Spade, types};

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

/// A local page that answers `503` until `up` is set, then `200` exactly once: a condition met
/// once and never again. `served` is set once it answered `200`.
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

async fn act(spade: &Spade, agent: &str, action: &str) -> Result<Value> {
    let (status, body) = spade
        .post(&format!("/v1/agents/{agent}/{action}"), json!({}))
        .await?;
    assert_eq!(status, 200, "{action}: {body}");
    Ok(body)
}

async fn row(spade: &Spade, agent: &str) -> Result<Value> {
    let (_, body) = spade.get("/v1/running").await?;
    body["bots"]
        .as_array()
        .and_then(|rows| rows.iter().find(|r| r["id"] == agent).cloned())
        .ok_or_else(|| format!("{agent} isn't in the running view").into())
}

/// Its one routine: whether it is paused, and its next run.
async fn routine(spade: &Spade, agent: &str) -> Result<(Value, Value)> {
    let (_, body) = spade.get(&format!("/v1/agents/{agent}/routines")).await?;
    let first = body["routines"][0].clone();
    Ok((first["paused"].clone(), first["next_run"].clone()))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_paused_bot_moves_paused_and_resuming_it_there_fires_each_held_thing_once() -> Result {
    let (url, up, served) = once_up().await?;
    let fleet = Arc::new(Fleet::default());
    let laptop = machine(
        &fleet,
        "host-laptop",
        "Laptop",
        vec![
            Script::reply("").call(
                "c1",
                "wait_for",
                json!({ "condition": { "kind": "url", "url": url },
                        "reason": "the build server answers" }),
            ),
            Script::reply("Waiting for the build server."),
            Script::reply("").plain(r#"{"title":"Builds"}"#),
        ],
    )
    .await?;
    let studio = machine(&fleet, "host-studio", "Studio", Vec::new()).await?;

    let (status, made) = laptop
        .post(
            "/v1/agents",
            json!({ "name": "Builds", "task": "Watch the build server.", "model": "fake/m" }),
        )
        .await?;
    assert_eq!(status, 201, "{made}");
    let field = |name: &str| made["agent"][name].as_str().unwrap_or_default().to_owned();
    let (bot, conversation) = (field("id"), field("conversation"));
    laptop
        .say(&conversation, "Tell me when the build server is up")
        .await?;
    laptop.wait_for(&conversation, "reply_finished").await?;
    let (status, body) = laptop
        .post(
            &format!("/v1/agents/{bot}/routines"),
            json!({ "name": "Morning check", "instruction": "Check the builds.",
                    "trigger": { "kind": "schedule", "schedule": "daily at 9:00" },
                    "time_zone": "UTC" }),
        )
        .await?;
    assert_eq!(status, 201, "{body}");
    let (_, held_slot) = routine(&laptop, &bot).await?;
    assert!(held_slot.is_i64(), "the routine is on: {held_slot}");

    // Paused on the laptop: the page answers its one 200 (the wait is met, and held), and the
    // person writes to it (the message waits).
    assert_eq!(act(&laptop, &bot, "pause").await?["changed"], true);
    up.store(true, Ordering::SeqCst);
    until("the page answered its one 200", || async {
        Ok(served.load(Ordering::SeqCst))
    })
    .await?;
    tokio::time::sleep(Duration::from_millis(300)).await;
    laptop.say(&conversation, "Are you still on it?").await?;
    tokio::time::sleep(Duration::from_millis(200)).await;
    let before = laptop.events(&conversation).await?;
    assert_eq!(count(&before, "wake_fired"), 0, "{:?}", types(&before));
    assert_eq!(count(&before, "reply_started"), 1, "{:?}", types(&before));

    // It moves as it is, paused.
    let (status, started) = move_bot(&laptop, &studio, &bot, "mv_p", "host-studio").await?;
    assert_eq!(status, 202, "{started}");
    assert_eq!(
        move_ends(&laptop, &bot).await?,
        Value::Null,
        "the move took"
    );
    let arrived = row(&studio, &bot).await?;
    assert_eq!(
        (&arrived["state"], &arrived["reads"], &arrived["actions"]),
        (&json!("paused"), &json!("paused"), &json!(["resume"])),
        "{arrived}"
    );
    assert_eq!(
        routine(&studio, &bot).await?.0,
        true,
        "routines arrive paused"
    );

    // The studio restarts before Resume: still paused, nothing of it fired.
    let studio = restart_scripted(
        &fleet,
        "host-studio",
        studio,
        vec![
            Script::reply("The build server is up."),
            Script::reply("Yes, still on it."),
        ],
    )
    .await?;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(row(&studio, &bot).await?["reads"], "paused");
    let there = studio.events(&conversation).await?;
    assert_eq!(count(&there, "wake_fired"), 0, "{:?}", types(&there));
    assert_eq!(count(&there, "reply_started"), 1, "{:?}", types(&there));

    // Resumed there: the held wake fires once, the message that waited is answered, and the
    // routine comes back on at the slot it held.
    assert_eq!(act(&studio, &bot, "resume").await?["changed"], true);
    until("what waited is answered", || async {
        let events = studio.events(&conversation).await?;
        let waited = events
            .iter()
            .rposition(|e| e["type"] == "user_message")
            .unwrap_or(0);
        let answered = events[waited..]
            .iter()
            .any(|e| e["type"] == "reply_finished");
        Ok(answered && row(&studio, &bot).await?["reads"] == "idle")
    })
    .await?;
    let events = studio.events(&conversation).await?;
    let fired: Vec<&Value> = events
        .iter()
        .filter(|e| e["type"] == "wake_fired")
        .collect();
    assert_eq!(fired.len(), 1, "{:?}", types(&events));
    assert_eq!(fired[0]["cause"], "condition");
    assert_eq!(
        routine(&studio, &bot).await?,
        (json!(false), held_slot),
        "on again at the slot it held"
    );

    // Resume again changes nothing, and nothing fires twice.
    assert_eq!(act(&studio, &bot, "resume").await?["changed"], false);
    tokio::time::sleep(Duration::from_millis(200)).await;
    let events = studio.events(&conversation).await?;
    assert_eq!(count(&events, "wake_fired"), 1, "{:?}", types(&events));
    Ok(())
}
