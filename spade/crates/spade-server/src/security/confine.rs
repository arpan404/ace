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
        let (path_first, mut env) = toolchains::env(&toolchain_dirs, &|p: &Path| p.is_dir());
        env.push((
            "TMPDIR".to_owned(),
            policy.temp.to_string_lossy().into_owned(),
        ));
        if let Some(ticket) = &ticket {
            env.extend(ticket.env());
        }
        let runner = self.runner.clone();
        Ok(Some(Confined {
            launch: Box::new(move |program, args| {
                runner
                    .wrap(&policy, program, args)
                    .map(|launch| (launch.program, launch.args))
                    .map_err(|error| format!("the sandbox could not start: {error}"))
            }),
            env,
            path_first,
            hold: Box::new(ticket),
        }))
    }

    fn contains(&self, home: &Path) -> bool {
        self.bot_of(home).is_some() && Security::contains(self)
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
