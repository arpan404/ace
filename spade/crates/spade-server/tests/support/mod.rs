//! A real Spade server for tests: engine, API, temporary SQLite and a scripted fake model
//! endpoint, plus fake tools that record what they did.

#![allow(dead_code)]

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub mod gated;

use keyring_core::mock;
use serde_json::{Value, json};
use spade_core::tools::{Risk, ToolDef};
use spade_keys::{KeyStore, Keys};
use spade_models::{Catalog, Models, ToolSpec};
use spade_server::api::AppState;
use spade_server::clock::{Clock, CountingIds, Ids, SystemClock};
use spade_server::engine::{Engine, Limits, Setup};
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
    /// The mock store behind `keys`, to make the keychain fail on purpose.
    pub mock: Arc<mock::Store>,
    /// The connection to ace, when started with `ace_home`.
    pub ace: Option<Arc<AceLink>>,
    /// The person's connected apps, when started with `connectors`.
    pub connectors: Option<Arc<spade_connect::Connectors>>,
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
    /// An edited `models.json` from an earlier Spade, to adopt.
    pub adopt: Option<Catalog>,
    /// Every keychain read takes this long, as one blocked on a prompt does.
    pub keychain_delay: Option<Duration>,
    /// Every keychain read waits until this opens, as on a prompt nobody has answered yet.
    pub keychain_gate: Option<Gate>,
    /// How long admission waits for setup.
    pub settle_deadline: Duration,
    /// With `keychain_gate`, only this endpoint's key reads wait.
    pub keychain_gate_for: Option<&'static str>,
    /// Every keychain delete waits until this opens.
    pub keychain_delete_gate: Option<Gate>,
    /// Writes to the database before Spade first opens it.
    pub seed: Option<fn(&Store) -> spade_store::Result<()>>,
    /// Bots' workspaces, for the API (ADR 0130).
    pub workspaces: Option<spade_server::workspace::Workspaces>,
    /// Skill proposals, for the API (ADR 0130).
    pub learning: Option<Arc<spade_server::learning::Learning>>,
    /// Sets up connectors (ADR 0131), with the mock keychain.
    pub connectors: bool,
    /// The engine's clock; the machine's when absent.
    pub clock: Option<Arc<dyn Clock>>,
    /// The engine's ids; counting from 1 when absent.
    pub ids: Option<Arc<dyn Ids>>,
    /// Where bots on subscriptions reach ace (ADR 0133), set before work opens.
    pub brains: Option<spade_server::engine::BrainSource>,
    /// Sending a model step again; quick waits when absent, so a failing endpoint is not slow.
    pub model_retry: Option<spade_server::engine::Retry>,
}

/// A clock a test sets by hand.
#[derive(Default)]
pub struct ManualClock(std::sync::atomic::AtomicI64);

impl ManualClock {
    pub fn at(ms: i64) -> Arc<Self> {
        Arc::new(Self(std::sync::atomic::AtomicI64::new(ms)))
    }

    pub fn set(&self, ms: i64) {
        self.0.store(ms, std::sync::atomic::Ordering::SeqCst);
    }
}

impl Clock for ManualClock {
    fn now_ms(&self) -> i64 {
        self.0.load(std::sync::atomic::Ordering::SeqCst)
    }
}

/// A keychain prompt: reads wait until [`Gate::open`]. A gated delete can also be made to panic
/// once ([`Gate::panic_next`]), as a keychain library bug would.
#[derive(Clone, Default)]
pub struct Gate(
    Arc<(Mutex<bool>, std::sync::Condvar)>,
    Arc<std::sync::atomic::AtomicBool>,
);

impl Gate {
    /// The next gated delete panics instead of waiting.
    pub fn panic_next(&self) {
        self.1.store(true, std::sync::atomic::Ordering::SeqCst);
    }

    pub(crate) fn take_panic(&self) -> bool {
        self.1.swap(false, std::sync::atomic::Ordering::SeqCst)
    }

    pub fn open(&self) {
        let (open, wake) = &*self.0;
        if let Ok(mut open) = open.lock() {
            *open = true;
        }
        wake.notify_all();
    }

    pub(crate) fn wait(&self) {
        let (open, wake) = &*self.0;
        if let Ok(mut guard) = open.lock() {
            while !*guard {
                guard = match wake.wait(guard) {
                    Ok(guard) => guard,
                    Err(_) => return,
                };
            }
        }
    }
}

impl Default for Options {
    fn default() -> Self {
        Self {
            cap_usd: 5.0,
            limits: Limits::default(),
            skills: None,
            ace_home: None,
            ace_retry: None,
            adopt: None,
            keychain_delay: None,
            keychain_gate: None,
            settle_deadline: spade_server::startup::SETTLE_DEADLINE,
            seed: None,
            keychain_delete_gate: None,
            keychain_gate_for: None,
            workspaces: None,
            learning: None,
            connectors: false,
            clock: None,
            ids: None,
            brains: None,
            model_retry: None,
        }
    }
}

fn catalog(root: &str) -> Result<Catalog> {
    let json = json!({
        "roles": { "main": "fake/m", "fast": "fake/m", "deep": "fake/m" },
        "endpoints": [{ "id": "fake", "name": "Fake", "format": "openai-chat", "base_url": root,
                        "key": { "env": "FAKE_KEY" }, "session_header": "x-session",
                        "models": [{ "id": "m", "name": "M", "capabilities": ["tools", "images"], "price": { "input": 2, "output": 10 } }] },
                      // A second preset nobody has a key for: never imported on its own. It shares
                      // the model id `m` at another price.
                      { "id": "spare", "name": "Spare", "format": "openai-chat",
                        "base_url": "https://spare.example/v1/", "key": {},
                        "models": [{ "id": "m", "name": "Spare M", "context": 1000, "capabilities": ["tools"],
                                     "price": { "input": 100, "output": 100 } },
                                   { "id": "s", "name": "S", "context": 1000, "capabilities": ["tools"] }] },
                      // Image and transcription models billed per call (ADR 0134), for the media
                      // tests to point at their own fake.
                      { "id": "media", "name": "Media", "format": "openai-chat",
                        "base_url": "https://media.example/v1/", "key": {},
                        "models": [{ "id": "paint-1", "name": "Paint", "capabilities": ["image-generation"],
                                     "price": { "input": 0, "output": 0, "per_call": 1.5 } },
                                   { "id": "ears-1", "name": "Ears", "capabilities": ["transcription"],
                                     "price": { "input": 0, "output": 0, "per_call": 1.5 } }] }]
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

    /// Like `start_with`, with a whole toolbox (tools and live sources).
    pub async fn start_toolbox(
        scripts: Vec<Script>,
        tools: Toolbox,
        options: Options,
    ) -> Result<Self> {
        let fake = FakeProvider::start_sequence(scripts).await?;
        let dir = Arc::new(tempfile::tempdir()?);
        Self::serve_toolbox(fake, dir, tools, options).await
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
        let mock = mock::Store::new()?;
        let keys = match &options.keychain_delete_gate {
            Some(gate) => KeyStore::with_store(
                Arc::new(gated::GatedStore {
                    inner: mock.clone(),
                    gate: gate.clone(),
                }),
                spade_keys::SERVICE,
            ),
            None => KeyStore::with_store(mock.clone(), spade_keys::SERVICE),
        };
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
        // As in Spade: the (mock) keychain first, then the endpoint's variable, which only the
        // shipped fake endpoint names.
        let keychain = keys.clone();
        let delay = options.keychain_delay;
        let gate = options.keychain_gate.clone();
        let gate_for = options.keychain_gate_for;
        let models = Models::new(
            catalog(&fake.root)?,
            Keys::keychain_then_env(
                move |endpoint| {
                    if let Some(delay) = delay {
                        std::thread::sleep(delay);
                    }
                    if let Some(gate) = &gate
                        && gate_for.is_none_or(|only| only == endpoint)
                    {
                        gate.wait();
                    }
                    keychain.get(endpoint).ok().flatten()
                },
                |var| (var == "FAKE_KEY").then(|| "fake-key".to_owned()),
            ),
            spade_server::home::VERSION,
        )?;
        let store = Store::open(&dir.path().join("spade.sqlite"))?;
        if let Some(seed) = options.seed {
            seed(&store)?;
        }
        // The endpoint is the person's now, kept in the database, and a restarted fake listens
        // on a new port. Moved here as a person cannot (the API refuses a key's host change).
        for mut endpoint in store.endpoints()? {
            if endpoint.id == "fake" {
                endpoint.base_url = fake.root.clone();
                store.update_endpoint(&endpoint)?;
            }
        }
        let connectors = if options.connectors {
            let hub = spade_connect::Connectors::open(spade_connect::Setup {
                store: Store::open(&dir.path().join("spade.sqlite"))?,
                keys: Some(keys.clone()),
                clock: spade_connect::system_clock(),
                random: Arc::new(spade_connect::OsRandom),
                catalogue: spade_connect::catalogue::shipped(),
                timeout: Duration::from_secs(5),
                relist: Duration::from_secs(600),
                addresses: spade_connect::Addresses::system(),
            })?;
            let source = spade_server::tools::ConnectorSource::new(
                hub.clone(),
                Store::open(&dir.path().join("spade.sqlite"))?,
            );
            tools = tools.with_source(Arc::new(source));
            Some(hub)
        } else {
            None
        };
        let engine = Engine::open(Setup {
            store,
            models,
            tools,
            clock: options
                .clock
                .clone()
                .unwrap_or_else(|| Arc::new(SystemClock)),
            ids: options
                .ids
                .clone()
                .unwrap_or_else(|| Arc::new(CountingIds::default())),
            daily_cap_micros: spade_core::spending::usd_to_micros(options.cap_usd),
            utc_offset_seconds: 0,
            limits: Limits {
                retry: options.model_retry.unwrap_or(spade_server::engine::Retry {
                    tries: 3,
                    first_wait: Duration::from_millis(10),
                    longest: Duration::from_secs(1),
                }),
                ..options.limits
            },
            skills: options.skills,
            images: spade_server::images::ImageStore::open(&dir.path().join("images"))?,
            adopt: options.adopt.clone(),
            keychain: Some(keys.clone()),
        })?;
        if let Some(brains) = options.brains.clone() {
            engine.set_brains(brains);
        }
        let state = AppState {
            engine: engine.clone(),
            token: TOKEN.into(),
            keys: Some(keys.clone()),
            ace: ace.clone(),
            workspaces: options.workspaces.clone(),
            learning: options.learning.clone(),
            connectors: connectors.clone(),
        };
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let base = format!("http://{}", listener.local_addr()?);
        if let Some(hub) = &connectors {
            hub.set_listening(listener.local_addr()?);
            hub.start();
        }
        let (stop, stopped) = oneshot::channel::<()>();
        let task = tokio::spawn(spade_server::serve(listener, state, async {
            let _ = stopped.await;
        }));
        // As Spade starts: listening first, then the setup that reads keys. Tests wait for it
        // unless they test a slow keychain.
        let finishing =
            spade_server::startup::finish(engine.clone(), None, None, options.settle_deadline);
        if options.keychain_delay.is_none() && options.keychain_gate.is_none() {
            finishing.await?;
        }
        Ok(Self {
            base,
            fake,
            http: reqwest::Client::new(),
            dir,
            engine,
            keys,
            mock,
            ace,
            connectors,
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

    /// Like `restart`, with `options` for the new server.
    pub async fn restart_with(
        mut self,
        tools: Vec<Arc<dyn Tool>>,
        scripts: Vec<Script>,
        options: Options,
    ) -> Result<Self> {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        let _ = (&mut self.task).await;
        let fake = FakeProvider::start_sequence(scripts).await?;
        Self::serve(fake, self.dir.clone(), tools, options).await
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

    /// Makes the keychain's next read or change of `endpoint`'s key fail, once.
    pub fn fail_keychain_once(&self, endpoint: &str) -> Result {
        use keyring_core::api::CredentialStoreApi;
        let entry = self
            .mock
            .build(spade_keys::SERVICE, &format!("endpoint:{endpoint}"), None)?;
        let cred: &mock::Cred = entry
            .as_any()
            .downcast_ref()
            .ok_or("not a mock credential")?;
        cred.set_error(keyring_core::Error::Invalid(
            "store".to_owned(),
            "locked".to_owned(),
        ));
        Ok(())
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
