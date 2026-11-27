// SPDX-License-Identifier: Apache-2.0
//! A table-driven [`PlanPorts`] for the installer planner's tests.

use std::collections::{BTreeMap, BTreeSet};

use crate::command::InstallAction;
use crate::plan::{Env, InstallTarget, PlanPorts, ProviderInstallPlan};

#[derive(Default)]
pub struct FakePorts {
    /// Command name to the path `find_executable` answers.
    pub executables: BTreeMap<String, String>,
    /// `"<path> <args...>"` to the stdout a successful probe prints.
    pub outputs: BTreeMap<String, String>,
    pub writable: BTreeSet<String>,
    pub realpaths: BTreeMap<String, String>,
    pub settings: BTreeMap<String, String>,
    pub binary_paths: BTreeMap<String, String>,
    pub registry: Option<ProviderInstallPlan>,
}

impl FakePorts {
    pub fn with(mut self, name: &str, path: &str) -> FakePorts {
        self.executables.insert(name.into(), path.into());
        self
    }

    pub fn output(mut self, command: &str, args: &str, stdout: &str) -> FakePorts {
        self.outputs.insert(
            format!("{command} {args}").trim_end().to_string(),
            stdout.into(),
        );
        self
    }

    pub fn allow_writable(mut self, path: &str) -> FakePorts {
        self.writable.insert(path.into());
        self
    }

    pub fn resolves(mut self, path: &str, to: &str) -> FakePorts {
        self.realpaths.insert(path.into(), to.into());
        self
    }
}

impl PlanPorts for FakePorts {
    fn find_executable(&self, command: &str, _env: &Env) -> Option<String> {
        self.executables.get(command).cloned()
    }

    fn probe(&self, command: &str, args: &[&str]) -> Option<String> {
        let key = format!("{command} {}", args.join(" "))
            .trim_end()
            .to_string();
        self.outputs.get(&key).cloned()
    }

    fn writable(&self, path: &str) -> bool {
        self.writable.contains(path)
    }

    fn realpath(&self, path: &str) -> Option<String> {
        self.realpaths
            .get(path)
            .cloned()
            .or_else(|| Some(path.to_string()))
    }

    fn read_settings(&self, path: &str) -> Option<String> {
        self.settings.get(path).cloned()
    }

    fn binary_path(&self, provider: ace_protocol::generated::ProviderKind) -> Option<String> {
        self.binary_paths.get(&format!("{provider}")).cloned()
    }

    fn registry_plan(
        &self,
        _target: &InstallTarget,
        _action: InstallAction,
    ) -> Option<ProviderInstallPlan> {
        self.registry.clone()
    }
}
