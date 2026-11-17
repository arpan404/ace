//! A plugin's local server or hook that can't be sealed off in this machine's sandbox (on Windows:
//! one with network, or run from a folder Spade doesn't own) starts only once the person allows it
//! to run outside the sandbox (ADR 0167, Windows amendment). Spade asks with a request card in the
//! bot's conversation; until it is answered the server or hook is refused, never run plainly.
//!
//! The approval is bound to the bot, the plugin, its version and content hash, what runs (server
//! or hook), its command and its environment, so an update, a changed command or a changed
//! environment asks again. **Allow** covers one start; **Always for this plugin version** is kept
//! in Spade's database (`settings`, key `plugins.outside`). A server or hook allowed outside runs
//! plainly and is shown as such — never as `contained` — and the server's tool calls keep their
//! usual reviews.

use std::collections::HashSet;
use std::sync::{Mutex, OnceLock, Weak};

use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use spade_ace::plugins::SpadePlugin;
use spade_store::Store;

const KEY: &str = "plugins.outside";

/// Why a plugin's server or hook didn't start: it waits for the person.
pub const WAITING: &str = "It waits for you to allow it to run outside the sandbox.";

/// Why a plugin's server or hook didn't start: the person declined it.
pub const DECLINED: &str = "You declined to run it outside the sandbox.";

/// What of a plugin would run.
#[derive(Debug, Clone, Copy)]
pub enum What<'a> {
    /// Its local MCP server, by name.
    Server(&'a str),
    /// Its hook at this event.
    Hook(&'a str),
}

impl What<'_> {
    fn label(self) -> String {
        match self {
            Self::Server(name) => format!("server {name}"),
            Self::Hook(event) => format!("hook {event}"),
        }
    }
}

/// One start of a plugin's server or hook, as an approval is bound to it.
pub struct Start<'a> {
    pub bot: &'a str,
    pub plugin: &'a SpadePlugin,
    pub what: What<'a>,
    pub command: &'a str,
    pub args: &'a [String],
    pub env: &'a [(String, String)],
}

impl Start<'_> {
    /// What the approval is bound to: a digest of everything that decides what runs, and as whom.
    pub fn key(&self) -> String {
        let mut env = self.env.to_vec();
        env.sort();
        let bound = json!({
            "bot": self.bot,
            "plugin": self.plugin.install.name,
            "version": self.plugin.install.version,
            "hash": self.plugin.install.hash,
            "what": self.what.label(),
            "command": self.command,
            "args": self.args,
            "env": env,
        });
        Sha256::digest(bound.to_string().as_bytes())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }
}

/// The request's sentence for `plugin`, which can't be sealed off because of `reason` (the line
/// the sandbox gave).
pub fn line(plugin: &str, reason: &str) -> String {
    if reason == spade_sandbox::windows::NETWORK_REVIEW {
        format!(
            "{plugin} needs the network, and Windows can't seal that off yet. Run it outside the \
             sandbox?"
        )
    } else {
        format!(
            "{plugin} runs from a folder Spade can't seal off here yet. Run it outside the sandbox?"
        )
    }
}

/// A request to raise in a bot's conversation.
#[derive(Debug, Clone)]
pub struct Asked {
    pub plugin: String,
    pub version: String,
    pub hash: String,
    pub what: String,
    pub line: String,
    pub key: String,
}

/// Raises a request card in a bot's conversation: the engine, once it exists.
pub trait Ask: Send + Sync {
    fn ask_outside(&self, bot: &str, asked: Asked);
}

/// An approval kept for a plugin version.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct Kept {
    key: String,
    bot: String,
    plugin: String,
    version: String,
    hash: String,
}

/// The person's answers: kept (Always for this plugin version), once (one start), and declined
/// since Spade started (not asked again until it restarts or the plugin changes).
pub struct Outside {
    store: std::sync::Arc<Store>,
    lock: Mutex<()>,
    once: Mutex<HashSet<String>>,
    declined: Mutex<HashSet<String>>,
    asker: OnceLock<Weak<dyn Ask>>,
}

/// What may run of a start that can't be sealed off.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Allowed {
    /// The person allowed it outside the sandbox (kept, or this once).
    Outside,
    /// Not yet: the person is asked (or was, and hasn't answered).
    Waiting,
    /// The person declined it.
    Declined,
}

impl Outside {
    pub fn new(store: std::sync::Arc<Store>) -> Self {
        Self {
            store,
            lock: Mutex::new(()),
            once: Mutex::default(),
            declined: Mutex::default(),
            asker: OnceLock::new(),
        }
    }

    pub fn set_asker(&self, asker: Weak<dyn Ask>) {
        let _ = self.asker.set(asker);
    }

    /// Whether `start` may run outside the sandbox: an approval kept for it, or one for a single
    /// start (taken now). Otherwise the person is asked (unless they declined it), and it waits.
    pub fn decide(&self, start: &Start<'_>, reason: &str) -> Allowed {
        let key = start.key();
        if self.kept().iter().any(|kept| kept.key == key) {
            return Allowed::Outside;
        }
        if lock(&self.once).remove(&key) {
            return Allowed::Outside;
        }
        if lock(&self.declined).contains(&key) {
            return Allowed::Declined;
        }
        if let Some(asker) = self.asker.get().and_then(Weak::upgrade) {
            asker.ask_outside(
                start.bot,
                Asked {
                    plugin: start.plugin.install.name.clone(),
                    version: start.plugin.install.version.clone(),
                    hash: start.plugin.install.hash.clone(),
                    what: start.what.label(),
                    line: line(&start.plugin.install.name, reason),
                    key,
                },
            );
        }
        Allowed::Waiting
    }

    /// Records the person's answer to `asked` for `bot`.
    pub fn answered(
        &self,
        bot: &str,
        asked: &Asked,
        allowed: bool,
        always: bool,
    ) -> Result<(), spade_store::StoreError> {
        let key = asked.key.clone();
        if !allowed {
            lock(&self.declined).insert(key);
            return Ok(());
        }
        lock(&self.declined).remove(&key);
        if !always {
            lock(&self.once).insert(key);
            return Ok(());
        }
        let _held = lock(&self.lock);
        let mut all = self.kept();
        if !all.iter().any(|kept| kept.key == key) {
            all.push(Kept {
                key,
                bot: bot.to_owned(),
                plugin: asked.plugin.clone(),
                version: asked.version.clone(),
                hash: asked.hash.clone(),
            });
        }
        self.write(&all)
    }

    /// Whether the person allowed this plugin version to run outside the sandbox for `bot`.
    pub fn kept_for(&self, bot: &str, plugin: &SpadePlugin) -> bool {
        self.kept().iter().any(|kept| {
            kept.bot == bot
                && kept.plugin == plugin.install.name
                && kept.version == plugin.install.version
                && kept.hash == plugin.install.hash
        })
    }

    /// Forgets a deleted bot's approvals.
    pub fn forget(&self, bot: &str) -> Result<(), spade_store::StoreError> {
        let _held = lock(&self.lock);
        let mut all = self.kept();
        all.retain(|kept| kept.bot != bot);
        self.write(&all)
    }

    fn kept(&self) -> Vec<Kept> {
        match self.store.setting(KEY) {
            Ok(Some(text)) => serde_json::from_str(&text).unwrap_or_else(|error| {
                tracing::warn!(%error, "the plugins allowed outside the sandbox could not be read");
                Vec::new()
            }),
            Ok(None) => Vec::new(),
            Err(error) => {
                tracing::warn!(%error, "could not read the plugins allowed outside the sandbox");
                Vec::new()
            }
        }
    }

    fn write(&self, all: &[Kept]) -> Result<(), spade_store::StoreError> {
        let text = serde_json::to_string(all).unwrap_or_else(|_| "[]".to_owned());
        self.store.set_setting(KEY, Some(&text))
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|p| p.into_inner())
}
