// SPDX-License-Identifier: Apache-2.0
//! The reviewed installer allowlist and the directories vendors' own installers write to, from
//! `@ace/provider-kit/installers`. Commands and packages are never derived from a registry or a
//! client payload: only rows in this table are run.

use ace_protocol::generated::ProviderKind;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Brew {
    pub name: &'static str,
    pub cask: bool,
    /// Other names of the same package; the one installed is the one updated.
    pub alternates: &'static [&'static str],
}

#[derive(Clone, Copy, Debug)]
pub struct Installer {
    pub binary: &'static str,
    pub source_url: &'static str,
    pub package: Option<&'static str>,
    pub node_major: Option<u32>,
    pub node_minor: Option<u32>,
    pub npm_flags: &'static [&'static str],
    /// Bun can install the package globally, so an existing Bun install is updated with Bun.
    pub bun: bool,
    pub brew: Option<Brew>,
    pub script: Option<&'static str>,
    pub script_home: Option<&'static str>,
    pub script_uninstall: &'static [(&'static str, &'static str)],
    pub manual: Option<&'static str>,
    pub registry_id: Option<&'static str>,
    /// The vendor release channel to install from, when it isn't the default `latest`.
    pub channel: Option<&'static str>,
}

const NO_ALTERNATES: &[&str] = &[];
const NO_FLAGS: &[&str] = &[];
const NO_FILES: &[(&str, &str)] = &[];

pub const CODEX: Installer = Installer {
    binary: "codex",
    source_url: "https://learn.chatgpt.com/docs/codex/cli",
    package: Some("@openai/codex"),
    node_major: Some(16),
    node_minor: None,
    npm_flags: NO_FLAGS,
    bun: true,
    brew: Some(Brew {
        name: "codex",
        cask: true,
        alternates: NO_ALTERNATES,
    }),
    script: Some("https://chatgpt.com/codex/install.sh"),
    script_home: Some(SCRIPT_EXECUTABLE_PATHS[0].1),
    script_uninstall: NO_FILES,
    manual: None,
    registry_id: None,
    channel: None,
};

pub const CLAUDE: Installer = Installer {
    binary: "claude",
    source_url: "https://code.claude.com/docs/en/setup",
    package: Some("@anthropic-ai/claude-code"),
    node_major: Some(22),
    node_minor: None,
    npm_flags: NO_FLAGS,
    bun: false,
    // `claude-code` follows the stable channel, `claude-code@latest` the latest one.
    brew: Some(Brew {
        name: "claude-code",
        cask: true,
        alternates: &["claude-code@latest"],
    }),
    script: Some("https://claude.ai/install.sh"),
    script_home: Some(SCRIPT_EXECUTABLE_PATHS[1].1),
    script_uninstall: &[("-f", ".local/bin/claude"), ("-rf", ".local/share/claude")],
    manual: None,
    registry_id: None,
    channel: None,
};

pub const OPENCODE: Installer = Installer {
    binary: "opencode",
    source_url: "https://opencode.ai/v2/docs/",
    package: Some("@opencode/cli"),
    node_major: None,
    node_minor: None,
    npm_flags: &["--allow-scripts=@opencode/cli"],
    bun: true,
    brew: Some(Brew {
        name: "anomalyco/tap/opencode-v2",
        cask: false,
        alternates: NO_ALTERNATES,
    }),
    script: Some("https://opencode.ai/v2/install"),
    script_home: Some(SCRIPT_EXECUTABLE_PATHS[2].1),
    script_uninstall: NO_FILES,
    manual: None,
    registry_id: None,
    channel: None,
};

pub const PI: Installer = Installer {
    binary: "pi",
    source_url: "https://github.com/earendil-works/pi/tree/main/packages/coding-agent",
    package: Some("@earendil-works/pi-coding-agent"),
    node_major: Some(22),
    node_minor: Some(19),
    npm_flags: &["--ignore-scripts"],
    bun: false,
    brew: None,
    script: None,
    script_home: None,
    script_uninstall: NO_FILES,
    manual: None,
    registry_id: None,
    channel: None,
};

pub const CURSOR: Installer = Installer {
    binary: "",
    source_url: "https://cursor.com/docs/sdk/typescript",
    package: None,
    node_major: None,
    node_minor: None,
    npm_flags: NO_FLAGS,
    bun: false,
    brew: None,
    script: None,
    script_home: None,
    script_uninstall: NO_FILES,
    manual: Some("Cursor's SDK ships with ace. Sign in to Cursor; update the SDK by updating ace."),
    registry_id: None,
    channel: None,
};

pub const ANTIGRAVITY: Installer = Installer {
    binary: "agy_acp_server",
    source_url: "https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json",
    package: None,
    node_major: None,
    node_minor: None,
    npm_flags: NO_FLAGS,
    bun: false,
    brew: None,
    script: None,
    script_home: None,
    script_uninstall: NO_FILES,
    manual: None,
    registry_id: Some("official:antigravity-acp"),
    channel: None,
};

pub const GEMINI: Installer = Installer {
    binary: "gemini",
    source_url: "https://geminicli.com/docs/get-started/installation/",
    package: Some("@google/gemini-cli"),
    node_major: Some(20),
    node_minor: None,
    npm_flags: NO_FLAGS,
    bun: true,
    brew: Some(Brew {
        name: "gemini-cli",
        cask: false,
        alternates: NO_ALTERNATES,
    }),
    script: None,
    script_home: None,
    script_uninstall: NO_FILES,
    manual: None,
    registry_id: None,
    channel: None,
};

const QWEN_CODE: Installer = Installer {
    binary: "qwen",
    source_url: "https://qwenlm.github.io/qwen-code-docs/en/developers/development/deployment/",
    package: Some("@qwen-code/qwen-code"),
    node_major: Some(22),
    node_minor: None,
    npm_flags: NO_FLAGS,
    bun: true,
    brew: None,
    script: None,
    script_home: None,
    script_uninstall: NO_FILES,
    manual: None,
    registry_id: None,
    channel: None,
};

const CLAUDE_ACP: Installer = Installer {
    binary: "claude-agent-acp",
    source_url: "https://github.com/agentclientprotocol/claude-agent-acp/blob/main/README.md",
    package: Some("@agentclientprotocol/claude-agent-acp"),
    node_major: Some(22),
    node_minor: None,
    npm_flags: NO_FLAGS,
    bun: true,
    brew: None,
    script: None,
    script_home: None,
    script_uninstall: NO_FILES,
    manual: None,
    registry_id: None,
    channel: None,
};

const CODEX_ACP: Installer = Installer {
    binary: "codex-acp",
    source_url: "https://github.com/agentclientprotocol/codex-acp/blob/main/README.md",
    package: Some("@agentclientprotocol/codex-acp"),
    node_major: Some(22),
    node_minor: None,
    npm_flags: NO_FLAGS,
    bun: true,
    brew: None,
    script: None,
    script_home: None,
    script_uninstall: NO_FILES,
    manual: None,
    registry_id: None,
    channel: None,
};

pub const GOOSE: Installer = Installer {
    binary: "goose",
    source_url: "https://formulae.brew.sh/formula/block-goose-cli",
    package: None,
    node_major: None,
    node_minor: None,
    npm_flags: NO_FLAGS,
    bun: false,
    brew: Some(Brew {
        name: "block-goose-cli",
        cask: false,
        alternates: NO_ALTERNATES,
    }),
    script: None,
    script_home: None,
    script_uninstall: NO_FILES,
    manual: None,
    registry_id: None,
    channel: None,
};

const AUGGIE: Installer = Installer {
    binary: "auggie",
    source_url: "https://www.augmentcode.com/product/cli",
    package: Some("@augmentcode/auggie"),
    node_major: Some(20),
    node_minor: None,
    npm_flags: NO_FLAGS,
    bun: true,
    brew: None,
    script: None,
    script_home: None,
    script_uninstall: NO_FILES,
    manual: None,
    registry_id: None,
    channel: None,
};

/// The ACP agents the manifest installs. The registry's own commands are never run from a
/// payload: a target named here chooses a fixed row.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InstallAgent {
    Gemini,
    QwenCode,
    ClaudeAcp,
    CodexAcp,
    Goose,
    Auggie,
}

impl InstallAgent {
    pub fn parse(name: &str) -> Option<InstallAgent> {
        Some(match name {
            "gemini" => InstallAgent::Gemini,
            "qwen-code" => InstallAgent::QwenCode,
            "claude-acp" => InstallAgent::ClaudeAcp,
            "codex-acp" => InstallAgent::CodexAcp,
            "goose" => InstallAgent::Goose,
            "auggie" => InstallAgent::Auggie,
            _ => return None,
        })
    }

    pub fn as_str(self) -> &'static str {
        match self {
            InstallAgent::Gemini => "gemini",
            InstallAgent::QwenCode => "qwen-code",
            InstallAgent::ClaudeAcp => "claude-acp",
            InstallAgent::CodexAcp => "codex-acp",
            InstallAgent::Goose => "goose",
            InstallAgent::Auggie => "auggie",
        }
    }

    pub fn installer(self) -> Installer {
        match self {
            InstallAgent::Gemini => GEMINI,
            InstallAgent::QwenCode => QWEN_CODE,
            InstallAgent::ClaudeAcp => CLAUDE_ACP,
            InstallAgent::CodexAcp => CODEX_ACP,
            InstallAgent::Goose => GOOSE,
            InstallAgent::Auggie => AUGGIE,
        }
    }
}

/// The reviewed installer for a provider, or for one of its ACP agents. A provider with no
/// row has nothing ace installs on its behalf.
pub fn installer(provider: ProviderKind, agent: Option<InstallAgent>) -> Option<Installer> {
    match (provider, agent) {
        (ProviderKind::Acp, Some(agent)) => Some(agent.installer()),
        (ProviderKind::Acp, None) => None,
        (_, Some(_)) => None,
        (ProviderKind::Claude, None) => Some(CLAUDE),
        (ProviderKind::Codex, None) => Some(CODEX),
        (ProviderKind::Opencode, None) => Some(OPENCODE),
        (ProviderKind::Pi, None) => Some(PI),
        (ProviderKind::Cursor, None) => Some(CURSOR),
        (ProviderKind::Antigravity, None) => Some(ANTIGRAVITY),
    }
}

pub const PACKAGE_MANAGER_SOURCES: [(&str, &str); 3] = [
    (
        "npm",
        "https://docs.npmjs.com/cli/v11/commands/npm-uninstall/",
    ),
    ("bun", "https://bun.sh/docs/pm/cli/remove"),
    ("brew", "https://docs.brew.sh/Manpage"),
];

/// Official per-user script destinations, shared by discovery and the reviewed manifest.
pub const SCRIPT_EXECUTABLE_PATHS: [(&str, &str); 3] = [
    ("codex", ".local/bin/codex"),
    ("claude", ".local/bin/claude"),
    ("opencode", ".opencode/bin/opencode"),
];

/// A Windows directory as an environment base and a relative path.
pub type WindowsDirectory = (&'static str, &'static str);

/// Per-user Windows directories each vendor's own installer writes to, checked after PATH.
pub const WINDOWS_INSTALL_DIRECTORIES: &[(&str, &[WindowsDirectory])] = &[
    ("claude", &[("USERPROFILE", ".local\\bin")]),
    ("codex", &[("LOCALAPPDATA", "Programs\\OpenAI\\Codex\\bin")]),
    ("opencode", &[("USERPROFILE", ".opencode\\bin")]),
    ("cursor-agent", &[("LOCALAPPDATA", "cursor-agent")]),
    ("uv", &[("USERPROFILE", ".local\\bin")]),
    ("node", &[("PROGRAMFILES", "nodejs")]),
    ("npm", &[("PROGRAMFILES", "nodejs")]),
];

/// Shim directories of the Windows package managers people install agent CLIs with.
pub const WINDOWS_SHIM_DIRECTORIES: &[WindowsDirectory] = &[
    ("APPDATA", "npm"),
    ("USERPROFILE", ".bun\\bin"),
    ("LOCALAPPDATA", "Microsoft\\WinGet\\Links"),
    ("SCOOP", "shims"),
    ("USERPROFILE", "scoop\\shims"),
];

/// Agent CLIs and package managers whose lookup may fall back to the shim directories.
pub const WINDOWS_SHIM_COMMANDS: &[&str] = &[
    "claude",
    "codex",
    "opencode",
    "pi",
    "cursor-agent",
    "agy_acp_server",
    "gemini",
    "qwen",
    "claude-agent-acp",
    "codex-acp",
    "goose",
    "auggie",
    "uv",
];

#[cfg(test)]
mod tests {
    use super::*;

    // packages/provider-kit/src/installers/manifest.ts (reviewed allowlist)
    #[test]
    fn every_provider_with_an_installer_is_in_the_only_allowlist_ace_runs_from() {
        for provider in [
            ProviderKind::Claude,
            ProviderKind::Codex,
            ProviderKind::Opencode,
            ProviderKind::Pi,
            ProviderKind::Cursor,
            ProviderKind::Antigravity,
        ] {
            assert!(installer(provider, None).is_some(), "{provider}");
            assert!(
                installer(provider, Some(InstallAgent::Gemini)).is_none(),
                "{provider}"
            );
        }
        assert!(installer(ProviderKind::Acp, None).is_none());
        assert_eq!(
            installer(ProviderKind::Acp, Some(InstallAgent::QwenCode)).map(|spec| spec.binary),
            Some("qwen")
        );
        assert_eq!(
            InstallAgent::parse("qwen-code"),
            Some(InstallAgent::QwenCode)
        );
        assert_eq!(InstallAgent::parse("official:qwen-code"), None);
    }

    #[test]
    fn the_script_destinations_are_the_ones_discovery_checks() {
        assert_eq!(SCRIPT_EXECUTABLE_PATHS[0], ("codex", ".local/bin/codex"));
        assert_eq!(
            installer(ProviderKind::Claude, None).unwrap().script_home,
            Some(".local/bin/claude")
        );
        assert_eq!(
            installer(ProviderKind::Opencode, None).unwrap().script_home,
            Some(".opencode/bin/opencode")
        );
    }
}
