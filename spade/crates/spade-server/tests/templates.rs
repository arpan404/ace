//! New bot from a template (ADR 0132 §11, ADR 0200 §3.8, ADR 0197) through Spade's API, as the
//! app sends it: the template is a version 3 package built into Spade, so the bot it makes is
//! linked to it like any installed package, its routines arrive paused, its declared effects are
//! its switches, and the person's one message is the bot's first job.

mod support;

use serde_json::{Value, json};
use spade_testkit::Script;
use support::{Result, Spade};

fn text(value: &Value) -> String {
    value.as_str().unwrap_or_default().to_owned()
}

async fn routines(spade: &Spade, bot: &str) -> Result<Vec<(String, bool)>> {
    let (_, body) = spade.get(&format!("/v1/agents/{bot}/routines")).await?;
    Ok(body["routines"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .map(|r| (text(&r["name"]), r["paused"].as_bool().unwrap_or(false)))
        .collect())
}

#[tokio::test]
async fn new_bot_from_a_template_makes_a_bot_linked_to_the_template_with_its_first_message_sent()
-> Result {
    let spade = Spade::start(
        vec![
            Script::reply("Two things need you today."),
            Script::reply("").plain(r#"{"title":"Morning"}"#),
        ],
        Vec::new(),
    )
    .await?;
    // The one-message flow (ADR 0197): a template, a free name, no task, the first job.
    let (status, made) = spade
        .post(
            "/v1/agents",
            json!({
                "template": "inbox",
                "name": "Inbox",
                "task": "",
                "time_zone": "Europe/Berlin",
                "first_message": { "text": "What came in this morning?" },
            }),
        )
        .await?;
    assert_eq!(status, 201, "{made}");
    let agent = &made["agent"];
    let bot = text(&agent["id"]);
    assert_eq!(agent["name"], "Inbox");

    // Linked to the template's package, built into Spade.
    let (status, package) = spade.get(&format!("/v1/agents/{bot}/package")).await?;
    assert_eq!(status, 200, "{package}");
    let link = &package["package"];
    assert_eq!(link["source"], "spade");
    assert_eq!(link["name"], "inbox");
    assert_eq!(link["version"], "1.0.0");
    assert_eq!(text(&link["hash"]).len(), 64, "its content hash: {link}");
    // What the template declares is on: the person picked ace's own template.
    let effects: Vec<(String, bool)> = link["effects"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .map(|e| (text(&e["key"]), e["on"].as_bool().unwrap_or(false)))
        .collect();
    assert_eq!(
        effects,
        vec![
            ("network".to_owned(), true),
            ("send_as_person".to_owned(), true)
        ]
    );
    // Its routine arrived, paused, as a package's triggers do.
    assert_eq!(
        routines(&spade, &bot).await?,
        vec![("Morning inbox".to_owned(), true)]
    );

    // The message was its first job.
    let chat = text(&agent["conversation"]);
    let events = spade.wait_for(&chat, "reply_finished").await?;
    assert!(
        events
            .iter()
            .any(|e| e["type"] == "user_message" && e["text"] == "What came in this morning?"),
        "{events:?}"
    );
    Ok(())
}

#[tokio::test]
async fn what_the_person_chose_over_a_template_stays_theirs_through_an_update() -> Result {
    let spade = Spade::start(vec![Script::reply("Hello.")], Vec::new()).await?;
    let (status, made) = spade
        .post(
            "/v1/agents",
            json!({ "template": "research", "name": "Research 2", "task": "Only answer about rockets." }),
        )
        .await?;
    assert_eq!(status, 201, "{made}");
    let bot = text(&made["agent"]["id"]);
    assert_eq!(made["agent"]["name"], "Research 2");
    assert_eq!(made["agent"]["task"], "Only answer about rockets.");
    let (_, package) = spade.get(&format!("/v1/agents/{bot}/package")).await?;
    assert_eq!(package["package"]["name"], "research");

    // A corrected template (a later Spade's) replaces only what the person left as shipped.
    let (_, listed) = spade.get("/v1/templates").await?;
    let research = listed["templates"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .find(|t| t["id"] == "research")
        .unwrap_or_default();
    let fixed = json!({
        "format": "spade-bot",
        "version": 3,
        "requires": { "runtime": "1" },
        "name": "Researcher",
        "blurb": research["blurb"],
        "task": "You research questions for the person, and cite every claim.",
        "face": research["face"],
        "personality": research["personality"],
        "model": research["model_kind"],
        "triggers": [{ "kind": "message" }],
        "pricing": { "kind": "free" }
    });
    let (status, plan) = spade
        .post(
            &format!("/v1/agents/{bot}/package/plan"),
            json!({ "recipe": fixed }),
        )
        .await?;
    assert_eq!(status, 200, "{plan}");
    assert_eq!(plan["plan"]["name"], "kept", "{plan}");
    assert_eq!(plan["plan"]["task"], "kept", "{plan}");
    Ok(())
}

#[tokio::test]
async fn a_template_may_be_made_with_its_effects_off_and_its_routines_on() -> Result {
    let spade = Spade::start(vec![Script::reply("Hello.")], Vec::new()).await?;
    let (status, made) = spade
        .post(
            "/v1/agents",
            json!({
                "template": "meeting-notes",
                "switches": { "network": true, "send_as_person": false },
                "start_routines": true,
            }),
        )
        .await?;
    assert_eq!(status, 201, "{made}");
    let bot = text(&made["agent"]["id"]);
    let (_, package) = spade.get(&format!("/v1/agents/{bot}/package")).await?;
    let on: Vec<bool> = package["package"]["effects"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .map(|e| e["on"].as_bool().unwrap_or(false))
        .collect();
    assert_eq!(on, vec![true, false]);
    assert!(
        routines(&spade, &bot)
            .await?
            .iter()
            .all(|(_, paused)| !paused)
    );

    let (status, _) = spade
        .post("/v1/agents", json!({ "template": "no-such-role" }))
        .await?;
    assert_eq!(status, 404);
    Ok(())
}
