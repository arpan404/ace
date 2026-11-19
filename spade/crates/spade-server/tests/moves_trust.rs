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

/// What the person accepts for a move of `bot` from the laptop to the studio.
fn said(bot: &str, digest: String) -> Value {
    json!({ "bot": bot, "from": "host-laptop", "via": "host-laptop", "to": "host-studio",
        "digest": digest, "replaces": "bot" })
}

/// A manifest's hash, as the person accepts it.
fn sha(manifest: &Value) -> String {
    use sha2::Digest as _;
    sha2::Sha256::digest(manifest.to_string())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
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
        let status = accept(&studio, id, &said("a_l1", "0".repeat(64)), true).await?;
        assert!(matches!(status, 400 | 404), "accept {id:?}: {status}");
        for step in ["begin", "part", "commit", "abort", "status"] {
            let request =
                json!({ "op": "move", "step": step, "move": id, "manifest": manifest(id, "a_l1") });
            let (status, _) = deliver(&studio.base, "host-laptop", "Laptop", &request).await?;
            assert_eq!(status, 400, "{step} {id:?}");
        }
    }
    // A bot id or a machine that names a path is refused as well.
    for bot in ["..", "../a", "A_1"] {
        let status = accept(&studio, "mv_ok", &said(bot, "0".repeat(64)), true).await?;
        assert_eq!(status, 400, "{bot:?}");
    }
    let mut odd = said("a_l1", "0".repeat(64));
    odd["from"] = json!("../laptop");
    assert_eq!(accept(&studio, "mv_ok", &odd, true).await?, 400);
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
    let digest = sha(&manifest("mv_2", "a_l1"));
    // Accepted without the person's stamp, or with one over something else.
    assert_eq!(
        accept(&studio, "mv_2", &said("a_l1", digest.clone()), false).await?,
        403
    );
    let other = studio
        .http
        .put(format!("{}/v1/moves/mv_2/accept", studio.base))
        .bearer_auth(TOKEN)
        .header(
            spade_server::security::attest::HEADER,
            stamp("move:mv_2", "accept:a_l1"),
        )
        .json(&said("a_l1", digest.clone()))
        .send()
        .await?;
    assert_eq!(
        other.status().as_u16(),
        403,
        "a stamp over less than the whole move"
    );
    // For another machine.
    let mut elsewhere = said("a_l1", digest.clone());
    elsewhere["to"] = json!("host-laptop");
    assert_eq!(accept(&studio, "mv_2", &elsewhere, true).await?, 409);
    // A stamp counts once.
    let once = stamp(
        "move:mv_3",
        &format!("accept:a_l1:host-laptop:host-laptop:host-studio:{digest}:bot"),
    );
    for expected in [200, 403] {
        let answer = studio
            .http
            .put(format!("{}/v1/moves/mv_3/accept", studio.base))
            .bearer_auth(TOKEN)
            .header(spade_server::security::attest::HEADER, &once)
            .json(&said("a_l1", digest.clone()))
            .send()
            .await?;
        assert_eq!(answer.status().as_u16(), expected);
    }
    // A real move the person never accepted there waits for their say, and the bot stays.
    let (bot, _) = research(&laptop).await?;
    let (status, _) = laptop
        .post(
            &format!("/v1/agents/{bot}/move"),
            json!({ "to": "host-studio", "move": "mv_9" }),
        )
        .await?;
    assert_eq!(status, 202);
    let mut waiting = Value::Null;
    for _ in 0..200 {
        waiting = laptop.get(&format!("/v1/agents/{bot}/move")).await?.1;
        if waiting["move"]["state"] == "awaiting" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert_eq!(waiting["move"]["state"], "awaiting", "{waiting}");
    assert!(listed(&laptop, &bot).await?.is_some());
    assert!(listed(&studio, &bot).await?.is_none());
    Ok(())
}

#[tokio::test]
async fn a_move_hears_only_from_the_device_the_person_accepted_it_from() -> Result {
    let (fleet, laptop, studio) = pair().await?;
    let (bot, _) = research(&laptop).await?;
    let (status, _) = laptop
        .post(
            &format!("/v1/agents/{bot}/move"),
            json!({ "to": "host-studio", "move": "mv_1" }),
        )
        .await?;
    assert_eq!(status, 202);
    let started = support::fleet::packed(&laptop, &bot).await?;
    assert_eq!(
        started["via"], "host-laptop",
        "how the studio's daemon knows the laptop"
    );
    // The laptop can't reach the studio for now, so another machine speaks first.
    fleet.unreachable.store(true, Ordering::SeqCst);
    let accepted = support::fleet::accepting(&bot, &started, "host-studio");
    assert_eq!(accept(&studio, "mv_1", &accepted, true).await?, 200);
    // The very manifest the person accepted, byte for byte, sent by another paired machine.
    let manifest: Value = serde_json::from_str(&std::fs::read_to_string(
        laptop.dir.path().join("moves/mv_1/out/manifest.json"),
    )?)?;
    for step in ["begin", "status", "abort", "commit"] {
        let request = json!({ "op": "move", "step": step, "move": "mv_1", "manifest": manifest });
        let (status, body) = deliver(&studio.base, "host-evil", "Evil", &request).await?;
        assert_eq!(status, 403, "{step}: {body}");
    }
    // A made-up history claimed as the laptop's, but from the other device, is refused too.
    let mut fake = manifest.clone();
    fake["parts"] = json!(1);
    let begin = json!({ "op": "move", "step": "begin", "move": "mv_1", "manifest": fake });
    assert_eq!(
        deliver(&studio.base, "host-evil", "Evil", &begin).await?.0,
        403
    );
    // The move the person accepted still goes through, from the laptop, whole.
    fleet.unreachable.store(false, Ordering::SeqCst);
    assert_eq!(move_ends(&laptop, &bot).await?, Value::Null);
    assert!(listed(&studio, &bot).await?.is_some());
    Ok(())
}

#[tokio::test]
async fn spade_in_use_on_the_machine_it_moves_to_is_never_replaced() -> Result {
    let (_fleet, laptop, studio) = pair().await?;
    // Each machine thinks it hosts Spade.
    laptop
        .put(
            "/v1/main/host",
            json!({ "host": "host-laptop", "version": 1, "at": 1, "by": "seed" }),
        )
        .await?;
    studio
        .put(
            "/v1/main/host",
            json!({ "host": "host-studio", "version": 1, "at": 1, "by": "seed" }),
        )
        .await?;
    let (_, all) = studio.get("/v1/agents").await?;
    let studio_spade = all["agents"][0]["id"].clone();
    let (_, all) = laptop.get("/v1/agents").await?;
    let spade = all["agents"][0]["id"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let (status, _) = laptop
        .post(
            &format!("/v1/agents/{spade}/move"),
            json!({ "to": "host-studio", "move": "mv_1" }),
        )
        .await?;
    assert_eq!(status, 202);
    let started = support::fleet::packed(&laptop, &spade).await?;
    assert_eq!(started["replaces"], "main");
    let accepted = support::fleet::accepting(&spade, &started, "host-studio");
    assert_eq!(
        accept(&studio, "mv_1", &accepted, true).await?,
        409,
        "Spade is in use there"
    );
    // Said to be a plain bot, the manifest doesn't match what was accepted.
    let mut as_bot = accepted.clone();
    as_bot["replaces"] = json!("bot");
    assert_eq!(accept(&studio, "mv_1", &as_bot, true).await?, 200);
    let ended = move_ends(&laptop, &spade).await?;
    assert_eq!(ended["state"], "failed", "{ended}");
    let (_, all) = studio.get("/v1/agents").await?;
    assert_eq!(
        all["agents"][0]["id"], studio_spade,
        "the studio's own Spade is still there"
    );
    Ok(())
}

#[tokio::test]
async fn a_bot_arrives_on_the_auto_review_though_the_machine_it_moves_to_runs_full_access() -> Result
{
    let (_fleet, laptop, studio) = pair().await?;
    let answer = studio
        .http
        .put(format!("{}/v1/security/autonomy", studio.base))
        .bearer_auth(TOKEN)
        .header(
            spade_server::security::attest::HEADER,
            stamp("machine", "full_access"),
        )
        .json(&json!({ "autonomy": "full_access" }))
        .send()
        .await?;
    assert!(answer.status().is_success(), "{}", answer.status());
    let (bot, _) = research(&laptop).await?;
    let (status, _) = move_bot(&laptop, &studio, &bot, "mv_1", "host-studio").await?;
    assert_eq!(status, 202);
    assert_eq!(move_ends(&laptop, &bot).await?, Value::Null);
    let arrived = listed(&studio, &bot).await?.ok_or("not there")?;
    assert_eq!(arrived["autonomy"], "auto_review", "{arrived}");
    // A bot made here follows the machine: the arrival didn't change the machine.
    let (_, made) = studio
        .post("/v1/agents", json!({ "name": "Local", "model": "fake/m" }))
        .await?;
    assert_eq!(made["agent"]["autonomy"], "full_access", "{made}");
    Ok(())
}

#[tokio::test]
async fn a_begun_move_hears_only_from_its_machine_and_keeps_its_manifest() -> Result {
    let (_fleet, laptop, studio) = pair().await?;
    support::fleet::sending(&laptop, "mv_1", "a_l1", "host-laptop")?;
    let sent = manifest("mv_1", "a_l1");
    assert_eq!(
        accept(&studio, "mv_1", &said("a_l1", sha(&sent)), true).await?,
        200
    );
    let begin = json!({ "op": "move", "step": "begin", "move": "mv_1", "manifest": sent });
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
    // Refused by the inventory, or sooner, as more than the move declared.
    assert!(
        ended["problem"]
            .as_str()
            .is_some_and(|p| p.contains("inventory") || p.contains("declared")),
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
    let path = format!("/v1/agents/{bot}/move");
    let (one, two) = tokio::join!(
        laptop.post(&path, json!({ "to": "host-studio", "move": "mv_1" })),
        laptop.post(&path, json!({ "to": "host-studio", "move": "mv_2" })),
    );
    let (one, two) = (one?, two?);
    let mut statuses = [one.0, two.0];
    statuses.sort_unstable();
    assert_eq!(statuses, [202, 409]);
    let winner = if one.0 == 202 { "mv_1" } else { "mv_2" };
    let started = support::fleet::packed(&laptop, &bot).await?;
    assert_eq!(started["id"], winner);
    let accepted = support::fleet::accepting(&bot, &started, "host-studio");
    assert_eq!(accept(&studio, winner, &accepted, true).await?, 200);
    assert_eq!(move_ends(&laptop, &bot).await?, Value::Null);
    let (_, all) = studio.get("/v1/agents").await?;
    let copies = all["agents"]
        .as_array()
        .map(|a| a.iter().filter(|a| a["id"] == json!(bot)).count())
        .unwrap_or(0);
    assert_eq!(copies, 1);
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
    assert_eq!(kept["autonomy"], "auto_review", "{kept}");
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
async fn a_moved_away_bots_archive_goes_after_thirty_days_without_a_restart() -> Result {
    let fleet = Arc::new(Fleet::default());
    let limits = spade_server::engine::Limits {
        archive_sweep: Duration::from_millis(50),
        ..spade_server::engine::Limits::default()
    };
    let laptop = support::fleet::machine_with(
        &fleet,
        "host-laptop",
        "Laptop",
        vec![Script::reply("unused")],
        limits,
    )
    .await?;
    let studio = machine(
        &fleet,
        "host-studio",
        "Studio",
        vec![Script::reply("unused")],
    )
    .await?;
    let (bot, _) = research(&laptop).await?;
    let (status, _) = move_bot(&laptop, &studio, &bot, "mv_1", "host-studio").await?;
    assert_eq!(status, 202);
    assert_eq!(move_ends(&laptop, &bot).await?, Value::Null);
    let archive = laptop.dir.path().join("moved").join("mv_1");
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(archive.exists(), "kept while it is young, sweep or not");
    // Ended a month ago, as far as this machine's records go.
    let store = Store::open(&laptop.database())?;
    let ended = store.stored_move("mv_1")?.ok_or("no move")?;
    let month_ago = ended.updated_ms - 31 * 24 * 60 * 60_000;
    store.set_move("mv_1", &ended.state, &ended.detail, month_ago)?;
    for _ in 0..200 {
        if !archive.exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(
        !archive.exists(),
        "gone after thirty days, the server still running"
    );
    Ok(())
}

#[tokio::test]
async fn a_move_past_its_limits_or_past_what_it_declared_is_refused_and_its_staging_removed()
-> Result {
    let (_fleet, laptop, studio) = pair().await?;
    let mut begun = 0;
    let mut begin = |change: &dyn Fn(&mut Value)| {
        begun += 1;
        let id = format!("mv_{begun}");
        let mut sent = manifest(&id, "a_l1");
        change(&mut sent);
        (id, sent)
    };
    // More than a move may be, declared up front: refused before anything is staged.
    for change in [
        &(|m: &mut Value| m["parts"] = json!(100_001)) as &dyn Fn(&mut Value),
        &|m: &mut Value| m["bytes"] = json!(13u64 << 30),
        &|m: &mut Value| m["inventory"]["count"] = json!(250_001),
        &|m: &mut Value| m["inventory"]["bytes"] = json!(9u64 << 30),
        &|m: &mut Value| m["bytes"] = Value::Null,
    ] {
        let (id, sent) = begin(change);
        assert_eq!(
            accept(&studio, &id, &said("a_l1", sha(&sent)), true).await?,
            200
        );
        let request = json!({ "op": "move", "step": "begin", "move": id, "manifest": sent });
        let (status, body) = deliver(&studio.base, "host-laptop", "Laptop", &request).await?;
        assert_eq!(status, 413, "{body}");
        // An acceptance nobody used stays for the person to withdraw; nothing was staged.
        assert!(
            !studio
                .dir
                .path()
                .join("moves")
                .join(&id)
                .join("in")
                .exists(),
            "{id}"
        );
    }
    // Within limits, but sending more than it declared: given up, its staging removed.
    for part in [
        json!({ "kind": "rows", "table": "settings", "rows": [{ "key": "x".repeat(64), "value": "y" }] }),
        json!({ "kind": "inventory", "entries": [{ "kind": "image", "name": "0".repeat(64), "size": 1, "sha256": "0".repeat(64) }] }),
    ] {
        let (id, sent) = begin(&|m: &mut Value| {
            m["parts"] = json!(3);
            m["bytes"] = json!(40);
        });
        support::fleet::sending(&laptop, &id, &format!("a_{id}"), "host-laptop")?;
        assert_eq!(
            accept(&studio, &id, &said("a_l1", sha(&sent)), true).await?,
            200
        );
        let request = json!({ "op": "move", "step": "begin", "move": id, "manifest": sent });
        assert_eq!(
            deliver(&studio.base, "host-laptop", "Laptop", &request)
                .await?
                .0,
            200
        );
        let staging = studio.dir.path().join("moves").join(&id);
        assert!(staging.exists());
        let request = json!({ "op": "move", "step": "part", "move": id, "index": 0, "part": part });
        let (status, body) = deliver(&studio.base, "host-laptop", "Laptop", &request).await?;
        assert_eq!(status, 413, "{body}");
        assert!(!staging.exists(), "its staging is removed");
        let again = json!({ "op": "move", "step": "part", "move": id, "index": 1, "part": { "kind": "rows", "table": "settings", "rows": [] } });
        assert_eq!(
            deliver(&studio.base, "host-laptop", "Laptop", &again)
                .await?
                .0,
            409
        );
    }
    Ok(())
}

#[tokio::test]
async fn a_move_the_machine_it_names_never_sent_is_refused_and_the_sender_is_named_as_known()
-> Result {
    let (_fleet, laptop, studio) = pair().await?;
    // Another paired device claims to bring a bot from the laptop, and the person, reading
    // "from Laptop", accepts it with that device.
    let forged = manifest("mv_1", "a_l1");
    let mut claimed = said("a_l1", sha(&forged));
    claimed["via"] = json!("host-evil");
    assert_eq!(accept(&studio, "mv_1", &claimed, true).await?, 200);
    let begin = json!({ "op": "move", "step": "begin", "move": "mv_1", "manifest": forged });
    let (status, body) = deliver(&studio.base, "host-evil", "Laptop", &begin).await?;
    assert_eq!(status, 403, "the laptop never sent it: {body}");
    assert!(
        !studio.dir.path().join("moves/mv_1/in/parts").exists(),
        "nothing was staged"
    );
    // The laptop's own move, its device vouched for by the laptop: the sender is named as
    // this machine knows it, whatever name the request carries.
    support::fleet::sending(&laptop, "mv_2", "a_l2", "host-laptop")?;
    let sent = manifest("mv_2", "a_l2");
    assert_eq!(
        accept(&studio, "mv_2", &said("a_l2", sha(&sent)), true).await?,
        200
    );
    let begin = json!({ "op": "move", "step": "begin", "move": "mv_2", "manifest": sent });
    let (status, body) = deliver(&studio.base, "host-laptop", "Pretender", &begin).await?;
    assert_eq!(status, 200, "{body}");
    let held = Store::open(&studio.database())?
        .stored_move("mv_2")?
        .ok_or("no move")?;
    assert_eq!(held.peer_name, "Laptop");
    Ok(())
}
