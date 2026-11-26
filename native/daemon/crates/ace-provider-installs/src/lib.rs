// SPDX-License-Identifier: Apache-2.0
//! Installing and updating the provider CLIs: the reviewed allowlist, the commands they run,
//! and the plan that picks one, ported from `@ace/provider-kit/installers` and the daemon's
//! provider-install planner. The planner takes every filesystem and process fact through a
//! port, so the daemon supplies the only shell and nothing here spawns a provider.

pub mod command;
pub mod manifest;
pub mod plan;
pub mod prerequisite;
pub mod release;
#[cfg(test)]
pub mod testing;

pub use command::{InstallAction, InstallCommand, InstallMethod};
pub use manifest::{InstallAgent, Installer, installer};
pub use plan::{
    InstallPlanner, InstallPrerequisite, InstallStatus, InstallTarget, PlanError, PlanPorts,
    ProviderInstallPlan, RegistryPlan, install_target,
};
