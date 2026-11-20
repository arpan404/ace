//! What holds while a bot moves (ADR 0187): one gate that nothing passes until an arriving bot
//! is this machine's, held through a restart; a worker that moves only with its maker; a move
//! that can't reach its machine in time; the person's Check again; and how many moves arrive
//! at once, with staging nobody sends to swept while Spade runs.

mod support;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::Duration;

use serde_json::{Value, json};
use spade_store::Store;
use spade_testkit::Script;
use support::fleet::{Fleet, accept, deliver, link, machine, machine_with, move_bot, move_ends};
use support::{Result, Spade};

async fn pair() -> Result<(Arc<Fleet>, Spade, Spade)> {
    let fleet = Arc::new(Fleet::default());
    let laptop = machine(
        &fleet,
        "host-laptop",
        "Laptop",
        vec![Script::reply("unused")],
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

/// A bot with a running routine, a file and a few messages.
async fn research(spade: &Spade) -> Result<(String, String)> {
    let (status, made) = spade
        .post(
            "/v1/agents",
            json!({ "name": "Research", "model": "fake/m" }),
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
            &format!("/v1/agents/{bot}/routines"),
            json!({ "name": "Digest", "instruction": "Send the digest.",
                    "trigger": { "kind": "schedule", "schedule": "every 1 minute" }, "time_zone": "UTC" }),
        )
        .await?;
    assert_eq!(status, 201, "{body}");
    let store = Store::open(&spade.database())?;
    let events: Vec<spade_core::Event> = (0..1_200)
        .map(|i| spade_core::Event::user_message(format!("note {i}")))
        .collect();
    store.append_all(&conversation, &events, 1)?;
    let folder = spade.dir.path().join("workspace").join(&bot);
    std::fs::create_dir_all(&folder)?;
    std::fs::write(folder.join("plan.md"), "# Plan\n")?;
    let (status, body) = spade
        .post(
            &format!("/v1/agents/{bot}/notes"),
            json!({ "text": "Prefers short answers." }),
        )
        .await?;
    assert!(status < 300, "{body}");
    Ok((bot, conversation))
}

/// The id of `bot`'s note on `spade`.
async fn note_of(spade: &Spade, bot: &str) -> Result<String> {
    let (_, body) = spade.get(&format!("/v1/agents/{bot}/notes")).await?;
    let notes = body["notes"]
        .as_array()
        .or(body.as_array())
        .cloned()
        .unwrap_or_default();
    Ok(notes
        .first()
        .and_then(|n| n["id"].as_str())
        .ok_or("no note")?
        .to_owned())
}

async fn listed(spade: &Spade, bot: &str) -> Result<Option<Value>> {
    let (_, body) = spade.get("/v1/agents").await?;
    Ok(body["agents"]
        .as_array()
        .and_then(|all| all.iter().find(|a| a["id"] == bot).cloned()))
}

/// Everything that could reach an arriving bot or act as it, each refused or not finding it.
async fn unreachable(studio: &Spade, bot: &str, conversation: &str, note: &str) -> Result {
    assert!(listed(studio, bot).await?.is_none(), "not listed");
    let (_, all) = studio.get("/v1/conversations").await?;
    let text = all.to_string();
    assert!(
        !text.contains(conversation),
        "no conversation list shows it: {text}"
    );
    let (status, _) = studio
        .patch(&format!("/v1/notes/{note}"), json!({ "text": "Changed." }))
        .await?;
    assert_eq!(status, 404, "its note isn't changed");
    let (status, _) = studio
        .post(&format!("/v1/notes/{note}/accept"), json!({}))
        .await?;
    assert_eq!(status, 404, "nor kept");
    let (status, _) = studio.delete(&format!("/v1/notes/{note}")).await?;
    assert_eq!(status, 404, "nor deleted");
    let (_, shared) = studio.get("/v1/notes").await?;
    assert!(!shared.to_string().contains(note), "nor listed");
    let (status, _) = studio
        .post(
            &format!("/v1/conversations/{conversation}/messages"),
            json!({ "text": "Hi" }),
        )
        .await?;
    assert_eq!(status, 404, "no message reaches it");
    let (status, _) = studio
        .get(&format!("/v1/conversations/{conversation}/events"))
        .await?;
    assert_eq!(status, 404, "nothing of it is read");
    let (status, _) = studio
        .patch(&format!("/v1/agents/{bot}"), json!({ "name": "Taken" }))
        .await?;
    assert_eq!(status, 404, "nobody acts as it");
    let (status, _) = studio.get(&format!("/v1/agents/{bot}/routines")).await?;
    assert!(status == 404 || status == 200, "{status}");
    let (_, local) = studio
        .post("/v1/agents", json!({ "name": "Local", "model": "fake/m" }))
        .await?;
    let local = local["agent"]["id"].clone();
    let (status, body) = studio
        .post(
            "/v1/groups",
            json!({ "name": "Launch", "members": [{ "agent": local }, { "agent": bot }] }),
        )
        .await?;
    assert!(status >= 400, "a club can't take it in: {status} {body}");
    Ok(())
}

#[tokio::test]
async fn a_bot_arriving_is_reached_by_nothing_while_its_rows_are_copied() -> Result {
    let (_fleet, laptop, studio) = pair().await?;
    let (bot, conversation) = research(&laptop).await?;
    let note = note_of(&laptop, &bot).await?;
    // The studio holds its copy after the bot's own row has landed, until the test lets go.
    let (held, wait) = mpsc::channel::<()>();
    let (release, released) = mpsc::channel::<()>();
    let released = Mutex::new(released);
    let batches = AtomicUsize::new(0);
    studio.engine.hold_arrivals(Arc::new(move || {
        if batches.fetch_add(1, Ordering::SeqCst) == 1 {
            let _ = held.send(());
            let _ = released
                .lock()
                .map(|r| r.recv_timeout(Duration::from_secs(30)));
        }
    }));
    let (status, _) = move_bot(&laptop, &studio, &bot, "mv_1", "host-studio").await?;
    assert_eq!(status, 202);
    tokio::task::spawn_blocking(move || wait.recv_timeout(Duration::from_secs(20))).await??;
    let store = Store::open(&studio.database())?;
    let entry = store.stored_move("mv_1")?.ok_or("no move")?;
    assert_eq!(entry.state, "activating", "held mid-copy");
    assert!(
        store.agents()?.iter().all(|a| a.id != bot),
        "copied, yet listed nowhere"
    );
    unreachable(&studio, &bot, &conversation, &note).await?;
    let _ = release.send(());
    assert_eq!(move_ends(&laptop, &bot).await?, Value::Null);
    assert!(
        listed(&studio, &bot).await?.is_some(),
        "it is the studio's now"
    );
    let (status, _) = studio
        .get(&format!("/v1/conversations/{conversation}/events"))
        .await?;
    assert_eq!(status, 200);
    let (status, _) = studio
        .patch(&format!("/v1/notes/{note}"), json!({ "text": "Changed." }))
        .await?;
    assert_eq!(status, 200, "its note is the studio's now");
    Ok(())
}

#[tokio::test]
async fn after_a_restart_mid_copy_nothing_reaches_the_bot_and_its_move_still_arrives() -> Result {
    let (fleet, laptop, studio) = pair().await?;
    let (bot, conversation) = research(&laptop).await?;
    let note = note_of(&laptop, &bot).await?;
    // The studio's copy dies after the bot's own row has landed, as in a crash.
    let batches = Arc::new(AtomicUsize::new(0));
    let counted = batches.clone();
    studio.engine.hold_arrivals(Arc::new(move || {
        if counted.fetch_add(1, Ordering::SeqCst) == 1 {
            panic!("the machine stopped mid-copy");
        }
    }));
    let (status, _) = move_bot(&laptop, &studio, &bot, "mv_1", "host-studio").await?;
    assert_eq!(status, 202);
    for _ in 0..400 {
        let entry = Store::open(&studio.database())?.stored_move("mv_1")?;
        if entry.is_some_and(|e| e.state == "activating") && batches.load(Ordering::SeqCst) > 1 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let studio = support::fleet::restart(&fleet, "host-studio", studio).await?;
    // Restarted, before anything else runs: the half-copied bot is behind the gate.
    unreachable(&studio, &bot, &conversation, &note).await?;
    // Once the studio is back in the fleet, the copy is taken out and the move arrives whole.
    link(&fleet, "host-studio", &studio);
    assert_eq!(move_ends(&laptop, &bot).await?, Value::Null);
    let arrived = listed(&studio, &bot).await?.ok_or("not there")?;
    assert_eq!(arrived["name"], "Research");
    let (_, events) = studio
        .get(&format!("/v1/conversations/{conversation}/events"))
        .await?;
    assert!(
        events.as_array().is_some_and(|e| e.len() > 1_200),
        "the whole history"
    );
    Ok(())
}

#[tokio::test]
async fn a_worker_never_moves_apart_from_its_maker_nor_while_it_works() -> Result {
    let (fleet, laptop, studio) = pair().await?;
    let (maker, maker_conversation) = research(&laptop).await?;
    let (_, made) = laptop
        .post("/v1/agents", json!({ "name": "Helper", "model": "fake/m" }))
        .await?;
    let worker = made["agent"]["id"].as_str().unwrap_or_default().to_owned();
    let worker_conversation = made["agent"]["conversation"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let link_event = spade_core::Event::from_json(json!({
        "type": "worker_of", "parent": maker, "parent_conversation": maker_conversation,
        "parent_name": "Research", "call": "c1",
    }));
    Store::open(&laptop.database())?.append(&worker_conversation, &link_event, 2)?;
    // Read again from the store, as at a start.
    let laptop = support::fleet::restart(&fleet, "host-laptop", laptop).await?;
    link(&fleet, "host-laptop", &laptop);
    // Its maker is at work while the worker is: neither moves now.
    let (status, body) = move_bot(&laptop, &studio, &maker, "mv_1", "host-studio").await?;
    assert_eq!(status, 409, "{body}");
    // The worker never moves apart from its maker.
    let (status, body) = laptop
        .post(
            &format!("/v1/agents/{worker}/move"),
            json!({ "to": "host-studio", "move": "mv_2" }),
        )
        .await?;
    assert_eq!(status, 409, "{body}");
    assert!(
        body["error"].as_str().is_some_and(|e| e.contains("worker")),
        "{body}"
    );
    assert!(listed(&laptop, &worker).await?.is_some());
    assert!(listed(&studio, &worker).await?.is_none());
    Ok(())
}

#[tokio::test]
async fn a_move_that_cant_reach_its_machine_in_time_gives_up_and_the_bot_carries_on() -> Result {
    let fleet = Arc::new(Fleet::default());
    let limits = spade_server::engine::Limits {
        move_pre_commit: Duration::from_millis(800),
        ..spade_server::engine::Limits::default()
    };
    let laptop = machine_with(
        &fleet,
        "host-laptop",
        "Laptop",
        vec![Script::reply("unused")],
        limits,
    )
    .await?;
    let _studio = machine(
        &fleet,
        "host-studio",
        "Studio",
        vec![Script::reply("unused")],
    )
    .await?;
    let (bot, conversation) = research(&laptop).await?;
    fleet
        .unreachable
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let (status, _) = laptop
        .post(
            &format!("/v1/agents/{bot}/move"),
            json!({ "to": "host-studio", "move": "mv_1" }),
        )
        .await?;
    assert_eq!(status, 202);
    let ended = move_ends(&laptop, &bot).await?;
    assert_eq!(ended["state"], "failed", "{ended}");
    assert!(
        ended["problem"]
            .as_str()
            .is_some_and(|p| p.contains("too long")),
        "{ended}"
    );
    let (status, body) = laptop
        .post(
            &format!("/v1/conversations/{conversation}/messages"),
            json!({ "text": "Still here?" }),
        )
        .await?;
    assert!(status < 300, "it carries on here: {body}");
    Ok(())
}

#[tokio::test]
async fn check_again_asks_at_once() -> Result {
    let (fleet, laptop, studio) = pair().await?;
    let (bot, _) = research(&laptop).await?;
    // The commit reaches the studio but its answer is lost, and the studio goes away a while.
    fleet.lose_commit_answer.store(true, Ordering::SeqCst);
    let (status, _) = move_bot(&laptop, &studio, &bot, "mv_1", "host-studio").await?;
    assert_eq!(status, 202);
    let mut seen = Value::Null;
    for _ in 0..400 {
        seen = laptop.get(&format!("/v1/agents/{bot}/move")).await?.1;
        if seen["move"]["state"] == "committing" {
            fleet.unreachable.store(true, Ordering::SeqCst);
            break;
        }
        if seen["move"].is_null() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    if seen["move"].is_null() {
        // The answer came back before it could be lost: nothing to check.
        return Ok(());
    }
    // Long enough for its waits to have grown past the bound below.
    tokio::time::sleep(Duration::from_secs(9)).await;
    fleet.unreachable.store(false, Ordering::SeqCst);
    let started = std::time::Instant::now();
    let (_, checked) = laptop
        .post(&format!("/v1/agents/{bot}/move/check"), json!({}))
        .await?;
    assert_eq!(checked["checking"], true);
    assert_eq!(move_ends(&laptop, &bot).await?, Value::Null);
    assert!(
        started.elapsed() < Duration::from_secs(6),
        "asked at once: {:?}",
        started.elapsed()
    );
    Ok(())
}

#[tokio::test]
async fn a_bot_whose_machine_left_after_its_commit_stays_frozen_until_the_person_keeps_it_here()
-> Result {
    let (fleet, laptop, studio) = pair().await?;
    let (bot, conversation) = research(&laptop).await?;
    fleet.lose_commit_answer.store(true, Ordering::SeqCst);
    let (status, _) = move_bot(&laptop, &studio, &bot, "mv_1", "host-studio").await?;
    assert_eq!(status, 202);
    let mut committing = false;
    for _ in 0..400 {
        let seen = laptop.get(&format!("/v1/agents/{bot}/move")).await?.1;
        if seen["move"]["state"] == "committing" {
            committing = true;
            break;
        }
        if seen["move"].is_null() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    if !committing {
        // It finished before its answer could be lost: nothing to check.
        return Ok(());
    }
    // The person removes the studio from their machines: the laptop can't learn whether the
    // move took, so the bot stays frozen, however long; nothing gives it up by itself.
    fleet
        .spades
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .retain(|(host, _, _)| host != "host-studio");
    let _ = laptop
        .post(&format!("/v1/agents/{bot}/move/check"), json!({}))
        .await?;
    let mut seen = Value::Null;
    for _ in 0..400 {
        seen = laptop.get(&format!("/v1/agents/{bot}/move")).await?.1;
        if seen["move"]["can_keep"] == true {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(seen["move"]["state"], "committing", "{seen}");
    assert_eq!(seen["move"]["can_keep"], true, "{seen}");
    tokio::time::sleep(Duration::from_millis(500)).await;
    let (status, _) = laptop
        .post(
            &format!("/v1/conversations/{conversation}/messages"),
            json!({ "text": "Hi" }),
        )
        .await?;
    assert_eq!(status, 409, "still frozen: only the person lets it go now");
    // The person keeps it here.
    let (status, body) = laptop.delete(&format!("/v1/agents/{bot}/move")).await?;
    assert!(status < 300, "{body}");
    let ended = move_ends(&laptop, &bot).await?;
    assert_eq!(ended["state"], "failed", "{ended}");
    assert!(
        ended["problem"]
            .as_str()
            .is_some_and(|p| p.starts_with("You kept")),
        "{ended}"
    );
    let (status, body) = laptop
        .post(
            &format!("/v1/conversations/{conversation}/messages"),
            json!({ "text": "Hi" }),
        )
        .await?;
    assert!(status < 300, "it carries on here: {body}");
    Ok(())
}

/// A manifest that reads right for `bot`, with nothing in it.
fn manifest(id: &str, bot: &str) -> Value {
    json!({
        "format": "spade-move", "version": 2, "schema": Store::schema_version(),
        "move": id, "from": "host-laptop", "bot": { "id": bot, "name": "Research", "main": false },
        "agents": [bot], "tables": {}, "parts": 1, "bytes": 10,
        "inventory": { "count": 0, "bytes": 0, "sha256": "0".repeat(64) },
    })
}

fn sha(manifest: &Value) -> String {
    use sha2::Digest as _;
    sha2::Sha256::digest(manifest.to_string())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[tokio::test]
async fn two_moves_arrive_at_once_at_most_and_staging_nobody_sends_to_goes_while_spade_runs()
-> Result {
    let fleet = Arc::new(Fleet::default());
    let limits = spade_server::engine::Limits {
        archive_sweep: Duration::from_millis(50),
        ..spade_server::engine::Limits::default()
    };
    let studio = machine_with(
        &fleet,
        "host-studio",
        "Studio",
        vec![Script::reply("unused")],
        limits,
    )
    .await?;
    let laptop = machine(
        &fleet,
        "host-laptop",
        "Laptop",
        vec![Script::reply("unused")],
    )
    .await?;
    let mut statuses = Vec::new();
    for n in 1..=3 {
        let (id, bot) = (format!("mv_{n}"), format!("a_l{n}"));
        support::fleet::sending(&laptop, &id, &bot, "host-laptop")?;
        let sent = manifest(&id, &bot);
        let said = json!({ "bot": bot, "from": "host-laptop", "via": "host-laptop",
            "to": "host-studio", "digest": sha(&sent), "replaces": "bot" });
        assert_eq!(accept(&studio, &id, &said, true).await?, 200);
        let begin = json!({ "op": "move", "step": "begin", "move": id, "manifest": sent });
        statuses.push(
            deliver(&studio.base, "host-laptop", "Laptop", &begin)
                .await?
                .0,
        );
    }
    assert_eq!(statuses, [200, 200, 429], "a third waits for the others");
    // Nobody sends to the first any more: a day later its staging goes, Spade still running.
    let store = Store::open(&studio.database())?;
    let entry = store.stored_move("mv_1")?.ok_or("no move")?;
    store.set_move(
        "mv_1",
        &entry.state,
        &entry.detail,
        entry.updated_ms - 2 * 24 * 60 * 60_000,
    )?;
    let staging = studio.dir.path().join("moves").join("mv_1");
    assert!(staging.exists());
    for _ in 0..200 {
        if !staging.exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(!staging.exists(), "swept while running");
    assert_eq!(
        store.stored_move("mv_1")?.map(|e| e.state),
        Some("aborted".to_owned())
    );
    Ok(())
}

#[tokio::test]
async fn an_abort_or_the_sweep_waits_for_a_commit_in_hand_and_never_removes_what_it_uses() -> Result
{
    let fleet = Arc::new(Fleet::default());
    let laptop = machine(
        &fleet,
        "host-laptop",
        "Laptop",
        vec![Script::reply("unused")],
    )
    .await?;
    let limits = spade_server::engine::Limits {
        archive_sweep: Duration::from_millis(50),
        ..spade_server::engine::Limits::default()
    };
    let studio = machine_with(
        &fleet,
        "host-studio",
        "Studio",
        vec![Script::reply("unused")],
        limits,
    )
    .await?;
    let (bot, _) = research(&laptop).await?;
    let (held, wait) = mpsc::channel::<()>();
    let (release, released) = mpsc::channel::<()>();
    let released = Mutex::new(released);
    let batches = AtomicUsize::new(0);
    studio.engine.hold_arrivals(Arc::new(move || {
        if batches.fetch_add(1, Ordering::SeqCst) == 1 {
            let _ = held.send(());
            let _ = released
                .lock()
                .map(|r| r.recv_timeout(Duration::from_secs(30)));
        }
    }));
    let (status, _) = move_bot(&laptop, &studio, &bot, "mv_1", "host-studio").await?;
    assert_eq!(status, 202);
    tokio::task::spawn_blocking(move || wait.recv_timeout(Duration::from_secs(20))).await??;
    // The commit is in hand. To the sweep the move looks a day old.
    let store = Store::open(&studio.database())?;
    let backdate = spade_store::Store::connect(studio.database())?;
    backdate.execute("UPDATE moves SET updated_ms = 0 WHERE id = 'mv_1'", [])?;
    tokio::time::sleep(Duration::from_millis(400)).await;
    let staging = studio.dir.path().join("moves/mv_1/in");
    assert!(staging.exists(), "the sweep left the staging a commit uses");
    assert_eq!(
        store.stored_move("mv_1")?.map(|m| m.state).as_deref(),
        Some("activating")
    );
    // An abort from the laptop waits for the commit, then finds it took.
    let base = studio.base.clone();
    let abort = tokio::spawn(async move {
        let request = json!({ "op": "move", "step": "abort", "move": "mv_1" });
        deliver(&base, "host-laptop", "Laptop", &request).await
    });
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert!(
        !abort.is_finished(),
        "the abort waits for the commit in hand"
    );
    assert!(staging.exists(), "nothing removed the staging meanwhile");
    let _ = release.send(());
    let (status, body) = abort.await??;
    assert_eq!(status, 409, "{body}");
    assert_eq!(move_ends(&laptop, &bot).await?, Value::Null);
    assert!(listed(&studio, &bot).await?.is_some(), "it arrived whole");
    Ok(())
}
