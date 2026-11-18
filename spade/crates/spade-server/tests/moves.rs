//! Moving a bot to another machine (ADR 0187): two Spades with a fake fleet of daemons between
//! them that stamps and signs each inbox request as ace does, and can lose answers, change a
//! part on the way or go offline.

mod support;

use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use serde_json::{Value, json};
use spade_testkit::Script;
use support::fleet::{Fleet, link, machine, move_bot, move_ends};
use support::{Result, Spade};

async fn pair() -> Result<(Arc<Fleet>, Spade, Spade)> {
    let fleet = Arc::new(Fleet::default());
    let laptop = machine(
        &fleet,
        "host-laptop",
        "Laptop",
        vec![Script::reply("Noted: the launch is on Friday.")],
    )
    .await?;
    let studio = machine(
        &fleet,
        "host-studio",
        "Studio",
        vec![Script::reply("unused")],
    )
    .await?;
    Ok((fleet, laptop, studio))
}

/// A bot with a conversation, a note, two routines (one a webhook), a file and a folder grant.
async fn furnished(spade: &Spade) -> Result<String> {
    let (status, made) = spade
        .post(
            "/v1/agents",
            json!({ "name": "Research", "task": "Track the launch.", "model": "fake/m" }),
        )
        .await?;
    assert_eq!(status, 201, "{made}");
    let bot = made["agent"]["id"].as_str().unwrap_or_default().to_owned();
    let conversation = made["agent"]["conversation"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let (status, body) = spade
        .post(
            &format!("/v1/conversations/{conversation}/messages"),
            json!({ "text": "The launch is on Friday." }),
        )
        .await?;
    assert!(status < 300, "{body}");
    idle(spade, &bot).await?;
    for body in [
        json!({ "name": "Digest", "instruction": "Send the digest.",
                "trigger": { "kind": "schedule", "schedule": "daily at 9:00" }, "time_zone": "UTC" }),
        json!({ "name": "Hook", "instruction": "Run on a hook.", "trigger": { "kind": "webhook" } }),
    ] {
        let (status, body) = spade
            .post(&format!("/v1/agents/{bot}/routines"), body)
            .await?;
        assert_eq!(status, 201, "{body}");
    }
    for text in ["Prefers short summaries", "The launch owner is Sam"] {
        let (status, body) = spade
            .post(&format!("/v1/agents/{bot}/notes"), json!({ "text": text }))
            .await?;
        assert_eq!(status, 201, "{body}");
    }
    let folder = spade.dir.path().join("workspace").join(&bot).join("drafts");
    std::fs::create_dir_all(&folder)?;
    std::fs::write(folder.join("plan.md"), "# Launch plan\n\nShip on Friday.\n")?;
    std::fs::write(folder.join("big.bin"), vec![7u8; 700 * 1024])?;
    Ok(bot)
}

async fn idle(spade: &Spade, bot: &str) -> Result<()> {
    for _ in 0..200 {
        let (_, body) = spade.get("/v1/agents").await?;
        let state = body["agents"]
            .as_array()
            .and_then(|all| all.iter().find(|a| a["id"] == bot))
            .map(|a| a["state"].clone());
        if state == Some(json!("idle")) {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    Err("the bot never went idle".into())
}

async fn listed(spade: &Spade, bot: &str) -> Result<Option<Value>> {
    let (_, body) = spade.get("/v1/agents").await?;
    Ok(body["agents"]
        .as_array()
        .and_then(|all| all.iter().find(|a| a["id"] == bot).cloned()))
}

async fn events(spade: &Spade, conversation: &str) -> Result<Vec<Value>> {
    let (_, body) = spade
        .get(&format!("/v1/conversations/{conversation}/events"))
        .await?;
    Ok(body.as_array().cloned().unwrap_or_default())
}

async fn notes(spade: &Spade, bot: &str) -> Result<Vec<String>> {
    let (_, body) = spade.get(&format!("/v1/agents/{bot}/notes")).await?;
    let mut texts: Vec<String> = body["notes"]
        .as_array()
        .map(|n| {
            n.iter()
                .filter_map(|n| n["text"].as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    texts.sort();
    Ok(texts)
}

#[tokio::test]
async fn a_bot_moved_to_another_machine_keeps_its_history_notes_files_and_id_and_its_routines_arrive_paused()
-> Result {
    let (_fleet, laptop, studio) = pair().await?;
    let bot = furnished(&laptop).await?;
    let before = listed(&laptop, &bot).await?.ok_or("not listed")?;
    let conversation = before["conversation"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let history = events(&laptop, &conversation).await?;
    let kept_notes = notes(&laptop, &bot).await?;

    let (status, started) = move_bot(&laptop, &studio, &bot, "mv_1", "host-studio").await?;
    assert_eq!(status, 202, "{started}");
    assert_eq!(
        move_ends(&laptop, &bot).await?,
        Value::Null,
        "the move took"
    );

    assert!(
        listed(&laptop, &bot).await?.is_none(),
        "gone from the laptop's roster"
    );
    let arrived = listed(&studio, &bot).await?.ok_or("not on the studio")?;
    assert_eq!(arrived["name"], "Research");
    assert_eq!(arrived["task"], "Track the launch.");
    assert_eq!(
        arrived["conversation"],
        json!(conversation),
        "same conversation id"
    );
    // The whole history, every event as it was, then one more: its arrival, after which no
    // answer the person gave on the laptop counts.
    assert!(history.len() >= 3, "{history:?}");
    let mut there = events(&studio, &conversation).await?;
    let last = there.pop().unwrap_or_default();
    assert_eq!(there, history, "the whole history");
    assert_eq!(last["event"]["type"], "arrived", "{last}");
    assert_eq!(notes(&studio, &bot).await?, kept_notes);
    let (_, routines) = studio.get(&format!("/v1/agents/{bot}/routines")).await?;
    let routines = routines["routines"].as_array().cloned().unwrap_or_default();
    assert_eq!(routines.len(), 2);
    assert!(routines.iter().all(|r| r["paused"] == true), "{routines:?}");
    let folder = studio
        .dir
        .path()
        .join("workspace")
        .join(&bot)
        .join("drafts");
    assert_eq!(
        std::fs::read_to_string(folder.join("plan.md"))?,
        "# Launch plan\n\nShip on Friday.\n"
    );
    assert_eq!(
        std::fs::read(folder.join("big.bin"))?,
        vec![7u8; 700 * 1024]
    );
    assert_eq!(arrived["arrived"]["routines_paused"], 2);
    assert_eq!(arrived["arrived"]["webhooks"], 1);
    assert_eq!(arrived["arrived"]["from"]["name"], "Laptop");

    // The laptop kept an archive and says where the bot went to anyone asking there.
    assert!(laptop.dir.path().join("moved").read_dir()?.next().is_some());
    assert!(!laptop.dir.path().join("workspace").join(&bot).exists());
    let (status, _) = laptop
        .post(
            &format!("/v1/conversations/{conversation}/messages"),
            json!({ "text": "Hi" }),
        )
        .await?;
    assert_eq!(status, 404);
    Ok(())
}

#[tokio::test]
async fn a_move_that_fails_halfway_leaves_the_bot_where_it_was() -> Result {
    let (fleet, laptop, studio) = pair().await?;
    let bot = furnished(&laptop).await?;
    let kept_notes = notes(&laptop, &bot).await?;
    fleet.change_notes.store(true, Ordering::SeqCst);

    let (status, started) = move_bot(&laptop, &studio, &bot, "mv_2", "host-studio").await?;
    assert_eq!(status, 202, "{started}");
    let ended = move_ends(&laptop, &bot).await?;
    assert_eq!(ended["state"], "failed", "{ended}");
    assert!(
        ended["problem"]
            .as_str()
            .is_some_and(|p| p.contains("notes")),
        "{ended}"
    );

    let still = listed(&laptop, &bot)
        .await?
        .ok_or("the bot left the laptop")?;
    assert_eq!(still["move"]["state"], "failed");
    assert_eq!(notes(&laptop, &bot).await?, kept_notes);
    assert!(
        laptop
            .dir
            .path()
            .join("workspace")
            .join(&bot)
            .join("drafts/plan.md")
            .exists()
    );
    assert!(
        listed(&studio, &bot).await?.is_none(),
        "nothing of it on the studio"
    );
    assert!(!studio.dir.path().join("workspace").join(&bot).exists());

    // It takes messages again, and the failure can be dismissed.
    let conversation = still["conversation"].as_str().unwrap_or_default();
    let (status, body) = laptop
        .post(
            &format!("/v1/conversations/{conversation}/messages"),
            json!({ "text": "Still here?" }),
        )
        .await?;
    assert!(status < 300, "{body}");
    let (status, _) = laptop.delete(&format!("/v1/agents/{bot}/move")).await?;
    assert_eq!(status, 200);
    let after = listed(&laptop, &bot).await?.ok_or("gone")?;
    assert!(after["move"].is_null());
    Ok(())
}

#[tokio::test]
async fn a_move_waiting_on_an_unreachable_machine_can_be_cancelled_and_the_bot_stays() -> Result {
    let (fleet, laptop, studio) = pair().await?;
    let bot = furnished(&laptop).await?;
    fleet.unreachable.store(true, Ordering::SeqCst);
    let (status, _) = move_bot(&laptop, &studio, &bot, "mv_3", "host-studio").await?;
    assert_eq!(status, 202);
    let mut waiting = Value::Null;
    for _ in 0..200 {
        waiting = listed(&laptop, &bot).await?.ok_or("gone")?;
        if waiting["move"]["waiting"] == true {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert_eq!(waiting["move"]["waiting"], true, "{waiting}");
    assert_eq!(waiting["status"], "Moving to Studio");
    // Frozen meanwhile: a message is refused, in words.
    let conversation = waiting["conversation"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let (status, body) = laptop
        .post(
            &format!("/v1/conversations/{conversation}/messages"),
            json!({ "text": "Hi" }),
        )
        .await?;
    assert_eq!(status, 409, "{body}");
    assert!(
        body["error"]
            .as_str()
            .is_some_and(|e| e.contains("moving to Studio")),
        "{body}"
    );

    let (status, body) = laptop.delete(&format!("/v1/agents/{bot}/move")).await?;
    assert_eq!(status, 200, "{body}");
    // A cancelled move leaves nothing to show: the bot is simply still here.
    assert_eq!(move_ends(&laptop, &bot).await?, Value::Null);
    let still = listed(&laptop, &bot)
        .await?
        .ok_or("the bot left the laptop")?;
    assert_ne!(still["status"], "Moving to Studio");
    let (status, body) = laptop
        .post(
            &format!("/v1/conversations/{conversation}/messages"),
            json!({ "text": "Hi" }),
        )
        .await?;
    assert!(status < 300, "{body}");
    assert!(listed(&studio, &bot).await?.is_none());
    Ok(())
}

#[tokio::test]
async fn a_move_interrupted_by_a_restart_carries_on_by_itself() -> Result {
    let (fleet, laptop, studio) = pair().await?;
    let bot = furnished(&laptop).await?;
    fleet.unreachable.store(true, Ordering::SeqCst);
    let (status, _) = move_bot(&laptop, &studio, &bot, "mv_4", "host-studio").await?;
    assert_eq!(status, 202);
    for _ in 0..200 {
        let shown = listed(&laptop, &bot).await?.ok_or("gone")?;
        if shown["move"]["waiting"] == true {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let laptop = laptop
        .restart(Vec::new(), vec![Script::reply("unused")])
        .await?;
    fleet.unreachable.store(false, Ordering::SeqCst);
    link(&fleet, "host-laptop", &laptop);
    assert_eq!(move_ends(&laptop, &bot).await?, Value::Null, "it finished");
    assert!(listed(&laptop, &bot).await?.is_none());
    assert!(listed(&studio, &bot).await?.is_some());
    Ok(())
}

#[tokio::test]
async fn a_commit_whose_answer_was_lost_still_finishes_the_move_once() -> Result {
    let (fleet, laptop, studio) = pair().await?;
    let bot = furnished(&laptop).await?;
    fleet.lose_commit_answer.store(true, Ordering::SeqCst);
    let (status, _) = move_bot(&laptop, &studio, &bot, "mv_5", "host-studio").await?;
    assert_eq!(status, 202);
    assert_eq!(move_ends(&laptop, &bot).await?, Value::Null);
    assert!(listed(&laptop, &bot).await?.is_none());
    let (_, all) = studio.get("/v1/agents").await?;
    let copies = all["agents"]
        .as_array()
        .map(|a| a.iter().filter(|a| a["id"] == json!(bot)).count())
        .unwrap_or(0);
    assert_eq!(copies, 1);
    Ok(())
}

#[tokio::test]
async fn api_keys_never_leave_the_machine() -> Result {
    let (fleet, laptop, studio) = pair().await?;
    let bot = furnished(&laptop).await?;
    let (status, body) = laptop
        .post(
            "/v1/endpoints",
            json!({ "name": "Paid", "format": "openai-chat", "base_url": "https://paid.example/v1/" }),
        )
        .await?;
    assert_eq!(status, 201, "{body}");
    let (status, body) = laptop
        .put("/v1/keys/paid", json!({ "key": "sk-very-secret-4242" }))
        .await?;
    assert!(status < 300, "{body}");
    let (status, body) = laptop
        .patch(
            &format!("/v1/agents/{bot}"),
            json!({ "model": "paid/model-x" }),
        )
        .await?;
    assert_eq!(status, 200, "{body}");

    move_bot(&laptop, &studio, &bot, "mv_6", "host-studio").await?;
    assert_eq!(move_ends(&laptop, &bot).await?, Value::Null);
    let carried = fleet
        .carried
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .join("\n");
    assert!(!carried.is_empty());
    assert!(!carried.contains("sk-very-secret-4242"), "a key travelled");
    let arrived = listed(&studio, &bot).await?.ok_or("not there")?;
    assert_eq!(
        arrived["model"], "paid/model-x",
        "it keeps its model choice"
    );
    assert_eq!(
        arrived["arrived"]["endpoints"],
        json!(["Paid"]),
        "and says what to add"
    );
    Ok(())
}

#[tokio::test]
async fn moving_spade_names_the_new_machine_its_host_and_the_old_ones_main_goes_quiet() -> Result {
    let (_fleet, laptop, studio) = pair().await?;
    let seed = json!({ "host": "host-laptop", "version": 1, "at": 1, "by": "seed" });
    for spade in [&laptop, &studio] {
        let (status, body) = spade.put("/v1/main/host", seed.clone()).await?;
        assert_eq!(status, 200, "{body}");
    }
    let (_, all) = laptop.get("/v1/agents").await?;
    let main = all["agents"][0].clone();
    assert_eq!(main["kind"], "main");
    let spade_id = main["id"].as_str().unwrap_or_default().to_owned();
    let (_, all) = studio.get("/v1/agents").await?;
    assert!(
        all["agents"]
            .as_array()
            .is_some_and(|a| a.iter().all(|a| a["kind"] != "main")),
        "the studio's Spade is quiet while the laptop hosts it"
    );

    let (status, started) = move_bot(&laptop, &studio, &spade_id, "mv_7", "host-studio").await?;
    assert_eq!(status, 202, "{started}");
    assert_eq!(move_ends(&laptop, &spade_id).await?, Value::Null);

    let (_, all) = studio.get("/v1/agents").await?;
    assert_eq!(
        all["agents"][0]["id"],
        json!(spade_id),
        "Spade, with its own id"
    );
    assert_eq!(all["agents"][0]["kind"], "main");
    let (_, all) = laptop.get("/v1/agents").await?;
    assert!(
        all["agents"]
            .as_array()
            .is_some_and(|a| a.iter().all(|a| a["kind"] != "main"))
    );
    let (_, here) = laptop.get("/v1/main").await?;
    let (_, there) = studio.get("/v1/main").await?;
    assert_eq!(here["host"], there["host"]);
    assert_eq!(there["host"]["host"], "host-studio");
    assert_eq!(there["host"]["version"], 2);
    assert_eq!(there["shown"], true);
    assert_eq!(here["shown"], false);
    Ok(())
}

#[tokio::test]
async fn the_old_elections_switch_off_heals_once_a_host_choice_arrives_but_the_persons_stays()
-> Result {
    let fleet = Arc::new(Fleet::default());
    let laptop = machine(
        &fleet,
        "host-laptop",
        "Laptop",
        vec![Script::reply("unused")],
    )
    .await?;
    let mains = |body: &Value| {
        body["agents"]
            .as_array()
            .map(|a| a.iter().filter(|a| a["kind"] == "main").count())
            .unwrap_or(0)
    };
    laptop.put("/v1/main", json!({ "enabled": false })).await?;
    assert_eq!(mains(&laptop.get("/v1/agents").await?.1), 0);
    let choice = json!({ "host": "host-laptop", "version": 1, "at": 5, "by": "seed" });
    laptop.put("/v1/main/host", choice).await?;
    assert_eq!(mains(&laptop.get("/v1/agents").await?.1), 1, "healed");
    // The old app's switch changes nothing now; the person's own does, and stays.
    laptop.put("/v1/main", json!({ "enabled": false })).await?;
    assert_eq!(mains(&laptop.get("/v1/agents").await?.1), 1);
    laptop
        .put("/v1/main", json!({ "enabled": false, "by": "person" }))
        .await?;
    let newer = json!({ "host": "host-laptop", "version": 2, "at": 6, "by": "person" });
    laptop.put("/v1/main/host", newer).await?;
    assert_eq!(mains(&laptop.get("/v1/agents").await?.1), 0);
    // An older record never replaces a newer one.
    let older = json!({ "host": "host-studio", "version": 1, "at": 9, "by": "seed" });
    let (_, held) = laptop.put("/v1/main/host", older).await?;
    assert_eq!(held["host"]["host"], "host-laptop");
    Ok(())
}

#[tokio::test]
async fn a_large_bot_arriving_never_holds_up_the_other_bots_requests() -> Result {
    let (_fleet, laptop, studio) = pair().await?;
    let (status, made) = laptop
        .post(
            "/v1/agents",
            json!({ "name": "Archive", "model": "fake/m" }),
        )
        .await?;
    assert_eq!(status, 201, "{made}");
    let bot = made["agent"]["id"].as_str().unwrap_or_default().to_owned();
    let conversation = made["agent"]["conversation"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    // A long history: tens of megabytes of events.
    let store = spade_store::Store::open(&laptop.database())?;
    let line = "a line of a long history ".repeat(24);
    for chunk in 0..30 {
        let events: Vec<spade_core::Event> = (0..2_000)
            .map(|i| spade_core::Event::user_message(format!("{chunk}.{i} {line}")))
            .collect();
        store.append_all(&conversation, &events, 1)?;
    }
    // A bot of the studio's own, whose requests go on meanwhile.
    let (_, local) = studio
        .post("/v1/agents", json!({ "name": "Local", "model": "fake/m" }))
        .await?;
    let local = local["agent"]["conversation"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let (status, _) = move_bot(&laptop, &studio, &bot, "mv_1", "host-studio").await?;
    assert_eq!(status, 202);
    // Meanwhile the studio keeps answering its own bot's requests, each within a bound.
    let mut slowest = Duration::ZERO;
    let mut asked = 0;
    loop {
        let started = std::time::Instant::now();
        let (status, _) = studio
            .get(&format!("/v1/conversations/{local}/events"))
            .await?;
        assert_eq!(status, 200);
        slowest = slowest.max(started.elapsed());
        asked += 1;
        let (_, view) = laptop.get(&format!("/v1/agents/{bot}/move")).await?;
        if view["move"].is_null() || view["move"]["state"] == "failed" {
            assert!(view["move"].is_null(), "{view}");
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(asked > 3, "the move was over before it could be watched");
    // Batched, the slowest wait is tens of milliseconds; one transaction for the whole
    // history holds every other request for most of a second.
    assert!(
        slowest < Duration::from_millis(400),
        "a request waited {slowest:?}"
    );
    let arrived = events(&studio, &conversation).await?;
    assert_eq!(arrived.len(), 60_001, "every event, and its arrival");
    Ok(())
}
