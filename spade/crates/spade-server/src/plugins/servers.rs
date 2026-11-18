//! Plugins' local MCP servers (ADR 0151, point 11): one process per bot and server, started on
//! the bot's first tool search or call, run in the bot's workspace with the shell's built
//! environment plus the variables the plugin declared. The stdio transport's lifecycle (idle
//! stop, crash restarts) is `spade_mcp`'s.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use spade_ace::plugins::SpadePlugin;
use spade_mcp::{McpClient, McpConfig, McpTool, StdioCommand, ToolsError};

use super::view::LocalServer;
use super::{expand_root, lock, root_vars};

/// How long a call to a local server may take.
const CALL_TIMEOUT: Duration = Duration::from_secs(60);
/// How long the first listing waits for a server to start.
const START_TIMEOUT: Duration = Duration::from_secs(30);

/// (bot, plugin, server)
type Key = (String, String, String);

#[derive(Default)]
pub(super) struct Servers {
    map: Mutex<HashMap<Key, Arc<Server>>>,
    idle: Mutex<Option<Duration>>,
}

pub struct Server {
    pub plugin: String,
    pub name: String,
    hash: String,
    pub client: McpClient,
    tools: Mutex<Option<Vec<McpTool>>>,
    problem: Mutex<Option<String>>,
    /// Its sandbox's proxy access, held as long as the server may run (ADR 0167).
    _hold: Option<Box<dyn std::any::Any + Send + Sync>>,
    /// It runs in a sandbox that holds files and network here, so its calls are the OS's to
    /// decide (ADR 0171).
    contained: bool,
    /// It runs in the sandbox with its network off and no environment of the plugin's own (where
    /// API tokens go): nothing it does leaves this machine as anyone (ADR 0163, amendment 2).
    sealed: bool,
    /// It can't be sealed off here and the person allowed it to run outside the sandbox: it runs
    /// plainly, never `contained`, and its calls keep their reviews (ADR 0167).
    outside: bool,
    /// It can't be sealed off here and waits for the person to allow it outside the sandbox (or
    /// they declined): not started, and set up again on its next start.
    waiting: bool,
    /// What its tools declare they do, by tool name, from its execution entry.
    effects: std::collections::BTreeMap<String, spade_core::effect::Effect>,
}

/// A local server as a bot's settings show it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ServerState {
    pub name: String,
    /// `not_started`, `running`, `stopped` (idle), `failed`, or `waiting_for_you` (it can't be
    /// sealed off here and waits for the person to allow it outside the sandbox).
    pub state: &'static str,
    pub tools: usize,
    pub problem: Option<String>,
    /// It runs outside the sandbox, as the person allowed: uncontained.
    pub outside_sandbox: bool,
}

impl Server {
    /// Whether its calls run in a sandbox that holds files and network here.
    /// Whether nothing its tools do can leave this machine: sandboxed, offline, no tokens.
    pub fn sealed(&self) -> bool {
        self.sealed
    }

    pub fn contained(&self) -> bool {
        self.contained
    }

    /// The plugin version it runs (the accepted install's hash).
    pub fn version(&self) -> &str {
        &self.hash
    }

    /// What `tool` declares it does, when its entry says.
    pub fn declared(&self, tool: &str) -> Option<spade_core::effect::Effect> {
        self.effects.get(tool).copied()
    }

    pub fn tools(&self) -> Vec<McpTool> {
        lock(&self.tools).clone().unwrap_or_default()
    }

    pub async fn call(
        &self,
        tool: &str,
        arguments: serde_json::Value,
    ) -> Result<spade_mcp::McpToolResult, ToolsError> {
        let result = self.client.call(tool, arguments).await;
        if let Err(error) = &result {
            *lock(&self.problem) = Some(error.to_string());
        }
        result
    }

    async fn list(&self) {
        match tokio::time::timeout(START_TIMEOUT, self.client.tools()).await {
            Ok(Ok(tools)) => {
                *lock(&self.tools) = Some(tools);
                *lock(&self.problem) = None;
            }
            Ok(Err(error)) => *lock(&self.problem) = Some(error.to_string()),
            Err(_) => *lock(&self.problem) = Some("it did not start in time".to_owned()),
        }
    }
}

impl Servers {
    pub(super) fn set_idle(&self, idle: Duration) {
        *lock(&self.idle) = Some(idle);
    }

    /// Keeps only the servers `keep(bot, plugin, hash)` says to; the rest are stopped.
    pub(super) fn keep(&self, keep: impl Fn(&str, &str, &str) -> bool) {
        let dropped: Vec<Arc<Server>> = {
            let mut map = lock(&self.map);
            let gone: Vec<Key> = map
                .iter()
                .filter(|((agent, plugin, _), server)| !keep(agent, plugin, &server.hash))
                .map(|(key, _)| key.clone())
                .collect();
            gone.iter().filter_map(|key| map.remove(key)).collect()
        };
        for server in dropped {
            server.client.close();
        }
    }

    /// The bot's server, created (not yet started) if it has none.
    pub(super) fn server(
        &self,
        agent: &str,
        plugin: &SpadePlugin,
        server: &LocalServer,
        dir: &Path,
        base_env: Vec<(String, String)>,
        how: &Starting<'_>,
    ) -> Arc<Server> {
        let (shell, consents) = (how.shell, how.consents);
        let key = (agent.to_owned(), server.plugin.clone(), server.name.clone());
        let mut map = lock(&self.map);
        if let Some(existing) = map.get(&key)
            && existing.hash == plugin.install.hash
            && !existing.waiting
        {
            return existing.clone();
        }
        let root = &plugin.root;
        let mut command = StdioCommand::new(expand_root(&server.command, root), dir);
        command.args = server.args.iter().map(|a| expand_root(a, root)).collect();
        // What the plugin injects of its own (an API token, say), beyond the bot's shell's.
        let injects = !server.env.is_empty();
        let mut env = base_env;
        env.extend(root_vars(root));
        env.extend(
            server
                .env
                .iter()
                .map(|(name, value)| (name.clone(), expand_root(value, root))),
        );
        command.env = env;
        if let Some(idle) = *lock(&self.idle) {
            command.idle = idle;
        }
        // The bot's sandbox, reading the plugin's folder too (ADR 0167). Where the sandbox can't
        // seal it off (on Windows: network, or a folder Spade doesn't own), it starts only once
        // the person allows it to run outside the sandbox, and then plainly — never `contained`.
        // Where it should hold the server and can't, the server doesn't start.
        let kind = crate::workspace::shell::Kind::Plugin { root: root.into() };
        let mut online = true;
        let (hold, problem, outside, waiting) = match shell.review(dir, &kind) {
            Some(reason) => {
                let start = super::outside::Start {
                    bot: agent,
                    plugin,
                    what: super::outside::What::Server(&server.name),
                    command: &command.program,
                    args: &command.args,
                    env: &command.env,
                };
                match consents.decide(&start, &reason) {
                    super::outside::Allowed::Outside => (None, None, true, false),
                    super::outside::Allowed::Waiting => {
                        (None, Some(super::outside::WAITING.to_owned()), false, true)
                    }
                    super::outside::Allowed::Declined => {
                        (None, Some(super::outside::DECLINED.to_owned()), false, true)
                    }
                }
            }
            None => {
                let (hold, problem) = match server_plan(shell.confine(dir, &kind)) {
                    ServerPlan::Plain => (None, None),
                    ServerPlan::Refuse(why) => (None, Some(why)),
                    ServerPlan::Wrap(confined) => {
                        let args: Vec<std::ffi::OsString> =
                            command.args.iter().map(Into::into).collect();
                        match (confined.launch)(Path::new(&command.program), &args) {
                            Ok((program, args)) => {
                                command.program = program.to_string_lossy().into_owned();
                                command.args = args
                                    .iter()
                                    .map(|a| a.to_string_lossy().into_owned())
                                    .collect();
                                if let Some((_, path)) =
                                    command.env.iter_mut().find(|(n, _)| n == "PATH")
                                    && !confined.path_first.is_empty()
                                {
                                    *path = format!("{}:{path}", confined.path_first.join(":"));
                                }
                                command.env.extend(confined.env);
                                online = confined.online;
                                (Some(confined.hold), None)
                            }
                            Err(why) => (None, Some(why)),
                        }
                    }
                };
                (hold, problem, false, false)
            }
        };
        if problem.is_some() {
            // Never started unconfined: a program that can't be found.
            command.program = String::new();
        }
        let label = format!("{}/{}", server.plugin, server.name);
        // Allowed outside the sandbox is never `contained`, whatever the machine's sandbox says.
        let contained = !outside && hold.is_some() && shell.contains(dir);
        let made = Arc::new(Server {
            plugin: server.plugin.clone(),
            name: server.name.clone(),
            hash: plugin.install.hash.clone(),
            client: McpClient::new(McpConfig::stdio(&label, command, CALL_TIMEOUT)),
            tools: Mutex::new(None),
            problem: Mutex::new(problem),
            _hold: hold,
            contained,
            sealed: contained && !online && !injects,
            outside,
            waiting,
            effects: server
                .effects
                .iter()
                .filter_map(|(tool, said)| {
                    spade_core::effect::Effect::declared(said).map(|e| (tool.clone(), e))
                })
                .collect(),
        });
        if let Some(old) = map.insert(key, made.clone()) {
            old.client.close();
        }
        made
    }

    /// Starts and lists `server` if its tools have not been listed yet.
    pub(super) async fn start(server: &Arc<Server>) {
        // One waiting for the person is never started: it has no command to run.
        if server.waiting {
            return;
        }
        if lock(&server.tools).is_none() && !server.client.gave_up() {
            server.list().await;
        }
    }

    /// The bot's servers whose tools are listed.
    pub(super) fn listed(&self, agent: &str) -> Vec<Arc<Server>> {
        let mut servers: Vec<Arc<Server>> = lock(&self.map)
            .iter()
            .filter(|((a, _, _), server)| a == agent && lock(&server.tools).is_some())
            .map(|(_, server)| server.clone())
            .collect();
        servers.sort_by(|a, b| (&a.plugin, &a.name).cmp(&(&b.plugin, &b.name)));
        servers
    }

    pub(super) fn state(&self, agent: &str, plugin: &str, name: &str) -> ServerState {
        let key = (agent.to_owned(), plugin.to_owned(), name.to_owned());
        let Some(server) = lock(&self.map).get(&key).cloned() else {
            return ServerState {
                name: name.to_owned(),
                state: "not_started",
                tools: 0,
                problem: None,
                outside_sandbox: false,
            };
        };
        let state = if server.waiting {
            "waiting_for_you"
        } else if server.client.gave_up() {
            "failed"
        } else if server.client.process_id().is_some() {
            "running"
        } else if lock(&server.tools).is_some() {
            "stopped"
        } else {
            "not_started"
        };
        ServerState {
            name: name.to_owned(),
            state,
            tools: lock(&server.tools).as_ref().map_or(0, Vec::len),
            problem: lock(&server.problem).clone(),
            outside_sandbox: server.outside,
        }
    }
}

impl super::Plugins {
    /// Starts `agent`'s local servers that have not listed their tools yet, so a tool search
    /// finds them. Called before the bot's tool searches and calls.
    pub async fn start_servers(&self, agent: &str) {
        self.refresh().await;
        let plugins = self.for_agent(agent);
        if plugins.is_empty() {
            return;
        }
        let Some(dir) = self.workspace_dir(agent) else {
            return;
        };
        let env = self.shell.environment(&dir);
        let mut servers = Vec::new();
        for plugin in &plugins {
            for local in super::view::usable(plugin, false).local {
                servers.push(self.servers.server(
                    agent,
                    plugin,
                    &local,
                    &dir,
                    env.clone(),
                    &Starting {
                        shell: &self.shell,
                        consents: &self.outside,
                    },
                ));
            }
        }
        futures_util::future::join_all(servers.iter().map(Servers::start)).await;
    }

    /// Whether `agent` has any local server to start.
    pub fn has_servers(&self, agent: &str) -> bool {
        self.for_agent(agent)
            .iter()
            .any(|plugin| !super::view::usable(plugin, false).local.is_empty())
    }

    /// `agent`'s servers whose tools are listed, for its tool search.
    pub fn listed(&self, agent: &str) -> Vec<Arc<Server>> {
        self.servers.listed(agent)
    }
}

/// A plugin tool's name as offered: `<plugin>__<tool>`, with anything a provider would refuse in
/// a tool name (only letters, digits, `_` and `-`, at most 64) made `_`.
pub fn tool_name(plugin: &str, tool: &str) -> String {
    format!("{plugin}__{tool}")
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .take(64)
        .collect()
}

pub use crate::tools::PluginTools;

/// What a server is started through: the bots' shell (and its sandbox), and the person's answers
/// for servers the sandbox can't seal off.
pub(super) struct Starting<'a> {
    pub shell: &'a crate::workspace::shell::Shell,
    pub consents: &'a super::outside::Outside,
}

use crate::workspace::shell::{Confined, Confinement};

/// What a server's confinement means for starting it (ADR 0167 Windows hardening, review round 3
/// item 1): run plain (no sandbox applies), wrap in the sandbox, or refuse with a problem. A run
/// that needs review, or a sandbox that should hold the server but can't, is a refusal — a plugin
/// server is never launched unconfined behind the daemon's back.
enum ServerPlan {
    Plain,
    Wrap(Box<Confined>),
    Refuse(String),
}

fn server_plan(confinement: Result<Confinement, String>) -> ServerPlan {
    match confinement {
        Ok(Confinement::None) => ServerPlan::Plain,
        Ok(Confinement::Contained(confined)) => ServerPlan::Wrap(confined),
        Ok(Confinement::NeedsReview(reason)) => ServerPlan::Refuse(reason),
        Err(why) => ServerPlan::Refuse(why),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_server_that_needs_review_or_fails_to_confine_is_refused_not_launched() {
        // No sandbox applies: the server runs as today.
        assert!(matches!(
            server_plan(Ok(Confinement::None)),
            ServerPlan::Plain
        ));
        // A run that can't be contained must not launch unconfined — it is refused.
        assert!(matches!(
            server_plan(Ok(Confinement::NeedsReview(
                "needs your folders".to_owned()
            ))),
            ServerPlan::Refuse(_)
        ));
        // A sandbox that should hold it but errored is also a refusal.
        assert!(matches!(
            server_plan(Err("the sandbox could not start".to_owned())),
            ServerPlan::Refuse(_)
        ));
    }
}
