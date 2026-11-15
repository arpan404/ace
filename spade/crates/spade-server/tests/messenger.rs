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
    assert_eq!(made["access"], "auto_review", "Spade's one level");
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

#[tokio::test]
async fn each_connected_app_names_the_bots_that_may_use_it() -> Result {
    let app = spade_testkit::FakeConnector::start(vec![spade_testkit::connector::tool(
        "echo",
        Some(true),
        None,
    )])
    .await;
    app.accept_token("api-key-1");
    let spade = Spade::start_with(
        Vec::new(),
        Vec::new(),
        support::Options {
            connectors: true,
            ..support::Options::default()
        },
    )
    .await?;
    let (status, body) = spade
        .post(
            "/v1/connectors",
            json!({ "url": app.url(), "name": "Fake", "local": true, "token": "api-key-1" }),
        )
        .await?;
    assert_eq!(status, 200, "{body}");
    let connector = body["connector"]["id"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let (_, roster) = spade.get("/v1/agents").await?;
    let main = roster["agents"][0]["id"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let bot = spade.new_agent("Inbox", "").await?;
    let other = spade.new_agent("Trips", "").await?;
    let bot = bot["id"].as_str().unwrap_or_default().to_owned();

    let users = |body: &Value| body["connectors"][0]["bots"].clone();
    let (_, body) = spade.get("/v1/connectors").await?;
    assert_eq!(
        users(&body),
        json!([main]),
        "Spade uses every app; a new bot none"
    );
    let (status, _) = spade
        .put(
            &format!("/v1/agents/{bot}/connectors"),
            json!({ "connectors": [connector] }),
        )
        .await?;
    assert_eq!(status, 200);
    let (_, body) = spade.get("/v1/connectors").await?;
    let mut shown: Vec<String> = serde_json::from_value(users(&body))?;
    shown.sort();
    let mut expected = vec![main, bot];
    expected.sort();
    assert_eq!(shown, expected);
    assert!(
        !users(&body)
            .to_string()
            .contains(other["id"].as_str().unwrap_or("-"))
    );
    let (_, one) = spade.get(&format!("/v1/connectors/{connector}")).await?;
    assert_eq!(one["connector"]["bots"].as_array().map(Vec::len), Some(2));
    Ok(())
}

#[tokio::test]
async fn each_skill_names_the_bots_that_wrote_it_and_the_bots_that_use_it() -> Result {
    use spade_server::clock::SystemClock;
    use spade_server::learning::{Draft, Learning};
    use spade_server::skill_store::SkillStore;
    use spade_server::tools::SkillLibrary;

    let dir = tempfile::tempdir()?;
    // The store's own file, with the bots its rows name.
    let rows = spade_store::Store::open(&dir.path().join("skills.sqlite"))?;
    for bot in ["a_writer", "a_reader"] {
        rows.create_agent(
            spade_store::NewAgent {
                id: bot,
                kind: "bot",
                name: bot,
                task: "",
                avatar: "{}",
                model: "fake/m",
                conversation: &format!("c_{bot}"),
            },
            &[],
            1,
        )?;
    }
    rows.record_skill_load("a_reader", "release-notes")?;
    rows.record_skill_load("a_writer", "release-notes")?;
    let store = SkillStore::open(
        dir.path().join("skills"),
        rows,
        std::sync::Arc::new(SystemClock),
        None,
    );
    let library: std::sync::Arc<dyn SkillLibrary> = store.clone();
    let learning = std::sync::Arc::new(Learning::new(
        dir.path().join("learning"),
        std::sync::Arc::new(SystemClock),
        library,
    ));
    let draft = |name: &str| Draft {
        name: name.to_owned(),
        description: "Write release notes".to_owned(),
        body: "Group by area.\n".to_owned(),
        why: "Asked twice.".to_owned(),
        base: None,
        source: None,
    };
    let saved = learning.propose("a_writer", "c_a_writer.k1", draft("release-notes"))?;
    learning.answer("a_writer", &saved.id, true).await?;
    // A discarded one wrote nothing.
    let other = learning.propose("a_reader", "c_a_reader.k2", draft("release-notes"))?;
    learning.answer("a_reader", &other.id, false).await?;

    let spade = Spade::start_with(
        Vec::new(),
        Vec::new(),
        support::Options {
            skill_store: Some(store),
            learning: Some(learning),
            ..support::Options::default()
        },
    )
    .await?;
    let (status, body) = spade.get("/v1/skills").await?;
    assert_eq!(status, 200, "{body}");
    let skill = &body["skills"][0];
    assert_eq!(skill["name"], "release-notes", "{body}");
    assert_eq!(skill["written_by"], json!(["a_writer"]));
    assert_eq!(skill["used_by"], json!(["a_reader", "a_writer"]));
    Ok(())
}

#[tokio::test]
async fn a_groups_files_are_the_ones_its_members_made_answering_it() -> Result {
    let spade = Spade::start(
        vec![
            Script::reply("").call(
                "w1",
                "workspace_write",
                json!({ "path": "launch/plan.md", "content": "# Plan" }),
            ),
            Script::reply("I wrote the plan."),
            Script::reply("").plain(r#"{"title":"T"}"#),
        ],
        vec![std::sync::Arc::new(support::FakeTool::new(
            "workspace_write",
            spade_core::tools::Risk::Read,
            "written",
        ))],
    )
    .await?;
    let member = spade.new_agent("Research", "").await?;
    let (status, body) = spade
        .post(
            "/v1/groups",
            json!({ "name": "Launch", "members": [{ "agent": member["id"] }] }),
        )
        .await?;
    assert_eq!(status, 201, "{body}");
    let group = body["group"].clone();
    let id = group["id"].as_str().unwrap_or_default();
    let (_, files) = spade.get(&format!("/v1/groups/{id}/files")).await?;
    assert_eq!(files, json!({ "files": [] }));
    let (status, _) = spade
        .post(
            &format!("/v1/groups/{id}/messages"),
            json!({ "text": "Write the launch plan" }),
        )
        .await?;
    assert_eq!(status, 202);
    let conversation = group["conversation"].as_str().unwrap_or_default();
    spade
        .wait_for_count(conversation, "group_message", 2)
        .await?;
    let (status, files) = spade.get(&format!("/v1/groups/{id}/files")).await?;
    assert_eq!(status, 200, "{files}");
    let shown = files["files"].as_array().cloned().unwrap_or_default();
    assert_eq!(shown.len(), 1, "{files}");
    assert_eq!(
        (&shown[0]["agent"], &shown[0]["path"]),
        (&group["lead"]["agent"], &json!("launch/plan.md"))
    );
    let (status, _) = spade.get("/v1/groups/missing/files").await?;
    assert_eq!(status, 404);
    Ok(())
}
