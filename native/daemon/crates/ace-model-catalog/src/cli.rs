// SPDX-License-Identifier: Apache-2.0
//! Provider CLI versions and their minimums (`cli-versions.ts`, `cli-requirements.ts`).
//!
//! Every minimum-version decision goes through [`check_cli_version`]. A CLI below its
//! minimum is `cli_too_old` with the versions it names; an unreadable one is admitted,
//! exactly as the TypeScript admits it.

use std::sync::OnceLock;

use regex::Regex;

/// The oldest version of each provider CLI ace supports (`cliRequirements`).
pub fn cli_name(id: &str) -> Option<&'static str> {
    Some(match id {
        "claude" => "Claude Code",
        "codex" => "Codex",
        "opencode" => "OpenCode",
        "pi" => "Pi",
        "cursor-sdk" => "Cursor SDK",
        "antigravity" => "Antigravity",
        "gemini" => "Gemini CLI",
        _ => return None,
    })
}

/// The minimum for a CLI, as the TypeScript table states it.
pub fn cli_minimum(id: &str) -> Option<&'static str> {
    Some(match id {
        "claude" => "2.1.286",
        "codex" => "0.159.1",
        "opencode" => "2.0.22",
        "pi" => "0.85.1",
        "cursor-sdk" => "1.0.35",
        "antigravity" => "1.2.1",
        "gemini" => "0.43.0",
        _ => return None,
    })
}

/// The CLI a provider's own install lists models through (`providerCli`).
pub fn provider_cli(provider: &str) -> Option<&'static str> {
    Some(match provider {
        "claude" => "claude",
        "codex" => "codex",
        "opencode" => "opencode",
        "pi" => "pi",
        _ => return None,
    })
}

/// A parsed CLI version.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliVersion {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
    pub prerelease: Vec<String>,
}

fn version_pattern() -> Option<&'static Regex> {
    // The TypeScript anchors the match with a trailing `(?![\w.]*\d)`, which Rust's
    // regex does not support; [`parse_cli_version`] checks that tail itself.
    static PATTERN: OnceLock<Option<Regex>> = OnceLock::new();
    PATTERN
        .get_or_init(|| {
            Regex::new(
                r"(?:^|[^\w.])v?(\d{1,9})\.(\d{1,9})(?:\.(\d{1,9}))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?",
            )
            .ok()
        })
        .as_ref()
}

/// `(?![\w.]*\d)`: the match is not the start of a longer version-like run.
fn version_tail_is_clear(rest: &str) -> bool {
    let mut seen_digit = false;
    for character in rest.chars() {
        if character.is_ascii_digit() {
            seen_digit = true;
        } else if character.is_alphanumeric() || character == '_' || character == '.' {
            continue;
        } else {
            return true;
        }
        if seen_digit {
            return false;
        }
    }
    !seen_digit
}

/// The first `major.minor[.patch][-prerelease]` in a CLI's version output.
pub fn parse_cli_version(text: Option<&str>) -> Option<CliVersion> {
    let text = text.filter(|text| !text.is_empty())?;
    let head = ace_models::text::slice_utf16(text, 4096);
    // The first match whose tail does not read as a longer version, as the anchored
    // TypeScript regex does.
    let pattern = version_pattern()?;
    let captures = pattern.captures_iter(&head).find(|captures| {
        captures
            .get(0)
            .is_some_and(|whole| version_tail_is_clear(&head[whole.end()..]))
    })?;
    let number = |index: usize, fallback: u64| {
        captures
            .get(index)
            .and_then(|value| value.as_str().parse().ok())
            .unwrap_or(fallback)
    };
    Some(CliVersion {
        major: number(1, 0),
        minor: number(2, 0),
        patch: number(3, 0),
        prerelease: captures
            .get(4)
            .map(|value| value.as_str().split('.').map(str::to_owned).collect())
            .unwrap_or_default(),
    })
}

/// The version as ace writes it: `2.1.286`, `0.86.0-beta.1`.
pub fn format_cli_version(version: &CliVersion) -> String {
    let base = format!("{}.{}.{}", version.major, version.minor, version.patch);
    if version.prerelease.is_empty() {
        base
    } else {
        format!("{base}-{}", version.prerelease.join("."))
    }
}

fn compare_identifiers(left: &str, right: &str) -> std::cmp::Ordering {
    let numeric = |text: &str| !text.is_empty() && text.chars().all(|c| c.is_ascii_digit());
    match (numeric(left), numeric(right)) {
        (true, true) => left
            .parse::<u64>()
            .unwrap_or(u64::MAX)
            .cmp(&right.parse::<u64>().unwrap_or(u64::MAX)),
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        (false, false) => left.cmp(right),
    }
}

/// Semantic-version order: a prerelease sorts before its own release.
pub fn compare_cli_versions(left: &CliVersion, right: &CliVersion) -> std::cmp::Ordering {
    left.major
        .cmp(&right.major)
        .then_with(|| left.minor.cmp(&right.minor))
        .then_with(|| left.patch.cmp(&right.patch))
        .then_with(
            || match (left.prerelease.is_empty(), right.prerelease.is_empty()) {
                (true, true) => std::cmp::Ordering::Equal,
                (true, false) => std::cmp::Ordering::Greater,
                (false, true) => std::cmp::Ordering::Less,
                (false, false) => {
                    for index in 0..left.prerelease.len().max(right.prerelease.len()) {
                        match (left.prerelease.get(index), right.prerelease.get(index)) {
                            (None, _) => return std::cmp::Ordering::Less,
                            (_, None) => return std::cmp::Ordering::Greater,
                            (Some(one), Some(two)) => {
                                let order = compare_identifiers(one, two);
                                if order != std::cmp::Ordering::Equal {
                                    return order;
                                }
                            }
                        }
                    }
                    std::cmp::Ordering::Equal
                }
            },
        )
}

/// Where an installed CLI stands against a minimum.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CliCheck {
    /// The version output held no version; callers don't block on it.
    Unreadable {
        required: String,
    },
    TooOld {
        installed: String,
        required: String,
    },
    Ok {
        installed: String,
        required: String,
    },
}

/// `checkCliVersion`: only a version below the minimum is `too_old`.
pub fn check_cli_version(minimum: &str, output: Option<&str>) -> CliCheck {
    let Some(required) = parse_cli_version(Some(minimum)) else {
        // The table above is fixed, so this is a programming error, not provider data.
        return CliCheck::Unreadable {
            required: minimum.to_owned(),
        };
    };
    let required_text = format_cli_version(&required);
    match parse_cli_version(output) {
        None => CliCheck::Unreadable {
            required: required_text,
        },
        Some(installed) => {
            let ordered = compare_cli_versions(&installed, &required);
            let installed_text = format_cli_version(&installed);
            if ordered.is_lt() {
                CliCheck::TooOld {
                    installed: installed_text,
                    required: required_text,
                }
            } else {
                CliCheck::Ok {
                    installed: installed_text,
                    required: required_text,
                }
            }
        }
    }
}

/// The person-facing sentence for a CLI older than ace supports.
pub fn cli_too_old_message(name: &str, installed: &str, required: &str) -> String {
    format!("{name} {installed} is older than {required}, the oldest version ace supports.")
}

/// The corrective hint for a CLI older than ace supports.
pub fn cli_update_hint(name: &str) -> String {
    format!("Update {name}, then refresh.")
}

/// Why a refresh refused to start: the CLI is older than ace's minimum for it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliTooOld {
    pub cli: String,
    pub name: String,
    pub installed: String,
    pub required: String,
}

impl CliTooOld {
    pub fn message(&self) -> String {
        format!(
            "{} {}",
            cli_too_old_message(&self.name, &self.installed, &self.required),
            cli_update_hint(&self.name)
        )
    }
}

/// `requireMinimum`: a CLI older than ace's minimum is reported as such.
pub fn require_minimum(cli: &str, output: Option<&str>) -> Result<(), CliTooOld> {
    match check_cli_version(cli_minimum(cli).unwrap_or_default(), output) {
        CliCheck::TooOld {
            installed,
            required,
        } => Err(CliTooOld {
            cli: cli.to_owned(),
            name: cli_name(cli).unwrap_or(cli).to_owned(),
            installed,
            required,
        }),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    //! Ports `packages/provider-kit/src/cli-versions.ts`'s reading and ordering, and
    //! the minimum that `catalog-minimum-version.process.test.ts` holds the catalog to:
    //! "a CLI older than ace's minimum is refused before discovery, a newer one runs".

    use super::*;

    #[test]
    fn the_first_version_in_cli_output_is_read_and_written_back() {
        for (text, expected) in [
            ("2.1.286 (Claude Code)", "2.1.286"),
            ("codex-cli 0.159.1", "0.159.1"),
            ("opencode v2.0.22", "2.0.22"),
            ("agy 1.2.1", "1.2.1"),
            ("1.2", "1.2.0"),
            ("0.86.0-beta.1", "0.86.0-beta.1"),
        ] {
            let parsed = parse_cli_version(Some(text)).unwrap_or_else(|| panic!("{text}"));
            assert_eq!(format_cli_version(&parsed), expected);
        }
        assert_eq!(parse_cli_version(Some("no version here")), None);
        assert_eq!(parse_cli_version(None), None);
    }

    #[test]
    fn a_prerelease_sorts_before_its_release_and_after_the_one_before() {
        let version =
            |text: &str| parse_cli_version(Some(text)).unwrap_or_else(|| panic!("{text}"));
        assert!(compare_cli_versions(&version("2.0.0-beta.1"), &version("2.0.0")).is_lt());
        assert!(compare_cli_versions(&version("2.0.0-beta.1"), &version("1.9.9")).is_gt());
        assert!(compare_cli_versions(&version("2.0.0-beta.2"), &version("2.0.0-beta.10")).is_lt());
    }

    #[test]
    fn only_a_version_below_the_minimum_is_too_old_and_an_unreadable_one_is_admitted() {
        assert_eq!(
            check_cli_version("2.0.22", Some("opencode v2.0.21")),
            CliCheck::TooOld {
                installed: "2.0.21".into(),
                required: "2.0.22".into()
            }
        );
        assert!(matches!(
            check_cli_version("2.0.22", Some("opencode v2.0.22")),
            CliCheck::Ok { .. }
        ));
        assert!(matches!(
            check_cli_version("2.0.22", None),
            CliCheck::Unreadable { .. }
        ));
    }

    #[test]
    fn a_too_old_cli_names_both_versions_and_what_to_do() {
        let refused = match require_minimum("opencode", Some("2.0.21")) {
            Ok(()) => panic!("2.0.21 is below the minimum"),
            Err(refused) => refused,
        };
        assert_eq!(
            refused.message(),
            "OpenCode 2.0.21 is older than 2.0.22, the oldest version ace supports. Update OpenCode, then refresh."
        );
        assert!(require_minimum("opencode", Some("2.0.22")).is_ok());
        assert!(require_minimum("opencode", None).is_ok());
    }
}
