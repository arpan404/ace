//! A bot suggesting a package (ADR 0200 §8, §10 phase 2) through Spade's API: the card it shows
//! comes from the market's signed manifest, the bot can't install anything, the person's install
//! answers the card and the turn carries on, a name the market doesn't list (or a listing whose
//! signature doesn't verify) is refused to the bot, and the card survives a restart.

mod support;

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{Value, json};
use spade_server::clock::Ids;
use spade_server::engine::{MarketBots, MarketFuture};
use spade_server::packages::envelope::Envelope;
use spade_testkit::Script;
use support::packaged::{bots, install, sealed, secure, secured, text};
use support::{Options, Result, Spade};

/// Ids that never repeat a first run's, so a restarted engine never reuses one.
struct LaterIds(AtomicU64);

impl Ids for LaterIds {
    fn next(&self, prefix: &str) -> String {
        format!("{prefix}_later_{}", self.0.fetch_add(1, Ordering::SeqCst))
    }
}

/// A market that lists flight-watcher 1.0.0 and nothing else, signed by the test market's key.
struct Market;

impl MarketBots for Market {
    fn listed_bot(&self, name: &str) -> MarketFuture<'_> {
        let listed = (name == "flight-watcher").then(|| sealed("1.0.0"));
        Box::pin(async move {
            Ok(listed.map(|sealed| Envelope {
                signed: sealed["signed"].clone(),
                bot_json: text(&sealed["bot_json"]),
            }))
        })
    }
}

fn suggest(call: &str, package: &str) -> Script {
    Script::reply("").call(
        call,
        "package_suggest",
        json!({ "package": package, "why": "You check fares every morning" }),
    )
}

fn title() -> Script {
    Script::reply("").plain(r#"{"title":"Fares"}"#)
}

async fn chat(spade: &Spade) -> Result<String> {
    let agent = spade.new_agent("Travel", "").await?;
    Ok(text(&agent["conversation"]))
}

fn result(events: &[Value], call: &str) -> (String, bool) {
    events
        .iter()
        .rev()
        .find(|e| e["type"] == "tool_finished" && e["call_id"] == call)
        .map(|e| (text(&e["content"]), e["is_error"] == true))
        .unwrap_or_default()
}

fn card(events: &[Value], call: &str) -> Value {
    events
        .iter()
        .rev()
        .find(|e| e["type"] == "question_asked" && e["call_id"] == call)
        .map(|e| e["questions"][0].clone())
        .unwrap_or_default()
}

async fn market_spade(scripts: Vec<Script>) -> Result<Spade> {
    let spade = secured(scripts, Vec::new()).await?;
    spade.engine.set_market(Arc::new(Market));
    Ok(spade)
}

#[tokio::test]
async fn a_suggested_package_shows_its_signed_card_and_only_the_persons_install_answers_it()
-> Result {
    let spade = market_spade(vec![
        suggest("s1", "flight-watcher"),
        title(),
        Script::reply("Flight watcher is set up."),
    ])
    .await?;
    let chat = chat(&spade).await?;
    spade.say(&chat, "Keep an eye on fares to Tokyo").await?;
    let events = spade.wait_for(&chat, "question_asked").await?;
    let shown = card(&events, "s1");
    assert_eq!(shown["kind"], "suggest");
    assert_eq!(shown["prompt"], "You check fares every morning");
    assert_eq!(
        json!([
            shown["package"],
            shown["version"],
            shown["name"],
            shown["blurb"]
        ]),
        json!([
            "flight-watcher",
            "1.0.0",
            "Flight watcher",
            "Watches fares."
        ])
    );
    assert_eq!(
        shown["publisher"]["name"], "fares-inc",
        "the publisher is the signed manifest's"
    );
    assert_eq!(
        shown["can"],
        json!([
            "Reach api.example-fares.com",
            "Send messages as you",
            "Run on a schedule"
        ])
    );
    // The bot waits on the person, and nothing is installed by its asking.
    let (_, travel) = spade.get("/v1/agents").await?;
    let waiting = travel["agents"]
        .as_array()
        .and_then(|a| a.iter().find(|b| b["conversation"] == chat.as_str()))
        .map(|b| b["state"].clone());
    assert_eq!(waiting, Some(json!("waiting")));
    assert_eq!(bots(&spade).await?.len(), 1, "only the bot that asked");
    // An answer posted to the card isn't taken: only installing answers it.
    let (status, body) = spade
        .post(
            &format!("/v1/conversations/{chat}/questions/s1"),
            json!({ "answers": ["yes"] }),
        )
        .await?;
    assert_eq!(status, 400, "{body}");

    // The person installs it on the review: the card reads that, and the turn carries on.
    let (status, made) = spade.post("/v1/agents", install(json!({}), false)).await?;
    assert_eq!(status, 201, "{made}");
    let events = spade.wait_for(&chat, "reply_finished").await?;
    let (said, failed) = result(&events, "s1");
    assert!(!failed, "{said}");
    assert!(
        said.starts_with("The person installed Flight watcher as a new bot, Flight watcher."),
        "{said}"
    );
    let answered = events
        .iter()
        .find(|e| e["type"] == "question_answered" && e["call_id"] == "s1")
        .cloned()
        .unwrap_or_default();
    assert_eq!(answered["answers"][0]["bot"], made["agent"]["id"]);
    Ok(())
}

#[tokio::test]
async fn a_package_the_market_doesnt_list_is_refused_to_the_bot() -> Result {
    let spade = market_spade(vec![
        suggest("s1", "fare-sniper-9000"),
        title(),
        Script::reply("I couldn't find one."),
    ])
    .await?;
    let chat = chat(&spade).await?;
    spade.say(&chat, "Find me a fare bot").await?;
    let events = spade.wait_for(&chat, "reply_finished").await?;
    let (said, failed) = result(&events, "s1");
    assert!(failed);
    assert!(
        said.starts_with("There's no package called fare-sniper-9000 in the market."),
        "{said}"
    );
    assert!(
        !events.iter().any(|e| e["type"] == "question_asked"),
        "no card for a made-up package"
    );
    Ok(())
}

#[tokio::test]
async fn a_listing_whose_signature_this_spade_doesnt_trust_is_refused() -> Result {
    let spade = market_spade(vec![
        suggest("s1", "flight-watcher"),
        title(),
        Script::reply("No."),
    ])
    .await?;
    // No key this Spade trusts signed the listing.
    spade.engine.trust_market_keys(Vec::new());
    let chat = chat(&spade).await?;
    spade.say(&chat, "Watch fares").await?;
    let events = spade.wait_for(&chat, "reply_finished").await?;
    let (said, failed) = result(&events, "s1");
    assert!(failed);
    assert!(said.contains("market listing can't be trusted"), "{said}");
    Ok(())
}

#[tokio::test]
async fn a_card_left_for_later_survives_a_restart_and_the_install_arrives_as_a_late_answer()
-> Result {
    let spade = market_spade(vec![
        suggest("s1", "flight-watcher"),
        title(),
        Script::reply("I'll carry on without it."),
    ])
    .await?;
    let chat = chat(&spade).await?;
    spade.say(&chat, "Watch fares to Tokyo").await?;
    spade.wait_for(&chat, "question_asked").await?;
    let (status, body) = spade
        .post(
            &format!("/v1/conversations/{chat}/questions/s1"),
            json!({ "defer": true }),
        )
        .await?;
    assert_eq!(status, 202, "{body}");
    let events = spade.wait_for(&chat, "reply_finished").await?;
    let (said, _) = result(&events, "s1");
    assert!(
        said.starts_with("The person will look at Flight watcher later."),
        "{said}"
    );

    let spade = spade
        .restart_with(
            Vec::new(),
            vec![Script::reply("Good, it's watching now.")],
            Options {
                ids: Some(Arc::new(LaterIds(AtomicU64::new(1)))),
                ..Options::default()
            },
        )
        .await?;
    secure(&spade).await?;
    let events = spade.events(&chat).await?;
    assert_eq!(card(&events, "s1")["kind"], "suggest", "the card is kept");
    let (_, listed) = spade.get("/v1/agents").await?;
    let later = listed["agents"]
        .as_array()
        .and_then(|a| a.iter().find(|b| b["conversation"] == chat.as_str()))
        .map(|b| b["questions_for_later"].clone());
    assert_eq!(later, Some(json!(1)));

    let (status, made) = spade.post("/v1/agents", install(json!({}), false)).await?;
    assert_eq!(status, 201, "{made}");
    let events = spade.wait_for_count(&chat, "reply_finished", 2).await?;
    let late = events
        .iter()
        .find(|e| e["type"] == "question_answered" && e["call_id"] == "s1")
        .cloned()
        .unwrap_or_default();
    assert_eq!(late["late"], true, "{late}");
    // Installing it again makes a second bot and answers nothing twice.
    let mut again = install(json!({}), false);
    again["from_recipe"]["transaction"] = json!("install-2");
    let (status, body) = spade.post("/v1/agents", again).await?;
    assert_eq!(status, 201, "{body}");
    let answered = spade
        .events(&chat)
        .await?
        .iter()
        .filter(|e| e["type"] == "question_answered")
        .count();
    assert_eq!(answered, 1);
    Ok(())
}
