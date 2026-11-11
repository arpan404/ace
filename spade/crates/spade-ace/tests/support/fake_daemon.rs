//! A stand-in for the daemon's loopback WebSocket that speaks just enough of the protocol: `hello`
//! with the local token, `starting` then `welcome`, and `skills.request` `list` and `read`. A
//! wrong token gets an `unauthorized` error and close 4001, as the daemon does. Reads answer
//! late so concurrent requests come back out of order; `skl_…silent` reads never answer.

use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::sync::{broadcast, mpsc};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;

pub const LOCAL_TOKEN: &str = "local-token-for-tests";
pub const REVIEW: &str = "skl_1111111111111111111111111111111111111111";
pub const DEPLOY: &str = "skl_2222222222222222222222222222222222222222";
pub const SILENT: &str = "skl_9999999999999999999999999999999999999999";
/// Read answers with a result kind Spade doesn't know.
pub const FUTURE: &str = "skl_7777777777777777777777777777777777777777";
/// A list for this workspace is stale and holds an entry Spade can't read.
pub const STALE_WORKSPACE: &str = "ws_stale";

pub struct FakeDaemon {
    addr: SocketAddr,
    hellos: Arc<Mutex<Vec<Value>>>,
    connections: Arc<AtomicUsize>,
    drop_all: broadcast::Sender<()>,
    saw_close: Arc<AtomicBool>,
}

impl FakeDaemon {
    pub async fn start() -> Self {
        Self::start_as(false).await
    }

    /// Authenticates, then never reads again; it keeps writing small frames and notes when the
    /// client's side of the socket is gone.
    pub async fn start_deaf() -> Self {
        Self::start_as(true).await
    }

    async fn start_as(deaf: bool) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .unwrap_or_else(|e| panic!("bind: {e}"));
        let addr = listener
            .local_addr()
            .unwrap_or_else(|e| panic!("addr: {e}"));
        let hellos = Arc::new(Mutex::new(Vec::new()));
        let connections = Arc::new(AtomicUsize::new(0));
        let (drop_all, _) = broadcast::channel(4);
        let saw_close = Arc::new(AtomicBool::new(false));
        let accept = (hellos.clone(), connections.clone(), drop_all.clone());
        let closes = saw_close.clone();
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let Ok(socket) = tokio_tungstenite::accept_async(stream).await else {
                    continue;
                };
                accept.1.fetch_add(1, Ordering::SeqCst);
                if deaf {
                    tokio::spawn(serve_deaf(socket, closes.clone()));
                } else {
                    tokio::spawn(serve(socket, accept.0.clone(), accept.2.subscribe()));
                }
            }
        });
        Self {
            addr,
            hellos,
            connections,
            drop_all,
            saw_close,
        }
    }

    /// A deaf daemon found the client's side of its socket closed.
    pub fn saw_close(&self) -> bool {
        self.saw_close.load(Ordering::SeqCst)
    }

    pub fn url(&self) -> String {
        format!("ws://{}/", self.addr)
    }

    pub fn hellos(&self) -> Vec<Value> {
        lock(&self.hellos).clone()
    }

    pub fn connections(&self) -> usize {
        self.connections.load(Ordering::SeqCst)
    }

    /// Closes every open socket, as a daemon restart does.
    pub fn drop_connections(&self) {
        let _ = self.drop_all.send(());
    }
}

async fn serve(
    socket: tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
    hellos: Arc<Mutex<Vec<Value>>>,
    mut drop_all: broadcast::Receiver<()>,
) {
    let (mut sink, mut stream) = socket.split();
    let (out, mut outgoing) = mpsc::unbounded_channel::<Message>();
    let writer = tokio::spawn(async move {
        while let Some(message) = outgoing.recv().await {
            let closing = matches!(message, Message::Close(_));
            if sink.send(message).await.is_err() || closing {
                break;
            }
        }
    });
    let mut authenticated = false;
    loop {
        let frame = tokio::select! {
            frame = stream.next() => frame,
            _ = drop_all.recv() => break,
        };
        let Some(Ok(Message::Text(text))) = frame else {
            break;
        };
        let Ok(message) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        if !authenticated {
            lock(&hellos).push(message.clone());
            if message["type"] == "hello" && message["token"] == LOCAL_TOKEN {
                authenticated = true;
                send(&out, json!({ "type": "starting" }));
                send(
                    &out,
                    json!({ "type": "welcome", "hostId": "host_test", "protocolVersion": 1, "headSeq": 0 }),
                );
            } else {
                send(
                    &out,
                    json!({ "type": "error", "code": "unauthorized", "message": "Valid hello required" }),
                );
                let _ = out.send(Message::Close(Some(CloseFrame {
                    code: CloseCode::from(4001),
                    reason: "unauthorized".into(),
                })));
                break;
            }
            continue;
        }
        if message["type"] != "skills.request" {
            continue;
        }
        let request_id = message["requestId"].clone();
        let operation = &message["operation"];
        // Frames Spade doesn't know arrive between answers and must be skipped.
        send(&out, json!({ "type": "pong" }));
        match operation["op"].as_str() {
            Some("list") => {
                let stale = operation["workspaceId"] == STALE_WORKSPACE;
                let mut entries = vec![entry(REVIEW), entry(DEPLOY)];
                if stale {
                    entries.push(json!({ "id": "skl_broken", "scope": "personal" }));
                }
                send(
                    &out,
                    json!({
                        "type": "skills.result",
                        "requestId": request_id,
                        "result": { "kind": "list", "entries": entries, "stale": stale }
                    }),
                );
            }
            Some("read") => {
                let id = operation["id"].as_str().unwrap_or_default().to_owned();
                if id == SILENT {
                    continue;
                }
                let out = out.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    let result = if id == FUTURE {
                        json!({ "kind": "hologram", "beam": 3 })
                    } else if id == REVIEW || id == DEPLOY {
                        json!({ "kind": "skill", "entry": entry(&id), "text": text_of(&id), "kept": [] })
                    } else {
                        json!({ "kind": "error", "code": "not_found", "message": "No skill with that id." })
                    };
                    send(
                        &out,
                        json!({ "type": "skills.result", "requestId": request_id, "result": result }),
                    );
                });
            }
            _ => send(
                &out,
                json!({ "type": "error", "code": "invalid_message", "message": "Message does not match the protocol", "requestId": request_id }),
            ),
        }
    }
    drop(out);
    let _ = writer.await;
}

async fn serve_deaf(
    mut socket: tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
    saw_close: Arc<AtomicBool>,
) {
    let hello = socket.next().await;
    let Some(Ok(Message::Text(text))) = hello else {
        return;
    };
    let ok = serde_json::from_str::<Value>(&text)
        .map(|hello| hello["token"] == LOCAL_TOKEN)
        .unwrap_or(false);
    if !ok {
        return;
    }
    let welcome =
        json!({ "type": "welcome", "hostId": "host_test", "protocolVersion": 1, "headSeq": 0 });
    if socket
        .send(Message::text(welcome.to_string()))
        .await
        .is_err()
    {
        return;
    }
    // Never reads again. A write fails once the client has let the socket go.
    for _ in 0..400 {
        tokio::time::sleep(Duration::from_millis(25)).await;
        let sent = tokio::time::timeout(
            Duration::from_millis(500),
            socket.send(Message::text(json!({ "type": "pong" }).to_string())),
        )
        .await;
        if !matches!(sent, Ok(Ok(()))) {
            saw_close.store(true, Ordering::SeqCst);
            return;
        }
    }
}

pub fn text_of(id: &str) -> String {
    format!("---\nname: {id}\n---\nDo the thing carefully.\n")
}

fn entry(id: &str) -> Value {
    let (name, scope, manual) = if id == REVIEW {
        ("review-code", "personal", false)
    } else {
        ("deploy", "project", true)
    };
    let mut entry = json!({
        "id": id,
        "name": name,
        "description": format!("{name} skill"),
        "scope": scope,
        "path": format!("~/.agents/skills/{name}"),
        "agents": [{ "provider": "claude", "via": "link", "path": "~/.claude/skills/x", "removable": true, "honoursManual": true }],
        "manual": manual,
        "editable": true,
        "hash": "a".repeat(64),
        "addedLater": { "anything": true }
    });
    if id == REVIEW {
        entry["title"] = json!("Review code");
        entry["argumentHint"] = json!("[branch]");
    }
    entry
}

fn send(out: &mpsc::UnboundedSender<Message>, value: Value) {
    let _ = out.send(Message::text(value.to_string()));
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}
