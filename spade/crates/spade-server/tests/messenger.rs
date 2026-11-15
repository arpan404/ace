//! What the messenger app reads (Spade v4): each conversation's seen cursor and "finished, not
//! seen", plain previews, a bot made with its first message, the model for new bots, and which
//! bots use each app and skill.

mod support;

use std::time::{Duration, Instant};

use serde_json::{Value, json};
use spade_server::computer::{Computers, Kind, Lifecycle, Report, Terminals};
use spade_server::workspace::Workspaces;
use spade_server::workspace::shell::Shell;
use spade_testkit::Script;
use support::{Result, Spade};

fn title() -> Script {
    Script::reply("").plain(r#"{"title":"A title"}"#)
}

async fn agent(spade: &Spade, id: &str) -> Result<Value> {
    let (status, body) = spade.get("/v1/agents").await?;
    assert_eq!(status, 200, "{body}");
    Ok(body["agents"]
        .as_array()
        .and_then(|all| all.iter().find(|a| a["id"] == id).cloned())
        .unwrap_or_default())
}

async fn wait_until(spade: &Spade, id: &str, check: impl Fn(&Value) -> bool) -> Result<Value> {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let found = agent(spade, id).await?;
        if check(&found) {
            return Ok(found);
        }
        if Instant::now() > deadline {
            return Err(format!("never got there: {found}").into());
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn a_finished_reply_is_not_seen_until_the_person_marks_it_and_the_mark_survives_a_restart()
-> Result {
    let spade = Spade::start(
        vec![
            Script::reply("Found [three flights](https://x.dev/f) to **Oslo**."),
            title(),
        ],
        Vec::new(),
    )
    .await?;
    let bot = spade.new_agent("Trips", "").await?;
    let id = bot["id"].as_str().unwrap_or_default().to_owned();
    let conversation = bot["conversation"].as_str().unwrap_or_default().to_owned();
    assert_eq!(bot["unseen"], false, "nothing said yet");
    spade.say(&conversation, "Find flights").await?;
    let done = wait_until(&spade, &id, |a| a["unseen"] == true).await?;
    assert_eq!(done["state"], "idle", "only once it finished");
    assert_eq!(
        done["last_message"]["text"], "Found three flights to Oslo.",
        "plain text, links as their words"
    );
    let reply_seq = done["last_message"]["seq"].as_i64().unwrap_or_default();
    assert!(reply_seq > 0, "{done}");

    let (status, body) = spade
        .put(&format!("/v1/conversations/{conversation}/seen"), json!({}))
        .await?;
    assert_eq!(status, 200, "{body}");
    let cursor = body["seen_seq"].as_i64().unwrap_or_default();
    assert!(cursor >= reply_seq, "{body}");
    let (status, body) = spade
        .put(
            &format!("/v1/conversations/{conversation}/seen"),
            json!({ "seq": 1 }),
        )
        .await?;
    assert_eq!(
        (status, body["seen_seq"].as_i64()),
        (200, Some(cursor)),
        "never back"
    );
    let (status, _) = spade
        .put("/v1/conversations/missing/seen", json!({}))
        .await?;
    assert_eq!(status, 404);

    let spade = spade.restart(Vec::new(), Vec::new()).await?;
    let after = agent(&spade, &id).await?;
    assert_eq!(
        (after["unseen"].clone(), after["seen_seq"].as_i64()),
        (json!(false), Some(cursor)),
        "{after}"
    );
    Ok(())
}

async fn bots(spade: &Spade) -> Result<usize> {
    let (_, body) = spade.get("/v1/agents").await?;
    Ok(body["agents"].as_array().map_or(0, Vec::len))
}

#[tokio::test]
async fn a_bot_made_with_its_first_message_starts_on_it_and_a_refused_message_makes_no_bot()
-> Result {
    let spade = Spade::start(vec![Script::reply("On it."), title()], Vec::new()).await?;
    let (status, body) = spade
        .post(
            "/v1/agents",
            json!({ "name": "Trips", "first_message": { "text": "Plan a weekend in Oslo" } }),
        )
        .await?;
    assert_eq!(status, 201, "{body}");
    let made = &body["agent"];
    assert_eq!(made["model"], "fake/m", "Spade's default model");
    assert_eq!(made["access"], "ask", "the new-bot level");
    let conversation = made["conversation"].as_str().unwrap_or_default();
    let events = spade.wait_for(conversation, "reply_finished").await?;
    assert_eq!(events[0]["type"], "user_message", "{events:?}");
    assert_eq!(events[0]["text"], "Plan a weekend in Oslo");

    let before = bots(&spade).await?;
    let (status, body) = spade
        .post(
            "/v1/agents",
            json!({ "name": "Empty", "first_message": { "text": "   " } }),
        )
        .await?;
    assert_eq!(status, 400, "{body}");
    assert_eq!(bots(&spade).await?, before, "nothing was made");
    Ok(())
}

#[tokio::test]
async fn a_first_message_refused_once_the_bot_exists_takes_the_bot_back() -> Result {
    // No money to spend: the message is refused as it is sent, after the bot was made.
    let options = support::Options {
        cap_usd: 0.0,
        ..support::Options::default()
    };
    let spade = Spade::start_with(Vec::new(), Vec::new(), options).await?;
    let before = bots(&spade).await?;
    let (status, body) = spade
        .post(
            "/v1/agents",
            json!({ "name": "Trips", "model": "fake/m", "first_message": { "text": "Go" } }),
        )
        .await?;
    assert_eq!(status, 402, "{body}");
    assert_eq!(bots(&spade).await?, before, "the bot went with its message");
    Ok(())
}

#[tokio::test]
async fn new_bots_start_on_the_model_the_person_chose_for_them() -> Result {
    let spade = Spade::start(Vec::new(), Vec::new()).await?;
    let (_, models) = spade.get("/v1/models").await?;
    assert_eq!(models["new_bot_model"], Value::Null, "{models}");
    let (status, body) = spade
        .put("/v1/settings", json!({ "new_bot_model": "fake/other" }))
        .await?;
    assert_eq!(status, 204, "{body}");
    let (_, models) = spade.get("/v1/models").await?;
    assert_eq!(models["new_bot_model"], "fake/other");
    let (status, body) = spade.post("/v1/agents", json!({ "name": "Trips" })).await?;
    assert_eq!(
        (status, &body["agent"]["model"]),
        (201, &json!("fake/other"))
    );
    let (status, body) = spade
        .put("/v1/settings", json!({ "new_bot_model": "not a model" }))
        .await?;
    assert_eq!(status, 400, "{body}");

    let (status, body) = spade
        .put("/v1/settings", json!({ "new_bot_model": null }))
        .await?;
    assert_eq!(status, 204, "{body}");
    let (status, body) = spade.post("/v1/agents", json!({ "name": "Inbox" })).await?;
    assert_eq!(status, 201, "{body}");
    assert_eq!(
        body["agent"]["model"], "fake/m",
        "back to the first usable model"
    );

    spade
        .put("/v1/settings", json!({ "new_bot_model": "fake/other" }))
        .await?;
    let spade = spade.restart(Vec::new(), Vec::new()).await?;
    let (_, models) = spade.get("/v1/models").await?;
    assert_eq!(
        models["new_bot_model"], "fake/other",
        "kept across a restart"
    );
    Ok(())
}

fn computers(
    root: &std::path::Path,
    clock: std::sync::Arc<support::ManualClock>,
) -> std::sync::Arc<Computers> {
    let workspaces = Workspaces::new(root.join("workspace"));
    let terminals = Terminals::new(
        root.join("terminal"),
        workspaces.clone(),
        Shell::system(),
        clock.clone(),
    );
    Computers::open(root.join("computer"), workspaces, terminals, clock)
}

#[test]
fn a_computer_wakes_while_ace_brings_up_the_browser_and_keeps_the_surfaces_it_used() -> Result {
    let dir = tempfile::tempdir()?;
    let clock = support::ManualClock::at(1_000_000);
    let all = computers(dir.path(), clock.clone());
    let fresh = all.view("a_1");
    assert_eq!(
        (fresh.state, fresh.used.as_slice()),
        (Lifecycle::Asleep, &[][..])
    );

    all.bot_used("a_1", Kind::Browser);
    assert_eq!(
        all.view("a_1").state,
        Lifecycle::Starting,
        "the bot reached for it"
    );
    clock.set(1_002_000);
    all.report(
        "a_1",
        Kind::Browser,
        Report {
            live: true,
            ..Report::default()
        },
    )?;
    let view = all.view("a_1");
    assert_eq!(
        (view.state, view.used.as_slice()),
        (Lifecycle::Ready, &[Kind::Browser][..])
    );

    // ace never answers for the screen: it reads as starting only a while.
    all.bot_used("a_1", Kind::Screen);
    assert_eq!(all.view("a_1").state, Lifecycle::Starting);
    clock.set(1_002_000 + 31_000);
    assert_eq!(
        all.view("a_1").state,
        Lifecycle::Ready,
        "the browser is still open"
    );
    all.report("a_1", Kind::Browser, Report::default())?;
    clock.set(1_002_000 + 31_000 + 3 * 60_000);
    assert_eq!(
        all.view("a_1").state,
        Lifecycle::Asleep,
        "all closed and quiet"
    );

    // After a restart, what it used is still known; nothing is open.
    drop(all);
    let all = computers(dir.path(), clock);
    let view = all.view("a_1");
    assert_eq!(
        (view.state, view.used.as_slice()),
        (Lifecycle::Asleep, &[Kind::Browser, Kind::Screen][..])
    );
    assert!(all.view("a_2").used.is_empty(), "each bot its own");
    all.remove("a_1");
    assert!(
        all.view("a_1").used.is_empty(),
        "a deleted bot's go with it"
    );
    Ok(())
}
