//! The composer's `/` menu: the skills and commands a bot may use, and a message that starts one
//! (docs/plugins.md, "Skills and commands"). The skill's or command's text rides at the tail of
//! that message's prompt, fixed when it was stored, and never changes the prompt before it.

mod support;

use std::sync::Arc;

use serde_json::{Value, json};
use spade_server::skill_store::{AceSwitch, SkillStore};
use spade_server::tools::SkillLibrary;
use spade_store::Store;
use spade_testkit::Script;
use support::plugins::{FakeAce, bot, options, plugin, wait};
use support::{Options, Result, Spade};

/// A plugin with a skill and a command that names `$ARGUMENTS` and `${PLUGIN_ROOT}`, a skill
/// store holding them, and two bots, one of them allowed the plugin.
async fn kit() -> Result<(
    Spade,
    String,
    String,
    String,
    Arc<SkillStore>,
    tempfile::TempDir,
)> {
    let kit = plugin(
        "kit",
        &"f".repeat(64),
        "/plugins/kit",
        json!([
            { "kind": "skill", "name": "tidy", "path": "skills/tidy/SKILL.md",
              "description": "Tidy a codebase",
              "text": "---\nname: tidy\ndescription: Tidy a codebase\n---\nTidy imports first.\n",
              "files": [] },
            { "kind": "command", "name": "ship", "path": "commands/ship.md",
              "description": "Ship the release",
              "text": "Ship $ARGUMENTS with ${PLUGIN_ROOT}/ship.sh." },
        ]),
        json!([]),
    );
    let ace = FakeAce::with(vec![kit]);
    let dir = tempfile::tempdir()?;
    let store = SkillStore::open(
        dir.path().join("skills"),
        Store::open(&dir.path().join("spade.sqlite"))?,
        Arc::new(spade_server::clock::SystemClock),
        Some(Arc::new(AceSwitch::new(None))),
    );
    let library: Arc<dyn SkillLibrary> = store.clone();
    let spade = Spade::start_with(
        vec![
            Script::reply("Shipped."),
            Script::reply("").plain(r#"{"title":"Ship"}"#),
            Script::reply("Anything else?"),
        ],
        Vec::new(),
        Options {
            skills: Some(library),
            skill_store: Some(store.clone()),
            ..options(ace)
        },
    )
    .await?;
    let (_, allowed) = bot(&spade, "Shipper", &["kit"]).await?;
    let (_, other) = bot(&spade, "Other", &[]).await?;
    let id = |name: &str| -> Result<String> {
        Ok(store
            .views()?
            .into_iter()
            .find(|view| view.name == name)
            .ok_or("no such row")?
            .id)
    };
    let ship = id("ship")?;
    Ok((spade, allowed, other, ship, store, dir))
}

fn menu(body: &Value) -> Vec<(String, String, String)> {
    body["invocables"]
        .as_array()
        .map(|rows| {
            rows.iter()
                .map(|row| {
                    (
                        row["kind"].as_str().unwrap_or_default().to_owned(),
                        row["name"].as_str().unwrap_or_default().to_owned(),
                        row["source"].as_str().unwrap_or_default().to_owned(),
                    )
                })
                .collect()
        })
        .unwrap_or_default()
}

#[tokio::test]
async fn the_menu_lists_only_what_the_bot_may_use_skills_before_commands() -> Result {
    let (spade, allowed, other, _, _, _dir) = kit().await?;
    let (status, body) = spade
        .get(&format!("/v1/conversations/{allowed}/invocables"))
        .await?;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        menu(&body),
        [
            ("skill".into(), "tidy".into(), "kit".into()),
            ("command".into(), "ship".into(), "kit".into()),
        ]
    );
    let (_, body) = spade
        .get(&format!("/v1/conversations/{other}/invocables"))
        .await?;
    assert!(menu(&body).is_empty(), "{body}");
    Ok(())
}

#[tokio::test]
async fn a_command_reaches_the_model_at_the_tail_with_its_arguments_and_leaves_earlier_bytes()
-> Result {
    let (spade, allowed, _, ship, _, _dir) = kit().await?;
    let (status, body) = spade
        .post(
            &format!("/v1/conversations/{allowed}/messages"),
            json!({ "text": "v2.1", "invoke": { "kind": "command", "id": ship } }),
        )
        .await?;
    assert_eq!(status, 202, "{body}");
    let events = wait(&spade, &allowed, "reply_finished", 1).await?;
    // Stored on the message, with the text the model read.
    let message = events
        .iter()
        .find(|event| event["type"] == "user_message")
        .ok_or("no message")?;
    assert_eq!(message["text"], "v2.1");
    assert_eq!(message["invoke"]["kind"], "command");
    assert_eq!(message["invoke"]["name"], "ship");
    assert_eq!(
        message["invoke"]["text"],
        "Ship v2.1 with /plugins/kit/ship.sh."
    );
    let first = spade.fake.seen()[0].body.to_string();
    assert!(
        first.contains("Ship v2.1 with /plugins/kit/ship.sh."),
        "the model never read the command"
    );
    assert!(
        first.rfind("<invoked").unwrap_or(0) > first.find("v2.1").unwrap_or(usize::MAX),
        "the command came before the message it started"
    );

    // The next turn rebuilds the same bytes before its own new message.
    spade.say(&allowed, "thanks").await?;
    wait(&spade, &allowed, "reply_finished", 2).await?;
    let seen = spade.fake.seen();
    let (_, before) = first.split_at(first.find("Ship v2.1").unwrap_or(0));
    let second = seen
        .iter()
        .map(|call| call.body.to_string())
        .find(|body| body.contains("thanks"))
        .ok_or("no second call")?;
    assert!(
        second.contains(before.split("</invoked>").next().unwrap_or(before)),
        "a later prompt changed the invoked text"
    );
    Ok(())
}

#[tokio::test]
async fn a_skill_or_command_the_bot_may_not_use_is_refused_and_nothing_is_stored() -> Result {
    let (spade, allowed, other, ship, _, _dir) = kit().await?;
    let post = async |chat: &str, invoke: Value| {
        spade
            .post(
                &format!("/v1/conversations/{chat}/messages"),
                json!({ "text": "go", "invoke": invoke }),
            )
            .await
    };
    // A bot not allowed the plugin.
    let (status, _) = post(&other, json!({ "kind": "command", "id": ship })).await?;
    assert_eq!(status, 422);
    // A command asked for as a skill, an id nobody has, and a kind that is neither.
    let (status, _) = post(&allowed, json!({ "kind": "skill", "id": ship })).await?;
    assert_eq!(status, 422);
    let (status, _) = post(&allowed, json!({ "kind": "command", "id": "plg_nothing" })).await?;
    assert_eq!(status, 422);
    let (status, _) = post(&allowed, json!({ "kind": "agent", "id": ship })).await?;
    assert_eq!(status, 422);
    for chat in [&allowed, &other] {
        assert!(
            spade
                .events(chat)
                .await?
                .iter()
                .all(|event| event["type"] != "user_message"),
            "a refused message was stored"
        );
    }
    Ok(())
}
