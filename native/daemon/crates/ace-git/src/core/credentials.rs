// SPDX-License-Identifier: Apache-2.0
//! What an admitted transfer may borrow from the person's configuration
//! (`packages/git/src/credential-helpers.ts`, G2c): credential helpers and
//! `core.sshCommand` from their own system, XDG and global files only, never
//! from a file inside the checkout, its Git directory or a protected root.

use std::path::Path;

use ace_json::{Array, JsString, Map, Value};

use crate::core::error::{GitError, GitErrorCode};
use crate::core::spawn::BoxFuture;

/// A credential helper exactly as Git names it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CredentialHelper {
    pub key: String,
    pub value: String,
}

/// One `git config` answer the checks read.
#[derive(Debug, Clone)]
pub struct ConfigOutput {
    pub stdout: Vec<u8>,
    pub exit_code: i32,
    pub truncated: bool,
}

/// The shell runs the config queries; every argument list is Git's own.
pub trait TransportPorts: Send + Sync {
    fn query(&self, call: u64, args: &[String]) -> BoxFuture<'_, Result<ConfigOutput, GitError>>;
}

fn malformed(context: &str) -> GitError {
    GitError::new(
        GitErrorCode::MalformedOutput,
        format!("Malformed Git {context}"),
    )
}

/// The `-z` field values Git printed, refusing anything but a terminated listing.
pub fn values(output: &ConfigOutput) -> Result<Vec<String>, GitError> {
    if output.truncated {
        return Err(GitError::new(
            GitErrorCode::OutputTooLarge,
            "Credential helper configuration is too large",
        ));
    }
    if output.exit_code != 0 && output.exit_code != 1 {
        return Err(GitError::new(
            GitErrorCode::GitFailed,
            "Could not inspect user credential helper configuration",
        ));
    }
    let text = std::str::from_utf8(&output.stdout).map_err(|_| {
        GitError::new(
            GitErrorCode::MalformedOutput,
            "Invalid credential helper configuration encoding",
        )
    })?;
    if text.is_empty() {
        return Ok(Vec::new());
    }
    if output.exit_code != 0 || !text.ends_with('\0') {
        return Err(GitError::new(
            GitErrorCode::MalformedOutput,
            "Invalid credential helper configuration",
        ));
    }
    Ok(text[..text.len() - 1].split('\0').map(str::to_owned).collect())
}

/// Groups of `size` fields, e.g. origin and value from `--show-origin`.
pub fn records(output: &ConfigOutput, size: usize) -> Result<Vec<Vec<String>>, GitError> {
    let fields = values(output)?;
    if size == 0 || !fields.len().is_multiple_of(size) {
        return Err(malformed("user transport configuration"));
    }
    Ok(fields.chunks(size).map(<[String]>::to_vec).collect())
}

/// Paths that may not supply transport programs, canonical.
pub struct TrustedOrigin {
    roots: Vec<Option<String>>,
}

impl TrustedOrigin {
    pub fn new(untrusted_roots: &[String]) -> Self {
        Self {
            roots: untrusted_roots
                .iter()
                .map(|root| crate::core::paths::canonical(root).ok())
                .collect(),
        }
    }

    /// Whether `origin` is a file outside every untrusted root, following symbolic links.
    pub fn trusted(&self, origin: Option<&str>) -> bool {
        let Some(path) = origin.and_then(|origin| origin.strip_prefix("file:")) else {
            return false;
        };
        if !Path::new(path).is_absolute() {
            return false;
        }
        let Some(resolved) = crate::core::paths::canonical(path).ok() else {
            return false;
        };
        self.roots.iter().all(|root| match root {
            None => true,
            Some(root) => match resolved.strip_prefix(root.as_str()) {
                Some(rest) => !rest.starts_with(std::path::MAIN_SEPARATOR) && !rest.is_empty(),
                None => true,
            },
        })
    }
}

fn helper_key_ok(key: &str) -> bool {
    static PATTERN: std::sync::OnceLock<Option<regex::Regex>> = std::sync::OnceLock::new();
    let pattern =
        PATTERN.get_or_init(|| regex::Regex::new(r"^credential\.(?:[^\x00\n=]+\.)?helper$").ok());
    // A zod bound counts code points; the key's is 4,096.
    key.chars().count() <= 4_096
        && pattern
            .as_ref()
            .is_some_and(|pattern| pattern.is_match(key))
}

fn helper_value_ok(value: &str) -> bool {
    // The value's bound is 16,384 code points.
    value.chars().count() <= 16_384 && !value.contains('\0')
}

pub fn validate_helpers(helpers: Vec<CredentialHelper>) -> Result<Vec<CredentialHelper>, GitError> {
    if helpers.len() > 512
        || helpers
            .iter()
            .any(|helper| !helper_key_ok(&helper.key) || !helper_value_ok(&helper.value))
    {
        return Err(GitError::new(
            GitErrorCode::MalformedOutput,
            "Invalid user credential helper configuration",
        ));
    }
    Ok(helpers)
}

/// Helpers from one of the person's own config files, following its includes, as their Git would.
pub async fn read_credential_helpers(
    call: u64,
    ports: &dyn TransportPorts,
    file: &str,
    trusted: &TrustedOrigin,
) -> Result<Vec<CredentialHelper>, GitError> {
    let output = ports
        .query(call, &config_file_args(file, &["--get-regexp", "^credential\\.(.*\\.)?helper$"]))
        .await?;
    let mut ordered: Vec<CredentialHelper> = Vec::new();
    for entry in records(&output, 2)? {
        let separator = entry[1].find('\n').ok_or_else(|| {
            GitError::new(
                GitErrorCode::MalformedOutput,
                "Invalid credential helper configuration",
            )
        })?;
        if trusted.trusted(Some(&entry[0])) {
            ordered.push(CredentialHelper {
                key: entry[1][..separator].to_owned(),
                value: entry[1][separator + 1..].to_owned(),
            });
        }
    }
    validate_helpers(ordered)
}

/// `core.sshCommand` values from one of the person's own files, under the same trust rule.
pub async fn read_ssh_commands(
    call: u64,
    ports: &dyn TransportPorts,
    file: &str,
    trusted: &TrustedOrigin,
) -> Result<Vec<String>, GitError> {
    let output = ports
        .query(call, &config_file_args(file, &["--get-all", "core.sshCommand"]))
        .await?;
    Ok(records(&output, 2)?
        .into_iter()
        .filter(|entry| trusted.trusted(Some(&entry[0])))
        .map(|entry| entry[1].clone())
        .collect())
}

fn config_file_args(file: &str, tail: &[&str]) -> Vec<String> {
    let mut args = vec![
        "config".to_owned(),
        "--file".to_owned(),
        file.to_owned(),
        "--includes".to_owned(),
        "--show-origin".to_owned(),
        "--null".to_owned(),
    ];
    args.extend(tail.iter().map(|arg| (*arg).to_owned()));
    args
}

/// The repository's own `core.sshCommand` values (local and worktree scope), in Git's order.
pub async fn repository_ssh_commands(
    call: u64,
    ports: &dyn TransportPorts,
) -> Result<Vec<String>, GitError> {
    let output = ports
        .query(
            call,
            &[
                "config".to_owned(),
                "--show-scope".to_owned(),
                "--null".to_owned(),
                "--get-all".to_owned(),
                "core.sshCommand".to_owned(),
            ],
        )
        .await?;
    Ok(records(&output, 2)?
        .into_iter()
        .filter(|entry| entry[0] == "local" || entry[0] == "worktree")
        .map(|entry| entry[1].clone())
        .collect())
}

/// Git's compiled system file, pinned to system scope with includes disabled; found by any key a
/// transfer borrows from it. `Ok(None)` when it sets neither.
pub async fn system_credential_config_file(
    call: u64,
    ports: &dyn TransportPorts,
) -> Result<Option<String>, GitError> {
    let output = ports
        .query(
            call,
            &[
                "config".to_owned(),
                "--system".to_owned(),
                "--no-includes".to_owned(),
                "--null".to_owned(),
                "--show-origin".to_owned(),
                "--name-only".to_owned(),
                "--get-regexp".to_owned(),
                "^(credential\\.(.*\\.)?helper|core\\.sshcommand)$".to_owned(),
            ],
        )
        .await?;
    let entries = values(&output)?;
    let mut paths: Vec<String> = Vec::new();
    let mut index = 0;
    while index < entries.len() {
        let origin = entries.get(index).map(String::as_str);
        let key = entries.get(index + 1).map(String::as_str);
        index += 2;
        let (Some(origin), Some(key)) = (origin, key) else {
            return Err(malformed("system credential config origin"));
        };
        let path = origin
            .strip_prefix("file:")
            .filter(|path| !path.is_empty())
            .ok_or_else(|| malformed("system credential config origin"))?;
        if !(helper_key_ok(key) || key == "core.sshcommand") {
            return Err(malformed("system credential config origin"));
        }
        if !Path::new(path).is_absolute() {
            return Err(malformed("system credential config path"));
        }
        if !paths.iter().any(|known| known == path) {
            paths.push(path.to_owned());
        }
    }
    if paths.len() > 1 {
        return Err(malformed("system credential config origin"));
    }
    Ok(paths.into_iter().next())
}

/// What a transfer may use, from the person's own files.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TransportConfig {
    pub helpers: Vec<CredentialHelper>,
    pub ssh_command: Option<String>,
}

/// One `userTransportConfig` call.
#[derive(Debug, Clone)]
pub struct TransportRequest {
    pub call: u64,
    /// `Some` when the caller pinned the system file; `None` asks Git for it.
    pub system: Option<String>,
    pub files: Vec<Option<String>>,
    pub protected_roots: Vec<String>,
    pub helpers: bool,
    pub repository_ssh: bool,
}

pub async fn user_transport_config(
    ports: &dyn TransportPorts,
    request: &TransportRequest,
) -> Result<TransportConfig, GitError> {
    let mut files: Vec<String> = Vec::new();
    match &request.system {
        Some(system) => files.push(system.clone()),
        None => {
            if let Some(system) = system_credential_config_file(request.call, ports).await? {
                files.push(system);
            }
        }
    }
    let mut roots = Vec::new();
    for flag in ["--show-toplevel", "--git-common-dir"] {
        let output = ports
            .query(
                request.call,
                &[
                    "rev-parse".to_owned(),
                    "--path-format=absolute".to_owned(),
                    flag.to_owned(),
                ],
            )
            .await?;
        match single_path(&output) {
            Some(path) if Path::new(&path).is_absolute() && !output.truncated => roots.push(path),
            _ if flag == "--git-common-dir" => {
                return Err(GitError::new(
                    GitErrorCode::NotARepo,
                    "Could not locate the repository for a transfer",
                ));
            }
            _ => {}
        }
    }
    roots.extend(request.protected_roots.iter().cloned());
    let trusted = TrustedOrigin::new(&roots);
    let mut helpers = Vec::new();
    let mut commands = Vec::new();
    for file in &files {
        if !Path::new(file).exists() {
            continue;
        }
        if request.helpers {
            helpers.extend(read_credential_helpers(request.call, ports, file, &trusted).await?);
        }
        commands.extend(read_ssh_commands(request.call, ports, file, &trusted).await?);
    }
    for file in request.files.iter().flatten() {
        if !Path::new(file).exists() {
            continue;
        }
        if request.helpers {
            helpers.extend(read_credential_helpers(request.call, ports, file, &trusted).await?);
        }
        commands.extend(read_ssh_commands(request.call, ports, file, &trusted).await?);
    }
    if request.repository_ssh {
        commands.extend(repository_ssh_commands(request.call, ports).await?);
    }
    Ok(TransportConfig {
        helpers,
        // Git's last value wins; an empty value means plain ssh again.
        ssh_command: commands.into_iter().rev().find(|value| !value.is_empty()),
    })
}

fn single_path(output: &ConfigOutput) -> Option<String> {
    if output.exit_code != 0 {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).into_owned();
    Some(text.strip_suffix('\n').unwrap_or(&text).to_owned())
}

/// The answer frame: `{ helpers: [{key,value}], sshCommand: string|null }`.
pub fn transport_to_json(config: &TransportConfig) -> String {
    let helpers: Vec<Value> = config
        .helpers
        .iter()
        .map(|helper| {
            let mut map = Map::new();
            map.insert(JsString::from("key"), Value::from(helper.key.as_str()));
            map.insert(JsString::from("value"), Value::from(helper.value.as_str()));
            Value::Object(map)
        })
        .collect();
    let mut frame = Map::new();
    frame.insert(JsString::from("helpers"), Value::Array(Array::from(helpers)));
    frame.insert(
        JsString::from("sshCommand"),
        match &config.ssh_command {
            Some(command) => Value::from(command.as_str()),
            None => Value::Null,
        },
    );
    ace_json::to_string(&Value::Object(frame))
}

/// Reads the request frame `{callId, system, files, protectedRoots, helpers, repositorySsh}`.
pub fn request_from_json(text: &str) -> Option<TransportRequest> {
    let Value::Object(map) = ace_json::parse(text).ok()? else {
        return None;
    };
    let string = |key: &str| match map.get(key) {
        Some(Value::String(value)) => Some(value.to_string_lossy().into_owned()),
        _ => None,
    };
    let call = match map.get("callId") {
        Some(Value::Number(number)) => number.as_f64()? as u64,
        _ => return None,
    };
    let files = match map.get("files") {
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| match item {
                Value::String(file) => Some(Some(file.to_string_lossy().into_owned())),
                Value::Null => Some(None),
                _ => None,
            })
            .collect::<Option<Vec<_>>>()?,
        _ => Vec::new(),
    };
    let protected_roots = match map.get("protectedRoots") {
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| match item {
                Value::String(root) => Some(root.to_string_lossy().into_owned()),
                _ => None,
            })
            .collect::<Option<Vec<_>>>()?,
        _ => Vec::new(),
    };
    Some(TransportRequest {
        call,
        system: string("system"),
        files,
        protected_roots,
        helpers: matches!(map.get("helpers"), Some(Value::Bool(true))),
        repository_ssh: matches!(map.get("repositorySsh"), Some(Value::Bool(true))),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct FakePorts {
        answers: Mutex<Vec<ConfigOutput>>,
    }

    fn output(text: &str) -> ConfigOutput {
        ConfigOutput {
            stdout: text.as_bytes().to_vec(),
            exit_code: 0,
            truncated: false,
        }
    }

    impl TransportPorts for FakePorts {
        fn query(
            &self,
            _call: u64,
            _args: &[String],
        ) -> BoxFuture<'_, Result<ConfigOutput, GitError>> {
            let answer = self
                .answers
                .lock()
                .ok()
                .and_then(|mut answers| {
                    if answers.is_empty() {
                        None
                    } else {
                        Some(answers.remove(0))
                    }
                })
                .unwrap_or_else(|| output(""));
            Box::pin(std::future::ready(Ok(answer)))
        }
    }

    #[test]
    fn values_refuse_truncation_bad_exits_and_unterminated_listings() {
        assert_eq!(
            records(&output("a\0b\0"), 2).ok(),
            Some(vec![vec!["a".to_owned(), "b".to_owned()]])
        );
        let truncated = ConfigOutput {
            truncated: true,
            ..output("a\0")
        };
        assert_eq!(
            values(&truncated).err().map(|error| error.code),
            Some(GitErrorCode::OutputTooLarge)
        );
        assert!(values(&output("a")).is_err());
        assert!(records(&output("a\0b\0c\0"), 2).is_err());
    }

    #[test]
    fn an_untrusted_root_or_a_non_file_origin_never_supplies_a_program() {
        let root = std::env::temp_dir().join(format!("ace-g2c-trust-{}", std::process::id()));
        std::fs::create_dir_all(&root).expect("root");
        let inside = root.join("config");
        std::fs::write(&inside, "").expect("inside");
        let outside = std::env::temp_dir().join(format!(
            "ace-g2c-outside-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|since| since.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::write(&outside, "").expect("outside");
        let trusted = TrustedOrigin::new(&[root.to_string_lossy().into_owned()]);
        assert!(!trusted.trusted(Some(&format!("file:{}", inside.display()))));
        assert!(trusted.trusted(Some(&format!("file:{}", outside.display()))));
        assert!(!trusted.trusted(Some("command:")));
        assert!(!trusted.trusted(Some("file:relative")));
        std::fs::remove_dir_all(&root).ok();
        std::fs::remove_file(&outside).ok();
    }

    #[test]
    fn helper_keys_and_values_are_bounded_in_code_points() {
        let helper = CredentialHelper {
            key: "credential.helper".to_owned(),
            value: "\u{1F600}".repeat(16_384),
        };
        assert!(validate_helpers(vec![helper]).is_ok());
        let too_long = CredentialHelper {
            key: "credential.helper".to_owned(),
            value: "\u{1F600}".repeat(16_385),
        };
        assert!(validate_helpers(vec![too_long]).is_err());
        for key in ["credential..helper", "credential.a=b.helper", "credentialx.helper"] {
            assert!(
                validate_helpers(vec![CredentialHelper {
                    key: key.to_owned(),
                    value: "x".to_owned(),
                }])
                .is_err(),
                "{key}"
            );
        }
        // A URL-scoped helper is a helper.
        assert!(validate_helpers(vec![CredentialHelper {
            key: "credential.http://127.0.0.1:8080/.helper".to_owned(),
            value: "!run".to_owned(),
        }])
        .is_ok());
    }

    #[tokio::test]
    async fn one_transfer_reads_the_given_files_and_keeps_the_last_ssh_command() {
        let base = std::env::temp_dir().join(format!(
            "ace-g2c-transfer-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|since| since.as_nanos())
                .unwrap_or(0)
        ));
        let checkout = base.join("checkout");
        let home = base.join("home");
        std::fs::create_dir_all(&checkout).expect("checkout");
        std::fs::create_dir_all(&home).expect("home");
        let file = home.join("config");
        std::fs::write(&file, "").expect("config");
        let ports = FakePorts {
            answers: Mutex::new(vec![
                output(&format!("{}\n", checkout.display())),
                output(&format!("{}/.git\n", checkout.display())),
                output(&format!(
                    "file:{}\0credential.helper\nosxkeychain\0",
                    file.display()
                )),
                output(&format!("file:{}\0first\0", file.display())),
                output("local\0repo\0"),
            ]),
        };
        let request = TransportRequest {
            call: 1,
            system: Some(file.to_string_lossy().into_owned()),
            files: Vec::new(),
            protected_roots: Vec::new(),
            helpers: true,
            repository_ssh: true,
        };
        let config = user_transport_config(&ports, &request).await.expect("config");
        assert_eq!(
            config.helpers,
            vec![CredentialHelper {
                key: "credential.helper".to_owned(),
                value: "osxkeychain".to_owned(),
            }]
        );
        assert_eq!(config.ssh_command.as_deref(), Some("repo"));
        std::fs::remove_dir_all(&base).ok();
    }
}
