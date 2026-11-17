//! The person's plugins in tests (ADR 0151): a stand-in for ace's daemon, plugins and hooks as
//! ace answers them, a bot allowed some, and a sandbox that can't seal any plugin off (as Windows
//! can't one with network, ADR 0167).

use std::collections::BTreeSet;
use std::path::Path;
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use spade_ace::plugins::{Installed, SpadePlugin};
use spade_server::plugins::{BoxFuture, Daemon};
use spade_server::workspace::shell::{Confine, Confinement, Kind};

use super::{Options, Result, Spade};

/// Stands in for ace's daemon: accepted plugins, and which are turned off in ace.
#[derive(Default)]
pub struct FakeAce {
    pub plugins: Mutex<Vec<SpadePlugin>>,
    off: Mutex<BTreeSet<String>>,
    /// The accepted plugins' files, by `<plugin>/<path>`.
    files: Mutex<std::collections::BTreeMap<String, Vec<u8>>>,
}

impl FakeAce {
    pub fn with(plugins: Vec<SpadePlugin>) -> Arc<Self> {
        Arc::new(Self {
            plugins: Mutex::new(plugins),
            ..Self::default()
        })
    }

    pub fn with_file(self: Arc<Self>, plugin: &str, path: &str, bytes: &[u8]) -> Arc<Self> {
        self.files
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(format!("{plugin}/{path}"), bytes.to_vec());
        self
    }

    pub fn turn_off(&self, name: &str) {
        self.off
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(name.to_owned());
    }

    pub fn replace(&self, plugin: SpadePlugin) {
        let mut plugins = self.plugins.lock().unwrap_or_else(|p| p.into_inner());
        plugins.retain(|p| p.install.name != plugin.install.name);
        plugins.push(plugin);
    }

    pub fn enabled(&self, name: &str) -> bool {
        !self
            .off
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .contains(name)
    }
}

impl Daemon for FakeAce {
    fn installed(&self) -> BoxFuture<'_, std::result::Result<Vec<Installed>, String>> {
        let plugins = self
            .plugins
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        Box::pin(async move {
            Ok(plugins
                .into_iter()
                .map(|p| Installed {
                    enabled: self.enabled(&p.install.name),
                    install: p.install,
                })
                .collect())
        })
    }

    fn plugin<'a>(
        &'a self,
        name: &'a str,
    ) -> BoxFuture<'a, std::result::Result<SpadePlugin, String>> {
        let found = self
            .plugins
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .iter()
            .find(|p| p.install.name == name)
            .cloned();
        Box::pin(async move {
            let mut plugin = found.ok_or("Plugin not installed")?;
            plugin.enabled = self.enabled(name);
            Ok(plugin)
        })
    }

    fn file<'a>(
        &'a self,
        name: &'a str,
        path: &'a str,
    ) -> BoxFuture<'a, std::result::Result<Vec<u8>, String>> {
        let found = self
            .files
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(&format!("{name}/{path}"))
            .cloned();
        Box::pin(
            async move { found.ok_or_else(|| "Not a file of this plugin's skills".to_owned()) },
        )
    }
}

/// A plugin as ace answers `plugins.spade`, its folder `root`.
pub fn plugin(
    name: &str,
    hash: &str,
    root: &str,
    components: Value,
    executions: Value,
) -> SpadePlugin {
    let value = json!({
        "install": { "name": name, "version": "1.0", "commit": "c".repeat(40), "hash": hash,
                     "acceptedAt": 1 },
        "enabled": true, "root": root, "components": components, "executions": executions,
        "unsupported": [],
    });
    serde_json::from_value(value).unwrap_or_else(|e| panic!("{e}"))
}

pub fn hook(event: &str, command: &str, matcher: Option<&str>) -> Value {
    let mut hook = json!({ "kind": "hook", "event": event, "command": command });
    if let Some(matcher) = matcher {
        hook["matcher"] = json!(matcher);
    }
    hook
}

pub fn options(ace: Arc<FakeAce>) -> Options {
    Options {
        plugins: Some(ace),
        ..Options::default()
    }
}

/// A bot the person allowed `plugins`; its id and conversation.
pub async fn bot(spade: &Spade, name: &str, plugins: &[&str]) -> Result<(String, String)> {
    let agent = spade.new_agent(name, "").await?;
    let id = agent["id"].as_str().unwrap_or_default().to_owned();
    let conversation = agent["conversation"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let (status, body) = spade
        .put(
            &format!("/v1/agents/{id}/plugins"),
            json!({ "plugins": plugins }),
        )
        .await?;
    assert_eq!(status, 200, "{body}");
    Ok((id, conversation))
}

pub fn of_type<'a>(events: &'a [Value], kind: &str) -> Vec<&'a Value> {
    events.iter().filter(|e| e["type"] == kind).collect()
}

/// Waits for `count` events of `kind` with no deadline shorter than the hooks need.
pub async fn wait(spade: &Spade, id: &str, kind: &str, count: usize) -> Result<Vec<Value>> {
    spade.wait_for_count(id, kind, count).await
}

/// A sandbox that can't seal off any plugin's run, as Windows can't one with network: every plugin
/// server or hook would need review. The bots' own commands aren't affected.
pub struct CantSealPlugins;

impl Confine for CantSealPlugins {
    fn confine(&self, _home: &Path, kind: &Kind) -> std::result::Result<Confinement, String> {
        Ok(match kind {
            Kind::Plugin { .. } => {
                Confinement::NeedsReview(spade_sandbox::windows::NETWORK_REVIEW.to_owned())
            }
            _ => Confinement::None,
        })
    }

    fn contains(&self, _home: &Path) -> bool {
        false
    }

    fn review(&self, _home: &Path, kind: &Kind) -> Option<String> {
        matches!(kind, Kind::Plugin { .. })
            .then(|| spade_sandbox::windows::NETWORK_REVIEW.to_owned())
    }
}

pub fn cant_seal(ace: Arc<FakeAce>) -> Options {
    Options {
        plugin_confine: Some(Arc::new(CantSealPlugins)),
        ..options(ace)
    }
}

/// The open requests to run a plugin outside the sandbox in `events`.
pub fn outside_asks(events: &[Value]) -> Vec<&Value> {
    let answered: Vec<&Value> = of_type(events, "plugin_outside_answered")
        .into_iter()
        .map(|e| &e["id"])
        .collect();
    of_type(events, "plugin_outside_asked")
        .into_iter()
        .filter(|e| !answered.contains(&&e["id"]))
        .collect()
}

pub async fn answer_outside(spade: &Spade, chat: &str, id: &str, always: bool) -> Result<u16> {
    let (status, _) = spade
        .post(
            &format!("/v1/conversations/{chat}/plugin_outside/{id}"),
            json!({ "allowed": true, "always": always }),
        )
        .await?;
    Ok(status)
}
