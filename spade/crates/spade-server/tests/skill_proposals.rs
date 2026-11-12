//! Skills a bot writes (ADR 0130), through the real server and ace's library on a fake daemon:
//! a proposal waits for the person, Save sends it to the library, Discard never does, an edit
//! keeps what the skill was, and a bot's notes come back with the skill.

#[path = "../../spade-ace/tests/support/fake_daemon.rs"]
#[allow(dead_code)]
mod fake_daemon;
mod support;

use std::sync::Arc;
use std::time::Duration;

use fake_daemon::{FakeDaemon, LOCAL_TOKEN};
use serde_json::{Value, json};
use spade_ace::{AceSkills, LoopbackUrl, Secret, SkillsConfig};
use spade_server::clock::SystemClock;
use spade_server::learning::{Learning, SkillFeedback, SkillPropose};
use spade_server::tools::{AceLibrary, EngineHandle, SkillLibrary, SkillLoad, Tool};
use spade_testkit::Script;
use support::{Options, Result, Spade, types};

struct Setup {
    spade: Spade,
    daemon: FakeDaemon,
    _dir: tempfile::TempDir,
}

async fn start(scripts: Vec<Script>) -> Result<Setup> {
    let daemon = FakeDaemon::start().await;
    let url = LoopbackUrl::parse(&daemon.url())?;
    let config = SkillsConfig::new(
        url,
        Secret::new(LOCAL_TOKEN),
        "spade",
        Duration::from_secs(5),
    )?;
    let library: Arc<dyn SkillLibrary> = Arc::new(AceLibrary(Arc::new(AceSkills::new(config))));
    let dir = tempfile::tempdir()?;
    let learning = Arc::new(Learning::new(
        dir.path().join("skills"),
        Arc::new(SystemClock),
        library.clone(),
    ));
    let bots = EngineHandle::default();
    let tools: Vec<Arc<dyn Tool>> = vec![
        Arc::new(SkillPropose {
            learning: learning.clone(),
            bots: bots.clone(),
        }),
        Arc::new(SkillFeedback {
            learning: learning.clone(),
            bots: bots.clone(),
        }),
        Arc::new(SkillLoad::new(library).with_notes(learning.clone(), bots.clone())),
    ];
    let spade = Spade::start_with(
        scripts,
        tools,
        Options {
            learning: Some(learning),
            ..Options::default()
        },
    )
    .await?;
    bots.set(&spade.engine);
    Ok(Setup {
        spade,
        daemon,
        _dir: dir,
    })
}

fn release_notes() -> Value {
    json!({
        "name": "release-notes",
        "description": "Write release notes from the merged pull requests",
        "body": "# Release notes\n\n1. List merged PRs since the last tag.\n2. Group by area.\n",
        "why": "You corrected me twice about grouping by area."
    })
}

/// A new bot, sent a message: its id, conversation and events once its reply has finished.
async fn proposed(setup: &Setup) -> Result<(String, String, Vec<Value>)> {
    let agent = setup.spade.new_agent("Writer", "").await?;
    let field = |name: &str| agent[name].as_str().unwrap_or_default().to_owned();
    let (bot, conversation) = (field("id"), field("conversation"));
    setup.spade.say(&conversation, "Write the notes").await?;
    let events = setup
        .spade
        .wait_for(&conversation, "reply_finished")
        .await?;
    Ok((bot, conversation, events))
}

async fn proposals(spade: &Spade, bot: &str) -> Result<Vec<Value>> {
    let (status, body) = spade
        .get(&format!("/v1/agents/{bot}/skill-proposals"))
        .await?;
    assert_eq!(status, 200, "{body}");
    Ok(body["proposals"].as_array().cloned().unwrap_or_default())
}

#[tokio::test]
async fn a_saved_proposal_reaches_the_skill_library() -> Result {
    let setup = start(vec![
        Script::reply("").call("c1", "skill_propose", release_notes()),
        Script::reply("I wrote that down as a skill."),
    ])
    .await?;
    let (bot, _, events) = proposed(&setup).await?;
    assert!(
        !types(&events).contains(&"approval_requested".to_owned()),
        "proposing asks nothing: {:?}",
        types(&events)
    );
    let open = proposals(&setup.spade, &bot).await?;
    assert_eq!(open.len(), 1);
    assert_eq!(open[0]["state"], "open");
    assert_eq!(open[0]["call_id"], "c1");
    assert_eq!(open[0]["base"], Value::Null, "a new skill");
    assert!(
        setup.daemon.writes().is_empty(),
        "nothing reaches ace before Save"
    );

    let id = open[0]["id"].as_str().unwrap_or_default();
    let path = format!("/v1/agents/{bot}/skill-proposals/{id}");
    let (status, saved) = setup.spade.post(&path, json!({ "save": true })).await?;
    assert_eq!(status, 200, "{saved}");
    assert_eq!(saved["proposal"]["state"], "saved");
    let writes = setup.daemon.writes();
    assert_eq!(writes.len(), 1);
    assert_eq!(writes[0]["op"], "create");
    assert_eq!(writes[0]["name"], "release-notes");
    assert_eq!(writes[0]["body"], release_notes()["body"]);

    let (again, _) = setup.spade.post(&path, json!({ "save": true })).await?;
    assert_eq!(again, 409, "an answered proposal is not saved twice");
    assert_eq!(setup.daemon.writes().len(), 1);
    Ok(())
}

#[tokio::test]
async fn a_discarded_proposal_never_reaches_the_library() -> Result {
    let setup = start(vec![
        Script::reply("").call("c1", "skill_propose", release_notes()),
        Script::reply("Proposed."),
    ])
    .await?;
    let (bot, _, _) = proposed(&setup).await?;
    let open = proposals(&setup.spade, &bot).await?;
    let id = open[0]["id"].as_str().unwrap_or_default();
    let (status, discarded) = setup
        .spade
        .post(
            &format!("/v1/agents/{bot}/skill-proposals/{id}"),
            json!({ "save": false }),
        )
        .await?;
    assert_eq!(status, 200);
    assert_eq!(discarded["proposal"]["state"], "discarded");
    assert!(setup.daemon.writes().is_empty());
    Ok(())
}

#[tokio::test]
async fn a_proposal_for_an_existing_skill_is_an_edit_of_what_it_was() -> Result {
    let edit = json!({
        "name": "review-code",
        "description": "Review code, tests first",
        "body": "Read the tests first.\n",
    });
    let setup = start(vec![
        Script::reply("").call("c1", "skill_propose", edit.clone()),
        Script::reply("Proposed an edit."),
    ])
    .await?;
    let (bot, _, _) = proposed(&setup).await?;
    let open = proposals(&setup.spade, &bot).await?;
    let base = &open[0]["base"];
    assert_eq!(
        base["body"], "Do the thing carefully.\n",
        "the body as it was"
    );
    assert_eq!(base["description"], "review-code skill");

    let id = open[0]["id"].as_str().unwrap_or_default();
    let (status, _) = setup
        .spade
        .post(
            &format!("/v1/agents/{bot}/skill-proposals/{id}"),
            json!({ "save": true }),
        )
        .await?;
    assert_eq!(status, 200);
    let writes = setup.daemon.writes();
    assert_eq!(writes[0]["op"], "edit");
    assert_eq!(writes[0]["expectedHash"], "a".repeat(64));
    assert_eq!(writes[0]["body"], "Read the tests first.\n");
    Ok(())
}

#[tokio::test]
async fn a_new_proposal_for_the_same_name_replaces_the_open_one() -> Result {
    let mut second = release_notes();
    second["body"] = json!("Group by area, then by size.\n");
    let setup = start(vec![
        Script::reply("").call("c1", "skill_propose", release_notes()),
        Script::reply("").call("c2", "skill_propose", second),
        Script::reply("Proposed."),
    ])
    .await?;
    let (bot, _, _) = proposed(&setup).await?;
    let open = proposals(&setup.spade, &bot).await?;
    assert_eq!(open.len(), 1);
    assert_eq!(open[0]["body"], "Group by area, then by size.\n");
    Ok(())
}

#[tokio::test]
async fn a_bots_note_on_a_skill_comes_back_when_it_loads_the_skill() -> Result {
    let setup = start(vec![
        Script::reply("").call(
            "c1",
            "skill_feedback",
            json!({ "name": "review-code", "verdict": "outdated", "note": "It skips the tests." }),
        ),
        Script::reply("").call("c2", "skill_load", json!({ "name": "review-code" })),
        Script::reply("Loaded."),
    ])
    .await?;
    let (_, _, events) = proposed(&setup).await?;
    let loaded = events
        .iter()
        .find(|e| e["type"] == "tool_finished" && e["call_id"] == "c2")
        .and_then(|e| e["content"].as_str())
        .unwrap_or_default();
    assert!(loaded.contains("Do the thing carefully."), "{loaded}");
    assert!(
        loaded.contains("outdated: It skips the tests."),
        "the note shows with the skill: {loaded}"
    );
    Ok(())
}
