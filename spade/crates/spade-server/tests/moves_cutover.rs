//! An arrival around its cutover (ADR 0187): a machine stopped just before or just after the
//! one transaction that makes a bot its own (a lost answer included) ends with the bot on one
//! machine; Spade arriving across such a stop still starts with no apps; and a move given up
//! after its files were placed puts back exactly what it placed, none of it seen meanwhile.

mod support;

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use sha2::Digest as _;
use spade_store::Store;
use spade_testkit::Script;
use support::fleet::{Fleet, deliver, link, machine, move_bot, move_ends, offer_host};
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

/// A bot with a file in its workspace, and its conversation.
async fn research_with(spade: &Spade) -> Result<(String, String)> {
    let (status, made) = spade
        .post(
            "/v1/agents",
            json!({ "name": "Research", "model": "fake/m" }),
        )
        .await?;
    assert_eq!(status, 201, "{made}");
    let bot = made["agent"]["id"].as_str().unwrap_or_default().to_owned();
    let folder = spade.dir.path().join("workspace").join(&bot);
    std::fs::create_dir_all(folder.join("notes/deep"))?;
    std::fs::write(folder.join("notes/deep/plan.md"), "# Plan\n")?;
    let conversation = made["agent"]["conversation"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    Ok((bot, conversation))
}

async fn research(spade: &Spade) -> Result<String> {
    Ok(research_with(spade).await?.0)
}

async fn listed(spade: &Spade, bot: &str) -> Result<bool> {
    let (_, body) = spade.get("/v1/agents").await?;
    Ok(body["agents"]
        .as_array()
        .is_some_and(|all| all.iter().any(|a| a["id"] == bot)))
}

/// Stops every arrival on `spade` at `point`, as a machine that stops there.
fn stop_at(spade: &Spade, point: &'static str) {
    spade.engine.hold_arrivals_at(Arc::new(move |at: &str| {
        if at == point {
            panic!("the machine stopped at {point}");
        }
    }));
}

async fn state_of(spade: &Spade, id: &str) -> Result<Option<String>> {
    Ok(Store::open(&spade.database())?
        .stored_move(id)?
        .map(|m| m.state))
}

async fn reaches(spade: &Spade, id: &str, state: &str) -> Result {
    for _ in 0..400 {
        if state_of(spade, id).await?.as_deref() == Some(state) {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    Err(format!("{id} never read {state}").into())
}

#[tokio::test]
async fn a_machine_stopped_just_before_or_after_the_cutover_ends_with_the_bot_on_one_machine()
-> Result {
    // Before: its files placed, not yet its own. After: its own, the answer never sent (the
    // laptop's next ask hears it from what the studio stored).
    for (point, there) in [("placed", "placing"), ("committed", "committed")] {
        let (fleet, laptop, studio) = pair().await?;
        let bot = research(&laptop).await?;
        stop_at(&studio, point);
        let (status, _) = move_bot(&laptop, &studio, &bot, "mv_1", "host-studio").await?;
        assert_eq!(status, 202);
        reaches(&studio, "mv_1", there).await?;
        tokio::time::sleep(Duration::from_millis(100)).await;
        if point == "placed" {
            // Not the studio's yet, and the studio stopped: the laptop keeps it meanwhile.
            assert!(
                listed(&laptop, &bot).await?,
                "{point}: the laptop keeps it meanwhile"
            );
        }
        let studio = support::fleet::restart(&fleet, "host-studio", studio).await?;
        link(&fleet, "host-studio", &studio);
        assert_eq!(move_ends(&laptop, &bot).await?, Value::Null, "{point}");
        assert!(listed(&studio, &bot).await?, "{point}: the studio has it");
        assert!(
            !listed(&laptop, &bot).await?,
            "{point}: and only the studio"
        );
        assert!(
            studio
                .dir
                .path()
                .join("workspace")
                .join(&bot)
                .join("notes/deep/plan.md")
                .exists(),
            "{point}: its files, nested folders and all"
        );
    }
    Ok(())
}

#[tokio::test]
async fn spade_arriving_across_a_stop_before_its_cutover_starts_with_no_apps() -> Result {
    let (fleet, laptop, studio) = pair().await?;
    let seed = json!({ "host": "host-laptop", "version": 1, "at": 1, "by": "seed" });
    for spade in [&laptop, &studio] {
        assert_eq!(offer_host(spade, &seed, true).await?.0, 200);
    }
    let (_, all) = laptop.get("/v1/agents").await?;
    let spade_id = all["agents"][0]["id"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let (_, access) = laptop
        .get(&format!("/v1/agents/{spade_id}/connectors"))
        .await?;
    assert_eq!(access["all"], true, "Spade may use every app where it is");
    // Its rows are in, nothing else yet, when the studio stops.
    stop_at(&studio, "copied");
    let (status, _) = move_bot(&laptop, &studio, &spade_id, "mv_1", "host-studio").await?;
    assert_eq!(status, 202);
    reaches(&studio, "mv_1", "placing").await?;
    let studio = support::fleet::restart(&fleet, "host-studio", studio).await?;
    link(&fleet, "host-studio", &studio);
    assert_eq!(move_ends(&laptop, &spade_id).await?, Value::Null);
    let (_, access) = studio
        .get(&format!("/v1/agents/{spade_id}/connectors"))
        .await?;
    assert_eq!(access["all"], false, "{access}");
    assert_eq!(access["connectors"], json!([]));
    let (_, there) = studio.get("/v1/main").await?;
    assert_eq!(there["host"]["host"], "host-studio");
    assert_eq!(there["host"]["version"], 2);
    Ok(())
}

fn png(seed: u8) -> Vec<u8> {
    let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    bytes.extend(std::iter::repeat_n(seed, 64));
    bytes
}

fn sha(bytes: &[u8]) -> String {
    sha2::Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[tokio::test]
async fn a_move_given_up_after_its_files_were_placed_puts_back_exactly_those_unseen_meanwhile()
-> Result {
    let (_fleet, laptop, studio) = pair().await?;
    let (bot, conversation) = research_with(&laptop).await?;
    // It brings two images: one the studio already has, one it doesn't.
    let (known, fresh) = (png(1), png(2));
    for image in [&known, &fresh] {
        std::fs::write(laptop.dir.path().join("images").join(sha(image)), image)?;
    }
    std::fs::write(studio.dir.path().join("images").join(sha(&known)), &known)?;
    let store = Store::open(&laptop.database())?;
    let shown = |hash: String| {
        spade_core::Event::from_json(json!({ "type": "picture_shown", "sha256": hash }))
    };
    store.append_all(&conversation, &[shown(sha(&known)), shown(sha(&fresh))], 2)?;
    // A folder of no bot's, where the bot's goes on the studio.
    let orphan = studio.dir.path().join("workspace").join(&bot);
    std::fs::create_dir_all(&orphan)?;
    std::fs::write(orphan.join("old.md"), "kept\n")?;
    // The studio places its files, then stops before its cutover.
    stop_at(&studio, "placed");
    let (status, _) = move_bot(&laptop, &studio, &bot, "mv_1", "host-studio").await?;
    assert_eq!(status, 202);
    reaches(&studio, "mv_1", "placing").await?;
    let placed = studio.dir.path().join("images").join(sha(&fresh));
    // Each placement is flushed to disk before the next: give a busy machine time.
    for _ in 0..800 {
        if placed.exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(placed.exists(), "its new image is in place");
    let (status, _) = studio.get(&format!("/v1/images/{}", sha(&fresh))).await?;
    assert_eq!(status, 404, "and read by nobody before it is the studio's");
    let (status, _) = studio.get(&format!("/v1/images/{}", sha(&known))).await?;
    assert_eq!(status, 200, "one the studio had stays its own");
    // Given up: what it placed goes back, nothing else.
    let abort = json!({ "op": "move", "step": "abort", "move": "mv_1" });
    let (status, body) = deliver(&studio.base, "host-laptop", "Laptop", &abort).await?;
    assert_eq!(status, 200, "{body}");
    assert_eq!(state_of(&studio, "mv_1").await?.as_deref(), Some("aborted"));
    assert!(!placed.exists(), "the image it added is gone");
    assert!(
        studio.dir.path().join("images").join(sha(&known)).exists(),
        "the one the studio had stays"
    );
    assert_eq!(std::fs::read_to_string(orphan.join("old.md"))?, "kept\n");
    assert!(
        !orphan.join("notes").exists(),
        "its folder is back as it was"
    );
    assert!(!listed(&studio, &bot).await?);
    let (status, _) = studio.get(&format!("/v1/images/{}", sha(&known))).await?;
    assert_eq!(status, 200);
    assert!(listed(&laptop, &bot).await?);
    Ok(())
}

#[tokio::test]
async fn a_commit_answered_with_errors_keeps_the_bot_frozen_until_the_studio_says_it_took() -> Result
{
    let (fleet, laptop, studio) = pair().await?;
    let (bot, conversation) = research_with(&laptop).await?;
    // The commit is delivered, but its answer, and the next few, are a 500.
    fleet
        .garble_answers
        .store(3, std::sync::atomic::Ordering::SeqCst);
    let (status, _) = move_bot(&laptop, &studio, &bot, "mv_1", "host-studio").await?;
    assert_eq!(status, 202);
    reaches(&studio, "mv_1", "committed").await?;
    let (_, view) = laptop.get(&format!("/v1/agents/{bot}/move")).await?;
    if !view["move"].is_null() {
        // Still asking: the bot isn't let go meanwhile.
        let (status, _) = laptop
            .post(
                &format!("/v1/conversations/{conversation}/messages"),
                json!({ "text": "Hi" }),
            )
            .await?;
        assert_eq!(status, 409, "frozen while it asks: {view}");
    }
    assert_eq!(
        move_ends(&laptop, &bot).await?,
        Value::Null,
        "it finished, never failed"
    );
    assert!(listed(&studio, &bot).await?);
    assert!(!listed(&laptop, &bot).await?);
    Ok(())
}

#[tokio::test]
async fn a_machine_stopped_while_giving_a_move_up_carries_on_giving_it_up() -> Result {
    let (fleet, laptop, studio) = pair().await?;
    let bot = research(&laptop).await?;
    // The studio places the files, stops before its cutover; then, giving it up, stops again
    // as the files start going back.
    studio.engine.hold_arrivals_at(Arc::new(|at: &str| {
        if at == "placed" || at == "unplacing" {
            panic!("the machine stopped at {at}");
        }
    }));
    let (status, _) = move_bot(&laptop, &studio, &bot, "mv_1", "host-studio").await?;
    assert_eq!(status, 202);
    reaches(&studio, "mv_1", "placing").await?;
    let abort = json!({ "op": "move", "step": "abort", "move": "mv_1" });
    let (status, body) = deliver(&studio.base, "host-laptop", "Laptop", &abort).await?;
    assert_eq!(status, 503, "not acknowledged before it is done: {body}");
    assert_eq!(body["state"], "aborting");
    assert_eq!(
        state_of(&studio, "mv_1").await?.as_deref(),
        Some("aborting")
    );
    let studio = support::fleet::restart(&fleet, "host-studio", studio).await?;
    link(&fleet, "host-studio", &studio);
    // Restarted, it carries on giving the move up, never placing it.
    reaches(&studio, "mv_1", "aborted").await?;
    assert!(!listed(&studio, &bot).await?);
    assert!(
        !studio.dir.path().join("workspace").join(&bot).exists(),
        "its files went back"
    );
    let ended = move_ends(&laptop, &bot).await?;
    assert_eq!(ended["state"], "failed", "{ended}");
    assert!(
        listed(&laptop, &bot).await?,
        "the bot carries on where it was"
    );
    Ok(())
}

#[tokio::test]
async fn an_image_uploaded_while_a_move_holds_it_is_the_uploads_and_outlives_the_abort() -> Result {
    let (_fleet, laptop, studio) = pair().await?;
    let (bot, conversation) = research_with(&laptop).await?;
    let fresh = png(3);
    std::fs::write(laptop.dir.path().join("images").join(sha(&fresh)), &fresh)?;
    let shown =
        spade_core::Event::from_json(json!({ "type": "picture_shown", "sha256": sha(&fresh) }));
    Store::open(&laptop.database())?.append_all(&conversation, &[shown], 2)?;
    stop_at(&studio, "placed");
    let (status, _) = move_bot(&laptop, &studio, &bot, "mv_1", "host-studio").await?;
    assert_eq!(status, 202);
    let placed = studio.dir.path().join("images").join(sha(&fresh));
    for _ in 0..800 {
        if placed.exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(placed.exists());
    // Held, in any case of its hash.
    for hash in [sha(&fresh), sha(&fresh).to_uppercase()] {
        let (status, _) = studio.get(&format!("/v1/images/{hash}")).await?;
        assert_eq!(status, 404, "{hash}");
    }
    // A bot of the studio's own sends the same picture: it is the studio's now.
    let (_, local) = studio
        .post("/v1/agents", json!({ "name": "Local", "model": "fake/m" }))
        .await?;
    let local = local["agent"]["conversation"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &fresh);
    let (status, body) = studio
        .post(
            &format!("/v1/conversations/{local}/messages"),
            json!({ "text": "Look", "images": [{ "data": format!("data:image/png;base64,{encoded}") }] }),
        )
        .await?;
    assert!(status < 300, "{body}");
    let (status, _) = studio.get(&format!("/v1/images/{}", sha(&fresh))).await?;
    assert_eq!(status, 200, "the upload's, readable");
    // The move given up: what it placed goes back, but not the studio's own picture.
    let abort = json!({ "op": "move", "step": "abort", "move": "mv_1" });
    let (status, body) = deliver(&studio.base, "host-laptop", "Laptop", &abort).await?;
    assert_eq!(status, 200, "{body}");
    assert!(placed.exists(), "the upload's picture stays");
    let (status, _) = studio.get(&format!("/v1/images/{}", sha(&fresh))).await?;
    assert_eq!(status, 200);
    Ok(())
}
