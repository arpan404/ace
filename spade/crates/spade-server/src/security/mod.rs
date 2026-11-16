//! Spade's security boundaries on the server (ADR 0167; spade/docs/security.md): the machine's
//! sandbox and egress proxy, each bot's network policy, toolchains and grants, and how a bot's
//! command is confined. The policy and launch logic is in `spade-sandbox` and `spade_core::grant`;
//! this holds the person's settings and joins them to each run.

pub mod checkpoints;
mod confine;
pub mod settings;
pub mod toolchains;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use spade_core::grant::{self, Grant, Scope};
use spade_sandbox::Runner;
use spade_sandbox::egress::{EgressLog, Entry, NetworkPolicy, Proxy, SystemResolver};
use spade_store::Store;

pub use settings::BotSecurity;

use crate::clock::{Clock, Ids};
use crate::tools::EngineHandle;

/// What the security service is built from.
pub struct Setup {
    pub runner: Runner,
    pub store: Store,
    /// The person's home folder.
    pub home: PathBuf,
    /// Spade's data folder.
    pub spade_data: PathBuf,
    /// ace's data folder, when known.
    pub ace_data: Option<PathBuf>,
    /// The folder every bot's workspace is in.
    pub workspaces: PathBuf,
    /// Where the egress logs are kept.
    pub log_dir: PathBuf,
    pub clock: Arc<dyn Clock>,
    pub ids: Arc<dyn Ids>,
    /// The engine, for the tree grants pass down.
    pub bots: EngineHandle,
}

/// Why a change was refused.
#[derive(Debug, thiserror::Error)]
pub enum SecurityError {
    #[error("there is no such bot")]
    NotFound,
    #[error("{0}")]
    Invalid(String),
    #[error("the settings could not be saved: {0}")]
    Store(String),
}

/// Which of a bot's two network policies.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Network {
    Commands,
    Plugins,
}

pub struct Security {
    runner: Runner,
    store: Store,
    home: PathBuf,
    spade_data: PathBuf,
    ace_data: Option<PathBuf>,
    workspaces: PathBuf,
    log: Arc<EgressLog>,
    proxy: Option<Proxy>,
    /// Why the proxy isn't running, when it isn't.
    proxy_problem: Option<String>,
    ids: Arc<dyn Ids>,
    clock: Arc<dyn Clock>,
    bots: EngineHandle,
    /// One change to a bot's settings at a time.
    changing: Mutex<()>,
    checkpoints: Arc<checkpoints::Checkpoints>,
}

impl Security {
    /// The service, with the egress proxy listening when this machine has a sandbox.
    pub async fn start(setup: Setup) -> Arc<Self> {
        let log = Arc::new(EgressLog::new(setup.log_dir));
        let (proxy, proxy_problem) = if setup.runner.status().usable() {
            let clock = setup.clock.clone();
            match Proxy::start(
                log.clone(),
                Arc::new(SystemResolver),
                Arc::new(move || clock.now_ms()),
                Arc::new(|| uuid::Uuid::new_v4().simple().to_string()),
            )
            .await
            {
                Ok(proxy) => (Some(proxy), None),
                Err(error) => {
                    tracing::warn!(%error, "the egress proxy could not listen; sandboxed runs have no network");
                    (
                        None,
                        Some(format!("the egress proxy could not listen: {error}")),
                    )
                }
            }
        } else {
            (
                None,
                Some("there is no sandbox to send traffic from".to_owned()),
            )
        };
        Arc::new(Self {
            runner: setup.runner,
            store: setup.store,
            home: setup.home,
            spade_data: setup.spade_data.clone(),
            ace_data: setup.ace_data,
            workspaces: setup.workspaces,
            log,
            proxy,
            proxy_problem,
            ids: setup.ids,
            clock: setup.clock,
            bots: setup.bots,
            changing: Mutex::new(()),
            checkpoints: Arc::new(checkpoints::Checkpoints::new(
                setup.spade_data.join("checkpoints"),
            )),
        })
    }

    /// Whether a bot's run is contained here: files and network held, and the proxy listening.
    pub fn contains(&self) -> bool {
        self.runner.status().contains() && self.proxy.is_some()
    }

    /// The machine's sandbox, as Settings shows it.
    pub fn status_view(&self) -> Value {
        json!({
            "sandbox": self.runner.status(),
            "proxy": {
                "running": self.proxy.is_some(),
                "problem": self.proxy_problem,
            },
            "contained": self.contains(),
            "defaults": spade_sandbox::egress::DEFAULTS,
        })
    }

    /// The bot whose workspace is `home`, if it is one.
    fn bot_of(&self, home: &Path) -> Option<String> {
        let rest = home.strip_prefix(&self.workspaces).ok()?;
        let mut parts = rest.components();
        let only = parts.next()?.as_os_str().to_str()?.to_owned();
        let fine = parts.next().is_none()
            && !only.is_empty()
            && only
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
        fine.then_some(only)
    }

    fn exists(&self, bot: &str) -> Result<(), SecurityError> {
        match self.store.agent(bot) {
            Ok(Some(_)) => Ok(()),
            Ok(None) => Err(SecurityError::NotFound),
            Err(error) => Err(SecurityError::Store(error.to_string())),
        }
    }

    /// A bot's settings as stored (the defaults when none are).
    pub fn bot(&self, bot: &str) -> BotSecurity {
        settings::read(
            self.store
                .setting(&settings::key(bot))
                .ok()
                .flatten()
                .as_deref(),
        )
    }

    fn change(
        &self,
        bot: &str,
        apply: impl FnOnce(&mut BotSecurity) -> Result<(), SecurityError>,
    ) -> Result<BotSecurity, SecurityError> {
        let _held = self.changing.lock().unwrap_or_else(|p| p.into_inner());
        self.exists(bot)?;
        let mut current = self.bot(bot);
        apply(&mut current)?;
        let text = serde_json::to_string(&current)
            .map_err(|error| SecurityError::Store(error.to_string()))?;
        self.store
            .set_setting(&settings::key(bot), Some(&text))
            .map_err(|error| SecurityError::Store(error.to_string()))?;
        Ok(current)
    }

    /// Sets one of a bot's network policies, checking each addition's form.
    pub fn set_network(
        &self,
        bot: &str,
        which: Network,
        mut policy: NetworkPolicy,
    ) -> Result<BotSecurity, SecurityError> {
        policy.allow = policy
            .allow
            .iter()
            .map(|entry| NetworkPolicy::check_entry(entry).map_err(SecurityError::Invalid))
            .collect::<Result<_, _>>()?;
        policy.allow.dedup();
        if let Some(unknown) = policy
            .dropped
            .iter()
            .find(|d| !spade_sandbox::egress::DEFAULTS.contains(&d.as_str()))
        {
            return Err(SecurityError::Invalid(format!(
                "{unknown} is not one of the defaults"
            )));
        }
        self.change(bot, |current| {
            match which {
                Network::Commands => current.network = policy,
                Network::Plugins => current.plugin_network = Some(policy),
            }
            Ok(())
        })
    }

    /// Sets a bot's confirmed toolchains: folders that exist, outside the deny-list and Spade's
    /// data.
    pub fn set_toolchains(
        &self,
        bot: &str,
        toolchains: Vec<String>,
    ) -> Result<BotSecurity, SecurityError> {
        for path in &toolchains {
            self.check_folder(path)?;
        }
        self.change(bot, |current| {
            current.toolchains = toolchains;
            current.toolchains.dedup();
            Ok(())
        })
    }

    /// A folder the person may consent to: absolute, a real folder, not a credential place and
    /// not inside Spade's or ace's data.
    fn check_folder(&self, path: &str) -> Result<(), SecurityError> {
        let given = Path::new(path);
        if !given.is_absolute() {
            return Err(SecurityError::Invalid(format!(
                "{path} is not an absolute path"
            )));
        }
        let real = spade_sandbox::policy::real(given);
        if !real.is_dir() {
            return Err(SecurityError::Invalid(format!("{path} is not a folder")));
        }
        let ace = self
            .ace_data
            .clone()
            .unwrap_or_else(|| self.home.join(".ace"));
        let closed =
            spade_sandbox::credentials::denied(&spade_sandbox::policy::real(&self.home), &real)
                || real.starts_with(spade_sandbox::policy::real(&self.spade_data))
                || real.starts_with(spade_sandbox::policy::real(&ace))
                || real.parent().is_none();
        if closed {
            return Err(SecurityError::Invalid(format!(
                "{path} holds sign-ins or Spade's or ace's data, so it can't be granted"
            )));
        }
        Ok(())
    }

    /// The bots above `bot`, nearest first.
    fn ancestors(&self, bot: &str) -> Vec<String> {
        self.bots
            .get()
            .map(|engine| engine.agent_ancestors(bot))
            .unwrap_or_default()
    }

    /// Grants `scope` to `bot`, refused when it can never be granted or exceeds what the bot's
    /// parent has.
    pub fn add_grant(&self, bot: &str, scope: Scope, by: &str) -> Result<Grant, SecurityError> {
        grant::check(&scope, &spade_core::autonomy::never_granted)
            .map_err(SecurityError::Invalid)?;
        if let Scope::Folder { path, .. } = &scope {
            self.check_folder(path)?;
        }
        if let Some(parent) = self.ancestors(bot).first() {
            let above = self.effective_grants(parent);
            if !above.iter().any(|g| grant::within(&scope, &g.scope)) {
                return Err(SecurityError::Invalid(
                    "a worker's grant can't exceed what its parent has".to_owned(),
                ));
            }
        }
        let made = Grant {
            id: self.ids.next("gr"),
            scope,
            by: by.to_owned(),
            created_at: self.clock.now_ms(),
        };
        let kept = made.clone();
        self.change(bot, move |current| {
            if !current.grants.iter().any(|g| g.scope == kept.scope) {
                current.grants.push(kept);
            }
            Ok(())
        })?;
        Ok(made)
    }

    /// Takes a grant back; whether it was there.
    pub fn remove_grant(&self, bot: &str, id: &str) -> Result<bool, SecurityError> {
        let mut found = false;
        self.change(bot, |current| {
            let before = current.grants.len();
            current.grants.retain(|g| g.id != id);
            found = current.grants.len() != before;
            Ok(())
        })?;
        Ok(found)
    }

    /// A bot's effective grants: its own, narrowed by every bot above it (ADR 0161).
    pub fn effective_grants(&self, bot: &str) -> Vec<Grant> {
        let mut chain = self.ancestors(bot);
        chain.reverse();
        chain.push(bot.to_owned());
        let mut above: Option<Vec<Grant>> = None;
        for member in chain {
            let own = self.bot(&member).grants;
            above = Some(grant::effective(&own, above.as_deref()));
        }
        above.unwrap_or_default()
    }

    /// The bot's newest `limit` egress log entries, oldest first.
    pub fn egress(&self, bot: &str, limit: usize) -> Vec<Entry> {
        self.log.read(bot, limit)
    }

    /// Toolchains found under the person's home folder.
    pub fn toolchain_candidates(&self) -> Vec<PathBuf> {
        toolchains::detect(&self.home, &|p: &Path| p.is_dir())
    }

    /// Forgets a deleted bot's settings, log and checkpoints.
    pub fn forget(&self, bot: &str) {
        let _ = self.store.set_setting(&settings::key(bot), None);
        self.log.forget(bot);
        self.checkpoints.forget(bot);
    }

    fn workspace(&self, bot: &str) -> Result<PathBuf, SecurityError> {
        self.exists(bot)?;
        let workspace = self.workspaces.join(bot);
        if !workspace.is_dir() {
            return Err(SecurityError::Invalid(
                "the bot's workspace doesn't exist yet".to_owned(),
            ));
        }
        Ok(workspace)
    }

    /// A checkpoint of the bot's workspace to take before work nobody reviews, when one is due
    /// (at most once a minute): blocking work for the caller to run before that work starts.
    pub fn checkpoint_due(&self, bot: &str) -> Option<Box<dyn FnOnce() + Send>> {
        let workspace = self.workspaces.join(bot);
        let now = self.clock.now_ms();
        if !workspace.is_dir() || !self.checkpoints.due(bot, now) {
            return None;
        }
        let (checkpoints, id, bot) = (
            self.checkpoints.clone(),
            self.ids.next("cp"),
            bot.to_owned(),
        );
        Some(Box::new(move || {
            if let Err(error) = checkpoints.take(&bot, &workspace, &id, now, "auto") {
                tracing::warn!(%error, %bot, "a checkpoint before unreviewed work was not taken");
            }
        }))
    }

    /// The bot's checkpoints, newest first.
    pub fn checkpoints(&self, bot: &str) -> Result<Vec<checkpoints::Checkpoint>, SecurityError> {
        self.exists(bot)?;
        Ok(self.checkpoints.list(bot))
    }

    /// Takes a checkpoint of the bot's workspace now.
    pub fn take_checkpoint(
        &self,
        bot: &str,
        reason: &str,
    ) -> Result<checkpoints::Checkpoint, SecurityError> {
        let workspace = self.workspace(bot)?;
        self.checkpoints
            .take(
                bot,
                &workspace,
                &self.ids.next("cp"),
                self.clock.now_ms(),
                reason,
            )
            .map_err(|why| SecurityError::Store(format!("the checkpoint failed: {why}")))
    }

    /// Puts checkpoint `id` back in the bot's workspace, after a checkpoint of how it is now;
    /// answers that one. The caller makes sure the bot isn't working.
    pub fn restore_checkpoint(
        &self,
        bot: &str,
        id: &str,
    ) -> Result<checkpoints::Checkpoint, SecurityError> {
        let workspace = self.workspace(bot)?;
        if !self.checkpoints.list(bot).iter().any(|c| c.id == id) {
            return Err(SecurityError::NotFound);
        }
        let saved = self.take_checkpoint(bot, "before_restore")?;
        self.checkpoints
            .restore(bot, id, &workspace)
            .map_err(|why| SecurityError::Store(format!("the restore failed: {why}")))?;
        Ok(saved)
    }
}
