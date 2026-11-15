//! The person's plugins for Spade's bots (ADR 0151, points 8–13): which accepted plugins each bot
//! may use, what of them it uses (rules, hooks, local MCP servers), and the local servers'
//! processes. Plugins are read from the daemon only (`plugins.list`, `plugins.spade`); Spade
//! never reads a plugin's folder, it only runs the accepted commands there.
//!
//! What a bot can use of a plugin is decided in [`view`]; running hooks is [`hooks`]; local
//! servers and their tools are [`servers`]. The engine's hook points are in
//! `engine::plugin_hooks`.

mod access;
pub mod hooks;
pub mod servers;
pub mod view;

use std::collections::{BTreeSet, HashMap};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use spade_ace::plugins::{Installed, SpadePlugin};
use spade_store::Store;
use tokio::time::Instant;

use crate::workspace::Workspaces;
use crate::workspace::shell::Shell;

pub use access::Access;
pub use servers::{PluginTools, ServerState};

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// The daemon's plugin requests, so tests can stand in for ace.
pub trait Daemon: Send + Sync {
    /// Every accepted plugin and whether ace has it on.
    fn installed(&self) -> BoxFuture<'_, Result<Vec<Installed>, String>>;
    /// One accepted plugin as Spade uses it.
    fn plugin<'a>(&'a self, name: &'a str) -> BoxFuture<'a, Result<SpadePlugin, String>>;
    /// One file of an accepted plugin's skill, by its path in the plugin, as accepted.
    fn file<'a>(&'a self, name: &'a str, path: &'a str) -> BoxFuture<'a, Result<Vec<u8>, String>> {
        let _ = (name, path);
        Box::pin(async { Err("this daemon can't send a plugin's files".to_owned()) })
    }
}

/// The daemon as the skill store reads plugin skills' files.
struct DaemonFiles<'a>(&'a dyn Daemon);

impl crate::skill_store::PluginFiles for DaemonFiles<'_> {
    fn file<'a>(
        &'a self,
        plugin: &'a str,
        path: &'a str,
    ) -> BoxFuture<'a, Result<Vec<u8>, String>> {
        self.0.file(plugin, path)
    }
}

/// How long a reading of the daemon's plugins is used before it is read again.
pub const FRESH_FOR: Duration = Duration::from_secs(30);

/// How long hooks wait for a stale reading to be read again before going with the last one.
const REREAD_WAIT: Duration = Duration::from_secs(2);

pub struct Plugins {
    daemon: Arc<dyn Daemon>,
    access: Access,
    workspaces: Workspaces,
    shell: Shell,
    known: Mutex<Known>,
    refreshing: tokio::sync::Mutex<()>,
    servers: servers::Servers,
    /// How long a reading is used, in milliseconds ([`FRESH_FOR`] unless a test shortens it).
    fresh_for: std::sync::atomic::AtomicU64,
    /// How long one hook may run, in milliseconds ([`hooks::LIMIT`] unless a test shortens it).
    hook_limit: std::sync::atomic::AtomicU64,
    /// Where the plugins' skills and commands go, once set.
    skill_store: std::sync::OnceLock<Arc<crate::skill_store::SkillStore>>,
}

#[derive(Default)]
struct Known {
    installed: Vec<Installed>,
    /// The last copy of each accepted plugin, by name.
    plugins: HashMap<String, Arc<SpadePlugin>>,
    read_at: Option<Instant>,
    /// Why the last reading failed; the last copy is used meanwhile.
    problem: Option<String>,
}

/// One accepted plugin as a bot's settings show it.
#[derive(Debug, Clone, Serialize)]
pub struct PluginView {
    pub name: String,
    pub version: String,
    /// Turned on in ace; off means off for every bot.
    pub enabled_in_ace: bool,
    /// The person allowed it for this bot.
    pub allowed: bool,
    pub rules: Vec<String>,
    /// Skills its bots may load, and commands (manual skills only the person starts).
    pub skills: Vec<String>,
    pub commands: Vec<String>,
    /// Agents, as helper profiles of the bots allowed the plugin.
    pub agents: Vec<String>,
    pub hooks: Vec<String>,
    pub servers: Vec<ServerState>,
    /// Remote servers, added as connectors by URL.
    pub remote: Vec<view::RemoteServer>,
    pub not_used: Vec<view::NotUsed>,
}

/// A bot's plugins page.
#[derive(Debug, Clone, Serialize)]
pub struct BotPlugins {
    pub plugins: Vec<PluginView>,
    /// The bot runs on a subscription: it gets only rules (ADR 0133).
    pub cli: bool,
    /// Why ace's plugins could not be read just now, if they couldn't.
    pub problem: Option<String>,
}

impl Plugins {
    pub fn new(
        daemon: Arc<dyn Daemon>,
        store: Store,
        workspaces: Workspaces,
        shell: Shell,
    ) -> Arc<Self> {
        Arc::new(Self {
            daemon,
            access: Access::new(store),
            workspaces,
            shell,
            known: Mutex::new(Known::default()),
            refreshing: tokio::sync::Mutex::new(()),
            servers: servers::Servers::default(),
            fresh_for: std::sync::atomic::AtomicU64::new(
                u64::try_from(FRESH_FOR.as_millis()).unwrap_or(30_000),
            ),
            hook_limit: std::sync::atomic::AtomicU64::new(
                u64::try_from(hooks::LIMIT.as_millis()).unwrap_or(10_000),
            ),
            skill_store: std::sync::OnceLock::new(),
        })
    }

    /// Keeps the plugins' skills and commands in `store`, offered to the bots allowed them.
    pub fn set_skill_store(self: &Arc<Self>, store: Arc<crate::skill_store::SkillStore>) {
        let access: Arc<dyn crate::skill_store::PluginAccess> = self.clone();
        store.set_plugins(Arc::downgrade(&access));
        let _ = self.skill_store.set(store);
    }

    /// Brings the store's plugin skills in step with the plugins ace has on.
    async fn sync_skills(&self) {
        let Some(store) = self.skill_store.get() else {
            return;
        };
        let plugins: Vec<Arc<SpadePlugin>> = lock(&self.known).plugins.values().cloned().collect();
        let wanted: Vec<crate::skill_store::PluginSkill> = plugins
            .iter()
            .filter(|plugin| plugin.enabled)
            .flat_map(|plugin| view::usable(plugin, false).skills)
            .collect();
        if let Err(error) = store
            .sync_plugins(&wanted, &DaemonFiles(&*self.daemon))
            .await
        {
            tracing::warn!(%error, "the plugins' skills were not brought in step");
        }
    }

    /// Makes local servers stop after `idle` unused, for tests.
    #[must_use]
    pub fn with_server_idle(self: Arc<Self>, idle: Duration) -> Arc<Self> {
        self.servers.set_idle(idle);
        self
    }

    /// Makes each hook stop after `limit`, for tests.
    #[must_use]
    pub fn with_hook_limit(self: Arc<Self>, limit: Duration) -> Arc<Self> {
        let ms = u64::try_from(limit.as_millis()).unwrap_or(u64::MAX);
        self.hook_limit
            .store(ms, std::sync::atomic::Ordering::Relaxed);
        self
    }

    /// Makes a reading of ace's plugins go stale after `fresh_for`, for tests.
    #[must_use]
    pub fn with_fresh_for(self: Arc<Self>, fresh_for: Duration) -> Arc<Self> {
        let ms = u64::try_from(fresh_for.as_millis()).unwrap_or(u64::MAX);
        self.fresh_for
            .store(ms, std::sync::atomic::Ordering::Relaxed);
        self
    }

    fn fresh_for(&self) -> Duration {
        Duration::from_millis(self.fresh_for.load(std::sync::atomic::Ordering::Relaxed))
    }

    fn hook_limit(&self) -> Duration {
        Duration::from_millis(self.hook_limit.load(std::sync::atomic::Ordering::Relaxed))
    }

    /// Reads the daemon's plugins again unless the last reading is fresh. A plugin whose hash
    /// is unchanged is not fetched again. With ace away the last copy is kept.
    pub async fn refresh(&self) {
        let _one = self.refreshing.lock().await;
        let fresh = lock(&self.known)
            .read_at
            .is_some_and(|at| at.elapsed() < self.fresh_for());
        if fresh {
            return;
        }
        let installed = match self.daemon.installed().await {
            Ok(installed) => installed,
            Err(problem) => {
                let mut known = lock(&self.known);
                known.problem = Some(problem);
                known.read_at = Some(Instant::now());
                return;
            }
        };
        let mut plugins = HashMap::new();
        let mut problem = None;
        for entry in installed.iter().filter(|entry| entry.enabled) {
            let cached = lock(&self.known).plugins.get(&entry.install.name).cloned();
            match cached {
                Some(plugin) if plugin.install.hash == entry.install.hash => {
                    plugins.insert(entry.install.name.clone(), plugin);
                }
                _ => match self.daemon.plugin(&entry.install.name).await {
                    Ok(plugin) if plugin.install.hash == entry.install.hash => {
                        plugins.insert(entry.install.name.clone(), Arc::new(plugin));
                    }
                    Ok(_) => problem = Some("a plugin changed while it was read".to_owned()),
                    Err(error) => problem = Some(error),
                },
            }
        }
        {
            let mut known = lock(&self.known);
            known.installed = installed;
            known.plugins = plugins;
            known.read_at = Some(Instant::now());
            known.problem = problem;
        }
        self.servers.keep(|agent, plugin, hash| {
            self.usable_plugin(agent, plugin)
                .is_some_and(|p| p.install.hash == hash)
        });
        self.sync_skills().await;
    }

    /// [`Plugins::refresh`], waiting at most a moment: a daemon that doesn't answer leaves the
    /// last reading in use until it is stale again.
    pub async fn refresh_briefly(&self) {
        if tokio::time::timeout(REREAD_WAIT, self.refresh())
            .await
            .is_err()
        {
            let mut known = lock(&self.known);
            known.problem = Some("ace's plugins did not answer in time".to_owned());
            known.read_at = Some(Instant::now());
        }
    }

    /// Reads the daemon's plugins again now, whatever the last reading.
    pub async fn refresh_now(&self) {
        lock(&self.known).read_at = None;
        self.refresh().await;
    }

    /// The plugins `agent` may use now: allowed by the person, on in ace, and read.
    pub fn for_agent(&self, agent: &str) -> Vec<Arc<SpadePlugin>> {
        let allowed = self.access.allowed(agent);
        let known = lock(&self.known);
        let mut plugins: Vec<Arc<SpadePlugin>> = allowed
            .iter()
            .filter_map(|name| known.plugins.get(name).cloned())
            .filter(|plugin| plugin.enabled)
            .collect();
        plugins.sort_by(|a, b| a.install.name.cmp(&b.install.name));
        plugins
    }

    fn usable_plugin(&self, agent: &str, name: &str) -> Option<Arc<SpadePlugin>> {
        self.for_agent(agent)
            .into_iter()
            .find(|plugin| plugin.install.name == name)
    }

    /// The rules `agent`'s plugins add to its standing instructions.
    pub fn rules(&self, agent: &str, cli: bool) -> String {
        let rules: Vec<view::Rule> = self
            .for_agent(agent)
            .iter()
            .flat_map(|plugin| view::usable(plugin, cli).rules)
            .collect();
        view::rules_text(&rules)
    }

    /// Lets `agent` use exactly `names`. Only plugins accepted in ace may be named.
    pub fn set_allowed(&self, agent: &str, names: BTreeSet<String>) -> Result<(), AllowError> {
        {
            let known = lock(&self.known);
            if let Some(unknown) = names
                .iter()
                .find(|name| !known.installed.iter().any(|i| &i.install.name == *name))
            {
                return Err(AllowError::Unknown(unknown.clone()));
            }
        }
        self.access
            .set(agent, names)
            .map_err(|e| AllowError::Store(e.to_string()))?;
        self.servers.keep(|agent, plugin, hash| {
            self.usable_plugin(agent, plugin)
                .is_some_and(|p| p.install.hash == hash)
        });
        Ok(())
    }

    /// Forgets a deleted bot: its allow list and its servers.
    pub fn forget(&self, agent: &str) {
        if let Err(error) = self.access.set(agent, BTreeSet::new()) {
            tracing::warn!(%error, "could not forget a bot's plugins");
        }
        self.servers.keep(|a, _, _| a != agent);
    }

    /// Every accepted plugin as `agent`'s settings show it.
    pub fn view(&self, agent: &str, cli: bool) -> BotPlugins {
        let allowed = self.access.allowed(agent);
        let known = lock(&self.known);
        let mut plugins: Vec<PluginView> = known
            .installed
            .iter()
            .map(|entry| {
                let name = &entry.install.name;
                let usable = known
                    .plugins
                    .get(name)
                    .map(|plugin| view::usable(plugin, cli))
                    .unwrap_or_default();
                PluginView {
                    name: name.clone(),
                    version: entry.install.version.clone(),
                    enabled_in_ace: entry.enabled,
                    allowed: allowed.contains(name),
                    rules: usable.rules.iter().map(|r| r.name.clone()).collect(),
                    skills: names(&usable.skills, false),
                    commands: names(&usable.skills, true),
                    hooks: usable.hooks.iter().map(|h| h.event.clone()).collect(),
                    servers: usable
                        .local
                        .iter()
                        .map(|server| self.servers.state(agent, name, &server.name))
                        .collect(),
                    remote: usable.remote,
                    agents: usable.profiles.iter().map(|p| p.name.clone()).collect(),
                    not_used: usable.not_used,
                }
            })
            .collect();
        plugins.sort_by(|a, b| a.name.cmp(&b.name));
        BotPlugins {
            plugins,
            cli,
            problem: known.problem.clone(),
        }
    }

    /// Stops every local server, when Spade stops.
    pub fn stop_all(&self) {
        self.servers.keep(|_, _, _| false);
    }

    fn workspace_dir(&self, agent: &str) -> Option<std::path::PathBuf> {
        let workspace = self.workspaces.of(agent).ok()?;
        workspace.path().ok()
    }
}

impl crate::skill_store::PluginAccess for Plugins {
    fn plugins_for(&self, agent: &str) -> Vec<String> {
        self.for_agent(agent)
            .iter()
            .map(|plugin| plugin.install.name.clone())
            .collect()
    }

    fn refresh(&self) -> BoxFuture<'_, ()> {
        Box::pin(self.refresh_briefly())
    }
}

/// The agents of the plugins a bot may use now, as its helpers' profiles (ADR 0152, point 4).
impl crate::engine::ProfileSource for Plugins {
    fn profiles(&self, agent: &str) -> Vec<spade_core::helper::Profile> {
        self.for_agent(agent)
            .iter()
            .flat_map(|plugin| view::usable(plugin, false).profiles)
            .collect()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AllowError {
    #[error("no accepted plugin is called {0}")]
    Unknown(String),
    #[error("{0}")]
    Store(String),
}

/// The names of a plugin's commands (`manual`) or skills.
fn names(skills: &[crate::skill_store::PluginSkill], manual: bool) -> Vec<String> {
    skills
        .iter()
        .filter(|skill| skill.manual == manual)
        .map(|skill| skill.name.clone())
        .collect()
}

/// The variables naming a plugin's folder, as ADR 0014's placeholders do, so a command's
/// `${PLUGIN_ROOT}` finds it.
pub(crate) fn root_vars(root: &str) -> Vec<(String, String)> {
    [
        "PLUGIN_ROOT",
        "ACE_PLUGIN_ROOT",
        "CLAUDE_PLUGIN_ROOT",
        "CURSOR_PLUGIN_ROOT",
    ]
    .iter()
    .map(|name| ((*name).to_owned(), root.to_owned()))
    .collect()
}

/// `${PLUGIN_ROOT}` (and the provider spellings) in `value`, written out.
pub(crate) fn expand_root(value: &str, root: &str) -> String {
    let mut out = value.to_owned();
    for name in [
        "ACE_PLUGIN_ROOT",
        "CLAUDE_PLUGIN_ROOT",
        "CURSOR_PLUGIN_ROOT",
        "PLUGIN_ROOT",
    ] {
        out = out.replace(&format!("${{{name}}}"), root);
    }
    out
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}
