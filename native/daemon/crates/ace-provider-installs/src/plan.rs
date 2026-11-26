// SPDX-License-Identifier: Apache-2.0
//! Which reviewed command installs, updates or removes a provider's CLI on this computer, from
//! `apps/daemon/src/provider-install/planner.ts`. Every filesystem and process fact arrives
//! through [`PlanPorts`], so the decisions are testable without a real computer.

use std::collections::BTreeMap;

use ace_protocol::generated::ProviderKind;
use serde::Serialize;

use crate::command::{
    InstallAction, InstallCommand, InstallMethod, InstallerExecutables, install_command,
    installer_commands,
};
use crate::manifest::{Brew, InstallAgent, Installer, installer};
use crate::prerequisite::registry_prerequisites;
use crate::release::{brew_name, claude_channel};

pub type Env = BTreeMap<String, String>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Platform {
    Macos,
    Linux,
    Windows,
    Other,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Host {
    pub platform: Platform,
    pub arch: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InstallTarget {
    pub provider: ProviderKind,
    pub agent: Option<InstallAgent>,
    pub acp_agent_id: Option<String>,
}

impl InstallTarget {
    pub fn new(provider: ProviderKind) -> InstallTarget {
        InstallTarget {
            provider,
            agent: None,
            acp_agent_id: None,
        }
    }
}

/// Only the target's own fields: a plan built from a whole request would carry its `type` or
/// `requestId`, and clients refuse such a plan.
pub fn install_target(target: &InstallTarget) -> InstallTarget {
    InstallTarget {
        provider: target.provider,
        agent: target.agent,
        acp_agent_id: target.acp_agent_id.clone(),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum InstallStatus {
    Ready,
    Manual,
    SignIn,
    Unavailable,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallPrerequisite {
    pub name: String,
    pub source_url: String,
}

/// The registry's own reviewed plan for one agent, as `@ace/protocol` carries it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryPlan {
    pub runtime: String,
    pub acp_agent_id: String,
    pub version: String,
    pub source: String,
    pub destination: String,
    pub argv: Vec<String>,
    pub verification: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInstallPlan {
    pub provider: ProviderKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub acp_agent_id: Option<String>,
    pub action: InstallAction,
    pub status: InstallStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub method: Option<InstallMethod>,
    pub methods: Vec<InstallMethod>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub registry_plan: Option<RegistryPlan>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prerequisite: Option<InstallPrerequisite>,
    pub commands: Vec<InstallCommand>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verify: Option<InstallCommand>,
    pub source_url: String,
    pub needs_admin: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installed_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlanError {
    /// An agent was named for a provider that has no registry installation.
    InvalidRegistryTarget,
    /// A non-registry method was asked for a registry installation.
    InvalidRegistryInstaller,
}

/// Every fact the planner needs from the computer. The daemon's shell implements it with real
/// processes and files; tests implement it with a table.
pub trait PlanPorts {
    fn find_executable(&self, command: &str, env: &Env) -> Option<String>;
    fn find_opencode_executable(&self, command: &str, env: &Env) -> Option<String> {
        self.find_executable(command, env)
    }
    /// A command's stdout when it exits 0, else `None`.
    fn probe(&self, command: &str, args: &[&str]) -> Option<String>;
    fn writable(&self, path: &str) -> bool;
    fn realpath(&self, path: &str) -> Option<String>;
    /// A settings file's text; `None` when it is absent or unreadable.
    fn read_settings(&self, path: &str) -> Option<String>;
    fn binary_path(&self, _provider: ProviderKind) -> Option<String> {
        None
    }
    fn registry_plan(
        &self,
        _target: &InstallTarget,
        _action: InstallAction,
    ) -> Option<ProviderInstallPlan> {
        None
    }
}

pub struct InstallEnvironment<'a> {
    pub env: &'a Env,
    pub home: String,
    pub host: Host,
    /// Claude Code's managed settings file, which outranks the person's own settings.
    pub claude_managed_settings: Option<String>,
    pub ports: &'a dyn PlanPorts,
}

/// Where Claude Code reads organization-managed settings on each platform.
fn managed_claude_settings(platform: Platform) -> Option<&'static str> {
    match platform {
        Platform::Macos => Some("/Library/Application Support/ClaudeCode/managed-settings.json"),
        Platform::Linux => Some("/etc/claude-code/managed-settings.json"),
        Platform::Windows => Some("C:\\Program Files\\ClaudeCode\\managed-settings.json"),
        Platform::Other => None,
    }
}

fn normalize(path: &str) -> String {
    path.replace('\\', "/").trim_end_matches('/').to_string()
}

pub(crate) fn join(base: &str, rest: &str) -> String {
    let base = normalize(base);
    let rest = rest.trim_start_matches('/');
    if base.is_empty() {
        rest.to_string()
    } else {
        format!("{base}/{rest}")
    }
}

fn dirname(path: &str) -> String {
    let normalized = normalize(path);
    match normalized.rfind('/') {
        Some(0) => "/".to_string(),
        Some(at) => normalized[..at].to_string(),
        None => ".".to_string(),
    }
}

fn within(path: &str, root: &str) -> bool {
    let path = normalize(path);
    let root = normalize(root);
    path == root || path.starts_with(&format!("{root}/"))
}

/// A version as the TypeScript's `parseVersion` reads it: the leading semver of a version line,
/// with the CLIs' own name prefixes and ANSI control sequences removed.
pub fn parse_version(text: &str) -> Option<String> {
    let clean = strip_ansi(text).trim().to_string();
    let lower = clean.to_ascii_lowercase();
    let prefixes = [
        "codex-cli ",
        "agy ",
        "antigravity cli ",
        "antigravity ",
        "opencode ",
        "opencode version ",
        "pi ",
        "pi version ",
        "gemini ",
        "gemini version ",
        "qwen ",
        "qwen version ",
        "claude-agent-acp ",
        "claude-agent-acp version ",
        "codex-acp ",
        "codex-acp version ",
        "goose ",
        "goose version ",
        "auggie ",
        "auggie version ",
    ];
    let mut rest = clean.as_str();
    for prefix in prefixes {
        if lower.starts_with(prefix) {
            rest = &clean[prefix.len()..];
            break;
        }
    }
    let rest = rest.strip_prefix('v').unwrap_or(rest);
    let bytes = rest.as_bytes();
    let mut end = 0;
    let mut dots = 0;
    for byte in bytes {
        if byte.is_ascii_digit() || (*byte == b'.' && dots < 2) {
            if *byte == b'.' {
                dots += 1;
            }
            end += 1;
        } else {
            break;
        }
    }
    let version = &rest[..end];
    let parts: Vec<&str> = version.split('.').collect();
    (parts.len() == 3
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit())))
    .then(|| version.to_string())
}

fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(character) = chars.next() {
        if character == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for next in chars.by_ref() {
                    if next.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            continue;
        }
        out.push(character);
    }
    out
}

pub struct InstallPlanner<'a> {
    environment: InstallEnvironment<'a>,
}

impl<'a> InstallPlanner<'a> {
    pub fn new(environment: InstallEnvironment<'a>) -> InstallPlanner<'a> {
        InstallPlanner { environment }
    }

    pub fn env(&self) -> &Env {
        self.environment.env
    }

    pub fn ports(&self) -> &dyn PlanPorts {
        self.environment.ports
    }

    pub fn home(&self) -> String {
        self.environment.home.clone()
    }

    pub fn platform(&self) -> Platform {
        self.environment.host.platform
    }

    pub fn host(&self) -> &Host {
        &self.environment.host
    }

    /// Claude Code's release channel when it is `stable`: managed settings first, then the
    /// person's own. Its updater follows that channel, so ace checks and installs the same one.
    pub fn claude_channel(&self) -> Option<&'static str> {
        let config_dir = self
            .environment
            .env
            .get("CLAUDE_CONFIG_DIR")
            .cloned()
            .unwrap_or_else(|| join(&self.environment.home, ".claude"));
        let managed_path = self
            .environment
            .claude_managed_settings
            .clone()
            .or_else(|| {
                managed_claude_settings(self.environment.host.platform).map(str::to_string)
            });
        let managed = managed_path
            .as_deref()
            .and_then(|path| self.environment.ports.read_settings(path));
        let own = self
            .environment
            .ports
            .read_settings(&join(&config_dir, "settings.json"));
        let channel = claude_channel(managed.as_deref()).or_else(|| claude_channel(own.as_deref()));
        (channel == Some("stable")).then_some("stable")
    }

    fn probe(&self, command: &str, args: &[&str]) -> Option<String> {
        self.environment.ports.probe(command, args)
    }

    fn executable(&self, provider: ProviderKind, command: &str) -> Option<String> {
        if command.is_empty() {
            return None;
        }
        if provider == ProviderKind::Opencode {
            return self
                .environment
                .ports
                .find_opencode_executable(command, self.environment.env);
        }
        self.environment
            .ports
            .find_executable(command, self.environment.env)
    }

    fn roots(&self) -> (Option<String>, Option<String>, Option<String>) {
        let npm = self
            .environment
            .ports
            .find_executable("npm", self.environment.env);
        let bun = self
            .environment
            .ports
            .find_executable("bun", self.environment.env);
        let brew = self
            .environment
            .ports
            .find_executable("brew", self.environment.env);
        (
            npm.and_then(|npm| self.probe(&npm, &["root", "-g"]))
                .map(|root| root.trim().to_string()),
            brew.and_then(|brew| self.probe(&brew, &["--prefix"]))
                .map(|prefix| prefix.trim().to_string()),
            bun.and_then(|bun| self.probe(&bun, &["pm", "bin", "-g"]))
                .map(|bin| bin.trim().to_string()),
        )
    }

    pub fn plan(
        &self,
        requested_target: &InstallTarget,
        action: InstallAction,
        requested: Option<InstallMethod>,
    ) -> Result<ProviderInstallPlan, PlanError> {
        let target = install_target(requested_target);
        if target.acp_agent_id.is_some() && target.provider != ProviderKind::Acp {
            return Err(PlanError::InvalidRegistryTarget);
        }
        if target.provider == ProviderKind::Antigravity || target.acp_agent_id.is_some() {
            if requested.is_some_and(|method| method != InstallMethod::Registry) {
                return Err(PlanError::InvalidRegistryInstaller);
            }
            return Ok(
                match self.environment.ports.registry_plan(&target, action) {
                    Some(plan) => registry_prerequisites(&plan, self),
                    None => ProviderInstallPlan {
                        provider: target.provider,
                        agent: target.agent.map(|agent| agent.as_str().to_string()),
                        acp_agent_id: target.acp_agent_id.clone(),
                        action,
                        status: InstallStatus::Unavailable,
                        method: None,
                        methods: Vec::new(),
                        registry_plan: None,
                        prerequisite: None,
                        commands: Vec::new(),
                        verify: None,
                        source_url: "https://antigravity.google/docs/ide/extensions/zed".into(),
                        needs_admin: false,
                        installed_version: None,
                        message: Some(
                            "The agent catalog is unavailable. Reconnect and try Install again."
                                .into(),
                        ),
                    },
                },
            );
        }
        let listed = installer(target.provider, target.agent);
        let channel = if listed.is_some_and(|spec| spec.manual.is_none())
            && target.provider == ProviderKind::Claude
        {
            self.claude_channel()
        } else {
            None
        };
        let spec = listed.map(|mut spec| {
            spec.channel = channel;
            spec
        });
        let base = ProviderInstallPlan {
            provider: target.provider,
            agent: target.agent.map(|agent| agent.as_str().to_string()),
            acp_agent_id: target.acp_agent_id.clone(),
            action,
            status: InstallStatus::Unavailable,
            method: None,
            methods: Vec::new(),
            registry_plan: None,
            prerequisite: None,
            commands: Vec::new(),
            verify: None,
            source_url: spec
                .map(|spec| spec.source_url.to_string())
                .unwrap_or_else(|| "https://agentclientprotocol.com/get-started/agents".into()),
            needs_admin: false,
            installed_version: None,
            message: None,
        };
        let Some(mut spec) = spec else {
            return Ok(ProviderInstallPlan {
                message: Some(
                    "Choose a reviewed ACP agent. Custom registry commands cannot be installed by this API."
                        .into(),
                ),
                ..base
            });
        };
        if let Some(manual) = spec.manual {
            return Ok(ProviderInstallPlan {
                status: if target.provider == ProviderKind::Cursor {
                    InstallStatus::SignIn
                } else {
                    InstallStatus::Manual
                },
                message: Some(manual.to_string()),
                ..base
            });
        }
        let find = |name: &str| {
            self.environment
                .ports
                .find_executable(name, self.environment.env)
        };
        let npm_candidate = find("npm");
        let bun = find("bun");
        let brew = find("brew");
        let curl = find("curl");
        let bash = find("bash");
        let rm = find("rm");
        let node = find("node");
        let binary = self.executable(
            target.provider,
            &self
                .environment
                .ports
                .binary_path(target.provider)
                .unwrap_or_else(|| spec.binary.to_string()),
        );
        let node_version = node
            .as_deref()
            .and_then(|node| parse_version(&self.probe(node, &["--version"]).unwrap_or_default()));
        let npm = match node_version.as_deref() {
            Some(version) => {
                let parts: Vec<u64> = version
                    .split('.')
                    .map(|part| part.parse().unwrap_or(0))
                    .collect();
                let major = spec.node_major.unwrap_or(16) as u64;
                let minor = spec.node_minor.unwrap_or(0) as u64;
                if parts.first().copied().unwrap_or(0) > major
                    || (parts.first().copied().unwrap_or(0) == major
                        && parts.get(1).copied().unwrap_or(0) >= minor)
                {
                    npm_candidate.clone()
                } else {
                    None
                }
            }
            None => None,
        };
        let (mut npm_root, mut brew_prefix, mut bun_bin) = self.roots();
        let resolved = binary
            .as_deref()
            .and_then(|binary| self.environment.ports.realpath(binary))
            .or_else(|| binary.clone());
        let mut existing = resolved.as_deref().and_then(|resolved| {
            self.detect(
                &spec,
                resolved,
                binary.as_deref().unwrap_or(resolved),
                &npm_root,
                &brew_prefix,
                &bun_bin,
            )
        });
        // A failed manager probe is inconclusive while the CLI is still present.
        if resolved.is_some() && existing.is_none() {
            let again = self.roots();
            npm_root = again.0.clone().or(npm_root);
            brew_prefix = again.1.clone().or(brew_prefix);
            bun_bin = again.2.clone().or(bun_bin);
            existing = resolved.as_deref().and_then(|resolved| {
                self.detect(
                    &spec,
                    resolved,
                    binary.as_deref().unwrap_or(resolved),
                    &npm_root,
                    &brew_prefix,
                    &bun_bin,
                )
            });
        }
        // Update the Homebrew package the binary came from (`claude-code` or `claude-code@latest`).
        let installed_formula = spec
            .brew
            .zip(resolved.as_deref())
            .and_then(|(formula, path)| {
                let name = brew_name(Some(formula), Some(path))?;
                let name = reviewed_brew_name(&name)?;
                Some(Brew { name, ..formula })
            });
        if let Some(formula) = installed_formula {
            spec.brew = Some(formula);
        }
        let mut methods: Vec<InstallMethod> = Vec::new();
        if spec.package.is_some()
            && (npm.is_some() || (action == InstallAction::Uninstall && npm_candidate.is_some()))
        {
            methods.push(InstallMethod::Npm);
        }
        if spec.bun && bun.is_some() {
            methods.push(InstallMethod::Bun);
        }
        if spec.brew.is_some() && brew.is_some() {
            methods.push(InstallMethod::Brew);
        }
        if spec.script.is_some() && curl.is_some() && bash.is_some() {
            methods.push(InstallMethod::Script);
        }
        let installed_version = binary
            .as_deref()
            .and_then(|binary| parse_version(&self.probe(binary, &["--version"])?));
        let result = ProviderInstallPlan {
            methods: methods.clone(),
            installed_version,
            ..base
        };
        if binary.is_some() && existing.is_none() {
            return Ok(ProviderInstallPlan {
                status: InstallStatus::Manual,
                message: Some(
                    "The existing binary's installation method is unknown. Manage it through its original installer to avoid a duplicate."
                        .into(),
                ),
                ..result
            });
        }
        if existing.is_some() && requested.is_some() && existing != requested {
            return Ok(ProviderInstallPlan {
                message: Some("Use the existing installation method to avoid a duplicate.".into()),
                ..result
            });
        }
        if (action == InstallAction::Update || action == InstallAction::Uninstall)
            && binary.is_none()
        {
            return Ok(ProviderInstallPlan {
                message: Some("This CLI is not installed.".into()),
                ..result
            });
        }
        let brew_prefix_path = brew_prefix.as_deref().map(normalize);
        if npm.is_none()
            && spec.package.is_some()
            && brew.is_some()
            && brew_prefix_path.is_some()
            && action != InstallAction::Uninstall
            && ((binary.is_none() && methods.is_empty()) || existing == Some(InstallMethod::Npm))
        {
            let prefix = brew_prefix_path.as_deref().unwrap_or_default();
            let brew_path = brew.as_deref().unwrap_or_default();
            let npm_path = join(prefix, "bin/npm");
            let verify_path = join(prefix, &format!("bin/{}", spec.binary));
            let method = existing.unwrap_or(InstallMethod::Brew);
            let mut commands = vec![install_command(brew_path, &["install", "node"])];
            commands.extend(installer_commands(
                &spec,
                action,
                InstallMethod::Npm,
                InstallerExecutables {
                    npm: Some(&npm_path),
                    ..Default::default()
                },
                &self.environment.home,
            ));
            return Ok(ProviderInstallPlan {
                status: InstallStatus::Ready,
                method: Some(method),
                methods: vec![method],
                prerequisite: Some(node_prerequisite()),
                commands,
                verify: Some(install_command(&verify_path, &["--version"])),
                needs_admin: !self.environment.ports.writable(prefix),
                message: Some("Node.js and npm will be installed first using Homebrew.".into()),
                ..result
            });
        }
        if spec.package.is_some()
            && npm.is_none()
            && action != InstallAction::Uninstall
            && ((methods.is_empty() && binary.is_none()) || existing == Some(InstallMethod::Npm))
        {
            return Ok(ProviderInstallPlan {
                prerequisite: Some(node_prerequisite()),
                message: Some(
                    "Install Node.js from its official download. It includes npm. Then retry Install here."
                        .into(),
                ),
                ..result
            });
        }
        if methods.is_empty() && spec.brew.is_some() {
            return Ok(ProviderInstallPlan {
                prerequisite: Some(InstallPrerequisite {
                    name: "Homebrew".into(),
                    source_url: "https://brew.sh".into(),
                }),
                message: Some(
                    "This installer needs Homebrew. Install it using its official setup, which may require administrator approval, then retry here."
                        .into(),
                ),
                ..result
            });
        }
        let method = requested.or(existing).or_else(|| methods.first().copied());
        if method.is_none()
            || !method.is_some_and(|method| methods.contains(&method))
            || existing.is_some_and(|existing| Some(existing) != method)
        {
            return Ok(ProviderInstallPlan {
                message: Some(
                    "Use the existing installation method. Its package manager must be available on PATH."
                        .into(),
                ),
                ..result
            });
        }
        let method = method.unwrap_or(InstallMethod::Npm);
        let script_destination = (method == InstallMethod::Script)
            .then_some(spec.script_home)
            .flatten()
            .map(|script_home| join(&self.environment.home, script_home));
        let verify_path = binary
            .clone()
            .or(script_destination)
            .unwrap_or_else(|| spec.binary.to_string());
        let selected = ProviderInstallPlan {
            method: Some(method),
            verify: Some(install_command(&verify_path, &["--version"])),
            ..result
        };
        if method == InstallMethod::Script
            && action == InstallAction::Uninstall
            && spec.script_uninstall.is_empty()
        {
            return Ok(ProviderInstallPlan {
                status: InstallStatus::Manual,
                message: Some(
                    "The vendor does not document an automatic uninstall for this script installation. Follow the official source instructions."
                        .into(),
                ),
                ..selected
            });
        }
        let commands = installer_commands(
            &spec,
            action,
            method,
            InstallerExecutables {
                npm: npm.as_deref().or(if action == InstallAction::Uninstall {
                    npm_candidate.as_deref()
                } else {
                    None
                }),
                bun: bun.as_deref(),
                brew: brew.as_deref(),
                curl: curl.as_deref(),
                bash: bash.as_deref(),
                rm: rm.as_deref(),
            },
            &self.environment.home,
        );
        let destination = match method {
            InstallMethod::Npm => npm_root.clone(),
            InstallMethod::Bun => bun_bin.clone(),
            InstallMethod::Brew => brew_prefix.clone(),
            _ => Some(dirname(&verify_path)),
        };
        if commands.is_empty() {
            return Ok(ProviderInstallPlan {
                message: Some("Required installer executable is unavailable.".into()),
                ..selected
            });
        }
        let mut destinations: Vec<String> = destination.into_iter().collect();
        if let (InstallMethod::Npm, Some(root)) = (method, npm_root.as_deref()) {
            destinations.push(join(&dirname(&dirname(root)), "bin"));
            if let (Some(binary), Some(package)) = (binary.as_deref(), spec.package) {
                destinations.push(join(root, package));
                destinations.push(dirname(binary));
            }
        }
        if let Some(resolved) = resolved.as_deref() {
            destinations.push(dirname(resolved));
        }
        let needs_admin = destinations.is_empty()
            || destinations
                .iter()
                .any(|path| !self.environment.ports.writable(path));
        Ok(ProviderInstallPlan {
            status: InstallStatus::Ready,
            commands,
            needs_admin,
            message: needs_admin.then(|| {
                "This location requires administrator access. Ask the person to approve and run these commands in an ace terminal tab. ace never runs sudo."
                    .to_string()
            }),
            ..selected
        })
    }

    fn detect(
        &self,
        spec: &Installer,
        path: &str,
        link: &str,
        npm_root: &Option<String>,
        brew_prefix: &Option<String>,
        bun_bin: &Option<String>,
    ) -> Option<InstallMethod> {
        if let (Some(formula), Some(prefix)) = (spec.brew, brew_prefix.as_deref()) {
            let names = std::iter::once(formula.name).chain(formula.alternates.iter().copied());
            for name in names {
                let short = name.rsplit('/').next().unwrap_or(name);
                for directory in ["Cellar", "Caskroom"] {
                    if within(path, &join(prefix, &format!("{directory}/{short}"))) {
                        return Some(InstallMethod::Brew);
                    }
                }
            }
        }
        let under_npm = match (spec.package, npm_root.as_deref()) {
            (Some(package), Some(root)) => within(path, &join(root, package)),
            _ => false,
        };
        if under_npm {
            return Some(InstallMethod::Npm);
        }
        if let (true, Some(bin), Some(package)) = (spec.bun, bun_bin.as_deref(), spec.package) {
            let install_root = join(
                &dirname(bin),
                &format!("install/global/node_modules/{package}"),
            );
            if within(link, bin) || within(path, &install_root) {
                return Some(InstallMethod::Bun);
            }
        }
        if spec
            .script_home
            .is_some_and(|script_home| normalize(link) == join(&self.environment.home, script_home))
        {
            return Some(InstallMethod::Script);
        }
        None
    }

    /// Whether the plan's verify command now finds the CLI (or, after an uninstall, that it and
    /// the provider's binary are both gone).
    pub fn verify(&self, plan: &ProviderInstallPlan) -> Option<String> {
        let verify = plan.verify.as_ref()?;
        let path = self.executable(plan.provider, &verify.command);
        if plan.action == InstallAction::Uninstall {
            let spec = installer(
                plan.provider,
                plan.agent.as_deref().and_then(InstallAgent::parse),
            );
            let remaining = spec.and_then(|spec| self.executable(plan.provider, spec.binary));
            return (path.is_none() && remaining.is_none()).then(|| "removed".to_string());
        }
        let read = |candidate: &str| {
            parse_version(
                &self
                    .probe(candidate, &borrowed(&verify.args))
                    .unwrap_or_default(),
            )
        };
        path.as_deref().and_then(read).or_else(|| {
            self.executable(plan.provider, &verify.command)
                .as_deref()
                .and_then(read)
        })
    }
}

fn borrowed(values: &[String]) -> Vec<&str> {
    values.iter().map(String::as_str).collect()
}

pub(crate) fn home_join(home: &str, rest: &str) -> String {
    join(home, rest)
}

fn node_prerequisite() -> InstallPrerequisite {
    InstallPrerequisite {
        name: "Node.js".into(),
        source_url: "https://nodejs.org/en/download".into(),
    }
}

/// The reviewed Homebrew name a resolved formula maps to, so the plan stays static data.
fn reviewed_brew_name(name: &str) -> Option<&'static str> {
    for spec in [
        crate::manifest::CODEX,
        crate::manifest::CLAUDE,
        crate::manifest::OPENCODE,
        crate::manifest::GEMINI,
        crate::manifest::GOOSE,
    ] {
        if let Some(formula) = spec.brew {
            if formula.name == name {
                return Some(formula.name);
            }
            if let Some(alternate) = formula
                .alternates
                .iter()
                .copied()
                .find(|entry| *entry == name)
            {
                return Some(alternate);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::FakePorts;

    fn env() -> Env {
        let mut env = Env::new();
        env.insert("HOME".into(), "/Users/dev".into());
        env
    }

    fn planner<'a>(env: &'a Env, ports: &'a FakePorts) -> InstallPlanner<'a> {
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

    fn node_22_18() -> FakePorts {
        FakePorts::default()
            .with("node", "/usr/local/bin/node")
            .with("npm", "/usr/local/bin/npm")
            .output("/usr/local/bin/node", "--version", "v22.18.0")
            .output(
                "/usr/local/bin/npm",
                "root -g",
                "/usr/local/lib/node_modules",
            )
            .allow_writable("/usr/local/lib/node_modules")
            .allow_writable("/usr/local/bin")
    }

    // apps/daemon/src/provider-install/planner.process.test.ts
    // "Pi with an older Node offers the official prerequisite instead of starting npm"
    #[test]
    fn pi_with_an_older_node_offers_the_official_prerequisite_instead_of_starting_npm() {
        let env = env();
        let ports = node_22_18();
        let plan = planner(&env, &ports)
            .plan(
                &InstallTarget::new(ProviderKind::Pi),
                InstallAction::Install,
                None,
            )
            .expect("valid target");
        assert_eq!(plan.status, InstallStatus::Unavailable);
        assert_eq!(
            plan.prerequisite
                .as_ref()
                .map(|prerequisite| prerequisite.name.as_str()),
            Some("Node.js")
        );
        assert!(plan.commands.is_empty());
    }

    // "Homebrew installs a missing Node prerequisite before Pi and verifies the resulting CLI"
    #[test]
    fn homebrew_installs_a_missing_node_prerequisite_before_pi() {
        let env = env();
        let ports = FakePorts::default()
            .with("brew", "/opt/homebrew/bin/brew")
            .output("/opt/homebrew/bin/brew", "--prefix", "/opt/homebrew\n")
            .output("/opt/homebrew/bin/brew", "pm bin -g", "")
            .allow_writable("/opt/homebrew");
        let plan = planner(&env, &ports)
            .plan(
                &InstallTarget::new(ProviderKind::Pi),
                InstallAction::Install,
                None,
            )
            .expect("valid target");
        assert_eq!(plan.status, InstallStatus::Ready);
        assert_eq!(plan.method, Some(InstallMethod::Brew));
        assert_eq!(
            plan.prerequisite
                .as_ref()
                .map(|prerequisite| prerequisite.name.as_str()),
            Some("Node.js")
        );
        assert_eq!(
            plan.commands[0].display,
            "/opt/homebrew/bin/brew install node"
        );
        assert_eq!(
            plan.commands[1].display,
            "/opt/homebrew/bin/npm install -g --ignore-scripts @earendil-works/pi-coding-agent@latest"
        );
        assert!(!plan.needs_admin);
    }

    // "Codex installed by Bun updates that installation instead of reporting an unknown installer"
    #[test]
    fn codex_installed_by_bun_updates_that_installation() {
        let env = env();
        let ports = FakePorts::default()
            .with("bun", "/Users/dev/.bun/bin/bun")
            .with("codex", "/Users/dev/.bun/bin/codex")
            .output(
                "/Users/dev/.bun/bin/bun",
                "pm bin -g",
                "/Users/dev/.bun/bin",
            )
            .output("/Users/dev/.bun/bin/codex", "--version", "codex-cli 1.0.0")
            .resolves(
                "/Users/dev/.bun/bin/codex",
                "/Users/dev/.bun/install/global/node_modules/@openai/codex/bin/codex",
            )
            .allow_writable("/Users/dev/.bun/bin");
        let plan = planner(&env, &ports)
            .plan(
                &InstallTarget::new(ProviderKind::Codex),
                InstallAction::Update,
                None,
            )
            .expect("valid target");
        assert_eq!(plan.status, InstallStatus::Ready);
        assert_eq!(plan.method, Some(InstallMethod::Bun));
        assert_eq!(plan.installed_version.as_deref(), Some("1.0.0"));
        assert_eq!(
            plan.commands[0].args,
            ["install", "-g", "--trust", "@openai/codex"]
        );
    }

    // "the existing binary's installation method is unknown"
    #[test]
    fn an_existing_binary_of_unknown_origin_is_manual() {
        let env = env();
        let ports = FakePorts::default()
            .with("codex", "/somewhere/else/codex")
            .with("npm", "/usr/local/bin/npm")
            .with("node", "/usr/local/bin/node")
            .output("/usr/local/bin/node", "--version", "v24.0.0")
            .output(
                "/usr/local/bin/npm",
                "root -g",
                "/usr/local/lib/node_modules",
            )
            .output("/somewhere/else/codex", "--version", "1.0.0");
        let plan = planner(&env, &ports)
            .plan(
                &InstallTarget::new(ProviderKind::Codex),
                InstallAction::Install,
                None,
            )
            .expect("valid target");
        assert_eq!(plan.status, InstallStatus::Manual);
        assert_eq!(
            plan.message.as_deref(),
            Some(
                "The existing binary's installation method is unknown. Manage it through its original installer to avoid a duplicate."
            )
        );
    }

    #[test]
    fn asking_for_another_method_than_the_installed_one_is_refused() {
        let env = env();
        let ports = FakePorts::default()
            .with("npm", "/usr/local/bin/npm")
            .with("node", "/usr/local/bin/node")
            .with(
                "codex",
                "/usr/local/lib/node_modules/@openai/codex/bin/codex",
            )
            .output("/usr/local/bin/node", "--version", "v24.0.0")
            .output(
                "/usr/local/bin/npm",
                "root -g",
                "/usr/local/lib/node_modules",
            )
            .allow_writable("/usr/local/lib/node_modules")
            .allow_writable("/usr/local/bin");
        let plan = planner(&env, &ports)
            .plan(
                &InstallTarget::new(ProviderKind::Codex),
                InstallAction::Update,
                Some(InstallMethod::Brew),
            )
            .expect("valid target");
        assert_eq!(
            plan.message.as_deref(),
            Some("Use the existing installation method to avoid a duplicate.")
        );
    }

    // "an update is offered only once this computer's binary is published" / "This CLI is not installed."
    #[test]
    fn an_update_for_a_cli_that_is_not_installed_says_so() {
        let env = env();
        let ports = node_22_18();
        let plan = planner(&env, &ports)
            .plan(
                &InstallTarget::new(ProviderKind::Codex),
                InstallAction::Update,
                None,
            )
            .expect("valid target");
        assert_eq!(plan.message.as_deref(), Some("This CLI is not installed."));
    }

    // "Claude on the stable channel is checked and updated on stable unless managed settings say latest"
    #[test]
    fn claudes_stable_channel_is_read_from_the_persons_settings() {
        let env = env();
        let mut ports = FakePorts::default()
            .with("brew", "/opt/homebrew/bin/brew")
            .with(
                "claude",
                "/opt/homebrew/Caskroom/claude-code/2.1.311/claude",
            )
            .output("/opt/homebrew/bin/brew", "--prefix", "/opt/homebrew")
            .output(
                "/opt/homebrew/Caskroom/claude-code/2.1.311/claude",
                "--version",
                "2.1.311 (Claude Code)",
            )
            .output("/opt/homebrew/bin/brew", "pm bin -g", "")
            .allow_writable("/opt/homebrew");
        ports.settings.insert(
            "/Users/dev/.claude/settings.json".into(),
            r#"{"autoUpdatesChannel":"stable"}"#.into(),
        );
        let plan = planner(&env, &ports)
            .plan(
                &InstallTarget::new(ProviderKind::Claude),
                InstallAction::Update,
                None,
            )
            .expect("valid target");
        assert_eq!(plan.method, Some(InstallMethod::Brew));
        assert_eq!(plan.commands[0].args, ["upgrade", "--cask", "claude-code"]);
    }

    #[test]
    fn a_registry_agent_id_belongs_only_to_acp_targets() {
        let env = env();
        let ports = FakePorts::default();
        let target = InstallTarget {
            provider: ProviderKind::Codex,
            agent: None,
            acp_agent_id: Some("official:gemini".into()),
        };
        assert_eq!(
            planner(&env, &ports).plan(&target, InstallAction::Install, None),
            Err(PlanError::InvalidRegistryTarget)
        );
    }
}
