use ace_core::ProviderKind;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderSlashCommandKind {
    Provider,
    Skill,
    Plugin,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderSlashCommand {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<ProviderSlashCommandKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_prefix: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_hint: Option<String>,
}

impl ProviderSlashCommand {
    #[must_use]
    pub fn provider(name: impl Into<String>, description: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            kind: Some(ProviderSlashCommandKind::Provider),
            description: Some(description.into()),
            prompt_prefix: None,
            input_hint: None,
        }
    }

    #[must_use]
    pub fn with_input_hint(mut self, input_hint: impl Into<String>) -> Self {
        self.input_hint = Some(input_hint.into());
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderExtensionCommandInput {
    pub name: String,
    pub description: Option<String>,
    pub prompt_prefix: Option<String>,
    pub input_hint: Option<String>,
}

#[must_use]
pub fn provider_skill_slash_command(input: ProviderExtensionCommandInput) -> ProviderSlashCommand {
    let prompt_prefix = input
        .prompt_prefix
        .unwrap_or_else(|| format!("${}", input.name));
    ProviderSlashCommand {
        name: input.name,
        kind: Some(ProviderSlashCommandKind::Skill),
        description: input.description,
        prompt_prefix: Some(prompt_prefix),
        input_hint: input.input_hint,
    }
}

#[must_use]
pub fn provider_plugin_slash_command(input: ProviderExtensionCommandInput) -> ProviderSlashCommand {
    let prompt_prefix = input
        .prompt_prefix
        .unwrap_or_else(|| format!("@{}", input.name));
    ProviderSlashCommand {
        name: input.name,
        kind: Some(ProviderSlashCommandKind::Plugin),
        description: input.description,
        prompt_prefix: Some(prompt_prefix),
        input_hint: input.input_hint,
    }
}

#[must_use]
pub fn normalize_provider_slash_command_name(value: &str) -> Option<String> {
    let name = value.trim().trim_start_matches(['/', '@', '$']);
    if name.is_empty() || name.chars().any(char::is_whitespace) {
        return None;
    }
    Some(name.to_string())
}

#[must_use]
pub fn provider_slash_command_extension_kind(
    command: &ProviderSlashCommand,
    normalized_name: &str,
) -> Option<ProviderSlashCommandKind> {
    match command.kind {
        Some(ProviderSlashCommandKind::Skill | ProviderSlashCommandKind::Plugin) => {
            return command.kind;
        }
        Some(ProviderSlashCommandKind::Provider) | None => {}
    }

    let prompt_prefix = command.prompt_prefix.as_deref().map(str::trim);
    if prompt_prefix.is_some_and(|prefix| prefix.starts_with('$')) {
        return Some(ProviderSlashCommandKind::Skill);
    }
    if prompt_prefix.is_some_and(|prefix| prefix.starts_with('@')) {
        return Some(ProviderSlashCommandKind::Plugin);
    }

    let mut parts = normalized_name.splitn(2, ['/', ':', '.']);
    let root = parts.next()?;
    parts.next()?;
    match root.to_ascii_lowercase().as_str() {
        "skill" | "skills" => Some(ProviderSlashCommandKind::Skill),
        "plugin" | "plugins" => Some(ProviderSlashCommandKind::Plugin),
        _ => None,
    }
}

#[must_use]
pub fn merge_provider_slash_commands<I, S>(sources: I) -> Vec<ProviderSlashCommand>
where
    I: IntoIterator<Item = S>,
    S: IntoIterator<Item = ProviderSlashCommand>,
{
    let sources = sources
        .into_iter()
        .map(IntoIterator::into_iter)
        .map(Iterator::collect::<Vec<_>>)
        .collect::<Vec<_>>();
    let plugin_command_keys = collect_plugin_command_keys(&sources);
    let mut merged = Vec::new();
    let mut seen = HashSet::new();

    for source in sources {
        for candidate in source {
            let Some(name) = normalize_provider_slash_command_name(&candidate.name) else {
                continue;
            };
            let inferred_kind = provider_slash_command_extension_kind(&candidate, &name);
            let kind = candidate.kind.or(inferred_kind);
            let prompt_prefix = trim_optional(candidate.prompt_prefix).or_else(|| match kind {
                Some(ProviderSlashCommandKind::Skill) => Some(format!("${name}")),
                Some(ProviderSlashCommandKind::Plugin) => Some(format!("@{name}")),
                Some(ProviderSlashCommandKind::Provider) | None => None,
            });

            if kind == Some(ProviderSlashCommandKind::Skill)
                && is_redundant_plugin_primary_skill_command(&name, &plugin_command_keys)
            {
                continue;
            }

            let key = name.to_ascii_lowercase();
            if !seen.insert(key) {
                continue;
            }

            merged.push(ProviderSlashCommand {
                name,
                kind,
                description: trim_optional(candidate.description),
                prompt_prefix,
                input_hint: trim_optional(candidate.input_hint),
            });
        }
    }

    merged
}

#[must_use]
pub fn provider_fallback_slash_commands(
    provider: Option<ProviderKind>,
) -> Vec<ProviderSlashCommand> {
    match provider {
        Some(ProviderKind::Codex) => codex_fallback_slash_commands(),
        _ => Vec::new(),
    }
}

fn codex_fallback_slash_commands() -> Vec<ProviderSlashCommand> {
    [
        ProviderSlashCommand::provider("permissions", "Set what Codex can do without asking first"),
        ProviderSlashCommand::provider(
            "sandbox-add-read-dir",
            "Grant sandbox read access to an extra directory",
        )
        .with_input_hint("<path>"),
        ProviderSlashCommand::provider("agent", "Switch the active agent thread"),
        ProviderSlashCommand::provider("apps", "Browse apps and insert them into your prompt"),
        ProviderSlashCommand::provider("plugins", "Browse installed and discoverable plugins"),
        ProviderSlashCommand::provider(
            "compact",
            "Summarize the visible conversation to free tokens",
        ),
        ProviderSlashCommand::provider("diff", "Show the Git diff"),
        ProviderSlashCommand::provider("mcp", "List configured MCP tools")
            .with_input_hint("verbose"),
        ProviderSlashCommand::provider("model", "Choose the active model"),
        ProviderSlashCommand::provider("plan", "Switch to plan mode and optionally send a prompt")
            .with_input_hint("<prompt>"),
        ProviderSlashCommand::provider("ps", "Show background terminals and recent output"),
        ProviderSlashCommand::provider("fork", "Fork the current conversation"),
        ProviderSlashCommand::provider("side", "Start an ephemeral side conversation")
            .with_input_hint("<prompt>"),
        ProviderSlashCommand::provider("review", "Ask Codex to review your working tree"),
        ProviderSlashCommand::provider("status", "Display session configuration and token usage"),
    ]
    .into_iter()
    .collect()
}

fn trim_optional(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    })
}

fn collect_plugin_command_keys(sources: &[Vec<ProviderSlashCommand>]) -> HashSet<String> {
    let mut plugin_keys = HashSet::new();
    for candidate in sources.iter().flatten() {
        let Some(name) = normalize_provider_slash_command_name(&candidate.name) else {
            continue;
        };
        let kind = candidate
            .kind
            .or_else(|| provider_slash_command_extension_kind(candidate, &name));
        if kind == Some(ProviderSlashCommandKind::Plugin) {
            let plugin_key = comparable_extension_name(&name);
            if !plugin_key.is_empty() {
                plugin_keys.insert(plugin_key);
            }
        }
    }
    plugin_keys
}

fn is_redundant_plugin_primary_skill_command(
    command_name: &str,
    plugin_command_keys: &HashSet<String>,
) -> bool {
    let mut parts = command_name.splitn(2, ':');
    let Some(scope) = parts.next() else {
        return false;
    };
    let Some(skill_name) = parts.next() else {
        return false;
    };
    let plugin_key = comparable_extension_name(scope);
    let skill_key = comparable_extension_name(skill_name);
    if plugin_key.is_empty() || skill_key.is_empty() || !plugin_command_keys.contains(&plugin_key) {
        return false;
    }
    skill_key == plugin_key
        || plugin_key
            .strip_prefix(&skill_key)
            .is_some_and(|rest| rest.starts_with('-'))
        || skill_key
            .strip_prefix(&plugin_key)
            .is_some_and(|rest| rest.starts_with('-'))
}

fn comparable_extension_name(value: &str) -> String {
    let mut normalized = String::new();
    let mut last_was_dash = false;
    for ch in value.trim().chars().flat_map(char::to_lowercase) {
        if ch.is_ascii_alphanumeric() {
            normalized.push(ch);
            last_was_dash = false;
        } else if !last_was_dash {
            normalized.push('-');
            last_was_dash = true;
        }
    }
    normalized.trim_matches('-').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn command(name: &str) -> ProviderSlashCommand {
        ProviderSlashCommand {
            name: name.to_string(),
            kind: None,
            description: None,
            prompt_prefix: None,
            input_hint: None,
        }
    }

    #[test]
    fn creates_concrete_skill_and_plugin_invocations() {
        let skill = provider_skill_slash_command(ProviderExtensionCommandInput {
            name: "rust".to_string(),
            description: Some("Use Rust skill".to_string()),
            prompt_prefix: None,
            input_hint: Some("<prompt>".to_string()),
        });
        assert_eq!(skill.kind, Some(ProviderSlashCommandKind::Skill));
        assert_eq!(skill.prompt_prefix.as_deref(), Some("$rust"));

        let plugin = provider_plugin_slash_command(ProviderExtensionCommandInput {
            name: "browser-use".to_string(),
            description: None,
            prompt_prefix: None,
            input_hint: None,
        });
        assert_eq!(plugin.kind, Some(ProviderSlashCommandKind::Plugin));
        assert_eq!(plugin.prompt_prefix.as_deref(), Some("@browser-use"));
    }

    #[test]
    fn normalizes_names_and_infers_extension_kinds() {
        assert_eq!(
            normalize_provider_slash_command_name(" /plugin:browser "),
            Some("plugin:browser".to_string())
        );
        assert_eq!(normalize_provider_slash_command_name("bad name"), None);

        let mut skill = command("ignored");
        skill.prompt_prefix = Some("$rust".to_string());
        assert_eq!(
            provider_slash_command_extension_kind(&skill, "ignored"),
            Some(ProviderSlashCommandKind::Skill)
        );

        let mut plugin = command("ignored");
        plugin.prompt_prefix = Some("@browser".to_string());
        assert_eq!(
            provider_slash_command_extension_kind(&plugin, "ignored"),
            Some(ProviderSlashCommandKind::Plugin)
        );

        assert_eq!(
            provider_slash_command_extension_kind(&command("plugin/browser"), "plugin/browser"),
            Some(ProviderSlashCommandKind::Plugin)
        );
    }

    #[test]
    fn merge_trims_deduplicates_and_fills_prompt_prefixes() {
        let merged = merge_provider_slash_commands([
            vec![ProviderSlashCommand {
                name: " /Rust ".to_string(),
                kind: Some(ProviderSlashCommandKind::Skill),
                description: Some(" Rust skill ".to_string()),
                prompt_prefix: None,
                input_hint: Some(" <prompt> ".to_string()),
            }],
            vec![
                ProviderSlashCommand {
                    name: "rust".to_string(),
                    kind: Some(ProviderSlashCommandKind::Skill),
                    description: Some("duplicate".to_string()),
                    prompt_prefix: None,
                    input_hint: None,
                },
                ProviderSlashCommand {
                    name: "@browser".to_string(),
                    kind: Some(ProviderSlashCommandKind::Plugin),
                    description: None,
                    prompt_prefix: None,
                    input_hint: None,
                },
            ],
        ]);

        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].name, "Rust");
        assert_eq!(merged[0].description.as_deref(), Some("Rust skill"));
        assert_eq!(merged[0].prompt_prefix.as_deref(), Some("$Rust"));
        assert_eq!(merged[0].input_hint.as_deref(), Some("<prompt>"));
        assert_eq!(merged[1].name, "browser");
        assert_eq!(merged[1].prompt_prefix.as_deref(), Some("@browser"));
    }

    #[test]
    fn drops_redundant_primary_plugin_skill_commands() {
        let merged = merge_provider_slash_commands([
            vec![provider_plugin_slash_command(
                ProviderExtensionCommandInput {
                    name: "browser-use".to_string(),
                    description: None,
                    prompt_prefix: None,
                    input_hint: None,
                },
            )],
            vec![
                provider_skill_slash_command(ProviderExtensionCommandInput {
                    name: "browser-use:browser".to_string(),
                    description: None,
                    prompt_prefix: None,
                    input_hint: None,
                }),
                provider_skill_slash_command(ProviderExtensionCommandInput {
                    name: "browser-use:inspect-page".to_string(),
                    description: None,
                    prompt_prefix: None,
                    input_hint: None,
                }),
            ],
        ]);

        assert_eq!(
            merged
                .iter()
                .map(|command| command.name.as_str())
                .collect::<Vec<_>>(),
            vec!["browser-use", "browser-use:inspect-page"]
        );
    }

    #[test]
    fn codex_fallback_commands_include_parity_surfaces() {
        let commands = provider_fallback_slash_commands(Some(ProviderKind::Codex));
        let names = commands
            .iter()
            .map(|command| command.name.as_str())
            .collect::<HashSet<_>>();
        for expected in [
            "permissions",
            "apps",
            "plugins",
            "mcp",
            "plan",
            "fork",
            "side",
            "review",
            "ps",
        ] {
            assert!(names.contains(expected), "missing {expected}");
        }
    }
}
