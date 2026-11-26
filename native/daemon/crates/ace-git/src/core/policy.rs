// SPDX-License-Identifier: Apache-2.0
//! The execution policy (`packages/git/src/non-executing.ts`, G2c): the
//! command-scope configuration that keeps a protected or automatic call from
//! running anything of the checkout's, the hook switches `disabled-hooks.ts`
//! rewrites for `/dev/null`, and the transport limits every admitted transfer
//! carries.
//!
//! Command-scope `-c`/`GIT_CONFIG_*` entries win over repository, worktree,
//! global and system files, which is why the policy is expressed that way.

use ace_json::{Array, JsString, Map, Value};
use regex::Regex;

use crate::core::error::{GitError, GitErrorCode};

/// Events Git can run as hooks. A file-backed `hook.<event>.<name>` shadows one of these.
pub const HOOK_EVENTS: &[&str] = &[
    "applypatch-msg",
    "pre-applypatch",
    "post-applypatch",
    "pre-commit",
    "pre-merge-commit",
    "prepare-commit-msg",
    "commit-msg",
    "post-commit",
    "pre-rebase",
    "post-checkout",
    "post-merge",
    "pre-push",
    "pre-receive",
    "update",
    "proc-receive",
    "post-receive",
    "post-update",
    "reference-transaction",
    "push-to-checkout",
    "pre-auto-gc",
    "post-rewrite",
    "sendemail-validate",
    "fsmonitor-watchman",
    "p4-changelist",
    "p4-prepare-changelist",
    "p4-post-changelist",
    "p4-pre-submit",
    "post-index-change",
];

/// The inspection every policy call runs first; its records are `scope\0key\0`.
pub const EXECUTION_KEY_QUERY: &[&str] = &[
    "config",
    "--null",
    "--name-only",
    "--show-scope",
    "--get-regexp",
    "^(filter\\..*\\.(clean|smudge|process|required)|hook\\..*\\.[^.]+)$",
];

/// Where `core.hooksPath` points to disable hooks on POSIX.
pub const POSIX_HOOKS: &str = "/dev/null";

/// Protocols an admitted transfer may use; anything else loses to `protocol.allow=never`.
pub const TRANSPORT_PROTOCOLS: &[&str] = &["http", "https", "ssh", "file"];

/// A hook or filter key accepted from the checkout's configuration.
struct KeyRules {
    filter: Regex,
    hook: Regex,
}

fn key_rules() -> Option<&'static KeyRules> {
    static RULES: std::sync::OnceLock<Option<KeyRules>> = std::sync::OnceLock::new();
    RULES
        .get_or_init(|| {
            Some(KeyRules {
                filter: Regex::new(r"^filter\.[^\x00\n]+\.(?:clean|smudge|process|required)$")
                    .ok()?,
                hook: Regex::new(r"^hook\.[^\x00\n]+\.[^\x00\n.]+$").ok()?,
            })
        })
        .as_ref()
}

/// File-backed filter drivers and named hooks from an `EXECUTION_KEY_QUERY` result.
#[derive(Debug)]
pub struct ConfiguredExtensions {
    pub drivers: Vec<String>,
    pub hooks: Vec<String>,
}

fn malformed() -> GitError {
    GitError::new(
        GitErrorCode::MalformedOutput,
        "Invalid Git execution configuration",
    )
}

/// Parses the inspection: pairs of scope and key, with command-scope entries
/// (our own event switches) ignored, since only file-backed entries can
/// introduce an untrusted friendly name or filter driver.
pub fn configured_extensions(keys: &str) -> Result<ConfiguredExtensions, GitError> {
    if !keys.is_empty() && !keys.ends_with('\0') {
        return Err(malformed());
    }
    let records: Vec<&str> = if keys.is_empty() {
        Vec::new()
    } else {
        keys[..keys.len() - 1].split('\0').collect()
    };
    let mut configured: Vec<&str> = Vec::new();
    let mut index = 0;
    while index < records.len() {
        let scope = records[index];
        let key = records.get(index + 1).copied();
        let Some(key) = key else {
            return Err(malformed());
        };
        if scope.is_empty() {
            return Err(malformed());
        }
        if scope != "command" {
            configured.push(key);
        }
        index += 2;
    }
    let Some(rules) = key_rules() else {
        return Err(malformed());
    };
    let mut drivers: Vec<String> = Vec::new();
    let mut hooks: Vec<String> = Vec::new();
    for key in configured {
        if rules.filter.is_match(key) {
            if let Some(name) = key.rsplit_once('.').map(|(prefix, _)| prefix) {
                push_unique(&mut drivers, name);
            }
        } else if rules.hook.is_match(key) {
            if let Some(name) = key.rsplit_once('.').map(|(prefix, _)| prefix) {
                push_unique(&mut hooks, name);
            }
        } else {
            return Err(malformed());
        }
    }
    for name in &hooks {
        if HOOK_EVENTS.contains(&name.trim_start_matches("hook.")) {
            return Err(GitError::new(
                GitErrorCode::UnsupportedRepository,
                "A configured hook shadows a reserved event; remove it before continuing",
            ));
        }
    }
    if drivers.len() > 512 || hooks.len() > 512 {
        return Err(GitError::new(
            GitErrorCode::UnsupportedRepository,
            "Too many execution extensions",
        ));
    }
    Ok(ConfiguredExtensions { drivers, hooks })
}

fn push_unique(items: &mut Vec<String>, value: &str) {
    if !items.iter().any(|item| item == value) {
        items.push(value.to_owned());
    }
}

/// The switches that turn every hook event off, in Git's own words.
fn hook_switches() -> Vec<(String, String)> {
    let mut switches = vec![("core.hooksPath".to_owned(), POSIX_HOOKS.to_owned())];
    for event in HOOK_EVENTS {
        switches.push((format!("hook.{event}.enabled"), "false".to_owned()));
    }
    switches
}

/// Builds `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_i`, `GIT_CONFIG_VALUE_i`.
fn command_config(pairs: &[(String, String)]) -> Vec<(String, String)> {
    let mut env = vec![("GIT_CONFIG_COUNT".to_owned(), pairs.len().to_string())];
    for (index, (key, value)) in pairs.iter().enumerate() {
        env.push((format!("GIT_CONFIG_KEY_{index}"), key.clone()));
        env.push((format!("GIT_CONFIG_VALUE_{index}"), value.clone()));
    }
    env
}

/// The fixed guards plus every file-backed driver and named hook neutralised.
fn guarded_pairs(extensions: &ConfiguredExtensions) -> Vec<(String, String)> {
    let mut pairs = hook_switches();
    for (key, value) in [
        ("core.fsmonitor", "false"),
        ("core.untrackedCache", "false"),
        ("core.attributesFile", "/dev/null"),
        ("gc.auto", "0"),
        ("maintenance.auto", "false"),
        ("commit.gpgSign", "false"),
        ("tag.gpgSign", "false"),
    ] {
        pairs.push((key.to_owned(), value.to_owned()));
    }
    for driver in &extensions.drivers {
        for (suffix, value) in [
            ("clean", ""),
            ("smudge", ""),
            ("process", ""),
            ("required", "false"),
        ] {
            pairs.push((format!("{driver}.{suffix}"), value.to_owned()));
        }
    }
    for hook in &extensions.hooks {
        pairs.push((format!("{hook}.event"), String::new()));
        pairs.push((format!("{hook}.enabled"), "false".to_owned()));
    }
    pairs
}

/// Config inspection is read-only and receives the same fixed execution guards.
pub fn non_executing_env(keys: &str) -> Result<Vec<(String, String)>, GitError> {
    let extensions = configured_extensions(keys)?;
    let mut env = command_config(&guarded_pairs(&extensions));
    env.push(("GIT_ATTR_NOSYSTEM".to_owned(), "1".to_owned()));
    env.push(("GIT_NO_LAZY_FETCH".to_owned(), "1".to_owned()));
    env.push(("GIT_ALLOW_PROTOCOL".to_owned(), String::new()));
    env.push(("GIT_OPTIONAL_LOCKS".to_owned(), "0".to_owned()));
    Ok(env)
}

/// Only hooks are switched off: every other program the person configured runs as usual.
pub fn hookless_env(keys: &str) -> Result<Vec<(String, String)>, GitError> {
    let extensions = configured_extensions(keys)?;
    let mut pairs = hook_switches();
    for hook in &extensions.hooks {
        pairs.push((format!("{hook}.event"), String::new()));
        pairs.push((format!("{hook}.enabled"), "false".to_owned()));
    }
    Ok(command_config(&pairs))
}

/// Transport limits for every admitted transfer, executing or not.
pub fn transport_env(
    protocols: &[String],
    ssh_command: Option<&str>,
) -> Result<Vec<(String, String)>, GitError> {
    if protocols.len() > 4 {
        return Err(invalid("Invalid Git transport policy"));
    }
    for protocol in protocols {
        if !TRANSPORT_PROTOCOLS.contains(&protocol.as_str()) {
            return Err(invalid("Invalid Git transport policy"));
        }
    }
    // A zod bound counts code points, so the limit is characters, not UTF-16 units.
    let trimmed = ssh_command.unwrap_or("").trim();
    let command = if trimmed.is_empty() { "ssh" } else { trimmed };
    if command.chars().count() > 16_384 || command.contains('\0') || command.contains('\n') {
        return Err(invalid("Invalid Git SSH command"));
    }
    Ok(vec![
        ("GIT_ALLOW_PROTOCOL".to_owned(), protocols.join(":")),
        (
            "GIT_SSH_COMMAND".to_owned(),
            format!("{command} -o BatchMode=yes"),
        ),
        ("GIT_ASKPASS".to_owned(), String::new()),
        ("GIT_TERMINAL_PROMPT".to_owned(), "0".to_owned()),
    ])
}

/// The guarded environment for a transfer: nothing executes, and only the admitted protocols pass.
pub fn non_executing_transport_env(
    keys: &str,
    protocols: &[String],
    ssh_command: Option<&str>,
) -> Result<Vec<(String, String)>, GitError> {
    let mut env = non_executing_env(keys)?;
    env.extend(transport_env(protocols, ssh_command)?);
    Ok(env)
}

fn invalid(message: &str) -> GitError {
    GitError::new(GitErrorCode::InvalidArgument, message)
}

/// What the caller's scope asks of one Git call (`execute()` in `cli.ts`).
#[derive(Debug, Clone, Default)]
pub struct CallPolicy {
    /// A protected root or an automatic operation: nothing of the checkout's may run.
    pub guarded: bool,
    /// A reviewer's checkout: hooks inside it are its author's programs.
    pub hookless: bool,
    /// An admitted transfer, with its protocols and the person's SSH command.
    pub transport: Option<(Vec<String>, Option<String>)>,
    /// The inspection's answer, when one ran.
    pub keys: String,
}

/// One prepared call: its policy environment and the arguments that must precede the command.
pub struct PreparedCall {
    pub env: Vec<(String, String)>,
    pub args: Vec<String>,
}

pub fn prepare(call: &CallPolicy) -> Result<PreparedCall, GitError> {
    let env = match (&call.transport, call.guarded, call.hookless) {
        (Some((protocols, ssh)), true, _) => {
            non_executing_transport_env(&call.keys, protocols, ssh.as_deref())?
        }
        (Some((protocols, ssh)), false, hookless) => {
            let mut env = if hookless {
                hookless_env(&call.keys)?
            } else {
                Vec::new()
            };
            env.extend(transport_env(protocols, ssh.as_deref())?);
            env
        }
        (None, true, _) => non_executing_env(&call.keys)?,
        (None, false, true) => hookless_env(&call.keys)?,
        // A person's ordinary call carries no policy environment at all.
        (None, false, false) => Vec::new(),
    };
    let args = if call.guarded || call.transport.is_some() {
        vec!["-c".to_owned(), "protocol.allow=never".to_owned()]
    } else {
        Vec::new()
    };
    Ok(PreparedCall { env, args })
}

/// [`PreparedCall`] as the shell reads it: `{ env: [[key, value], ...], args: [...] }`.
pub fn prepared_to_json(prepared: &PreparedCall) -> String {
    let env: Vec<Value> = prepared
        .env
        .iter()
        .map(|(key, value)| {
            Value::Array(Array::from(vec![
                Value::String(JsString::from(key.as_str())),
                Value::String(JsString::from(value.as_str())),
            ]))
        })
        .collect();
    let mut object = Map::new();
    object.insert(JsString::from("env"), Value::Array(Array::from(env)));
    object.insert(
        JsString::from("args"),
        Value::Array(Array::from(
            prepared
                .args
                .iter()
                .map(|arg| Value::String(JsString::from(arg.as_str())))
                .collect::<Vec<_>>(),
        )),
    );
    ace_json::to_string(&Value::Object(object))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env_of(pairs: &[(String, String)], key: &str) -> Option<String> {
        pairs
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.clone())
    }

    #[test]
    fn the_inspection_keeps_file_backed_keys_and_drops_command_scope_entries() {
        // `scope\0key\0`: command-scope entries are our own switches, never the checkout's.
        let keys = "command\0hook.pre-commit.enabled\0global\0filter.prettier.clean\0local\0hook.acme.verify\0";
        let extensions = configured_extensions(keys).expect("parsed");
        assert_eq!(extensions.drivers, vec!["filter.prettier".to_owned()]);
        assert_eq!(extensions.hooks, vec!["hook.acme".to_owned()]);
    }

    #[test]
    fn malformed_inspections_are_malformed_output() {
        for keys in [
            "no terminator",
            "scope\0",
            "\0hook.pre-commit.enabled\0",
            "scope\0not-a-key\0",
        ] {
            let error = configured_extensions(keys).expect_err(keys);
            assert_eq!(error.code, GitErrorCode::MalformedOutput, "{keys}");
        }
        // An odd number of records leaves a scope without its key.
        let error = configured_extensions("global\0filter.a.clean\0local\0").expect_err("odd");
        assert_eq!(error.code, GitErrorCode::MalformedOutput);
    }

    #[test]
    fn a_file_backed_hook_shadowing_a_reserved_event_is_refused() {
        let error = configured_extensions("local\0hook.pre-commit.verify\0").expect_err("shadow");
        assert_eq!(error.code, GitErrorCode::UnsupportedRepository);
        assert!(error.message.contains("shadows a reserved event"));
    }

    #[test]
    fn more_than_512_drivers_or_hooks_is_refused() {
        let drivers: String = (0..513)
            .map(|index| format!("local\0filter.d{index}.clean\0"))
            .collect();
        assert_eq!(
            configured_extensions(&drivers).expect_err("many").code,
            GitErrorCode::UnsupportedRepository
        );
    }

    #[test]
    fn a_guarded_call_switches_every_hook_and_neutralises_each_driver() {
        let env = non_executing_env("local\0filter.prettier.clean\0local\0hook.acme.verify\0")
            .expect("env");
        assert_eq!(env_of(&env, "GIT_ATTR_NOSYSTEM").as_deref(), Some("1"));
        assert_eq!(env_of(&env, "GIT_NO_LAZY_FETCH").as_deref(), Some("1"));
        assert_eq!(env_of(&env, "GIT_ALLOW_PROTOCOL").as_deref(), Some(""));
        assert_eq!(env_of(&env, "GIT_OPTIONAL_LOCKS").as_deref(), Some("0"));
        let pairs = |key: &str| env_of(&env, key);
        let mut index = 0;
        let count: usize = env_of(&env, "GIT_CONFIG_COUNT")
            .expect("count")
            .parse()
            .expect("number");
        let mut found = Vec::new();
        while index < count {
            found.push((
                pairs(&format!("GIT_CONFIG_KEY_{index}")).unwrap_or_default(),
                pairs(&format!("GIT_CONFIG_VALUE_{index}")).unwrap_or_default(),
            ));
            index += 1;
        }
        assert!(found.contains(&("core.hooksPath".to_owned(), "/dev/null".to_owned())));
        assert!(found.contains(&("hook.pre-commit.enabled".to_owned(), "false".to_owned())));
        assert!(found.contains(&("filter.prettier.clean".to_owned(), String::new())));
        assert!(found.contains(&("filter.prettier.required".to_owned(), "false".to_owned())));
        assert!(found.contains(&("hook.acme.event".to_owned(), String::new())));
        assert!(found.contains(&("core.fsmonitor".to_owned(), "false".to_owned())));
    }

    #[test]
    fn a_hookless_call_switches_hooks_and_nothing_else() {
        let env = hookless_env("").expect("env");
        let count: usize = env_of(&env, "GIT_CONFIG_COUNT")
            .expect("count")
            .parse()
            .expect("number");
        let mut index = 0;
        while index < count {
            let key = env_of(&env, &format!("GIT_CONFIG_KEY_{index}")).unwrap_or_default();
            assert!(key == "core.hooksPath" || key.starts_with("hook."));
            index += 1;
        }
        assert_eq!(env_of(&env, "GIT_ATTR_NOSYSTEM"), None);
    }

    #[test]
    fn a_transfer_allows_only_its_protocols_and_never_prompts() {
        let env = transport_env(&["http".to_owned(), "ssh".to_owned()], None).expect("env");
        assert_eq!(
            env_of(&env, "GIT_ALLOW_PROTOCOL").as_deref(),
            Some("http:ssh")
        );
        assert_eq!(
            env_of(&env, "GIT_SSH_COMMAND").as_deref(),
            Some("ssh -o BatchMode=yes")
        );
        assert_eq!(env_of(&env, "GIT_ASKPASS").as_deref(), Some(""));
        assert_eq!(env_of(&env, "GIT_TERMINAL_PROMPT").as_deref(), Some("0"));
        for protocols in [
            vec!["ftp".to_owned()],
            vec![
                "http".to_owned(),
                "https".to_owned(),
                "ssh".to_owned(),
                "file".to_owned(),
                "http".to_owned(),
            ],
        ] {
            assert_eq!(
                transport_env(&protocols, None).expect_err("refused").code,
                GitErrorCode::InvalidArgument
            );
        }
    }

    #[test]
    fn the_ssh_command_limit_counts_code_points_not_utf16_units() {
        // An emoji is one code point but two UTF-16 units: 16,384 of them pass.
        let emoji = "\u{1F600}".repeat(16_384);
        assert!(transport_env(&["ssh".to_owned()], Some(&emoji)).is_ok());
        let too_long = "\u{1F600}".repeat(16_385);
        assert_eq!(
            transport_env(&["ssh".to_owned()], Some(&too_long))
                .expect_err("too long")
                .code,
            GitErrorCode::InvalidArgument
        );
        // Whitespace alone falls back to ssh; a newline is refused.
        assert_eq!(
            env_of(
                &transport_env(&["ssh".to_owned()], Some("   ")).expect("default"),
                "GIT_SSH_COMMAND"
            )
            .as_deref(),
            Some("ssh -o BatchMode=yes")
        );
        assert!(transport_env(&["ssh".to_owned()], Some("a\nb")).is_err());
    }

    #[test]
    fn a_prepared_call_carries_the_guard_arguments_and_its_environment() {
        let guarded = prepare(&CallPolicy {
            guarded: true,
            hookless: false,
            transport: None,
            keys: String::new(),
        })
        .expect("guarded");
        assert_eq!(
            guarded.args,
            vec!["-c".to_owned(), "protocol.allow=never".to_owned()]
        );
        assert_eq!(
            env_of(&guarded.env, "GIT_NO_LAZY_FETCH").as_deref(),
            Some("1")
        );
        let person = prepare(&CallPolicy::default()).expect("person");
        assert!(person.env.is_empty());
        assert!(person.args.is_empty());
    }
}
