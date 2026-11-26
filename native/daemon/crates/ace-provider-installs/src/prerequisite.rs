// SPDX-License-Identifier: Apache-2.0
//! Bootstrapping only documented prerequisites before a registry install, from
//! `apps/daemon/src/provider-install/prerequisites.ts`.

use crate::command::{InstallMethod, install_command};
use crate::manifest::{InstallAgent, installer};
use crate::plan::{
    InstallPlanner, InstallPrerequisite, InstallStatus, ProviderInstallPlan, parse_version,
};

const NODE_PREREQUISITE: (&str, &str) = ("Node.js", "https://nodejs.org/en/download");

/// Bootstrap only documented prerequisites, then re-plan the registry install.
pub fn registry_prerequisites(
    plan: &ProviderInstallPlan,
    planner: &InstallPlanner<'_>,
) -> ProviderInstallPlan {
    let ports = planner.ports();
    let env = planner.env();
    let mut prerequisite = plan.prerequisite.clone();
    if plan
        .registry_plan
        .as_ref()
        .is_some_and(|registry| registry.runtime == "npm")
    {
        let node = ports.find_executable("node", env);
        let version = node.as_deref().and_then(|node| {
            let output = ports.probe(node, &["--version"]).unwrap_or_default();
            parse_version(output.trim_start_matches('v'))
        });
        let agent = plan
            .acp_agent_id
            .as_deref()
            .and_then(|id| id.strip_prefix("official:"))
            .and_then(InstallAgent::parse);
        let spec = agent.and_then(installer_for_agent);
        let minimum = if plan.acp_agent_id.as_deref() == Some("official:github-copilot-cli") {
            22
        } else {
            spec.unwrap_or(16)
        };
        let major = version
            .as_deref()
            .and_then(|version| version.split('.').next())
            .and_then(|major| major.parse::<u32>().ok())
            .unwrap_or(0);
        if version.is_none() || major < minimum {
            prerequisite = Some(InstallPrerequisite {
                name: NODE_PREREQUISITE.0.into(),
                source_url: NODE_PREREQUISITE.1.into(),
            });
        }
    }
    let Some(prerequisite) = prerequisite else {
        return plan.clone();
    };
    let base = ProviderInstallPlan {
        registry_plan: None,
        status: InstallStatus::Unavailable,
        prerequisite: Some(prerequisite.clone()),
        ..plan.clone()
    };
    if prerequisite.name == NODE_PREREQUISITE.0 {
        let brew = ports.find_executable("brew", env);
        let prefix = brew
            .as_deref()
            .and_then(|brew| ports.probe(brew, &["--prefix"]))
            .map(|prefix| prefix.trim().to_string())
            .filter(|prefix| !prefix.is_empty());
        if let (Some(brew), Some(prefix)) = (brew, prefix) {
            return ProviderInstallPlan {
                status: InstallStatus::Ready,
                method: Some(InstallMethod::Registry),
                methods: vec![InstallMethod::Registry],
                commands: vec![install_command(&brew, &["install", "node"])],
                needs_admin: !ports.writable(&prefix),
                message: Some("Node.js and npm will be installed first using Homebrew.".into()),
                ..base
            };
        }
        return ProviderInstallPlan {
            message: Some(
                "Install Node.js from its official download. It includes npm. Then retry Install here."
                    .into(),
            ),
            ..base
        };
    }
    if prerequisite.name != "uv" {
        return base;
    }
    let find = |name: &str| ports.find_executable(name, env);
    let (curl, bash, sh, env_command) = (find("curl"), find("bash"), find("sh"), find("env"));
    let (Some(curl), Some(bash), Some(sh), Some(env_command)) = (curl, bash, sh, env_command)
    else {
        return ProviderInstallPlan {
            message: Some("Install uv using its official setup, then retry Install here.".into()),
            ..base
        };
    };
    let destination = crate::plan::home_join(&planner.home(), ".local/bin");
    let download = install_command(&curl, &["-LsSf", "https://astral.sh/uv/install.sh"]).display;
    let install_dir = format!("UV_INSTALL_DIR={destination}");
    let run = install_command(&env_command, &[&install_dir, "UV_NO_MODIFY_PATH=1", &sh]).display;
    let pipeline = format!("{download} | {run}");
    ProviderInstallPlan {
        status: InstallStatus::Ready,
        method: Some(InstallMethod::Registry),
        methods: vec![InstallMethod::Registry],
        commands: vec![install_command(&bash, &["-o", "pipefail", "-c", &pipeline])],
        needs_admin: !ports.writable(&destination),
        message: Some("uv will be installed first using its official installer.".into()),
        ..base
    }
}

fn installer_for_agent(agent: InstallAgent) -> Option<u32> {
    installer(ace_protocol::generated::ProviderKind::Acp, Some(agent))
        .and_then(|spec| spec.node_major)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plan::{Host, InstallEnvironment, InstallTarget, Platform, RegistryPlan};
    use crate::testing::FakePorts;
    use ace_protocol::generated::ProviderKind;
    use std::collections::BTreeMap;

    fn plan(
        runtime: &str,
        agent: Option<&str>,
        prerequisite: Option<(&str, &str)>,
    ) -> ProviderInstallPlan {
        ProviderInstallPlan {
            provider: ProviderKind::Acp,
            agent: None,
            acp_agent_id: agent.map(str::to_string),
            action: crate::command::InstallAction::Install,
            status: InstallStatus::Ready,
            method: Some(InstallMethod::Registry),
            methods: vec![InstallMethod::Registry],
            registry_plan: Some(RegistryPlan {
                runtime: runtime.into(),
                acp_agent_id: agent.unwrap_or("official:gemini").into(),
                version: "1.0.0".into(),
                source: "https://example.test/agent.json".into(),
                destination: "/tmp/agent".into(),
                argv: Vec::new(),
                verification: "sha256".into(),
            }),
            prerequisite: prerequisite.map(|(name, source_url)| InstallPrerequisite {
                name: name.into(),
                source_url: source_url.into(),
            }),
            commands: Vec::new(),
            verify: None,
            source_url: "https://example.test".into(),
            needs_admin: false,
            installed_version: None,
            message: None,
        }
    }

    fn planner<'a>(env: &'a BTreeMap<String, String>, ports: &'a FakePorts) -> InstallPlanner<'a> {
        InstallPlanner::new(InstallEnvironment {
            env,
            home: "/Users/dev".into(),
            host: Host {
                platform: Platform::Macos,
                arch: "arm64".into(),
            },
            claude_managed_settings: None,
            ports,
        })
    }

    // apps/daemon/src/provider-install/prerequisites.process.test.ts
    // "Copilot requires Node 22 before its registry installation can start"
    #[test]
    fn copilot_requires_node_22_before_its_registry_installation_can_start() {
        let env = BTreeMap::new();
        let mut ports = FakePorts::default();
        ports
            .executables
            .insert("node".into(), "/usr/local/bin/node".into());
        ports
            .outputs
            .insert("/usr/local/bin/node --version".into(), "v20.11.0".into());
        let target = InstallTarget {
            provider: ProviderKind::Acp,
            agent: None,
            acp_agent_id: Some("official:github-copilot-cli".into()),
        };
        let result = registry_prerequisites(
            &plan("npm", target.acp_agent_id.as_deref(), None),
            &planner(&env, &ports),
        );
        assert_eq!(result.status, InstallStatus::Unavailable);
        assert_eq!(
            result
                .prerequisite
                .as_ref()
                .map(|value| value.name.as_str()),
            Some("Node.js")
        );
    }

    // "a registry agent installs missing uv first and verifies the agent without restarting"
    #[test]
    fn a_registry_agent_installs_missing_uv_first() {
        let env = BTreeMap::new();
        let mut ports = FakePorts::default();
        for (name, path) in [
            ("curl", "/usr/bin/curl"),
            ("bash", "/bin/bash"),
            ("sh", "/bin/sh"),
            ("env", "/usr/bin/env"),
        ] {
            ports.executables.insert(name.into(), path.into());
        }
        ports.writable.insert("/Users/dev/.local/bin".into());
        let result = registry_prerequisites(
            &plan(
                "uv",
                Some("official:gemini"),
                Some(("uv", "https://docs.astral.sh/uv/")),
            ),
            &planner(&env, &ports),
        );
        assert_eq!(result.status, InstallStatus::Ready);
        assert_eq!(result.method, Some(InstallMethod::Registry));
        assert_eq!(
            result.commands[0].display,
            "/bin/bash -o pipefail -c '/usr/bin/curl -LsSf https://astral.sh/uv/install.sh | /usr/bin/env UV_INSTALL_DIR=/Users/dev/.local/bin UV_NO_MODIFY_PATH=1 /bin/sh'"
        );
        assert!(!result.needs_admin);
    }
}
