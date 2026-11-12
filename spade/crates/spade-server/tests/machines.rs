//! Bots on the person's other machines (ADR 0132): two Spades with a fake daemon between them
//! that stamps the sender and can lose answers or go offline. An ask is delivered exactly once,
//! waits while its machine is away, and its answer comes back.

mod support;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use serde_json::{Value, json};
use spade_server::teams::{BoxFuture, Machine, Remote, RemoteError};
use spade_testkit::{FakeProvider, Script};
use support::{Result, Spade, TOKEN};

/// The two daemons and the link between them, as Spade on the laptop sees them: it forwards to
/// the studio's Spade inbox with the laptop's stamp.
struct FakeDaemons {
    http: reqwest::Client,
    studio: String,
    offline: AtomicBool,
    /// Delivers the next ask, then reports the connection lost, as after sending.
    lose_next_answer: AtomicBool,
    asks_sent: AtomicUsize,
}

impl FakeDaemons {
    fn new(studio: &Spade) -> Arc<Self> {
        Arc::new(Self {
            http: reqwest::Client::new(),
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
            let answer = self
                .http
                .post(format!("{}/v1/inbox", self.studio))
                .bearer_auth(TOKEN)
                .header("x-ace-from-host", "host-laptop")
                .header("x-ace-from-name", "Laptop")
                .json(&request)
                .send()
                .await
                .map_err(|_| RemoteError::Offline)?;
            let status = answer.status().as_u16();
            let body: Value = answer.json().await.unwrap_or(Value::Null);
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

/// The studio, with its Research bot answering `answer`.
async fn studio(answer: &str) -> Result<(Spade, Value, FakeProvider, FakeProvider)> {
    let studio = Spade::start(vec![Script::reply("unused")], Vec::new()).await?;
    let titles = quiet_titles(&studio).await?;
    let fake = own_endpoint(&studio, "Research Net", vec![Script::reply(answer)]).await?;
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
async fn the_inbox_takes_only_stamped_requests_and_delivers_a_key_once() -> Result {
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
    assert_eq!(status, 403, "the app can't pose as another machine");

    let send = || {
        reqwest::Client::new()
            .post(format!("{}/v1/inbox", studio.base))
            .bearer_auth(TOKEN)
            .header("x-ace-from-host", "host-laptop")
            .header("x-ace-from-name", "Laptop")
            .json(&ask)
            .send()
    };
    let first: Value = send().await?.json().await?;
    let second: Value = send().await?.json().await?;
    assert_eq!(first["status"], "accepted");
    assert_eq!(second["status"], "duplicate");
    let delivered = user_messages(
        &studio
            .wait_for(&conversation(&research), "reply_finished")
            .await?,
    );
    assert_eq!(delivered.len(), 1);

    let answer: Value = reqwest::Client::new()
        .post(format!("{}/v1/inbox", studio.base))
        .bearer_auth(TOKEN)
        .header("x-ace-from-host", "host-laptop")
        .header("x-ace-from-name", "Laptop")
        .json(&json!({ "op": "answer", "key": "k1", "wait_ms": 5000 }))
        .send()
        .await?
        .json()
        .await?;
    assert_eq!(answer, json!({ "status": "answered", "text": "Hi." }));
    let other_machine: Value = reqwest::Client::new()
        .post(format!("{}/v1/inbox", studio.base))
        .bearer_auth(TOKEN)
        .header("x-ace-from-host", "host-other")
        .header("x-ace-from-name", "Other")
        .json(&json!({ "op": "answer", "key": "k1", "wait_ms": 0 }))
        .send()
        .await?
        .json()
        .await?;
    assert_eq!(
        other_machine["status"], "unknown",
        "a key belongs to its sender"
    );
    Ok(())
}
