//! A packaged bot's ceiling through Spade's API (ADR 0200 §3.4): what its package declared and
//! the person left on bounds everything it does and everything it makes, at the gate and again
//! right before a call starts; a package's identity comes only from the market's signature over
//! its bytes; and a bot whose install never finished is never left runnable.

mod support;

use std::sync::Arc;

use serde_json::{Value, json};
use spade_core::effect::Effect;
use spade_core::tools::Risk;
use spade_server::tools::Tool;
use spade_testkit::Script;
use support::packaged::*;
use support::{FakeTool, Result, Spade};

fn standing(call: &str, name: &str) -> Script {
    Script::reply("").call(
        call,
        "call_tool",
        json!({ "name": "bot_create", "arguments": {
            "kind": "standing", "name": name, "task": "Post the fares each week." } }),
    )
}

async fn may_make_bots(spade: &Spade, bot: &str) -> Result {
    let (status, body) = spade
        .patch(
            &format!("/v1/agents/{bot}"),
            json!({ "may_create_bots": "yes" }),
        )
        .await?;
    assert_eq!(status, 200, "{body}");
    Ok(())
}

fn made(events: &[Value]) -> Option<&Value> {
    events.iter().find(|e| e["type"] == "bot_made")
}

#[tokio::test]
async fn a_packaged_bot_cant_make_a_bot_for_the_person_past_what_its_package_declared() -> Result {
    let spade = secured(
        vec![
            standing("b1", "Fare poster"),
            Script::reply("I couldn't."),
            Script::reply("").plain(r#"{"title":"Fares"}"#),
        ],
        Vec::new(),
    )
    .await?;
    // Network is declared but the person left it off.
    let switches = json!({ "network:hosts:api.example-fares.com": false, "send_as_person": true });
    let agent = installed(&spade, switches, false).await?;
    may_make_bots(&spade, &text(&agent["id"])).await?;
    let conversation = text(&agent["conversation"]);
    spade
        .say(&conversation, "Make a bot that posts fares")
        .await?;
    let events = spade.wait_for(&conversation, "reply_finished").await?;
    let done = finished(&events, "b1").cloned().unwrap_or_default();
    assert!(
        done.to_string()
            .contains("Flight watcher doesn't declare reaching outside its own folder."),
        "{done}"
    );
    assert!(made(&events).is_none(), "no bot was made");
    assert_eq!(bots(&spade).await?.len(), 1);
    Ok(())
}

#[tokio::test]
async fn a_bot_a_packaged_bot_makes_is_held_to_its_makers_package() -> Result {
    let release =
        FakeTool::new("release_create", Risk::Write, "released").declares(Effect::Publish);
    let released = release.calls();
    let tools: Vec<Arc<dyn Tool>> = vec![Arc::new(release)];
    let spade = secured(
        vec![
            standing("b1", "Fare poster"),
            Script::reply("Made it."),
            Script::reply("").plain(r#"{"title":"Fares"}"#),
            Script::reply("").call("p1", "release_create", json!({})),
            Script::reply("I can't publish."),
            Script::reply("").plain(r#"{"title":"Post"}"#),
        ],
        tools,
    )
    .await?;
    let agent = installed(&spade, hosts_on(), false).await?;
    may_make_bots(&spade, &text(&agent["id"])).await?;
    let conversation = text(&agent["conversation"]);
    spade
        .say(&conversation, "Make a bot that posts fares")
        .await?;
    let events = spade.wait_for(&conversation, "reply_finished").await?;
    let made = made(&events).cloned().unwrap_or_default();
    let poster = bots(&spade)
        .await?
        .into_iter()
        .find(|b| b["id"] == made["bot"])
        .unwrap_or_default();
    // Not a packaged bot itself, yet it can do no more than Flight watcher declared.
    assert!(poster["package"].is_null(), "{poster}");
    let chat = text(&poster["conversation"]);
    spade.say(&chat, "Publish this week's report").await?;
    let events = spade.wait_for(&chat, "reply_finished").await?;
    let done = finished(&events, "p1").cloned().unwrap_or_default();
    assert!(
        done.to_string()
            .contains("Flight watcher doesn't declare publishing."),
        "{done}"
    );
    assert!(
        released.lock().map(|c| c.is_empty()).unwrap_or(false),
        "it never ran"
    );
    Ok(())
}

#[tokio::test]
async fn a_call_allowed_while_a_switch_was_on_doesnt_run_once_the_person_turns_it_off() -> Result {
    let mail = FakeTool::new("mail_send", Risk::Write, "sent").declares(Effect::SendAsPerson);
    let sent = mail.calls();
    let spade = secured(
        vec![
            Script::reply("").call("m1", "mail_send", json!({ "to": "agent@example.com" })),
            Script::reply("Not sent."),
            Script::reply("").plain(r#"{"title":"Mail"}"#),
        ],
        vec![Arc::new(mail)],
    )
    .await?;
    let agent = installed(&spade, hosts_on(), false).await?;
    let bot = text(&agent["id"]);
    let conversation = text(&agent["conversation"]);
    spade.say(&conversation, "Mail my travel agent").await?;
    spade.wait_for(&conversation, "approval_requested").await?;
    // The person turns sending off, then answers the card that was already waiting.
    let (status, body) = spade
        .put(
            &format!("/v1/agents/{bot}/package/effects"),
            json!({ "key": "send_as_person", "on": false }),
        )
        .await?;
    assert_eq!(status, 200, "{body}");
    let (status, body) = spade
        .post(
            &format!("/v1/conversations/{conversation}/approvals/m1"),
            json!({ "allowed": true }),
        )
        .await?;
    assert_eq!(status, 202, "{body}");
    let events = spade.wait_for(&conversation, "reply_finished").await?;
    let done = finished(&events, "m1").cloned().unwrap_or_default();
    assert!(
        done.to_string()
            .contains("Flight watcher doesn't declare sending in your name."),
        "{done}"
    );
    assert!(sent.lock().map(|c| c.is_empty()).unwrap_or(false));
    Ok(())
}

#[tokio::test]
async fn a_package_that_uses_no_module_has_no_question_search_or_app_request() -> Result {
    let spade = secured(
        vec![
            Script::reply("")
                .call("q1", "ask_user", json!({ "question": "Which trip?" }))
                .call("s1", "tool_search", json!({ "query": "calendar" }))
                .call(
                    "a1",
                    "app_connect_request",
                    json!({ "app": "notion", "why": "Notes." }),
                ),
            Script::reply("Done."),
            Script::reply("").plain(r#"{"title":"Trips"}"#),
        ],
        Vec::new(),
    )
    .await?;
    let mut body = install(hosts_on(), false);
    body["recipe"]["uses"] = json!([]);
    body["envelope"] = support::market::envelope("flight-watcher", "1.0.0", &body["recipe"]);
    body.as_object_mut().map(|body| body.remove("package"));
    let (status, made) = spade.post("/v1/agents", body).await?;
    assert_eq!(status, 201, "{made}");
    let conversation = text(&made["agent"]["conversation"]);
    spade.say(&conversation, "Plan my trip").await?;
    let events = spade.wait_for(&conversation, "reply_finished").await?;
    for call in ["q1", "s1", "a1"] {
        let done = finished(&events, call).cloned().unwrap_or_default();
        assert_eq!(done["is_error"], true, "{call}: {done}");
        assert!(
            done.to_string().contains("doesn't use the module"),
            "{call}: {done}"
        );
    }
    assert!(
        !events.iter().any(|e| e["type"] == "question_asked"),
        "no card was shown"
    );
    Ok(())
}

#[tokio::test]
async fn without_the_markets_signature_a_package_installs_as_local_and_claims_no_identity() -> Result
{
    let spade = secured(Vec::new(), Vec::new()).await?;
    // Another package's signature, or one over other bytes, proves nothing.
    let mut forged = install(hosts_on(), false);
    forged["envelope"]["bot_json"] =
        json!(serde_json::to_string_pretty(&json!({ "name": "Mail reader" })).unwrap_or_default());
    let (status, body) = spade.post("/v1/agents", forged).await?;
    assert_eq!(status, 400, "{body}");
    let mut claimed = install(hosts_on(), false);
    claimed["package"]["version"] = json!("9.9.9");
    let (status, body) = spade.post("/v1/agents", claimed).await?;
    assert_eq!(status, 400, "{body}");
    assert!(bots(&spade).await?.is_empty());
    // No identity at all: a local package, linked so its ceiling holds, never a market one.
    let mut local = install(hosts_on(), false);
    local.as_object_mut().map(|body| {
        body.remove("package");
        body.remove("envelope");
    });
    let (status, made) = spade.post("/v1/agents", local).await?;
    assert_eq!(status, 201, "{made}");
    let identity = &made["agent"]["package"];
    assert_eq!(identity["source"], "local", "{identity}");
    assert_eq!(identity["name"], "local/flight-watcher", "{identity}");
    assert_eq!(identity["version"], "local", "{identity}");
    let bot = text(&made["agent"]["id"]);
    // It moves between local versions only, never onto a market identity.
    let (status, body) = spade
        .post(
            &format!("/v1/agents/{bot}/package"),
            json!({ "recipe": watcher("2.0.0"), "package": package("2.0.0"), "transaction": "u1" }),
        )
        .await?;
    assert_eq!(status, 400, "{body}");
    let (status, body) = spade
        .post(
            &format!("/v1/agents/{bot}/package"),
            json!({ "recipe": watcher("2.0.0"), "envelope": sealed("2.0.0"), "transaction": "u2" }),
        )
        .await?;
    assert_eq!(status, 400, "{body}");
    let (status, body) = spade
        .post(
            &format!("/v1/agents/{bot}/package"),
            json!({ "recipe": watcher("2.0.0"), "transaction": "u3" }),
        )
        .await?;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["package"]["version"], "local");
    Ok(())
}

#[tokio::test]
async fn a_market_bot_updates_only_to_a_version_the_market_signed() -> Result {
    let spade = secured(Vec::new(), Vec::new()).await?;
    let agent = installed(&spade, hosts_on(), false).await?;
    let bot = text(&agent["id"]);
    let path = format!("/v1/agents/{bot}/package");
    // No signature, a claim the signature doesn't make, and another package's signature.
    let other = support::market::envelope("mail-reader", "2.0.0", &watcher("2.0.0"));
    for (body, why) in [
        (
            json!({ "recipe": watcher("2.0.0"), "package": package("2.0.0"), "transaction": "u1" }),
            "no signature",
        ),
        (
            json!({ "recipe": watcher("2.0.0"), "package": package("3.0.0"), "envelope": sealed("2.0.0"), "transaction": "u2" }),
            "a version the signature doesn't name",
        ),
        (
            json!({ "recipe": watcher("2.0.0"), "envelope": other, "transaction": "u3" }),
            "another package",
        ),
    ] {
        let (status, answer) = spade.post(&path, body).await?;
        assert_eq!(status, 400, "{why}: {answer}");
    }
    let (_, body) = spade.get(&path).await?;
    assert_eq!(body["package"]["version"], "1.0.0", "{body}");
    Ok(())
}

#[tokio::test]
async fn a_bot_whose_install_a_crash_cut_short_is_gone_at_the_next_start() -> Result {
    let spade = Spade::start(Vec::new(), Vec::new()).await?;
    secure(&spade).await?;
    let agent = installed(&spade, hosts_on(), true).await?;
    let bot = text(&agent["id"]);
    // As a crash before the install's commit leaves it: the bot and its ceiling, still marked
    // as an install's.
    let Some(mut link) = spade.engine.bot_package(&bot) else {
        panic!("the bot is linked");
    };
    link.installing = true;
    spade
        .engine
        .set_bot_package(&bot, &link)
        .unwrap_or_else(|e| panic!("{e}"));
    assert!(
        spade.engine.installing(&bot),
        "nothing is scheduled for it meanwhile"
    );
    let spade = spade.restart(Vec::new(), Vec::new()).await?;
    assert!(bots(&spade).await?.is_empty(), "the half-made bot is gone");
    assert!(spade.engine.bot_package(&bot).is_none());
    Ok(())
}
