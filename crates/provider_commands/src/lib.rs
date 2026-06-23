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
const CLAUDE_PLUGIN_MANIFEST_DIR: &str = ".claude-plugin";

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

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProviderExtensionDiscoveryOptions {
    pub cwd: Option<PathBuf>,
    pub provider_home: Option<PathBuf>,
    pub agents_home: Option<PathBuf>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GenericProviderExtensionDiscoveryOptions {
    pub cwd: Option<PathBuf>,
    pub provider_home: Option<PathBuf>,
    pub config_home: Option<PathBuf>,
    pub agents_home: Option<PathBuf>,
    pub provider_home_dir_name: String,
    pub plugin_manifest_dir_name: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct PluginManifest {
    name: Option<String>,
    description: Option<String>,
    skills: Option<String>,
    commands: Option<String>,
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
        .flat_map(|manifest_path| read_plugin_commands(&manifest_path, PluginReadMode::Codex))
        .collect::<Vec<_>>();

    merge_provider_slash_commands([skill_commands, plugin_commands])
}

#[must_use]
pub fn discover_claude_extension_slash_commands(
    options: ProviderExtensionDiscoveryOptions,
) -> Vec<ProviderSlashCommand> {
    let claude_home = options
        .provider_home
        .or_else(|| home_dir().map(|home| home.join(".claude")));
    let agents_home = options
        .agents_home
        .or_else(|| home_dir().map(|home| home.join(".agents")));

    let skill_commands = discover_skill_root_slash_commands(
        &[
            options
                .cwd
                .as_deref()
                .map(|cwd| cwd.join(".claude").join("skills")),
            options
                .cwd
                .as_deref()
                .map(|cwd| cwd.join(".agents").join("skills")),
            claude_home.as_deref().map(|home| home.join("skills")),
            agents_home.as_deref().map(|home| home.join("skills")),
        ],
        SkillPromptMode::Natural,
    );
    let plugin_commands = claude_home
        .as_deref()
        .map(|home| home.join("plugins").join("installed_plugins.json"))
        .into_iter()
        .flat_map(read_claude_installed_plugin_commands)
        .collect::<Vec<_>>();

    merge_provider_slash_commands([skill_commands, plugin_commands])
}

#[must_use]
pub fn discover_generic_provider_extension_slash_commands(
    options: GenericProviderExtensionDiscoveryOptions,
) -> Vec<ProviderSlashCommand> {
    let provider_home_dir_name =
        nonempty_string(options.provider_home_dir_name).unwrap_or_else(|| ".provider".to_string());
    let provider_home = options.provider_home.or(options.config_home).or_else(|| {
        home_dir().map(|home| {
            if provider_home_dir_name.starts_with('.') {
                home.join(&provider_home_dir_name)
            } else {
                home.join(format!(".{provider_home_dir_name}"))
            }
        })
    });
    let agents_home = options
        .agents_home
        .or_else(|| home_dir().map(|home| home.join(".agents")));
    let skill_commands = discover_skill_root_slash_commands(
        &[
            options
                .cwd
                .as_deref()
                .map(|cwd| cwd.join(&provider_home_dir_name).join("skills")),
            options
                .cwd
                .as_deref()
                .map(|cwd| cwd.join(".agents").join("skills")),
            provider_home.as_deref().map(|home| home.join("skills")),
            agents_home.as_deref().map(|home| home.join("skills")),
        ],
        SkillPromptMode::Natural,
    );
    let plugin_commands = match options.plugin_manifest_dir_name.as_deref() {
        Some(manifest_dir_name) => provider_home
            .as_deref()
            .map(|home| home.join("plugins"))
            .into_iter()
            .flat_map(|root| plugin_manifest_files(&root, manifest_dir_name))
            .flat_map(|manifest_path| {
                read_plugin_commands(&manifest_path, PluginReadMode::NaturalWithMarkdownCommands)
            })
            .collect::<Vec<_>>(),
        None => Vec::new(),
    };

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

fn nonempty_string(value: String) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SkillPromptMode {
    Dollar,
    Natural,
}

fn read_skill_command_with_mode(
    skill_dir: &Path,
    prefix: Option<&str>,
    mode: SkillPromptMode,
) -> Option<ProviderSlashCommand> {
    let mut command = read_skill_command(skill_dir, prefix)?;
    if mode == SkillPromptMode::Natural {
        let skill_name = command.name.rsplit(':').next().unwrap_or(&command.name);
        command.prompt_prefix = Some(match prefix {
            Some(plugin_name) => {
                format!("Use the {skill_name} skill from the {plugin_name} plugin:")
            }
            None => format!("Use the {skill_name} skill:"),
        });
    }
    Some(command)
}

fn read_skill_root(root: &Path, prefix: Option<&str>, depth: usize) -> Vec<ProviderSlashCommand> {
    read_skill_root_with_mode(root, prefix, depth, SkillPromptMode::Dollar)
}

fn read_skill_root_with_mode(
    root: &Path,
    prefix: Option<&str>,
    depth: usize,
    mode: SkillPromptMode,
) -> Vec<ProviderSlashCommand> {
    if !is_directory(root) {
        return Vec::new();
    }
    let mut commands = Vec::new();
    for entry in safe_read_dir(root) {
        if let Some(command) = read_skill_command_with_mode(&entry, prefix, mode) {
            commands.push(command);
        } else if depth < SKILL_ROOT_MAX_NESTED_DEPTH && is_directory(&entry) {
            commands.extend(read_skill_root_with_mode(&entry, prefix, depth + 1, mode));
        }
    }
    commands
}

fn discover_skill_root_slash_commands(
    roots: &[Option<PathBuf>],
    mode: SkillPromptMode,
) -> Vec<ProviderSlashCommand> {
    merge_provider_slash_commands(
        roots
            .iter()
            .filter_map(Option::as_deref)
            .map(|root| read_skill_root_with_mode(root, None, 0, mode)),
    )
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PluginReadMode {
    Codex,
    NaturalWithMarkdownCommands,
}

fn read_plugin_commands(
    plugin_manifest_path: &Path,
    mode: PluginReadMode,
) -> Vec<ProviderSlashCommand> {
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

    let plugin_prompt_prefix = match mode {
        PluginReadMode::Codex => format!("@{plugin_name}"),
        PluginReadMode::NaturalWithMarkdownCommands => format!("Use the {plugin_name} plugin."),
    };
    let skill_prompt_mode = match mode {
        PluginReadMode::Codex => SkillPromptMode::Dollar,
        PluginReadMode::NaturalWithMarkdownCommands => SkillPromptMode::Natural,
    };

    let mut commands = vec![provider_plugin_slash_command(
        ProviderExtensionCommandInput {
            name: plugin_name.clone(),
            description,
            prompt_prefix: Some(plugin_prompt_prefix),
            input_hint: Some("<prompt>".to_string()),
        },
    )];

    if let Some(skills_root) = manifest
        .skills
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        commands.extend(read_skill_root_with_mode(
            &plugin_root.join(skills_root),
            Some(&plugin_name),
            0,
            skill_prompt_mode,
        ));
    }
    if mode == PluginReadMode::NaturalWithMarkdownCommands
        && let Some(commands_root) = manifest
            .commands
            .as_deref()
            .filter(|value| !value.trim().is_empty())
    {
        commands.extend(read_plugin_markdown_command_root(
            &plugin_root.join(commands_root),
            &plugin_name,
        ));
    }

    commands
}

#[derive(Debug, Deserialize)]
struct ClaudeInstalledPlugins {
    #[serde(default)]
    plugins: std::collections::BTreeMap<String, Vec<ClaudeInstalledPluginEntry>>,
}

#[derive(Debug, Deserialize)]
struct ClaudeInstalledPluginEntry {
    #[serde(rename = "installPath")]
    install_path: Option<PathBuf>,
}

fn read_claude_installed_plugin_commands(
    installed_plugins_path: PathBuf,
) -> Vec<ProviderSlashCommand> {
    let Some(raw) = safe_read_to_string(&installed_plugins_path) else {
        return Vec::new();
    };
    let Ok(installed) = serde_json::from_str::<ClaudeInstalledPlugins>(&raw) else {
        return Vec::new();
    };
    installed
        .plugins
        .into_iter()
        .flat_map(|(identity, installs)| {
            let fallback_name = identity.split('@').next().unwrap_or_default().to_string();
            installs.into_iter().filter_map(move |entry| {
                let install_path = entry.install_path?;
                let manifest_path = install_path
                    .join(CLAUDE_PLUGIN_MANIFEST_DIR)
                    .join("plugin.json");
                let mut commands = read_plugin_commands(
                    &manifest_path,
                    PluginReadMode::NaturalWithMarkdownCommands,
                );
                if commands.is_empty() {
                    commands = read_plugin_commands_from_root_with_fallback_name(
                        &install_path,
                        CLAUDE_PLUGIN_MANIFEST_DIR,
                        &fallback_name,
                        PluginReadMode::NaturalWithMarkdownCommands,
                    );
                }
                Some(commands)
            })
        })
        .flatten()
        .collect()
}

fn read_plugin_commands_from_root_with_fallback_name(
    plugin_root: &Path,
    manifest_dir_name: &str,
    fallback_name: &str,
    mode: PluginReadMode,
) -> Vec<ProviderSlashCommand> {
    let manifest_path = plugin_root.join(manifest_dir_name).join("plugin.json");
    let commands = read_plugin_commands(&manifest_path, mode);
    if !commands.is_empty() {
        return commands;
    }
    let Some(plugin_name) = normalize_discovered_command_name(fallback_name) else {
        return Vec::new();
    };
    vec![provider_plugin_slash_command(
        ProviderExtensionCommandInput {
            name: plugin_name.clone(),
            description: Some(format!("Use {plugin_name}")),
            prompt_prefix: Some(format!("Use the {plugin_name} plugin.")),
            input_hint: Some("<prompt>".to_string()),
        },
    )]
}

fn read_plugin_markdown_command_root(root: &Path, plugin_name: &str) -> Vec<ProviderSlashCommand> {
    if !is_directory(root) {
        return Vec::new();
    }
    safe_read_dir(root)
        .into_iter()
        .filter_map(|file| read_plugin_markdown_command(&file, plugin_name))
        .collect()
}

fn read_plugin_markdown_command(file: &Path, plugin_name: &str) -> Option<ProviderSlashCommand> {
    if file.extension().and_then(|extension| extension.to_str()) != Some("md") {
        return None;
    }
    let raw_name = file.file_stem()?.to_string_lossy();
    if raw_name.starts_with('_') {
        return None;
    }
    let command_name = normalize_discovered_command_name(&raw_name)?;
    let markdown = safe_read_to_string(file)?;
    let name = format!("{plugin_name}:{command_name}");
    Some(provider_plugin_slash_command(
        ProviderExtensionCommandInput {
            name: name.clone(),
            description: frontmatter_field(&markdown, "description")
                .or_else(|| first_markdown_heading(&markdown)),
            prompt_prefix: Some(format!("/{name}")),
            input_hint: Some("<prompt>".to_string()),
        },
    ))
}

fn first_markdown_heading(markdown: &str) -> Option<String> {
    markdown.lines().find_map(|line| {
        line.trim_start()
            .strip_prefix("# ")
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string)
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
    fn discovers_claude_skills_plugins_and_markdown_commands() {
        let temp = tempfile::tempdir().expect("tempdir");
        let cwd = temp.path().join("repo");
        let claude_home = temp.path().join("claude-home");
        let agents_home = temp.path().join("agents-home");
        write_skill(
            &cwd.join(".claude").join("skills").join("audit"),
            "---\ndescription: Audit code\n---\n# Audit\n",
        );

        let plugin_root = temp.path().join("installed").join("acme-plugin");
        fs::create_dir_all(plugin_root.join(".claude-plugin")).expect("plugin manifest dir");
        fs::write(
            plugin_root.join(".claude-plugin").join("plugin.json"),
            r#"{
  "name": "acme-plugin",
  "description": "Acme plugin",
  "skills": "skills",
  "commands": "commands"
}"#,
        )
        .expect("plugin manifest");
        write_skill(
            &plugin_root.join("skills").join("deploy-review"),
            "---\ndescription: Review deploy\n---\n# Deploy Review\n",
        );
        fs::create_dir_all(plugin_root.join("commands")).expect("plugin commands dir");
        fs::write(
            plugin_root.join("commands").join("deploy.md"),
            "---\ndescription: Deploy command\n---\n# Deploy\n",
        )
        .expect("plugin command");
        fs::create_dir_all(claude_home.join("plugins")).expect("claude plugins dir");
        fs::write(
            claude_home.join("plugins").join("installed_plugins.json"),
            serde_json::json!({
                "plugins": {
                    "acme-plugin@marketplace": [
                        { "installPath": plugin_root }
                    ]
                }
            })
            .to_string(),
        )
        .expect("installed plugins");

        let commands =
            discover_claude_extension_slash_commands(ProviderExtensionDiscoveryOptions {
                cwd: Some(cwd),
                provider_home: Some(claude_home),
                agents_home: Some(agents_home),
            });
        let names = commands
            .iter()
            .map(|command| command.name.as_str())
            .collect::<Vec<_>>();
        assert!(names.contains(&"audit"));
        assert!(names.contains(&"acme-plugin"));
        assert!(names.contains(&"acme-plugin:deploy-review"));
        assert!(names.contains(&"acme-plugin:deploy"));

        let plugin = commands
            .iter()
            .find(|command| command.name == "acme-plugin")
            .expect("plugin");
        assert_eq!(
            plugin.prompt_prefix.as_deref(),
            Some("Use the acme-plugin plugin.")
        );
        let plugin_skill = commands
            .iter()
            .find(|command| command.name == "acme-plugin:deploy-review")
            .expect("plugin skill");
        assert_eq!(
            plugin_skill.prompt_prefix.as_deref(),
            Some("Use the deploy-review skill from the acme-plugin plugin:")
        );
        let plugin_command = commands
            .iter()
            .find(|command| command.name == "acme-plugin:deploy")
            .expect("plugin command");
        assert_eq!(plugin_command.kind, Some(ProviderSlashCommandKind::Plugin));
        assert_eq!(
            plugin_command.prompt_prefix.as_deref(),
            Some("/acme-plugin:deploy")
        );
    }

    #[test]
    fn discovers_generic_provider_skills_and_plugins() {
        let temp = tempfile::tempdir().expect("tempdir");
        let provider_home = temp.path().join("cursor-home");
        let agents_home = temp.path().join("agents-home");
        write_skill(
            &provider_home.join("skills").join("rules"),
            "---\ndescription: Use rules\n---\n# Rules\n",
        );

        let plugin_root = provider_home.join("plugins").join("rules-plugin");
        fs::create_dir_all(plugin_root.join(".cursor-plugin")).expect("plugin manifest dir");
        fs::write(
            plugin_root.join(".cursor-plugin").join("plugin.json"),
            r#"{
  "name": "rules-plugin",
  "description": "Rules plugin",
  "skills": "skills",
  "commands": "commands"
}"#,
        )
        .expect("plugin manifest");
        write_skill(
            &plugin_root.join("skills").join("lint"),
            "---\ndescription: Lint rules\n---\n# Lint\n",
        );
        fs::create_dir_all(plugin_root.join("commands")).expect("plugin commands dir");
        fs::write(plugin_root.join("commands").join("fix.md"), "# Fix\n").expect("plugin command");

        let commands = discover_generic_provider_extension_slash_commands(
            GenericProviderExtensionDiscoveryOptions {
                cwd: None,
                provider_home: Some(provider_home),
                config_home: None,
                agents_home: Some(agents_home),
                provider_home_dir_name: ".cursor".to_string(),
                plugin_manifest_dir_name: Some(".cursor-plugin".to_string()),
            },
        );
        let names = commands
            .iter()
            .map(|command| command.name.as_str())
            .collect::<Vec<_>>();
        assert!(names.contains(&"rules"));
        assert!(names.contains(&"rules-plugin"));
        assert!(names.contains(&"rules-plugin:lint"));
        assert!(names.contains(&"rules-plugin:fix"));
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
