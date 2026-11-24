mod support;

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use spade_testkit::Script;
use support::{Result, TOKEN, person_stamp};

#[tokio::test]
async fn template_draft_refuses_personal_data_and_bearer_cannot_publish() -> Result {
    let proposal = json!({
        "description": "Measure rendering performance.",
        "task": "Record a baseline before making changes.",
        "notes": ["Compare results under the same conditions."],
    });
    let mut private = proposal.clone();
    private["task"] = json!("Email my findings to testing@example.test.");
    let spade = support::packaged::secured(
        vec![
            Script::reply("").call("private", "template_draft", private),
            Script::reply("").call("clean", "template_draft", proposal),
            Script::reply("The template is unpublished."),
        ],
        Vec::new(),
    )
    .await?;
    let agent = spade
        .new_agent("Render benchmarks", "Work in /Users/test/private.")
        .await?;
    let chat = agent["conversation"].as_str().unwrap_or_default();
    spade.say(chat, "Draft a template.").await?;
    let events = spade.wait_for(chat, "reply_finished").await?;
    let cards: Vec<&Value> = events
        .iter()
        .filter(|event| event["type"] == "card_shown")
        .collect();
    assert_eq!(cards.len(), 1, "{events:?}");
    let id = cards[0]["card"].as_str().unwrap_or_default();
    let (status, details) = spade.get(&format!("/v1/share-templates/{id}")).await?;
    assert_eq!(status, 200);
    assert_eq!(details["visibility"], Value::Null);
    assert_eq!(details["draft"]["recipe"]["version"], 3);
    assert_eq!(
        details["draft"]["recipe"]["task"],
        "Record a baseline before making changes."
    );
    assert_eq!(
        details["draft"]["recipe"]["notes"],
        json!(["Compare results under the same conditions."])
    );
    let path = format!("/v1/share-templates/{id}/authorize");
    let review = json!({
        "revision": details["revision"],
        "visibility": "unlisted",
        "name": "Render benchmarks",
        "description": "Measure rendering performance.",
        "task": "Compare median run times.",
        "notes": [],
        "skills": [],
        "routines": [],
        "connectors": [],
    });
    let (status, _) = spade.post_unstamped(&path, review.clone()).await?;
    assert_eq!(status, 403);

    let bytes = serde_json::to_vec(&review)?;
    let hash: String = Sha256::digest(&bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let stamp = person_stamp(
        &spade.person_key_path,
        &format!("template:{id}"),
        &format!("authorize:{hash}"),
    )?;
    let response = spade
        .http
        .post(format!("{}{path}", spade.base))
        .bearer_auth(TOKEN)
        .header(spade_server::security::attest::HEADER, &stamp)
        .body(bytes.clone())
        .send()
        .await?;
    assert_eq!(response.status().as_u16(), 200);
    let authorized: Value = response.json().await?;
    assert_eq!(authorized["recipe"]["task"], "Compare median run times.");
    assert_eq!(authorized["recipe"]["notes"], json!([]));

    let replay = spade
        .http
        .post(format!("{}{path}", spade.base))
        .bearer_auth(TOKEN)
        .header(spade_server::security::attest::HEADER, stamp)
        .body(bytes)
        .send()
        .await?;
    assert_eq!(replay.status().as_u16(), 403);

    let (_, still) = spade.get(&format!("/v1/share-templates/{id}")).await?;
    assert_ne!(still["revision"], details["revision"]);
    assert_eq!(still["visibility"], Value::Null);
    assert_eq!(still["draft"], authorized);
    Ok(())
}
