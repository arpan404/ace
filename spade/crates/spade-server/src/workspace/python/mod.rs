//! The `python` tool: runs Python code, or a script in the workspace, in the bot's sandbox
//! through the same runner as `shell` (the gate's launch, the terminal, the background window and
//! the output rules all come from there). ADR 0220.
//!
//! The Python a bot runs is Spade's, not the workspace's. Each bot has a runtime folder,
//! `<workspaces>/.python/<bot>/`, outside its workspace, which every run of the bot may read and
//! none may write but Spade's own set-up, and that only in the new environment it builds
//! (`runtime.rs`). Packages are installed only with uv, which never starts the environment's
//! Python, from one index, as binary wheels whose hashes the resolution fixed. Each change builds
//! a new environment generation, which Spade checks and then makes current; a run keeps the
//! generation it started with. A run's script, and the workspace modules it may import (the
//! trusted ones), are staged when the gate classes the call, and only those staged bytes run.

mod generation;
mod runtime;
mod scripts;

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};
use spade_core::tools::{Risk, ToolDef};

pub use generation::Generation;
use runtime::Runtime;
pub use scripts::{
    BOOT, LAUNCHER, MOST_ASKED, Origin, Staged, asked_packages, command, module_of, package_spec,
    setup_script,
};

use super::shell::{By, Job, Kind};
use super::shell_tool::{Run, ShellTool, cleared, run_cleared};
use super::tools::{Commands, Place, output_name, shown_def};
use super::walk::{Stamp, Stamps};
use super::{PathError, Workspace};
use crate::tools::{Tool, ToolFuture, ToolOutput, parse};

/// The tool's name.
pub const PYTHON: &str = "python";

/// Where every bot's Python runtime is, inside the workspaces' root (outside every bot's own
/// folder: bot ids never start with a dot).
pub const RUNTIMES: &str = ".python";

/// The bot's Python runtime folder under the workspaces' root `root`.
pub fn runtime_of(root: &Path, bot: &str) -> PathBuf {
    root.join(RUNTIMES).join(bot)
}

/// The packages a bot's environment starts with, locked with everything they need (resolved from
/// PyPI as binary wheels for CPython 3.11 and newer, 2026-11-23).
pub const DEFAULT_PACKAGES: &[&str] = &[
    "certifi==2026.11.20",
    "charset-normalizer==3.5.3",
    "contourpy==1.3.3",
    "cycler==0.12.1",
    "et-xmlfile==2.0.0",
    "fonttools==4.68.0",
    "idna==3.20",
    "kiwisolver==1.5.1",
    "lxml==6.1.3",
    "matplotlib==3.11.2",
    "numpy==2.4.6",
    "openpyxl==3.1.5",
    "packaging==26.3",
    "pandas==3.1.1",
    "pillow==13.0.0",
    "pyparsing==3.3.3",
    "pypdf==7.1.1",
    "python-dateutil==4.0.0",
    "python-docx==1.2.0",
    "requests==2.34.2",
    "typing-extensions==4.16.0",
    "tzdata==2026.6",
    "urllib3==2.8.0",
];

/// The CPython uv is asked for first.
pub const PINNED: &str = "3.12";

/// The one index packages come from by default.
pub const PYPI: &str = "https://pypi.org/simple";

/// The most images a run attaches to its result.
const MOST_IMAGES: usize = crate::images::MOST_IMAGES;
/// The most changed files a result names.
const MOST_NAMED: usize = 50;
/// The longest the set-up of one environment may take (a CPython download and the packages).
const SETUP_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// The largest script, or workspace module, a run stages.
const LARGEST_SCRIPT: u64 = super::files::LARGEST_WRITE as u64;
/// The most staged calls kept waiting for their run (a call classed but never run).
const MOST_STAGED: usize = 1_000;
/// The most workspace modules staged with one script.
const MOST_MODULES: usize = 500;
/// Environment generations kept: the current one and those runs started on before it.
const KEEP_GENERATIONS: usize = 3;

/// Where packages come from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Index {
    /// This index URL and nothing else.
    Url(String),
    /// Wheels in this folder of the bot's runtime (relative to it), and no index at all.
    Folder(String),
}

/// How the tool finds Python and what a new environment starts with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Setup {
    /// Folders looked in, in order, for `uv` and for `python3.x`.
    pub folders: Vec<PathBuf>,
    /// The CPython version uv is asked for first, as a uv-managed one (downloaded once for the
    /// bot); `None` to use only a Python already on the machine.
    pub pinned: Option<String>,
    /// The locked packages (`name==version`), binary wheels only.
    pub packages: Vec<String>,
    pub index: Index,
}

impl Setup {
    /// As Spade runs: the system folders commands find programs in (the clean `PATH`), the
    /// pinned version, the default packages from PyPI.
    pub fn system() -> Self {
        Self {
            folders: SYSTEM_FOLDERS.iter().map(PathBuf::from).collect(),
            pinned: Some(PINNED.to_owned()),
            packages: DEFAULT_PACKAGES.iter().map(|&p| p.to_owned()).collect(),
            index: Index::Url(PYPI.to_owned()),
        }
    }

    /// Whether uv is where the set-up looks for it: packages are installed only with uv.
    fn uv(&self) -> bool {
        self.folders
            .iter()
            .any(|folder| folder.join("uv").is_file())
    }
}

/// The folders a command's clean `PATH` holds (`shell.rs`), where uv and Python are looked for.
const SYSTEM_FOLDERS: &[&str] = &["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin"];

/// Python versions looked for by name in each folder, newest first, then plain `python3`.
const NAMES: &[&str] = &[
    "python3.14",
    "python3.13",
    "python3.12",
    "python3.11",
    "python3.10",
    "python3",
];

/// What a run made or changed in the workspace, in words, from its files' stamps before and
/// after it (`cut`: more files than one look covers). Answers the words and the files made or
/// changed.
pub fn made(before: &Stamps, after: &Stamps, cut: bool) -> (String, Vec<String>) {
    let mut lines = Vec::new();
    let mut files = Vec::new();
    for (path, now) in after {
        let how = match before.get(path) {
            None => "new",
            Some(was) if was != now => "changed",
            Some(_) => continue,
        };
        lines.push(format!("{path} ({how}, {} bytes)", now.size));
        files.push(path.clone());
    }
    for path in before.keys().filter(|path| !after.contains_key(*path)) {
        lines.push(format!("{path} (removed)"));
    }
    lines.sort();
    if lines.is_empty() && !cut {
        return (String::new(), files);
    }
    let count = lines.len();
    lines.truncate(MOST_NAMED);
    let mut text = format!("Files it made or changed:\n{}", lines.join("\n"));
    if count > MOST_NAMED {
        text.push_str(&format!("\n[and {} more]", count - MOST_NAMED));
    }
    if cut {
        text.push_str(
            "\n[The workspace holds more files than Spade looks at; some may be missing.]",
        );
    }
    (text, files)
}

pub struct PythonTool {
    commands: ShellTool,
    setup: Arc<Setup>,
    /// Each call's staged script as the gate classed it, by call key.
    staged: Arc<Mutex<HashMap<String, Staged>>>,
    /// Held while a bot's environment is checked and a generation built, so two never build at
    /// once.
    setups: Arc<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>>,
}

impl PythonTool {
    pub(super) fn new(commands: ShellTool, setup: Setup) -> Self {
        Self {
            commands,
            setup: Arc::new(setup),
            staged: Arc::default(),
            setups: Arc::default(),
        }
    }

    /// Whether the bot's sandbox holds its commands, the only place this tool runs.
    fn held(&self, workspace: &Path) -> bool {
        self.commands.shell.contains(workspace) && !self.commands.shell.outside(workspace)
    }

    /// The calling bot's runtime.
    fn runtime(&self, key: &str) -> Option<Runtime> {
        let bot = self.commands.place.bots.agent_for_key(key)?;
        let root = self.commands.place.all.python_runtime(&bot).ok()?;
        Some(Runtime { root })
    }

    /// The lock a bot's environment is built under.
    fn setup_lock(&self, key: &str) -> Arc<tokio::sync::Mutex<()>> {
        let Some(bot) = self.commands.place.bots.agent_for_key(key) else {
            return Arc::default();
        };
        self.setups
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .entry(bot)
            .or_default()
            .clone()
    }
}

#[derive(Deserialize)]
struct PythonArgs {
    #[serde(default)]
    code: Option<String>,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    packages: Vec<String>,
    #[serde(default)]
    timeout_s: Option<u64>,
}

/// What the run is: code, or a script already in the workspace.
#[derive(Clone)]
enum Script {
    Code(String),
    Path(String),
}

impl PythonArgs {
    fn script(&self) -> Result<Script, String> {
        match (&self.code, &self.path) {
            (Some(code), None) if !code.trim().is_empty() => Ok(Script::Code(code.clone())),
            (None, Some(path)) if !path.trim().is_empty() => Ok(Script::Path(path.clone())),
            (Some(_), Some(_)) => Err("give code or path, not both".to_owned()),
            _ => Err("give the code to run, or the path of a script in your workspace".to_owned()),
        }
    }
}

/// The script's bytes, and for a workspace script its path: the code, or the file read through
/// real folders only.
fn script_bytes(
    workspace: &Workspace,
    script: &Script,
) -> Result<(Vec<u8>, Option<String>), PathError> {
    match script {
        Script::Code(code) => Ok((code.as_bytes().to_vec(), None)),
        Script::Path(path) => {
            let path = workspace.normal(path)?;
            let bytes = workspace.bytes_no_follow(&path, LARGEST_SCRIPT)?;
            Ok((bytes, Some(path)))
        }
    }
}

/// The workspace modules a script may import, staged: each `.py` under its folder that Spade's
/// file tools wrote from a clean prompt (its bytes still the ones recorded), staged as read now;
/// the others listed as refused. As the JSON `boot.py` reads.
fn modules(workspace: &Workspace, runtime: &Runtime, folder: &str) -> Result<Vec<u8>, PathError> {
    let mut allowed = BTreeMap::new();
    let mut refused = Vec::new();
    let prefix = if folder.is_empty() {
        String::new()
    } else {
        format!("{folder}/")
    };
    for path in workspace.python_files(folder, MOST_MODULES)? {
        let Some((name, package)) = path.strip_prefix(&prefix).and_then(scripts::module_of) else {
            continue;
        };
        // Read only when it has a trust record; trusted only when its bytes still match it.
        let trusted = workspace
            .trust()
            .has(&path)
            .then(|| workspace.bytes_no_follow(&path, LARGEST_SCRIPT).ok())
            .flatten()
            .filter(|bytes| workspace.file_trusted(&path, bytes));
        match trusted {
            Some(bytes) => {
                let staged = runtime
                    .stage(&bytes, "py")
                    .map_err(|e| PathError::Io(format!("a module could not be staged: {e}")))?;
                allowed.insert(name, json!({ "file": staged, "package": package }));
            }
            None => refused.push(name),
        }
    }
    serde_json::to_vec(&json!({ "modules": allowed, "refused": refused }))
        .map_err(|e| PathError::Io(e.to_string()))
}

/// Stages a call's script and its modules. Answers what the run starts and, for a workspace
/// script, the text the reviewer is shown.
fn stage(
    workspace: &Workspace,
    runtime: &Runtime,
    script: &Script,
) -> Result<(Staged, Option<spade_core::autonomy::shell::Shown>), PathError> {
    let dir = workspace.path()?;
    let (bytes, path) = script_bytes(workspace, script)?;
    let origin = Origin::of(&dir, path.as_deref());
    let staged_script = runtime
        .stage(&bytes, "py")
        .map_err(|e| PathError::Io(format!("the script could not be staged: {e}")))?;
    let listed = modules(workspace, runtime, &origin.folder)?;
    let staged_modules = runtime
        .stage(&listed, "json")
        .map_err(|e| PathError::Io(format!("the script's modules could not be staged: {e}")))?;
    let shown = path.map(|path| spade_core::autonomy::shell::Shown {
        path,
        content: String::from_utf8_lossy(&bytes).into_owned(),
    });
    Ok((
        Staged {
            script: staged_script,
            modules: staged_modules,
            name: origin.name,
        },
        shown,
    ))
}

/// Why the tool doesn't run here.
const NOT_HELD: &str = "Not run: the python tool runs only inside Spade's sandbox, which isn't \
                        holding your commands here. Run python3 with shell instead.";

/// Why a call without its staged script doesn't run.
const NOT_STAGED: &str = "Not run: Spade runs only the copy of the script it took when the call \
                          was checked, and it has none for this call (it couldn't be written, or \
                          Spade restarted since). Call python again.";

impl Tool for PythonTool {
    fn def(&self) -> ToolDef {
        shown_def(
            PYTHON,
            "Runs Python 3 in your workspace folder: code, or the script at path with args (it \
             runs as read when you call; modules beside it import if you wrote them with \
             workspace_write). Your own environment has pandas, numpy, matplotlib (saves to \
             files; no windows), openpyxl, python-docx, pypdf and requests; packages adds more \
             from PyPI first (name or name==version, binary wheels only, kept for later runs). \
             Answers the exit code, the output and the files it made or changed; images it saved \
             are shown. Same sandbox, timeout_s and 30-second background rule as shell.",
            json!({ "type": "object",
                    "properties": { "code": { "type": "string" },
                                    "path": { "type": "string" },
                                    "args": { "type": "array", "items": { "type": "string" } },
                                    "packages": { "type": "array", "items": { "type": "string" },
                                                  "maxItems": MOST_ASKED },
                                    "timeout_s": { "type": "integer", "minimum": 1 } } }),
            Risk::Write,
            // Like a command, anything it reads or makes is untrusted.
            true,
        )
    }

    /// In the bot's sandbox, as `shell` is: the OS holds it and nothing classifies it. The script
    /// and its trusted modules are staged now, so what a reviewer is shown (a workspace script's
    /// whole text, and the packages asked for in the arguments) is what runs. Where the sandbox
    /// doesn't hold the bot's commands, the call is refused before anything runs.
    fn classed(&self, key: &str, arguments: &Value) -> spade_core::autonomy::Classed {
        use spade_core::autonomy::Classed;
        let Ok(workspace) = self.commands.place.workspace(key) else {
            return Classed::default();
        };
        if !workspace.path().ok().is_some_and(|path| self.held(&path)) {
            return Classed::default();
        }
        let script = parse::<PythonArgs>(arguments.clone())
            .ok()
            .and_then(|args| args.script().ok());
        let (Some(script), Some(runtime)) = (script, self.runtime(key)) else {
            return Classed::sandboxed();
        };
        // Unstaged, the run refuses: nothing is read from the workspace after this.
        let Ok((staged, shown)) = stage(&workspace, &runtime, &script) else {
            return Classed::sandboxed();
        };
        let mut all = self.staged.lock().unwrap_or_else(|p| p.into_inner());
        if all.len() >= MOST_STAGED {
            all.clear();
        }
        all.entry(key.to_owned()).or_insert(staged);
        Classed {
            shown: shown.into_iter().collect(),
            ..Classed::sandboxed()
        }
    }

    /// "Always" covers this exact run: the same code, or the same script with the same args, and
    /// the same packages.
    fn always_scope(&self, arguments: &Value) -> Option<String> {
        let field = |name: &str| arguments.get(name).cloned().unwrap_or(Value::Null);
        Some(
            json!([
                field("code"),
                field("path"),
                field("args"),
                field("packages")
            ])
            .to_string(),
        )
    }

    fn run(&self, key: &str, arguments: Value) -> ToolFuture {
        let args: PythonArgs = match parse(arguments) {
            Ok(args) => args,
            Err(output) => return Box::pin(async move { output }),
        };
        if let Err(why) = args.script() {
            return Box::pin(async move { ToolOutput::error(why) });
        }
        // Checked before anything is written or run.
        let asked = match asked_packages(&args.packages) {
            Ok(asked) => asked,
            Err(why) => return Box::pin(async move { ToolOutput::error(why) }),
        };
        let workspace = match self.commands.place.workspace(key) {
            Ok(workspace) => workspace,
            Err(output) => return Box::pin(async move { output }),
        };
        let dir = match workspace.path() {
            Ok(dir) => dir,
            Err(error) => return Box::pin(async move { ToolOutput::error(error.to_string()) }),
        };
        if cfg!(windows) {
            return Box::pin(async {
                ToolOutput::error(
                    "Not run: the python tool isn't available on Windows yet. Run python with \
                     shell instead.",
                )
            });
        }
        let staged = self
            .staged
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(key);
        if !self.held(&dir) {
            return Box::pin(async { ToolOutput::error(NOT_HELD) });
        }
        let (Some(staged), Some(runtime)) = (staged, self.runtime(key)) else {
            return Box::pin(async { ToolOutput::error(NOT_STAGED) });
        };
        let uv = self.setup.uv();
        if !asked.is_empty() && !uv {
            return Box::pin(async {
                ToolOutput::error(
                    "Not run: Spade installs packages only with uv, which isn't on this machine, \
                     so this Python has only its standard library. The person can install uv, \
                     for example with Homebrew: brew install uv.",
                )
            });
        }
        let lock = self.setup_lock(key);
        let (place, shell) = (self.commands.place.clone(), self.commands.shell.clone());
        let setup = self.setup.clone();
        let name = output_name(key);
        let key = key.to_owned();
        Box::pin(async move {
            let intact = {
                let (runtime, staged) = (runtime.clone(), staged.clone());
                tokio::task::spawn_blocking(move || {
                    runtime.staged_intact(&staged.script) && runtime.staged_intact(&staged.modules)
                })
                .await
                .unwrap_or(false)
            };
            if !intact {
                return ToolOutput::error(NOT_STAGED);
            }
            // The launch the gate cleared, taken once for the set-up and the run.
            let (plan, by) = match cleared(&place, &shell, &key, &dir) {
                Ok(cleared) => cleared,
                Err(refused) => return refused,
            };
            if !plan.sandboxed {
                return ToolOutput::error(NOT_HELD);
            }
            let (generation, notes) = {
                let _one = lock.lock().await;
                match ensure(&shell, &dir, &runtime, &setup, &asked, uv).await {
                    Ok(ready) => ready,
                    Err(failed) => return failed,
                }
            };
            let before = {
                let workspace = workspace.clone();
                tokio::task::spawn_blocking(move || workspace.stamps())
                    .await
                    .ok()
                    .and_then(Result::ok)
            };
            let timeout = args
                .timeout_s
                .map_or(super::tools::SHELL_TIMEOUT, Duration::from_secs)
                .max(Duration::from_secs(1));
            // The generation current now, which the run keeps whatever is built after.
            let environment = runtime.environment(&generation.id);
            let command = command(&runtime.control(), &environment, &dir, &staged, &args.args);
            let run = Run {
                command: &command,
                timeout,
                output_name: &name,
            };
            let output = run_cleared(&place, &shell, &key, &workspace, run, plan, by).await;
            let found = match before {
                Some((before, _)) => {
                    tokio::task::spawn_blocking(move || look_again(&workspace, &before))
                        .await
                        .unwrap_or_default()
                }
                None => Found::default(),
            };
            with_files(&place, output, &notes, found)
        })
    }
}

/// The digest naming a set-up: its script and its locked packages.
fn setup_digest(script: &str, locked: &str) -> String {
    super::trust::hash(format!("{script}\n{locked}").as_bytes())
}

/// The bot's current environment generation, built first when there is none fitting this
/// set-up, or one lacks a package the call `asked` for: Spade's script, in a contained run of its
/// own that may write only the new generation and uv's folders, then Spade's check of what it
/// installed, then the switch. Answers the generation and what the set-up said, or the result
/// when it failed (the call's script then doesn't run).
async fn ensure(
    shell: &Commands,
    dir: &Path,
    runtime: &Runtime,
    setup: &Setup,
    asked: &[String],
    uv: bool,
) -> Result<(Generation, String), ToolOutput> {
    let script = setup_script(setup);
    let locked: String = setup.packages.iter().map(|p| format!("{p}\n")).collect();
    let digest = setup_digest(&script, &locked);
    let prepared = {
        let (runtime, script, locked) = (runtime.clone(), script.clone(), locked.clone());
        tokio::task::spawn_blocking(move || {
            runtime.write_control(&[
                ("run.sh", LAUNCHER.as_bytes()),
                ("boot.py", BOOT.as_bytes()),
                ("setup.sh", script.as_bytes()),
                ("locked.txt", locked.as_bytes()),
            ])?;
            Ok::<_, std::io::Error>(runtime.current())
        })
        .await
    };
    let current = match prepared {
        Ok(Ok(current)) => current,
        Ok(Err(error)) => {
            return Err(ToolOutput::error(format!(
                "Spade couldn't write the bot's Python launcher: {error}"
            )));
        }
        Err(_) => return Err(ToolOutput::error("the file work stopped")),
    };
    let Some(specs) = generation::wanted(current.as_ref(), &digest, uv, &setup.packages, asked)
    else {
        return current
            .map(|current| (current, String::new()))
            .ok_or_else(|| ToolOutput::error("the bot's Python has no environment"));
    };
    let begun = {
        let runtime = runtime.clone();
        tokio::task::spawn_blocking(move || runtime.begin()).await
    };
    let (id, writable) = match begun {
        Ok(Ok(begun)) => begun,
        Ok(Err(error)) => {
            return Err(ToolOutput::error(format!(
                "Spade couldn't make the bot's Python environment: {error}"
            )));
        }
        Err(_) => return Err(ToolOutput::error("the file work stopped")),
    };
    let mut command = format!(
        "/bin/sh {} {}",
        scripts::quote(&runtime.control().join("setup.sh").to_string_lossy()),
        scripts::quote(&id)
    );
    for spec in &specs {
        command.push(' ');
        command.push_str(&scripts::quote(spec));
    }
    let ran = shell
        .one_shot()
        .run_job(Job {
            dir,
            script: &command,
            asked: None,
            timeout: SETUP_TIMEOUT,
            env: &[],
            tee: None,
            cleanup: None,
            stdin: None,
            kind: Kind::PythonSetup {
                runtime: runtime.root.clone(),
                writable,
            },
            outside: false,
            // Only ever contained: it is the one run that writes the bot's Python.
            may_run_uncontained: false,
            contained_only: true,
            by: By::Spade,
            clean: false,
            read_only: false,
        })
        .await;
    let discard = |runtime: &Runtime| runtime.discard(&id);
    let ran = match ran {
        Ok(ran) => ran,
        Err(why) => {
            discard(runtime);
            return Err(ToolOutput::error(format!(
                "Python could not be set up: {why}"
            )));
        }
    };
    let said = [ran.stdout.trim(), ran.stderr.trim()]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    if ran.timed_out || ran.code != Some(0) {
        discard(runtime);
        let how = match ran.code {
            Some(code) if !ran.timed_out => format!("Exit code {code}."),
            _ => "Python's set-up did not finish.".to_owned(),
        };
        return Err(ToolOutput::error(format!(
            "{how}\n{said}\n[The script was not run.]"
        )));
    }
    // What got installed, checked against what was resolved and asked for, before it counts.
    let extra: Vec<String> = specs
        .iter()
        .filter(|spec| !setup.packages.contains(spec))
        .cloned()
        .collect();
    let checked = {
        let (runtime, id, extra) = (runtime.clone(), id.clone(), extra.clone());
        tokio::task::spawn_blocking(move || {
            let (resolved, installed) = runtime.installed(&id).map_err(|e| e.to_string())?;
            let installed = if uv {
                generation::verify(&generation::pins(&resolved), &installed, &extra)?
            } else {
                BTreeMap::new()
            };
            let made = Generation {
                id: id.clone(),
                setup: digest,
                uv,
                asked: extra,
                installed,
            };
            runtime
                .switch(&made, KEEP_GENERATIONS)
                .map_err(|e| e.to_string())?;
            Ok::<_, String>(made)
        })
        .await
        .unwrap_or_else(|_| Err("the file work stopped".to_owned()))
    };
    match checked {
        Ok(made) => Ok((made, said)),
        Err(why) => {
            discard(runtime);
            Err(ToolOutput::error(format!(
                "{said}\n[Spade checked what was installed and didn't use it: {why}. The script \
                 was not run.]"
            )))
        }
    }
}

/// What a run left: the words naming the files it made or changed, and the images among them.
#[derive(Default)]
struct Found {
    text: String,
    images: Vec<Vec<u8>>,
}

fn look_again(workspace: &Workspace, before: &Stamps) -> Found {
    let Ok((after, cut)) = workspace.stamps() else {
        return Found::default();
    };
    let (text, files) = made(before, &after, cut);
    let images = files
        .iter()
        .filter(|path| {
            after
                .get(*path)
                .is_some_and(|stamp: &Stamp| stamp.size <= super::reading::LARGEST_IMAGE)
        })
        // Opened without following a link and checked to be a file once opened.
        .filter_map(|path| {
            workspace
                .bytes_no_follow(path, super::reading::LARGEST_IMAGE)
                .ok()
        })
        .filter(|bytes| crate::images::sniff(bytes).is_some())
        .take(MOST_IMAGES)
        .collect();
    Found { text, images }
}

/// The run's result after what the set-up said, with the files it made named, and its images
/// given to the model and shown to the person.
fn with_files(place: &Place, output: ToolOutput, notes: &str, found: Found) -> ToolOutput {
    let mut output = output;
    if !notes.is_empty() {
        output.content = format!("{notes}\n{}", output.content);
    }
    if !found.text.is_empty() {
        output.content.push_str("\n\n");
        output.content.push_str(&found.text);
    }
    if let Some(engine) = place.bots.get() {
        for bytes in &found.images {
            if let Ok(image) = engine.put_image(bytes) {
                output.shared.images.push(image);
            }
        }
    }
    output.images = found.images;
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stamp(size: u64, at: u128) -> Stamp {
        Stamp {
            size,
            modified: Some(at),
            inode: 1,
        }
    }

    #[test]
    fn a_run_names_the_files_it_made_changed_and_removed() {
        let before = Stamps::from([
            ("data.csv".to_owned(), stamp(10, 1)),
            ("old.txt".to_owned(), stamp(3, 1)),
            ("same.txt".to_owned(), stamp(3, 1)),
            ("rewritten.txt".to_owned(), stamp(3, 1)),
        ]);
        let after = Stamps::from([
            ("data.csv".to_owned(), stamp(12, 2)),
            ("out/chart.png".to_owned(), stamp(900, 2)),
            ("same.txt".to_owned(), stamp(3, 1)),
            // Same size and time, a new file renamed in place.
            (
                "rewritten.txt".to_owned(),
                Stamp {
                    inode: 2,
                    ..stamp(3, 1)
                },
            ),
        ]);
        let (text, files) = made(&before, &after, false);
        assert_eq!(
            text,
            "Files it made or changed:\ndata.csv (changed, 12 bytes)\nold.txt (removed)\n\
             out/chart.png (new, 900 bytes)\nrewritten.txt (changed, 3 bytes)"
        );
        assert_eq!(files, vec!["data.csv", "out/chart.png", "rewritten.txt"]);
        assert_eq!(made(&before, &before, false), (String::new(), Vec::new()));
        assert!(
            made(&before, &before, true)
                .0
                .contains("some may be missing")
        );
    }
}
