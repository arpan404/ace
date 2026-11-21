//! A package's own code, as Spade keeps and runs it (ADR 0203 §3, §5). The bytes a step was
//! accepted with are kept once by their sha256 in Spade's own folder (`code/blobs`), which no run
//! sees; a linked bot's link pins each of its components to one of them. Each bot with code has
//! a worker of its own (`spade_wasm::BotCode`), whose only folder (`code/bots/<bot>`) holds copies
//! of exactly its pinned bytes. Moving the bot to another version retires its worker; the next
//! call starts one with the new pins.
//!
//! - [`accept`] checks the components sent with an install or a step and keeps their bytes.
//! - [`tools`] offers each switched-on component's tools to its bot as `code_<component>_<tool>`.
//! - [`http`] carries a component's `http` requests: through the bot's egress proxy, or a
//!   scenario's fakes.
//!
//! What a call may do is the engine's to decide (`engine::code`).

pub mod accept;
pub mod http;
pub mod tools;

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use sha2::{Digest, Sha256};
use spade_core::package::code::run::{self as code_run, ToolSpec};
use spade_wasm::{BotCode, Outcome, Target};
use tokio::process::Command;

/// Makes the command that starts a worker whose only folder is `folder`: inside the bot's
/// sandbox, offline, or an error when this machine can't hold it so.
pub type Launch = Arc<dyn Fn(&Path) -> Result<Command, String> + Send + Sync>;

/// The longest [`Code::list`] waits for a listing another caller started.
const LIST_WAIT: std::time::Duration = std::time::Duration::from_secs(30);

/// One machine's code: its blob store, its bots' workers and what each component offers.
pub struct Code {
    root: PathBuf,
    launch: Launch,
    http: Arc<dyn http::Http>,
    bots: Mutex<HashMap<String, Arc<BotCode>>>,
    /// Each component's tools, by sha256, once its `toolbox.tools` answered.
    listed: Mutex<HashMap<String, Listed>>,
    /// Components being listed now, so one is never listed twice at once.
    listing: Mutex<HashSet<String>>,
    /// The engine whose links say which components are on, once it set this up.
    engine: std::sync::OnceLock<std::sync::Weak<crate::engine::Engine>>,
}

/// The components of `link` whose switch is on, by name, with their pins: the only ones loaded,
/// listed or run (ADR 0203 §5).
pub fn enabled_pins(link: &spade_core::package::link::Link) -> BTreeMap<String, String> {
    link.code
        .iter()
        .filter(|(name, _)| link.on.contains(&code_run::switch_key(name)))
        .map(|(name, sha)| (name.clone(), sha.clone()))
        .collect()
}

/// What a component's `toolbox.tools` answered.
#[derive(Debug, Clone)]
pub enum Listed {
    Tools(Vec<ToolSpec>),
    /// Why it gives no tools: its answer didn't read, or it couldn't run.
    Failed(String),
}

impl Code {
    /// The code kept under `root` (Spade's data folder's `code`), workers started with `launch`,
    /// requests carried by `http`.
    pub fn new(root: &Path, launch: Launch, http: Arc<dyn http::Http>) -> Arc<Self> {
        Arc::new(Self {
            root: root.to_path_buf(),
            launch,
            http,
            bots: Mutex::default(),
            listed: Mutex::default(),
            listing: Mutex::default(),
            engine: std::sync::OnceLock::new(),
        })
    }

    /// Reads which components are on from `engine`'s links.
    pub(crate) fn bind(&self, engine: std::sync::Weak<crate::engine::Engine>) {
        let _ = self.engine.set(engine);
    }

    /// `bot`'s switched-on components and their pins, as its link says now.
    pub fn enabled(&self, bot: &str) -> BTreeMap<String, String> {
        self.engine
            .get()
            .and_then(std::sync::Weak::upgrade)
            .and_then(|engine| engine.bot_package(bot))
            .map(|link| enabled_pins(&link))
            .unwrap_or_default()
    }

    pub(crate) fn http(&self) -> &Arc<dyn http::Http> {
        &self.http
    }

    fn blobs(&self) -> PathBuf {
        self.root.join("blobs")
    }

    fn blob(&self, sha: &str) -> PathBuf {
        self.blobs().join(format!("{sha}.wasm"))
    }

    fn bot_folder(&self, bot: &str) -> PathBuf {
        self.root.join("bots").join(bot)
    }

    /// Keeps `bytes` by their sha256, which it answers. The same bytes kept twice are one file.
    pub fn keep(&self, bytes: &[u8]) -> Result<String, String> {
        let sha = hex(&Sha256::digest(bytes));
        let path = self.blob(&sha);
        if self.read_blob(&sha).is_some() {
            return Ok(sha);
        }
        std::fs::create_dir_all(self.blobs())
            .map_err(|e| format!("the code store couldn't be made: {e}"))?;
        let partial = self.blobs().join(format!("{sha}.part"));
        std::fs::write(&partial, bytes)
            .and_then(|()| std::fs::rename(&partial, &path))
            .map_err(|e| format!("the component couldn't be kept: {e}"))?;
        Ok(sha)
    }

    /// Kept bytes, only when they still hash to `sha`.
    fn read_blob(&self, sha: &str) -> Option<Vec<u8>> {
        if !is_sha(sha) {
            return None;
        }
        let bytes = std::fs::read(self.blob(sha)).ok()?;
        (hex(&Sha256::digest(&bytes)) == sha).then_some(bytes)
    }

    /// The bot's worker with every switched-on component in its folder, and no other: started at
    /// its first call. A switch that moves retires it.
    pub async fn bot(&self, bot: &str) -> Result<Arc<BotCode>, String> {
        let pins = self.enabled(bot);
        if let Some(found) = self.bots.lock().unwrap_or_else(|p| p.into_inner()).get(bot) {
            return Ok(found.clone());
        }
        let folder = self.bot_folder(bot);
        std::fs::create_dir_all(&folder)
            .map_err(|e| format!("the bot's code folder couldn't be made: {e}"))?;
        let launch = self.launch.clone();
        let launched = folder.clone();
        let code = Arc::new(BotCode::new(&folder, Box::new(move || launch(&launched))));
        for (name, sha) in &pins {
            let bytes = self
                .read_blob(sha)
                .ok_or_else(|| format!("{name}'s bytes aren't kept on this machine"))?;
            code.add(&bytes).await?;
        }
        let mut bots = self.bots.lock().unwrap_or_else(|p| p.into_inner());
        Ok(bots.entry(bot.to_owned()).or_insert(code).clone())
    }

    /// Stop on the bot: every code call it has open ends now (ADR 0203 §4).
    pub async fn stop(&self, bot: &str) {
        let found = self
            .bots
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(bot)
            .cloned();
        if let Some(code) = found {
            code.stop().await;
        }
    }

    /// The bot moved to another version, was paused or was removed: its worker ends and its folder
    /// goes. The next call starts afresh from the link's pins.
    pub fn retire(&self, bot: &str) {
        let found = self
            .bots
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(bot);
        let _ = std::fs::remove_dir_all(self.bot_folder(bot));
        if let Some(code) = found {
            match tokio::runtime::Handle::try_current() {
                Ok(handle) => {
                    handle.spawn(async move { code.pause().await });
                }
                Err(_) => drop(code),
            }
        }
    }

    /// Kept bytes no pin in `live` names go, with the folders of bots not in `bots` (an install a
    /// crash cut short, a removed bot). Run as Spade opens, before any call.
    pub fn collect(&self, live: &HashSet<String>, bots: &HashSet<String>) {
        if let Ok(entries) = std::fs::read_dir(self.blobs()) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                let sha = name.split('.').next().unwrap_or_default();
                if !live.contains(sha) {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
        if let Ok(entries) = std::fs::read_dir(self.root.join("bots")) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if !bots.contains(&name) {
                    let _ = std::fs::remove_dir_all(entry.path());
                }
            }
        }
    }

    /// What the component `sha` offers, once known.
    pub fn listed(&self, sha: &str) -> Option<Listed> {
        self.listed
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(sha)
            .cloned()
    }

    /// Asks the bot's worker for the tools of each switched-on component not listed yet; one
    /// that is off is never loaded or run. A component that can't be listed gives no tools, with
    /// why.
    pub async fn list(&self, bot: &str) {
        let pins = self.enabled(bot);
        let wanted: Vec<String> = {
            let listed = self.listed.lock().unwrap_or_else(|p| p.into_inner());
            let mut listing = self.listing.lock().unwrap_or_else(|p| p.into_inner());
            pins.values()
                .filter(|sha| !listed.contains_key(*sha) && listing.insert((*sha).clone()))
                .cloned()
                .collect()
        };
        if !wanted.is_empty() {
            self.list_now(bot, wanted).await;
        }
        // Another listing of the same component may still be under way: its answer is waited
        // for, so whoever asks is offered its tools once this returns.
        let deadline = tokio::time::Instant::now() + LIST_WAIT;
        while self
            .enabled(bot)
            .values()
            .any(|sha| self.listed(sha).is_none())
            && tokio::time::Instant::now() < deadline
        {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    }

    async fn list_now(&self, bot: &str, wanted: Vec<String>) {
        let worker = self.bot(bot).await;
        for sha in wanted {
            // Checked again right before it runs: a switch turned off meanwhile runs nothing.
            if !self.enabled(bot).values().any(|on| *on == sha) {
                self.listing
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .remove(&sha);
                continue;
            }
            let listed = match &worker {
                Err(why) => Listed::Failed(why.clone()),
                Ok(code) => list_one(code, &sha).await,
            };
            if let Listed::Failed(why) = &listed {
                tracing::warn!(%bot, component = %sha, %why, "a component gives no tools");
            }
            self.listed
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .insert(sha.clone(), listed);
            self.listing
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .remove(&sha);
        }
    }
}

/// One component's `toolbox.tools`, read. It may ask Spade for nothing while listing.
async fn list_one(code: &BotCode, sha: &str) -> Listed {
    let bounds = spade_core::package::code::Bounds {
        deadline_ms: u64::from(spade_core::package::code::DEFAULT_TIMEOUT_S) * 1000,
        fuel: spade_core::package::code::FUEL_PER_CALL,
        memory_bytes: u64::from(spade_core::package::code::DEFAULT_MEMORY_MB) * 1024 * 1024,
    };
    let running = match code.call(sha, Target::Tools, "", bounds).await {
        Ok(running) => running,
        Err(why) => return Listed::Failed(why),
    };
    let outcome = running
        .finish(|_| async {
            Err("a component asks for nothing while it lists its tools".to_owned())
        })
        .await;
    match outcome {
        Outcome::Done {
            output: Ok(json), ..
        } => match code_run::tools_from(&json) {
            Ok((tools, left_out)) => {
                for why in left_out {
                    tracing::warn!(component = %sha, %why, "a tool was left out");
                }
                Listed::Tools(tools)
            }
            Err(why) => Listed::Failed(why),
        },
        Outcome::Done {
            output: Err(why), ..
        } => Listed::Failed(why),
        Outcome::Failed { message, .. } => Listed::Failed(message),
    }
}

pub(crate) fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn is_sha(text: &str) -> bool {
    text.len() == 64 && text.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Where a machine's workers start from: the worker binary (Spade's own with
/// [`spade_wasm::launch::WORKER_ARG`], or `spade-wasm`) and the folders the sandbox hides.
#[derive(Debug, Clone)]
pub struct Workers {
    pub program: PathBuf,
    pub args: Vec<std::ffi::OsString>,
    pub home: PathBuf,
    pub spade_data: PathBuf,
    pub ace_data: Option<PathBuf>,
}

/// Starts each worker inside the bot's sandbox, offline (ADR 0203 §3). A machine whose sandbox
/// can't hold it so runs no code: its calls answer why.
pub fn sandboxed(runner: spade_sandbox::Runner, workers: Workers) -> Launch {
    Arc::new(move |folder: &Path| {
        if !runner.holds_offline() {
            return Err(
                "code runs only inside the bot's sandbox, which this machine can't hold offline"
                    .to_owned(),
            );
        }
        let place = spade_wasm::launch::Place {
            program: workers.program.clone(),
            args: workers.args.clone(),
            folder: folder.to_path_buf(),
            home: workers.home.clone(),
            spade_data: workers.spade_data.clone(),
            ace_data: workers.ace_data.clone(),
        };
        spade_wasm::launch::command(&runner, &place)
    })
}

/// Asks `bot`'s components for their tools now, in the background, so its next turn is offered
/// them: after an install or a step, and as Spade opens.
pub fn warm(engine: &crate::engine::Engine, bot: &str) {
    let Some(code) = engine.code() else {
        return;
    };
    if code.enabled(bot).is_empty() {
        return;
    }
    let Ok(handle) = tokio::runtime::Handle::try_current() else {
        return;
    };
    let bot = bot.to_owned();
    handle.spawn(async move { code.list(&bot).await });
}

/// Every pin a bot's link, a step it is taking or a step held for it names, and every bot: what
/// [`Code::collect`] keeps. Run as Spade opens, before any call.
pub fn collect_unused(engine: &crate::engine::Engine) {
    let Some(code) = engine.code() else {
        return;
    };
    let Ok(agents) = engine.store().agents() else {
        return;
    };
    let mut live = HashSet::new();
    let mut bots = HashSet::new();
    for agent in &agents {
        bots.insert(agent.id.clone());
        if let Some(link) = engine.bot_package(&agent.id) {
            live.extend(link.code.values().cloned());
            if let Some(pending) = &link.pending {
                live.extend(pending.code.values().cloned());
            }
        }
        if let Some(held) = crate::packages::held::of(engine, &agent.id) {
            live.extend(held.code.values().cloned());
        }
    }
    code.collect(&live, &bots);
    for bot in &bots {
        warm(engine, bot);
    }
}
