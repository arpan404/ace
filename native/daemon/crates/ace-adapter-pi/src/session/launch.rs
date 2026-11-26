// SPDX-License-Identifier: Apache-2.0
//! Pi's launch: the arguments, environment, cwd and extension path the TypeScript builds
//! (`packages/adapter-pi/src/session.ts:97`–`:131`, `launch-args.ts:1`–`:20`).
//!
//! The command is the person's own Pi install; discovery supplies its path and version, and
//! `version.rs` refuses a release older than ace supports before anything is spawned.

/// The permission selectors Pi accepts, from `@ace/provider-kit/access-modes` (`:37`):
/// read-only is Pi's own tool allowlist plus ace's extension tools, full access leaves Pi's
/// own tools alone.
pub const READ_ONLY: &str = "tools:read,grep,find,ls";
pub const UNRESTRICTED: &str = "unrestricted";
/// Pi's read-only allowlist plus ace's extension tools (`access-modes.ts:30`–`:36`).
const READ_ONLY_TOOLS: &str = "read,grep,find,ls,ace_*";
/// Pi's `--thinking` levels (`pi --help`, 1.2.0; `launch-args.ts:4`).
pub const THINKING_LEVELS: [&str; 7] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
/// What the daemon knows when it opens a Pi thread.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PiLaunchInput {
    /// The person's Pi executable, from discovery (`cli.path`).
    pub executable: String,
    /// Discovery's version output (`cli.version`), gated before anything is spawned.
    pub version: Option<String>,
    pub cwd: String,
    /// The child's whole environment: `ctx.env`, then `ctx.agentEnv` over it.
    pub env: Vec<(String, String)>,
    /// The effective model, `ctx.model`.
    pub model: Option<String>,
    /// `ctx.permissionMode`, in Pi's own spelling.
    pub permission_mode: Option<String>,
    /// `ctx.options["effort"]`: one of [`THINKING_LEVELS`].
    pub effort: Option<String>,
    /// `ctx.builtinSkills.directories`: ace's shipped skill directories.
    pub builtin_skills: Vec<String>,
    /// The `extension.ts` ace installs with `-e` (the daemon's resource root).
    pub extension_path: String,
    /// The private MCP config file's path, exported as `ACE_PI_SESSION_FILE`.
    pub session_file: String,
}

/// One launch, ready for the supervisor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PiLaunch {
    pub command: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub env: Vec<(String, String)>,
}

/// Why a launch is refused. Every message is the TypeScript's own.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PiLaunchError {
    #[error("Pi cannot run the permission mode {0}")]
    PermissionMode(String),
    #[error("Pi cannot run the effort level {0}")]
    Effort(String),
}

/// `piLaunchArgs` (`launch-args.ts:12`–`:20`): Read-only's allowlist, then the effort.
pub fn pi_launch_args(
    mode: Option<&str>,
    effort: Option<&str>,
) -> Result<Vec<String>, PiLaunchError> {
    let mut args = Vec::new();
    match mode {
        Some(READ_ONLY) => args.push("--tools".to_owned()),
        Some(UNRESTRICTED) | None => {}
        Some(other) => return Err(PiLaunchError::PermissionMode(other.to_owned())),
    }
    if mode == Some(READ_ONLY) {
        args.push(READ_ONLY_TOOLS.to_owned());
    }
    if let Some(effort) = effort {
        // `PiThinking.parse(effort)`: an unknown level is refused, never passed through.
        if !THINKING_LEVELS.contains(&effort) {
            return Err(PiLaunchError::Effort(effort.to_owned()));
        }
        args.push("--thinking".to_owned());
        args.push(effort.to_owned());
    }
    Ok(args)
}

/// The environment the session exports: the child's whole environment with the session file,
/// and the control variables removed (`session.ts:123`–`:131`). A masked variable is not
/// launched, as node's spawn takes it.
pub fn pi_environment(input: &PiLaunchInput) -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = input.env.clone();
    set(&mut env, "ACE_PI_SESSION_FILE", &input.session_file);
    for masked in [
        "ACE_PI_CONTROL_SECRET",
        "ACE_PI_MCP_URL",
        "ACE_PI_MCP_BEARER",
    ] {
        remove(&mut env, masked);
    }
    env
}

/// The launch `session.ts:97`–`:131` builds: `--mode rpc`, the extension, the model, the
/// access mode, the effort, then ace's skill directories.
pub fn pi_launch(input: &PiLaunchInput) -> Result<PiLaunch, PiLaunchError> {
    let mut args = vec![
        "--mode".to_owned(),
        "rpc".to_owned(),
        "-e".to_owned(),
        input.extension_path.clone(),
    ];
    if let Some(model) = &input.model {
        args.push("--model".to_owned());
        args.push(model.clone());
    }
    args.extend(pi_launch_args(
        input.permission_mode.as_deref(),
        input.effort.as_deref(),
    )?);
    // ace's shipped skills, beside the person's own (Pi lists every skill directory it gets).
    for directory in &input.builtin_skills {
        args.push("--skill".to_owned());
        args.push(directory.clone());
    }
    Ok(PiLaunch {
        command: input.executable.clone(),
        args,
        cwd: input.cwd.clone(),
        env: pi_environment(input),
    })
}

fn set(env: &mut Vec<(String, String)>, name: &str, value: &str) {
    match env.iter_mut().find(|(key, _)| key == name) {
        Some(entry) => entry.1 = value.to_owned(),
        None => env.push((name.to_owned(), value.to_owned())),
    }
}

fn remove(env: &mut Vec<(String, String)>, name: &str) {
    env.retain(|(key, _)| key != name);
}

#[cfg(test)]
mod tests {
    // Ported from `packages/adapter-pi/src/launch-args.test.ts`, case for case.
    use super::*;

    fn input() -> PiLaunchInput {
        PiLaunchInput {
            executable: "/opt/pi".to_owned(),
            cwd: "/work".to_owned(),
            env: vec![
                ("PATH".to_owned(), "/bin".to_owned()),
                ("ACE_PI_CONTROL_SECRET".to_owned(), "old".to_owned()),
                ("ACE_PI_MCP_URL".to_owned(), "old".to_owned()),
                ("ACE_PI_MCP_BEARER".to_owned(), "old".to_owned()),
            ],
            extension_path: "/ace/extension.ts".to_owned(),
            session_file: "/tmp/ace-mcp-1/config.json".to_owned(),
            ..PiLaunchInput::default()
        }
    }

    /// "Pi's Read-only runs its own read-only tool allowlist plus ace's tools; Full access
    /// leaves its tools alone".
    #[test]
    fn read_only_runs_its_own_allowlist_plus_aces_tools_and_full_access_leaves_its_tools_alone() {
        assert_eq!(
            pi_launch_args(Some(READ_ONLY), None).expect("read-only"),
            vec!["--tools".to_owned(), "read,grep,find,ls,ace_*".to_owned()]
        );
        assert_eq!(
            pi_launch_args(Some(UNRESTRICTED), None).expect("unrestricted"),
            Vec::<String>::new()
        );
        assert_eq!(
            pi_launch_args(None, None).expect("none"),
            Vec::<String>::new()
        );
    }

    /// "an effort is Pi's thinking level, and an unknown mode or level is refused".
    #[test]
    fn an_effort_is_pis_thinking_level_and_an_unknown_mode_or_level_is_refused() {
        assert_eq!(
            pi_launch_args(Some(UNRESTRICTED), Some("xhigh")).expect("xhigh"),
            vec!["--thinking".to_owned(), "xhigh".to_owned()]
        );
        assert_eq!(
            pi_launch_args(Some("plan"), None).unwrap_err().to_string(),
            "Pi cannot run the permission mode plan"
        );
        assert!(pi_launch_args(None, Some("ultra")).is_err());
    }

    #[test]
    fn the_launch_puts_the_extension_model_effort_and_skills_in_order() {
        let mut input = input();
        input.model = Some("synthetic/model".to_owned());
        input.effort = Some("low".to_owned());
        input.builtin_skills = vec!["/ace/skills".to_owned(), "/ace/more".to_owned()];
        let launch = pi_launch(&input).expect("launch");
        assert_eq!(launch.command, "/opt/pi");
        assert_eq!(
            launch.args,
            vec![
                "--mode",
                "rpc",
                "-e",
                "/ace/extension.ts",
                "--model",
                "synthetic/model",
                "--thinking",
                "low",
                "--skill",
                "/ace/skills",
                "--skill",
                "/ace/more",
            ]
        );
        assert_eq!(launch.cwd, "/work");
    }

    #[test]
    fn the_environment_exports_the_session_file_and_drops_the_control_variables() {
        let launch = pi_launch(&input()).expect("launch");
        assert_eq!(
            launch.env,
            vec![
                ("PATH".to_owned(), "/bin".to_owned()),
                (
                    "ACE_PI_SESSION_FILE".to_owned(),
                    "/tmp/ace-mcp-1/config.json".to_owned()
                ),
            ]
        );
    }
}
