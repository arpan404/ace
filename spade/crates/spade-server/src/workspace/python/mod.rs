//! The `python` tool: runs Python code, or a script in the workspace, in the bot's sandbox
//! through the same runner as `shell` (the gate's launch, the terminal, the background window and
//! the output rules all come from there). ADR 0220.
//!
//! The Python is Spade's: one environment per machine with a fixed set of packages, built by
//! Spade itself on the host from the lock it ships (`machine.rs`), shared by every bot and
//! written by none. A run's script, and the workspace modules it may import (the trusted ones),
//! are staged in the bot's own folder when the gate classes the call (`staging.rs`); only those
//! staged bytes run, and a call the person allowed runs only if they are the bytes it was allowed
//! with.

mod environment;
mod machine;
mod scripts;
mod staging;
mod vetting;

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};
use spade_core::tools::{Risk, ToolDef};

use machine::Machine;
pub use scripts::{BOOT, LAUNCHER, Origin, Staged, command, module_of};
use staging::Staging;

use super::shell_tool::{Run, ShellTool, cleared, run_cleared};
use super::tools::{Place, output_name, shown_def};
use super::walk::{Stamp, Stamps};
use super::{PathError, Workspace};
use crate::tools::{Tool, ToolFuture, ToolOutput, parse};

/// The tool's name.
pub const PYTHON: &str = "python";

/// Where Spade's Python is, inside the workspaces' root (outside every bot's own folder: bot ids
/// never start with a dot): `shared/` for the machine, `bots/<bot>/` for each bot's staged
/// scripts.
pub const RUNTIMES: &str = ".python";

/// The bot's own Python folder (its staged scripts) under the workspaces' root `root`.
pub fn runtime_of(root: &Path, bot: &str) -> PathBuf {
    root.join(RUNTIMES).join("bots").join(bot)
}

/// The machine's shared Python folder under the workspaces' root `root`.
pub fn shared_of(root: &Path) -> PathBuf {
    root.join(RUNTIMES).join("shared")
}

/// What `bot`'s runs may read of Spade's Python: the launcher, the environments, the CPython
/// they were made from, and its own staged scripts. Nothing in any sandbox writes them.
pub fn readable(root: &Path, bot: &str) -> Vec<PathBuf> {
    let shared = shared_of(root);
    vec![
        shared.join("control"),
        shared.join("environments"),
        shared.join("pythons"),
        runtime_of(root, bot),
    ]
}

/// The lock Spade ships: the packages bots run with, pinned with every wheel's hash.
pub const LOCK: &str = include_str!("../../../../../config/python-lock.txt");

/// The packages the lock is for (it pins them and everything they need).
pub const PACKAGES: &[&str] = &[
    "pandas",
    "numpy",
    "matplotlib",
    "openpyxl",
    "python-docx",
    "pypdf",
    "requests",
];

/// The CPython uv is asked for first.
pub const PINNED: &str = "3.12";

/// The one index packages come from.
pub const PYPI: &str = "https://pypi.org/simple";

/// The most images a run attaches to its result.
const MOST_IMAGES: usize = crate::images::MOST_IMAGES;
/// The most changed files a result names.
const MOST_NAMED: usize = 50;
/// The largest script, or workspace module, a run stages.
const LARGEST_SCRIPT: u64 = super::files::LARGEST_WRITE as u64;
/// The most staged calls kept waiting for their run (a call classed but never run).
const MOST_STAGED: usize = 1_000;
/// The most workspace modules staged with one script.
const MOST_MODULES: usize = 500;

/// Spade's own variables a build passes on to uv: how this machine reaches the network.
const PASSED_ON: &[&str] = &[
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "ALL_PROXY",
    "all_proxy",
    "NO_PROXY",
    "no_proxy",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
];

/// Where packages come from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Index {
    /// This index URL and nothing else.
    Url(String),
    /// Wheels in this folder, and no index at all.
    Folder(PathBuf),
}

/// How Spade finds Python and builds the machine's environment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Setup {
    /// Folders looked in, in order, for `uv` and for `python3.x`.
    pub folders: Vec<PathBuf>,
    /// The CPython version uv is asked for first, as a uv-managed one (downloaded once for the
    /// machine); `None` to use only a Python already on the machine.
    pub pinned: Option<String>,
    /// The lock installed (`name==version` with hashes), exactly.
    pub lock: String,
    /// The packages the lock is for, each checked to be installed.
    pub wanted: Vec<String>,
    pub index: Index,
    /// Variables passed on to the build (a proxy, a certificate store).
    pub env: Vec<(String, String)>,
}

impl Setup {
    /// As Spade runs: the system folders commands find programs in (the clean `PATH`), the
    /// pinned version, the lock Spade ships, from PyPI.
    pub fn system() -> Self {
        Self {
            folders: SYSTEM_FOLDERS.iter().map(PathBuf::from).collect(),
            pinned: Some(PINNED.to_owned()),
            lock: LOCK.to_owned(),
            wanted: PACKAGES.iter().map(|&p| p.to_owned()).collect(),
            index: Index::Url(PYPI.to_owned()),
            env: PASSED_ON
                .iter()
                .filter_map(|name| std::env::var(name).ok().map(|v| ((*name).to_owned(), v)))
                .collect(),
        }
    }

    /// The environment this set-up builds, with uv (`uv`, as sampled once for this build) or
    /// without.
    fn environment(&self, uv: bool) -> String {
        let index = match &self.index {
            Index::Url(url) => url.clone(),
            Index::Folder(folder) => folder.to_string_lossy().into_owned(),
        };
        let pinned = self.pinned.clone().unwrap_or_default();
        let digest = trust_hash(format!("{}\n{index}\n{pinned}", self.lock).as_bytes());
        environment::name(&digest, uv)
    }
}

fn trust_hash(bytes: &[u8]) -> String {
    super::trust::hash(bytes)
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
}

impl PythonTool {
    pub(super) fn new(commands: ShellTool, setup: Setup) -> Self {
        Self {
            commands,
            setup: Arc::new(setup),
            staged: Arc::default(),
        }
    }

    /// Whether the bot's sandbox holds its commands, the only place this tool runs.
    fn held(&self, workspace: &Path) -> bool {
        self.commands.shell.contains(workspace) && !self.commands.shell.outside(workspace)
    }

    /// The calling bot's staging folder.
    fn staging(&self, key: &str) -> Option<Staging> {
        let bot = self.commands.place.bots.agent_for_key(key)?;
        let root = self.commands.place.all.python_runtime(&bot).ok()?;
        Some(Staging { root })
    }

    /// The machine's Python.
    fn machine(&self) -> Machine {
        Machine {
            root: shared_of(self.commands.place.all.root()),
        }
    }

    /// Where no program Spade runs on the host to build Python may come from: every bot's
    /// workspace (all of them, under the workspaces' root, but Spade's shared Python) and every
    /// folder any bot may write. An error when those can't be read.
    fn places(&self) -> Result<vetting::Places, String> {
        let root = self.commands.place.all.root().to_path_buf();
        let mut forbidden = vec![root.clone()];
        if let Some(security) = self
            .commands
            .place
            .bots
            .get()
            .and_then(|e| e.security().cloned())
        {
            forbidden.extend(security.writable_folders()?);
        }
        #[cfg(unix)]
        let owner = {
            use std::os::unix::fs::MetadataExt;
            std::fs::metadata(&root).map_err(|e| e.to_string())?.uid()
        };
        #[cfg(not(unix))]
        let owner = 0;
        Ok(vetting::Places {
            forbidden,
            allowed: vec![shared_of(&root)],
            owner,
        })
    }

    /// The call's staged script: the one already staged for it, or staged now. Every later
    /// look at the call (the person's answer, the run) uses this first one.
    ///
    /// Answers it with its preview: the staged script's own bytes, read back from the copy, so
    /// what a reviewer or the person is shown and what the scope binds are one snapshot.
    fn staged_for(&self, key: &str, arguments: &Value) -> Option<(Staged, String)> {
        let staging = self.staging(key)?;
        let staged = match self.existing(key) {
            Some(staged) => staged,
            None => {
                let workspace = self.commands.place.workspace(key).ok()?;
                let script = parse::<PythonArgs>(arguments.clone()).ok()?.script().ok()?;
                let (staged, _) = stage(&workspace, &staging, &script).ok()?;
                let mut all = self.staged.lock().unwrap_or_else(|p| p.into_inner());
                if all.len() >= MOST_STAGED && !all.contains_key(key) {
                    all.clear();
                }
                all.entry(key.to_owned()).or_insert(staged).clone()
            }
        };
        let preview = staging.bytes(&staged.script)?;
        Some((staged, String::from_utf8_lossy(&preview).into_owned()))
    }

    /// The call's staged script, if one was staged and is still held.
    fn existing(&self, key: &str) -> Option<Staged> {
        self.staged
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(key)
            .cloned()
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
fn modules(workspace: &Workspace, staging: &Staging, folder: &str) -> Result<Vec<u8>, PathError> {
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
                let staged = staging
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
    staging: &Staging,
    script: &Script,
) -> Result<(Staged, Option<spade_core::autonomy::shell::Shown>), PathError> {
    let dir = workspace.path()?;
    let (bytes, path) = script_bytes(workspace, script)?;
    let origin = Origin::of(&dir, path.as_deref());
    let staged_script = staging
        .stage(&bytes, "py")
        .map_err(|e| PathError::Io(format!("the script could not be staged: {e}")))?;
    let listed = modules(workspace, staging, &origin.folder)?;
    let staged_modules = staging
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

/// Why a call the person allowed doesn't run on other bytes.
const NOT_ALLOWED: &str = "Not run: the script (or a module it imports) isn't the one the person \
                           allowed; it changed since they were asked. Call python again to be \
                           asked about it as it is now.";

/// How a scope names the staged bytes it was allowed for.
const STAGED: &str = "\n[staged ";

impl Tool for PythonTool {
    fn def(&self) -> ToolDef {
        shown_def(
            PYTHON,
            "Runs Python 3 in your workspace folder: code, or the script at path with args (it \
             runs as read when you call; modules beside it import if you wrote them with \
             workspace_write). It has pandas, numpy, matplotlib (saves to files; no windows), \
             openpyxl, python-docx, pypdf and requests, and nothing else can be installed. \
             Answers the exit code, the output and the files it made or changed; images it saved \
             are shown. Same sandbox, timeout_s and 30-second background rule as shell.",
            json!({ "type": "object",
                    "properties": { "code": { "type": "string" },
                                    "path": { "type": "string" },
                                    "args": { "type": "array", "items": { "type": "string" } },
                                    "timeout_s": { "type": "integer", "minimum": 1 } } }),
            Risk::Write,
            // Like a command, anything it reads or makes is untrusted.
            true,
        )
    }

    /// In the bot's sandbox, as `shell` is: the OS holds it and nothing classifies it. The script
    /// and its trusted modules are staged now, so what a reviewer is shown (a workspace script's
    /// whole text) is what runs. Where the sandbox doesn't hold the bot's commands, the call is
    /// refused before anything runs.
    fn classed(&self, key: &str, arguments: &Value) -> spade_core::autonomy::Classed {
        use spade_core::autonomy::Classed;
        let Ok(workspace) = self.commands.place.workspace(key) else {
            return Classed::default();
        };
        if !workspace.path().ok().is_some_and(|path| self.held(&path)) {
            return Classed::default();
        }
        // Unstaged, the run refuses: nothing is read from the workspace after this.
        let Some((_, shown)) = self.staged_for(key, arguments) else {
            return Classed::sandboxed();
        };
        let path = arguments.get("path").and_then(Value::as_str);
        Classed {
            shown: match path {
                Some(path) => vec![spade_core::autonomy::shell::Shown {
                    path: path.to_owned(),
                    content: shown,
                }],
                None => Vec::new(),
            },
            ..Classed::sandboxed()
        }
    }

    /// "Always" covers this exact run: the same code, or the same script with the same args.
    fn always_scope(&self, arguments: &Value) -> Option<String> {
        let field = |name: &str| arguments.get(name).cloned().unwrap_or(Value::Null);
        Some(json!([field("code"), field("path"), field("args")]).to_string())
    }

    /// The scope the person is asked about names the staged bytes, so their answer holds for
    /// those bytes only.
    fn always_scope_in(&self, key: &str, arguments: &Value) -> Option<String> {
        let scope = self.always_scope(arguments)?;
        // Where it can't run, nothing is staged for it.
        let held = self
            .commands
            .place
            .workspace(key)
            .ok()
            .and_then(|workspace| workspace.path().ok())
            .is_some_and(|path| self.held(&path));
        // Only the snapshot the call was classed (and previewed) with: never staged again here.
        // With none held, the scope names nothing and the run refuses.
        let binding = held
            .then(|| self.existing(key))
            .flatten()
            .map(|staged| staged.binding())
            .unwrap_or_default();
        Some(format!("{scope}{STAGED}{binding}]"))
    }

    fn run(&self, key: &str, arguments: Value) -> ToolFuture {
        let args: PythonArgs = match parse(arguments) {
            Ok(args) => args,
            Err(output) => return Box::pin(async move { output }),
        };
        if let Err(why) = args.script() {
            return Box::pin(async move { ToolOutput::error(why) });
        }
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
        let (Some(staged), Some(staging)) = (staged, self.staging(key)) else {
            return Box::pin(async { ToolOutput::error(NOT_STAGED) });
        };
        // A call the person allowed runs only on the bytes they were asked about.
        let allowed = self
            .commands
            .place
            .bots
            .get()
            .and_then(|engine| engine.allowed_scope(key));
        if !bound_to(allowed.as_deref(), &staged) {
            return Box::pin(async { ToolOutput::error(NOT_ALLOWED) });
        }
        let machine = self.machine();
        let places = match self.places() {
            Ok(places) => places,
            Err(why) => {
                return Box::pin(async move {
                    ToolOutput::error(format!(
                        "Spade couldn't check where its Python comes from: {why}"
                    ))
                });
            }
        };
        let (place, shell) = (self.commands.place.clone(), self.commands.shell.clone());
        let setup = self.setup.clone();
        let name = output_name(key);
        let key = key.to_owned();
        Box::pin(async move {
            let intact = {
                let (staging, staged) = (staging.clone(), staged.clone());
                tokio::task::spawn_blocking(move || {
                    staging.intact(&staged.script) && staging.intact(&staged.modules)
                })
                .await
                .unwrap_or(false)
            };
            if !intact {
                return ToolOutput::error(NOT_STAGED);
            }
            // The launch the gate cleared, taken once.
            let (plan, by) = match cleared(&place, &shell, &key, &dir) {
                Ok(cleared) => cleared,
                Err(refused) => return refused,
            };
            if !plan.sandboxed {
                return ToolOutput::error(NOT_HELD);
            }
            let (environment, lease, notes) = match ensure(&machine, &setup, &places).await {
                Ok(ready) => ready,
                Err(failed) => return ToolOutput::error(failed),
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
            let command = command(
                &machine.control(),
                &machine.environment(&environment),
                &dir,
                &staged,
                &args.args,
            );
            let run = Run {
                command: &command,
                timeout,
                output_name: &name,
                // The environment is held until the script and everything it started have ended,
                // in the bot's terminal past this call too if the call is stopped first.
                hold: Some(Box::new(lease)),
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

/// Whether a call may run `staged`: one the person allowed (`allowed`, the scope they were
/// asked with) only when it names exactly those staged bytes; one no person was asked about runs
/// what was staged when it was classed.
fn bound_to(allowed: Option<&str>, staged: &Staged) -> bool {
    match allowed {
        None => true,
        Some(scope) => scope
            .rsplit_once(STAGED)
            .is_some_and(|(_, binding)| binding.trim_end_matches(']') == staged.binding()),
    }
}

/// The machine's current environment, built first when there is none for this set-up (Spade's
/// lock changed, or uv came or went), and the call's hold on it. Answers its name, the lease and
/// what a build said; or why there is none (the call's script then doesn't run).
async fn ensure(
    machine: &Machine,
    setup: &Setup,
    places: &vetting::Places,
) -> Result<(String, machine::Lease, String), String> {
    let guard = {
        let machine = machine.clone();
        tokio::task::spawn_blocking(move || {
            machine.write_control()?;
            machine.exclusive()
        })
        .await
        .map_err(|_| "the file work stopped".to_owned())?
        .map_err(|e| format!("Spade couldn't prepare its Python: {e}"))?
    };
    // The programs this build may run, sampled once: the environment is named from this sample.
    let tools = {
        let (machine, setup, places) = (machine.clone(), setup.clone(), places.clone());
        tokio::task::spawn_blocking(move || machine.tools(&setup, &places))
            .await
            .map_err(|_| "the file work stopped".to_owned())?
    };
    let wanted = setup.environment(tools.uv.is_some());
    let current = machine.current().map(|c| c.environment);
    let mut said = String::new();
    if current.as_deref() != Some(wanted.as_str()) || !machine.usable(&wanted) {
        if !machine.usable(&wanted) {
            said = machine.build(setup, &wanted, &tools).await.map_err(|why| {
                format!("Python could not be set up: {why}\n[The script was not run.]")
            })?;
        }
        // Only once the environment is whole is it recorded; the old one stays until then.
        machine.publish(&wanted).map_err(|e| {
            format!("Spade couldn't record its Python: {e}\n[The script was not run.]")
        })?;
        machine.sweep(&wanted);
    }
    let lease = machine
        .lease(&wanted)
        .map_err(|e| format!("Spade couldn't hold its Python: {e}"))?;
    drop(guard);
    Ok((wanted, lease, said))
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
    fn an_environment_is_named_from_the_one_sample_of_uv_its_build_uses() {
        let setup = Setup {
            folders: vec![PathBuf::from("/opt/homebrew/bin")],
            pinned: None,
            lock: "a==1\n".to_owned(),
            wanted: vec!["a".to_owned()],
            index: Index::Url(PYPI.to_owned()),
            env: Vec::new(),
        };
        // Whatever is on disk now: a build that found no usable uv is the standard library.
        assert_eq!(setup.environment(false), "standard-library");
        assert!(setup.environment(true).starts_with("locked-"));
    }

    #[test]
    fn an_allowed_call_runs_only_the_bytes_it_was_allowed_with() {
        let staged = |script: &str| Staged {
            script: PathBuf::from(format!("/s/scripts/{script}.py")),
            modules: PathBuf::from("/s/scripts/m1.json"),
            name: "<code>".to_owned(),
        };
        let asked = format!("[\"print(1)\",null,[]]{STAGED}{}]", staged("a1").binding());
        assert!(bound_to(Some(&asked), &staged("a1")));
        // Restaged from a changed file after a restart: not what the person allowed.
        assert!(!bound_to(Some(&asked), &staged("b2")));
        // A scope from an older build, naming no staged bytes, allows none.
        assert!(!bound_to(Some("[\"print(1)\",null,[]]"), &staged("a1")));
        assert!(bound_to(None, &staged("a1")));
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
