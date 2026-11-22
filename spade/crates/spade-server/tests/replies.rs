//! Replying to a message (ADR 0212 §4) through the real API: the person posts with `reply_to`,
//! Spade stores what it quoted on the message and the model reads it before the person's words.
//! An id that names nothing is dropped and the message still goes.

mod support;

use serde_json::{Value, json};
use spade_testkit::{FakeProvider, Script};
use support::{Result, Spade};

/// Every text the model was sent in its last request, in order.
fn last_prompt(fake: &FakeProvider) -> String {
    let seen = fake.seen();
    let Some(last) = seen.last() else {
        return String::new();
    };
    last.body["messages"]
        .as_array()
        .map(|messages| {
            messages
                .iter()
                .filter_map(|m| m["content"].as_str())
                .collect::<Vec<_>>()
                .join("\n---\n")
        })
        .unwrap_or_default()
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

fn seq_of(rows: &[(i64, Value)], kind: &str) -> i64 {
    rows.iter()
        .rev()
        .find(|(_, e)| e["type"] == kind)
        .map_or(0, |(seq, _)| *seq)
}

#[tokio::test]
async fn the_persons_reply_is_stored_with_the_words_it_quotes_and_reaches_the_model() -> Result {
    let spade = Spade::start(
        vec![
            Script::reply("<msg>Found 3.</msg>\n<msg>Cheapest is 9:10.</msg>")
                .plain(r#"{"title":"Flights"}"#),
            Script::reply("<msg>Booked.</msg>"),
            Script::reply("Sure."),
        ],
        Vec::new(),
    )
    .await?;
    let id = spade.ask("Flights to Lisbon?").await?;
    spade.wait_for(&id, "reply_finished").await?;
    let step = seq_of(&rows(&spade, &id).await?, "step_finished");

    let quoted = format!("m{step}.2");
    let (status, body) = spade
        .post(
            &format!("/v1/conversations/{id}/messages"),
            json!({ "text": "Book that one", "reply_to": quoted }),
        )
        .await?;
    assert_eq!(status, 202, "{body}");
    spade.wait_for_count(&id, "reply_finished", 2).await?;
    let stored = rows(&spade, &id).await?;
    let mine = seq_of(&stored, "user_message");
    let message = &stored[usize::try_from(mine - 1)?].1;
    assert_eq!(message["text"], "Book that one");
    assert_eq!(
        message["reply_to"],
        json!({ "id": quoted, "text": "Cheapest is 9:10.", "mine": false })
    );
    let prompt = last_prompt(&spade.fake);
    assert!(
        prompt.contains(&format!(
            "[m{mine}] (replying to your message {quoted}: \"Cheapest is 9:10.\")\nBook that one"
        )),
        "{prompt}"
    );
    // The bot's own earlier words read back with their ids.
    assert!(
        prompt.contains(&format!("<msg id=\"m{step}.2\">Cheapest is 9:10.</msg>")),
        "{prompt}"
    );

    // An id that names no message is dropped; the message still goes as typed.
    let (status, body) = spade
        .post(
            &format!("/v1/conversations/{id}/messages"),
            json!({ "text": "And a hotel", "reply_to": "m999" }),
        )
        .await?;
    assert_eq!(status, 202, "{body}");
    spade.wait_for_count(&id, "reply_finished", 3).await?;
    let stored = rows(&spade, &id).await?;
    let last = &stored[usize::try_from(seq_of(&stored, "user_message") - 1)?].1;
    assert_eq!(last["text"], "And a hotel");
    assert!(last.get("reply_to").is_none(), "{last}");
    Ok(())
}

/// An endpoint on its own fake, so a bot's requests follow its own script.
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

fn text(value: &Value) -> String {
    value.as_str().unwrap_or_default().to_owned()
}

#[tokio::test]
async fn a_reply_in_a_club_is_stored_on_its_message_and_the_member_reads_whose_words_it_quotes()
-> Result {
    let spade = Spade::start(vec![Script::reply("the lead is not asked")], Vec::new()).await?;
    let _titles = own_endpoint(
        &spade,
        "Titles",
        vec![Script::reply("").plain(r#"{"title":"T"}"#)],
    )
    .await?;
    spade
        .put("/v1/settings", json!({ "fast_model": "titles/t" }))
        .await?;
    let (writer, writer_fake) = bot(
        &spade,
        "Writer",
        vec![
            Script::reply("<msg>A draft.</msg>\n<msg>Shorter?</msg>"),
            Script::reply("Done."),
        ],
    )
    .await?;
    let (other, _other_fake) = bot(&spade, "Other", vec![Script::reply("unused")]).await?;
    let (status, body) = spade
        .post(
            "/v1/groups",
            json!({ "name": "Docs", "members": [{ "agent": writer["id"] }, { "agent": other["id"] }] }),
        )
        .await?;
    assert_eq!(status, 201, "{body}");
    let club = &body["group"];
    let (club_id, transcript) = (text(&club["id"]), text(&club["conversation"]));
    let post = |body: Value| {
        let spade = &spade;
        let path = format!("/v1/groups/{club_id}/messages");
        async move { spade.post(&path, body).await }
    };

    let (status, body) = post(json!({ "text": "@writer draft the intro" })).await?;
    assert_eq!(status, 202, "{body}");
    spade
        .wait_for_count(&transcript, "group_message", 2)
        .await?;
    let answer = seq_of(&rows(&spade, &transcript).await?, "group_message");

    let quoted = format!("m{answer}.2");
    let (status, body) =
        post(json!({ "text": "@writer yes, shorter", "reply_to": quoted })).await?;
    assert_eq!(status, 202, "{body}");
    let events = spade
        .wait_for_count(&transcript, "group_message", 4)
        .await?;
    let posted = events
        .iter()
        .filter(|e| e["type"] == "group_message" && e["from"].is_null())
        .last()
        .cloned()
        .unwrap_or_default();
    assert_eq!(
        posted["reply_to"],
        json!({ "id": quoted, "text": "Shorter?", "mine": false, "name": "Writer" })
    );
    let prompt = last_prompt(&writer_fake);
    assert!(
        prompt.contains("(replying to Writer's message: \"Shorter?\")\n@writer yes, shorter"),
        "{prompt}"
    );
    Ok(())
}
