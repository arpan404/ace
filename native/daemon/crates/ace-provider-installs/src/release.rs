// SPDX-License-Identifier: Apache-2.0
//! Pure facts about a published release: what the registry says the newest version is, which
//! package carries this computer's binary, and which Homebrew name an installed binary came
//! from, from `apps/daemon/src/provider-install/release.ts`.

use std::sync::OnceLock;

use ace_json::Value;
use regex::Regex;

/// A published version: `1.2.3`, with an optional `-prerelease` and `+build`.
pub fn release_version(text: &str) -> bool {
    static PATTERN: OnceLock<Option<Regex>> = OnceLock::new();
    PATTERN
        .get_or_init(|| {
            Regex::new(r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$").ok()
        })
        .as_ref()
        .is_some_and(|pattern| pattern.is_match(text))
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Release {
    pub version: String,
    /// Package name to version or `npm:` alias, in the order the registry printed it.
    pub optional_dependencies: Vec<(String, String)>,
}

/// A registry reply for one version's `version` and `optionalDependencies`, from npm `view` or
/// Bun `info` with `--json`: a bare version string when the package has no optional
/// dependencies, else an object. Plain version text reads too.
pub fn parse_release(raw: Option<&str>) -> Option<Release> {
    let text = raw?.trim();
    if text.is_empty() {
        return None;
    }
    let parsed = ace_json::parse(text).ok();
    if let Some(Value::String(version)) = parsed.as_ref() {
        return release_version(version.as_str()).then(|| Release {
            version: version.as_str().to_string(),
            optional_dependencies: Vec::new(),
        });
    }
    // Plain version text (a bare `0.167.0` is not JSON).
    if release_version(text) {
        return Some(Release {
            version: text.to_string(),
            optional_dependencies: Vec::new(),
        });
    }
    let object = parsed?.as_object()?.clone();
    let version = match object.get("version") {
        Some(Value::String(version)) if release_version(version.as_str()) => {
            version.as_str().to_string()
        }
        Some(Value::String(_)) | Some(_) => return None,
        None => return None,
    };
    let mut optional_dependencies = Vec::new();
    match object.get("optionalDependencies") {
        None => {}
        Some(Value::Object(dependencies)) => {
            for (name, value) in dependencies.iter() {
                let value = value.as_str()?;
                optional_dependencies.push((name.as_str().to_string(), value.to_string()));
            }
        }
        Some(_) => return None,
    }
    Some(Release {
        version,
        optional_dependencies,
    })
}

const ARCH_NAMES: &[(&str, &[&str])] = &[("arm64", &["arm64", "aarch64"]), ("x64", &["x64"])];

/// The `name@version` of the package that carries this computer's binary for `release`, when the
/// CLI ships one per platform: `@anthropic-ai/claude-code-darwin-arm64@2.1.321`, or Codex's alias
/// `@openai/codex@0.167.0-darwin-arm64`. Vendors publish these after the main package, so until it
/// exists the release can't install here. Undefined when the CLI has no such package.
pub fn platform_package(
    name: &str,
    release: &Release,
    platform: &str,
    arch: &str,
) -> Option<String> {
    let architectures = ARCH_NAMES
        .iter()
        .find(|(known, _)| *known == arch)
        .map(|(_, names)| *names)
        .unwrap_or(std::slice::from_ref(&arch));
    let suffixes: Vec<String> = architectures
        .iter()
        .map(|cpu| format!("{platform}-{cpu}"))
        .collect();
    for (dependency, spec) in &release.optional_dependencies {
        let alias = spec.strip_prefix("npm:");
        let (target, version) = match alias {
            Some(alias) => match alias.rfind('@') {
                Some(at) if at > 0 => (&alias[..at], &alias[at + 1..]),
                _ => (dependency.as_str(), spec.as_str()),
            },
            None => (dependency.as_str(), spec.as_str()),
        };
        if !release_version(version) {
            continue;
        }
        let ours = if target == name {
            suffixes
                .iter()
                .any(|suffix| version.ends_with(&format!("-{suffix}")))
        } else {
            target
                .strip_prefix(&format!("{name}-"))
                .is_some_and(|suffix| suffixes.iter().any(|known| known == suffix))
        };
        if ours {
            return Some(format!("{target}@{version}"));
        }
    }
    None
}

/// The Homebrew name `path` (a resolved binary) was installed under, else the default name.
/// `None` when the provider has no Homebrew formula.
pub fn brew_name(formula: Option<crate::manifest::Brew>, path: Option<&str>) -> Option<String> {
    let formula = formula?;
    let names = std::iter::once(formula.name).chain(formula.alternates.iter().copied());
    let normalized = path.unwrap_or("").replace('\\', "/");
    for candidate in names {
        let short = candidate.rsplit('/').next().unwrap_or(candidate);
        if ["Caskroom", "Cellar"]
            .iter()
            .any(|dir| normalized.contains(&format!("/{dir}/{short}/")))
        {
            return Some(candidate.to_string());
        }
    }
    Some(formula.name.to_string())
}

/// Claude Code's `autoUpdatesChannel` in one settings file; `None` when it isn't set or invalid.
pub fn claude_channel(settings: Option<&str>) -> Option<&'static str> {
    let parsed = ace_json::parse(settings?).ok()?;
    let object = parsed.as_object()?;
    match object.get("autoUpdatesChannel")? {
        Value::String(channel) => match channel.as_str() {
            "stable" => Some("stable"),
            "latest" => Some("latest"),
            _ => None,
        },
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn release(optional_dependencies: &[(&str, &str)]) -> Release {
        Release {
            version: "2.0.0".into(),
            optional_dependencies: optional_dependencies
                .iter()
                .map(|(name, spec)| ((*name).to_string(), (*spec).to_string()))
                .collect(),
        }
    }

    // apps/daemon/src/provider-install/release.test.ts
    // "registry replies read as a release whatever shape the package manager prints"
    #[test]
    fn registry_replies_read_as_a_release_whatever_shape_the_package_manager_prints() {
        assert_eq!(
            parse_release(Some("\"1.5.0\"\n")),
            Some(Release {
                version: "1.5.0".into(),
                optional_dependencies: Vec::new()
            })
        );
        assert_eq!(
            parse_release(Some("0.167.0")),
            Some(Release {
                version: "0.167.0".into(),
                optional_dependencies: Vec::new()
            })
        );
        assert_eq!(
            parse_release(Some(
                r#"{"version":"2.1.321","optionalDependencies":{"x-darwin-arm64":"2.1.321"}}"#
            )),
            Some(Release {
                version: "2.1.321".into(),
                optional_dependencies: vec![("x-darwin-arm64".into(), "2.1.321".into())],
            })
        );
        for unusable in [
            None,
            Some(""),
            Some("not a version"),
            Some(r#"{"name":"x"}"#),
            Some("1.2"),
        ] {
            assert_eq!(parse_release(unusable), None, "{unusable:?}");
        }
    }

    // "the binary package for this computer: <case>"
    #[test]
    fn the_binary_package_for_this_computer_names_its_platform() {
        assert_eq!(
            platform_package(
                "@anthropic-ai/claude-code",
                &release(&[
                    ("@anthropic-ai/claude-code-darwin-x64", "2.0.0"),
                    ("@anthropic-ai/claude-code-darwin-arm64", "2.0.0"),
                ]),
                "darwin",
                "arm64",
            ),
            Some("@anthropic-ai/claude-code-darwin-arm64@2.0.0".into())
        );
        // Codex's alias to a platform version of itself.
        assert_eq!(
            platform_package(
                "@openai/codex",
                &release(&[
                    (
                        "@openai/codex-linux-arm64",
                        "npm:@openai/codex@2.0.0-linux-arm64"
                    ),
                    (
                        "@openai/codex-linux-x64",
                        "npm:@openai/codex@2.0.0-linux-x64"
                    ),
                ]),
                "linux",
                "x64",
            ),
            Some("@openai/codex@2.0.0-linux-x64".into())
        );
        // OpenCode's plain build, not its baseline variant.
        assert_eq!(
            platform_package(
                "@opencode/cli",
                &release(&[
                    ("@opencode/cli-darwin-x64-baseline", "2.0.0"),
                    ("@opencode/cli-darwin-x64", "2.0.0"),
                ]),
                "darwin",
                "x64",
            ),
            Some("@opencode/cli-darwin-x64@2.0.0".into())
        );
        assert_eq!(
            platform_package(
                "tool",
                &release(&[("tool-linux-aarch64", "2.0.0")]),
                "linux",
                "arm64"
            ),
            Some("tool-linux-aarch64@2.0.0".into())
        );
        // Nothing for a third-party native dependency, nor a range rather than a version.
        assert_eq!(
            platform_package(
                "@google/gemini-cli",
                &release(&[("@lydell/node-pty-darwin-arm64", "1.1.0")]),
                "darwin",
                "arm64"
            ),
            None
        );
        assert_eq!(
            platform_package(
                "tool",
                &release(&[("tool-darwin-arm64", "^2.0.0")]),
                "darwin",
                "arm64"
            ),
            None
        );
    }

    // "a Homebrew binary updates under the name it was installed with"
    #[test]
    fn a_homebrew_binary_updates_under_the_name_it_was_installed_with() {
        let claude = crate::manifest::CLAUDE.brew;
        assert_eq!(
            brew_name(
                claude,
                Some("/opt/homebrew/Caskroom/claude-code@latest/2.1.321/claude")
            ),
            Some("claude-code@latest".into())
        );
        assert_eq!(
            brew_name(
                claude,
                Some("/opt/homebrew/Caskroom/claude-code/2.1.311/claude")
            ),
            Some("claude-code".into())
        );
        assert_eq!(
            brew_name(claude, Some("/somewhere/else/claude")),
            Some("claude-code".into())
        );
        // Pi has no Homebrew formula: nothing is named.
        assert_eq!(brew_name(crate::manifest::PI.brew, None), None);
    }

    // "Claude's release channel is read from its settings and ignored when unset or invalid"
    #[test]
    fn claudes_release_channel_is_read_from_its_settings_and_ignored_when_unset() {
        assert_eq!(
            claude_channel(Some(r#"{"autoUpdatesChannel":"stable"}"#)),
            Some("stable")
        );
        assert_eq!(
            claude_channel(Some(r#"{"autoUpdatesChannel":"latest","model":"x"}"#)),
            Some("latest")
        );
        for unset in [
            None,
            Some(""),
            Some("{"),
            Some("{}"),
            Some(r#"{"autoUpdatesChannel":"nightly"}"#),
        ] {
            assert_eq!(claude_channel(unset), None, "{unset:?}");
        }
    }
}
