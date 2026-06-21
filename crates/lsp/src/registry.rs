use crate::{
    LspError, Result,
    types::{
        LspInstallProvider, LspInstallResult, LspToolDefinition, LspToolStatus, LspToolStatusKind,
    },
};
use ace_process::{CommandRequest, ProcessRunner};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{Arc, RwLock},
};

#[derive(Debug, Clone)]
pub struct LspToolRegistry {
    custom_dir: PathBuf,
    definitions: Arc<RwLock<BTreeMap<String, LspToolDefinition>>>,
}

impl LspToolRegistry {
    pub fn new(custom_dir: PathBuf) -> Result<Self> {
        std::fs::create_dir_all(&custom_dir)?;
        let registry = Self {
            custom_dir,
            definitions: Arc::new(RwLock::new(BTreeMap::new())),
        };
        registry.load_builtins();
        registry.load_custom_definitions()?;
        Ok(registry)
    }

    #[must_use]
    pub fn in_memory() -> Self {
        let registry = Self {
            custom_dir: PathBuf::new(),
            definitions: Arc::new(RwLock::new(BTreeMap::new())),
        };
        registry.load_builtins();
        registry
    }

    pub fn list(&self) -> Vec<LspToolDefinition> {
        self.definitions
            .read()
            .expect("registry")
            .values()
            .cloned()
            .collect()
    }

    pub fn get(&self, id: &str) -> Option<LspToolDefinition> {
        self.definitions.read().expect("registry").get(id).cloned()
    }

    pub fn search(&self, query: &str) -> Vec<LspToolDefinition> {
        let query = query.trim().to_lowercase();
        self.list()
            .into_iter()
            .filter(|definition| {
                query.is_empty()
                    || definition.id.contains(&query)
                    || definition.display_name.to_lowercase().contains(&query)
                    || definition
                        .languages
                        .iter()
                        .any(|language| language.to_lowercase().contains(&query))
            })
            .collect()
    }

    pub fn match_file(
        &self,
        relative_path: &str,
        language_id: Option<&str>,
    ) -> Vec<LspToolDefinition> {
        let extension = Path::new(relative_path)
            .extension()
            .and_then(|extension| extension.to_str())
            .map(str::to_lowercase);
        self.list()
            .into_iter()
            .filter(|definition| {
                language_id.is_some_and(|language| {
                    definition
                        .languages
                        .iter()
                        .any(|candidate| candidate.eq_ignore_ascii_case(language))
                }) || extension.as_ref().is_some_and(|extension| {
                    definition
                        .file_extensions
                        .iter()
                        .any(|candidate| candidate.eq_ignore_ascii_case(extension))
                })
            })
            .collect()
    }

    pub fn status(&self, tool_id: &str) -> Result<LspToolStatus> {
        let definition = self
            .get(tool_id)
            .ok_or_else(|| LspError::UnknownTool(tool_id.to_string()))?;
        let resolved_command = which::which(&definition.command).ok();
        let status = if resolved_command.is_some() {
            LspToolStatusKind::Installed
        } else {
            LspToolStatusKind::Missing
        };
        Ok(LspToolStatus {
            definition,
            status,
            resolved_command,
        })
    }

    pub async fn install<R: ProcessRunner>(
        &self,
        runner: &R,
        tool_id: &str,
    ) -> Result<LspInstallResult> {
        let definition = self
            .get(tool_id)
            .ok_or_else(|| LspError::UnknownTool(tool_id.to_string()))?;
        let (command, args) = install_command(&definition)?;
        let output = runner
            .run(CommandRequest::new(&command).args(args.clone()))
            .await?;
        Ok(LspInstallResult {
            tool_id: tool_id.to_string(),
            command,
            args,
            status: output.status,
            stdout: output.stdout_string(),
            stderr: output.stderr_string(),
        })
    }

    pub fn upsert_custom(&self, definition: LspToolDefinition) -> Result<LspToolDefinition> {
        validate_definition(&definition)?;
        self.definitions
            .write()
            .expect("registry")
            .insert(definition.id.clone(), definition.clone());
        if !self.custom_dir.as_os_str().is_empty() {
            let path = self.custom_path(&definition.id)?;
            std::fs::write(path, serde_json::to_vec_pretty(&definition)?)?;
        }
        Ok(definition)
    }

    pub fn uninstall_custom(&self, tool_id: &str) -> Result<bool> {
        let removed = self
            .definitions
            .write()
            .expect("registry")
            .remove(tool_id)
            .is_some();
        if !self.custom_dir.as_os_str().is_empty() {
            let path = self.custom_path(tool_id)?;
            if path.exists() {
                std::fs::remove_file(path)?;
            }
        }
        Ok(removed)
    }

    fn load_builtins(&self) {
        let mut definitions = self.definitions.write().expect("registry");
        for definition in builtin_definitions() {
            definitions.insert(definition.id.clone(), definition);
        }
    }

    fn load_custom_definitions(&self) -> Result<()> {
        if self.custom_dir.as_os_str().is_empty() {
            return Ok(());
        }
        for entry in std::fs::read_dir(&self.custom_dir)? {
            let entry = entry?;
            if entry.path().extension().and_then(|ext| ext.to_str()) != Some("json") {
                continue;
            }
            let definition: LspToolDefinition =
                serde_json::from_slice(&std::fs::read(entry.path())?)?;
            validate_definition(&definition)?;
            self.definitions
                .write()
                .expect("registry")
                .insert(definition.id.clone(), definition);
        }
        Ok(())
    }

    fn custom_path(&self, id: &str) -> Result<PathBuf> {
        if id.contains('/') || id.contains('\\') || id.contains("..") {
            return Err(LspError::InvalidToolDefinition(id.to_string()));
        }
        Ok(self.custom_dir.join(format!("{id}.json")))
    }
}

pub fn install_command(definition: &LspToolDefinition) -> Result<(String, Vec<String>)> {
    if definition.install_args.is_empty() {
        return Err(LspError::InvalidToolDefinition(definition.id.clone()));
    }
    let (command, mut prefix): (&str, Vec<String>) = match definition.install_provider {
        LspInstallProvider::Npm => ("npm", vec!["install".to_string(), "-g".to_string()]),
        LspInstallProvider::UvTool => ("uv", vec!["tool".to_string(), "install".to_string()]),
        LspInstallProvider::GoInstall => ("go", vec!["install".to_string()]),
        LspInstallProvider::Rustup => ("rustup", vec!["component".to_string(), "add".to_string()]),
        LspInstallProvider::Custom => (&definition.command, Vec::new()),
    };
    prefix.extend(definition.install_args.clone());
    Ok((command.to_string(), prefix))
}

fn validate_definition(definition: &LspToolDefinition) -> Result<()> {
    if definition.id.trim().is_empty()
        || definition.command.trim().is_empty()
        || definition.languages.is_empty()
    {
        return Err(LspError::InvalidToolDefinition(definition.id.clone()));
    }
    Ok(())
}

fn builtin_definitions() -> Vec<LspToolDefinition> {
    vec![
        npm(
            "typescript-language-server",
            "TypeScript",
            &["typescript", "javascript"],
            &["ts", "tsx", "js", "jsx"],
            "typescript-language-server",
            &["typescript-language-server", "typescript"],
        ),
        npm(
            "vscode-langservers-extracted",
            "HTML/CSS/JSON/ESLint",
            &["html", "css", "json"],
            &["html", "css", "json"],
            "vscode-html-language-server",
            &["vscode-langservers-extracted"],
        ),
        rustup(
            "rust-analyzer",
            "Rust Analyzer",
            &["rust"],
            &["rs"],
            "rust-analyzer",
            &["rust-analyzer"],
        ),
        go_install(
            "gopls",
            "Go",
            &["go"],
            &["go"],
            "gopls",
            &["golang.org/x/tools/gopls@latest"],
        ),
        uv_tool(
            "pyright",
            "Pyright",
            &["python"],
            &["py"],
            "pyright-langserver",
            &["pyright"],
        ),
    ]
}

fn npm(
    id: &str,
    display_name: &str,
    languages: &[&str],
    extensions: &[&str],
    command: &str,
    install_args: &[&str],
) -> LspToolDefinition {
    definition(
        id,
        display_name,
        languages,
        extensions,
        command,
        LspInstallProvider::Npm,
        install_args,
    )
}

fn uv_tool(
    id: &str,
    display_name: &str,
    languages: &[&str],
    extensions: &[&str],
    command: &str,
    install_args: &[&str],
) -> LspToolDefinition {
    definition(
        id,
        display_name,
        languages,
        extensions,
        command,
        LspInstallProvider::UvTool,
        install_args,
    )
}

fn go_install(
    id: &str,
    display_name: &str,
    languages: &[&str],
    extensions: &[&str],
    command: &str,
    install_args: &[&str],
) -> LspToolDefinition {
    definition(
        id,
        display_name,
        languages,
        extensions,
        command,
        LspInstallProvider::GoInstall,
        install_args,
    )
}

fn rustup(
    id: &str,
    display_name: &str,
    languages: &[&str],
    extensions: &[&str],
    command: &str,
    install_args: &[&str],
) -> LspToolDefinition {
    definition(
        id,
        display_name,
        languages,
        extensions,
        command,
        LspInstallProvider::Rustup,
        install_args,
    )
}

fn definition(
    id: &str,
    display_name: &str,
    languages: &[&str],
    extensions: &[&str],
    command: &str,
    install_provider: LspInstallProvider,
    install_args: &[&str],
) -> LspToolDefinition {
    LspToolDefinition {
        id: id.to_string(),
        display_name: display_name.to_string(),
        languages: languages
            .iter()
            .map(|language| (*language).to_string())
            .collect(),
        file_extensions: extensions
            .iter()
            .map(|extension| (*extension).to_string())
            .collect(),
        command: command.to_string(),
        args: Vec::new(),
        install_provider,
        install_args: install_args.iter().map(|arg| (*arg).to_string()).collect(),
        env: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ace_process::{CommandOutput, CommandRequest};
    use async_trait::async_trait;
    use std::sync::Mutex;

    #[derive(Default)]
    struct FakeRunner {
        requests: Mutex<Vec<CommandRequest>>,
    }

    #[async_trait]
    impl ProcessRunner for FakeRunner {
        async fn run(&self, request: CommandRequest) -> ace_process::Result<CommandOutput> {
            self.requests.lock().expect("requests").push(request);
            Ok(CommandOutput {
                status: 0,
                stdout: b"ok".to_vec(),
                stderr: Vec::new(),
            })
        }
    }

    #[test]
    fn matches_tools_by_extension_and_language() {
        let registry = LspToolRegistry::in_memory();
        assert!(
            registry
                .match_file("src/main.rs", None)
                .iter()
                .any(|tool| tool.id == "rust-analyzer")
        );
        assert!(
            registry
                .match_file("Makefile", Some("typescript"))
                .iter()
                .any(|tool| tool.id == "typescript-language-server")
        );
    }

    #[test]
    fn builds_installer_commands() {
        let registry = LspToolRegistry::in_memory();
        let ts = registry
            .get("typescript-language-server")
            .expect("typescript");
        let (command, args) = install_command(&ts).expect("command");
        assert_eq!(command, "npm");
        assert_eq!(args[0], "install");
        assert!(args.iter().any(|arg| arg == "typescript-language-server"));
    }

    #[tokio::test]
    async fn install_uses_process_runner() {
        let runner = FakeRunner::default();
        let registry = LspToolRegistry::in_memory();
        let result = registry
            .install(&runner, "rust-analyzer")
            .await
            .expect("install");
        assert_eq!(result.command, "rustup");
        assert_eq!(runner.requests.lock().expect("requests").len(), 1);
    }

    #[test]
    fn persists_custom_definitions() {
        let temp = tempfile::tempdir().expect("tempdir");
        let registry = LspToolRegistry::new(temp.path().to_path_buf()).expect("registry");
        registry
            .upsert_custom(LspToolDefinition {
                id: "custom-ls".to_string(),
                display_name: "Custom".to_string(),
                languages: vec!["custom".to_string()],
                file_extensions: vec!["cust".to_string()],
                command: "custom-ls".to_string(),
                args: Vec::new(),
                install_provider: LspInstallProvider::Custom,
                install_args: vec!["install".to_string()],
                env: Vec::new(),
            })
            .expect("upsert");
        let loaded = LspToolRegistry::new(temp.path().to_path_buf()).expect("reload");
        assert!(loaded.get("custom-ls").is_some());
    }
}
