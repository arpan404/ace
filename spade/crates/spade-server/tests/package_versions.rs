//! Which version a packaged bot may move to (ADR 0200 §6.1): never one withdrawn while it had it,
//! back only to the version it had just before, and, for a step taken again after a crash or
//! held while the bot worked, only on the market's proof of that version.

mod support;

use serde_json::json;
use spade_store::Store;
use support::packaged::*;
use support::{Result, Spade};

async fn moving(spade: &Spade, bot: &str, version: &str, transaction: &str) -> Result<u16> {
    let (status, _) = spade
        .post(
            &format!("/v1/agents/{bot}/package"),
            json!({ "recipe": watcher(version), "envelope": sealed(version), "transaction": transaction }),
        )
        .await?;
    Ok(status)
}

async fn version(spade: &Spade, bot: &str) -> Result<serde_json::Value> {
    let (_, body) = spade.get(&format!("/v1/agents/{bot}/package")).await?;
    Ok(body["package"].clone())
}

#[tokio::test]
async fn a_bot_rolls_back_only_to_the_version_it_had_before() -> Result {
    let spade = secured(Vec::new(), Vec::new()).await?;
    let bot = text(&installed(&spade, hosts_on(), false).await?["id"]);
    assert_eq!(moving(&spade, &bot, "2.0.0", "u2").await?, 200);
    assert_eq!(moving(&spade, &bot, "3.0.0", "u3").await?, 200);
    // Two steps back is a version the person never approved going back to.
    assert_eq!(moving(&spade, &bot, "1.0.0", "back-two").await?, 400);
    assert_eq!(version(&spade, &bot).await?["version"], "3.0.0");
    assert_eq!(moving(&spade, &bot, "2.0.0", "back-one").await?, 200);
    assert_eq!(version(&spade, &bot).await?["version"], "2.0.0");
    Ok(())
}

#[tokio::test]
async fn a_bot_never_moves_to_a_version_withdrawn_while_it_had_it() -> Result {
    let spade = secured(Vec::new(), Vec::new()).await?;
    let bot = text(&installed(&spade, hosts_on(), false).await?["id"]);
    assert_eq!(moving(&spade, &bot, "2.0.0", "u2").await?, 200);
    let (status, _) = spade
        .post(
            &format!("/v1/agents/{bot}/package/withdrawn"),
            json!({ "reason": "It sent too many requests." }),
        )
        .await?;
    assert_eq!(status, 200);
    // The same version again doesn't end the withdrawal.
    assert_eq!(moving(&spade, &bot, "2.0.0", "again").await?, 400);
    assert!(!version(&spade, &bot).await?["withdrawn"].is_null());
    // A newer one does; going back to the withdrawn one, though it is the one before, doesn't.
    assert_eq!(moving(&spade, &bot, "3.0.0", "u3").await?, 200);
    let now = version(&spade, &bot).await?;
    assert!(now["withdrawn"].is_null(), "{now}");
    assert_eq!(moving(&spade, &bot, "2.0.0", "back").await?, 400);
    assert_eq!(version(&spade, &bot).await?["version"], "3.0.0");
    Ok(())
}

#[tokio::test]
async fn a_held_update_nothing_proves_is_never_applied_and_stays_for_the_person() -> Result {
    let spade = secured(Vec::new(), Vec::new()).await?;
    let bot = text(&installed(&spade, hosts_on(), false).await?["id"]);
    // As a build before proofs held it: the version and its manifest, nothing proving them.
    let held = spade_server::packages::held::Held {
        transaction: "held-legacy".to_owned(),
        package: serde_json::from_value(package("2.0.0"))?,
        manifest: spade_server::packages::manifest(&watcher("2.0.0"))
            .unwrap_or_else(|e| panic!("{e}")),
        time_zone: None,
        proof: None,
    };
    Store::open(&spade.database())?.set_setting(
        &spade_store::package_held_key(&bot),
        Some(&serde_json::to_string(&held)?),
    )?;
    // The next start applies held updates of bots that are still.
    let spade = spade.restart(Vec::new(), Vec::new()).await?;
    let now = version(&spade, &bot).await?;
    assert_eq!(now["version"], "1.0.0", "not applied: {now}");
    assert_eq!(
        now["held"]["version"], "2.0.0",
        "still there for the person: {now}"
    );
    Ok(())
}
