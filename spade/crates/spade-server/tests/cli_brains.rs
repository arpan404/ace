//! Bots on the person's subscriptions (ADR 0133), through the real engine and API with a fake
//! daemon brain service: it streams a CLI's turn as JSON lines and calls the bot's tools through
//! Spade's MCP server, as ace's `spade_call` does.

mod support;

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::extract::State;
use axum::response::Response;
use axum::routing::{get, post};
use serde_json::{Value, json};
use spade_ace::brains::AceBrains;
use spade_ace::{LoopbackUrl, Secret, ToolsConfig};
use spade_core::tools::Risk;
use spade_server::engine::Engine;
use spade_server::tools::Tool;
use support::{FakeTool, Options, Result, Spade, TOKEN};
use tokio::net::TcpListener;

/// What the fake CLI does in one turn, in order.
#[derive(Clone)]
enum Act {
    Text(&'static str),
    /// Reads the web with its own tools.
    ReadsTheWeb,
    /// Calls one of the bot's tools through Spade and writes back what it returned.
    Call(&'static str, Value),
    Finish,
    Fail(&'static str, &'static str),
    /// Keeps the turn running until Spade lets go.
    Hang,
}

#[derive(Default)]
struct Daemon {
    turns: Mutex<VecDeque<Vec<Act>>>,
    /// Every turn request Spade sent.
    requests: Mutex<Vec<Value>>,
    /// Turns Spade let go of before they ended.
    dropped: Mutex<usize>,
    spade: Mutex<String>,
}

/// Counts a turn Spade let go of, when its answer is dropped unfinished.
struct Watch(Arc<Daemon>, bool);
impl Drop for Watch {
    fn drop(&mut self) {
        if !self.1
            && let Ok(mut dropped) = self.0.dropped.lock()
        {
            *dropped += 1;
        }
    }
}

async fn turn(State(daemon): State<Arc<Daemon>>, body: String) -> Response {
    let request: Value = serde_json::from_str(&body).unwrap_or_default();
    let bot = request["bot"].as_str().unwrap_or_default().to_owned();
    daemon.requests.lock().map(|mut r| r.push(request)).ok();
    let acts = daemon
        .turns
        .lock()
        .ok()
        .and_then(|mut t| t.pop_front())
        .unwrap_or_else(|| vec![Act::Finish]);
    let spade = daemon.spade.lock().map(|s| s.clone()).unwrap_or_default();
    let watch = Watch(daemon.clone(), false);
    let lines = futures_util::stream::unfold(
        (acts.into_iter(), watch, bot, spade),
        |(mut acts, mut watch, bot, spade)| async move {
            let line = match acts.next()? {
                Act::Text(text) => json!({ "type": "text", "text": text }),
                Act::ReadsTheWeb => json!({ "type": "read", "source": "the web" }),
                Act::Call(name, arguments) => {
                    let answer: Value = reqwest::Client::new()
                        .post(format!("{spade}/v1/agents/{bot}/mcp"))
                        .bearer_auth(TOKEN)
                        .json(&json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call",
                                       "params": { "name": name, "arguments": arguments } }))
                        .send()
                        .await
                        .ok()?
                        .json()
                        .await
                        .ok()?;
                    let text = answer["result"]["content"][0]["text"]
                        .as_str()
                        .unwrap_or("?");
                    json!({ "type": "text", "text": format!("[{name}: {text}]") })
                }
                Act::Finish => {
                    watch.1 = true;
                    json!({ "type": "finished", "usage": { "input": 12, "output": 3 } })
                }
                Act::Fail(reason, message) => {
                    watch.1 = true;
                    json!({ "type": "failed", "reason": reason, "message": message })
                }
                Act::Hang => {
                    std::future::pending::<()>().await;
                    return None;
                }
            };
            Some((
                Ok::<_, std::io::Error>(format!("{line}\n")),
                (acts, watch, bot, spade),
            ))
        },
    );
    Response::new(Body::from_stream(lines))
}

async fn subscriptions() -> axum::Json<Value> {
    axum::Json(json!({ "providers": [{
        "provider": "codex", "name": "Codex",
        "accounts": [{ "id": "work", "label": "Work" }],
        "models": [{ "id": "gpt-6.1-sol", "name": "GPT-6.1 Sol" }],
    }] }))
}

async fn fake_daemon() -> Result<(Arc<Daemon>, String)> {
    let daemon = Arc::new(Daemon::default());
    let app = Router::new()
        .route("/spade/brains/turn", post(turn))
        .route("/spade/brains/subscriptions", get(subscriptions))
        .with_state(daemon.clone());
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("http://{}/mcp", listener.local_addr()?);
    tokio::spawn(async move { axum::serve(listener, app).await });
    Ok((daemon, url))
}

fn connect(engine: &Engine, daemon: &Arc<Daemon>, url: &str, spade: &str) -> Result {
    let tools = ToolsConfig::new(
        LoopbackUrl::parse(url)?,
        Secret::new("grant"),
        Duration::from_secs(30),
    )?;
    engine.set_brains(Arc::new(move || Ok(AceBrains::new(&tools))));
    *daemon.spade.lock().map_err(|e| e.to_string())? = spade.to_owned();
    Ok(())
}

async fn start(
    tools: Vec<Arc<dyn Tool>>,
    turns: Vec<Vec<Act>>,
) -> Result<(Spade, Arc<Daemon>, String)> {
    // No money to spend: a subscription never counts toward Spade's cap.
    let options = Options {
        cap_usd: 0.0,
        ..Options::default()
    };
    let spade = Spade::start_with(Vec::new(), tools, options).await?;
    let (daemon, url) = fake_daemon().await?;
    daemon
        .turns
        .lock()
        .map_err(|e| e.to_string())?
        .extend(turns);
    connect(&spade.engine, &daemon, &url, &spade.base)?;
    Ok((spade, daemon, url))
}

/// A bot on Codex through ace; its conversation id.
async fn cli_bot(spade: &Spade, task: &str) -> Result<(String, String)> {
    let (status, body) = spade
        .post(
            "/v1/agents",
            json!({ "name": "Notes", "task": task, "model": "cli:codex@work/gpt-6.1-sol" }),
        )
        .await?;
    assert_eq!(status, 201, "{body}");
    let agent = &body["agent"];
    Ok((
        agent["id"].as_str().unwrap_or_default().to_owned(),
        agent["conversation"]
            .as_str()
            .unwrap_or_default()
            .to_owned(),
    ))
}

fn requests(daemon: &Daemon) -> Vec<Value> {
    daemon
        .requests
        .lock()
        .map(|r| r.clone())
        .unwrap_or_default()
}

fn finished_text(events: &[Value]) -> Vec<String> {
    events
        .iter()
        .filter(|e| e["type"] == "reply_finished")
        .map(|e| e["text"].as_str().unwrap_or_default().to_owned())
        .collect()
}

#[tokio::test]
async fn a_bot_on_a_subscription_answers_through_ace_with_its_task_and_no_spend() -> Result {
    let (spade, daemon, _) = start(
        Vec::new(),
        vec![vec![
            Act::Text("Hello from "),
            Act::Text("Codex."),
            Act::Finish,
        ]],
    )
    .await?;
    let (bot, chat) = cli_bot(&spade, "Keep my notes tidy").await?;
    spade.say(&chat, "Hi").await?;
    let events = spade.wait_for(&chat, "reply_finished").await?;
    assert_eq!(finished_text(&events), ["Hello from Codex."]);
    let sent = requests(&daemon);
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0]["bot"], bot);
    assert_eq!(sent[0]["provider"], "codex");
    assert_eq!(sent[0]["account"], "work");
    assert_eq!(sent[0]["model"], "gpt-6.1-sol");
    assert_eq!(sent[0]["message"], "Hi");
    let instructions = sent[0]["instructions"].as_str().unwrap_or_default();
    assert!(
        instructions.contains("Keep my notes tidy"),
        "{instructions}"
    );
    assert!(instructions.contains("spade_call"), "{instructions}");
    let step = events.iter().find(|e| e["type"] == "step_finished");
    assert_eq!(step.map(|s| s["cost_micros"].clone()), Some(json!(0)));
    // The person's subscriptions, as ace lists them, for the picker.
    let (status, listed) = spade.get("/v1/subscriptions").await?;
    assert_eq!(status, 200);
    assert_eq!(listed["providers"][0]["provider"], "codex");
    assert_eq!(listed["providers"][0]["accounts"][0]["id"], "work");
    Ok(())
}

#[tokio::test]
async fn a_cli_call_to_a_write_waits_for_the_person_and_reading_the_web_makes_notes_ask() -> Result
{
    let email = FakeTool::new("send_email", Risk::Write, "sent");
    let note = FakeTool::new("note_down", Risk::Memory, "noted");
    let (emails, notes) = (email.calls(), note.calls());
    let (spade, _daemon, _) = start(
        vec![Arc::new(email), Arc::new(note)],
        vec![
            vec![
                Act::Call("note_down", json!({ "text": "milk" })),
                Act::Call("send_email", json!({ "to": "sam" })),
                Act::Finish,
            ],
            vec![
                Act::ReadsTheWeb,
                Act::Call("note_down", json!({ "text": "from a page" })),
                Act::Finish,
            ],
        ],
    )
    .await?;
    let (_, chat) = cli_bot(&spade, "").await?;
    spade.say(&chat, "Note milk and email Sam").await?;
    // A note runs at once; the email waits for the person.
    let events = spade.wait_for(&chat, "approval_requested").await?;
    let asked: Vec<&Value> = events
        .iter()
        .filter(|e| e["type"] == "approval_requested")
        .collect();
    assert_eq!(asked.len(), 1);
    assert_eq!(asked[0]["name"], "send_email");
    assert_eq!(notes.lock().map(|n| n.len()).unwrap_or(0), 1);
    assert_eq!(emails.lock().map(|n| n.len()).unwrap_or(0), 0);
    let call = asked[0]["call_id"].as_str().unwrap_or_default().to_owned();
    let (status, _) = spade
        .post(
            &format!("/v1/conversations/{chat}/approvals/{call}"),
            json!({ "allowed": true }),
        )
        .await?;
    assert_eq!(status, 202);
    let events = spade.wait_for(&chat, "reply_finished").await?;
    assert_eq!(emails.lock().map(|n| n.len()).unwrap_or(0), 1);
    // The CLI got each result back and wrote it into the reply.
    assert_eq!(finished_text(&events), ["[send_email: sent]"]);
    let replies = spade.events(&chat).await?;
    let text: String = replies
        .iter()
        .filter(|e| e["type"] == "step_finished")
        .map(|e| e["text"].as_str().unwrap_or_default())
        .collect();
    assert!(text.contains("[note_down: noted]"), "{text}");

    // Once the CLI read the web itself, even a note asks.
    spade.say(&chat, "Note what that page says").await?;
    let events = spade.wait_for_count(&chat, "approval_requested", 2).await?;
    let last = events
        .iter()
        .rev()
        .find(|e| e["type"] == "approval_requested");
    assert_eq!(last.map(|e| e["name"].clone()), Some(json!("note_down")));
    Ok(())
}

#[tokio::test]
async fn stop_lets_go_of_the_cli_turn_and_closes_the_reply_as_stopped() -> Result {
    let (spade, daemon, _) = start(
        Vec::new(),
        vec![vec![Act::Text("Thinking it over"), Act::Hang]],
    )
    .await?;
    let (_, chat) = cli_bot(&spade, "").await?;
    spade.say(&chat, "Think long").await?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while requests(&daemon).is_empty() && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    tokio::time::sleep(Duration::from_millis(100)).await;
    let (status, _) = spade
        .post(&format!("/v1/conversations/{chat}/stop"), json!({}))
        .await?;
    assert_eq!(status, 202);
    spade.wait_for(&chat, "reply_stopped").await?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while *daemon.dropped.lock().map_err(|e| e.to_string())? == 0 {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the CLI's turn was never let go"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    Ok(())
}

#[tokio::test]
async fn after_a_restart_the_bot_carries_on_in_the_same_session_with_only_the_new_message() -> Result
{
    let (spade, daemon, url) =
        start(Vec::new(), vec![vec![Act::Text("First."), Act::Finish]]).await?;
    let (bot, chat) = cli_bot(&spade, "Keep notes").await?;
    spade.say(&chat, "One").await?;
    spade.wait_for(&chat, "reply_finished").await?;
    let spade = spade.restart(Vec::new(), Vec::new()).await?;
    daemon
        .turns
        .lock()
        .map_err(|e| e.to_string())?
        .push_back(vec![Act::Text("Second."), Act::Finish]);
    connect(&spade.engine, &daemon, &url, &spade.base)?;
    spade.say(&chat, "Two").await?;
    spade.wait_for_count(&chat, "reply_finished", 2).await?;
    let sent = requests(&daemon);
    assert_eq!(sent.len(), 2);
    assert_eq!(sent[1]["bot"], bot, "the same bot's session");
    assert_eq!(sent[1]["message"], "Two");
    assert_eq!(sent[1]["instructionsChanged"], false);
    Ok(())
}

#[tokio::test]
async fn a_signed_out_cli_shows_one_line_on_the_bot_and_is_not_tried_again() -> Result {
    let line = "Codex is signed out. Sign in to it in ace, then send again.";
    let (spade, daemon, _) = start(Vec::new(), vec![vec![Act::Fail("signed_out", line)]]).await?;
    let (bot, chat) = cli_bot(&spade, "").await?;
    spade.say(&chat, "Hi").await?;
    let events = spade.wait_for(&chat, "reply_failed").await?;
    let failed = events.iter().find(|e| e["type"] == "reply_failed");
    assert_eq!(failed.map(|e| e["error"].clone()), Some(json!(line)));
    let (_, roster) = spade.get("/v1/agents").await?;
    let row = roster["agents"]
        .as_array()
        .and_then(|a| a.iter().find(|a| a["id"] == bot.as_str()))
        .cloned()
        .unwrap_or_default();
    assert_eq!(row["problem"], line);
    assert_eq!(row["state"], "idle");
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(requests(&daemon).len(), 1, "nothing retried the turn");
    Ok(())
}

#[tokio::test]
async fn ace_being_away_fails_the_turn_with_one_line() -> Result {
    let (spade, _daemon, _) = start(Vec::new(), Vec::new()).await?;
    let (_, chat) = cli_bot(&spade, "").await?;
    // ace's files point nowhere.
    spade.engine.set_brains(Arc::new(
        || Err("Spade has no grant for ace yet".to_owned()),
    ));
    spade.say(&chat, "Hi").await?;
    let events = spade.wait_for(&chat, "reply_failed").await?;
    let failed = events.iter().find(|e| e["type"] == "reply_failed");
    assert_eq!(
        failed.map(|e| e["error"].clone()),
        Some(json!("Spade has no grant for ace yet"))
    );
    Ok(())
}
