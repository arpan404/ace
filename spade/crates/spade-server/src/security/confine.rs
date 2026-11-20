//! How one of a bot's runs is confined (ADR 0167 decision 1): its policy from the person's
//! settings and the bot's effective grants, a proxy ticket for its traffic, and the sandbox's
//! launch. The shell asks through [`Confine`].

use std::path::{Path, PathBuf};

use spade_core::grant::Scope;
use spade_sandbox::egress::Mode;
use spade_sandbox::{Facts, Policy};

use super::{Security, toolchains};
use crate::workspace::shell::{Confine, Confined, Confinement, Kind};

impl Security {
    /// Whether `bot` is held by a package's ceiling that leaves out `network`.
    pub(crate) fn reaches_nothing(&self, bot: &str) -> bool {
        self.bots
            .get()
            .and_then(|engine| engine.bot_ceiling(bot))
            .is_some_and(|(_, allows)| !allows.has(spade_core::effect::Effect::Network))
    }
}

impl Confine for Security {
    fn confine(&self, home: &Path, kind: &Kind) -> Result<Confinement, String> {
        let Some(bot) = self.bot_of(home) else {
            return Ok(Confinement::None);
        };
        // No sandbox on this machine: commands run as before, and stay reviewed (decision 9).
        if !self.runner.status().usable() {
            return Ok(Confinement::None);
        }
        let settings = self.bot(&bot);
        let held = self.effective(&bot);
        let folders: Vec<(PathBuf, bool)> = self
            .effective_grants(&bot)
            .into_iter()
            .filter_map(|grant| match grant.scope {
                Scope::Folder { path, write } => Some((PathBuf::from(path), write)),
                _ => None,
            })
            .collect();
        let toolchain_dirs: Vec<PathBuf> = settings.toolchains.iter().map(PathBuf::from).collect();
        let (network, also_read, scratch) = match kind {
            Kind::Command => (held.network, Vec::new(), Vec::new()),
            Kind::Terminal { scratch } => (held.network, Vec::new(), vec![scratch.clone()]),
            Kind::Plugin { root } => (held.plugin_network, vec![root.clone()], Vec::new()),
        };
        // Under a package's ceiling without `network`, the bot's runs reach nothing, whatever
        // its own or the machine's policy says (ADR 0200 §3.4).
        let network = if self.reaches_nothing(&bot) {
            spade_sandbox::egress::NetworkPolicy::off()
        } else {
            network
        };
        let run = self.ids.next("run");
        let ticket = match (&self.proxy, network.mode) {
            (Some(proxy), Mode::AllowList | Mode::Open) => Some(proxy.open(&bot, &run, network)),
            _ => None,
        };
        let policy = Policy::build(&Facts {
            home: self.home.clone(),
            spade_data: self.spade_data.clone(),
            ace_data: self.ace_data.clone(),
            workspace: home.to_path_buf(),
            folders,
            toolchains: toolchain_dirs.clone(),
            also_read,
            scratch,
            proxy_port: ticket
                .as_ref()
                .and(self.proxy.as_ref())
                .map(|proxy| proxy.port()),
        });
        std::fs::create_dir_all(&policy.temp).map_err(|error| {
            format!("the sandbox's temporary folder could not be made: {error}")
        })?;
        // Windows reports `contained` only for runs with no network on folders Spade owns; any
        // other run keeps the review path. Decided by the same probe the plugins ask before they
        // start (`review`), so the two never disagree.
        #[cfg(windows)]
        if let Some(line) = self.windows_review(&bot, home, kind) {
            return Ok(Confinement::NeedsReview(line.to_owned()));
        }
        // Windows: each run gets its own AppContainer identity, and its SID is granted on the
        // folders Spade owns (the workspace, temp, scratch, an owned plugin folder), journaled with
        // each object's identity before any change so a later run or a crash can take the grants
        // back (ADR 0167, ACL hygiene). Done before the launch, fail closed; a bot whose earlier
        // run's cleanup is stuck is refused here.
        #[cfg(windows)]
        let container = spade_sandbox::windows::Container::for_run(&bot, &run);
        #[cfg(windows)]
        let sid = spade_sandbox::windows::acls::reconcile(
            &self.acl_dir(),
            &bot,
            &container,
            &spade_sandbox::windows::grants(
                &policy,
                &spade_sandbox::policy::real(&self.spade_data),
            ),
        )
        .map_err(|error| format!("the sandbox's permissions could not be set: {error}"))?;
        // From here the run owns its rollback: if anything below fails (the bridge, the plan), this
        // guard drops and takes back the grants and the profile. On success it moves into `hold`
        // and cleans up when the run ends instead.
        #[cfg(windows)]
        let run_hold = RunHold {
            acl_dir: self.acl_dir(),
            container: container.clone(),
        };
        let (path_first, mut env) = toolchains::env(&toolchain_dirs, &|p: &Path| p.is_dir());
        env.push((
            "TMPDIR".to_owned(),
            policy.temp.to_string_lossy().into_owned(),
        ));
        // Windows commands read TEMP/TMP, not TMPDIR.
        #[cfg(windows)]
        for name in ["TEMP", "TMP"] {
            env.push((name.to_owned(), policy.temp.to_string_lossy().into_owned()));
        }

        // Windows reaches the proxy through a per-run egress bridge (ADR 0167 decision 3): a
        // loopback listener inside the container (`HTTP_PROXY` points at it) that forwards over a
        // named pipe to the daemon-side acceptor started here. Elsewhere the proxy is on loopback.
        #[cfg(windows)]
        let (bridge_spec, bridge_hold) = self
            .windows_bridge(&ticket, &run, &sid, &mut env)
            .map_err(|error| format!("the sandbox's network bridge could not start: {error}"))?;
        #[cfg(not(windows))]
        if let Some(ticket) = &ticket {
            env.extend(ticket.env());
        }

        let runner = self.runner.clone();
        #[cfg(windows)]
        let launch: crate::workspace::shell::Launcher = {
            let launcher = runner.launcher().map(std::path::Path::to_path_buf);
            let plan = spade_sandbox::windows::plan(
                container.clone(),
                spade_sandbox::windows::run::DEFAULT_ACTIVE_PROCESSES,
                spade_sandbox::windows::run::DEFAULT_MEMORY_BYTES,
                bridge_spec,
            );
            Box::new(move |program: &Path, args: &[std::ffi::OsString]| {
                let launcher = launcher
                    .clone()
                    .ok_or_else(|| "Spade's own program is unknown".to_owned())?;
                spade_sandbox::windows::run::wrap(&launcher, &plan, program, args)
                    .map(|(program, args)| spade_sandbox::Launch {
                        program,
                        args,
                        seals_env: false,
                    })
                    .map_err(|error| format!("the sandbox could not start: {error}"))
            })
        };
        // A plugin's server with its network off is held offline where the machine can enforce
        // it fully (ADR 0171, amendment 4): what the launch applies is what makes it sealed.
        #[cfg(not(windows))]
        let offline =
            ticket.is_none() && matches!(kind, Kind::Plugin { .. }) && self.runner.holds_offline();
        #[cfg(windows)]
        let offline = false;
        #[cfg(not(windows))]
        let launch: crate::workspace::shell::Launcher = Box::new(move |program, args| {
            let launched = if offline {
                runner.wrap_offline(&policy, program, args)
            } else {
                runner.wrap(&policy, program, args)
            };
            launched.map_err(|error| format!("the sandbox could not start: {error}"))
        });

        // Windows: when the run ends (its processes gone, so no open handle survives revocation),
        // the hold stops the bridge and takes back the run's ACL grants and its profile. The
        // rollback guard made above now becomes that run-end cleanup.
        let watch = ticket.as_ref().map(spade_sandbox::egress::Ticket::watch);
        #[cfg(windows)]
        let hold: Box<dyn std::any::Any + Send + Sync> = Box::new((ticket, bridge_hold, run_hold));
        #[cfg(not(windows))]
        let hold: Box<dyn std::any::Any + Send + Sync> = Box::new(ticket);

        Ok(Confinement::Contained(Box::new(Confined {
            launch,
            env,
            path_first,
            hold,
            watch,
            offline,
        })))
    }

    fn contains(&self, home: &Path) -> bool {
        let Some(bot) = self.bot_of(home) else {
            return false;
        };
        self.bot_containment(&bot).0
    }

    fn read_only_available(&self) -> bool {
        // A read-only settled command runs only where every boundary holds (ADR 0172, amendment
        // 7), never half-confined. Windows has no read-only profile yet, so it never advertises one.
        #[cfg(windows)]
        {
            false
        }
        #[cfg(not(windows))]
        {
            self.runner.status().contains()
        }
    }

    fn read_only_settles(&self, command: &str) -> bool {
        // The command settles only if every program it runs resolves on the clean PATH (ADR 0172,
        // amendment 7): otherwise it would fail "command not found" inside the sandbox, so it goes
        // to the reviewer instead.
        super::read_only::resolve(command, &self.home).is_some()
    }

    fn read_only(&self, home: &Path, command: &str) -> Result<Confined, String> {
        if self.bot_of(home).is_none() {
            return Err("this conversation has no bot".to_owned());
        }
        if !self.runner.status().contains() {
            return Err("this machine can't fully confine a read-only command".to_owned());
        }
        // The extra read roots and PATH folders the command's own programs need, resolved outside
        // the sandbox (Homebrew/Cargo prefixes; on macOS the active developer dir). `None` means a
        // program couldn't be resolved, so the command must not run here.
        let Some(reads) = super::read_only::resolve(command, &self.home) else {
            return Err(
                "a program this command runs could not be resolved on the clean PATH".to_owned(),
            );
        };
        // A read-only policy: the workspace and the system paths readable, nothing writable, no
        // network (ADR 0172, amendment 7). No consented folders, no proxy ticket, no scratch; the
        // resolved program roots go in `also_read`, read-only.
        let policy = Policy::build(&Facts {
            home: self.home.clone(),
            spade_data: self.spade_data.clone(),
            ace_data: self.ace_data.clone(),
            workspace: home.to_path_buf(),
            folders: Vec::new(),
            toolchains: Vec::new(),
            also_read: reads.reads,
            scratch: Vec::new(),
            proxy_port: None,
        });
        // A read-only run writes nowhere, so Spade makes no temporary folder for it. Creating one
        // before the sandbox applies would follow a symlinked `.spade` out of the folder (finding
        // 5). `TMPDIR` points at the bot's folder: it exists and is readable, so a program that
        // queries it (git, which otherwise warns about `DARWIN_USER_TEMP_DIR` and falls back to
        // `/tmp`) resolves cleanly, and the sandbox still makes it unwritable, so a program that
        // tries to write scratch fails closed rather than writing outside.
        // Read-only sandboxing of a settled command is Unix-only for now; Windows reviews it.
        #[cfg(windows)]
        {
            let _ = (policy, reads.path_first, home);
            return Err("Spade has no read-only sandbox for Windows yet".to_owned());
        }
        #[cfg(not(windows))]
        {
            let env = vec![("TMPDIR".to_owned(), home.to_string_lossy().into_owned())];
            let path_first = reads
                .path_first
                .iter()
                .map(|p| p.to_string_lossy().into_owned())
                .collect();
            let runner = self.runner.clone();
            let launch: crate::workspace::shell::Launcher = Box::new(move |program, args| {
                runner
                    .wrap_read_only(&policy, program, args)
                    .map_err(|error| format!("the sandbox could not start: {error}"))
            });
            Ok(Confined {
                launch,
                env,
                path_first,
                hold: Box::new(()),
                // No network, so nothing goes through the proxy to watch.
                watch: None,
                // A settled read-only command, not a plugin's server.
                offline: false,
            })
        }
    }

    fn review(&self, home: &Path, kind: &Kind) -> Option<String> {
        let bot = self.bot_of(home)?;
        if !self.runner.status().usable() {
            return None;
        }
        #[cfg(windows)]
        {
            self.windows_review(&bot, home, kind).map(str::to_owned)
        }
        #[cfg(not(windows))]
        {
            let _ = (bot, kind);
            None
        }
    }

    fn outside(&self, home: &Path) -> bool {
        self.bot_of(home)
            .is_some_and(|bot| Security::outside(self, &bot))
    }

    /// Before a run nobody reviews (a bot's command where the sandbox holds it): the workspace
    /// not reserved for a restore, and a checkpoint of it when one is due (ADR 0167 decision 8).
    /// Plugins' runs don't take one.
    fn before(
        &self,
        home: &Path,
        kind: &Kind,
    ) -> Option<Box<dyn FnOnce() -> Result<(), String> + Send>> {
        if matches!(kind, Kind::Plugin { .. }) || !Security::contains(self) {
            return None;
        }
        Some(self.before_unreviewed(&self.bot_of(home)?, None))
    }
}

/// Ends a run's egress-bridge acceptor when the run ends (dropped with its ticket).
#[cfg(windows)]
pub(crate) struct BridgeHold(spade_sandbox::windows::bridge::Stop);

#[cfg(windows)]
impl Drop for BridgeHold {
    fn drop(&mut self) {
        self.0.stop();
    }
}

/// Takes back a run's AppContainer grants and deletes its per-run profile when the run ends. A
/// cleanup that can't confirm a revocation leaves it pending (the bot's next run is refused until
/// it clears) and is reported, never swallowed.
#[cfg(windows)]
pub(crate) struct RunHold {
    acl_dir: PathBuf,
    container: spade_sandbox::windows::Container,
}

#[cfg(windows)]
impl Drop for RunHold {
    fn drop(&mut self) {
        if let Err(error) = spade_sandbox::windows::acls::cleanup(&self.acl_dir, &self.container) {
            tracing::warn!(
                container = %self.container.name,
                %error,
                "a sandbox run's ACL grants could not be fully taken back; the bot is held until they clear",
            );
        }
    }
}

impl Security {
    /// Whether `bot`'s commands are contained here, and when they aren't on Windows, the line the
    /// person reads for why (they keep the review path). With no sandbox on this machine they
    /// aren't contained and the machine's own status says why.
    pub fn bot_containment(&self, bot: &str) -> (bool, Option<&'static str>) {
        if !Security::contains(self) {
            return (false, None);
        }
        // Windows contains a run only with no network (a Less Privileged AppContainer) and when
        // it touches no ACLs on the person's folders (a consented folder or a toolchain under the
        // home folder sends it to review instead).
        #[cfg(windows)]
        {
            let line = self.windows_review(bot, &self.workspaces.join(bot), &Kind::Command);
            (line.is_none(), line)
        }
        #[cfg(not(windows))]
        {
            let _ = bot;
            (true, None)
        }
    }
}

#[cfg(windows)]
impl Security {
    /// The known system roots a toolchain may live in without an ACL change (readable by every app
    /// package): the Windows directory and the two Program Files folders.
    fn windows_system_roots() -> Vec<PathBuf> {
        ["SystemRoot", "ProgramFiles", "ProgramFiles(x86)"]
            .iter()
            .filter_map(std::env::var_os)
            .map(|value| spade_sandbox::policy::real(Path::new(&value)))
            .collect()
    }

    /// Why a run of `kind` for `bot` (home `home`) can't be contained on Windows, as the person
    /// reads it, or `None` when it can: with network it can't be a Less Privileged AppContainer
    /// (`WSAStartup` fails under LPAC, and as a plain AppContainer it keeps ambient app-package
    /// read access), and it must touch no ACLs on folders Spade doesn't own (ADR 0167 narrowing).
    /// No side effects: `confine` and the plugins' pre-start probe both decide with it.
    pub(crate) fn windows_review(
        &self,
        bot: &str,
        home: &Path,
        kind: &Kind,
    ) -> Option<&'static str> {
        use spade_sandbox::policy::real;
        let held = self.effective(bot);
        let network = match kind {
            Kind::Command | Kind::Terminal { .. } => &held.network,
            Kind::Plugin { .. } => &held.plugin_network,
        };
        let networked =
            self.proxy.is_some() && matches!(network.mode, Mode::AllowList | Mode::Open);
        let consented: Vec<PathBuf> = self
            .effective_grants(bot)
            .into_iter()
            .filter_map(|grant| match grant.scope {
                Scope::Folder { path, .. } => Some(real(Path::new(&path))),
                _ => None,
            })
            .collect();
        let toolchains: Vec<PathBuf> = self
            .bot(bot)
            .toolchains
            .iter()
            .map(|path| real(Path::new(path)))
            .collect();
        let scratch: Vec<PathBuf> = match kind {
            Kind::Terminal { scratch } => vec![real(scratch)],
            _ => Vec::new(),
        };
        let plugin_root = match kind {
            Kind::Plugin { root } => Some(real(root)),
            _ => None,
        };
        let workspace = real(home);
        let data = real(&self.spade_data);
        let roots = Self::windows_system_roots();
        let owned_only =
            spade_sandbox::windows::containable(&spade_sandbox::windows::Containability {
                workspace: &workspace,
                scratch: &scratch,
                consented: &consented,
                toolchains: &toolchains,
                plugin_root: plugin_root.as_deref(),
                spade_data: &data,
                system_roots: &roots,
            });
        spade_sandbox::windows::review_line(networked, owned_only)
    }

    /// Starts the daemon-side egress-bridge acceptor for this run and points the command's proxy
    /// variables at the in-container bridge's loopback port. Returns the bridge for the plan and a
    /// hold that stops the acceptor when the run ends. No ticket (network off) means no bridge, and
    /// that is fine. But when the run *does* need network, the acceptor must be confirmed listening
    /// before the run starts: a failure is reported and fails the run closed, never run silently
    /// without the boundary.
    fn windows_bridge(
        &self,
        ticket: &Option<spade_sandbox::egress::Ticket>,
        run: &str,
        sid: &spade_sandbox_windows::sid::Sid,
        env: &mut Vec<(String, String)>,
    ) -> Result<(Option<spade_sandbox::windows::Bridge>, Option<BridgeHold>), String> {
        let (Some(ticket), Some(proxy)) = (ticket, self.proxy.as_ref()) else {
            return Ok((None, None));
        };
        let port = free_loopback_port()
            .ok_or_else(|| "no free loopback port for the egress bridge".to_owned())?;
        let pipe = format!("spade-egress-{run}-{}", uuid::Uuid::new_v4().simple());
        let stop = spade_sandbox::windows::bridge::Stop::new();
        let (name, sid, proxy_port, task_stop) =
            (pipe.clone(), sid.clone(), proxy.port(), stop.clone());
        // The acceptor reports on `ready` once its first pipe instance is listening (or failed).
        let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel(1);
        tokio::spawn(async move {
            spade_sandbox::windows::bridge::serve(&name, &sid, proxy_port, &task_stop, ready_tx)
                .await;
        });
        match ready_rx.recv_timeout(std::time::Duration::from_secs(5)) {
            Ok(true) => {}
            _ => {
                stop.stop();
                return Err("the egress bridge did not come up".to_owned());
            }
        }
        env.extend(ticket.env_on(port));
        Ok((
            Some(spade_sandbox::windows::Bridge { pipe, port }),
            Some(BridgeHold(stop)),
        ))
    }
}

/// A free loopback TCP port (bound then released; a small race is tolerated and fails closed).
#[cfg(windows)]
fn free_loopback_port() -> Option<u16> {
    std::net::TcpListener::bind(("127.0.0.1", 0))
        .ok()
        .and_then(|listener| listener.local_addr().ok())
        .map(|addr| addr.port())
}
