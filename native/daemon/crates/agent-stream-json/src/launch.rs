// SPDX-License-Identifier: Apache-2.0
//! The argv for one session, in the order the recordings and the CLI reference pin. The
//! host-mode prefix and the boolean flags are the prompt-less handshake of `claude` 2.1.331
//! (`fixtures/claude/handshake-2.1.331/argv.coding.json` and `argv.isolated.json`, Q2): it opens
//! with `--output-format stream-json --verbose --input-format stream-json
//! --permission-prompt-tool stdio` and no `-p`. The valued flags keep the forms ace's fake and
//! tests pin (`--resume=`, `--resume-session-at=`, `--setting-sources=`), the rest take the
//! value as the next argument.

/// How a session starts: new, resumed, or forked from an earlier one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionStart {
    New {
        session_id: String,
    },
    Resume {
        session_id: String,
    },
    Fork {
        source: String,
        at: Option<String>,
        session_id: String,
    },
}

/// Everything that becomes a flag. `None` means no flag; `Some(Vec::new())` for
/// `setting_sources` is the recorded `--setting-sources=` (Q4).
pub struct Launch {
    pub session: SessionStart,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub permission_mode: Option<String>,
    pub allow_dangerously_skip_permissions: bool,
    pub setting_sources: Option<Vec<String>>,
    pub strict_mcp_config: bool,
    /// A path, or inline JSON `{"mcpServers": ...}`. The caller swaps inline JSON for a private
    /// file.
    pub mcp_config: Option<String>,
    pub plugin_dirs: Vec<String>,
    pub include_partial_messages: bool,
    pub include_hook_events: bool,
    /// Flags the caller adds verbatim (`chrome` -> `--chrome`), in insertion order.
    pub extra: Vec<(String, Option<String>)>,
}

/// The child's argv, without the executable.
pub fn args(launch: &Launch) -> Vec<String> {
    let mut args = vec![
        "--output-format".to_owned(),
        "stream-json".to_owned(),
        "--verbose".to_owned(),
        "--input-format".to_owned(),
        "stream-json".to_owned(),
        "--permission-prompt-tool".to_owned(),
        "stdio".to_owned(),
    ];
    match &launch.session {
        SessionStart::New { session_id } => {
            args.push("--session-id".to_owned());
            args.push(session_id.clone());
        }
        SessionStart::Resume { session_id } => args.push(format!("--resume={session_id}")),
        SessionStart::Fork {
            source,
            at,
            session_id,
        } => {
            args.push(format!("--resume={source}"));
            args.push("--fork-session".to_owned());
            if let Some(at) = at {
                args.push(format!("--resume-session-at={at}"));
            }
            args.push("--session-id".to_owned());
            args.push(session_id.clone());
        }
    }
    push_value(&mut args, "--model", &launch.model);
    push_value(&mut args, "--effort", &launch.effort);
    push_value(&mut args, "--permission-mode", &launch.permission_mode);
    if launch.allow_dangerously_skip_permissions {
        args.push("--allow-dangerously-skip-permissions".to_owned());
    }
    if let Some(sources) = &launch.setting_sources {
        args.push(format!("--setting-sources={}", sources.join(",")));
    }
    if launch.strict_mcp_config {
        args.push("--strict-mcp-config".to_owned());
    }
    push_value(&mut args, "--mcp-config", &launch.mcp_config);
    for directory in &launch.plugin_dirs {
        args.push("--plugin-dir".to_owned());
        args.push(directory.clone());
    }
    if launch.include_hook_events {
        args.push("--include-hook-events".to_owned());
    }
    if launch.include_partial_messages {
        args.push("--include-partial-messages".to_owned());
    }
    for (name, value) in &launch.extra {
        match value {
            Some(value) => args.push(format!("--{name}={value}")),
            None => args.push(format!("--{name}")),
        }
    }
    args
}

fn push_value(args: &mut Vec<String>, flag: &str, value: &Option<String>) {
    if let Some(value) = value {
        args.push(flag.to_owned());
        args.push(value.clone());
    }
}
