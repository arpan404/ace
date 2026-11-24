//! Reactions (docs/chat-core.md, Messages, ids and replies) through the real API: the person puts
//! an emoji on a message or takes it back, which is stored and served like any event but starts
//! no turn; the model reads it once, at the end of its next prompt. A bot's `<react>` in its
//! words is stored as the bot's reaction.

mod support;

use std::time::Duration;

use futures_util::StreamExt;
use serde_json::{Value, json};
use spade_testkit::{FakeProvider, Script};
use support::{Result, Spade};

/// The messages of each streamed model request (titles left out), in order.
fn prompts(fake: &FakeProvider) -> Vec<Vec<Value>> {
    fake.seen()
        .iter()
        .filter(|s| s.body["stream"] == true)
        .map(|s| s.body["messages"].as_array().cloned().unwrap_or_default())
        .collect()
}

/// The stored rows of a conversation: `(seq, event)`.
async fn rows(spade: &Spade, id: &str) -> Result<Vec<(i64, Value)>> {
    let (_, body) = spade.get(&format!("/v1/conversations/{id}/events")).await?;
    Ok(body
        .as_array()
        .map(|rows| {
            rows.iter()
                .map(|r| (r["seq"].as_i64().unwrap_or(0), r["event"].clone()))
                .collect()
        })
        .unwrap_or_default())
}

fn last_seq(rows: &[(i64, Value)], kind: &str) -> i64 {
    rows.iter()
        .rev()
        .find(|(_, e)| e["type"] == kind)
        .map_or(0, |(seq, _)| *seq)
}

fn reactions(rows: &[(i64, Value)]) -> Vec<Value> {
    rows.iter()
        .filter(|(_, e)| e["type"] == "reaction")
        .map(|(_, e)| e.clone())
        .collect()
}

fn count(rows: &[(i64, Value)], kind: &str) -> usize {
    rows.iter().filter(|(_, e)| e["type"] == kind).count()
}

#[tokio::test]
async fn the_persons_reaction_is_stored_starts_no_turn_and_the_model_reads_it_once_at_the_end()
-> Result {
    let spade = Spade::start(
        vec![
            Script::reply("<msg>Found 3.</msg>\n<msg>Cheapest is 9:10.</msg>"),
            Script::reply("").plain(r#"{"title":"Flights"}"#),
            Script::reply("Booking it."),
            Script::reply("Noted."),
            Script::reply("Alright."),
        ],
        Vec::new(),
    )
    .await?;
    let id = spade.ask("Flights to Lisbon?").await?;
    spade.wait_for(&id, "reply_finished").await?;
    let before = rows(&spade, &id).await?;
    let step = last_seq(&before, "step_finished");
    let on = format!("m{step}.2");
    let path = format!("/v1/conversations/{id}/messages/{on}/reactions");

    // The live stream sends the reaction as a stored event.
    let after = before.last().map_or(0, |(seq, _)| *seq);
    let response = spade
        .http
        .get(format!(
            "{}/v1/conversations/{id}/live?after={after}",
            spade.base
        ))
        .bearer_auth(support::TOKEN)
        .send()
        .await?;
    let mut live = response.bytes_stream();

    // A replaced reaction: the later one stands.
    for emoji in ["👍", "❤️"] {
        let (status, body) = spade.post(&path, json!({ "emoji": emoji })).await?;
        assert_eq!(status, 202, "{body}");
    }
    let mut streamed = String::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while !streamed.contains("❤️") && tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_secs(5), live.next()).await {
            Ok(Some(Ok(chunk))) => streamed.push_str(&String::from_utf8_lossy(&chunk)),
            _ => break,
        }
    }
    assert!(streamed.contains("event: stored"), "{streamed}");
    assert!(
        streamed.contains("\"type\":\"reaction\"") && streamed.contains("\"by\":\"person\""),
        "{streamed}"
    );
    let stored = rows(&spade, &id).await?;
    assert_eq!(
        reactions(&stored),
        vec![
            json!({ "type": "reaction", "message": on, "emoji": "👍", "by": "person" }),
            json!({ "type": "reaction", "message": on, "emoji": "❤️", "by": "person" }),
        ]
    );
    // No turn started for it: the model was asked nothing more.
    assert_eq!(count(&stored, "reply_started"), 1);
    assert_eq!(prompts(&spade.fake).len(), 1);

    // On the next message the model reads the standing reaction once, before the person's words.
    spade.say(&id, "Book it").await?;
    spade.wait_for_count(&id, "reply_finished", 2).await?;
    let mine = last_seq(&rows(&spade, &id).await?, "user_message");
    let second = prompts(&spade.fake).pop().unwrap_or_default();
    let tail = second.last().cloned().unwrap_or(Value::Null);
    assert_eq!(
        tail["content"],
        format!("[the person reacted ❤️ to {on}]\n\n[m{mine}] Book it"),
        "{tail}"
    );

    // Taken back: stored with the emoji it took back, told once on the next step.
    let (status, body) = spade.delete(&path).await?;
    assert_eq!(status, 202, "{body}");
    spade.say(&id, "Thanks").await?;
    spade.wait_for_count(&id, "reply_finished", 3).await?;
    let stored = rows(&spade, &id).await?;
    assert_eq!(
        reactions(&stored).last(),
        Some(
            &json!({ "type": "reaction", "message": on, "emoji": "❤️", "by": "person", "removed": true })
        )
    );
    let third = prompts(&spade.fake).pop().unwrap_or_default();
    // What the model read before is unchanged, and the first note is not told again.
    assert_eq!(third[..second.len()], second[..]);
    let all = Value::Array(third.clone()).to_string();
    assert_eq!(all.matches("[the person reacted ❤️").count(), 1, "{all}");
    assert!(!all.contains("reacted 👍"), "{all}");
    let tail = third.last().cloned().unwrap_or(Value::Null);
    let mine = last_seq(&stored, "user_message");
    assert_eq!(
        tail["content"],
        format!("[the person took back their reaction to {on}]\n\n[m{mine}] Thanks"),
        "{tail}"
    );
    assert_eq!(count(&stored, "reply_started"), 3);
    Ok(())
}

#[tokio::test]
async fn a_reaction_to_nothing_is_not_found_and_one_that_is_not_an_emoji_is_refused() -> Result {
    let spade = Spade::start(
        vec![Script::reply("Hello.").plain(r#"{"title":"Hi"}"#)],
        Vec::new(),
    )
    .await?;
    let id = spade.ask("Hi").await?;
    spade.wait_for(&id, "reply_finished").await?;
    let step = last_seq(&rows(&spade, &id).await?, "step_finished");
    let path = |id: &str, on: &str| format!("/v1/conversations/{id}/messages/{on}/reactions");

    for on in ["m999", "m1.7", "nonsense"] {
        let (status, _) = spade.post(&path(&id, on), json!({ "emoji": "👍" })).await?;
        assert_eq!(status, 404, "{on}");
        let (status, _) = spade.delete(&path(&id, on)).await?;
        assert_eq!(status, 404, "{on}");
    }
    let (status, _) = spade
        .post(&path("no-such-chat", "m1"), json!({ "emoji": "👍" }))
        .await?;
    assert_eq!(status, 404);
    for emoji in ["", "👍 👍", "a\nb", "\u{7}", "🎉🎉🎉🎉🎉"] {
        let (status, _) = spade
            .post(&path(&id, &format!("m{step}")), json!({ "emoji": emoji }))
            .await?;
        assert_eq!(status, 400, "{emoji:?}");
    }
    assert!(reactions(&rows(&spade, &id).await?).is_empty());
    Ok(())
}

#[tokio::test]
async fn a_bots_react_tag_is_stored_as_its_reaction_on_a_message_that_is_there() -> Result {
    let spade = Spade::start(
        vec![
            Script::reply("Hello."),
            Script::reply("").plain(r#"{"title":"Hi"}"#),
            Script::reply(
                "<react to=\"m1\">👍</react><react to=\"m999\">🎉</react><msg>Glad to help.</msg>",
            ),
            Script::reply("Bye."),
        ],
        Vec::new(),
    )
    .await?;
    let id = spade.ask("Hi").await?;
    spade.wait_for(&id, "reply_finished").await?;
    let first = last_seq(&rows(&spade, &id).await?, "user_message");
    assert_eq!(first, 1);
    spade.say(&id, "Thanks").await?;
    spade.wait_for_count(&id, "reply_finished", 2).await?;
    let stored = rows(&spade, &id).await?;
    // Only the reaction on a message that is there is stored; one on m999 names nothing.
    assert_eq!(
        reactions(&stored),
        vec![json!({ "type": "reaction", "message": "m1", "emoji": "👍", "by": "bot" })]
    );
    assert_eq!(count(&stored, "reply_started"), 2);

    // The model reads its own reaction back as it wrote it, and its message keeps the first id.
    let step = last_seq(&stored, "step_finished");
    spade.say(&id, "See you").await?;
    spade.wait_for_count(&id, "reply_finished", 3).await?;
    let all = Value::Array(prompts(&spade.fake).pop().unwrap_or_default()).to_string();
    assert!(
        all.contains(&format!(
            r#"<react to=\"m1\">👍</react>\n<react to=\"m999\">🎉</react>\n<msg id=\"m{step}\">Glad to help.</msg>"#
        )),
        "{all}"
    );
    assert!(!all.contains("[the person reacted"), "{all}");
    Ok(())
}

async fn own_endpoint(spade: &Spade, name: &str, scripts: Vec<Script>) -> Result<FakeProvider> {
    let fake = FakeProvider::start_sequence(scripts).await?;
    let (status, body) = spade
        .post(
            "/v1/endpoints",
            json!({ "name": name, "format": "openai-chat", "base_url": fake.root, "needs_key": false }),
        )
        .await?;
    assert_eq!(status, 201, "{body}");
    Ok(fake)
}

async fn bot(spade: &Spade, name: &str, scripts: Vec<Script>) -> Result<(Value, FakeProvider)> {
    let fake = own_endpoint(spade, &format!("{name} Net"), scripts).await?;
    let model = format!("{}-net/m", name.to_lowercase());
    let (status, body) = spade
        .post("/v1/agents", json!({ "name": name, "model": model }))
        .await?;
    assert_eq!(status, 201, "{body}");
    Ok((body["agent"].clone(), fake))
}

fn text_field(value: &Value) -> String {
    value.as_str().unwrap_or_default().to_owned()
}

#[tokio::test]
async fn club_member_react_tags_store_agent_identity_and_api_serves_grouped_reactions() -> Result {
    let spade = Spade::start(vec![Script::reply("unused")], Vec::new()).await?;
    let _titles = own_endpoint(
        &spade,
        "Titles",
        vec![Script::reply("").plain(r#"{"title":"T"}"#)],
    )
    .await?;
    spade
        .put("/v1/settings", json!({ "fast_model": "titles/t" }))
        .await?;
    let (flights, _flights_fake) = bot(
        &spade,
        "Flights",
        vec![Script::reply(
            "<react to=\"m1\">👍</react><msg>Checking TAP fares.</msg>",
        )],
    )
    .await?;
    let (inbox, _inbox_fake) = bot(
        &spade,
        "Inbox",
        vec![Script::reply("<react to=\"m1\">👍</react>")],
    )
    .await?;
    let flights_id = text_field(&flights["id"]);
    let inbox_id = text_field(&inbox["id"]);
    let (status, body) = spade
        .post(
            "/v1/groups",
            json!({
                "name": "Lisbon trip",
                "members": [{ "agent": flights_id }, { "agent": inbox_id }]
            }),
        )
        .await?;
    assert_eq!(status, 201, "{body}");
    let club = &body["group"];
    let club_id = text_field(&club["id"]);
    let transcript = text_field(&club["conversation"]);

    let (status, body) = spade
        .post(
            &format!("/v1/groups/{club_id}/messages"),
            json!({ "text": "@flights @inbox Lisbon dates locked" }),
        )
        .await?;
    assert_eq!(status, 202, "{body}");
    // Wait until both member asks have finished and both member reactions landed.
    spade
        .wait_for_count(&transcript, "group_answered", 2)
        .await?;
    spade.wait_for_count(&transcript, "reaction", 2).await?;

    let stored = rows(&spade, &transcript).await?;
    // Inbox only reacted (no words), so only the person's message and Flights' reply were posted.
    assert_eq!(count(&stored, "group_message"), 2);
    let flights_msg = format!("m{}", last_seq(&stored, "group_message"));

    // Both member bots' private chats got no stray reactions from answering the club ask.
    assert!(reactions(&rows(&spade, &text_field(&flights["conversation"])).await?).is_empty());
    assert!(reactions(&rows(&spade, &text_field(&inbox["conversation"])).await?).is_empty());

    // The person can react to any club message (their own and a member bot's).
    let (status, body) = spade
        .post(
            &format!("/v1/conversations/{transcript}/messages/m1/reactions"),
            json!({ "emoji": "❤️" }),
        )
        .await?;
    assert_eq!(status, 202, "{body}");
    let (status, body) = spade
        .post(
            &format!("/v1/conversations/{transcript}/messages/{flights_msg}/reactions"),
            json!({ "emoji": "🔥" }),
        )
        .await?;
    assert_eq!(status, 202, "{body}");

    // Aggregated summary API serves `{ emoji, by[] }` per message.
    let (status, summary) = spade
        .get(&format!("/v1/conversations/{transcript}/reactions"))
        .await?;
    assert_eq!(status, 200, "{summary}");
    let m1 = summary["reactions"]["m1"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    assert_eq!(m1.len(), 2, "{summary}");
    assert_eq!(m1[0]["emoji"], "👍");
    let mut thumbs_by: Vec<String> = m1[0]["by"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|v| v.as_str().map(str::to_owned))
        .collect();
    thumbs_by.sort();
    let mut expected_bots = vec![flights_id.clone(), inbox_id.clone()];
    expected_bots.sort();
    assert_eq!(thumbs_by, expected_bots);
    assert_eq!(m1[1], json!({ "emoji": "❤️", "by": ["person"] }));
    assert_eq!(
        summary["reactions"][&flights_msg],
        json!([{ "emoji": "🔥", "by": ["person"] }])
    );

    // Per-message GET and DELETE keep member reactions intact when the person removes theirs.
    let (status, _) = spade
        .delete(&format!(
            "/v1/conversations/{transcript}/messages/m1/reactions"
        ))
        .await?;
    assert_eq!(status, 202);
    let (status, one) = spade
        .get(&format!(
            "/v1/conversations/{transcript}/messages/m1/reactions"
        ))
        .await?;
    assert_eq!(status, 200, "{one}");
    let groups = one["reactions"].as_array().cloned().unwrap_or_default();
    assert_eq!(groups.len(), 1, "{one}");
    assert_eq!(groups[0]["emoji"], "👍");
    Ok(())
}
