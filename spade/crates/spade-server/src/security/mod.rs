//! Spade's security boundaries on the server (ADR 0167; spade/docs/security.md): the machine's
//! sandbox and egress proxy, each bot's network policy, toolchains and grants, and how a bot's
//! command is confined. The policy and launch logic is in `spade-sandbox` and `spade_core::grant`;
//! this holds the person's settings and joins them to each run.

pub mod attest;
pub mod checkpoints;
mod confine;
pub mod grants;
pub mod read_only;
pub mod settings;
pub mod toolchains;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use spade_core::autonomy::Mode;
use spade_core::grant::{self, Grant, Scope};
use spade_sandbox::Runner;
use spade_sandbox::egress::{EgressLog, Entry, NetworkPolicy, Proxy, SystemResolver};
use spade_store::Store;

pub use settings::{BotSecurity, Commands, Effective, MachineSecurity};

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
    /// The key the daemon stamps the person's own changes with (`attest::KEY_FILE` in ace's
    /// home); `None` takes no stamp, so nothing raises a bot to Full access.
    pub person_key: Option<PathBuf>,
}

/// Why a change was refused.
#[derive(Debug, thiserror::Error)]
pub enum SecurityError {
    #[error("there is no such bot")]
    NotFound,
    /// Only the person may make this change, and the request doesn't carry their say.
    #[error("{0}")]
    PersonOnly(&'static str),
    #[error("{0}")]
    Invalid(String),
    #[error("the settings could not be saved: {0}")]
    Store(String),
}

/// A network policy with each addition's form checked and every dropped name a default.
fn checked(mut policy: NetworkPolicy) -> Result<NetworkPolicy, SecurityError> {
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
    Ok(policy)
}

fn reserved(maintenance: &Mutex<std::collections::HashSet<String>>, bot: &str) -> bool {
    maintenance
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .contains(bot)
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
    /// Bots whose workspace is reserved for maintenance (a restore): no turn starts, no command
    /// runs and no file tool writes until it is released.
    maintenance: Arc<Mutex<std::collections::HashSet<String>>>,
    /// The person's stamps on changes only they may make.
    attestor: attest::Attestor,
}

/// A bot's workspace held for maintenance; released when dropped.
pub struct Reservation {
    maintenance: Arc<Mutex<std::collections::HashSet<String>>>,
    bot: String,
}

impl Drop for Reservation {
    fn drop(&mut self) {
        self.maintenance
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&self.bot);
    }
}

/// Why work that waits for a reservation doesn't run now.
pub const RESERVED: &str = "the bot's workspace is being restored from a checkpoint";

impl Security {
    /// The service, with the egress proxy listening when this machine has a sandbox.
    pub async fn start(setup: Setup) -> Arc<Self> {
        let log = Arc::new(EgressLog::new(setup.log_dir));
        // Windows: take back any AppContainer ACLs a crashed run left behind before anything runs
        // (ADR 0167, ACL hygiene). Each run re-applies its own; this only undoes stale grants.
        #[cfg(windows)]
        spade_sandbox::windows::acls::recover(&setup.spade_data.join("sandbox-acls"));
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
            maintenance: Arc::default(),
            attestor: attest::Attestor::new(setup.person_key),
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
            "bots": self.machine(),
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

    /// The machine's defaults, which bots without their own inherit (ADR 0171).
    pub fn machine(&self) -> MachineSecurity {
        settings::read(
            self.store
                .setting(settings::MACHINE)
                .ok()
                .flatten()
                .as_deref(),
        )
    }

    /// What holds for a bot: its own settings over the machine's.
    pub fn effective(&self, bot: &str) -> Effective {
        settings::effective(&self.bot(bot), &self.machine())
    }

    /// How the bot decides (ADR 0163, amendment 2): its own setting over its parent's or the
    /// machine's, never freer than a bot above it.
    pub fn autonomy(&self, bot: &str) -> Mode {
        let mut chain = self.above(bot);
        chain.push(self.bot(bot));
        settings::autonomy(&chain, self.machine().autonomy)
    }

    /// The settings of the bots above `bot`, the top one first.
    fn above(&self, bot: &str) -> Vec<BotSecurity> {
        let mut chain: Vec<BotSecurity> = self
            .ancestors(bot)
            .iter()
            .map(|above| self.bot(above))
            .collect();
        chain.reverse();
        chain
    }

    /// Sets how the bot decides; `None` follows its parent's or the machine's. A change that
    /// puts the bot in Full access is the person's alone: it needs their stamp (`stamp`, from
    /// ace's daemon, `attest`), and records that they confirmed it. Going back to the
    /// auto-review never does.
    pub fn set_autonomy(
        &self,
        bot: &str,
        mode: Option<Mode>,
        stamp: Option<&str>,
    ) -> Result<BotSecurity, SecurityError> {
        let above = self.above(bot);
        self.change(bot, |current| {
            let machine = self.machine().autonomy;
            let with = |own: Option<Mode>| {
                let mut chain = above.clone();
                chain.push(BotSecurity {
                    autonomy: own,
                    ..BotSecurity::default()
                });
                settings::autonomy(&chain, machine)
            };
            let raises = mode == Some(Mode::FullAccess)
                || (with(mode) == Mode::FullAccess && with(current.autonomy) != Mode::FullAccess);
            if raises {
                let value = mode.map_or("null", Mode::name);
                if !self.attestor.person(stamp, bot, value, self.clock.now_ms()) {
                    return Err(SecurityError::PersonOnly(attest::PERSON_ONLY));
                }
                current.full_access_confirmed = true;
            }
            current.autonomy = mode;
            Ok(())
        })
    }

    /// Whether `stamp` is the person's say on `target` becoming `value` (ADR 0163 amendment 2,
    /// `attest`); a good stamp is used up. Accepting a bot moved here asks this (ADR 0187).
    pub fn person_says(&self, stamp: Option<&str>, target: &str, value: &str) -> bool {
        self.attestor
            .person(stamp, target, value, self.clock.now_ms())
    }

    /// Sets how bots without their own setting decide; Full access needs the person's stamp.
    pub fn set_machine_autonomy(
        &self,
        mode: Mode,
        stamp: Option<&str>,
    ) -> Result<MachineSecurity, SecurityError> {
        if mode == Mode::FullAccess
            && !self
                .attestor
                .person(stamp, "machine", mode.name(), self.clock.now_ms())
        {
            return Err(SecurityError::PersonOnly(attest::PERSON_ONLY));
        }
        self.change_machine(|machine| machine.autonomy = mode)
    }

    /// Whether the bot runs its commands outside the sandbox.
    pub fn outside(&self, bot: &str) -> bool {
        self.effective(bot).commands == Commands::Outside
    }

    /// Changes the machine's defaults.
    pub fn change_machine(
        &self,
        apply: impl FnOnce(&mut MachineSecurity),
    ) -> Result<MachineSecurity, SecurityError> {
        let _held = self.changing.lock().unwrap_or_else(|p| p.into_inner());
        let mut current = self.machine();
        apply(&mut current);
        let text = serde_json::to_string(&current)
            .map_err(|error| SecurityError::Store(error.to_string()))?;
        self.store
            .set_setting(settings::MACHINE, Some(&text))
            .map_err(|error| SecurityError::Store(error.to_string()))?;
        Ok(current)
    }

    /// Sets where the bot's commands run; `None` follows the machine.
    pub fn set_commands(
        &self,
        bot: &str,
        commands: Option<Commands>,
    ) -> Result<BotSecurity, SecurityError> {
        self.change(bot, |current| {
            current.commands = commands;
            Ok(())
        })
    }

    /// Sets one of the machine's network policies, checking each addition's form.
    pub fn set_machine_network(
        &self,
        which: Network,
        policy: NetworkPolicy,
    ) -> Result<MachineSecurity, SecurityError> {
        let policy = checked(policy)?;
        self.change_machine(|machine| match which {
            Network::Commands => machine.network = policy,
            Network::Plugins => machine.plugin_network = policy,
        })
    }

    /// Takes away a bot's own network policy, so it follows the machine's.
    pub fn inherit_network(&self, bot: &str, which: Network) -> Result<BotSecurity, SecurityError> {
        self.change(bot, |current| {
            match which {
                Network::Commands => current.network = None,
                Network::Plugins => current.plugin_network = None,
            }
            Ok(())
        })
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
        policy: NetworkPolicy,
    ) -> Result<BotSecurity, SecurityError> {
        let policy = checked(policy)?;
        self.change(bot, |current| {
            match which {
                Network::Commands => current.network = Some(policy),
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
    /// Answers the folder as it really is (links resolved): what is stored and compared.
    fn check_folder(&self, path: &str) -> Result<String, SecurityError> {
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
        Ok(real.to_string_lossy().into_owned())
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
        // Refused by what the tool declares it does (ADR 0171), never by its name.
        let engine = self.bots.get();
        let conversation = engine
            .as_ref()
            .and_then(|engine| engine.agent_view(bot).ok().flatten())
            .map(|view| view.agent.conversation);
        let never = |tool: &str| {
            let (engine, conversation) = (engine.as_ref()?, conversation.as_deref()?);
            spade_core::effect::never_granted(engine.tool_effect(conversation, tool))
        };
        grant::check(&scope, &never).map_err(SecurityError::Invalid)?;
        // A folder is kept as the folder it names, never as a link to it.
        let scope = match scope {
            Scope::Folder { path, write } => Scope::Folder {
                path: self.check_folder(&path)?,
                write,
            },
            other => other,
        };
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
        let owns: Vec<Vec<Grant>> = chain.iter().map(|m| self.bot(m).grants).collect();
        // Folders are compared as they resolve now, so one that became a link out is dropped.
        grants::narrowed(&owns, &|path: &str| {
            spade_sandbox::policy::real(Path::new(path))
                .to_string_lossy()
                .into_owned()
        })
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
        // Windows: take back every run's AppContainer ACLs for this bot and delete its profiles.
        #[cfg(windows)]
        spade_sandbox::windows::acls::forget(&self.acl_dir(), bot);
    }

    /// Where the Windows ACL journal lives (ADR 0167, ACL hygiene).
    #[cfg(windows)]
    pub(crate) fn acl_dir(&self) -> PathBuf {
        self.spade_data.join("sandbox-acls")
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

    /// Reserves `bot`'s workspace for maintenance; `None` when it already is.
    pub fn reserve(&self, bot: &str) -> Option<Reservation> {
        let mut held = self.maintenance.lock().unwrap_or_else(|p| p.into_inner());
        held.insert(bot.to_owned()).then(|| Reservation {
            maintenance: self.maintenance.clone(),
            bot: bot.to_owned(),
        })
    }

    /// Whether `bot`'s workspace is reserved for maintenance now.
    pub fn reserved(&self, bot: &str) -> bool {
        reserved(&self.maintenance, bot)
    }

    /// What must happen before work nobody reviews (a contained command or file write): the
    /// workspace not reserved, and a checkpoint of it when one is due (at most once a minute).
    /// Blocking work for the caller to run first; its error means the work must not run
    /// unreviewed.
    pub fn before_unreviewed(&self, bot: &str) -> Box<dyn FnOnce() -> Result<(), String> + Send> {
        let workspace = self.workspaces.join(bot);
        let (checkpoints, maintenance) = (self.checkpoints.clone(), self.maintenance.clone());
        let (id, now, bot) = (self.ids.next("cp"), self.clock.now_ms(), bot.to_owned());
        Box::new(move || {
            if reserved(&maintenance, &bot) {
                return Err(RESERVED.to_owned());
            }
            if !workspace.is_dir() || !checkpoints.due(&bot, now) {
                return Ok(());
            }
            checkpoints
                .take(&bot, &workspace, &id, now, "auto")
                .map(|_| ())
                .map_err(|error| {
                    format!("a checkpoint of the workspace couldn't be taken: {error}")
                })
        })
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
