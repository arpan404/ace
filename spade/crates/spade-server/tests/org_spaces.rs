//! Shared bots stay inside their organization's space (ADR 0206 §2.3, §8): a club takes bots of
//! one space, a contract is called only inside one, and a shared bot moves only between its
//! organization's hosts, never onto another organization's.

mod support;

use std::sync::Arc;

use reqwest::Method;
use serde_json::json;
use spade_testkit::Script;
use support::contracts::{self, calls, of_type};
use support::fleet::{Fleet, PERSON_KEY, accepting, machine, move_ends, packed};
use support::org::{ORG, as_member, bind, bind_directly, bind_to, member, shared_bot};
use support::sandbox::world;
use support::{Result, packaged::text};

const SPACES: &str = "inside one space";

#[tokio::test]
async fn a_club_takes_bots_of_one_space_and_a_shared_club_takes_member_stamps() -> Result {
    let w = world(false, vec![], |_| vec![]).await?;
    bind(&w.spade, &w.person_key).await?;
    let admin = member("user_root", "admin");
    let (ci, _) = shared_bot(&w.spade, &w.person_key, &admin, "CI watcher").await?;
    let (triage, _) = shared_bot(&w.spade, &w.person_key, &admin, "Triage").await?;
    // A shared bot with the person's own bot: refused, whichever leads.
    for lead in [&ci, &w.bot] {
        let (status, body) = w
            .spade
            .post(
                "/v1/groups",
                json!({ "name": "Ops", "lead": lead,
                        "members": [{ "agent": ci }, { "agent": w.bot }] }),
            )
            .await?;
        assert_eq!(status, 409, "{body}");
        assert!(
            text(&body["error"]).contains("A club stays inside one space"),
            "{body}"
        );
    }
    // Two of the organization's shared bots: a shared club, without Spade, the person's own.
    let (status, made) = w
        .spade
        .post(
            "/v1/groups",
            json!({ "name": "Ops", "lead": ci, "members": [{ "agent": ci }, { "agent": triage }] }),
        )
        .await?;
    assert_eq!(status, 201, "{made}");
    let club = text(&made["group"]["id"]);
    let members = made["group"]["members"].as_array().map(Vec::len);
    assert_eq!(members, Some(2), "{made}");
    // Posting takes `talk` on its lead; adding the person's bot is refused even for an admin.
    let (status, _) = w
        .spade
        .post(
            &format!("/v1/groups/{club}/messages"),
            json!({ "text": "Status?" }),
        )
        .await?;
    assert_eq!(status, 403);
    let (status, body) = as_member(
        &w.spade,
        &w.person_key,
        Some(&admin),
        Method::PATCH,
        &format!("/v1/groups/{club}"),
        &json!({ "members": [{ "agent": ci }, { "agent": triage }, { "agent": w.bot }] }),
    )
    .await?;
    assert_eq!(status, 409, "{body}");
    Ok(())
}

#[tokio::test]
async fn a_personal_bot_cant_call_a_shared_bots_contract() -> Result {
    let world = contracts::world(
        vec![calls("p1"), Script::reply("Couldn't call it.")],
        |_| vec![],
        vec![],
    )
    .await?;
    bind_directly(&world.spade)?;
    // The watcher is Acme's shared bot now; the planner stays the person's.
    world
        .spade
        .engine
        .share_new_bot(&world.watcher_id, &member("user_root", "admin"))?;
    world
        .spade
        .say(&world.planner, "What's the cheapest fare KTM to DEL?")
        .await?;
    let events = world.spade.wait_for(&world.planner, "job_finished").await?;
    let finished = of_type(&events, "job_finished");
    let told = finished.first().map(|e| e.to_string()).unwrap_or_default();
    assert!(told.contains(SPACES), "{told}");
    // The watcher was never asked.
    let theirs = world.spade.events(&world.watcher).await?;
    assert!(
        !theirs.iter().any(|e| e["type"] == "user_message"),
        "{theirs:?}"
    );
    Ok(())
}

#[tokio::test]
async fn a_shared_bot_never_moves_to_another_organizations_host() -> Result {
    let fleet = Arc::new(Fleet::default());
    let laptop = machine(&fleet, "host-laptop", "Acme box", vec![]).await?;
    let studio = machine(&fleet, "host-studio", "Other box", vec![]).await?;
    bind(&laptop, &PERSON_KEY).await?;
    bind_to(&studio, &PERSON_KEY, "org_OTHER", "Other").await?;
    let admin = member("user_root", "admin");
    let (bot, _) = shared_bot(&laptop, &PERSON_KEY, &admin, "CI watcher").await?;
    let start = |id: &str| json!({ "to": "host-studio", "move": id });
    let path = format!("/v1/agents/{bot}/move");

    // Moving it is admins': its maker as a member can't, and nobody without a stamp.
    let (status, _) = laptop.post(&path, start("m0")).await?;
    assert_eq!(status, 403);
    let maker = member("user_root", "member");
    let (status, _) = as_member(
        &laptop,
        &PERSON_KEY,
        Some(&maker),
        Method::POST,
        &path,
        &start("m0"),
    )
    .await?;
    assert_eq!(status, 403);

    // The list says the other machine is another organization's: refused before anything moves.
    support::fleet::lock_orgs(&fleet).insert("host-studio".to_owned(), "org_OTHER".to_owned());
    let (status, body) = as_member(
        &laptop,
        &PERSON_KEY,
        Some(&admin),
        Method::POST,
        &path,
        &start("m1"),
    )
    .await?;
    assert_eq!(status, 409, "{body}");
    assert!(text(&body["error"]).contains("moves only between its organization's hosts"));

    // A list that says otherwise doesn't carry it there: that host refuses it on arrival.
    support::fleet::lock_orgs(&fleet).insert("host-studio".to_owned(), ORG.to_owned());
    let (status, body) = as_member(
        &laptop,
        &PERSON_KEY,
        Some(&admin),
        Method::POST,
        &path,
        &start("m2"),
    )
    .await?;
    assert_eq!(status, 202, "{body}");
    let started = packed(&laptop, &bot).await?;
    assert!(started.is_object(), "{started}");
    let (status, body) = as_member(
        &studio,
        &PERSON_KEY,
        Some(&admin),
        Method::PUT,
        "/v1/moves/m2/accept",
        &accepting(&bot, &started, "host-studio"),
    )
    .await?;
    assert_eq!(status, 200, "{body}");
    let ended = move_ends(&laptop, &bot).await?;
    assert_eq!(ended["state"], "failed", "{ended}");
    let (_, there) = studio.get("/v1/agents").await?;
    let arrived = there["agents"]
        .as_array()
        .is_some_and(|agents| agents.iter().any(|a| a["id"] == bot.as_str()));
    assert!(!arrived, "{there}");
    Ok(())
}
