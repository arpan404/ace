//! Panels (ADR 0200 §5.2) through the real engine and API on a scripted fake endpoint: a package
//! installs with its panel's page, kept and served by its hash; `panel_update` sets the panel's
//! state only when it fits the declared schema; only an action the panel declares, with a value
//! that fits, reaches the bot, once, as the person's input; and a card opens only its own panels.

mod support;

use serde_json::{Value, json};
use spade_testkit::{Script, Seen};
use support::{Result, Spade, TOKEN};

const PAGE: &str = "<!doctype html><html><head><title>Watched trips</title></head><body>\
<ul id=\"trips\"></ul><script>addEventListener('ace:state', () => {});</script></body></html>";

fn watcher() -> Value {
    json!({
        "format": "spade-bot",
        "version": 3,
        "requires": { "runtime": "1" },
        "name": "Flight watcher",
        "blurb": "Watches fares.",
        "task": "You watch flight fares for the person.",
        "surfaces": [{
            "id": "watchlist",
            "kind": "panel",
            "file": "panels/watchlist/index.html",
            "title": "Watched trips",
            "state": {
                "type": "object",
                "properties": {
                    "trips": { "type": "array", "maxItems": 20, "items": {
                        "type": "object",
                        "properties": {
                            "route": { "type": "string", "maxLength": 40 },
                            "fare": { "type": "number", "minimum": 0 }
                        },
                        "required": ["route"] } }
                },
                "required": ["trips"]
            },
            "actions": [
                { "name": "stop_watching", "label": "Stop watching",
                  "value": { "type": "string", "maxLength": 40 } }
            ]
        }]
    })
}

fn install(pages: Value) -> Value {
    json!({
        "recipe": watcher(),
        "from_recipe": { "source": "local", "name": "flight-watcher", "version": "dev", "transaction": "install-panels" },
        "grants": { "connectors": [], "plugins": [], "skills": [] },
        "switches": {},
        "start_routines": false,
        "pages": pages,
    })
}

fn title() -> Script {
    Script::reply("").plain(r#"{"title":"Fares"}"#)
}

fn turns(seen: &[Seen]) -> Vec<Value> {
    seen.iter()
        .filter(|s| s.body["stream"] == true)
        .map(|s| s.body.clone())
        .collect()
}

fn last_sent(spade: &Spade) -> String {
    turns(&spade.fake.seen())
        .last()
        .map(|body| body["messages"].to_string())
        .unwrap_or_default()
}

fn finished<'a>(events: &'a [Value], call: &str) -> &'a Value {
    events
        .iter()
        .find(|e| e["type"] == "tool_finished" && e["call_id"] == call)
        .unwrap_or(&Value::Null)
}

fn count(events: &[Value], kind: &str) -> usize {
    events.iter().filter(|e| e["type"] == kind).count()
}

#[tokio::test]
async fn a_package_without_its_panels_page_does_not_install() -> Result {
    let spade = Spade::start(Vec::new(), Vec::new()).await?;
    let (status, body) = spade.post("/v1/agents", install(json!({}))).await?;
    assert_eq!(status, 400, "{body}");
    assert!(
        body.to_string().contains("panels/watchlist/index.html"),
        "{body}"
    );
    let (_, listed) = spade.get("/v1/agents").await?;
    assert!(!listed.to_string().contains("Flight watcher"), "{listed}");
    Ok(())
}

#[tokio::test]
async fn a_panels_state_fits_its_schema_and_only_its_declared_actions_reach_the_bot() -> Result {
    let spade = Spade::start(
        vec![
            // State that doesn't fit: refused with its problems, nothing stored.
            Script::reply("").call(
                "p1",
                "panel_update",
                json!({ "surface": "watchlist", "data": { "trips": [{ "fare": -3 }] } }),
            ),
            Script::reply("").call(
                "p2",
                "panel_update",
                json!({ "surface": "watchlist", "data": { "trips": [{ "route": "KTM-DEL", "fare": 182 }] } }),
            ),
            // A card may open its own panel, never one its package doesn't ship.
            Script::reply("").call(
                "c1",
                "card_show",
                json!({ "data": { "title": "Fares", "blocks": [{ "kind": "actions", "actions": [
                    { "kind": "open", "label": "See all trips", "panel": "elsewhere" }] }] } }),
            ),
            Script::reply("").call(
                "c2",
                "card_show",
                json!({ "data": { "title": "Fares", "blocks": [{ "kind": "actions", "actions": [
                    { "kind": "open", "label": "See all trips", "panel": "watchlist" }] }] } }),
            ),
            Script::reply("Watching KTM to DEL."),
            title(),
            Script::reply("I stopped watching it."),
        ],
        Vec::new(),
    )
    .await?;
    let (status, made) = spade
        .post(
            "/v1/agents",
            install(json!({ "panels/watchlist/index.html": PAGE })),
        )
        .await?;
    assert_eq!(status, 201, "{made}");
    let chat = made["agent"]["conversation"]
        .as_str()
        .unwrap_or_default()
        .to_owned();

    // Its panel, with the page it shows, kept by hash and served as text.
    let (status, listed) = spade
        .get(&format!("/v1/conversations/{chat}/panels"))
        .await?;
    assert_eq!(status, 200, "{listed}");
    let panel = &listed["panels"][0];
    assert_eq!(panel["id"], "watchlist");
    assert_eq!(panel["title"], "Watched trips");
    assert_eq!(panel["actions"], json!(["stop_watching"]));
    assert_eq!(panel["state"], Value::Null);
    let hash = panel["page"].as_str().unwrap_or_default().to_owned();
    assert_eq!(hash.len(), 64);
    let page = spade
        .http
        .get(format!("{}/v1/panels/pages/{hash}", spade.base))
        .bearer_auth(TOKEN)
        .send()
        .await?;
    assert_eq!(page.status().as_u16(), 200);
    assert!(
        page.headers()["content-type"]
            .to_str()
            .unwrap_or_default()
            .starts_with("text/plain")
    );
    assert_eq!(page.text().await?, PAGE);

    spade.say(&chat, "Watch KTM to DEL").await?;
    let events = spade.wait_for(&chat, "reply_finished").await?;
    let refused = finished(&events, "p1");
    assert_eq!(refused["is_error"], true);
    let words = refused["content"].as_str().unwrap_or_default();
    assert!(words.contains("data.trips[0].route: is needed"), "{words}");
    assert!(
        words.contains("data.trips[0].fare: is at least 0"),
        "{words}"
    );
    assert_eq!(count(&events, "panel_updated"), 1);
    assert_eq!(finished(&events, "c1")["is_error"], true);
    assert_eq!(finished(&events, "c2")["is_error"], false);
    let card = events
        .iter()
        .find(|e| e["type"] == "card_shown")
        .cloned()
        .unwrap_or(Value::Null);
    assert_eq!(
        card["data"]["blocks"][0]["actions"][0]["kind"],
        "open_panel"
    );

    let (_, listed) = spade
        .get(&format!("/v1/conversations/{chat}/panels"))
        .await?;
    assert_eq!(
        listed["panels"][0]["state"],
        json!({ "trips": [{ "route": "KTM-DEL", "fare": 182 }] })
    );

    // Only a declared action with a value that fits gets through.
    let path = format!("/v1/conversations/{chat}/panels/watchlist/actions");
    let model_calls = turns(&spade.fake.seen()).len();
    for (body, status) in [
        (json!({ "key": "a1", "action": "book_it" }), 400),
        (
            json!({ "key": "a2", "action": "stop_watching", "value": 7 }),
            400,
        ),
        (json!({ "key": "a3", "action": "stop_watching" }), 400),
    ] {
        let (got, answer) = spade.post(&path, body).await?;
        assert_eq!(got, status, "{answer}");
    }
    let (got, _) = spade
        .post(
            &format!("/v1/conversations/{chat}/panels/elsewhere/actions"),
            json!({ "key": "a4", "action": "stop_watching", "value": "KTM-DEL" }),
        )
        .await?;
    assert_eq!(got, 404);
    assert_eq!(turns(&spade.fake.seen()).len(), model_calls);
    assert_eq!(count(&spade.events(&chat).await?, "panel_action"), 0);

    // Sent twice (a retry after a lost answer): it reaches the bot once, as the person's input.
    let action = json!({ "key": "a5", "action": "stop_watching", "value": "KTM-DEL" });
    for _ in 0..2 {
        let (got, answer) = spade.post(&path, action.clone()).await?;
        assert_eq!(got, 202, "{answer}");
    }
    spade.wait_for_count(&chat, "reply_finished", 2).await?;
    let sent = last_sent(&spade);
    assert!(
        sent.contains("<panel_action panel=\\\"watchlist\\\" action=\\\"stop_watching\\\">"),
        "{sent}"
    );
    assert!(sent.contains("\\\"KTM-DEL\\\""), "{sent}");
    assert_eq!(count(&spade.events(&chat).await?, "panel_action"), 1);
    Ok(())
}

#[tokio::test]
async fn an_update_brings_its_panels_new_page_and_one_without_it_changes_nothing() -> Result {
    let spade = Spade::start(Vec::new(), Vec::new()).await?;
    let (status, made) = spade
        .post(
            "/v1/agents",
            install(json!({ "panels/watchlist/index.html": PAGE })),
        )
        .await?;
    assert_eq!(status, 201, "{made}");
    let bot = made["agent"]["id"].as_str().unwrap_or_default().to_owned();
    let chat = made["agent"]["conversation"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let page_of = |listed: &Value| listed["panels"][0]["page"].as_str().map(str::to_owned);
    let (_, before) = spade
        .get(&format!("/v1/conversations/{chat}/panels"))
        .await?;

    let mut next = watcher();
    next["blurb"] = json!("Watches fares, and says when one drops.");
    let (status, refused) = spade
        .post(
            &format!("/v1/agents/{bot}/package"),
            json!({ "recipe": next, "transaction": "update-1", "pages": {} }),
        )
        .await?;
    assert_eq!(status, 400, "{refused}");
    let (_, same) = spade
        .get(&format!("/v1/conversations/{chat}/panels"))
        .await?;
    assert_eq!(page_of(&same), page_of(&before));

    let newer = PAGE.replace("<ul", "<h1>Trips</h1><ul");
    let (status, moved) = spade
        .post(
            &format!("/v1/agents/{bot}/package"),
            json!({ "recipe": next, "transaction": "update-2",
                    "pages": { "panels/watchlist/index.html": newer } }),
        )
        .await?;
    assert_eq!(status, 200, "{moved}");
    let (_, after) = spade
        .get(&format!("/v1/conversations/{chat}/panels"))
        .await?;
    let hash = page_of(&after).unwrap_or_default();
    assert_ne!(Some(hash.clone()), page_of(&before));
    let page = spade
        .http
        .get(format!("{}/v1/panels/pages/{hash}", spade.base))
        .bearer_auth(TOKEN)
        .send()
        .await?;
    assert_eq!(page.text().await?, newer);
    Ok(())
}
