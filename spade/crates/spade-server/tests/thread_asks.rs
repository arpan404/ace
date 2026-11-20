//! Asks from ace threads (ADR 0198): ace's daemon delivers the person's words to a bot or a club
//! once, by key and signed with its own token; the answer is read back by the key; the thread's
//! context pack makes the turn untrusted; the message keeps the thread it came from.

mod support;

use serde_json::{Value, json};
use spade_server::teams::proof::inbox_proof;
use spade_testkit::{FakeProvider, Script};
use support::{Options, Result, Spade, TOKEN};

/// ace's local token in its home, which signs every thread ask.
const DAEMON_TOKEN: &str = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

/// One request as ace's daemon sends it: Spade's bearer, `ace:thread`, and its signature.
async fn signed(
    spade: &Spade,
    method: reqwest::Method,
    path: &str,
    body: Option<&Value>,
    key: &str,
) -> Result<(u16, Value)> {
    let bytes = body
        .map(serde_json::to_vec)
        .transpose()?
        .unwrap_or_default();
    let time = now_ms();
    let proof = inbox_proof(key, time, "ace:thread", "ace", &bytes).unwrap_or_default();
    let mut request = reqwest::Client::new()
        .request(method, format!("{}{path}", spade.base))
        .bearer_auth(TOKEN)
        .header("x-ace-from-host", "ace:thread")
        .header("x-ace-from-name", "ace")
        .header("x-ace-inbox-time", time.to_string())
        .header("x-ace-inbox-proof", proof);
    if body.is_some() {
        request = request
            .header("content-type", "application/json")
            .body(bytes);
    }
    let answer = request.send().await?;
    let status = answer.status().as_u16();
    Ok((status, answer.json().await.unwrap_or(Value::Null)))
}

async fn ask(spade: &Spade, body: &Value) -> Result<(u16, Value)> {
    signed(
        spade,
        reqwest::Method::POST,
        "/v1/thread-asks",
        Some(body),
        DAEMON_TOKEN,
    )
    .await
}

async fn answer(spade: &Spade, key: &str) -> Result<Value> {
    let path = format!("/v1/thread-asks/{key}?wait_ms=8000");
    Ok(
        signed(spade, reqwest::Method::GET, &path, None, DAEMON_TOKEN)
            .await?
            .1,
    )
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

/// Spade with ace's home beside it, and titles on a quiet fake of their own.
async fn spade() -> Result<(Spade, FakeProvider)> {
    let home = tempfile::tempdir()?.keep();
    std::fs::write(home.join("daemon-token"), format!("{DAEMON_TOKEN}\n"))?;
    let spade = Spade::start_with(
        vec![Script::reply("unused")],
        Vec::new(),
        Options {
            ace_home: Some(home),
            ..Options::default()
        },
    )
    .await?;
    let titles = own_endpoint(
        &spade,
        "Titles",
        vec![Script::reply("").plain(r#"{"title":"T"}"#); 6],
    )
    .await?;
    spade
        .put("/v1/settings", json!({ "fast_model": "titles/t" }))
        .await?;
    Ok((spade, titles))
}

fn conversation(value: &Value) -> String {
    value["conversation"]
        .as_str()
        .unwrap_or_default()
        .to_owned()
}

fn from_thread(to: Value, key: &str, context: Option<&str>) -> Value {
    let mut body = json!({
        "key": key,
        "to": to,
        "text": "@Research why does login fail?",
        "thread": { "id": "thread-1", "title": "Fix login" },
    });
    if let Some(context) = context {
        body["context"] = json!(context);
    }
    body
}

#[tokio::test]
async fn only_ace_can_ask_for_a_thread_and_a_key_is_delivered_once() -> Result {
    let (spade, _titles) = spade().await?;
    let (research, _fake) = bot(
        &spade,
        "Research",
        vec![Script::reply("The cookie expired.")],
    )
    .await?;
    let body = from_thread(
        json!({ "kind": "bot", "id": research["id"] }),
        "ace.t.1",
        None,
    );
    let (status, _) = spade.post("/v1/thread-asks", body.clone()).await?;
    assert_eq!(
        status, 403,
        "Spade's bearer token alone can't claim a thread"
    );
    let (status, _) = signed(
        &spade,
        reqwest::Method::POST,
        "/v1/thread-asks",
        Some(&body),
        "not-ace",
    )
    .await?;
    assert_eq!(status, 403, "signed with another key");

    let (_, first) = ask(&spade, &body).await?;
    let (_, again) = ask(&spade, &body).await?;
    assert_eq!(first["status"], "accepted");
    assert_eq!(again["status"], "duplicate");
    let read = answer(&spade, "ace.t.1").await?;
    assert_eq!(read["status"], "answered");
    assert_eq!(read["replies"][0]["text"], "The cookie expired.");
    assert_eq!(read["replies"][0]["bot"]["name"], "Research");
    assert!(
        read["replies"][0]["bot"]["avatar"].is_object(),
        "the bot's face comes with it"
    );

    let events = spade.events(&conversation(&research)).await?;
    let messages: Vec<&Value> = events
        .iter()
        .filter(|e| e["type"] == "user_message")
        .collect();
    assert_eq!(messages.len(), 1);
    assert_eq!(
        messages[0]["from_thread"],
        json!({ "id": "thread-1", "title": "Fix login" })
    );
    Ok(())
}

#[tokio::test]
async fn a_thread_s_context_pack_makes_the_turn_untrusted_and_reaches_the_bot_as_context() -> Result
{
    let (spade, _titles) = spade().await?;
    let (research, fake) = bot(&spade, "Research", vec![Script::reply("Seen.")]).await?;
    let pack = "From the ace thread \"Fix login\" (project ace).\nperson: it 500s";
    let body = from_thread(
        json!({ "kind": "bot", "id": research["id"] }),
        "ace.t.2",
        Some(pack),
    );
    ask(&spade, &body).await?;
    assert_eq!(answer(&spade, "ace.t.2").await?["status"], "answered");
    let events = spade.events(&conversation(&research)).await?;
    let message = events
        .iter()
        .find(|e| e["type"] == "user_message")
        .cloned()
        .unwrap_or_default();
    assert_eq!(message["from_thread"]["untrusted"], true);
    let prompt = fake
        .seen()
        .first()
        .map(|seen| seen.body.to_string())
        .unwrap_or_default();
    assert!(
        prompt.contains("person: it 500s"),
        "the pack reaches the bot"
    );
    assert!(
        prompt.contains("in their ace thread"),
        "the bot is told where the words came from"
    );
    Ok(())
}

#[tokio::test]
async fn an_ask_for_a_club_goes_through_the_club_and_its_members_replies_come_back() -> Result {
    let (spade, _titles) = spade().await?;
    let (research, _r) = bot(&spade, "Research", vec![Script::reply("Sources attached.")]).await?;
    let (writer, _w) = bot(&spade, "Writer", vec![Script::reply("Unused.")]).await?;
    let members = json!([{ "agent": research["id"] }, { "agent": writer["id"] }]);
    let (status, club) = spade
        .post(
            "/v1/groups",
            json!({ "name": "Launch", "members": members, "lead": research["id"] }),
        )
        .await?;
    assert_eq!(status, 201, "{club}");
    let club = club["group"].clone();
    let body = from_thread(json!({ "kind": "club", "id": club["id"] }), "ace.t.3", None);
    let (_, first) = ask(&spade, &body).await?;
    assert_eq!(first["status"], "accepted");
    assert_eq!(ask(&spade, &body).await?.1["status"], "duplicate");
    let mut read = answer(&spade, "ace.t.3").await?;
    for _ in 0..5 {
        if read["status"] != "pending" {
            break;
        }
        read = answer(&spade, "ace.t.3").await?;
    }
    assert_eq!(read["status"], "answered", "{read}");
    assert_eq!(read["replies"][0]["bot"]["name"], "Research");
    assert_eq!(read["replies"][0]["text"], "Sources attached.");
    let events = spade.events(&conversation(&club)).await?;
    let posted = events
        .iter()
        .find(|e| e["type"] == "group_message" && e["from"].is_null())
        .cloned()
        .unwrap_or_default();
    assert_eq!(
        posted["thread"]["title"], "Fix login",
        "the club shows where it came from"
    );
    Ok(())
}

#[tokio::test]
async fn an_ask_names_a_real_bot_and_the_thread_it_came_from() -> Result {
    let (spade, _titles) = spade().await?;
    let missing = from_thread(json!({ "kind": "bot", "id": "nobody" }), "ace.t.4", None);
    assert_eq!(ask(&spade, &missing).await?.0, 404);
    let (research, _fake) = bot(&spade, "Research", vec![Script::reply("Hi.")]).await?;
    let mut nameless = from_thread(
        json!({ "kind": "bot", "id": research["id"] }),
        "ace.t.5",
        None,
    );
    nameless["thread"] = json!({});
    assert_eq!(ask(&spade, &nameless).await?.0, 400);
    let bad_key = from_thread(
        json!({ "kind": "bot", "id": research["id"] }),
        "no spaces",
        None,
    );
    assert_eq!(ask(&spade, &bad_key).await?.0, 400);
    assert_eq!(answer(&spade, "ace.never").await?["status"], "unknown");
    Ok(())
}

/// One inbox request as another machine's call arrives here: this machine's daemon stamps the
/// caller's pairing and name, and signs it with its own token.
async fn inbox(spade: &Spade, from: &str, name: &str, body: &Value) -> Result<(u16, Value)> {
    let bytes = serde_json::to_vec(body)?;
    let time = now_ms();
    let proof = inbox_proof(DAEMON_TOKEN, time, from, name, &bytes).unwrap_or_default();
    let answer = reqwest::Client::new()
        .post(format!("{}/v1/inbox", spade.base))
        .bearer_auth(TOKEN)
        .header("x-ace-from-host", from)
        .header("x-ace-from-name", name)
        .header("x-ace-inbox-time", time.to_string())
        .header("x-ace-inbox-proof", proof)
        .header("content-type", "application/json")
        .body(bytes)
        .send()
        .await?;
    let status = answer.status().as_u16();
    Ok((status, answer.json().await.unwrap_or(Value::Null)))
}

#[tokio::test]
async fn a_thread_on_another_machine_asks_through_the_inbox_once_and_only_that_machine_reads_it()
-> Result {
    let (spade, _titles) = spade().await?;
    let (research, _fake) = bot(
        &spade,
        "Research",
        vec![Script::reply("Studio's build is green.")],
    )
    .await?;
    let mut body = from_thread(
        json!({ "kind": "bot", "id": research["id"] }),
        "ace.t.9",
        None,
    );
    body["op"] = json!("thread_ask");
    let (status, first) = inbox(&spade, "pair-studio", "Studio", &body).await?;
    assert_eq!(status, 200, "{first}");
    assert_eq!(first["status"], "accepted");
    let (_, again) = inbox(&spade, "pair-studio", "Studio", &body).await?;
    assert_eq!(
        again["status"], "duplicate",
        "a retry through the fleet delivers nothing twice"
    );

    let read = json!({ "op": "thread_answer", "key": "ace.t.9", "wait_ms": 8000 });
    let (_, answered) = inbox(&spade, "pair-studio", "Studio", &read).await?;
    assert_eq!(answered["status"], "answered");
    assert_eq!(answered["replies"][0]["text"], "Studio's build is green.");
    // Its key is that machine's: this machine's ace and another machine know nothing of it.
    assert_eq!(answer(&spade, "ace.t.9").await?["status"], "unknown");
    let (_, other) = inbox(&spade, "pair-laptop", "Laptop", &read).await?;
    assert_eq!(other["status"], "unknown");

    let events = spade.events(&conversation(&research)).await?;
    let message = events
        .iter()
        .find(|e| e["type"] == "user_message")
        .cloned()
        .unwrap_or_default();
    assert_eq!(
        message["from_thread"],
        json!({ "id": "thread-1", "title": "Fix login", "machine": "Studio" })
    );
    Ok(())
}

/// A simulator on another machine, as ace's `@` picker names it.
fn simulator_on_studio() -> Value {
    json!([{
        "type": "device",
        "id": "ios:6F1C0D52-3C3A-4F5B-9C1E-0D6E2B1F7A10",
        "name": "iPhone 17",
        "kind": "simulator",
        "machine": { "id": "studio", "name": "Studio", "here": false },
        "os": "iOS 26.1",
        "online": true
    }])
}

async fn until_settled(spade: &Spade, key: &str) -> Result<Value> {
    let mut read = answer(spade, key).await?;
    for _ in 0..8 {
        if read["status"] != "pending" {
            break;
        }
        read = answer(spade, key).await?;
    }
    Ok(read)
}

#[tokio::test]
async fn devices_named_with_a_club_reach_each_member_asked_and_leave_the_turn_trusted() -> Result {
    let (spade, _titles) = spade().await?;
    let (research, r) = bot(&spade, "Research", vec![Script::reply("I'd need Studio.")]).await?;
    let (writer, _w) = bot(&spade, "Writer", vec![Script::reply("Unused.")]).await?;
    let members = json!([{ "agent": research["id"] }, { "agent": writer["id"] }]);
    let (_, club) = spade
        .post(
            "/v1/groups",
            json!({ "name": "Launch", "members": members, "lead": research["id"] }),
        )
        .await?;
    let club = club["group"].clone();
    let mut body = from_thread(
        json!({ "kind": "club", "id": club["id"] }),
        "ace.t.10",
        None,
    );
    body["devices"] = simulator_on_studio();
    assert_eq!(ask(&spade, &body).await?.1["status"], "accepted");
    assert_eq!(
        until_settled(&spade, "ace.t.10").await?["status"],
        "answered"
    );
    let prompt = r
        .seen()
        .first()
        .map(|seen| seen.body.to_string())
        .unwrap_or_default();
    assert!(
        prompt.contains("The person named these devices for this work"),
        "the member reads the devices: {prompt}"
    );
    assert!(prompt.contains("iPhone 17"));
    assert!(prompt.contains("on the machine \\\"Studio\\\""));
    let events = spade.events(&conversation(&research)).await?;
    let message = events
        .iter()
        .find(|e| e["type"] == "user_message")
        .cloned()
        .unwrap_or_default();
    assert_ne!(
        message["from_group"]["untrusted"], true,
        "ace's own facts don't make the turn untrusted"
    );
    Ok(())
}

#[tokio::test]
async fn devices_named_with_a_bot_come_first_in_its_turn_before_the_thread_s_pack() -> Result {
    let (spade, _titles) = spade().await?;
    let (research, fake) = bot(&spade, "Research", vec![Script::reply("Seen.")]).await?;
    let mut body = from_thread(
        json!({ "kind": "bot", "id": research["id"] }),
        "ace.t.11",
        Some("person: it 500s"),
    );
    body["devices"] = simulator_on_studio();
    ask(&spade, &body).await?;
    assert_eq!(
        until_settled(&spade, "ace.t.11").await?["status"],
        "answered"
    );
    let prompt = fake
        .seen()
        .first()
        .map(|seen| seen.body.to_string())
        .unwrap_or_default();
    let devices = prompt
        .find("The person named these devices")
        .unwrap_or(usize::MAX);
    let pack = prompt.find("person: it 500s").unwrap_or(0);
    assert!(devices < pack, "devices first, then the pack: {prompt}");
    Ok(())
}
