//! The `shell` tool, and the runner it shares with `python`: a command started under the launch
//! the gate gave its call, in the one-shot shell or the bot's terminal, then described for the
//! model.

use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};
use spade_core::tools::{Risk, ToolDef};

use super::Workspace;
use super::shell::{Launch, Ran};
use super::tools::{Commands, Place, SHELL_TIMEOUT, output_name, shown_def};
use crate::tools::{Tool, ToolFuture, ToolOutput, parse};

#[derive(Clone)]
pub struct ShellTool {
    pub(super) place: Place,
    pub(super) shell: Commands,
}

#[derive(Deserialize)]
struct ShellArgs {
    command: String,
    #[serde(default)]
    timeout_s: Option<u64>,
}

/// Whether a `shell` call asks to run outside the sandbox (ADR 0171).
pub fn asks_outside(arguments: &Value) -> bool {
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
        // What it runs, read as its start outside the sandbox will read it again
        // (`outside::admit`): the scripts, the programs its `PATH` finds and the configuration
        // of the tools it runs (ADR 0172, amendment 2). Without the command's environment
        // nothing is found, and the reading is incomplete.
        let read = super::outside::read(&workspace, &start, &env.unwrap_or_default(), arguments);
        // The classifier settles only from the folder the command starts in, inside the bot's.
        let config_clean = match &folder {
            Some(_) => read.config_clean,
            None => spade_core::autonomy::ConfigTools::default(),
        };
        let classed = read;
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
            let timeout = args
                .timeout_s
                .map_or(SHELL_TIMEOUT, Duration::from_secs)
                .max(Duration::from_secs(1));
            let run = Run {
                command: &args.command,
                timeout,
                output_name: &name,
            };
            run_command(&place, &shell, &key, &workspace, run).await
        })
    }
}

/// A command a tool runs for its call.
pub(super) struct Run<'a> {
    pub command: &'a str,
    pub timeout: Duration,
    /// The file name a long output is kept under (`.spade/outputs`).
    pub output_name: &'a str,
}

/// Runs a command for the call with `key` in the bot's workspace, launched as the gate cleared
/// the call (in its sandbox, or as reviewed), and answers its result as the model reads it: how
/// it ended, then its output (a long one kept as a file), with where it ran for the reply's steps.
pub(super) async fn run_command(
    place: &Place,
    shell: &Commands,
    key: &str,
    workspace: &Workspace,
    run: Run<'_>,
) -> ToolOutput {
    let dir = match workspace.path() {
        Ok(dir) => dir,
        Err(error) => return ToolOutput::error(error.to_string()),
    };
    let Run {
        command,
        timeout,
        output_name,
    } = run;
    // What the gate authorized for this call, decided once there and never again here
    // (ADR 0171; ADR 0167 Windows hardening): a call cleared to run contained launches
    // only contained, and is refused if the sandbox no longer holds it. With no engine
    // (no gate), a command runs as the sandbox finds it.
    let contains_now = shell.contains(&dir);
    // With it, the warrant of the verdict that let it run, which a start outside the
    // sandbox must pass at its spawn (ADR 0171, amendment 5): under the terminal's lock for
    // a terminal command, so no earlier command can rewrite what it runs in between. With
    // no gate there is no warrant, and nothing starts plainly.
    let (launch, warrant) = match place.bots.get() {
        Some(engine) => engine.take_launch(key),
        None if contains_now => (Launch::Contained, None),
        None => (Launch::Reviewed, None),
    };
    let by = crate::workspace::shell::By::Bot(warrant);
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
        .and_then(|engine| engine.take_hardening(key));
    if let Some(form) = &form
        && spade_classify::hardening(command).as_ref() != Some(form)
    {
        return ToolOutput::error(
            "Not run: it can't run with Spade's configuration overrides now. Call it \
             again to have it reviewed."
                .to_owned(),
        );
    }
    let overrides: &[(String, String)] = form.as_ref().map_or(&[], |f| f.env.as_slice());
    let ran = match shell {
        Commands::OneShot(shell) => {
            shell
                .run_job(crate::workspace::shell::Job {
                    dir: &dir,
                    script: command,
                    asked: None,
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
                    contained_only: plan.contained_only(),
                    by,
                    clean: form.is_some(),
                    read_only: form.is_some(),
                })
                .await
        }
        Commands::Terminal(terminals) => {
            let run = TerminalRun {
                command,
                timeout,
                plan,
                overrides,
                by,
            };
            in_terminal(place, key, terminals, run).await
        }
    };
    // Whatever the command did to the folder, the app looks again.
    place.files_changed(key, None);
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
    let (kept, name) = (workspace.clone(), output_name.to_owned());
    let shown = tokio::task::spawn_blocking(move || kept.keep_large(&name, &text))
        .await
        .unwrap_or_else(|_| "The output could not be read.".to_owned());
    let output = if failed {
        ToolOutput::error(shown)
    } else {
        ToolOutput::ok(shown)
    };
    ToolOutput {
        // Where it ran and what the sandbox did with it, for the reply's steps; a
        // command that never started has nothing to say there beyond its result.
        command: ran.ok().map(|ran| Box::new(command_run(ran))),
        ..output
    }
}

/// How a terminal command's scope names the state it was allowed in.
const STATE: &str = "\n[terminal state ";

/// A command for the bot's terminal, as the gate cleared it.
struct TerminalRun<'a> {
    command: &'a str,
    timeout: Duration,
    plan: crate::workspace::shell::LaunchPlan,
    /// The classifier's configuration overrides it runs with, if any.
    overrides: &'a [(String, String)],
    /// A bot's, with the warrant its start outside the sandbox must pass, read again under the
    /// terminal's lock right before it starts.
    by: crate::workspace::shell::By,
}

/// Runs the bot's command in its terminal; refused while the person has its computer, and when
/// the terminal is no longer in the state the command was allowed in.
async fn in_terminal(
    place: &Place,
    key: &str,
    terminals: &crate::computer::Terminals,
    run: TerminalRun<'_>,
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
            run.command,
            run.timeout,
            expected.as_deref(),
            run.plan,
            run.overrides,
            !run.overrides.is_empty(),
            run.by,
        )
        .await
}

/// Where a command ran and how it went, as its step shows it (`command_ran`).
fn command_run(ran: Ran) -> crate::tools::CommandRun {
    crate::tools::CommandRun {
        contained: ran.contained,
        exit_code: ran.code,
        timed_out: ran.timed_out,
        reached: ran.network.reached,
        refused: ran
            .network
            .refused
            .into_iter()
            .map(|r| spade_core::event::RefusedHost {
                host: r.host,
                port: r.port,
                reason: r.reason,
            })
            .collect(),
    }
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
