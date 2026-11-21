//! "Why do you think that?": a note or knowledge entry a bot writes records where it came from
//! (the conversation, the person's message it answered, the call), the API shows it, and
//! forgetting a source removes everything learned from it while the person's own words stay.

mod support;

use serde_json::{Value, json};
use spade_testkit::Script;
use support::{Result, Spade};

fn title() -> Script {
    Script::reply("").plain(r#"{"title":"Trips"}"#)
}

async fn sources(spade: &Spade, bot: &str) -> Result<Vec<Value>> {
    let (status, body) = spade.get(&format!("/v1/agents/{bot}/learned")).await?;
    assert_eq!(status, 200, "{body}");
    Ok(body["sources"].as_array().cloned().unwrap_or_default())
}

#[tokio::test]
async fn forgetting_a_source_removes_what_came_from_it_and_keeps_the_persons_words() -> Result {
    let spade = Spade::start(
        vec![
            Script::reply("").call(
                "c1",
                "memory_save",
                json!({ "text": "Prefers aisle seats" }),
            ),
            Script::reply("Noted."),
            title(),
            Script::reply("").call(
                "c2",
                "knowledge_write",
                json!({
                    "topic": "airlines", "title": "Baggage rules", "body": "23 kg in economy.",
                    "kind": "fact", "source": "web",
                    "source_detail": "https://www.example-air.com/baggage",
                }),
            ),
            Script::reply("Kept it."),
        ],
        Vec::new(),
    )
    .await?;
    let agent = spade.new_agent("Trips", "Plan trips.").await?;
    let bot = agent["id"].as_str().unwrap_or_default().to_owned();
    let conversation = agent["conversation"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    spade.say(&conversation, "I like aisle seats").await?;
    spade.wait_for(&conversation, "reply_finished").await?;
    spade
        .say(&conversation, "Look up the baggage rules")
        .await?;
    spade
        .wait_for_count(&conversation, "reply_finished", 2)
        .await?;
    // The person's own note, which no source owns.
    let (status, mine) = spade
        .post(
            &format!("/v1/agents/{bot}/notes"),
            json!({ "text": "Vegetarian" }),
        )
        .await?;
    assert_eq!(status, 201, "{mine}");

    // Where the bot's note came from: this conversation, answering the person's message.
    let (_, notes) = spade.get(&format!("/v1/agents/{bot}/notes")).await?;
    let saved = notes["notes"]
        .as_array()
        .and_then(|all| all.iter().find(|n| n["text"] == "Prefers aisle seats"))
        .cloned()
        .unwrap_or_default();
    let id = saved["id"].as_str().unwrap_or_default();
    let (status, why) = spade.get(&format!("/v1/notes/{id}/provenance")).await?;
    assert_eq!(status, 200, "{why}");
    assert_eq!(why["conversation"]["id"], json!(conversation));
    assert_eq!(why["conversation"]["name"], "Trips");
    assert_eq!(why["message"]["text"], "I like aisle seats");
    assert_eq!(why["call"], "c1");
    assert_eq!(why["source"], "bot");

    // The page's entry answers to the site as well as the conversation.
    let listed = sources(&spade, &bot).await?;
    let keys: Vec<&str> = listed.iter().filter_map(|s| s["key"].as_str()).collect();
    let here = format!("conversation:{conversation}");
    assert!(keys.contains(&"web:example-air.com"), "{listed:?}");
    assert!(keys.contains(&here.as_str()), "{listed:?}");
    let from_here = listed.iter().find(|s| s["key"] == json!(here)).cloned();
    assert_eq!(
        from_here.map(|s| (s["notes"].clone(), s["entries"].clone(), s["label"].clone())),
        Some((json!(1), json!(1), json!("Your conversation with Trips")))
    );

    // Forgetting the site takes only the page's entry.
    let (status, gone) = spade
        .post(
            &format!("/v1/agents/{bot}/learned/forget"),
            json!({ "source": "web:example-air.com" }),
        )
        .await?;
    assert_eq!(status, 200, "{gone}");
    assert_eq!(gone, json!({ "notes": 0, "entries": 1 }));
    let (_, entries) = spade.get(&format!("/v1/agents/{bot}/knowledge")).await?;
    assert_eq!(entries["entries"], json!([]));

    // Forgetting the conversation takes the bot's note; the person's stays.
    let (_, gone) = spade
        .post(
            &format!("/v1/agents/{bot}/learned/forget"),
            json!({ "source": here }),
        )
        .await?;
    assert_eq!(gone, json!({ "notes": 1, "entries": 0 }));
    let (_, notes) = spade.get(&format!("/v1/agents/{bot}/notes")).await?;
    let left: Vec<&str> = notes["notes"]
        .as_array()
        .map(|all| all.iter().filter_map(|n| n["text"].as_str()).collect())
        .unwrap_or_default();
    assert_eq!(left, vec!["Vegetarian"]);
    assert!(sources(&spade, &bot).await?.is_empty());
    Ok(())
}
