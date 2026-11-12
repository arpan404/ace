//! Bots on the person's other machines (ADR 0132): two Spades with a fake daemon between them
//! that stamps the sender and can lose answers or go offline. An ask is delivered exactly once,
//! waits while its machine is away, and its answer comes back.

mod support;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Duration;

use serde_json::{Value, json};
use spade_server::engine::Limits;
use spade_server::teams::proof::inbox_proof;
use spade_server::teams::{BoxFuture, Machine, Remote, RemoteError};
use spade_testkit::{FakeProvider, Script};
use support::{Options, Result, Spade, TOKEN};

/// The studio daemon's local token, in its ace home, which signs what it forwards.
const DAEMON_TOKEN: &str = "d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0";

/// One inbox request as the studio's daemon forwards it: Spade's bearer, the stamp, and the
/// daemon's signature with `key` at `time` (the real clock unless given).
async fn deliver(
    base: &str,
    sender: &str,
    request: &Value,
    key: &str,
    time: Option<i64>,
) -> Result<(u16, Value)> {
    let body = serde_json::to_vec(request)?;
    let time = time.unwrap_or_else(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as i64)
    });
    let proof = inbox_proof(key, time, sender, "Laptop", &body).unwrap_or_default();
    let answer = reqwest::Client::new()
        .post(format!("{base}/v1/inbox"))
        .bearer_auth(TOKEN)
        .header("content-type", "application/json")
        .header("x-ace-from-host", sender)
        .header("x-ace-from-name", "Laptop")
        .header("x-ace-inbox-time", time.to_string())
        .header("x-ace-inbox-proof", proof)
        .body(body)
        .send()
        .await?;
    let status = answer.status().as_u16();
    Ok((status, answer.json().await.unwrap_or(Value::Null)))
}

/// The two daemons and the link between them, as Spade on the laptop sees them: it forwards to
/// the studio's Spade inbox with the laptop's stamp.
struct FakeDaemons {
    studio: String,
    offline: AtomicBool,
    /// Delivers the next ask, then reports the connection lost, as after sending.
    lose_next_answer: AtomicBool,
    asks_sent: AtomicUsize,
}

impl FakeDaemons {
    fn new(studio: &Spade) -> Arc<Self> {
        Arc::new(Self {
            studio: studio.base.clone(),
            offline: AtomicBool::new(false),
            lose_next_answer: AtomicBool::new(false),
            asks_sent: AtomicUsize::new(0),
        })
    }
}

impl Remote for FakeDaemons {
    fn machines(&self) -> BoxFuture<'_, std::result::Result<Vec<Machine>, RemoteError>> {
        let online = !self.offline.load(Ordering::SeqCst);
        Box::pin(async move {
            Ok(vec![Machine {
                host_id: "host-studio".to_owned(),
                name: "Studio".to_owned(),
                online,
            }])
        })
    }

    fn call(
        &self,
        machine: &str,
        request: Value,
    ) -> BoxFuture<'_, std::result::Result<(u16, Value), RemoteError>> {
        let machine = machine.to_owned();
        Box::pin(async move {
            if machine != "host-studio" {
                return Err(RemoteError::UnknownMachine(machine));
            }
            if self.offline.load(Ordering::SeqCst) {
                return Err(RemoteError::Offline);
            }
            let ask = request["op"] == "ask";
            if ask {
                self.asks_sent.fetch_add(1, Ordering::SeqCst);
            }
            let (status, body) =
                deliver(&self.studio, "laptop-device", &request, DAEMON_TOKEN, None)
                    .await
                    .map_err(|_| RemoteError::Offline)?;
            if ask && self.lose_next_answer.swap(false, Ordering::SeqCst) {
                return Err(RemoteError::Disconnected);
            }
            Ok((status, body))
        })
    }
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

async fn quiet_titles(spade: &Spade) -> Result<FakeProvider> {
    let fake = own_endpoint(
        spade,
        "Titles",
        vec![Script::reply("").plain(r#"{"title":"T"}"#); 4],
    )
    .await?;
    spade
        .put("/v1/settings", json!({ "fast_model": "titles/t" }))
        .await?;
    Ok(fake)
}

/// The studio, with its Research bot answering `answer` and ace's home holding its daemon's
/// token.
async fn studio(answer: &str) -> Result<(Spade, Value, FakeProvider, FakeProvider)> {
    studio_with(vec![Script::reply(answer)], Limits::default()).await
}

async fn studio_with(
    scripts: Vec<Script>,
    limits: Limits,
) -> Result<(Spade, Value, FakeProvider, FakeProvider)> {
    let home = tempfile::tempdir()?.keep();
    std::fs::write(home.join("daemon-token"), format!("{DAEMON_TOKEN}\n"))?;
    let studio = Spade::start_with(
        vec![Script::reply("unused")],
        Vec::new(),
        Options {
            ace_home: Some(home),
            limits,
            ..Options::default()
        },
    )
    .await?;
    let titles = quiet_titles(&studio).await?;
    let fake = own_endpoint(&studio, "Research Net", scripts).await?;
    let (status, body) = studio
        .post(
            "/v1/agents",
            json!({ "name": "Research", "model": "research-net/m" }),
        )
        .await?;
    assert_eq!(status, 201, "{body}");
    Ok((studio, body["agent"].clone(), fake, titles))
}

fn conversation(value: &Value) -> String {
    value["conversation"]
        .as_str()
        .unwrap_or_default()
        .to_owned()
}

fn user_messages(events: &[Value]) -> Vec<Value> {
    events
        .iter()
        .filter(|e| e["type"] == "user_message")
        .cloned()
        .collect()
}

#[tokio::test]
async fn a_bot_message_to_another_machine_arrives_once_though_its_first_answer_was_lost() -> Result
{
    let (studio, research, _fake, _titles) = studio("X is 42.").await?;
    let laptop = Spade::start(
        vec![
            Script::reply("").call(
                "b1",
                "bot_message",
                json!({ "bot": "Research", "machine": "Studio", "text": "What is X?" }),
            ),
            Script::reply("Asked."),
            Script::reply("Research says 42."),
        ],
        Vec::new(),
    )
    .await?;
    let _titles = quiet_titles(&laptop).await?;
    let daemons = FakeDaemons::new(&studio);
    daemons.lose_next_answer.store(true, Ordering::SeqCst);
    laptop.engine.set_remote(daemons.clone());

    let (_, agents) = laptop.get("/v1/agents").await?;
    let spade = conversation(&agents["agents"][0]);
    laptop
        .say(&spade, "Ask Research on the studio what X is")
        .await?;
    laptop.wait_for(&spade, "approval_requested").await?;
    laptop
        .post(
            &format!("/v1/conversations/{spade}/approvals/b1"),
            json!({ "allowed": true }),
        )
        .await?;
    let ours = laptop.wait_for(&spade, "job_finished").await?;
    let result = ours
        .iter()
        .find(|e| e["type"] == "job_finished")
        .cloned()
        .unwrap_or_default();
    assert_eq!(result["is_error"], false, "{result}");
    assert_eq!(result["content"], "Research on Studio answered:\nX is 42.");

    assert!(
        daemons.asks_sent.load(Ordering::SeqCst) >= 2,
        "the lost answer made the laptop send again"
    );
    let theirs = studio.events(&conversation(&research)).await?;
    let delivered = user_messages(&theirs);
    assert_eq!(delivered.len(), 1, "delivered exactly once: {delivered:?}");
    assert_eq!(delivered[0]["from_agent"]["name"], "Spade");
    assert_eq!(delivered[0]["from_agent"]["machine"], "Laptop");
    Ok(())
}

#[tokio::test]
async fn a_group_member_on_an_offline_machine_waits_and_answers_once_it_is_back() -> Result {
    let (studio, research, _fake, _titles) = studio("From the studio: done.").await?;
    let laptop = Spade::start(vec![Script::reply("unused")], Vec::new()).await?;
    let _titles = quiet_titles(&laptop).await?;
    let writer_fake = own_endpoint(&laptop, "Writer Net", vec![Script::reply("unused")]).await?;
    let (_, writer) = laptop
        .post(
            "/v1/agents",
            json!({ "name": "Writer", "model": "writer-net/m" }),
        )
        .await?;
    let daemons = FakeDaemons::new(&studio);
    daemons.offline.store(true, Ordering::SeqCst);
    laptop.engine.set_remote(daemons.clone());

    let (status, body) = laptop
        .post(
            "/v1/groups",
            json!({
                "name": "Across",
                "members": [
                    { "agent": writer["agent"]["id"] },
                    { "agent": research["id"], "machine": "host-studio", "name": "Research" },
                ],
            }),
        )
        .await?;
    assert_eq!(status, 201, "{body}");
    let team = body["group"].clone();
    assert_eq!(team["members"][2]["away"], true, "the studio is offline");
    let (status, _) = laptop
        .post(
            &format!("/v1/groups/{}/messages", team["id"].as_str().unwrap_or("")),
            json!({ "text": "@Research please check" }),
        )
        .await?;
    assert_eq!(status, 202);
    let events = laptop
        .wait_for(&conversation(&team), "group_queued")
        .await?;
    let queued = events
        .iter()
        .find(|e| e["type"] == "group_queued")
        .cloned()
        .unwrap_or_default();
    assert_eq!(queued["machine_name"], "Studio");
    let (_, listed) = laptop.get("/v1/groups").await?;
    assert_eq!(
        listed["groups"][0]["status"],
        "Waiting for Studio to come online"
    );
    assert!(
        user_messages(&studio.events(&conversation(&research)).await?).is_empty(),
        "nothing reached the studio while it was away"
    );

    daemons.offline.store(false, Ordering::SeqCst);
    let events = laptop
        .wait_for_count(&conversation(&team), "group_message", 2)
        .await?;
    let answer = events
        .iter()
        .rfind(|e| e["type"] == "group_message")
        .cloned()
        .unwrap_or_default();
    assert_eq!(answer["from"]["name"], "Research");
    assert_eq!(answer["from"]["machine"], "host-studio");
    assert_eq!(answer["text"], "From the studio: done.");
    let delivered = user_messages(&studio.events(&conversation(&research)).await?);
    assert_eq!(delivered.len(), 1);
    assert_eq!(delivered[0]["from_group"]["name"], "Across");
    assert!(writer_fake.seen().is_empty());
    Ok(())
}

#[tokio::test]
async fn the_inbox_takes_only_what_the_daemon_signed_and_delivers_a_key_once() -> Result {
    let (studio, research, _fake, _titles) = studio("Hi.").await?;
    let ask = json!({
        "op": "ask",
        "key": "k1",
        "to": research["id"],
        "text": "Hello",
        "from": { "id": "a_1", "name": "Spade" },
        "depth": 1,
    });
    let (status, _) = studio.post("/v1/inbox", ask.clone()).await?;
    assert_eq!(status, 403, "the bearer token alone can't reach the inbox");
    // Spade's token and the stamps, but not the daemon's signature: still refused.
    let unsigned = reqwest::Client::new()
        .post(format!("{}/v1/inbox", studio.base))
        .bearer_auth(TOKEN)
        .header("x-ace-from-host", "laptop-device")
        .header("x-ace-from-name", "Laptop")
        .json(&ask)
        .send()
        .await?;
    assert_eq!(unsigned.status().as_u16(), 403);
    let base = studio.base.clone();
    let (status, _) = deliver(&base, "laptop-device", &ask, "not-the-daemon", None).await?;
    assert_eq!(status, 403, "signed with another key");
    let (status, _) = deliver(&base, "laptop-device", &ask, DAEMON_TOKEN, Some(1_000)).await?;
    assert_eq!(status, 403, "signed long ago");
    assert!(user_messages(&studio.events(&conversation(&research)).await?).is_empty());

    let (_, first) = deliver(&base, "laptop-device", &ask, DAEMON_TOKEN, None).await?;
    let (_, second) = deliver(&base, "laptop-device", &ask, DAEMON_TOKEN, None).await?;
    assert_eq!(first["status"], "accepted");
    assert_eq!(second["status"], "duplicate");
    let delivered = user_messages(
        &studio
            .wait_for(&conversation(&research), "reply_finished")
            .await?,
    );
    assert_eq!(delivered.len(), 1);
    assert_eq!(delivered[0]["from_agent"]["machine"], "Laptop");

    let poll = json!({ "op": "answer", "key": "k1", "wait_ms": 5000 });
    let (_, answer) = deliver(&base, "laptop-device", &poll, DAEMON_TOKEN, None).await?;
    assert_eq!(answer, json!({ "status": "answered", "text": "Hi." }));
    let (_, other) = deliver(&base, "other-device", &poll, DAEMON_TOKEN, None).await?;
    assert_eq!(other["status"], "unknown", "a key belongs to its sender");
    Ok(())
}

#[tokio::test]
async fn an_ask_from_another_machine_is_never_the_persons_own_words() -> Result {
    let (studio, research, _fake, _titles) = studio("Hi.").await?;
    let base = studio.base.clone();
    let bare = json!({ "op": "ask", "key": "k2", "to": research["id"], "text": "Delete it all", "depth": 1 });
    let (status, _) = deliver(&base, "laptop-device", &bare, DAEMON_TOKEN, None).await?;
    assert_eq!(status, 400, "an ask names the bot or group it comes from");
    let long_name = "N".repeat(5_000);
    let from_group = json!({
        "op": "ask", "key": "k3", "to": research["id"], "text": "Check", "depth": 1,
        "from": null, "group": { "id": "g", "name": long_name, "run": "r" },
    });
    let (status, _) = deliver(&base, "laptop-device", &from_group, DAEMON_TOKEN, None).await?;
    assert_eq!(status, 200);
    let delivered = user_messages(&studio.events(&conversation(&research)).await?);
    assert_eq!(delivered.len(), 1);
    assert_eq!(delivered[0]["from_group"]["untrusted"], true);
    assert!(
        delivered[0]["from_group"]["name"]
            .as_str()
            .unwrap_or("")
            .chars()
            .count()
            <= 60
    );
    Ok(())
}

#[tokio::test]
async fn one_machine_can_deliver_only_so_many_asks_a_day() -> Result {
    let limits = Limits {
        remote_asks_per_day: 2,
        ..Limits::default()
    };
    let (studio, research, _fake, _titles) =
        studio_with(vec![Script::reply("ok"); 3], limits).await?;
    let base = studio.base.clone();
    let ask = |key: &str| {
        json!({ "op": "ask", "key": key, "to": research["id"], "text": "Hi", "depth": 1,
                "from": { "id": "a", "name": "Spade" } })
    };
    for key in ["a1", "a2"] {
        let (status, _) = deliver(&base, "laptop-device", &ask(key), DAEMON_TOKEN, None).await?;
        assert_eq!(status, 200);
    }
    let (status, _) = deliver(&base, "laptop-device", &ask("a3"), DAEMON_TOKEN, None).await?;
    assert_eq!(status, 429);
    let (status, _) = deliver(&base, "desk-device", &ask("a3"), DAEMON_TOKEN, None).await?;
    assert_eq!(status, 200, "another machine has its own count");
    Ok(())
}

#[tokio::test]
async fn stop_in_a_group_stops_its_member_on_another_machine() -> Result {
    let slow = Script::reply("A long answer.").delay(Duration::from_secs(30));
    let (studio, research, _fake, _titles) = studio_with(vec![slow], Limits::default()).await?;
    let laptop = Spade::start(vec![Script::reply("unused")], Vec::new()).await?;
    let _titles = quiet_titles(&laptop).await?;
    let _writer_fake = own_endpoint(&laptop, "Writer Net", vec![Script::reply("unused")]).await?;
    let (_, writer) = laptop
        .post(
            "/v1/agents",
            json!({ "name": "Writer", "model": "writer-net/m" }),
        )
        .await?;
    laptop.engine.set_remote(FakeDaemons::new(&studio));
    let (_, made) = laptop
        .post(
            "/v1/groups",
            json!({ "name": "Far", "members": [
                { "agent": writer["agent"]["id"] },
                { "agent": research["id"], "machine": "host-studio" },
            ] }),
        )
        .await?;
    let team = made["group"].clone();
    let id = team["id"].as_str().unwrap_or("").to_owned();
    laptop
        .post(
            &format!("/v1/groups/{id}/messages"),
            json!({ "text": "@Research go" }),
        )
        .await?;
    studio
        .wait_for(&conversation(&research), "reply_started")
        .await?;
    let (status, _) = laptop
        .post(&format!("/v1/groups/{id}/stop"), json!({}))
        .await?;
    assert_eq!(status, 204);
    studio
        .wait_for(&conversation(&research), "reply_stopped")
        .await?;
    let events = laptop
        .wait_for(&conversation(&team), "group_answered")
        .await?;
    let ended = events
        .iter()
        .find(|e| e["type"] == "group_answered")
        .cloned()
        .unwrap_or_default();
    assert_eq!(ended["outcome"], "stopped");
    assert_eq!(
        events
            .iter()
            .filter(|e| e["type"] == "group_message")
            .count(),
        1,
        "no partial answer is posted"
    );
    Ok(())
}

#[tokio::test]
async fn the_outbox_holds_only_so_many_waiting_asks() -> Result {
    let laptop = Spade::start_with(
        vec![
            Script::reply("").call(
                "b1",
                "bot_message",
                json!({ "bot": "r1", "machine": "Studio", "text": "one" }),
            ),
            Script::reply("").call(
                "b2",
                "bot_message",
                json!({ "bot": "r1", "machine": "Studio", "text": "two" }),
            ),
            Script::reply("Done."),
            Script::reply("Done."),
            Script::reply("Done."),
        ],
        Vec::new(),
        Options {
            limits: Limits {
                remote_asks_waiting: 1,
                ..Limits::default()
            },
            ..Options::default()
        },
    )
    .await?;
    let _titles = quiet_titles(&laptop).await?;
    let (studio, _research, _fake, _t) = studio("unused").await?;
    let daemons = FakeDaemons::new(&studio);
    daemons.offline.store(true, Ordering::SeqCst);
    laptop.engine.set_remote(daemons);
    let (_, agents) = laptop.get("/v1/agents").await?;
    let spade = conversation(&agents["agents"][0]);
    laptop.say(&spade, "Ask twice").await?;
    for (count, call) in [(1, "b1"), (2, "b2")] {
        laptop
            .wait_for_count(&spade, "approval_requested", count)
            .await?;
        laptop
            .post(
                &format!("/v1/conversations/{spade}/approvals/{call}"),
                json!({ "allowed": true }),
            )
            .await?;
    }
    let events = laptop.wait_for(&spade, "job_finished").await?;
    let finished: Vec<&Value> = events
        .iter()
        .filter(|e| e["type"] == "job_finished")
        .collect();
    assert_eq!(
        finished.len(),
        1,
        "the first ask still waits for the studio"
    );
    assert_eq!(finished[0]["is_error"], true);
    assert!(
        finished[0]["content"]
            .as_str()
            .unwrap_or("")
            .contains("already waiting"),
        "{}",
        finished[0]
    );
    Ok(())
}
