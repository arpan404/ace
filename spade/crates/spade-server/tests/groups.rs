//! Groups (ADR 0132): the person posts, the lead answers or hands work to members, `@Name`
//! goes straight to a member, members' answers are posted as their own messages, chains are
//! bounded, and Stop stops every member.

mod support;

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use spade_testkit::{FakeProvider, Script};
use support::{Result, Spade};

/// An endpoint on its own fake, so each bot's requests follow their own script.
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

/// Titles go to a fake of their own, so they never take a bot's script.
async fn quiet_titles(spade: &Spade) -> Result<FakeProvider> {
    let fake = own_endpoint(
        spade,
        "Titles",
        vec![Script::reply("").plain(r#"{"title":"T"}"#)],
    )
    .await?;
    spade
        .put("/v1/settings", json!({ "fast_model": "titles/t" }))
        .await?;
    Ok(fake)
}

/// A bot on its own endpoint (named after it) answering with `scripts`.
async fn bot(spade: &Spade, name: &str, scripts: Vec<Script>) -> Result<(Value, FakeProvider)> {
    let endpoint = format!("{name} Net");
    let fake = own_endpoint(spade, &endpoint, scripts).await?;
    let model = format!("{}-net/m", name.to_lowercase());
    let (status, body) = spade
        .post("/v1/agents", json!({ "name": name, "model": model }))
        .await?;
    assert_eq!(status, 201, "{body}");
    Ok((body["agent"].clone(), fake))
}

async fn group(spade: &Spade, name: &str, members: &[&Value]) -> Result<Value> {
    let members: Vec<Value> = members
        .iter()
        .map(|m| json!({ "agent": m["id"] }))
        .collect();
    let (status, body) = spade
        .post("/v1/groups", json!({ "name": name, "members": members }))
        .await?;
    assert_eq!(status, 201, "{body}");
    Ok(body["group"].clone())
}

async fn post(spade: &Spade, group: &Value, text: &str) -> Result {
    let (status, body) = spade
        .post(
            &format!("/v1/groups/{}/messages", group["id"].as_str().unwrap_or("")),
            json!({ "text": text }),
        )
        .await?;
    assert_eq!(status, 202, "{body}");
    Ok(())
}

fn conversation(value: &Value) -> String {
    value["conversation"]
        .as_str()
        .unwrap_or_default()
        .to_owned()
}

/// The group's bubbles in order: (who, text), the person as `person`.
fn bubbles(events: &[Value]) -> Vec<(String, String)> {
    events
        .iter()
        .filter(|e| e["type"] == "group_message")
        .map(|e| {
            let who = e["from"]["name"].as_str().unwrap_or("person").to_owned();
            (who, e["text"].as_str().unwrap_or("").to_owned())
        })
        .collect()
}

#[tokio::test]
async fn the_lead_hands_part_to_a_member_and_both_answers_are_posted_as_their_bubbles() -> Result {
    let spade = Spade::start(
        vec![
            Script::reply("").call(
                "g1",
                "group_ask",
                json!({ "member": "Research", "text": "Find X" }),
            ),
            Script::reply("Research found it: X is 42."),
        ],
        Vec::new(),
    )
    .await?;
    let _titles = quiet_titles(&spade).await?;
    let (research, research_fake) =
        bot(&spade, "Research", vec![Script::reply("X is 42.")]).await?;
    let (writer, writer_fake) = bot(&spade, "Writer", vec![Script::reply("unused")]).await?;
    let team = group(&spade, "Launch team", &[&research, &writer]).await?;
    assert_eq!(team["lead"]["name"], "Spade", "Spade leads by default");
    assert_eq!(team["members"].as_array().map(Vec::len), Some(3));

    post(&spade, &team, "What is X?").await?;
    let events = spade
        .wait_for_count(&conversation(&team), "group_message", 3)
        .await?;
    assert_eq!(
        bubbles(&events),
        vec![
            ("person".to_owned(), "What is X?".to_owned()),
            ("Research".to_owned(), "X is 42.".to_owned()),
            ("Spade".to_owned(), "Research found it: X is 42.".to_owned()),
        ]
    );
    let handoff = events
        .iter()
        .find(|e| e["type"] == "group_asked" && e["by"]["name"] == "Spade")
        .cloned()
        .unwrap_or_default();
    assert_eq!(handoff["to"]["name"], "Research", "the handoff is a line");
    assert!(
        !events.iter().any(|e| e["type"] == "tool_started"),
        "no tool calls in the group"
    );
    let told = research_fake.seen()[0].body["messages"].to_string();
    assert!(
        told.contains("Launch team"),
        "the member knows the group: {told}"
    );
    let theirs = spade.events(&conversation(&research)).await?;
    let asked = theirs
        .iter()
        .find(|e| e["type"] == "user_message")
        .cloned()
        .unwrap_or_default();
    assert_eq!(asked["from_group"]["name"], "Launch team");
    assert_eq!(
        asked["from_agent"]["name"], "Spade",
        "a bot's ask is from that bot"
    );
    assert!(writer_fake.seen().is_empty(), "the writer was never asked");
    let _ = writer;

    let (_, listed) = spade.get("/v1/groups").await?;
    let shown = &listed["groups"][0];
    assert_eq!(shown["last_message"]["agent"]["name"], "Spade");
    assert_eq!(shown["state"], "idle");
    Ok(())
}

#[tokio::test]
async fn a_mention_goes_straight_to_that_member_and_not_to_the_lead() -> Result {
    let spade = Spade::start(
        vec![Script::reply("the lead should not answer")],
        Vec::new(),
    )
    .await?;
    let _titles = quiet_titles(&spade).await?;
    let (research, _research_fake) = bot(&spade, "Research", vec![Script::reply("unused")]).await?;
    let (writer, _writer_fake) = bot(&spade, "Writer", vec![Script::reply("A draft.")]).await?;
    let team = group(&spade, "Docs", &[&research, &writer]).await?;

    post(&spade, &team, "@writer draft the intro").await?;
    let events = spade
        .wait_for_count(&conversation(&team), "group_message", 2)
        .await?;
    assert_eq!(
        bubbles(&events)[1],
        ("Writer".to_owned(), "A draft.".to_owned())
    );
    assert!(spade.fake.seen().is_empty(), "the lead was not asked");
    let research_events = spade.events(&conversation(&research)).await?;
    assert!(
        !research_events.iter().any(|e| e["type"] == "user_message"),
        "only the mentioned member is asked"
    );
    Ok(())
}

#[tokio::test]
async fn a_group_turn_never_marks_the_members_own_chat_unseen_or_shows_in_its_row() -> Result {
    let spade = Spade::start(vec![Script::reply("unused")], Vec::new()).await?;
    let _titles = quiet_titles(&spade).await?;
    let (research, _research_fake) = bot(&spade, "Research", vec![Script::reply("unused")]).await?;
    let (writer, _writer_fake) = bot(
        &spade,
        "Writer",
        vec![Script::reply("Hello."), Script::reply("A draft.")],
    )
    .await?;
    let own = conversation(&writer);
    let writer_id = writer["id"].as_str().unwrap_or_default().to_owned();
    spade.say(&own, "Hi").await?;
    spade.wait_for(&own, "reply_finished").await?;
    let (status, body) = spade
        .put(&format!("/v1/conversations/{own}/seen"), json!({}))
        .await?;
    assert_eq!(status, 200, "{body}");
    let team = group(&spade, "Docs", &[&research, &writer]).await?;

    post(&spade, &team, "@writer draft the intro").await?;
    spade
        .wait_for_count(&conversation(&team), "group_message", 2)
        .await?;
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    let row = loop {
        let (_, agents) = spade.get("/v1/agents").await?;
        let row = agents["agents"]
            .as_array()
            .and_then(|all| all.iter().find(|a| a["id"] == writer_id.as_str()).cloned())
            .unwrap_or_default();
        if row["state"] == "idle" || std::time::Instant::now() > deadline {
            break row;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    assert_eq!(row["state"], "idle", "{row}");
    assert_eq!(row["unseen"], false, "the group turn is the group's: {row}");
    assert_eq!(
        (&row["last_message"]["from"], &row["last_message"]["text"]),
        (&json!("agent"), &json!("Hello.")),
        "its own chat's last word, not the group's: {row}"
    );
    Ok(())
}

#[tokio::test]
async fn members_ask_each_other_but_an_ask_back_up_the_chain_is_refused_as_a_cycle() -> Result {
    let spade = Spade::start(
        vec![
            Script::reply("").call(
                "s1",
                "group_ask",
                json!({ "member": "Research", "text": "Find X" }),
            ),
            Script::reply("Done."),
        ],
        Vec::new(),
    )
    .await?;
    let _titles = quiet_titles(&spade).await?;
    let (research, _r) = bot(
        &spade,
        "Research",
        vec![
            Script::reply("").call(
                "r1",
                "group_ask",
                json!({ "member": "Writer", "text": "Write X up" }),
            ),
            Script::reply("Research done."),
        ],
    )
    .await?;
    let (writer, _w) = bot(
        &spade,
        "Writer",
        vec![
            Script::reply("").call(
                "w1",
                "group_ask",
                json!({ "member": "Research", "text": "Check again" }),
            ),
            Script::reply("Writer done."),
        ],
    )
    .await?;
    let team = group(&spade, "Loop", &[&research, &writer]).await?;
    post(&spade, &team, "Go").await?;
    let events = spade
        .wait_for_count(&conversation(&team), "group_message", 4)
        .await?;
    let asks: Vec<(String, String, u64)> = events
        .iter()
        .filter(|e| e["type"] == "group_asked")
        .map(|e| {
            (
                e["by"]["name"].as_str().unwrap_or("person").to_owned(),
                e["to"]["name"].as_str().unwrap_or("").to_owned(),
                e["depth"].as_u64().unwrap_or(0),
            )
        })
        .collect();
    assert_eq!(
        asks,
        vec![
            ("person".to_owned(), "Spade".to_owned(), 1),
            ("Spade".to_owned(), "Research".to_owned(), 2),
            ("Research".to_owned(), "Writer".to_owned(), 3),
        ],
        "a member's ask to another member is shown; the ask back to Research never happens"
    );
    let writer_events = spade.events(&conversation(&writer)).await?;
    let refused = writer_events
        .iter()
        .find(|e| e["type"] == "tool_finished" && e["name"] == "group_ask")
        .cloned()
        .unwrap_or_default();
    assert_eq!(refused["is_error"], true);
    assert!(
        refused["content"]
            .as_str()
            .unwrap_or("")
            .contains("waiting on your answer already"),
        "Research waits on Writer, so it could never answer: {refused}"
    );
    Ok(())
}

#[tokio::test]
async fn stop_in_a_group_stops_every_member_and_posts_no_partial_answer() -> Result {
    let spade = Spade::start(vec![Script::reply("unused")], Vec::new()).await?;
    let _titles = quiet_titles(&spade).await?;
    let slow = || Script::reply("This takes a long time.").delay(Duration::from_secs(30));
    let (research, _r) = bot(&spade, "Research", vec![slow()]).await?;
    let (writer, _w) = bot(&spade, "Writer", vec![slow()]).await?;
    let team = group(&spade, "Slow", &[&research, &writer]).await?;
    post(&spade, &team, "@Research and @Writer, both of you please").await?;
    spade
        .wait_for(&conversation(&research), "reply_started")
        .await?;
    spade
        .wait_for(&conversation(&writer), "reply_started")
        .await?;
    let (_, listed) = spade.get("/v1/groups").await?;
    assert_eq!(listed["groups"][0]["state"], "working");
    assert_eq!(
        listed["groups"][0]["status"],
        "Research and Writer are answering"
    );

    let (status, body) = spade
        .post(
            &format!("/v1/groups/{}/stop", team["id"].as_str().unwrap_or("")),
            json!({}),
        )
        .await?;
    assert_eq!(status, 204, "{body}");
    spade
        .wait_for(&conversation(&research), "reply_stopped")
        .await?;
    spade
        .wait_for(&conversation(&writer), "reply_stopped")
        .await?;
    let events = spade
        .wait_for_count(&conversation(&team), "group_answered", 2)
        .await?;
    assert!(events.iter().any(|e| e["type"] == "group_stopped"));
    let outcomes: Vec<&str> = events
        .iter()
        .filter(|e| e["type"] == "group_answered")
        .filter_map(|e| e["outcome"].as_str())
        .collect();
    assert_eq!(outcomes, vec!["stopped", "stopped"]);
    assert_eq!(
        bubbles(&events).len(),
        1,
        "only the person's message is shown"
    );
    Ok(())
}

#[tokio::test]
async fn a_group_transcript_takes_no_direct_messages_and_a_group_needs_two_bots() -> Result {
    let spade = Spade::start(vec![Script::reply("unused")], Vec::new()).await?;
    let (research, _r) = bot(&spade, "Research", vec![Script::reply("unused")]).await?;
    let team = group(&spade, "Pair", &[&research]).await?;
    let (status, _) = spade
        .post(
            &format!("/v1/conversations/{}/messages", conversation(&team)),
            json!({ "text": "hi" }),
        )
        .await?;
    assert_eq!(status, 409, "posting goes through the group");
    let (status, _) = spade
        .post(
            "/v1/groups",
            json!({ "name": "Alone", "members": [{ "agent": research["id"] }], "lead": research["id"] }),
        )
        .await?;
    assert_eq!(status, 400, "a lead and nobody else is not a group");
    let (status, _) = spade
        .post(
            "/v1/groups",
            json!({ "name": "Ghost", "members": [{ "agent": "a_nobody" }] }),
        )
        .await?;
    assert_eq!(status, 404);
    Ok(())
}

#[tokio::test]
async fn a_group_names_the_member_that_waits_for_the_person_by_id_live_and_listed() -> Result {
    use futures_util::StreamExt;
    let mail = support::FakeTool::new("send_mail", spade_core::tools::Risk::Write, "sent");
    let spade = Spade::start(vec![Script::reply("unused")], vec![Arc::new(mail)]).await?;
    let _titles = quiet_titles(&spade).await?;
    let (research, _r) = bot(
        &spade,
        "Research",
        vec![
            Script::reply("").call("m1", "send_mail", json!({ "to": "sam" })),
            Script::reply("Sent."),
        ],
    )
    .await?;
    let (writer, _w) = bot(&spade, "Writer", vec![Script::reply("unused")]).await?;
    let team = group(&spade, "Mail", &[&research, &writer]).await?;
    let mut live = spade
        .http
        .get(format!(
            "{}/v1/conversations/{}/live?after=0",
            spade.base,
            conversation(&team)
        ))
        .bearer_auth(support::TOKEN)
        .send()
        .await?
        .bytes_stream();
    post(&spade, &team, "@Research mail Sam").await?;

    let mut seen = String::new();
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while !seen.contains("waiting_member") && std::time::Instant::now() < deadline {
        if let Ok(Some(Ok(chunk))) = tokio::time::timeout(Duration::from_secs(1), live.next()).await
        {
            seen.push_str(&String::from_utf8_lossy(&chunk));
        }
    }
    let frame = seen
        .lines()
        .filter_map(|line| line.strip_prefix("data: "))
        .filter_map(|data| serde_json::from_str::<Value>(data).ok())
        .find(|data| data.get("waiting_member").is_some())
        .unwrap_or_default();
    assert_eq!(frame["state"], "waiting", "{seen}");
    assert_eq!(frame["waiting_member"]["id"], research["id"]);

    let (_, listed) = spade.get("/v1/groups").await?;
    assert_eq!(listed["groups"][0]["waiting_member"]["id"], research["id"]);
    Ok(())
}

/// `count` bots on the shared fake, named Bot1, Bot2, …
async fn many_bots(spade: &Spade, count: usize) -> Result<Vec<Value>> {
    let mut bots = Vec::new();
    for n in 1..=count {
        bots.push(spade.new_agent(&format!("Bot{n}"), "").await?);
    }
    Ok(bots)
}

#[tokio::test]
async fn a_club_holds_32_bots() -> Result {
    let spade = Spade::start(vec![Script::reply("unused")], Vec::new()).await?;
    let bots = many_bots(&spade, 32).await?;
    let members = |bots: &[Value]| -> Vec<Value> {
        bots.iter().map(|b| json!({ "agent": b["id"] })).collect()
    };
    // 32 with the lead among them.
    let (status, body) = spade
        .post(
            "/v1/groups",
            json!({ "name": "Big", "members": members(&bots), "lead": bots[0]["id"] }),
        )
        .await?;
    assert_eq!(status, 201, "{body}");
    assert_eq!(body["group"]["members"].as_array().map(Vec::len), Some(32));
    let extra = spade.new_agent("Bot33", "").await?;
    let mut too_many = bots.clone();
    too_many.push(extra);
    let (status, body) = spade
        .post(
            "/v1/groups",
            json!({ "name": "Bigger", "members": members(&too_many), "lead": bots[0]["id"] }),
        )
        .await?;
    assert_eq!(status, 400, "{body}");
    Ok(())
}

#[tokio::test]
async fn a_club_message_naming_30_members_runs_only_the_lead_who_hands_it_on() -> Result {
    let spade = Spade::start(vec![Script::reply("I'll ask each of them.")], Vec::new()).await?;
    let _titles = quiet_titles(&spade).await?;
    let bots = many_bots(&spade, 30).await?;
    let members: Vec<Value> = bots.iter().map(|b| json!({ "agent": b["id"] })).collect();
    let (status, body) = spade
        .post(
            "/v1/groups",
            json!({ "name": "Big", "members": members, "lead": bots[0]["id"] }),
        )
        .await?;
    assert_eq!(status, 201, "{body}");
    let team = body["group"].clone();
    let everyone: Vec<String> = (1..=30).map(|n| format!("@Bot{n}")).collect();
    post(
        &spade,
        &team,
        &format!("{} what's your status?", everyone.join(" ")),
    )
    .await?;
    spade
        .wait_for_count(&conversation(&team), "group_message", 2)
        .await?;
    // One model turn ran: the lead's, told who else was named.
    let turns: Vec<_> = spade
        .fake
        .seen()
        .into_iter()
        .filter(|s| s.body["stream"] == true)
        .collect();
    assert_eq!(turns.len(), 1);
    let lead_events = spade.events(&conversation(&bots[0])).await?;
    let asked = lead_events
        .iter()
        .find(|e| e["type"] == "user_message")
        .map(|e| e["text"].as_str().unwrap_or("").to_owned())
        .unwrap_or_default();
    assert!(asked.contains("the person named 29 members"), "{asked}");
    for bot in &bots[1..] {
        let events = spade.events(&conversation(bot)).await?;
        assert!(
            !events.iter().any(|e| e["type"] == "user_message"),
            "{} was not run",
            bot["name"]
        );
    }
    Ok(())
}
