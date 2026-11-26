// SPDX-License-Identifier: Apache-2.0
//! The reviewed commands an installer runs, from `@ace/provider-kit/installers/commands.ts`.
//! Every executable path comes from the trusted planning boundary; nothing here is derived
//! from a registry or a client payload.

use serde::Serialize;

use crate::manifest::Installer;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct InstallCommand {
    pub command: String,
    pub args: Vec<String>,
    pub display: String,
}

/// A shell word as the person would type it: plain words stay bare, the rest are single-quoted.
fn quote(word: &str) -> String {
    let plain = !word.is_empty()
        && word.chars().all(|character| {
            character.is_ascii_alphanumeric()
                || matches!(character, '_' | '@' | '.' | '/' | ':' | '=' | '+' | '-')
        });
    if plain {
        word.to_string()
    } else {
        format!("'{}'", word.replace('\'', "'\\''"))
    }
}

pub fn install_command(executable: &str, args: &[&str]) -> InstallCommand {
    let mut words = Vec::with_capacity(args.len() + 1);
    words.push(executable.to_string());
    words.extend(args.iter().map(|argument| (*argument).to_string()));
    InstallCommand {
        command: executable.to_string(),
        args: args
            .iter()
            .map(|argument| (*argument).to_string())
            .collect(),
        display: words
            .iter()
            .map(|word| quote(word))
            .collect::<Vec<_>>()
            .join(" "),
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct InstallerExecutables<'a> {
    pub npm: Option<&'a str>,
    pub bun: Option<&'a str>,
    pub brew: Option<&'a str>,
    pub curl: Option<&'a str>,
    pub bash: Option<&'a str>,
    pub rm: Option<&'a str>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum InstallAction {
    Install,
    Update,
    Uninstall,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum InstallMethod {
    Npm,
    Bun,
    Brew,
    Script,
    Registry,
}

impl InstallMethod {
    pub fn as_str(self) -> &'static str {
        match self {
            InstallMethod::Npm => "npm",
            InstallMethod::Bun => "bun",
            InstallMethod::Brew => "brew",
            InstallMethod::Script => "script",
            InstallMethod::Registry => "registry",
        }
    }
}

/// Freshly build only reviewed commands; all paths come from the trusted planning boundary.
pub fn installer_commands(
    spec: &Installer,
    action: InstallAction,
    method: InstallMethod,
    executables: InstallerExecutables<'_>,
    home: &str,
) -> Vec<InstallCommand> {
    let InstallerExecutables {
        npm,
        bun,
        brew,
        curl,
        bash,
        rm,
    } = executables;
    match method {
        InstallMethod::Npm => match (npm, spec.package) {
            (Some(npm), Some(package)) => {
                let args = if action == InstallAction::Uninstall {
                    vec![
                        "uninstall".to_string(),
                        "-g".to_string(),
                        package.to_string(),
                    ]
                } else {
                    let mut args = vec!["install".to_string(), "-g".to_string()];
                    args.extend(spec.npm_flags.iter().map(|flag| (*flag).to_string()));
                    args.push(format!("{package}@{}", spec.channel.unwrap_or("latest")));
                    args
                };
                vec![install_command(npm, &borrowed(&args))]
            }
            _ => Vec::new(),
        },
        InstallMethod::Bun => match (bun, spec.package, spec.bun) {
            (Some(bun), Some(package), true) => {
                let args = if action == InstallAction::Uninstall {
                    vec!["remove".to_string(), "-g".to_string(), package.to_string()]
                } else {
                    vec![
                        "install".to_string(),
                        "-g".to_string(),
                        "--trust".to_string(),
                        package.to_string(),
                    ]
                };
                vec![install_command(bun, &borrowed(&args))]
            }
            _ => Vec::new(),
        },
        InstallMethod::Brew => match (brew, spec.brew) {
            (Some(brew), Some(formula)) => {
                let verb = match action {
                    InstallAction::Update => "upgrade",
                    InstallAction::Uninstall => "uninstall",
                    InstallAction::Install => "install",
                };
                let mut args = vec![verb.to_string()];
                if formula.cask {
                    args.push("--cask".to_string());
                }
                args.push(formula.name.to_string());
                vec![install_command(brew, &borrowed(&args))]
            }
            _ => Vec::new(),
        },
        InstallMethod::Script => match (bash, curl, spec.script) {
            (Some(_), Some(_), Some(_)) if action == InstallAction::Uninstall => {
                match (rm, spec.script_uninstall.is_empty()) {
                    (Some(rm), false) => spec
                        .script_uninstall
                        .iter()
                        .map(|(flag, path)| {
                            let absolute = format!("{}/{}", home.trim_end_matches('/'), path);
                            install_command(rm, &[*flag, "--", &absolute])
                        })
                        .collect(),
                    _ => Vec::new(),
                }
            }
            (Some(bash_path), Some(curl_path), Some(script)) => {
                let download = install_command(curl_path, &["-fsSL", script]).display;
                let channel: Vec<&str> = match spec.channel {
                    Some(channel) => vec!["-s", channel],
                    None => Vec::new(),
                };
                let run = install_command(bash_path, &channel).display;
                let pipeline = format!("{download} | {run}");
                vec![install_command(
                    bash_path,
                    &["-o", "pipefail", "-c", &pipeline],
                )]
            }
            _ => Vec::new(),
        },
        InstallMethod::Registry => Vec::new(),
    }
}

fn borrowed(values: &[String]) -> Vec<&str> {
    values.iter().map(String::as_str).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::CLAUDE;

    // packages/provider-kit/src/installers/commands.ts
    // "installCommand renders each argument as a shell word"
    #[test]
    fn every_argument_is_quoted_as_a_shell_word() {
        assert_eq!(
            install_command(
                "/usr/local/bin/npm",
                &["install", "-g", "@openai/codex@latest"]
            ),
            InstallCommand {
                command: "/usr/local/bin/npm".into(),
                args: vec!["install".into(), "-g".into(), "@openai/codex@latest".into()],
                display: "/usr/local/bin/npm install -g @openai/codex@latest".into(),
            }
        );
        assert_eq!(
            install_command("bash", &["-c", "curl -fsSL 'a b' | sh"]).display,
            "bash -c 'curl -fsSL '\\''a b'\\'' | sh'"
        );
        // An empty word is still a word.
        assert_eq!(install_command("tool", &[""]).display, "tool ''");
    }

    // apps/daemon/src/provider-install/planner.process.test.ts
    // "official script installation verifies the binary and uninstalls only Claude runtime files"
    #[test]
    fn a_script_install_pipes_the_reviewed_script_and_uninstalls_only_its_files() {
        let installed = installer_commands(
            &CLAUDE,
            InstallAction::Install,
            InstallMethod::Script,
            InstallerExecutables {
                curl: Some("/usr/bin/curl"),
                bash: Some("/bin/bash"),
                ..Default::default()
            },
            "/Users/dev",
        );
        assert_eq!(
            installed[0].display,
            "/bin/bash -o pipefail -c '/usr/bin/curl -fsSL https://claude.ai/install.sh | /bin/bash'"
        );
        let removed = installer_commands(
            &CLAUDE,
            InstallAction::Uninstall,
            InstallMethod::Script,
            InstallerExecutables {
                curl: Some("/usr/bin/curl"),
                bash: Some("/bin/bash"),
                rm: Some("/bin/rm"),
                ..Default::default()
            },
            "/Users/dev/",
        );
        assert_eq!(removed.len(), 2);
        assert_eq!(
            removed[0].display,
            "/bin/rm -f -- /Users/dev/.local/bin/claude"
        );
        assert_eq!(
            removed[1].display,
            "/bin/rm -rf -- /Users/dev/.local/share/claude"
        );
    }

    // "Homebrew latest versions use cask metadata while unknown paths and bundled Cursor remain manual"
    #[test]
    fn a_missing_executable_builds_no_command() {
        assert!(
            installer_commands(
                &CLAUDE,
                InstallAction::Install,
                InstallMethod::Script,
                InstallerExecutables::default(),
                "/Users/dev"
            )
            .is_empty()
        );
    }
}
