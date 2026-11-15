//! What the messenger app reads (Spade v4): each conversation's seen cursor and "finished, not
//! seen", plain previews, a bot made with its first message, the model for new bots, and which
//! bots use each app and skill.

mod support;

use std::time::{Duration, Instant};

use serde_json::{Value, json};
use spade_testkit::Script;
use support::{Result, Spade};

fn title() -> Script {
    Script::reply("").plain(r#"{"title":"A title"}"#)
}

async fn agent(spade: &Spade, id: &str) -> Result<Value> {
    let (status, body) = spade.get("/v1/agents").await?;
    assert_eq!(status, 200, "{body}");
    Ok(body["agents"]
        .as_array()
        .and_then(|all| all.iter().find(|a| a["id"] == id).cloned())
        .unwrap_or_default())
}

async fn wait_until(spade: &Spade, id: &str, check: impl Fn(&Value) -> bool) -> Result<Value> {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let found = agent(spade, id).await?;
        if check(&found) {
            return Ok(found);
        }
        if Instant::now() > deadline {
            return Err(format!("never got there: {found}").into());
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn a_finished_reply_is_not_seen_until_the_person_marks_it_and_the_mark_survives_a_restart()
-> Result {
    let spade = Spade::start(
        vec![
            Script::reply("Found [three flights](https://x.dev/f) to **Oslo**."),
            title(),
        ],
        Vec::new(),
    )
    .await?;
    let bot = spade.new_agent("Trips", "").await?;
    let id = bot["id"].as_str().unwrap_or_default().to_owned();
    let conversation = bot["conversation"].as_str().unwrap_or_default().to_owned();
    assert_eq!(bot["unseen"], false, "nothing said yet");
    spade.say(&conversation, "Find flights").await?;
    let done = wait_until(&spade, &id, |a| a["unseen"] == true).await?;
    assert_eq!(done["state"], "idle", "only once it finished");
    assert_eq!(
        done["last_message"]["text"], "Found three flights to Oslo.",
        "plain text, links as their words"
    );
    let reply_seq = done["last_message"]["seq"].as_i64().unwrap_or_default();
    assert!(reply_seq > 0, "{done}");

    let (status, body) = spade
        .put(&format!("/v1/conversations/{conversation}/seen"), json!({}))
        .await?;
    assert_eq!(status, 200, "{body}");
    let cursor = body["seen_seq"].as_i64().unwrap_or_default();
    assert!(cursor >= reply_seq, "{body}");
    let (status, body) = spade
        .put(
            &format!("/v1/conversations/{conversation}/seen"),
            json!({ "seq": 1 }),
        )
        .await?;
    assert_eq!(
        (status, body["seen_seq"].as_i64()),
        (200, Some(cursor)),
        "never back"
    );
    let (status, _) = spade
        .put("/v1/conversations/missing/seen", json!({}))
        .await?;
    assert_eq!(status, 404);

    let spade = spade.restart(Vec::new(), Vec::new()).await?;
    let after = agent(&spade, &id).await?;
    assert_eq!(
        (after["unseen"].clone(), after["seen_seq"].as_i64()),
        (json!(false), Some(cursor)),
        "{after}"
    );
    Ok(())
}
