//! The workspace tools a bot is offered: `workspace_list`, `workspace_read`, `workspace_search`,
//! `workspace_write`, `workspace_edit` and `shell`. Each finds the calling bot from the call's key
//! and works only in that bot's folder.

use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};
use spade_core::tools::{Risk, ToolDef};
use spade_models::ToolSpec;

use super::shell::{Launch, Ran, Shell};
use super::{PathError, Workspace, Workspaces};
use crate::tools::{EngineHandle, Tool, ToolFuture, ToolOutput, TurnFacts, parse};

/// The shell's deadline when the model names none. The model may name any longer one (ADR
/// 0158); a command still running after the engine's foreground window moves to the background
/// and its result arrives as a `<job_result>`.
pub const SHELL_TIMEOUT: Duration = Duration::from_secs(60);

/// What every workspace tool shares: where workspaces are and who is calling.
#[derive(Clone)]
struct Place {
    all: Workspaces,
    bots: EngineHandle,
}

impl Place {
    /// Tells the app's live views that files changed in the calling bot's workspace.
    fn files_changed(&self, key: &str, paths: Option<Vec<String>>) {
        if let (Some(engine), Some(bot)) = (self.bots.get(), self.bots.agent_for_key(key))
            && let Some(computers) = engine.computers()
        {
            computers.files_changed(&bot, paths);
        }
    }

    /// The bot yields to the person (cowork, ADR 0143): a file the person changed a moment ago
    /// is theirs for now, so the bot's write or edit of it is not run.
    fn yields(&self, key: &str, path: &str) -> Option<ToolOutput> {
        let (engine, bot) = (self.bots.get()?, self.bots.agent_for_key(key)?);
        let ago = engine.computers()?.person_changed_recently(&bot, path)?;
        Some(ToolOutput::ok(format!(
            "Not run: the person changed {path} {ago} seconds ago and may still be working on \
             it; they come first. Leave it for now: work on something else and read it again \
             before you change it."
        )))
    }

    fn workspace(&self, key: &str) -> Result<Workspace, ToolOutput> {
        let bot = self
            .bots
            .agent_for_key(key)
            .ok_or_else(|| ToolOutput::error("This conversation has no bot, so no workspace."))?;
        self.all
            .of(&bot)
            .map_err(|error| ToolOutput::error(error.to_string()))
    }
}

/// Where the bot's `shell` commands run: each on its own (`Shell`), or in the bot's persistent
/// terminal (ADR 0142), which the person can watch and take over.
#[derive(Clone)]
pub enum Commands {
    OneShot(Shell),
    Terminal(Arc<crate::computer::Terminals>),
}

impl Commands {
    /// Whether a command with home `home` runs contained in the bot's OS sandbox (ADR 0167).
    fn contains(&self, home: &std::path::Path) -> bool {
        match self {
            Self::OneShot(shell) => shell.contains(home),
            Self::Terminal(terminals) => terminals.contains(home),
        }
    }

    /// Whether the bot with home `home` runs its commands outside the sandbox (ADR 0171).
    fn outside(&self, home: &std::path::Path) -> bool {
        match self {
            Self::OneShot(shell) => shell.outside(home),
            Self::Terminal(terminals) => terminals.outside(home),
        }
    }
}

impl From<Shell> for Commands {
    fn from(shell: Shell) -> Self {
        Self::OneShot(shell)
    }
}

impl From<Arc<crate::computer::Terminals>> for Commands {
    fn from(terminals: Arc<crate::computer::Terminals>) -> Self {
        Self::Terminal(terminals)
    }
}

/// Every workspace tool, for `bots` (set once the engine exists), running shell commands with
/// `commands`.
pub fn tools(
    all: Workspaces,
    bots: EngineHandle,
    commands: impl Into<Commands>,
) -> Vec<Arc<dyn Tool>> {
    let shell = commands.into();
    let place = Place { all, bots };
    vec![
        Arc::new(WorkspaceList(place.clone())),
        Arc::new(WorkspaceRead(place.clone())),
        Arc::new(WorkspaceSearch(place.clone())),
        Arc::new(WorkspaceWrite(place.clone())),
        Arc::new(WorkspaceEdit(place.clone())),
        Arc::new(ShellTool { place, shell }),
    ]
}

fn def(name: &str, description: &str, schema: Value, risk: Risk) -> ToolDef {
    shown_def(name, description, schema, risk, false)
}

fn shown_def(
    name: &str,
    description: &str,
    schema: Value,
    risk: Risk,
    untrusted_output: bool,
) -> ToolDef {
    ToolDef {
        spec: ToolSpec {
            name: name.to_owned(),
            description: description.to_owned(),
            schema,
        },
        risk,
        untrusted_output,
        deferred: false,
        background: false,
    }
}

/// Runs file work off the async threads and turns its error into words for the model.
fn blocking(
    place: &Place,
    key: &str,
    work: impl FnOnce(Workspace) -> Result<ToolOutput, PathError> + Send + 'static,
) -> ToolFuture {
    let workspace = place.workspace(key);
    Box::pin(async move {
        let workspace = match workspace {
            Ok(workspace) => workspace,
            Err(output) => return output,
        };
        tokio::task::spawn_blocking(move || work(workspace))
            .await
            .unwrap_or_else(|_| Err(PathError::Io("the file work stopped".to_owned())))
            .unwrap_or_else(|error| ToolOutput::error(error.to_string()))
    })
}

/// A file name for a call's large output, from its key.
fn output_name(key: &str) -> String {
    key.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

pub struct WorkspaceList(Place);

#[derive(Deserialize)]
struct ListArgs {
    #[serde(default)]
    path: String,
}

/// A result, marked untrusted unless everything it shows is trusted.
fn marked(output: ToolOutput, trusted: bool) -> ToolOutput {
    if trusted { output } else { output.untrusted() }
}

impl Tool for WorkspaceList {
    fn def(&self) -> ToolDef {
        def(
            "workspace_list",
            "Lists a folder in your workspace (your own folder on this machine for files you \
             keep and work on). Paths are relative to the workspace; leave path empty for its top.",
            json!({ "type": "object", "properties": { "path": { "type": "string" } } }),
            Risk::Read,
        )
    }

    fn run(&self, key: &str, arguments: Value) -> ToolFuture {
        let args: ListArgs = match parse(arguments) {
            Ok(args) => args,
            Err(output) => return Box::pin(async move { output }),
        };
        blocking(&self.0, key, move |workspace| {
            let listing = workspace.list(&args.path)?;
            // Names are content too: trusted only when every entry shown is a trusted file.
            let trusted = workspace.listing_trusted(&listing);
            if listing.entries.is_empty() {
                return Ok(marked(ToolOutput::ok("The folder is empty."), trusted));
            }
            let mut lines: Vec<String> = listing
                .entries
                .iter()
                .map(|entry| match entry.kind {
                    super::EntryKind::Folder => format!("{}/", entry.path),
                    super::EntryKind::Link => format!("{} (link)", entry.path),
                    super::EntryKind::File => format!("{} ({} bytes)", entry.path, entry.size),
                })
                .collect();
            if listing.truncated {
                lines.push(format!("[Only the first {} shown.]", lines.len()));
            }
            Ok(marked(ToolOutput::ok(lines.join("\n")), trusted))
        })
    }
}

pub struct WorkspaceRead(Place);

#[derive(Deserialize)]
struct ReadArgs {
    path: String,
    #[serde(default)]
    offset: Option<usize>,
    #[serde(default)]
    limit: Option<usize>,
}

impl Tool for WorkspaceRead {
    fn def(&self) -> ToolDef {
        def(
            "workspace_read",
            "Reads a text file in your workspace, a window of lines at a time: offset is the first \
             line (from 1), limit how many (400 unless given).",
            json!({ "type": "object",
                    "properties": { "path": { "type": "string" },
                                    "offset": { "type": "integer", "minimum": 1 },
                                    "limit": { "type": "integer", "minimum": 1 } },
                    "required": ["path"] }),
            Risk::Read,
        )
    }

    fn run(&self, key: &str, arguments: Value) -> ToolFuture {
        let args: ReadArgs = match parse(arguments) {
            Ok(args) => args,
            Err(output) => return Box::pin(async move { output }),
        };
        blocking(&self.0, key, move |workspace| {
            let path = workspace.normal(&args.path)?;
            let text = workspace.text(&path)?;
            let trusted = workspace.file_trusted(&path, text.as_bytes());
            let window = super::files::window(
                &path,
                &text,
                args.offset.unwrap_or(1),
                args.limit.unwrap_or(super::files::READ_LINES),
            );
            Ok(marked(ToolOutput::ok(window), trusted))
        })
    }
}

pub struct WorkspaceSearch(Place);

#[derive(Deserialize)]
struct SearchArgs {
    text: String,
    #[serde(default)]
    path: String,
    #[serde(default)]
    ignore_case: bool,
}

impl Tool for WorkspaceSearch {
    fn def(&self) -> ToolDef {
        def(
            "workspace_search",
            "Finds lines containing some text in your workspace's files (under path, or all).",
            json!({ "type": "object",
                    "properties": { "text": { "type": "string" },
                                    "path": { "type": "string" },
                                    "ignore_case": { "type": "boolean" } },
                    "required": ["text"] }),
            Risk::Read,
        )
    }

    fn run(&self, key: &str, arguments: Value) -> ToolFuture {
        let args: SearchArgs = match parse(arguments) {
            Ok(args) => args,
            Err(output) => return Box::pin(async move { output }),
        };
        let name = output_name(key);
        blocking(&self.0, key, move |workspace| {
            let found = workspace.search(&args.path, &args.text, args.ignore_case)?;
            let start = workspace.normal(&args.path)?;
            let trusted = workspace.plain_folder(&start)
                && found.files.iter().all(|(path, hash)| {
                    workspace.plain_file(path) && workspace.trust().trusted(path, hash)
                });
            let shown = workspace.keep_large(&name, &found.text);
            Ok(marked(ToolOutput::ok(shown), trusted))
        })
    }
}

pub struct WorkspaceWrite(Place);

#[derive(Deserialize)]
struct WriteArgs {
    path: String,
    content: String,
}

impl Tool for WorkspaceWrite {
    fn def(&self) -> ToolDef {
        def(
            "workspace_write",
            "Writes a whole file in your workspace, creating its folders; replaces the file if it \
             exists.",
            json!({ "type": "object",
                    "properties": { "path": { "type": "string" },
                                    "content": { "type": "string" } },
                    "required": ["path", "content"] }),
            Risk::Write,
        )
    }

    fn run(&self, key: &str, arguments: Value) -> ToolFuture {
        self.run_in(key, arguments, &TurnFacts::default())
    }

    fn run_in(&self, key: &str, arguments: Value, turn: &TurnFacts) -> ToolFuture {
        let args: WriteArgs = match parse(arguments) {
            Ok(args) => args,
            Err(output) => return Box::pin(async move { output }),
        };
        let untrusted = turn.untrusted.clone();
        let (place, key) = (self.0.clone(), key.to_owned());
        blocking(&self.0, &key.clone(), move |workspace| {
            let path = workspace.normal(&args.path)?;
            // Checked and written under the workspace's file lock, so the person's write can't
            // land between (ADR 0143).
            workspace.changing(|| {
                if let Some(yielded) = place.yields(&key, &path) {
                    return Ok(yielded);
                }
                workspace.before_bot_commit(&path);
                let bytes = workspace.write(&path, &args.content)?;
                workspace.trust().record_write(
                    &path,
                    args.content.as_bytes(),
                    untrusted.as_deref(),
                );
                place.files_changed(&key, Some(vec![path.clone()]));
                Ok(ToolOutput::ok(format!("Wrote {bytes} bytes to {path}.")))
            })
        })
    }
}

pub struct WorkspaceEdit(Place);

#[derive(Deserialize)]
struct EditArgs {
    path: String,
    old: String,
    new: String,
}

impl Tool for WorkspaceEdit {
    fn def(&self) -> ToolDef {
        def(
            "workspace_edit",
            "Changes a file in your workspace: replaces the one place `old` appears with `new`. \
             Copy `old` exactly, with enough around it to appear once.",
            json!({ "type": "object",
                    "properties": { "path": { "type": "string" },
                                    "old": { "type": "string" },
                                    "new": { "type": "string" } },
                    "required": ["path", "old", "new"] }),
            Risk::Write,
        )
    }

    fn run(&self, key: &str, arguments: Value) -> ToolFuture {
        self.run_in(key, arguments, &TurnFacts::default())
    }

    fn run_in(&self, key: &str, arguments: Value, turn: &TurnFacts) -> ToolFuture {
        let args: EditArgs = match parse(arguments) {
            Ok(args) => args,
            Err(output) => return Box::pin(async move { output }),
        };
        let untrusted = turn.untrusted.clone();
        let (place, key) = (self.0.clone(), key.to_owned());
        blocking(&self.0, &key.clone(), move |workspace| {
            let path = workspace.normal(&args.path)?;
            workspace.changing(|| {
                if let Some(yielded) = place.yields(&key, &path) {
                    return Ok(yielded);
                }
                workspace.before_bot_commit(&path);
                let (before, after) = workspace.edit(&path, &args.old, &args.new)?;
                workspace.trust().record_edit(
                    &path,
                    before.as_bytes(),
                    after.as_bytes(),
                    untrusted.as_deref(),
                );
                place.files_changed(&key, Some(vec![path.clone()]));
                Ok(ToolOutput::ok(format!("Changed {path}.")))
            })
        })
    }
}

pub struct ShellTool {
    place: Place,
    shell: Commands,
}

#[derive(Deserialize)]
struct ShellArgs {
    command: String,
    #[serde(default)]
    timeout_s: Option<u64>,
}

/// Whether a `shell` call asks to run outside the sandbox (ADR 0171).
fn asks_outside(arguments: &Value) -> bool {
    arguments.get(OUTSIDE_SANDBOX).and_then(Value::as_bool) == Some(true)
}

/// The argument a bot sets to ask to run one command outside the sandbox.
const OUTSIDE_SANDBOX: &str = "outside_sandbox";

impl Tool for ShellTool {
    fn def(&self) -> ToolDef {
        shown_def(
            "shell",
            "Runs a shell command in your workspace folder (sh on macOS and Linux, cmd on \
             Windows) and answers its output. Stops it after timeout_s seconds (60 unless given; \
             give a longer one for long builds and test runs, as long as the work needs). A \
             command still running after 30 seconds moves to the background: the call answers \
             at once with its job id and the output arrives later as a <job_result>. Where \
             Spade's sandbox holds commands, they run without a review: they can write only in \
             your folder and folders the person granted, can't read the person's files or \
             sign-ins, can't drive other apps, and reach the network only through hosts your \
             network policy allows (a refused host answers 403 from Spade's proxy). When the \
             sandbox stops a command the step truly needs, call it again with \
             outside_sandbox: true and the person decides. Elsewhere each command is reviewed. \
             To push, comment or send a message, use git_push, pr_comment, issue_comment or \
             send_message: commands never hold the person's sign-ins. To read files, use \
             workspace_read and workspace_search instead.",
            json!({ "type": "object",
                    "properties": { "command": { "type": "string" },
                                    "timeout_s": { "type": "integer", "minimum": 1 },
                                    "outside_sandbox": { "type": "boolean",
                                        "description": "Ask the person to run this one command outside the sandbox." } },
                    "required": ["command"] }),
            Risk::Write,
            // A command can bring in anything: its output is untrusted, and so is every file it
            // makes or changes (only Spade's file tools make trusted files).
            true,
        )
    }

    /// Where the command runs (ADR 0171): in the bot's sandbox, where nothing classifies it;
    /// asking to run outside it this once; or outside it (the bot's setting, or a machine with
    /// no sandbox), classed by what it runs from the folder it would start in (where the bot's
    /// terminal is now, else its workspace), with the scripts it runs read for the reviewer.
    fn classed(&self, key: &str, arguments: &Value) -> spade_core::autonomy::Classed {
        use spade_core::autonomy::{Classed, classify_shell, shell::Lexical};
        let workspace = self
            .place
            .workspace(key)
            .ok()
            .and_then(|workspace| workspace.path().ok());
        let Some(workspace) = workspace else {
            return classify_shell(arguments, &Lexical);
        };
        // Its home is the workspace whatever folder it starts in, so the bot's sandbox holds it.
        let asks = self.shell.contains(&workspace) && !self.shell.outside(&workspace);
        if asks && !asks_outside(arguments) {
            return Classed::sandboxed();
        }
        // Where the command starts, and the environment it starts with.
        let (start, env) = match &self.shell {
            Commands::Terminal(terminals) => {
                let terminal = self
                    .place
                    .bots
                    .agent_for_key(key)
                    .and_then(|bot| terminals.of(&bot).ok());
                let session = self.place.bots.session_for_key(key);
                let start = terminal
                    .as_ref()
                    .map(|t| t.start_dir(&session))
                    .filter(|dir| !dir.as_os_str().is_empty());
                let env = terminal.map(|t| t.start_environment(&session));
                (start, env)
            }
            Commands::OneShot(shell) => (None, Some(shell.environment(&workspace))),
        };
        let start = start.unwrap_or_else(|| workspace.clone());
        // The folder the classifier places paths against, when the command starts in it.
        // As Spade names it to the bot, so the paths the bot writes match it.
        let folder = std::fs::canonicalize(&workspace)
            .ok()
            .filter(|root| std::fs::canonicalize(&start).is_ok_and(|start| start.starts_with(root)))
            .map(|_| workspace.clone());
        let classed = match super::place::FsPlace::new(start.clone(), &workspace) {
            Some(place) => classify_shell(arguments, &place),
            None => classify_shell(arguments, &Lexical),
        };
        // What configuration around the folder could make git, a package manager, cargo or
        // ripgrep run (ADR 0172, amendment 2); unknown without the command's environment.
        let config_clean = match (&folder, env) {
            (Some(_), Some(env)) => {
                spade_classify::inspect(&super::ambient::Disk { env }, &start, &workspace)
            }
            _ => spade_core::autonomy::ConfigTools::default(),
        };
        // A command settles only if a read-only sandbox is available and every program it runs
        // resolves on the clean PATH (ADR 0172, amendment 7); otherwise it goes to the reviewer.
        let command = arguments
            .get("command")
            .and_then(Value::as_str)
            .unwrap_or("");
        let sandboxable = match &self.shell {
            Commands::OneShot(shell) => shell.read_only_settles(command),
            Commands::Terminal(terminals) => terminals.read_only_settles(command),
        };
        let classed = spade_core::autonomy::Classed {
            workspace: folder.map(|root| root.to_string_lossy().into_owned()),
            config_clean,
            sandboxable,
            ..classed
        };
        // Asking to run outside: what it would run there is read now, so the request is bound
        // to those files and a script it reads secrets in is refused.
        if asks {
            return Classed {
                runs: spade_core::autonomy::Runs::AsksOutside,
                ..classed
            };
        }
        classed
    }

    /// "Always" allows this exact command, nothing like it.
    fn always_scope(&self, arguments: &Value) -> Option<String> {
        Some(
            arguments
                .get("command")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
        )
    }

    /// In the bot's terminal, "always" covers the command run from the folder and with the
    /// variables it has now; when either changes, the same command asks again.
    fn always_scope_in(&self, key: &str, arguments: &Value) -> Option<String> {
        let command = self.always_scope(arguments)?;
        let Commands::Terminal(terminals) = &self.shell else {
            return Some(command);
        };
        let digest = self
            .place
            .bots
            .agent_for_key(key)
            .and_then(|bot| terminals.of(&bot).ok())
            .map(|terminal| terminal.state_digest(&self.place.bots.session_for_key(key)))
            .unwrap_or_default();
        Some(format!("{command}{STATE}{digest}]"))
    }

    fn run(&self, key: &str, arguments: Value) -> ToolFuture {
        let workspace = self.place.workspace(key);
        let shell = self.shell.clone();
        let name = output_name(key);
        let (place, key) = (self.place.clone(), key.to_owned());
        Box::pin(async move {
            let args: ShellArgs = match parse(arguments) {
                Ok(args) => args,
                Err(output) => return output,
            };
            let workspace = match workspace {
                Ok(workspace) => workspace,
                Err(output) => return output,
            };
            let dir = match workspace.path() {
                Ok(dir) => dir,
                Err(error) => return ToolOutput::error(error.to_string()),
            };
            let timeout = args
                .timeout_s
                .map_or(SHELL_TIMEOUT, Duration::from_secs)
                .max(Duration::from_secs(1));
            // What the gate authorized for this call, decided once there and never again here
            // (ADR 0171; ADR 0167 Windows hardening): a call cleared to run contained launches
            // only contained, and is refused if the sandbox no longer holds it. With no engine
            // (no gate), a command runs as the sandbox finds it.
            let contains_now = shell.contains(&dir);
            let launch = match place.bots.get() {
                Some(engine) => engine.take_launch(&key),
                None if contains_now => Launch::Contained,
                None => Launch::Reviewed,
            };
            let plan = match launch.plan(contains_now) {
                Ok(plan) => plan,
                Err(refused) => return ToolOutput::error(refused),
            };
            let (outside, sandboxed) = (plan.outside, plan.sandboxed);
            // A call Spade's classifier settled runs only in the form it was settled for, with
            // the overrides that make it ignore configuration that could run a program, whatever
            // the files say now (ADR 0172, amendment 3). Checked again from the command itself.
            let form = place
                .bots
                .get()
                .and_then(|engine| engine.take_hardening(&key));
            if let Some(form) = &form
                && spade_classify::hardening(&args.command).as_ref() != Some(form)
            {
                return ToolOutput::error(
                    "Not run: it can't run with Spade's configuration overrides now. Call it \
                     again to have it reviewed."
                        .to_owned(),
                );
            }
            let overrides: &[(String, String)] = form.as_ref().map_or(&[], |f| f.env.as_slice());
            let ran = match &shell {
                Commands::OneShot(shell) => {
                    shell
                        .run_job(crate::workspace::shell::Job {
                            dir: &dir,
                            script: &args.command,
                            timeout,
                            env: overrides,
                            tee: None,
                            cleanup: None,
                            stdin: None,
                            kind: crate::workspace::shell::Kind::Command,
                            outside,
                            // Only a call reviewed or approved without relying on the sandbox
                            // may run uncontained; one cleared as contained must not.
                            may_run_uncontained: plan.may_run_uncontained,
                            clean: form.is_some(),
                            read_only: form.is_some(),
                        })
                        .await
                }
                Commands::Terminal(terminals) => {
                    in_terminal(
                        &place,
                        &key,
                        terminals,
                        &args.command,
                        timeout,
                        outside,
                        overrides,
                    )
                    .await
                }
            };
            // Whatever the command did to the folder, the app looks again.
            place.files_changed(&key, None);
            let failed = ran
                .as_ref()
                .map_or(true, |ran| ran.timed_out || ran.code != Some(0));
            let mut text = match &ran {
                Ok(ran) => describe(ran, timeout),
                Err(error) => error.clone(),
            };
            // What the sandbox stopped, said so the bot can ask to run it outside.
            if failed
                && sandboxed
                && let Some(kind) = spade_core::effect::blocked(&text)
            {
                text.push('\n');
                text.push_str(spade_core::effect::blocked_hint(kind));
            }
            // Nothing a command makes is trusted, so nothing needs marking here.
            let shown = tokio::task::spawn_blocking(move || workspace.keep_large(&name, &text))
                .await
                .unwrap_or_else(|_| "The output could not be read.".to_owned());
            if failed {
                ToolOutput::error(shown)
            } else {
                ToolOutput::ok(shown)
            }
        })
    }
}

/// How a terminal command's scope names the state it was allowed in.
const STATE: &str = "\n[terminal state ";

/// Runs the bot's command in its terminal; refused while the person has its computer, and when
/// the terminal is no longer in the state the command was allowed in.
async fn in_terminal(
    place: &Place,
    key: &str,
    terminals: &crate::computer::Terminals,
    command: &str,
    timeout: Duration,
    outside: bool,
    overrides: &[(String, String)],
) -> Result<Ran, String> {
    let bot = place
        .bots
        .agent_for_key(key)
        .ok_or_else(|| "This conversation has no bot, so no terminal.".to_owned())?;
    let held = place
        .bots
        .get()
        .and_then(|engine| engine.computers().cloned())
        .is_some_and(|c| c.driver(&bot) == crate::computer::Driver::Person);
    if held {
        return Err(
            "The person has your computer right now; wait until they hand it back.".to_owned(),
        );
    }
    // The folder and variables the call was allowed with, if it was allowed for them.
    let expected = place
        .bots
        .get()
        .and_then(|engine| engine.allowed_scope(key))
        .and_then(|scope| {
            scope
                .rsplit_once(STATE)
                .map(|(_, digest)| digest.trim_end_matches(']').to_owned())
        });
    let session = place.bots.session_for_key(key);
    terminals
        .of(&bot)?
        .run_in_state(
            &session,
            command,
            timeout,
            expected.as_deref(),
            outside,
            overrides,
            !overrides.is_empty(),
        )
        .await
}

/// A run as the model reads it: how it ended, then its output.
fn describe(ran: &Ran, timeout: Duration) -> String {
    let mut text = if ran.timed_out {
        format!(
            "Stopped after {} seconds: it had not finished, so it was killed with everything it \
             started.",
            timeout.as_secs()
        )
    } else {
        match ran.code {
            Some(code) => format!("Exit code {code}."),
            None => "Ended by a signal.".to_owned(),
        }
    };
    if !ran.stdout.is_empty() {
        text.push('\n');
        text.push_str(&ran.stdout);
    }
    if !ran.stderr.is_empty() {
        text.push_str("\n[stderr]\n");
        text.push_str(&ran.stderr);
    }
    if ran.cut {
        text.push_str(
            "\n[Some output was dropped: past 4 MiB, or still coming when the command ended.]",
        );
    }
    if ran.incomplete {
        text.push_str(
            "\n[Not every process this command started could be seen to stop; some may still \
             be running.]",
        );
    }
    text
}
