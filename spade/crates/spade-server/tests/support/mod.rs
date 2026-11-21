//! A real Spade server for tests: engine, API, temporary SQLite and a scripted fake model
//! endpoint, plus fake tools that record what they did.

#![allow(dead_code)]

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub mod code;
pub mod contracts;
pub mod fleet;
pub mod gated;
pub mod market;
#[cfg(any(target_os = "macos", all(target_os = "linux", feature = "landlock")))]
pub mod org;
pub mod outside;
pub mod packaged;
pub mod plugins;
pub mod sandbox;

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
    /// Poses as a tool of one of the person's apps (ADR 0131); `true` when it annotates
    /// itself.
    pub app: Option<bool>,
    /// What it declares it does (ADR 0171), over what its name or annotations would say.
    pub declared: Option<spade_core::effect::Effect>,
    /// A fake `shell` whose command starts outside the bot's folder, or in one Spade can't
    /// resolve: the classifier can't place its paths.
    pub unplaced: bool,
    /// A fake `shell` on a machine with no read-only sandbox: the classifier settles nothing.
    pub no_sandbox: bool,
    /// Answers given in turn before `answer`, the last of them again and again.
    pub answers: Arc<Mutex<Vec<String>>>,
    /// Scopes an Always allow to the call's `command`, as Spade's shell does.
    pub scoped: bool,
    /// Run with how many times it has been classified, before each classification answers (on
    /// the blocking pool): a test can hold one reading open while it changes something.
    pub classifying: Option<Arc<dyn Fn(usize) + Send + Sync>>,
    pub classified: Arc<std::sync::atomic::AtomicUsize>,
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
            app: None,
            declared: None,
            unplaced: false,
            no_sandbox: false,
            answers: Arc::default(),
            scoped: false,
            classifying: None,
            classified: Arc::default(),
        }
    }

    /// Scopes an Always allow to the call's `command`, as Spade's shell does.
    /// Calls `hook` with the count before each classification answers.
    pub fn while_classifying(mut self, hook: Arc<dyn Fn(usize) + Send + Sync>) -> Self {
        self.classifying = Some(hook);
        self
    }

    pub fn scoped(mut self) -> Self {
        self.scoped = true;
        self
    }

    /// A fake `shell` on a machine with no read-only sandbox.
    pub fn no_sandbox(mut self) -> Self {
        self.no_sandbox = true;
        self
    }

    /// A fake `shell` whose command starts where Spade can't place it against the bot's folder.
    pub fn unplaced(mut self) -> Self {
        self.unplaced = true;
        self
    }

    /// Takes arguments shaped by `schema`, as its server says.
    pub fn schema(mut self, schema: Value) -> Self {
        self.def.spec.schema = schema;
        self
    }

    /// Answers `answers` in turn, then the last of them on every later call.
    pub fn then_answers(mut self, answers: &[&str]) -> Self {
        // Kept last first, so each call pops the next and the last stays.
        let queued: Vec<String> = answers.iter().rev().map(|a| (*a).to_owned()).collect();
        self.answers = Arc::new(Mutex::new(queued));
        self
    }

    /// Declares what it does, as a catalogue entry or manifest would.
    pub fn declares(mut self, effect: spade_core::effect::Effect) -> Self {
        self.declared = Some(effect);
        self
    }

    /// Poses as a tool of one of the person's apps, as a connector offers it (ADR 0131).
    pub fn app(mut self, description: &str) -> Self {
        self.app = Some(true);
        self.def.spec.description = description.to_owned();
        self
    }

    /// Poses as an app's tool that sends no annotations at all.
    pub fn unannotated_app(mut self, description: &str) -> Self {
        self.app = Some(false);
        self.def.spec.description = description.to_owned();
        self
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

    /// A fake `shell` is a command with no sandbox, as on a machine without one: classed by
    /// what it runs, for the review, starting in the bot's folder (`Lexical`'s `/workspace`)
    /// unless it is [`FakeTool::unplaced`].
    fn classed(&self, _key: &str, arguments: &Value) -> spade_core::autonomy::Classed {
        let count = self
            .classified
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
            + 1;
        if let Some(hook) = &self.classifying {
            hook(count);
        }
        if self.def.spec.name == spade_core::autonomy::SHELL {
            let classed = spade_core::autonomy::classify_shell(
                arguments,
                &spade_core::autonomy::shell::Lexical,
            );
            spade_core::autonomy::Classed {
                workspace: (!self.unplaced).then(|| "/workspace".to_owned()),
                // As if the folder's configuration had been inspected and runs nothing.
                config_clean: spade_core::autonomy::ConfigTools::ALL,
                // As if the machine could hold a settled read in a read-only sandbox: the fake
                // shell doesn't launch through one, so this only exercises the gate.
                sandboxable: !self.no_sandbox,
                ..classed
            }
        } else {
            spade_core::autonomy::Classed::default()
        }
    }

    fn always_scope(&self, arguments: &Value) -> Option<String> {
        self.scoped
            .then(|| arguments.get("command").and_then(Value::as_str))
            .flatten()
            .map(str::to_owned)
    }

    /// An app tool's server facts: its catalogue entry declares it (as a write outside the box
    /// unless the test says more); one that sends no annotations has no entry either.
    fn hints(&self) -> Option<spade_core::effect::Mcp> {
        self.app.map(|annotated| spade_core::effect::Mcp {
            read_only: self.def.risk == Risk::Read,
            annotated,
            declared: self
                .declared
                .or(annotated.then_some(spade_core::effect::Effect::Network)),
            ..spade_core::effect::Mcp::default()
        })
    }

    fn effect(&self, _arguments: &Value) -> Option<spade_core::effect::Effect> {
        use spade_core::effect::{builtin, mcp};
        match self.hints() {
            Some(hints) => mcp(hints),
            // A fake of Spade's own that isn't in its table acts outside the box, so it is
            // reviewed; tests of undeclared tools use `unannotated_app`.
            None => self
                .declared
                .or_else(|| builtin(&self.def.spec.name, self.def.risk))
                .or(Some(spade_core::effect::Effect::Network)),
        }
    }

    fn run(&self, _call_id: &str, arguments: Value) -> ToolFuture {
        let calls = self.calls.clone();
        let answer = self
            .answers
            .lock()
            .ok()
            .and_then(|mut queued| {
                if queued.len() > 1 {
                    queued.pop()
                } else {
                    queued.last().cloned()
                }
            })
            .unwrap_or_else(|| self.answer.clone());
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

/// What [`Options::before_work`] calls.
pub type BeforeWork = Arc<dyn Fn(&Arc<Engine>) + Send + Sync>;

pub struct Options {
    pub limits: Limits,
    /// The fake endpoints' key variables are unset: no preset is imported, as on a first run
    /// with nothing set up.
    pub no_env_keys: bool,
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
    /// Every read of the (mock) keychain itself waits until this opens, as on a prompt.
    pub keychain_read_gate: Option<Gate>,
    /// Writes to the database before Spade first opens it.
    pub seed: Option<fn(&Store) -> spade_store::Result<()>>,
    /// Bots' workspaces, for the API (ADR 0130).
    pub workspaces: Option<spade_server::workspace::Workspaces>,
    /// The person's accepted plugins (ADR 0151), from this stand-in for ace; hooks stop after
    /// `plugin_hook_limit` and local servers after `plugin_server_idle`.
    pub plugins: Option<Arc<dyn spade_server::plugins::Daemon>>,
    pub plugin_hook_limit: Duration,
    pub plugin_server_idle: Duration,
    /// The sandbox the plugins' hooks and servers go through; none by default.
    pub plugin_confine: Option<Arc<dyn spade_server::workspace::shell::Confine>>,
    /// How long a reading of ace's plugins is used.
    pub plugin_fresh_for: Duration,
    /// Skill proposals, for the API (ADR 0130).
    pub learning: Option<Arc<spade_server::learning::Learning>>,
    /// Spade's skill store, for the API (ADR 0151).
    pub skill_store: Option<Arc<spade_server::skill_store::SkillStore>>,
    /// Sets up connectors (ADR 0131), with the mock keychain.
    pub connectors: bool,
    /// With `connectors`: the client ID metadata document Spade signs in as.
    pub client_metadata: Option<String>,
    /// With `connectors`: Spade's own registered apps (ADR 0137).
    pub apps: Vec<spade_connect::App>,
    /// With `connectors`: catalogue entries added to the shipped ones.
    pub catalogue: Vec<spade_connect::Entry>,
    /// With `connectors`: Spade Cloud (ADR 0140).
    pub cloud: Option<spade_connect::Cloud>,
    /// The engine's clock; the machine's when absent.
    pub clock: Option<Arc<dyn Clock>>,
    /// The engine's ids; counting from 1 when absent.
    pub ids: Option<Arc<dyn Ids>>,
    /// Where bots on subscriptions reach ace (ADR 0133), set before work opens.
    pub brains: Option<spade_server::engine::BrainSource>,
    /// Called with the engine before it opens for work: what a restarted Spade sets up before a
    /// paused turn resumes (its security service, say).
    pub before_work: Option<BeforeWork>,
    /// Sending a model step again; quick waits when absent, so a failing endpoint is not slow.
    pub model_retry: Option<spade_server::engine::Retry>,
    /// The real `web_search` over these backends, with Brave's key from the mock keychain.
    pub search: Option<spade_search::SearchConfig>,
    /// The model that reviews held calls (ADR 0144, 0163). By default [`UNREACHABLE_REVIEWER`], whose
    /// endpoint refuses every connection: the review can't run, so every held call goes to the
    /// person and tests of approvals keep their script. `None` reviews on the default model
    /// (the fake), for the auto-review's own tests.
    pub reviewer: Option<String>,
    /// Spade's classifier (ADR 0172) is on. Off by default here, so tests of the reviewer keep
    /// their script; its own tests turn it on, as it is in a real Spade.
    pub classifier: bool,
}

/// A reviewer whose endpoint refuses connections (a local port nothing listens on).
pub const UNREACHABLE_REVIEWER: &str = "unreached/r";

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

    /// Closes it again: waits from now on hold until it opens.
    pub fn close(&self) {
        let (open, _) = &*self.0;
        if let Ok(mut open) = open.lock() {
            *open = false;
        }
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
            limits: Limits::default(),
            no_env_keys: false,
            skills: None,
            ace_home: None,
            ace_retry: None,
            adopt: None,
            keychain_delay: None,
            keychain_gate: None,
            settle_deadline: spade_server::startup::SETTLE_DEADLINE,
            seed: None,
            keychain_delete_gate: None,
            keychain_read_gate: None,
            keychain_gate_for: None,
            workspaces: None,
            plugins: None,
            plugin_hook_limit: Duration::from_secs(10),
            plugin_server_idle: Duration::from_secs(600),
            plugin_confine: None,
            plugin_fresh_for: spade_server::plugins::FRESH_FOR,
            learning: None,
            skill_store: None,
            connectors: false,
            client_metadata: None,
            apps: Vec::new(),
            catalogue: Vec::new(),
            cloud: None,
            clock: None,
            ids: None,
            brains: None,
            before_work: None,
            model_retry: None,
            search: None,
            reviewer: Some(UNREACHABLE_REVIEWER.to_owned()),
            classifier: false,
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
                                     "price": { "input": 0, "output": 0, "per_call": 1.5 } }] },
                      // Models whose endpoints search the web themselves, billed per search, for
                      // the web search tests to point at the fake.
                      { "id": "seeker", "name": "Seeker", "format": "anthropic",
                        "base_url": "https://seeker.example/v1/", "key": {},
                        "models": [{ "id": "seek-1", "name": "Seek", "capabilities": ["tools", "web-search"],
                                     "price": { "input": 0, "output": 0, "per_search": 0.5 } }] },
                      { "id": "looker", "name": "Looker", "format": "openai-responses",
                        "base_url": "https://looker.example/v1/", "key": {},
                        "models": [{ "id": "look-1", "name": "Look", "capabilities": ["tools", "web-search"],
                                     "price": { "input": 0, "output": 0, "per_search": 0.5 } }] },
                      // The reviewer tests use unless they test the review: nothing listens.
                      // Last, so it is never anyone's first usable model.
                      { "id": "unreached", "name": "Unreached", "format": "openai-chat",
                        "base_url": "http://127.0.0.1:9/v1/", "key": { "env": "UNREACHED_KEY" },
                        "models": [{ "id": "r", "name": "R", "capabilities": ["tools"],
                                     "price": { "input": 0, "output": 0 } }] }]
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

    /// Like `start`, with each streamed request (a turn's model step) taking the next of `turns`
    /// and every plain one (a title, the check of done) answered by `plain`.
    pub async fn start_turns(
        turns: Vec<Script>,
        plain: Script,
        tools: Vec<Arc<dyn Tool>>,
    ) -> Result<Self> {
        let fake = FakeProvider::start_turns(turns, plain).await?;
        let dir = Arc::new(tempfile::tempdir()?);
        Self::serve(fake, dir, tools, Options::default()).await
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
        let keys = match (&options.keychain_delete_gate, &options.keychain_read_gate) {
            (None, None) => KeyStore::with_store(mock.clone(), spade_keys::SERVICE),
            (deletes, reads) => KeyStore::with_store(
                Arc::new(gated::GatedStore {
                    inner: mock.clone(),
                    gate: deletes.clone(),
                    reads: reads.clone(),
                }),
                spade_keys::SERVICE,
            ),
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
        let env_keys = !options.no_env_keys;
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
                move |var| {
                    (env_keys && matches!(var, "FAKE_KEY" | "UNREACHED_KEY"))
                        .then(|| "fake-key".to_owned())
                },
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
        // The engine, once it exists, for tools that reach it (bots, apps' forms).
        let bots = spade_server::tools::EngineHandle::default();
        let connectors = if options.connectors {
            let hub = spade_connect::Connectors::open(spade_connect::Setup {
                store: Store::open(&dir.path().join("spade.sqlite"))?,
                keys: Some(keys.clone()),
                clock: spade_connect::system_clock(),
                random: Arc::new(spade_connect::OsRandom),
                catalogue: spade_connect::catalogue::shipped()
                    .into_iter()
                    .chain(options.catalogue.iter().cloned())
                    .collect(),
                timeout: Duration::from_secs(5),
                relist: Duration::from_secs(600),
                addresses: spade_connect::Addresses::system(),
                client_metadata: options.client_metadata.clone(),
                apps: options.apps.clone(),
                // A device sign-in's seconds pass in milliseconds here.
                tick: Duration::from_millis(1),
                cloud: options.cloud.clone(),
            })?;
            let source = spade_server::tools::ConnectorSource::new(
                hub.clone(),
                Store::open(&dir.path().join("spade.sqlite"))?,
            )
            .with_forms(bots.clone());
            tools = tools.with_source(Arc::new(source));
            Some(hub)
        } else {
            None
        };
        let plugins = match &options.plugins {
            Some(daemon) => {
                let workspaces = options.workspaces.clone().unwrap_or_else(|| {
                    spade_server::workspace::Workspaces::new(dir.path().join("workspace"))
                });
                let plugins = spade_server::plugins::Plugins::new(
                    daemon.clone(),
                    Store::open(&dir.path().join("spade.sqlite"))?,
                    workspaces,
                    match &options.plugin_confine {
                        Some(confine) => spade_server::workspace::shell::Shell::system()
                            .confined(confine.clone()),
                        None => spade_server::workspace::shell::Shell::system(),
                    },
                )
                .with_hook_limit(options.plugin_hook_limit)
                .with_server_idle(options.plugin_server_idle)
                .with_fresh_for(options.plugin_fresh_for);
                if let Some(store) = &options.skill_store {
                    plugins.set_skill_store(store.clone());
                }
                tools = tools.with_source(Arc::new(spade_server::tools::PluginTools::new(
                    plugins.clone(),
                    Store::open(&dir.path().join("spade.sqlite"))?,
                )));
                Some(plugins)
            }
            None => None,
        };
        // As in Spade: ace's tools are called for the bot that made each call.
        if let Some(link) = &ace {
            link.act_for(bots.clone());
        }
        let search = match options.search.clone() {
            Some(config) => {
                let lookup = keys.clone();
                let search = Arc::new(spade_search::Search::new(
                    config,
                    Keys::keychain_then_env(
                        move |backend| lookup.search_key(backend).ok().flatten(),
                        |_| None,
                    ),
                    Duration::from_secs(5),
                )?);
                tools = tools.with_tool(Arc::new(spade_server::tools::WebSearch {
                    search: search.clone(),
                    ace_fallback: false,
                    bots: bots.clone(),
                }));
                Some(search)
            }
            None => None,
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
        if !options.classifier {
            engine.set_oversight(spade_server::engine::GlobalChange {
                classifier: Some(false),
                ..Default::default()
            })?;
        }
        if let Some(brains) = options.brains.clone() {
            engine.set_brains(brains);
        }
        // A test's market signs the packages it installs; its key is what this Spade trusts.
        market::trust(&engine);
        if let Some(before) = &options.before_work {
            before(&engine);
        }
        bots.set(&engine);
        // As Spade wires it: workers and arrivals set apps through the hub.
        if let Some(hub) = &connectors {
            engine.set_connector_grants(hub.clone());
        }
        if let Some(plugins) = plugins {
            engine.set_profile_source(plugins.clone());
            engine.set_plugins(plugins);
        }
        if let (Some(search), Ok(url)) = (&search, engine.searxng_url()) {
            search.set_searxng(url.as_deref())?;
        }
        let state = AppState {
            engine: engine.clone(),
            token: TOKEN.into(),
            keys: Some(keys.clone()),
            ace: ace.clone(),
            workspaces: options.workspaces.clone(),
            learning: options.learning.clone(),
            skill_store: options.skill_store.clone(),
            connectors: connectors.clone(),
            search,
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
            if let Some(reviewer) = &options.reviewer {
                engine.set_oversight(spade_server::engine::GlobalChange {
                    review_model: Some(Some(reviewer.clone())),
                    ..Default::default()
                })?;
            }
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

    /// Stops this server, runs `sql` on its database (what a crash left behind), and opens a new
    /// engine and server on it.
    pub async fn restart_after_crash(
        mut self,
        sql: &str,
        tools: Vec<Arc<dyn Tool>>,
        scripts: Vec<Script>,
    ) -> Result<Self> {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        let _ = (&mut self.task).await;
        spade_store::Store::connect(self.dir.path().join("spade.sqlite"))?.execute_batch(sql)?;
        let fake = FakeProvider::start_sequence(scripts).await?;
        Self::serve(fake, self.dir.clone(), tools, Options::default()).await
    }

    /// Stops this server, runs `sql` on its database (to leave its events as a stop at a chosen
    /// point would), and opens a new engine and server on it with `options`.
    pub async fn restart_paused_with(
        mut self,
        sql: &str,
        tools: Vec<Arc<dyn Tool>>,
        scripts: Vec<Script>,
        options: Options,
    ) -> Result<Self> {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        let _ = (&mut self.task).await;
        spade_store::Store::connect(self.dir.path().join("spade.sqlite"))?.execute_batch(sql)?;
        let fake = FakeProvider::start_sequence(scripts).await?;
        Self::serve(fake, self.dir.clone(), tools, options).await
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

    /// [`Spade::restart_after_stop`] with `options` for the new server.
    pub async fn restart_after_stop_with(
        self,
        allowance: Duration,
        tools: Vec<Arc<dyn Tool>>,
        scripts: Vec<Script>,
        options: Options,
    ) -> Result<Self> {
        self.engine.pause_for_stop(allowance).await;
        self.restart_with(tools, scripts, options).await
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

    pub async fn patch(&self, path: &str, body: Value) -> Result<(u16, Value)> {
        let response = self
            .http
            .patch(format!("{}{path}", self.base))
            .bearer_auth(TOKEN)
            .json(&body)
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

    /// `PUT` with extra headers, as ace's daemon sends a stamped change.
    pub async fn put_with(
        &self,
        path: &str,
        body: Value,
        headers: &[(&str, &str)],
    ) -> Result<(u16, Value)> {
        let mut request = self
            .http
            .put(format!("{}{path}", self.base))
            .bearer_auth(TOKEN)
            .json(&body);
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        let response = request.send().await?;
        let status = response.status().as_u16();
        Ok((status, response.json().await.unwrap_or(Value::Null)))
    }

    /// Stores `key` for `endpoint` in the mock keychain behind Spade's back, as another app
    /// would: Spade learns of it only by reading.
    pub fn store_key_directly(&self, endpoint: &str, key: &str) -> Result {
        use keyring_core::api::CredentialStoreApi;
        self.mock
            .build(spade_keys::SERVICE, &format!("endpoint:{endpoint}"), None)?
            .set_password(key)?;
        Ok(())
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

    /// `POST` with extra headers, as ace's daemon sends a stamped change.
    pub async fn post_with(
        &self,
        path: &str,
        body: Value,
        headers: &[(&str, &str)],
    ) -> Result<(u16, Value)> {
        let mut request = self
            .http
            .post(format!("{}{path}", self.base))
            .bearer_auth(TOKEN)
            .json(&body);
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        let response = request.send().await?;
        let status = response.status().as_u16();
        Ok((status, response.json().await.unwrap_or(Value::Null)))
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

    /// Waits until some event has one of the types `kinds`, and returns all events at that point.
    pub async fn wait_for_any(&self, id: &str, kinds: &[&str]) -> Result<Vec<Value>> {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let events = self.events(id).await?;
            if events
                .iter()
                .any(|e| kinds.iter().any(|kind| e["type"] == *kind))
            {
                return Ok(events);
            }
            if Instant::now() > deadline {
                return Err(
                    format!("no {kinds:?} event; got {}", types(&events).join(", ")).into(),
                );
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
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
