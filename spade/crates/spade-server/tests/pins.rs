//! Pins (Spade v4 list): the person pins a bot or a group to the top of their list. The pin is
//! kept in Spade, so every device sees the same strip, in the order they were pinned.

mod support;

use serde_json::{Value, json};
use support::{Result, Spade};

async fn pin(spade: &Spade, kind: &str, id: &str, pinned: bool) -> Result<(u16, Value)> {
    spade
        .put(&format!("/v1/{kind}/{id}/pin"), json!({ "pinned": pinned }))
        .await
}

async fn pinned_at(spade: &Spade, kind: &str, key: &str, id: &str) -> Result<Value> {
    let (_, body) = spade.get(&format!("/v1/{kind}")).await?;
    Ok(body[key]
        .as_array()
        .and_then(|all| all.iter().find(|item| item["id"] == id).cloned())
        .map(|item| item["pinned_at"].clone())
        .unwrap_or(Value::Null))
}

#[tokio::test]
async fn a_pinned_bot_says_when_it_was_pinned_and_an_unpinned_one_says_null() -> Result {
    let spade = Spade::start(Vec::new(), Vec::new()).await?;
    let bot = spade.new_agent("Trips", "").await?;
    let id = bot["id"].as_str().unwrap_or_default();
    assert_eq!(bot["pinned_at"], Value::Null, "new bots start unpinned");

    let (status, body) = pin(&spade, "agents", id, true).await?;
    assert_eq!(status, 200, "{body}");
    let first = body["agent"]["pinned_at"].as_i64().unwrap_or(0);
    assert!(first > 0, "{body}");
    assert_eq!(pinned_at(&spade, "agents", "agents", id).await?, first);

    // Pinning again keeps its place in the strip.
    let (_, again) = pin(&spade, "agents", id, true).await?;
    assert_eq!(again["agent"]["pinned_at"], first);

    let (status, body) = pin(&spade, "agents", id, false).await?;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["agent"]["pinned_at"], Value::Null);
    assert_eq!(
        pinned_at(&spade, "agents", "agents", id).await?,
        Value::Null
    );
    Ok(())
}

#[tokio::test]
async fn pins_keep_the_order_they_were_made_in_and_survive_a_restart() -> Result {
    let spade = Spade::start(Vec::new(), Vec::new()).await?;
    let one = spade.new_agent("One", "").await?;
    let two = spade.new_agent("Two", "").await?;
    let (one, two) = (
        one["id"].as_str().unwrap_or_default().to_owned(),
        two["id"].as_str().unwrap_or_default().to_owned(),
    );
    // Second pinned first: the strip reads oldest pin first, whatever the bots' own order.
    pin(&spade, "agents", &two, true).await?;
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    pin(&spade, "agents", &one, true).await?;
    let earlier = pinned_at(&spade, "agents", "agents", &two).await?;
    let later = pinned_at(&spade, "agents", "agents", &one).await?;
    assert!(earlier.as_i64() < later.as_i64(), "{earlier} {later}");

    let spade = spade.restart(Vec::new(), Vec::new()).await?;
    assert_eq!(pinned_at(&spade, "agents", "agents", &two).await?, earlier);
    assert_eq!(pinned_at(&spade, "agents", "agents", &one).await?, later);
    Ok(())
}

#[tokio::test]
async fn spade_itself_can_be_pinned() -> Result {
    let spade = Spade::start(Vec::new(), Vec::new()).await?;
    let (_, body) = spade.get("/v1/agents").await?;
    let main = body["agents"]
        .as_array()
        .and_then(|all| all.iter().find(|a| a["kind"] == "main").cloned())
        .unwrap_or_default();
    let id = main["id"].as_str().unwrap_or_default();
    let (status, body) = pin(&spade, "agents", id, true).await?;
    assert_eq!(status, 200, "{body}");
    assert!(body["agent"]["pinned_at"].is_i64(), "{body}");
    Ok(())
}

#[tokio::test]
async fn a_group_is_pinned_and_unpinned_like_a_bot() -> Result {
    let spade = Spade::start(Vec::new(), Vec::new()).await?;
    let one = spade.new_agent("One", "").await?;
    let (status, body) = spade
        .post(
            "/v1/groups",
            json!({ "name": "Crew", "members": [{ "agent": one["id"] }] }),
        )
        .await?;
    assert_eq!(status, 201, "{body}");
    let group = body["group"].clone();
    let id = group["id"].as_str().unwrap_or_default();
    assert_eq!(group["pinned_at"], Value::Null);

    let (status, body) = pin(&spade, "groups", id, true).await?;
    assert_eq!(status, 200, "{body}");
    let at = body["group"]["pinned_at"].clone();
    assert!(at.is_i64(), "{body}");
    assert_eq!(pinned_at(&spade, "groups", "groups", id).await?, at);

    let (_, body) = pin(&spade, "groups", id, false).await?;
    assert_eq!(body["group"]["pinned_at"], Value::Null);
    Ok(())
}

#[tokio::test]
async fn pinning_something_that_is_gone_is_a_404() -> Result {
    let spade = Spade::start(Vec::new(), Vec::new()).await?;
    assert_eq!(pin(&spade, "agents", "nope", true).await?.0, 404);
    assert_eq!(pin(&spade, "groups", "nope", true).await?.0, 404);
    Ok(())
}
