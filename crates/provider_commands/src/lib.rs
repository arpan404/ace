use ace_core::ProviderKind;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};

const COMMAND_NAME_MAX_LEN: usize = 121;
const PLUGIN_MANIFEST_MAX_DEPTH: usize = 5;
const SKILL_ROOT_MAX_NESTED_DEPTH: usize = 1;
const SKILL_FILE_NAME: &str = "SKILL.md";
const CODEX_PLUGIN_MANIFEST_DIR: &str = ".codex-plugin";

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

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CodexExtensionDiscoveryOptions {
    pub cwd: Option<PathBuf>,
    pub codex_home: Option<PathBuf>,
    pub agents_home: Option<PathBuf>,
}

#[derive(Debug, Clone, Deserialize)]
struct PluginManifest {
    name: Option<String>,
    description: Option<String>,
    skills: Option<String>,
    #[serde(default, rename = "interface")]
    interface_config: Option<PluginInterface>,
}

#[derive(Debug, Clone, Deserialize)]
struct PluginInterface {
    #[serde(rename = "shortDescription")]
    short_description: Option<String>,
    #[serde(rename = "longDescription")]
    long_description: Option<String>,
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
    if !is_valid_command_name(name) {
        return None;
    }
    Some(name.to_string())
}

#[must_use]
pub fn normalize_discovered_command_name(value: &str) -> Option<String> {
    let normalized = value.trim().replace(char::is_whitespace, "-");
    is_valid_command_name(&normalized).then_some(normalized)
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

#[must_use]
pub fn discover_codex_extension_slash_commands(
    options: CodexExtensionDiscoveryOptions,
) -> Vec<ProviderSlashCommand> {
    let codex_home = options
        .codex_home
        .or_else(|| home_dir().map(|home| home.join(".codex")));
    let agents_home = options
        .agents_home
        .or_else(|| home_dir().map(|home| home.join(".agents")));

    let mut skill_roots = Vec::new();
    if let Some(cwd) = options.cwd.as_deref() {
        skill_roots.push(cwd.join(".codex").join("skills"));
        skill_roots.push(cwd.join(".agents").join("skills"));
    }
    if let Some(codex_home) = codex_home.as_deref() {
        skill_roots.push(codex_home.join("skills"));
    }
    if let Some(agents_home) = agents_home.as_deref() {
        skill_roots.push(agents_home.join("skills"));
    }

    let skill_commands = skill_roots
        .iter()
        .flat_map(|root| read_skill_root(root, None, 0))
        .collect::<Vec<_>>();
    let plugin_commands = codex_home
        .as_deref()
        .map(|home| home.join("plugins").join("cache"))
        .into_iter()
        .flat_map(|root| plugin_manifest_files(&root, CODEX_PLUGIN_MANIFEST_DIR))
        .flat_map(|manifest_path| read_plugin_commands(&manifest_path))
        .collect::<Vec<_>>();

    merge_provider_slash_commands([skill_commands, plugin_commands])
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

fn is_valid_command_name(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    value.len() <= COMMAND_NAME_MAX_LEN
        && first.is_ascii_alphanumeric()
        && chars.all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | ':' | '-'))
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .or_else(|| std::env::var_os("USERPROFILE").filter(|value| !value.is_empty()))
        .map(PathBuf::from)
}

fn safe_read_dir(path: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(path) else {
        return Vec::new();
    };
    let mut entries = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .collect::<Vec<_>>();
    entries.sort();
    entries
}

fn safe_read_to_string(path: &Path) -> Option<String> {
    fs::read_to_string(path).ok()
}

fn is_directory(path: &Path) -> bool {
    path.is_dir()
}

fn frontmatter_field(markdown: &str, field: &str) -> Option<String> {
    let body = markdown.strip_prefix("---\n")?.split_once("\n---")?.0;
    body.lines()
        .find_map(|line| {
            let (key, value) = line.split_once(':')?;
            (key.trim() == field).then(|| value.trim().trim_matches(['"', '\'']).trim().to_string())
        })
        .filter(|value| !value.is_empty())
}

fn read_skill_command(skill_dir: &Path, prefix: Option<&str>) -> Option<ProviderSlashCommand> {
    let markdown = safe_read_to_string(&skill_dir.join(SKILL_FILE_NAME))?;
    let raw_name = frontmatter_field(&markdown, "name").or_else(|| {
        skill_dir
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
    })?;
    let skill_name = normalize_discovered_command_name(&raw_name)?;
    let command_name = prefix
        .map(|prefix| format!("{prefix}:{skill_name}"))
        .unwrap_or_else(|| skill_name.clone());
    let description =
        frontmatter_field(&markdown, "description").or_else(|| Some(format!("Use {command_name}")));
    Some(provider_skill_slash_command(
        ProviderExtensionCommandInput {
            name: command_name.clone(),
            description,
            prompt_prefix: Some(format!("${command_name}")),
            input_hint: Some("<prompt>".to_string()),
        },
    ))
}

fn read_skill_root(root: &Path, prefix: Option<&str>, depth: usize) -> Vec<ProviderSlashCommand> {
    if !is_directory(root) {
        return Vec::new();
    }
    let mut commands = Vec::new();
    for entry in safe_read_dir(root) {
        if let Some(command) = read_skill_command(&entry, prefix) {
            commands.push(command);
        } else if depth < SKILL_ROOT_MAX_NESTED_DEPTH && is_directory(&entry) {
            commands.extend(read_skill_root(&entry, prefix, depth + 1));
        }
    }
    commands
}

fn plugin_manifest_files(root: &Path, manifest_dir_name: &str) -> Vec<PathBuf> {
    fn visit(dir: &Path, manifest_dir_name: &str, depth: usize, manifests: &mut Vec<PathBuf>) {
        if depth > PLUGIN_MANIFEST_MAX_DEPTH || !is_directory(dir) {
            return;
        }
        let manifest_path = dir.join(manifest_dir_name).join("plugin.json");
        if manifest_path.is_file() {
            manifests.push(manifest_path);
            return;
        }
        for child in safe_read_dir(dir) {
            if is_directory(&child) {
                visit(&child, manifest_dir_name, depth + 1, manifests);
            }
        }
    }

    let mut manifests = Vec::new();
    visit(root, manifest_dir_name, 0, &mut manifests);
    manifests
}

fn read_plugin_commands(plugin_manifest_path: &Path) -> Vec<ProviderSlashCommand> {
    let Some(raw) = safe_read_to_string(plugin_manifest_path) else {
        return Vec::new();
    };
    let Ok(manifest) = serde_json::from_str::<PluginManifest>(&raw) else {
        return Vec::new();
    };
    let Some(plugin_root) = plugin_manifest_path.parent().and_then(Path::parent) else {
        return Vec::new();
    };
    let Some(raw_plugin_name) = manifest
        .name
        .as_deref()
        .map(ToString::to_string)
        .or_else(|| {
            plugin_root
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
        })
    else {
        return Vec::new();
    };
    let Some(plugin_name) = normalize_discovered_command_name(&raw_plugin_name) else {
        return Vec::new();
    };

    let description = manifest
        .interface_config
        .as_ref()
        .and_then(|interface| interface.short_description.clone())
        .or_else(|| {
            manifest
                .interface_config
                .as_ref()
                .and_then(|interface| interface.long_description.clone())
        })
        .or_else(|| manifest.description.clone())
        .or_else(|| Some(format!("Use {plugin_name}")));

    let mut commands = vec![provider_plugin_slash_command(
        ProviderExtensionCommandInput {
            name: plugin_name.clone(),
            description,
            prompt_prefix: Some(format!("@{plugin_name}")),
            input_hint: Some("<prompt>".to_string()),
        },
    )];

    if let Some(skills_root) = manifest
        .skills
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        commands.extend(read_skill_root(
            &plugin_root.join(skills_root),
            Some(&plugin_name),
            0,
        ));
    }

    commands
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
    use std::fs;

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

    #[test]
    fn discovers_codex_project_user_and_plugin_extension_commands() {
        let temp = tempfile::tempdir().expect("tempdir");
        let cwd = temp.path().join("repo");
        let codex_home = temp.path().join("codex-home");
        let agents_home = temp.path().join("agents-home");

        write_skill(
            &cwd.join(".codex").join("skills").join("review"),
            r#"---
name: review-code
description: Review code changes
---
# Review Code
"#,
        );
        write_skill(
            &agents_home.join("skills").join("deploy"),
            r#"---
description: Deploy carefully
---
# Deploy
"#,
        );

        let plugin_root = codex_home
            .join("plugins")
            .join("cache")
            .join("openai-bundled")
            .join("browser");
        fs::create_dir_all(plugin_root.join(".codex-plugin")).expect("plugin manifest dir");
        fs::write(
            plugin_root.join(".codex-plugin").join("plugin.json"),
            r#"{
  "name": "browser-use",
  "description": "Browser automation",
  "skills": "skills",
  "interface": { "shortDescription": "Use browser automation" }
}"#,
        )
        .expect("plugin manifest");
        write_skill(
            &plugin_root.join("skills").join("browser"),
            r#"---
description: Primary browser skill
---
# Browser
"#,
        );
        write_skill(
            &plugin_root.join("skills").join("inspect-page"),
            r#"---
description: Inspect a page
---
# Inspect Page
"#,
        );

        let commands = discover_codex_extension_slash_commands(CodexExtensionDiscoveryOptions {
            cwd: Some(cwd),
            codex_home: Some(codex_home),
            agents_home: Some(agents_home),
        });
        let names = commands
            .iter()
            .map(|command| command.name.as_str())
            .collect::<Vec<_>>();

        assert!(names.contains(&"review-code"));
        assert!(names.contains(&"deploy"));
        assert!(names.contains(&"browser-use"));
        assert!(!names.contains(&"browser-use:browser"));
        assert!(names.contains(&"browser-use:inspect-page"));

        let plugin = commands
            .iter()
            .find(|command| command.name == "browser-use")
            .expect("plugin command");
        assert_eq!(plugin.kind, Some(ProviderSlashCommandKind::Plugin));
        assert_eq!(plugin.prompt_prefix.as_deref(), Some("@browser-use"));
        assert_eq!(
            plugin.description.as_deref(),
            Some("Use browser automation")
        );

        let skill = commands
            .iter()
            .find(|command| command.name == "browser-use:inspect-page")
            .expect("plugin skill");
        assert_eq!(skill.kind, Some(ProviderSlashCommandKind::Skill));
        assert_eq!(
            skill.prompt_prefix.as_deref(),
            Some("$browser-use:inspect-page")
        );
    }

    #[test]
    fn discovery_ignores_bad_manifests_and_invalid_names() {
        let temp = tempfile::tempdir().expect("tempdir");
        let codex_home = temp.path().join("codex-home");
        let bad_plugin = codex_home.join("plugins").join("cache").join("bad-plugin");
        fs::create_dir_all(bad_plugin.join(".codex-plugin")).expect("bad plugin manifest dir");
        fs::write(
            bad_plugin.join(".codex-plugin").join("plugin.json"),
            "{ not json",
        )
        .expect("bad manifest");
        write_skill(
            &codex_home.join("skills").join("bad skill"),
            r#"---
name: bad/skill
description: Invalid name
---
"#,
        );

        let commands = discover_codex_extension_slash_commands(CodexExtensionDiscoveryOptions {
            cwd: None,
            codex_home: Some(codex_home),
            agents_home: Some(temp.path().join("empty-agents-home")),
        });

        assert!(commands.is_empty());
    }

    fn write_skill(dir: &Path, markdown: &str) {
        fs::create_dir_all(dir).expect("skill dir");
        fs::write(dir.join(SKILL_FILE_NAME), markdown).expect("skill file");
    }
}
