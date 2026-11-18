//! Moving a bot to another machine (ADR 0187): two Spades with a fake fleet of daemons between
//! them that stamps and signs each inbox request as ace does, and can lose answers, change a
//! part on the way or go offline.

mod support;

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use spade_server::clock::Ids;
use spade_server::teams::proof::inbox_proof;
use spade_server::teams::{BoxFuture, Machine, Remote, RemoteError};
use spade_testkit::Script;
use support::{Options, Result, Spade, TOKEN};

/// Both daemons' local token, in each ace home: what signs a forwarded inbox request.
const DAEMON_TOKEN: &str = "d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0";

/// Ids that never collide between the two machines, as UUIDs never do.
struct MachineIds(&'static str, AtomicU64);

impl Ids for MachineIds {
    fn next(&self, prefix: &str) -> String {
        format!(
            "{prefix}_{}{}",
            self.0,
            self.1.fetch_add(1, Ordering::SeqCst) + 1
        )
    }
}

/// What the fake daemons carry between the two Spades, and how they misbehave on purpose.
#[derive(Default)]
struct Fleet {
    /// host id → (Spade's address, machine name).
    spades: Mutex<Vec<(String, String, String)>>,
    offline: Mutex<HashSet<String>>,
    /// Listed online, but every call is lost before it arrives.
    unreachable: AtomicBool,
    /// Drops one note row from the next notes part on the way.
    change_notes: AtomicBool,
    /// Delivers the next commit, then says the connection was lost.
    lose_commit_answer: AtomicBool,
    /// Every request body carried, as sent.
    carried: Mutex<Vec<String>>,
}

/// One machine's daemon as its Spade sees it.
struct Link {
    me: String,
    fleet: Arc<Fleet>,
}

impl Remote for Link {
    fn host(&self) -> Option<String> {
        Some(self.me.clone())
    }

    fn machines(&self) -> BoxFuture<'_, std::result::Result<Vec<Machine>, RemoteError>> {
        Box::pin(async move {
            let offline = self
                .fleet
                .offline
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .clone();
            Ok(self
                .fleet
                .spades
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .iter()
                .filter(|(host, _, _)| *host != self.me)
                .map(|(host, _, name)| Machine {
                    host_id: host.clone(),
                    name: name.clone(),
                    online: !offline.contains(host),
                })
                .collect())
        })
    }

    fn call(
        &self,
        machine: &str,
        mut request: Value,
    ) -> BoxFuture<'_, std::result::Result<(u16, Value), RemoteError>> {
        let machine = machine.to_owned();
        Box::pin(async move {
            let (base, my_name) = {
                let spades = self.fleet.spades.lock().unwrap_or_else(|p| p.into_inner());
                let base = spades
                    .iter()
                    .find(|(host, _, _)| *host == machine)
                    .map(|(_, base, _)| base.clone())
                    .ok_or_else(|| RemoteError::UnknownMachine(machine.clone()))?;
                let mine = spades
                    .iter()
                    .find(|(host, _, _)| *host == self.me)
                    .map(|(_, _, name)| name.clone())
                    .unwrap_or_default();
                (base, mine)
            };
            if self.fleet.unreachable.load(Ordering::SeqCst)
                || self
                    .fleet
                    .offline
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .contains(&machine)
            {
                return Err(RemoteError::Offline);
            }
            if request["step"] == "part"
                && request["part"]["table"] == "notes"
                && self.fleet.change_notes.swap(false, Ordering::SeqCst)
                && let Some(rows) = request["part"]["rows"].as_array_mut()
            {
                rows.pop();
            }
            let body = serde_json::to_vec(&request).map_err(|_| RemoteError::Offline)?;
            self.fleet
                .carried
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .push(String::from_utf8_lossy(&body).into_owned());
            let time = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_millis() as i64);
            let proof =
                inbox_proof(DAEMON_TOKEN, time, &self.me, &my_name, &body).unwrap_or_default();
            let answer = reqwest::Client::new()
                .post(format!("{base}/v1/inbox"))
                .bearer_auth(TOKEN)
                .header("content-type", "application/json")
                .header("x-ace-from-host", &self.me)
                .header("x-ace-from-name", &my_name)
                .header("x-ace-inbox-time", time.to_string())
                .header("x-ace-inbox-proof", proof)
                .body(body)
                .send()
                .await
                .map_err(|_| RemoteError::Offline)?;
            let status = answer.status().as_u16();
            let answer = answer.json().await.unwrap_or(Value::Null);
            if request["step"] == "commit"
                && self.fleet.lose_commit_answer.swap(false, Ordering::SeqCst)
            {
                return Err(RemoteError::Disconnected);
            }
            Ok((status, answer))
        })
    }
}

/// A machine: its Spade, with ace's home holding the daemon's token, linked into the fleet.
async fn machine(
    fleet: &Arc<Fleet>,
    host: &str,
    name: &str,
    scripts: Vec<Script>,
) -> Result<Spade> {
    let home = tempfile::tempdir()?.keep();
    std::fs::write(home.join("daemon-token"), format!("{DAEMON_TOKEN}\n"))?;
    let tag = if host == "host-laptop" { "l" } else { "s" };
    let spade = Spade::start_with(
        scripts,
        Vec::new(),
        Options {
            ace_home: Some(home),
            ids: Some(Arc::new(MachineIds(tag, AtomicU64::new(0)))),
            ..Options::default()
        },
    )
    .await?;
    fleet
        .spades
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .push((host.to_owned(), spade.base.clone(), name.to_owned()));
    spade.engine.set_remote(Arc::new(Link {
        me: host.to_owned(),
        fleet: fleet.clone(),
    }));
    Ok(spade)
}

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

/// Waits until the move from `spade` ends; answers its last view (`null` once it is done).
async fn move_ends(spade: &Spade, bot: &str) -> Result<Value> {
    for _ in 0..400 {
        let (_, body) = spade.get(&format!("/v1/agents/{bot}/move")).await?;
        let state = &body["move"]["state"];
        if body["move"].is_null() || state == "failed" || state == "cancelled" {
            return Ok(body["move"].clone());
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    Err("the move never ended".into())
}

async fn events(spade: &Spade, conversation: &str) -> Result<Vec<Value>> {
    let (_, body) = spade
        .get(&format!("/v1/conversations/{conversation}/events"))
        .await?;
    Ok(body["events"].as_array().cloned().unwrap_or_default())
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

    let (status, started) = laptop
        .post(
            &format!("/v1/agents/{bot}/move"),
            json!({ "to": "host-studio" }),
        )
        .await?;
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
    assert_eq!(
        events(&studio, &conversation).await?,
        history,
        "the whole history"
    );
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

    let (status, started) = laptop
        .post(
            &format!("/v1/agents/{bot}/move"),
            json!({ "to": "host-studio" }),
        )
        .await?;
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
    let (status, _) = laptop
        .post(
            &format!("/v1/agents/{bot}/move"),
            json!({ "to": "host-studio" }),
        )
        .await?;
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
    let (status, _) = laptop
        .post(
            &format!("/v1/agents/{bot}/move"),
            json!({ "to": "host-studio" }),
        )
        .await?;
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
    {
        let mut spades = fleet.spades.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(entry) = spades.iter_mut().find(|(host, _, _)| host == "host-laptop") {
            entry.1 = laptop.base.clone();
        }
    }
    fleet.unreachable.store(false, Ordering::SeqCst);
    laptop.engine.set_remote(Arc::new(Link {
        me: "host-laptop".to_owned(),
        fleet: fleet.clone(),
    }));
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
    let (status, _) = laptop
        .post(
            &format!("/v1/agents/{bot}/move"),
            json!({ "to": "host-studio" }),
        )
        .await?;
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

    laptop
        .post(
            &format!("/v1/agents/{bot}/move"),
            json!({ "to": "host-studio" }),
        )
        .await?;
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

    let (status, started) = laptop
        .post(
            &format!("/v1/agents/{spade_id}/move"),
            json!({ "to": "host-studio" }),
        )
        .await?;
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
