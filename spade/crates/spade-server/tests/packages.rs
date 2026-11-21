//! Bots from agent packages (ADR 0200 §3, §6.1) through Spade's API, as the daemon sends them
//! after the person pressed Install, Update or Roll back: a version 3 package makes a bot linked
//! to it, with its triggers paused and only the effect switches the person left on; a call
//! outside what is left on is refused before any review; an update replaces what the package
//! still owns, keeps what the person changed, and turns nothing new on; a rollback is the same
//! path back; a withdrawn version pauses its bot and deletes nothing.

mod support;

use std::sync::Arc;

use serde_json::{Value, json};
use spade_core::effect::Effect;
use spade_core::tools::Risk;
use spade_server::tools::Tool;
use spade_testkit::Script;
use support::packaged::*;
use support::{FakeTool, Result, Spade};

#[tokio::test]
async fn installing_a_package_makes_a_linked_bot_with_triggers_paused_and_only_the_switches_left_on()
-> Result {
    let spade = secured(Vec::new(), Vec::new()).await?;
    let switches = json!({ "network:hosts:api.example-fares.com": true, "send_as_person": false });
    let agent = installed(&spade, switches, false).await?;
    let bot = text(&agent["id"]);
    assert_eq!(agent["package"]["name"], "flight-watcher");
    assert_eq!(agent["package"]["version"], "1.0.0");
    assert_eq!(agent["package"]["hash"], package("1.0.0")["hash"]);
    assert_eq!(
        switches_of(&agent["package"]),
        vec![
            ("network:hosts:api.example-fares.com".to_owned(), true),
            ("send_as_person".to_owned(), false),
        ]
    );
    // Schedule, event and webhook triggers all arrive paused.
    let made = routines(&spade, &bot).await?;
    assert_eq!(made.len(), 3, "{made:?}");
    assert!(made.iter().all(|(_, paused, _)| *paused), "{made:?}");
    // The host switch the person left on is on the bot's egress allow list, recorded as theirs.
    let (_, security) = spade.get(&format!("/v1/agents/{bot}/security")).await?;
    let allow = security["network"]["allow"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    assert!(
        allow.contains(&json!("api.example-fares.com")),
        "{security}"
    );
    // The person turns the send off and on again later; only declared effects turn on.
    let (status, body) = spade
        .put(
            &format!("/v1/agents/{bot}/package/effects"),
            json!({ "key": "network:hosts:api.example-fares.com", "on": false }),
        )
        .await?;
    assert_eq!(status, 200, "{body}");
    let (_, security) = spade.get(&format!("/v1/agents/{bot}/security")).await?;
    let allow = security["network"]["allow"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    assert!(
        !allow.contains(&json!("api.example-fares.com")),
        "{security}"
    );
    let (status, _) = spade
        .put(
            &format!("/v1/agents/{bot}/package/effects"),
            json!({ "key": "publish", "on": true }),
        )
        .await?;
    assert_eq!(status, 400, "the package never declared publishing");
    Ok(())
}

#[tokio::test]
async fn a_failure_part_way_leaves_nothing_installed() -> Result {
    // No security service: the switch the person left on can't be set up once the bot exists.
    let spade = Spade::start(Vec::new(), Vec::new()).await?;
    support::market::trust(&spade.engine);
    let (status, body) = spade.post("/v1/agents", install(hosts_on(), false)).await?;
    assert_eq!(status, 400, "{body}");
    assert!(
        text(&body["error"]).contains("security isn't ready"),
        "{body}"
    );
    assert!(bots(&spade).await?.is_empty(), "the half-made bot is gone");
    // A market identity the market's signature doesn't prove is refused before anything is made.
    let mut unproven = install(json!({}), false);
    unproven.as_object_mut().map(|body| body.remove("envelope"));
    let (status, _) = spade.post("/v1/agents", unproven).await?;
    assert_eq!(status, 400);
    assert!(bots(&spade).await?.is_empty());
    Ok(())
}

#[tokio::test]
async fn a_call_outside_what_the_package_declared_and_the_person_left_on_is_refused_before_review()
-> Result {
    let tools: Vec<Arc<dyn Tool>> = vec![
        Arc::new(
            FakeTool::new("release_create", Risk::Write, "released").declares(Effect::Publish),
        ),
        Arc::new(FakeTool::new("read_board", Risk::Write, "posted").declares(Effect::Network)),
        Arc::new(FakeTool::new("mail_send", Risk::Write, "sent").declares(Effect::SendAsPerson)),
    ];
    let spade = secured(
        vec![
            // Publishing was never declared, whatever the tool is called.
            Script::reply("").call("t1", "release_create", json!({})),
            // Network was declared but the person turned it off.
            Script::reply("").call("t2", "read_board", json!({})),
            // A declared send still goes to the person.
            Script::reply("").call("t3", "mail_send", json!({ "to": "agent@example.com" })),
        ],
        tools,
    )
    .await?;
    let switches = json!({ "network:hosts:api.example-fares.com": false, "send_as_person": true });
    let agent = installed(&spade, switches, false).await?;
    let conversation = text(&agent["conversation"]);
    spade.say(&conversation, "Check the fares").await?;
    let events = spade.wait_for(&conversation, "approval_requested").await?;
    for (call, words) in [
        ("t1", "Flight watcher doesn't declare publishing."),
        (
            "t2",
            "Flight watcher doesn't declare reaching outside its own folder.",
        ),
    ] {
        let done = finished(&events, call).cloned().unwrap_or_default();
        assert!(
            done.to_string().contains(words),
            "{call} refused with its reason: {done}"
        );
    }
    let asked = events
        .iter()
        .find(|e| e["type"] == "approval_requested")
        .cloned()
        .unwrap_or_default();
    assert_eq!(asked["call_id"], "t3", "{asked}");
    Ok(())
}

#[tokio::test]
async fn an_update_turns_nothing_new_on_keeps_what_the_person_changed_and_a_rollback_goes_back()
-> Result {
    let spade = secured(Vec::new(), Vec::new()).await?;
    let agent = installed(&spade, hosts_on(), false).await?;
    let bot = text(&agent["id"]);
    // The person edits the task and writes a note of their own.
    let (status, body) = spade
        .patch(
            &format!("/v1/agents/{bot}"),
            json!({ "task": "Watch fares to Delhi only." }),
        )
        .await?;
    assert_eq!(status, 200, "{body}");
    let (status, body) = spade
        .post(
            &format!("/v1/agents/{bot}/notes"),
            json!({ "text": "The person flies from Kathmandu." }),
        )
        .await?;
    assert!(status < 300, "{body}");

    let planned = plan(&spade, &bot, "2.0.0").await?;
    assert_eq!(planned["task"], "kept", "{planned}");
    assert_eq!(planned["asks_more"], json!(["publish"]));

    let updated = move_to(&spade, &bot, "2.0.0", "update-1").await?;
    assert_eq!(updated["version"], "2.0.0");
    assert_eq!(updated["previous"]["version"], "1.0.0");
    assert_eq!(
        switches_of(&updated),
        vec![
            ("network:hosts:api.example-fares.com".to_owned(), true),
            ("send_as_person".to_owned(), true),
            // New in this version: it starts off.
            ("publish".to_owned(), false),
        ]
    );
    let listed = bots(&spade).await?;
    assert_eq!(
        text(&listed[0]["task"]),
        "Watch fares to Delhi only.",
        "the person's task stays"
    );
    assert_eq!(listed[0]["package"]["version"], "2.0.0");
    let after = routines(&spade, &bot).await?;
    assert!(
        after
            .iter()
            .any(|(name, paused, _)| name == "Evening check" && *paused),
        "a new routine starts paused: {after:?}"
    );
    assert!(
        notes(&spade, &bot)
            .await?
            .contains(&"The person flies from Kathmandu.".to_owned()),
        "the person's note is theirs"
    );
    // The same transaction again changes nothing.
    let again = move_to(&spade, &bot, "2.0.0", "update-1").await?;
    assert_eq!(again, updated);

    // Rolling back is the same path to the earlier version.
    let back = move_to(&spade, &bot, "1.0.0", "rollback-1").await?;
    assert_eq!(back["version"], "1.0.0");
    assert_eq!(back["previous"]["version"], "2.0.0");
    let restored = routines(&spade, &bot).await?;
    assert!(
        !restored.iter().any(|(name, _, _)| name == "Evening check"),
        "{restored:?}"
    );
    assert!(
        !switches_of(&back).iter().any(|(key, _)| key == "publish"),
        "what only the newer version declared is gone"
    );
    assert!(
        notes(&spade, &bot)
            .await?
            .contains(&"The person flies from Kathmandu.".to_owned())
    );
    Ok(())
}

/// The bot's row in `/v1/agents`.
async fn row(spade: &Spade, bot: &str) -> Result<Value> {
    Ok(bots(spade)
        .await?
        .into_iter()
        .find(|a| a["id"] == bot)
        .unwrap_or_default())
}

fn title() -> Script {
    Script::reply("").plain(r#"{"title":"Fares"}"#)
}

#[tokio::test]
async fn a_withdrawn_version_pauses_its_bot_with_the_one_pause_and_resume_answers_what_waited()
-> Result {
    let spade = secured(vec![Script::reply("Fares are up."), title()], Vec::new()).await?;
    let agent = installed(&spade, hosts_on(), true).await?;
    let bot = text(&agent["id"]);
    let conversation = text(&agent["conversation"]);
    let before_notes = notes(&spade, &bot).await?;
    let (status, body) = spade
        .post(
            &format!("/v1/agents/{bot}/package/withdrawn"),
            json!({ "reason": "It sent too many requests." }),
        )
        .await?;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        body["package"]["withdrawn"]["reason"],
        "It sent too many requests."
    );
    // The bot is paused as the person's Pause pauses it; its routines are left as they were.
    let listed = row(&spade, &bot).await?;
    assert_eq!(
        (&listed["state"], &listed["status"]),
        (&json!("paused"), &json!("Paused")),
        "{listed}"
    );
    let kept = routines(&spade, &bot).await?;
    assert_eq!(kept.len(), 3);
    assert!(kept.iter().all(|(_, paused, _)| !*paused), "{kept:?}");
    assert_eq!(bots(&spade).await?.len(), 1, "the bot stays");
    assert_eq!(notes(&spade, &bot).await?, before_notes);
    // A message to it waits.
    spade.say(&conversation, "Any news?").await?;
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let events = spade.events(&conversation).await?;
    assert!(
        !events.iter().any(|e| e["type"] == "reply_started"),
        "nothing answers while paused"
    );
    // The Running page's Resume ends the withdrawal's pause too: there is one pause.
    let (status, body) = spade
        .post(&format!("/v1/agents/{bot}/resume"), json!({}))
        .await?;
    assert_eq!(status, 200, "{body}");
    let events = spade.wait_for(&conversation, "reply_finished").await?;
    assert_eq!(
        events
            .iter()
            .filter(|e| e["type"] == "reply_started")
            .count(),
        1,
        "what waited is answered once"
    );
    let (_, body) = spade.get(&format!("/v1/agents/{bot}/package")).await?;
    assert!(body["package"]["withdrawn"].is_null(), "{body}");
    assert_ne!(row(&spade, &bot).await?["state"], "paused");
    Ok(())
}

#[tokio::test]
async fn resuming_a_withdrawn_bot_from_the_marketplace_is_the_same_resume() -> Result {
    let spade = secured(Vec::new(), Vec::new()).await?;
    let agent = installed(&spade, hosts_on(), false).await?;
    let bot = text(&agent["id"]);
    let (status, _) = spade
        .post(
            &format!("/v1/agents/{bot}/package/withdrawn"),
            json!({ "reason": "Withdrawn." }),
        )
        .await?;
    assert_eq!(status, 200);
    let (status, body) = spade
        .delete(&format!("/v1/agents/{bot}/package/withdrawn"))
        .await?;
    assert_eq!(status, 200, "{body}");
    assert!(body["package"]["withdrawn"].is_null(), "{body}");
    assert_ne!(row(&spade, &bot).await?["state"], "paused");
    let (_, running) = spade.get("/v1/running").await?;
    let shown = running["bots"]
        .as_array()
        .and_then(|all| all.iter().find(|r| r["id"] == bot.as_str()).cloned())
        .unwrap_or_default();
    assert_ne!(shown["reads"], "paused", "{shown}");
    Ok(())
}

fn slow_tool() -> Vec<Arc<dyn Tool>> {
    vec![Arc::new(
        FakeTool::new("pause", Risk::Read, "ok").slow(std::time::Duration::from_millis(1_500)),
    )]
}

/// Asks for the update to 2.0.0 while the bot works: held, and the profile says so.
async fn ask_while_working(spade: &Spade, bot: &str, conversation: &str) -> Result {
    spade.say(conversation, "Check the fares").await?;
    spade.wait_for(conversation, "tool_started").await?;
    let (status, body) = spade
        .post(
            &format!("/v1/agents/{bot}/package"),
            json!({ "recipe": watcher("2.0.0"), "package": package("2.0.0"), "envelope": sealed("2.0.0"), "transaction": "update-held" }),
        )
        .await?;
    assert_eq!(status, 202, "held, not refused: {body}");
    assert_eq!(body["package"]["version"], "1.0.0", "{body}");
    assert_eq!(body["package"]["held"]["version"], "2.0.0", "{body}");
    let listed = row(spade, bot).await?;
    assert_eq!(listed["package"]["held"]["version"], "2.0.0", "{listed}");
    Ok(())
}

/// Waits until the bot's package reads `version` with nothing held.
async fn moved_to(spade: &Spade, bot: &str, version: &str) -> Result<Value> {
    for _ in 0..400 {
        let (_, body) = spade.get(&format!("/v1/agents/{bot}/package")).await?;
        if body["package"]["version"] == version && body["package"]["held"].is_null() {
            return Ok(body["package"].clone());
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    Err(format!("never moved to {version}").into())
}

async fn evening_checks(spade: &Spade, bot: &str) -> Result<usize> {
    Ok(routines(spade, bot)
        .await?
        .iter()
        .filter(|(name, _, _)| name == "Evening check")
        .count())
}

#[tokio::test]
async fn an_update_asked_for_while_the_bot_works_is_held_and_applied_once_when_it_is_still()
-> Result {
    let spade = secured(
        vec![
            Script::reply("").call("t1", "pause", json!({})),
            Script::reply("Checked."),
            title(),
        ],
        slow_tool(),
    )
    .await?;
    let agent = installed(&spade, hosts_on(), false).await?;
    let bot = text(&agent["id"]);
    let conversation = text(&agent["conversation"]);
    ask_while_working(&spade, &bot, &conversation).await?;
    assert_eq!(evening_checks(&spade, &bot).await?, 0, "nothing moved yet");

    spade.wait_for(&conversation, "reply_finished").await?;
    let moved = moved_to(&spade, &bot, "2.0.0").await?;
    assert_eq!(moved["previous"]["version"], "1.0.0");
    assert_eq!(evening_checks(&spade, &bot).await?, 1);
    // Asked again, the same step does nothing twice.
    let again = move_to(&spade, &bot, "2.0.0", "update-held").await?;
    assert_eq!(again["version"], "2.0.0");
    assert_eq!(evening_checks(&spade, &bot).await?, 1);
    Ok(())
}

#[tokio::test]
async fn an_update_held_while_the_bot_works_survives_a_restart_and_applies_once() -> Result {
    let spade = secured(
        vec![Script::reply("").call("t1", "pause", json!({}))],
        slow_tool(),
    )
    .await?;
    let agent = installed(&spade, hosts_on(), false).await?;
    let bot = text(&agent["id"]);
    let conversation = text(&agent["conversation"]);
    ask_while_working(&spade, &bot, &conversation).await?;

    // Spade stops mid-turn; the turn carries on after the restart and the update waits for it.
    let spade = spade
        .restart(slow_tool(), vec![Script::reply("Checked."), title()])
        .await?;
    secure(&spade).await?;
    moved_to(&spade, &bot, "2.0.0").await?;
    assert_eq!(evening_checks(&spade, &bot).await?, 1);
    Ok(())
}

/// As a crash leaves an update to 2.0.0: the step written down, nothing of it done yet, with what
/// proved it, or (as a build before proofs wrote it) nothing.
async fn crashed_mid_update(proof: Option<Value>) -> Result<(Spade, String)> {
    let spade = Spade::start(Vec::new(), Vec::new()).await?;
    secure(&spade).await?;
    let agent = installed(&spade, hosts_on(), false).await?;
    let bot = text(&agent["id"]);
    let Some(mut link) = spade.engine.bot_package(&bot) else {
        panic!("the bot is linked");
    };
    let next =
        spade_server::packages::manifest(&watcher("2.0.0")).unwrap_or_else(|e| panic!("{e}"));
    link.pending = Some(spade_core::package::link::Pending {
        transaction: "update-crashed".to_owned(),
        package: serde_json::from_value(package("2.0.0")).unwrap_or_else(|e| panic!("{e}")),
        manifest: next,
        routines: Default::default(),
        notes_added: Vec::new(),
        notes_removed: Vec::new(),
        proof,
        code: Default::default(),
    });
    spade
        .engine
        .set_bot_package(&bot, &link)
        .unwrap_or_else(|e| panic!("{e}"));
    Ok((spade.restart(Vec::new(), Vec::new()).await?, bot))
}

#[tokio::test]
async fn an_update_a_crash_cut_short_is_taken_again_at_the_next_start() -> Result {
    let (spade, bot) = crashed_mid_update(Some(sealed("2.0.0"))).await?;
    let (_, body) = spade.get(&format!("/v1/agents/{bot}/package")).await?;
    assert_eq!(body["package"]["version"], "2.0.0", "{body}");
    assert!(body["package"]["updating"].is_null(), "{body}");
    let after = routines(&spade, &bot).await?;
    assert_eq!(
        after
            .iter()
            .filter(|(name, _, _)| name == "Evening check")
            .count(),
        1,
        "{after:?}"
    );
    Ok(())
}

#[tokio::test]
async fn an_update_cut_short_that_nothing_proves_waits_for_the_person() -> Result {
    let (spade, bot) = crashed_mid_update(None).await?;
    let (_, body) = spade.get(&format!("/v1/agents/{bot}/package")).await?;
    assert_eq!(body["package"]["version"], "1.0.0", "not taken: {body}");
    assert_eq!(body["package"]["updating"], "2.0.0", "{body}");
    assert_eq!(
        routines(&spade, &bot)
            .await?
            .iter()
            .filter(|(name, _, _)| name == "Evening check")
            .count(),
        0
    );
    // The person accepts the version again, proved: it moves.
    let moved = move_to(&spade, &bot, "2.0.0", "update-again").await?;
    assert_eq!(moved["version"], "2.0.0");
    Ok(())
}

#[tokio::test]
async fn a_packages_uses_narrows_its_bot_to_those_modules_tools() -> Result {
    let tools: Vec<Arc<dyn Tool>> = vec![
        Arc::new(FakeTool::new("web_search", Risk::Read, "found it")),
        Arc::new(FakeTool::new("noop", Risk::Read, "did nothing")),
    ];
    let spade = secured(
        vec![
            Script::reply("").call("t1", "web_search", json!({ "query": "fares" })),
            Script::reply("").call("t2", "noop", json!({})),
            Script::reply("Done."),
            Script::reply("").plain(r#"{"title":"Fares"}"#),
        ],
        tools,
    )
    .await?;
    let mut body = install(hosts_on(), false);
    body["recipe"]["uses"] = json!(["task", "memory"]);
    body["envelope"] = support::market::envelope("flight-watcher", "1.0.0", &body["recipe"]);
    body.as_object_mut().map(|body| body.remove("package"));
    let (status, made) = spade.post("/v1/agents", body).await?;
    assert_eq!(status, 201, "{made}");
    let conversation = text(&made["agent"]["conversation"]);
    spade.say(&conversation, "Check the fares").await?;
    let events = spade.wait_for(&conversation, "reply_finished").await?;
    let done = |call| finished(&events, call).cloned().unwrap_or_default();
    assert_eq!(
        done("t1")["is_error"],
        true,
        "web isn't among its modules: {}",
        done("t1")
    );
    assert_eq!(done("t2")["is_error"], false, "{}", done("t2"));
    Ok(())
}
