//! How one of a bot's runs is confined (ADR 0167 decision 1): its policy from the person's
//! settings and the bot's effective grants, a proxy ticket for its traffic, and the sandbox's
//! launch. The shell asks through [`Confine`].

use std::path::{Path, PathBuf};

use spade_core::grant::Scope;
use spade_sandbox::egress::Mode;
use spade_sandbox::{Facts, Policy};

use super::{Security, toolchains};
use crate::workspace::shell::{Confine, Confined, Kind};

impl Confine for Security {
    fn confine(&self, home: &Path, kind: &Kind) -> Result<Option<Confined>, String> {
        let Some(bot) = self.bot_of(home) else {
            return Ok(None);
        };
        // No sandbox on this machine: commands run as before, and stay reviewed (decision 9).
        if !self.runner.status().usable() {
            return Ok(None);
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
        let run = self.ids.next("run");
        let ticket = match (&self.proxy, network.mode) {
            (Some(proxy), Mode::AllowList | Mode::Open) => Some(proxy.open(&bot, &run, network)),
            _ => None,
        };
        // The person's own folders this run would need, kept before the policy consumes them, so
        // Windows can decide whether the run is containable (it must change no ACLs on them).
        #[cfg(windows)]
        let consented_paths: Vec<PathBuf> = folders.iter().map(|(path, _)| path.clone()).collect();
        #[cfg(windows)]
        let plugin_root: Option<PathBuf> = match kind {
            Kind::Plugin { root } => Some(root.clone()),
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
        // Windows reports `contained` only for runs that touch no ACLs on the person's folders
        // (ADR 0167 narrowing). A run that needs a consented folder or a toolchain under the home
        // keeps the review path, unconfined — Spade asks first.
        #[cfg(windows)]
        {
            use spade_sandbox::policy::real;
            let real_all = |paths: &[PathBuf]| paths.iter().map(|p| real(p)).collect::<Vec<_>>();
            let plugin_real = plugin_root.as_ref().map(|p| real(p));
            if !spade_sandbox::windows::containable(
                &real_all(&consented_paths),
                &real_all(&toolchain_dirs),
                plugin_real.as_deref(),
                &real(&self.spade_data),
                &real(&self.home),
            ) {
                return Ok(None);
            }
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
                    .map_err(|error| format!("the sandbox could not start: {error}"))
            })
        };
        #[cfg(not(windows))]
        let launch: crate::workspace::shell::Launcher = Box::new(move |program, args| {
            runner
                .wrap(&policy, program, args)
                .map(|launch| (launch.program, launch.args))
                .map_err(|error| format!("the sandbox could not start: {error}"))
        });

        // Windows: when the run ends (its processes gone, so no open handle survives revocation),
        // the hold stops the bridge and takes back the run's ACL grants and its profile.
        #[cfg(windows)]
        let hold: Box<dyn std::any::Any + Send + Sync> = Box::new((
            ticket,
            bridge_hold,
            RunHold {
                acl_dir: self.acl_dir(),
                container,
            },
        ));
        #[cfg(not(windows))]
        let hold: Box<dyn std::any::Any + Send + Sync> = Box::new(ticket);

        Ok(Some(Confined {
            launch,
            env,
            path_first,
            hold,
        }))
    }

    fn contains(&self, home: &Path) -> bool {
        let Some(bot) = self.bot_of(home) else {
            return false;
        };
        if !Security::contains(self) {
            return false;
        }
        // Windows contains a run only when it touches no ACLs on the person's folders (a consented
        // folder or a toolchain under the home folder sends it to review instead).
        #[cfg(windows)]
        {
            self.windows_containable(&bot)
        }
        #[cfg(not(windows))]
        {
            let _ = bot;
            true
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
        Some(self.before_unreviewed(&self.bot_of(home)?))
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

#[cfg(windows)]
impl Security {
    /// Whether this bot's commands can be contained on Windows: it has no consented folders and no
    /// toolchain under the person's home folder, so Spade changes no ACLs on the person's folders.
    /// A run that needs them keeps the review path. Plugin folders are checked per run in `confine`.
    pub(crate) fn windows_containable(&self, bot: &str) -> bool {
        use spade_sandbox::policy::real;
        let consented: Vec<PathBuf> = self
            .effective_grants(bot)
            .into_iter()
            .filter_map(|grant| match grant.scope {
                Scope::Folder { path, .. } => Some(PathBuf::from(path)),
                _ => None,
            })
            .map(|path| real(&path))
            .collect();
        let toolchains: Vec<PathBuf> = self
            .bot(bot)
            .toolchains
            .iter()
            .map(|path| real(Path::new(path)))
            .collect();
        spade_sandbox::windows::containable(
            &consented,
            &toolchains,
            None,
            &real(&self.spade_data),
            &real(&self.home),
        )
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
