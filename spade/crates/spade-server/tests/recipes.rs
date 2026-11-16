//! Bots from marketplace recipes (ADR 0168 §5, §8) through `POST /v1/agents` with `recipe`, as
//! the daemon sends it after the person pressed Install: the bot has the recipe's task, face,
//! model kind, routines (paused unless the person started them), notes and where it came from;
//! only what the person granted is on, never what the recipe asks for; its tools only narrow;
//! and a refusal makes no bot.

mod support;

use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use spade_ace::plugins::{Installed, SpadePlugin};
use spade_core::tools::Risk;
use spade_server::plugins::{BoxFuture, Daemon};
use spade_testkit::{FakeConnector, Script};
use support::{FakeTool, Options, Result, Spade};

fn recipe() -> Value {
    json!({
        "format": "spade-bot",
        "version": 2,
        "name": "Inbox",
        "blurb": "Sorts your mail each morning.",
        "task": "You look after the person's inbox.",
        "face": { "kind": "character", "v": 1, "body": "round", "pair": "lagoon", "ears": "none",
                  "marking": "muzzle", "eyes": "egg", "mouth": "smile", "cheeks": "blush",
                  "accessory": "glasses" },
        "model": "fast",
        "routines": [
            { "name": "Morning sort", "instruction": "Sort the mail.", "schedule": "weekdays at 8:00" },
            { "name": "Evening check", "instruction": "Check for replies.", "schedule": "daily at 18:00" }
        ],
        "notes": ["Never send a reply without the person's word."]
    })
}

fn install(recipe: Value, grants: Value, start_routines: bool) -> Value {
    json!({
        "recipe": recipe,
        "from_recipe": { "source": "market", "name": "inbox", "version": "1.2.0" },
        "grants": grants,
        "start_routines": start_routines,
    })
}

fn no_grants() -> Value {
    json!({ "connectors": [], "plugins": [], "skills": [] })
}

fn id(agent: &Value) -> String {
    agent["id"].as_str().unwrap_or_default().to_owned()
}

async fn bots(spade: &Spade) -> Result<Vec<Value>> {
    let (_, body) = spade.get("/v1/agents").await?;
    Ok(body["agents"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|a| a["kind"] == "bot")
        .collect())
}

/// The bot's routines by name, each with whether it is paused.
async fn routines(spade: &Spade, agent: &str) -> Result<Vec<(String, bool)>> {
    let (_, body) = spade.get(&format!("/v1/agents/{agent}/routines")).await?;
    let mut all: Vec<(String, bool)> = body["routines"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .map(|r| {
            (
                r["name"].as_str().unwrap_or("").to_owned(),
                r["paused"].as_bool().unwrap_or(false),
            )
        })
        .collect();
    all.sort();
    Ok(all)
}

/// Adds `fake/cheap` and makes it the person's fast model; new bots stay on `fake/m`.
async fn cheap_fast_model(spade: &Spade) -> Result {
    let (status, body) = spade
        .post(
            "/v1/endpoints/fake/models",
            json!({ "id": "cheap", "capabilities": ["tools"] }),
        )
        .await?;
    assert!(status < 300, "{body}");
    let (status, body) = spade
        .put(
            "/v1/settings",
            json!({ "fast_model": "fake/cheap", "new_bot_model": "fake/m" }),
        )
        .await?;
    assert!(status < 300, "{body}");
    Ok(())
}

#[tokio::test]
async fn a_recipe_makes_a_bot_with_its_task_face_model_kind_paused_routines_and_notes() -> Result {
    let spade = Spade::start(Vec::new(), Vec::new()).await?;
    cheap_fast_model(&spade).await?;
    let (status, made) = spade
        .post("/v1/agents", install(recipe(), no_grants(), false))
        .await?;
    assert_eq!(status, 201, "{made}");
    assert_eq!(made["left_out"], json!([]));
    let agent = &made["agent"];
    assert_eq!(agent["name"], "Inbox");
    assert_eq!(agent["task"], "You look after the person's inbox.");
    assert_eq!(agent["avatar"], recipe()["face"]);
    assert_eq!(agent["model"], "fake/cheap", "the person's own fast model");
    assert_eq!(
        agent["from_recipe"],
        json!({ "source": "market", "name": "inbox", "version": "1.2.0" })
    );
    let bot = id(agent);
    assert_eq!(
        routines(&spade, &bot).await?,
        [
            ("Evening check".to_owned(), true),
            ("Morning sort".to_owned(), true)
        ],
        "every routine arrives paused"
    );
    let (_, notes) = spade.get(&format!("/v1/agents/{bot}/notes")).await?;
    assert_eq!(
        notes["notes"][0]["text"],
        "Never send a reply without the person's word."
    );

    // The profile keeps saying where it came from.
    let listed = bots(&spade).await?;
    assert_eq!(listed[0]["from_recipe"]["name"], "inbox");

    // A capable recipe uses the person's default model; an unknown face value is repaired.
    let mut capable = recipe();
    capable["model"] = json!("capable");
    capable["name"] = json!("Second");
    capable["face"]["body"] = json!("no-such-body");
    let (status, made) = spade
        .post("/v1/agents", install(capable, no_grants(), false))
        .await?;
    assert_eq!(status, 201, "{made}");
    assert_eq!(made["agent"]["model"], "fake/m");
    assert_eq!(made["agent"]["avatar"]["kind"], "character");
    assert_ne!(made["agent"]["avatar"]["body"], "no-such-body");
    Ok(())
}

#[tokio::test]
async fn routines_run_from_the_start_when_the_person_turned_them_on() -> Result {
    let spade = Spade::start(Vec::new(), Vec::new()).await?;
    let (status, made) = spade
        .post("/v1/agents", install(recipe(), no_grants(), true))
        .await?;
    assert_eq!(status, 201, "{made}");
    let made = routines(&spade, &id(&made["agent"])).await?;
    assert_eq!(made.len(), 2);
    assert!(made.iter().all(|(_, paused)| !paused), "{made:?}");
    Ok(())
}

#[tokio::test]
async fn only_connectors_the_person_granted_and_has_connected_are_on() -> Result {
    let app = FakeConnector::start(Vec::new()).await;
    app.accept_token("api-key-1");
    let spade = Spade::start_with(
        Vec::new(),
        Vec::new(),
        Options {
            connectors: true,
            catalogue: vec![spade_connect::Entry {
                id: "fakemail".into(),
                name: "Fake Mail".into(),
                url: app.url(),
                sign_in: vec![spade_connect::SignIn::Token],
                notes: String::new(),
                source: "https://example.com/docs".into(),
                via: None,
                local: true,
                effects: Default::default(),
                writes: None,
            }],
            ..Options::default()
        },
    )
    .await?;
    let (status, body) = spade
        .post(
            "/v1/connectors",
            json!({ "catalogue": "fakemail", "token": "api-key-1" }),
        )
        .await?;
    assert_eq!(status, 200, "{body}");
    let connected = body["connector"]["id"]
        .as_str()
        .unwrap_or_default()
        .to_owned();

    // The recipe asks for mail; asking grants nothing.
    let mut asking = recipe();
    asking["needs"] =
        json!({ "connectors": [{ "id": "fakemail", "why": "Reads mail.", "required": true }] });
    let (status, made) = spade
        .post("/v1/agents", install(asking.clone(), no_grants(), false))
        .await?;
    assert_eq!(status, 201, "{made}");
    let (_, allowed) = spade
        .get(&format!("/v1/agents/{}/connectors", id(&made["agent"])))
        .await?;
    assert_eq!(allowed, json!({ "all": false, "connectors": [] }));

    // The person's press of Install grants it, and two the machine doesn't have are named.
    asking["name"] = json!("Granted");
    let grants = json!({
        "connectors": ["fakemail", "linear", "https://mcp.example.com/mcp"],
        "plugins": [], "skills": [],
    });
    let (status, made) = spade
        .post("/v1/agents", install(asking, grants, false))
        .await?;
    assert_eq!(status, 201, "{made}");
    let (_, allowed) = spade
        .get(&format!("/v1/agents/{}/connectors", id(&made["agent"])))
        .await?;
    assert_eq!(allowed, json!({ "all": false, "connectors": [connected] }));
    let left_out: Vec<String> = made["left_out"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(|l| l.as_str().map(str::to_owned))
        .collect();
    assert_eq!(left_out.len(), 2, "{left_out:?}");
    assert!(left_out[0].starts_with("Linear") && left_out[0].contains("Connect after install"));
    assert!(left_out[1].starts_with("https://mcp.example.com/mcp"));
    Ok(())
}

/// Stands in for ace's plugins: the daemon accepts a plugin just before it asks for the bot.
#[derive(Default)]
struct FakeAce {
    plugins: Mutex<Vec<SpadePlugin>>,
}

impl FakeAce {
    fn accept(&self, name: &str) {
        let value = json!({
            "install": { "name": name, "version": "1.0", "commit": "c".repeat(40),
                         "hash": "a".repeat(64), "acceptedAt": 1 },
            "enabled": true, "root": "/nowhere", "components": [], "executions": [],
            "unsupported": [],
        });
        let plugin: SpadePlugin = serde_json::from_value(value).unwrap_or_else(|e| panic!("{e}"));
        self.plugins
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .push(plugin);
    }

    fn all(&self) -> Vec<SpadePlugin> {
        self.plugins
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }
}

impl Daemon for FakeAce {
    fn installed(&self) -> BoxFuture<'_, std::result::Result<Vec<Installed>, String>> {
        let all = self.all();
        Box::pin(async move {
            Ok(all
                .into_iter()
                .map(|p| Installed {
                    install: p.install,
                    enabled: true,
                })
                .collect())
        })
    }

    fn plugin<'a>(
        &'a self,
        name: &'a str,
    ) -> BoxFuture<'a, std::result::Result<SpadePlugin, String>> {
        let found = self.all().into_iter().find(|p| p.install.name == name);
        Box::pin(async move { found.ok_or_else(|| "Plugin not installed".to_owned()) })
    }
}

#[tokio::test]
async fn a_granted_plugin_is_allowed_for_the_new_bot_and_one_the_recipe_only_asks_for_is_not()
-> Result {
    let ace = Arc::new(FakeAce::default());
    ace.accept("calendar");
    let spade = Spade::start_with(
        Vec::new(),
        Vec::new(),
        Options {
            plugins: Some(ace.clone()),
            ..Options::default()
        },
    )
    .await?;
    // Read once, so the list Spade holds predates the plugin the daemon accepts next.
    let (status, _) = spade
        .post("/v1/agents", install(recipe(), no_grants(), false))
        .await?;
    assert_eq!(status, 201);
    ace.accept("mail-tools");

    let mut asking = recipe();
    asking["name"] = json!("With plugins");
    asking["plugins"] = json!(["spade-plugin/calendar"]);
    let grants = json!({ "connectors": [], "plugins": ["mail-tools"], "skills": [] });
    let (status, made) = spade
        .post("/v1/agents", install(asking, grants, false))
        .await?;
    assert_eq!(status, 201, "{made}");
    let (_, view) = spade
        .get(&format!("/v1/agents/{}/plugins", id(&made["agent"])))
        .await?;
    let allowed: Vec<&str> = view["plugins"]
        .as_array()
        .map(|all| {
            all.iter()
                .filter(|p| p["allowed"] == true)
                .filter_map(|p| p["name"].as_str())
                .collect()
        })
        .unwrap_or_default();
    assert_eq!(allowed, ["mail-tools"], "{view}");
    Ok(())
}

fn refused<'a>(events: &'a [Value], call: &str) -> Option<&'a Value> {
    events
        .iter()
        .find(|e| e["type"] == "tool_finished" && e["call_id"] == call)
}

#[tokio::test]
async fn a_recipes_tools_narrow_the_bot_and_never_add_one() -> Result {
    let tools = vec![
        FakeTool::new("noop", Risk::Read, "did nothing"),
        FakeTool::new("other", Risk::Read, "did something else"),
    ];
    let spade = Spade::start(
        vec![
            Script::reply("").call("t1", "noop", json!({})),
            Script::reply("").call("t2", "other", json!({})),
            Script::reply("").call("t3", "launch_rockets", json!({})),
            Script::reply("Done."),
            Script::reply("").plain(r#"{"title":"Tools"}"#),
        ],
        tools
            .into_iter()
            .map(|t| Arc::new(t) as Arc<dyn spade_server::tools::Tool>)
            .collect(),
    )
    .await?;
    let mut narrow = recipe();
    narrow["tools"] = json!(["noop", "launch_rockets"]);
    let (status, made) = spade
        .post("/v1/agents", install(narrow, no_grants(), false))
        .await?;
    assert_eq!(status, 201, "{made}");
    let conversation = made["agent"]["conversation"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    spade.say(&conversation, "Use your tools").await?;
    let events = spade.wait_for(&conversation, "reply_finished").await?;
    let finished = |call| refused(&events, call).cloned().unwrap_or_default();
    assert_eq!(finished("t1")["is_error"], false, "{}", finished("t1"));
    assert_eq!(
        finished("t2")["is_error"],
        true,
        "a tool outside the recipe's list"
    );
    assert_eq!(
        finished("t3")["is_error"],
        true,
        "naming a tool Spade doesn't have adds nothing"
    );
    Ok(())
}

#[tokio::test]
async fn a_refused_recipe_makes_no_bot() -> Result {
    let spade = Spade::start(Vec::new(), Vec::new()).await?;
    let mut secret = recipe();
    secret["notes"] = json!(["api_key=sk-live-0123456789abcdefABCDEF0123456789"]);
    let mut named_secret = recipe();
    named_secret["face"]["token"] = json!("x");
    let mut bad_schedule = recipe();
    bad_schedule["routines"][1]["schedule"] = json!("whenever the moon is full");
    let mut model_id = recipe();
    model_id["model"] = json!("openrouter/some-model");
    let mut version_one = recipe();
    version_one["version"] = json!(1);
    for (why, body) in [
        ("a secret-shaped value", install(secret, no_grants(), false)),
        (
            "a field named like a secret",
            install(named_secret, no_grants(), false),
        ),
        (
            "a schedule Spade can't read",
            install(bad_schedule, no_grants(), false),
        ),
        ("a model id", install(model_id, no_grants(), false)),
        ("not version 2", install(version_one, no_grants(), false)),
        (
            "a plugin grant with no plugins here",
            install(recipe(), json!({ "plugins": ["mail-tools"] }), false),
        ),
        ("no from_recipe", json!({ "recipe": recipe() })),
    ] {
        let (status, body) = spade.post("/v1/agents", body).await?;
        assert_eq!(status, 400, "{why}: {body}");
        assert!(
            body["detail"].as_str().is_some_and(|d| !d.is_empty()),
            "{why}: the daemon reads the reason: {body}"
        );
        assert!(bots(&spade).await?.is_empty(), "{why}: no bot was made");
    }
    Ok(())
}

#[tokio::test]
async fn a_failure_after_the_bot_was_made_removes_it_again() -> Result {
    let ace = Arc::new(FakeAce::default());
    let spade = Spade::start_with(
        Vec::new(),
        Vec::new(),
        Options {
            plugins: Some(ace),
            ..Options::default()
        },
    )
    .await?;
    // The daemon names a plugin ace doesn't have: allowing it fails once the bot exists.
    let grants = json!({ "connectors": [], "plugins": ["never-accepted"], "skills": [] });
    let (status, body) = spade
        .post("/v1/agents", install(recipe(), grants, false))
        .await?;
    assert_eq!(status, 400, "{body}");
    assert!(bots(&spade).await?.is_empty(), "the half-made bot is gone");
    Ok(())
}

#[tokio::test]
async fn one_install_transaction_makes_one_bot_however_often_it_is_sent() -> Result {
    let spade = Spade::start(Vec::new(), Vec::new()).await?;
    let mut body = install(recipe(), no_grants(), false);
    body["from_recipe"]["transaction"] = json!("install-7");
    let (status, first) = spade.post("/v1/agents", body.clone()).await?;
    assert_eq!(status, 201, "{first}");
    assert_eq!(first["agent"]["from_recipe"]["transaction"], "install-7");
    let (status, again) = spade.post("/v1/agents", body).await?;
    assert_eq!(status, 200, "{again}");
    assert_eq!(id(&again["agent"]), id(&first["agent"]));
    assert_eq!(bots(&spade).await?.len(), 1);
    // The daemon finds the bot by its transaction to undo an install it lost track of.
    let listed = bots(&spade).await?;
    assert_eq!(listed[0]["from_recipe"]["transaction"], "install-7");
    Ok(())
}
