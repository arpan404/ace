//! What a shared bot's steps put on the host's audit log beyond its calls (ADR 0206 §4.1), and
//! the organization's package rules (§3): a member's configure, move and delete each on the log
//! naming them, in the same write; installs and updates only as the policy allows, a version it
//! newly blocks paused (the one pause, nothing removed) and kept paused, and switches capped by
//! the member's role.

mod support;

use std::sync::Arc;

use reqwest::Method;
use serde_json::{Value, json};
use support::fleet::{Fleet, PERSON_KEY, accepting, machine, move_ends, packed};
use support::org::{
    ORG, as_member, bind, bind_directly, entries, export, member, offer, policy, shared_bot,
};
use support::packaged::{bots, install, move_to, secured, secured_with_person, text};
use support::{Result, Spade};

/// The one entry of `action` in `spade`'s log.
async fn the_entry(spade: &Spade, action: &str) -> Result<Value> {
    let found = entries(&export(spade).await?, action);
    assert_eq!(found.len(), 1, "{action}: {found:?}");
    Ok(found[0].clone())
}

#[tokio::test]
async fn a_shared_bots_configure_delete_and_move_are_on_the_log_naming_the_member() -> Result {
    let fleet = Arc::new(Fleet::default());
    let laptop = machine(&fleet, "host-laptop", "Acme box", vec![]).await?;
    let studio = machine(&fleet, "host-studio", "Acme spare", vec![]).await?;
    bind(&laptop, &PERSON_KEY).await?;
    bind(&studio, &PERSON_KEY).await?;
    support::fleet::lock_orgs(&fleet).insert("host-studio".to_owned(), ORG.to_owned());
    let admin = member("user_root", "admin");
    let (watcher, _) = shared_bot(&laptop, &PERSON_KEY, &admin, "CI watcher").await?;
    let (spare, _) = shared_bot(&laptop, &PERSON_KEY, &admin, "Spare").await?;

    // Renamed: what changed is named, never its value.
    let (status, body) = as_member(
        &laptop,
        &PERSON_KEY,
        Some(&admin),
        Method::PATCH,
        &format!("/v1/agents/{watcher}"),
        &json!({ "name": "CI watch" }),
    )
    .await?;
    assert_eq!(status, 200, "{body}");
    let configured = the_entry(&laptop, "bot.configured").await?;
    assert_eq!(configured["actor"]["id"], "user_root");
    assert_eq!(configured["targets"][0]["id"], watcher.as_str());
    assert_eq!(configured["metadata"]["changed"], "profile");
    // Which part changed, never what it says now.
    assert!(configured["metadata"].get("name").is_none(), "{configured}");

    // Deleted by a member who configures it: on the log with the bot it removed.
    let (status, body) = as_member(
        &laptop,
        &PERSON_KEY,
        Some(&admin),
        Method::DELETE,
        &format!("/v1/agents/{spare}"),
        &Value::Null,
    )
    .await?;
    assert!((200..300).contains(&status), "{status} {body}");
    let deleted = the_entry(&laptop, "bot.deleted").await?;
    assert_eq!(deleted["actor"]["id"], "user_root");
    assert_eq!(deleted["targets"][0]["id"], spare.as_str());
    assert_eq!(deleted["targets"][0]["name"], "Spare");

    // Moved to the organization's other host by an admin, accepted there by one.
    let (status, body) = as_member(
        &laptop,
        &PERSON_KEY,
        Some(&admin),
        Method::POST,
        &format!("/v1/agents/{watcher}/move"),
        &json!({ "to": "host-studio", "move": "m1" }),
    )
    .await?;
    assert_eq!(status, 202, "{body}");
    let started = packed(&laptop, &watcher).await?;
    let (status, body) = as_member(
        &studio,
        &PERSON_KEY,
        Some(&admin),
        Method::PUT,
        "/v1/moves/m1/accept",
        &accepting(&watcher, &started, "host-studio"),
    )
    .await?;
    assert_eq!(status, 200, "{body}");
    // Done: the move is over, and the bot is the other host's now.
    let ended = move_ends(&laptop, &watcher).await?;
    assert!(ended.is_null(), "{ended}");
    let moved = the_entry(&laptop, "bot.moved").await?;
    assert_eq!(moved["actor"]["id"], "user_root");
    assert_eq!(moved["targets"][0]["id"], watcher.as_str());
    assert_eq!(
        moved["targets"][1],
        json!({ "type": "host", "id": "host-studio" })
    );
    Ok(())
}

/// The flight watcher's link as Spade shows it.
async fn link(spade: &Spade, bot: &str) -> Result<Value> {
    let (status, body) = spade.get(&format!("/v1/agents/{bot}/package")).await?;
    assert_eq!(status, 200, "{body}");
    Ok(body["package"].clone())
}

#[tokio::test]
async fn an_org_host_takes_only_the_packages_its_policy_allows_and_pauses_a_blocked_one() -> Result
{
    let spade = secured(vec![], vec![]).await?;
    bind_directly(&spade)?;
    let only_others = r#"{"packages": {"mode": "allowlist", "allow": [{"source": "market", "name": "other-bot"}]}}"#;
    assert_eq!(offer(&spade, &policy(1, only_others)).await?.0, 200);
    let (status, body) = spade.post("/v1/agents", install(json!({}), false)).await?;
    assert_eq!(status, 403, "{body}");
    assert!(text(&body["error"]).contains("allowed packages"), "{body}");
    let (_, listed) = spade.get("/v1/agents").await?;
    assert!(!listed.to_string().contains("Flight watcher"), "{listed}");

    // Listed at 1.0.0 only: it installs, on the log, and can't move on to 2.0.0.
    let first = r#"{"packages": {"mode": "allowlist", "allow": [{"source": "market", "name": "flight-watcher", "versions": ["1.0.0"]}]}}"#;
    assert_eq!(offer(&spade, &policy(2, first)).await?.0, 200);
    let (status, made) = spade.post("/v1/agents", install(json!({}), false)).await?;
    assert_eq!(status, 201, "{made}");
    let bot = text(&made["agent"]["id"]);
    let installed = the_entry(&spade, "package.installed").await?;
    assert_eq!(installed["targets"][0]["id"], bot.as_str());
    assert_eq!(installed["metadata"]["version"], "1.0.0");
    let (status, body) = spade
        .post(
            &format!("/v1/agents/{bot}/package"),
            json!({
                "recipe": support::packaged::watcher("2.0.0"),
                "package": support::packaged::package("2.0.0"),
                "envelope": support::packaged::sealed("2.0.0"),
                "transaction": "up-1",
            }),
        )
        .await?;
    assert_eq!(status, 403, "{body}");
    assert_eq!(link(&spade, &bot).await?["version"], "1.0.0");

    // Every version listed: the update lands, on the log.
    let any = r#"{"packages": {"mode": "allowlist", "allow": [{"source": "market", "name": "flight-watcher"}]}}"#;
    assert_eq!(offer(&spade, &policy(3, any)).await?.0, 200);
    move_to(&spade, &bot, "2.0.0", "up-2").await?;
    let updated = the_entry(&spade, "package.updated").await?;
    assert_eq!(updated["metadata"]["version"], "2.0.0");
    assert_eq!(updated["metadata"]["from_version"], "1.0.0");

    // Then blocked: the running bot is paused, saying why, as the policy's step; not removed,
    // and not resumed while the block stands.
    let blocked = r#"{"packages": {"block": [{"name": "flight-watcher"}]}}"#;
    // One write: when the pause can't be stored, the policy isn't applied either, and nothing
    // says it was.
    let refusing = spade_store::Store::connect(spade.database())?;
    refusing.execute_batch(
        "CREATE TRIGGER refuse_pause BEFORE INSERT ON settings \
         WHEN NEW.key = 'paused_bots' BEGIN SELECT RAISE(ABORT, 'refused for a test'); END;",
    )?;
    assert_ne!(offer(&spade, &policy(4, blocked)).await?.0, 200);
    let (_, view) = spade.get("/v1/org").await?;
    assert_eq!(view["policy"], 3, "{view}");
    assert!(link(&spade, &bot).await?["withdrawn"].is_null());
    assert!(entries(&export(&spade).await?, "package.paused").is_empty());
    refusing.execute_batch("DROP TRIGGER refuse_pause;")?;
    assert_eq!(offer(&spade, &policy(4, blocked)).await?.0, 200);
    let paused = link(&spade, &bot).await?;
    assert!(
        text(&paused["withdrawn"]["reason"]).contains("blocked flight-watcher"),
        "{paused}"
    );
    let row = bots(&spade)
        .await?
        .into_iter()
        .find(|a| a["id"] == bot.as_str())
        .unwrap_or_default();
    assert_eq!(row["state"], "paused", "{row}");
    let recorded = the_entry(&spade, "package.paused").await?;
    assert_eq!(recorded["actor"]["type"], "policy");
    let (status, _) = spade
        .delete(&format!("/v1/agents/{bot}/package/withdrawn"))
        .await?;
    assert_eq!(status, 403);
    let (status, _) = spade
        .post(&format!("/v1/agents/{bot}/resume"), json!({}))
        .await?;
    assert_eq!(status, 403);
    Ok(())
}

#[tokio::test]
async fn a_shared_bots_switch_goes_on_only_as_far_as_the_members_role_may() -> Result {
    let spade = secured_with_person(&PERSON_KEY).await?;
    bind_directly(&spade)?;
    let any = r#"{"packages": {"mode": "open"}}"#;
    assert_eq!(offer(&spade, &policy(1, any)).await?.0, 200);
    let (status, made) = spade.post("/v1/agents", install(json!({}), false)).await?;
    assert_eq!(status, 201, "{made}");
    let bot = text(&made["agent"]["id"]);
    // Mia's: she made it, so she configures it.
    let access = spade_core::org::Access::new(ORG, "user_mia");
    spade_store::Store::connect(spade.database())?.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)",
        [format!("org_bot:{bot}"), serde_json::to_string(&access)?],
    )?;
    let path = format!("/v1/agents/{bot}/package/effects");
    let on = json!({ "key": "send_as_person", "on": true });
    let mia = member("user_mia", "member");
    let (status, body) =
        as_member(&spade, &PERSON_KEY, Some(&mia), Method::PUT, &path, &on).await?;
    assert_eq!(status, 403, "{body}");
    assert!(text(&body["error"]).contains("only admins"), "{body}");
    let admin = member("user_root", "admin");
    let (status, body) =
        as_member(&spade, &PERSON_KEY, Some(&admin), Method::PUT, &path, &on).await?;
    assert_eq!(status, 200, "{body}");
    let configured = the_entry(&spade, "bot.configured").await?;
    assert_eq!(configured["actor"]["id"], "user_root");
    assert_eq!(configured["metadata"]["changed"], "effects");
    // Turning it off only narrows: Mia may.
    let off = json!({ "key": "send_as_person", "on": false });
    let (status, body) =
        as_member(&spade, &PERSON_KEY, Some(&mia), Method::PUT, &path, &off).await?;
    assert_eq!(status, 200, "{body}");
    Ok(())
}

#[tokio::test]
async fn a_bot_moving_in_on_a_version_the_policy_blocks_arrives_paused() -> Result {
    let fleet = Arc::new(Fleet::default());
    let laptop = machine(&fleet, "host-laptop", "Acme box", vec![]).await?;
    let studio = machine(&fleet, "host-studio", "Acme spare", vec![]).await?;
    for spade in [&laptop, &studio] {
        bind(spade, &PERSON_KEY).await?;
        support::market::trust(&spade.engine);
    }
    support::fleet::lock_orgs(&fleet).insert("host-studio".to_owned(), ORG.to_owned());
    let (status, made) = laptop.post("/v1/agents", install(json!({}), false)).await?;
    assert_eq!(status, 201, "{made}");
    let bot = text(&made["agent"]["id"]);
    let access = spade_core::org::Access::new(ORG, "user_root");
    spade_store::Store::connect(laptop.database())?.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)",
        [format!("org_bot:{bot}"), serde_json::to_string(&access)?],
    )?;
    // The host it moves to blocks the flight watcher; the one it leaves doesn't.
    let blocked = r#"{"packages": {"block": [{"name": "flight-watcher"}]}}"#;
    assert_eq!(offer(&studio, &policy(1, blocked)).await?.0, 200);

    let admin = member("user_root", "admin");
    let (status, body) = as_member(
        &laptop,
        &PERSON_KEY,
        Some(&admin),
        Method::POST,
        &format!("/v1/agents/{bot}/move"),
        &json!({ "to": "host-studio", "move": "m1" }),
    )
    .await?;
    assert_eq!(status, 202, "{body}");
    let started = packed(&laptop, &bot).await?;
    let (status, body) = as_member(
        &studio,
        &PERSON_KEY,
        Some(&admin),
        Method::PUT,
        "/v1/moves/m1/accept",
        &accepting(&bot, &started, "host-studio"),
    )
    .await?;
    assert_eq!(status, 200, "{body}");
    assert!(move_ends(&laptop, &bot).await?.is_null());

    // There it is paused from its first moment, saying why, as the policy's step.
    let row = bots(&studio)
        .await?
        .into_iter()
        .find(|a| a["id"] == bot.as_str())
        .unwrap_or_default();
    assert_eq!(row["state"], "paused", "{row}");
    let arrived = link(&studio, &bot).await?;
    assert!(
        text(&arrived["withdrawn"]["reason"]).contains("blocked flight-watcher"),
        "{arrived}"
    );
    let recorded = the_entry(&studio, "package.paused").await?;
    assert_eq!(recorded["actor"]["type"], "policy");
    assert_eq!(recorded["targets"][0]["id"], bot.as_str());
    let (status, _) = studio
        .post(&format!("/v1/agents/{bot}/resume"), json!({}))
        .await?;
    assert_eq!(status, 403);
    Ok(())
}
