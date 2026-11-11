//! A real Spade server for tests: engine, API, temporary SQLite and a scripted fake model
//! endpoint, plus fake tools that record what they did.

#![allow(dead_code)]

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use keyring_core::mock;
use serde_json::{Value, json};
use spade_core::tools::{Risk, ToolDef};
use spade_keys::{KeyStore, Keys};
use spade_models::{Catalog, Models, ToolSpec};
use spade_server::api::AppState;
use spade_server::clock::{CountingIds, SystemClock};
use spade_server::engine::{EndpointInput, Engine, Limits, Setup};
use spade_server::tools::{
    AceLink, AceTarget, Retry, SkillLibrary, Tool, ToolFuture, ToolOutput, ToolSource, Toolbox,
};
use spade_store::Store;
use spade_testkit::{FakeProvider, Script};
use tokio::net::TcpListener;
use tokio::sync::oneshot;

pub type Result<T = ()> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

pub const TOKEN: &str = "test-token";

/// A fake tool: fixed definition, records each call's arguments, answers after `delay`.
pub struct FakeTool {
    pub def: ToolDef,
    pub answer: String,
    /// Images it returns with its answer.
    pub images: Vec<Vec<u8>>,
    pub delay: Duration,
    pub calls: Arc<Mutex<Vec<Value>>>,
}

impl FakeTool {
    pub fn new(name: &str, risk: Risk, answer: &str) -> Self {
        Self {
            def: ToolDef {
                spec: ToolSpec {
                    name: name.to_owned(),
                    description: format!("{name} tool"),
                    schema: json!({ "type": "object" }),
                },
                risk,
                untrusted_output: false,
                deferred: false,
                background: false,
            },
            answer: answer.to_owned(),
            images: Vec::new(),
            delay: Duration::ZERO,
            calls: Arc::default(),
        }
    }

    pub fn untrusted(mut self) -> Self {
        self.def.untrusted_output = true;
        self
    }

    pub fn deferred(mut self, description: &str) -> Self {
        self.def.deferred = true;
        self.def.spec.description = description.to_owned();
        self
    }

    pub fn background(mut self) -> Self {
        self.def.background = true;
        self
    }

    pub fn returning_image(mut self, bytes: &[u8]) -> Self {
        self.images.push(bytes.to_vec());
        self
    }

    pub fn slow(mut self, delay: Duration) -> Self {
        self.delay = delay;
        self
    }

    pub fn calls(&self) -> Arc<Mutex<Vec<Value>>> {
        self.calls.clone()
    }
}

impl Tool for FakeTool {
    fn def(&self) -> ToolDef {
        self.def.clone()
    }

    fn run(&self, _call_id: &str, arguments: Value) -> ToolFuture {
        let calls = self.calls.clone();
        let answer = self.answer.clone();
        let images = self.images.clone();
        let delay = self.delay;
        Box::pin(async move {
            if !delay.is_zero() {
                tokio::time::sleep(delay).await;
            }
            if let Ok(mut calls) = calls.lock() {
                calls.push(arguments);
            }
            ToolOutput {
                images,
                ..ToolOutput::ok(answer)
            }
        })
    }
}

pub struct Spade {
    pub base: String,
    pub fake: FakeProvider,
    pub http: reqwest::Client,
    pub dir: Arc<tempfile::TempDir>,
    pub engine: Arc<Engine>,
    /// The (mock) keychain this server keeps keys and the ace grant in.
    pub keys: KeyStore,
    /// The connection to ace, when started with `ace_home`.
    pub ace: Option<Arc<AceLink>>,
    stop: Option<oneshot::Sender<()>>,
    task: tokio::task::JoinHandle<std::io::Result<()>>,
}

pub struct Options {
    pub cap_usd: f64,
    pub limits: Limits,
    pub skills: Option<Arc<dyn SkillLibrary>>,
    /// Finds ace from this folder's files, retrying quickly.
    pub ace_home: Option<PathBuf>,
    /// Waits for the ace connection, when not the quick ones tests use by default.
    pub ace_retry: Option<Retry>,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            cap_usd: 5.0,
            limits: Limits::default(),
            skills: None,
            ace_home: None,
            ace_retry: None,
        }
    }
}

fn catalog(root: &str) -> Result<Catalog> {
    let json = json!({
        "roles": { "main": "fake/m", "fast": "fake/m", "deep": "fake/m" },
        "endpoints": [{ "id": "fake", "name": "Fake", "format": "openai-chat", "base_url": root,
                        "key": { "env": "FAKE_KEY" }, "session_header": "x-session",
                        "models": [{ "id": "m", "name": "M", "capabilities": ["tools", "images"], "price": { "input": 2, "output": 10 } }] }]
    });
    Ok(Catalog::from_json(&json.to_string())?)
}

impl Spade {
    pub async fn start(scripts: Vec<Script>, tools: Vec<Arc<dyn Tool>>) -> Result<Self> {
        Self::start_with(scripts, tools, Options::default()).await
    }

    pub async fn start_with(
        scripts: Vec<Script>,
        tools: Vec<Arc<dyn Tool>>,
        options: Options,
    ) -> Result<Self> {
        let fake = FakeProvider::start_sequence(scripts).await?;
        let dir = Arc::new(tempfile::tempdir()?);
        Self::serve(fake, dir, tools, options).await
    }

    /// Like `start`, with tools that also come from a live `source`.
    pub async fn start_with_source(
        scripts: Vec<Script>,
        tools: Vec<Arc<dyn Tool>>,
        source: Arc<dyn ToolSource>,
    ) -> Result<Self> {
        let fake = FakeProvider::start_sequence(scripts).await?;
        let dir = Arc::new(tempfile::tempdir()?);
        Self::serve_toolbox(
            fake,
            dir,
            Toolbox::new(tools).with_source(source),
            Options::default(),
        )
        .await
    }

    async fn serve(
        fake: FakeProvider,
        dir: Arc<tempfile::TempDir>,
        tools: Vec<Arc<dyn Tool>>,
        options: Options,
    ) -> Result<Self> {
        Self::serve_toolbox(fake, dir, Toolbox::new(tools), options).await
    }

    async fn serve_toolbox(
        fake: FakeProvider,
        dir: Arc<tempfile::TempDir>,
        mut tools: Toolbox,
        options: Options,
    ) -> Result<Self> {
        let keys = KeyStore::with_store(mock::Store::new()?, spade_keys::SERVICE);
        let ace = options.ace_home.clone().map(|home| {
            AceLink::start(
                AceTarget::Discover(home),
                Some(keys.clone()),
                options.ace_retry.unwrap_or(Retry {
                    first: Duration::from_millis(20),
                    longest: Duration::from_millis(100),
                    check: Duration::from_millis(50),
                    answer: Duration::from_millis(300),
                }),
            )
        });
        if let Some(link) = &ace {
            tools = tools.with_source(link.clone() as Arc<dyn ToolSource>);
        }
        let models = Models::new(
            catalog(&fake.root)?,
            Keys::new(|_| Some("fake-key".to_owned())),
            spade_server::home::VERSION,
        )?;
        let engine = Engine::open(Setup {
            store: Store::open(&dir.path().join("spade.sqlite"))?,
            models,
            tools,
            clock: Arc::new(SystemClock),
            ids: Arc::new(CountingIds::default()),
            daily_cap_micros: spade_core::spending::usd_to_micros(options.cap_usd),
            utc_offset_seconds: 0,
            limits: options.limits,
            skills: options.skills,
            images: spade_server::images::ImageStore::open(&dir.path().join("images"))?,
        })?;
        // The endpoint is the person's now, kept in the database: a restarted fake has a new port.
        engine.update_endpoint(
            "fake",
            EndpointInput {
                base_url: Some(fake.root.clone()),
                ..EndpointInput::default()
            },
        )?;
        engine.open_for_work();
        let state = AppState {
            engine: engine.clone(),
            token: TOKEN.into(),
            keys: Some(keys.clone()),
            ace: ace.clone(),
        };
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let base = format!("http://{}", listener.local_addr()?);
        let (stop, stopped) = oneshot::channel::<()>();
        let task = tokio::spawn(spade_server::serve(listener, state, async {
            let _ = stopped.await;
        }));
        Ok(Self {
            base,
            fake,
            http: reqwest::Client::new(),
            dir,
            engine,
            keys,
            ace,
            stop: Some(stop),
            task,
        })
    }

    /// Stops this server and opens a new engine and server on the same database and endpoint.
    pub async fn restart(
        mut self,
        tools: Vec<Arc<dyn Tool>>,
        scripts: Vec<Script>,
    ) -> Result<Self> {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        let _ = (&mut self.task).await;
        let fake = FakeProvider::start_sequence(scripts).await?;
        Self::serve(fake, self.dir.clone(), tools, Options::default()).await
    }

    /// Stops this server as SIGTERM does (open turns pause, a running model step gets
    /// `allowance`), then opens a new engine and server on the same database.
    pub async fn restart_after_stop(
        self,
        allowance: Duration,
        tools: Vec<Arc<dyn Tool>>,
        scripts: Vec<Script>,
    ) -> Result<Self> {
        self.engine.pause_for_stop(allowance).await;
        self.restart(tools, scripts).await
    }

    pub async fn delete(&self, path: &str) -> Result<(u16, Value)> {
        let response = self
            .http
            .delete(format!("{}{path}", self.base))
            .bearer_auth(TOKEN)
            .send()
            .await?;
        let status = response.status().as_u16();
        Ok((status, response.json().await.unwrap_or(Value::Null)))
    }

    pub async fn put(&self, path: &str, body: Value) -> Result<(u16, Value)> {
        let response = self
            .http
            .put(format!("{}{path}", self.base))
            .bearer_auth(TOKEN)
            .json(&body)
            .send()
            .await?;
        let status = response.status().as_u16();
        Ok((status, response.json().await.unwrap_or(Value::Null)))
    }

    /// Shuts the server down the graceful way; fails if it does not finish within `within`.
    pub async fn shut_down(mut self, within: Duration) -> Result {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        tokio::time::timeout(within, &mut self.task)
            .await
            .map_err(|_| "the server did not shut down in time")???;
        Ok(())
    }

    pub fn database(&self) -> PathBuf {
        self.dir.path().join("spade.sqlite")
    }

    pub async fn post(&self, path: &str, body: Value) -> Result<(u16, Value)> {
        let response = self
            .http
            .post(format!("{}{path}", self.base))
            .bearer_auth(TOKEN)
            .json(&body)
            .send()
            .await?;
        let status = response.status().as_u16();
        let text = response.text().await?;
        Ok((status, serde_json::from_str(&text).unwrap_or(Value::Null)))
    }

    pub async fn get(&self, path: &str) -> Result<(u16, Value)> {
        let response = self
            .http
            .get(format!("{}{path}", self.base))
            .bearer_auth(TOKEN)
            .send()
            .await?;
        let status = response.status().as_u16();
        Ok((status, response.json().await.unwrap_or(Value::Null)))
    }

    /// Creates a bot on the fake model and returns it as the API shows it.
    pub async fn new_agent(&self, name: &str, task: &str) -> Result<Value> {
        let (status, body) = self
            .post(
                "/v1/agents",
                json!({ "name": name, "task": task, "model": "fake/m" }),
            )
            .await?;
        assert_eq!(status, 201, "{body}");
        Ok(body["agent"].clone())
    }

    /// Sends `text` to conversation `id`.
    pub async fn say(&self, id: &str, text: &str) -> Result {
        let (status, body) = self
            .post(
                &format!("/v1/conversations/{id}/messages"),
                json!({ "text": text }),
            )
            .await?;
        assert_eq!(status, 202, "{body}");
        Ok(())
    }

    /// Creates a bot, sends it `text`, and returns its conversation's id.
    pub async fn ask(&self, text: &str) -> Result<String> {
        let agent = self.new_agent("Test", "").await?;
        let id = agent["conversation"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        self.say(&id, text).await?;
        Ok(id)
    }

    /// The conversation's stored events, as `event` objects.
    pub async fn events(&self, id: &str) -> Result<Vec<Value>> {
        let (_, body) = self.get(&format!("/v1/conversations/{id}/events")).await?;
        Ok(body
            .as_array()
            .map(|rows| rows.iter().map(|r| r["event"].clone()).collect())
            .unwrap_or_default())
    }

    /// Waits until some event has type `kind`, and returns all events at that point.
    pub async fn wait_for(&self, id: &str, kind: &str) -> Result<Vec<Value>> {
        self.wait_for_count(id, kind, 1).await
    }

    /// Waits until `count` events have type `kind`, and returns all events at that point.
    pub async fn wait_for_count(&self, id: &str, kind: &str, count: usize) -> Result<Vec<Value>> {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let events = self.events(id).await?;
            if events.iter().filter(|e| e["type"] == kind).count() >= count {
                return Ok(events);
            }
            if Instant::now() > deadline {
                return Err(format!("no {kind} event; got {}", types(&events).join(", ")).into());
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}

/// The `type` of each event, in order.
pub fn types(events: &[Value]) -> Vec<String> {
    events
        .iter()
        .map(|e| e["type"].as_str().unwrap_or("?").to_owned())
        .collect()
}
