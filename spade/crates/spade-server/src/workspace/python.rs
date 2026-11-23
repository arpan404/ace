//! The `python` tool: runs Python code, or a script in the workspace, in the bot's sandbox
//! through the same runner as `shell` (the gate's launch, the terminal, the background window and
//! the output rules all come from there).
//!
//! The Python a bot runs is Spade's, not the workspace's (ADR 0220). Each bot has a runtime
//! folder, `<workspaces>/.python/<bot>/`, outside its workspace: the bot's runs may read and run
//! from it but never write it. Only Spade's set-up run, a separate sandboxed run of Spade's own
//! script, writes it: the environment (`venv`), made the first time the tool runs (never at
//! start) with `uv` when it is there (a pinned uv-managed CPython first, else a Python 3.10 or
//! newer on the machine), else `python3 -I -m venv`, then a locked set of packages from one
//! explicit index, with every installer's configuration discovery off. Each run's script is a
//! copy staged by its content's hash when the gate classes the call, so the bytes a reviewer is
//! shown are the bytes that run, and nothing in the workspace can change them in between.
//!
//! The scripts and the command are built here by pure functions; the tool is the thin shell
//! around them.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};
use spade_core::tools::{Risk, ToolDef};

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
/// The longest the set-up of a bot's Python may take (a CPython download and the packages).
const SETUP_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// The largest script a run stages.
const LARGEST_SCRIPT: u64 = super::files::LARGEST_WRITE as u64;
/// The most staged calls kept waiting for their run (a call classed but never run).
const MOST_STAGED: usize = 1_000;

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
    /// Installed as named (`name==version`), binary wheels only.
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

/// `text` as one POSIX shell word.
fn quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', r"'\''"))
}

/// The launcher each run goes through, `<runtime>/run.sh`, run as `/bin/sh run.sh <workspace>
/// <script> <args>…`: it moves to the workspace and runs the staged script with the bot's
/// environment's Python, isolated (`-I`: no `PYTHON*` variables, no user site, no script or
/// working folder on `sys.path`) and unbuffered.
pub const LAUNCHER: &str = r#"# Spade's launcher for the python tool (ADR 0220). Spade writes it; the bot's runs can't change it.
runtime=$(cd "$(dirname "$0")" && pwd -P) || exit 1
cd -- "$1" || exit 1
shift
tmp=${TMPDIR:-$PWD/.spade/tmp}
export MPLBACKEND=Agg MPLCONFIGDIR="$tmp/matplotlib"
exec "$runtime/venv/bin/python" -I -u "$@"
"#;

/// Spade's set-up of the bot's environment, `<runtime>/setup.sh`, run as `/bin/sh setup.sh
/// <digest>` in a run that may write only the runtime folder. It makes `venv` when there is none,
/// installs the packages, and writes `ready` holding `digest` once they are in.
pub fn setup_script(setup: &Setup) -> String {
    let words = |paths: Vec<String>| paths.iter().map(|p| quote(p)).collect::<Vec<_>>().join(" ");
    let in_folders = |name: &str| {
        setup
            .folders
            .iter()
            .map(|folder| folder.join(name).to_string_lossy().into_owned())
            .collect::<Vec<_>>()
    };
    let uvs = words(in_folders("uv"));
    let pythons = words(NAMES.iter().flat_map(|name| in_folders(name)).collect());
    let looked = setup
        .folders
        .iter()
        .map(|f| f.to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join(", ");
    let pinned = setup.pinned.as_deref().map_or(String::new(), |version| {
        format!(
            "    \"$uv\" venv --no-config --quiet --seed --managed-python --python {} venv \
             >/dev/null 2>&1 && made=uv\n",
            quote(version)
        )
    });
    let index = match &setup.index {
        Index::Url(url) => format!("--index-url {}", quote(url)),
        Index::Folder(folder) => format!("--no-index --find-links \"$PWD\"/{}", quote(folder)),
    };
    let packages = setup
        .packages
        .iter()
        .map(|p| quote(p))
        .collect::<Vec<_>>()
        .join(" ");
    let install = if setup.packages.is_empty() {
        "printf '%s' \"$1\" > ready\n".to_owned()
    } else {
        let names: Vec<&str> = setup
            .packages
            .iter()
            .map(|p| p.split("==").next().unwrap_or(p))
            .collect();
        format!(
            r#"echo "[Installing Python's packages for this bot: {list}.]" >&2
if [ -n "$uv" ]; then
  "$uv" pip install --no-config --quiet --python venv/bin/python --only-binary :all: {index} {packages}
else
  venv/bin/python -I -m pip install --isolated --quiet --only-binary :all: {index} {packages}
fi
if [ $? -eq 0 ]; then
  printf '%s' "$1" > ready
else
  echo "[The packages could not all be installed (see above), so the script runs with what is there. Installing reaches the network, which the person's Network permission decides; the next run tries again.]" >&2
fi
"#,
            list = names.join(", "),
        )
    };
    format!(
        r#"# Spade's set-up of this bot's Python (ADR 0220). Spade writes it; only this run may write here.
cd "$(dirname "$0")" || exit 1
unset PYTHONPATH PYTHONHOME PYTHONSTARTUP PYTHONUSERBASE VIRTUAL_ENV
export PYTHONNOUSERSITE=1 UV_NO_CONFIG=1 UV_CACHE_DIR="$PWD/uv-cache" \
  UV_PYTHON_INSTALL_DIR="$PWD/pythons" PIP_CONFIG_FILE=/dev/null PIP_CACHE_DIR="$PWD/pip-cache" \
  PIP_DISABLE_PIP_VERSION_CHECK=1 PIP_NO_INPUT=1
uv=''
for found in {uvs}; do
  if [ -x "$found" ]; then uv=$found; break; fi
done
if [ ! -x venv/bin/python ]; then
  rm -rf venv ready
  made=''
  if [ -n "$uv" ]; then
{pinned}    [ -n "$made" ] || {{ "$uv" venv --no-config --quiet --seed --no-python-downloads --python '>=3.10' venv >/dev/null 2>&1 && made=uv; }}
  fi
  if [ -z "$made" ]; then
    for found in {pythons}; do
      if [ -x "$found" ] && "$found" -I -c 'import sys; sys.exit(sys.version_info < (3, 10))' 2>/dev/null; then
        "$found" -I -m venv venv && made=venv && break
      fi
    done
  fi
  if [ -z "$made" ]; then
    echo "No Python 3.10 or newer was found on this machine (looked for uv and python3 in {looked}). The person can install one, for example with Homebrew: brew install python." >&2
    exit 127
  fi
  echo "[Set up Python for this bot: $(venv/bin/python -I -c 'import platform; print(platform.python_version())').]" >&2
fi
{install}"#
    )
}

/// The digest naming a set-up or a staged script.
fn digest(text: &[u8]) -> String {
    super::trust::hash(text)
}

/// The command that runs the staged `script` with `args` through the launcher in `runtime`, in
/// the workspace at `workspace`. Every word is absolute or quoted, so no name reads as an option.
pub fn command(runtime: &Path, workspace: &Path, script: &Path, args: &[String]) -> String {
    let mut words = vec![
        "/bin/sh".to_owned(),
        quote(&runtime.join("run.sh").to_string_lossy()),
        quote(&workspace.to_string_lossy()),
        quote(&script.to_string_lossy()),
    ];
    words.extend(args.iter().map(|arg| quote(arg)));
    words.join(" ")
}

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

/// A bot's runtime folder, as Spade writes it (on the host, outside the sandbox).
#[derive(Debug, Clone)]
struct Runtime {
    dir: PathBuf,
}

impl Runtime {
    /// Writes `name` with `content` when it holds anything else, through a new file renamed
    /// over it.
    fn put(&self, name: &str, content: &[u8]) -> std::io::Result<()> {
        let path = self.dir.join(name);
        if std::fs::read(&path).is_ok_and(|now| now == content) {
            return Ok(());
        }
        let parent = path.parent().unwrap_or(&self.dir);
        std::fs::create_dir_all(parent)?;
        let mut file = tempfile::NamedTempFile::new_in(parent)?;
        std::io::Write::write_all(&mut file, content)?;
        file.persist(&path).map_err(|error| error.error)?;
        Ok(())
    }

    /// Stages a script's bytes as `scripts/<hash>.py`, the same bytes whenever it is named.
    fn stage(&self, bytes: &[u8]) -> std::io::Result<PathBuf> {
        let name = format!("scripts/{}.py", digest(bytes));
        self.put(&name, bytes)?;
        Ok(self.dir.join(name))
    }

    /// Whether the environment is set up as `digest` says.
    fn ready(&self, digest: &str) -> bool {
        std::fs::read_to_string(self.dir.join("ready")).is_ok_and(|ready| ready == digest)
            && std::fs::symlink_metadata(self.dir.join("venv/bin/python")).is_ok()
    }
}

pub struct PythonTool {
    commands: ShellTool,
    setup: Arc<Setup>,
    /// Each call's staged script as the gate classed it, by call key.
    staged: Arc<Mutex<HashMap<String, PathBuf>>>,
    /// Held while a bot's environment is checked and set up, so two runs never set it up at once.
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
        let dir = self.commands.place.all.python_runtime(&bot).ok()?;
        Some(Runtime { dir })
    }

    /// The lock a bot's set-up is made under.
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

/// Why the tool doesn't run here.
const NOT_HELD: &str = "Not run: the python tool runs only inside Spade's sandbox, which isn't \
                        holding your commands here. Run python3 with shell instead.";

impl Tool for PythonTool {
    fn def(&self) -> ToolDef {
        shown_def(
            PYTHON,
            "Runs Python 3 in your workspace folder: code, or the script at path with args (it \
             runs as read when you call, on its own: modules beside it in the workspace aren't \
             imported). Your own environment has pandas, numpy, matplotlib (saves to files; no \
             windows), openpyxl, python-docx, pypdf and requests. Answers the exit code, the \
             output and the files it made or changed; images it saved are shown. Same sandbox, \
             timeout_s and 30-second background rule as shell.",
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
    /// is staged now, so what a reviewer is shown (a workspace script's whole text) is what runs.
    /// Where the sandbox doesn't hold the bot's commands, the call is refused before anything
    /// runs.
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
        let Ok((bytes, path)) = script_bytes(&workspace, &script) else {
            return Classed::sandboxed();
        };
        if let Ok(staged) = runtime.stage(&bytes) {
            let mut all = self.staged.lock().unwrap_or_else(|p| p.into_inner());
            if all.len() >= MOST_STAGED {
                all.clear();
            }
            all.entry(key.to_owned()).or_insert(staged);
        }
        Classed {
            shown: path
                .map(|path| spade_core::autonomy::shell::Shown {
                    path,
                    content: String::from_utf8_lossy(&bytes).into_owned(),
                })
                .into_iter()
                .collect(),
            ..Classed::sandboxed()
        }
    }

    /// "Always" covers this exact run: the same code, or the same script with the same args.
    fn always_scope(&self, arguments: &Value) -> Option<String> {
        let field = |name: &str| arguments.get(name).cloned().unwrap_or(Value::Null);
        Some(json!([field("code"), field("path"), field("args")]).to_string())
    }

    fn run(&self, key: &str, arguments: Value) -> ToolFuture {
        let args: PythonArgs = match parse(arguments) {
            Ok(args) => args,
            Err(output) => return Box::pin(async move { output }),
        };
        let script = match args.script() {
            Ok(script) => script,
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
        let Some(runtime) = self.runtime(key) else {
            return Box::pin(async {
                ToolOutput::error("This conversation has no bot, so no Python.")
            });
        };
        let lock = self.setup_lock(key);
        let (place, shell) = (self.commands.place.clone(), self.commands.shell.clone());
        let setup = self.setup.clone();
        let name = output_name(key);
        let key = key.to_owned();
        Box::pin(async move {
            // The script as the gate classed it; staged now only when no gate classed it.
            let script = match staged {
                Some(staged) => Ok(staged),
                None => {
                    let (workspace, runtime) = (workspace.clone(), runtime.clone());
                    tokio::task::spawn_blocking(move || {
                        let (bytes, _) = script_bytes(&workspace, &script)?;
                        runtime.stage(&bytes).map_err(|error| {
                            PathError::Io(format!("the script could not be staged: {error}"))
                        })
                    })
                    .await
                    .unwrap_or_else(|_| Err(PathError::Io("the file work stopped".to_owned())))
                }
            };
            let script = match script {
                Ok(script) => script,
                Err(error) => return ToolOutput::error(error.to_string()),
            };
            // The launch the gate cleared, taken once for the set-up and the run.
            let (plan, by) = match cleared(&place, &shell, &key, &dir) {
                Ok(cleared) => cleared,
                Err(refused) => return refused,
            };
            if !plan.sandboxed {
                return ToolOutput::error(NOT_HELD);
            }
            let notes = {
                let _one = lock.lock().await;
                match set_up(&shell, &dir, &runtime, &setup).await {
                    Ok(notes) => notes,
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
            let command = command(&runtime.dir, &dir, &script, &args.args);
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

/// Sets up the bot's environment when it isn't set up as `setup` says: Spade's script, in a
/// contained run of its own that may also write the runtime folder. Answers what the set-up said,
/// for the result, or the result when it failed.
async fn set_up(
    shell: &Commands,
    dir: &Path,
    runtime: &Runtime,
    setup: &Setup,
) -> Result<String, ToolOutput> {
    let script = setup_script(setup);
    let wanted = digest(script.as_bytes());
    let files = {
        let (runtime, script, wanted) = (runtime.clone(), script.clone(), wanted.clone());
        tokio::task::spawn_blocking(move || {
            runtime.put("run.sh", LAUNCHER.as_bytes())?;
            runtime.put("setup.sh", script.as_bytes())?;
            Ok::<_, std::io::Error>(runtime.ready(&wanted))
        })
        .await
    };
    match files {
        Ok(Ok(true)) => return Ok(String::new()),
        Ok(Ok(false)) => {}
        Ok(Err(error)) => {
            return Err(ToolOutput::error(format!(
                "Spade couldn't write the bot's Python launcher: {error}"
            )));
        }
        Err(_) => return Err(ToolOutput::error("the file work stopped")),
    }
    let command = format!(
        "/bin/sh {} {}",
        quote(&runtime.dir.join("setup.sh").to_string_lossy()),
        quote(&wanted)
    );
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
                runtime: runtime.dir.clone(),
            },
            outside: false,
            // Only ever contained: it is the one run that writes Spade's runtime folder.
            may_run_uncontained: false,
            contained_only: true,
            by: By::Spade,
            clean: false,
            read_only: false,
        })
        .await
        .map_err(|why| ToolOutput::error(format!("Python could not be set up: {why}")))?;
    let said = [ran.stdout.trim(), ran.stderr.trim()]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    if ran.timed_out || ran.code != Some(0) {
        let how = match ran.code {
            Some(code) if !ran.timed_out => format!("Exit code {code}."),
            _ => "Python's set-up did not finish.".to_owned(),
        };
        return Err(ToolOutput::error(format!("{how}\n{said}")));
    }
    Ok(said)
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

    #[test]
    fn a_command_is_absolute_and_quoted_so_no_name_runs_or_reads_as_an_option() {
        let command = command(
            Path::new("/data/workspace/.python/b1"),
            Path::new("/data/workspace/b1"),
            Path::new("/data/workspace/.python/b1/scripts/ab.py"),
            &["-c".to_owned(), "$(rm -rf ~)".to_owned(), "it's".to_owned()],
        );
        assert_eq!(
            command,
            "/bin/sh '/data/workspace/.python/b1/run.sh' '/data/workspace/b1' \
             '/data/workspace/.python/b1/scripts/ab.py' '-c' '$(rm -rf ~)' 'it'\\''s'"
        );
    }

    #[test]
    fn the_set_up_looks_where_it_is_told_and_installs_from_one_index_with_no_configuration() {
        let setup = Setup {
            folders: vec![PathBuf::from("/opt/homebrew/bin")],
            pinned: Some("3.12".to_owned()),
            packages: vec!["pandas==3.1.1".to_owned()],
            index: Index::Url(PYPI.to_owned()),
        };
        let script = setup_script(&setup);
        assert!(script.contains("for found in '/opt/homebrew/bin/uv'; do"));
        assert!(script.contains("'/opt/homebrew/bin/python3.13'"));
        assert!(script.contains("--managed-python --python '3.12'"));
        assert!(script.contains("UV_NO_CONFIG=1") && script.contains("PIP_CONFIG_FILE=/dev/null"));
        assert!(script.contains(
            "pip install --no-config --quiet --python venv/bin/python --only-binary :all: \
             --index-url 'https://pypi.org/simple' 'pandas==3.1.1'"
        ));
        assert!(script.contains("-I -m pip install --isolated"));
        assert!(script.contains("\"$found\" -I -m venv venv"));
        assert!(script.contains("[Installing Python's packages for this bot: pandas.]"));

        let local = setup_script(&Setup {
            pinned: None,
            packages: vec!["spadecheck==1.0".to_owned()],
            index: Index::Folder("wheels".to_owned()),
            ..setup
        });
        assert!(!local.contains("--managed-python"));
        assert!(local.contains("--no-index --find-links \"$PWD\"/'wheels' 'spadecheck==1.0'"));
    }

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
