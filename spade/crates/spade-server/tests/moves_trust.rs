//! A move as a compromised or confused machine of the fleet would send it (ADR 0187): ids that
//! name paths, pushes the person never accepted, steps from another machine, a swapped
//! manifest, planted files, two starts at once, files that can't be placed yet, and the
//! person's consent and secrets, which must never cross.

mod support;

use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use serde_json::{Value, json};
use spade_store::Store;
use spade_testkit::Script;
use support::fleet::{Fleet, accept, deliver, machine, move_bot, move_ends, stamp};
use support::{Result, Spade, TOKEN};

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

/// A bot with a webhook routine and a file.
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
            json!({ "name": "Hook", "instruction": "Run.", "trigger": { "kind": "webhook" } }),
        )
        .await?;
    assert_eq!(status, 201, "{body}");
    let folder = spade.dir.path().join("workspace").join(&bot).join("drafts");
    std::fs::create_dir_all(&folder)?;
    std::fs::write(folder.join("plan.md"), "# Plan\n")?;
    Ok((bot, conversation))
}

async fn listed(spade: &Spade, bot: &str) -> Result<Option<Value>> {
    let (_, body) = spade.get("/v1/agents").await?;
    Ok(body["agents"]
        .as_array()
        .and_then(|all| all.iter().find(|a| a["id"] == bot).cloned()))
}

/// What is in Spade's data folder, by name.
fn data(spade: &Spade) -> Result<Vec<String>> {
    let mut names: Vec<String> = std::fs::read_dir(spade.dir.path())?
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|name| name != "moves")
        .collect();
    names.sort();
    Ok(names)
}

/// A manifest that reads right for `bot`, with nothing in it.
fn manifest(id: &str, bot: &str) -> Value {
    json!({
        "format": "spade-move", "version": 2, "schema": Store::schema_version(),
        "move": id, "from": "host-laptop", "bot": { "id": bot, "name": "Research", "main": false },
        "agents": [bot], "tables": {}, "parts": 1,
        "inventory": { "count": 0, "bytes": 0, "sha256": "0".repeat(64) },
    })
}

#[tokio::test]
async fn a_move_id_that_names_a_path_never_touches_spades_data() -> Result {
    let (_fleet, _laptop, studio) = pair().await?;
    let before = data(&studio)?;
    let bad = [
        ".",
        "..",
        "../..",
        "../x",
        "a/b",
        "/etc",
        "a\u{0}b",
        "ａ",
        "MV_1",
        "mv 1",
        "",
        "mv.1",
        "a\\b",
        "\u{202e}mv",
    ];
    for id in bad {
        // Refused: by Spade (400), or by the router before Spade sees it (404).
        let status = accept(&studio, id, "a_l1", true).await?;
        assert!(matches!(status, 400 | 404), "accept {id:?}: {status}");
        for step in ["begin", "part", "commit", "abort", "status"] {
            let request =
                json!({ "op": "move", "step": step, "move": id, "manifest": manifest(id, "a_l1") });
            let (status, _) = deliver(&studio.base, "host-laptop", "Laptop", &request).await?;
            assert_eq!(status, 400, "{step} {id:?}");
        }
    }
    // A bot id that names a path is refused as well.
    for bot in ["..", "../a", "A_1"] {
        assert_eq!(accept(&studio, "mv_ok", bot, true).await?, 400, "{bot:?}");
    }
    assert_eq!(data(&studio)?, before, "Spade's data folder is as it was");
    assert!(studio.database().exists());
    let (status, _) = studio.get("/v1/agents").await?;
    assert_eq!(status, 200);
    Ok(())
}

#[tokio::test]
async fn a_machine_of_the_fleet_alone_cant_push_a_bot_in() -> Result {
    let (_fleet, laptop, studio) = pair().await?;
    let begin = |id: &str, bot: &str| json!({ "op": "move", "step": "begin", "move": id, "manifest": manifest(id, bot) });
    // Never accepted here.
    let (status, body) = deliver(
        &studio.base,
        "host-laptop",
        "Laptop",
        &begin("mv_1", "a_l1"),
    )
    .await?;
    assert_eq!(status, 403, "{body}");
    // Accepted without the person's stamp, or with one for another move or bot.
    assert_eq!(accept(&studio, "mv_2", "a_l1", false).await?, 403);
    let other = studio
        .http
        .put(format!("{}/v1/moves/mv_2/accept", studio.base))
        .bearer_auth(TOKEN)
        .header(
            spade_server::security::attest::HEADER,
            stamp("move:mv_2", "accept:a_l9"),
        )
        .json(&json!({ "bot": "a_l1" }))
        .send()
        .await?;
    assert_eq!(other.status().as_u16(), 403, "a stamp for another bot");
    // A stamp counts once.
    let once = stamp("move:mv_3", "accept:a_l1");
    for expected in [200, 403] {
        let answer = studio
            .http
            .put(format!("{}/v1/moves/mv_3/accept", studio.base))
            .bearer_auth(TOKEN)
            .header(spade_server::security::attest::HEADER, &once)
            .json(&json!({ "bot": "a_l1" }))
            .send()
            .await?;
        assert_eq!(answer.status().as_u16(), expected);
    }
    // Accepted for one bot, a manifest for another is refused.
    let (status, body) = deliver(
        &studio.base,
        "host-laptop",
        "Laptop",
        &begin("mv_3", "a_l7"),
    )
    .await?;
    assert_eq!(status, 403, "{body}");
    // A real move the person never accepted there fails here, and the bot stays.
    let (bot, _) = research(&laptop).await?;
    let (status, _) = laptop
        .post(
            &format!("/v1/agents/{bot}/move"),
            json!({ "to": "host-studio", "move": "mv_9" }),
        )
        .await?;
    assert_eq!(status, 202);
    let ended = move_ends(&laptop, &bot).await?;
    assert_eq!(ended["state"], "failed", "{ended}");
    assert!(
        ended["problem"]
            .as_str()
            .is_some_and(|p| p.contains("accept")),
        "{ended}"
    );
    assert!(listed(&laptop, &bot).await?.is_some());
    assert!(listed(&studio, &bot).await?.is_none());
    Ok(())
}

#[tokio::test]
async fn a_begun_move_hears_only_from_its_machine_and_keeps_its_manifest() -> Result {
    let (_fleet, _laptop, studio) = pair().await?;
    assert_eq!(accept(&studio, "mv_1", "a_l1", true).await?, 200);
    let begin = json!({ "op": "move", "step": "begin", "move": "mv_1", "manifest": manifest("mv_1", "a_l1") });
    let (status, body) = deliver(&studio.base, "host-laptop", "Laptop", &begin).await?;
    assert_eq!(status, 200, "{body}");
    for step in ["part", "commit", "abort", "status", "begin"] {
        let request = json!({ "op": "move", "step": step, "move": "mv_1", "index": 0,
            "part": { "kind": "rows", "table": "settings", "rows": [] }, "manifest": manifest("mv_1", "a_l1") });
        let (status, _) = deliver(&studio.base, "host-evil", "Evil", &request).await?;
        assert_eq!(status, 403, "{step} from another machine");
    }
    let mut swapped = manifest("mv_1", "a_l1");
    swapped["parts"] = json!(2);
    let again = json!({ "op": "move", "step": "begin", "move": "mv_1", "manifest": swapped });
    let (status, _) = deliver(&studio.base, "host-laptop", "Laptop", &again).await?;
    assert_eq!(status, 409, "another manifest for the same move");
    Ok(())
}

#[tokio::test]
async fn a_file_the_inventory_doesnt_name_is_refused_and_nothing_is_kept() -> Result {
    let (fleet, laptop, studio) = pair().await?;
    let (bot, _) = research(&laptop).await?;
    fleet.change_file_path.store(true, Ordering::SeqCst);
    let (status, _) = move_bot(&laptop, &studio, &bot, "mv_1", "host-studio").await?;
    assert_eq!(status, 202);
    let ended = move_ends(&laptop, &bot).await?;
    assert_eq!(ended["state"], "failed", "{ended}");
    assert!(
        ended["problem"]
            .as_str()
            .is_some_and(|p| p.contains("inventory")),
        "{ended}"
    );
    assert!(listed(&studio, &bot).await?.is_none());
    assert!(!studio.dir.path().join("workspace").join(&bot).exists());
    assert!(
        laptop
            .dir
            .path()
            .join("workspace")
            .join(&bot)
            .join("drafts/plan.md")
            .exists()
    );
    Ok(())
}

#[tokio::test]
async fn two_starts_of_the_same_bot_at_once_move_it_once() -> Result {
    let (_fleet, laptop, studio) = pair().await?;
    let (bot, _) = research(&laptop).await?;
    assert_eq!(accept(&studio, "mv_1", &bot, true).await?, 200);
    let path = format!("/v1/agents/{bot}/move");
    let (one, two) = tokio::join!(
        laptop.post(&path, json!({ "to": "host-studio", "move": "mv_1" })),
        laptop.post(&path, json!({ "to": "host-studio", "move": "mv_2" })),
    );
    let mut statuses = [one?.0, two?.0];
    statuses.sort_unstable();
    assert_eq!(statuses, [202, 409]);
    let _ = move_ends(&laptop, &bot).await?;
    let (_, all) = studio.get("/v1/agents").await?;
    let copies = all["agents"]
        .as_array()
        .map(|a| a.iter().filter(|a| a["id"] == json!(bot)).count())
        .unwrap_or(0);
    assert!(copies <= 1);
    Ok(())
}

#[tokio::test]
async fn files_that_cant_be_placed_yet_keep_the_bot_on_its_machine_until_they_are() -> Result {
    let (_fleet, laptop, studio) = pair().await?;
    let (bot, _) = research(&laptop).await?;
    // The studio can't make its workspace folder: something else is in its place.
    let blocker = studio.dir.path().join("workspace");
    let _ = std::fs::remove_dir_all(&blocker);
    std::fs::write(&blocker, "not a folder")?;
    let (status, _) = move_bot(&laptop, &studio, &bot, "mv_1", "host-studio").await?;
    assert_eq!(status, 202);
    let mut waiting = Value::Null;
    for _ in 0..400 {
        waiting = listed(&laptop, &bot)
            .await?
            .ok_or("the laptop let go too soon")?;
        if waiting["move"]["state"] == "committing" && waiting["move"]["waiting"] == true {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert_eq!(waiting["move"]["state"], "committing", "{waiting}");
    assert!(
        laptop.dir.path().join("workspace").join(&bot).exists(),
        "nothing archived yet"
    );
    std::fs::remove_file(&blocker)?;
    assert_eq!(
        move_ends(&laptop, &bot).await?,
        Value::Null,
        "it took once placed"
    );
    assert!(listed(&laptop, &bot).await?.is_none());
    let placed = studio
        .dir
        .path()
        .join("workspace")
        .join(&bot)
        .join("drafts/plan.md");
    assert_eq!(std::fs::read_to_string(placed)?, "# Plan\n");
    Ok(())
}

#[tokio::test]
async fn the_persons_consent_and_secrets_stay_on_the_machine_they_were_given_on() -> Result {
    let (fleet, laptop, studio) = pair().await?;
    let (bot, conversation) = research(&laptop).await?;
    let (_, routines) = laptop.get(&format!("/v1/agents/{bot}/routines")).await?;
    let secret = routines["routines"][0]["webhook"]["secret"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    assert!(!secret.is_empty(), "{routines}");
    // Grants, Full access and every app, as the person gave them on the laptop.
    let security = json!({
        "autonomy": "full_access", "full_access_confirmed": true, "toolchains": ["/opt/rust"],
        "grants": [
            { "id": "g1", "kind": "folder", "path": "/tmp", "write": true, "by": "person", "created_at": 1 },
            { "id": "g2", "kind": "git_push", "repo": "o/r", "branch": "main", "by": "person", "created_at": 1 },
        ],
    });
    Store::open(&laptop.database())?
        .set_setting(&format!("security:{bot}"), Some(&security.to_string()))?;
    let (status, body) = laptop
        .put(
            &format!("/v1/agents/{bot}/connectors"),
            json!({ "all": true }),
        )
        .await?;
    assert!(status < 300, "{body}");

    let (status, _) = move_bot(&laptop, &studio, &bot, "mv_1", "host-studio").await?;
    assert_eq!(status, 202);
    assert_eq!(move_ends(&laptop, &bot).await?, Value::Null);

    let kept: Value = Store::open(&studio.database())?
        .setting(&format!("security:{bot}"))?
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default();
    assert_eq!(kept["grants"], json!([]), "{kept}");
    assert_eq!(kept["toolchains"], json!([]));
    assert!(kept.get("autonomy").is_none_or(Value::is_null), "{kept}");
    let arrived = listed(&studio, &bot).await?.ok_or("not there")?["arrived"].clone();
    let consent = arrived["consent"].to_string();
    for named in ["/tmp", "o/r", "/opt/rust", "Full access"] {
        assert!(consent.contains(named), "{named} not named: {arrived}");
    }
    assert_eq!(arrived["apps"], json!(["every app you connected"]));
    let (_, apps) = studio.get(&format!("/v1/agents/{bot}/connectors")).await?;
    assert_eq!(apps["all"], false, "{apps}");
    // Answers given there don't count here: the conversation closes with its arrival.
    let (_, events) = studio
        .get(&format!("/v1/conversations/{conversation}/events"))
        .await?;
    let last = events
        .as_array()
        .and_then(|e| e.last().cloned())
        .unwrap_or_default();
    assert_eq!(last["event"]["type"], "arrived", "{last}");
    // The webhook's secret never travelled, isn't in the archive, and is new there.
    let carried = fleet
        .carried
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .join("\n");
    assert!(!carried.contains(&secret), "a webhook secret travelled");
    let mut archived = String::new();
    for entry in walk(&laptop.dir.path().join("moved"))? {
        archived.push_str(&String::from_utf8_lossy(&std::fs::read(entry)?));
    }
    assert!(!archived.is_empty());
    assert!(
        !archived.contains(&secret),
        "the archive keeps a webhook secret"
    );
    let (_, there) = studio.get(&format!("/v1/agents/{bot}/routines")).await?;
    let new = there["routines"][0]["webhook"]["secret"]
        .as_str()
        .unwrap_or_default();
    assert!(!new.is_empty() && new != secret);
    Ok(())
}

fn walk(root: &std::path::Path) -> Result<Vec<std::path::PathBuf>> {
    let mut files = Vec::new();
    let mut folders = vec![root.to_path_buf()];
    while let Some(folder) = folders.pop() {
        for entry in std::fs::read_dir(folder)? {
            let entry = entry?;
            if entry.file_type()?.is_dir() {
                folders.push(entry.path());
            } else {
                files.push(entry.path());
            }
        }
    }
    Ok(files)
}

#[tokio::test]
async fn a_moved_away_bots_archive_goes_after_thirty_days() -> Result {
    let (fleet, laptop, studio) = pair().await?;
    let (bot, _) = research(&laptop).await?;
    let (status, _) = move_bot(&laptop, &studio, &bot, "mv_1", "host-studio").await?;
    assert_eq!(status, 202);
    assert_eq!(move_ends(&laptop, &bot).await?, Value::Null);
    let archive = laptop.dir.path().join("moved").join("mv_1");
    assert!(archive.exists(), "kept for now");
    // Ended a month ago, as far as this machine's records go.
    let store = Store::open(&laptop.database())?;
    let ended = store.stored_move("mv_1")?.ok_or("no move")?;
    let month_ago = ended.updated_ms - 31 * 24 * 60 * 60_000;
    store.set_move("mv_1", &ended.state, &ended.detail, month_ago)?;
    let laptop = laptop
        .restart(Vec::new(), vec![Script::reply("unused")])
        .await?;
    support::fleet::link(&fleet, "host-laptop", &laptop);
    assert!(!archive.exists(), "gone after thirty days");
    Ok(())
}
