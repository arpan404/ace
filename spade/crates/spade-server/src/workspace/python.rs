//! The `python` tool: runs Python code, or a script in the workspace, in the bot's sandbox
//! through the same runner as `shell` (the gate's launch, the terminal, the background window and
//! the output rules all come from there).
//!
//! Each bot has its own environment in `.spade/python/venv`, made by Spade's launcher the first
//! time the tool runs, never at start: with `uv` when it is there (a pinned uv-managed CPython
//! first, else a Python 3.10 or newer on the machine), else `python3 -m venv`, then the default
//! packages. The launcher is a short shell script Spade writes before every run; installing
//! reaches the network through the sandbox's proxy like any command.
//!
//! The launcher and the command are built here by pure functions; the tool is the thin shell
//! around them.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};
use spade_core::tools::{Risk, ToolDef};

use super::shell_tool::{Run, ShellTool, run_command};
use super::tools::{output_name, shown_def};
use super::{PathError, Snapshot, Workspace, changes};
use crate::tools::{Tool, ToolFuture, ToolOutput, parse};

/// The tool's name.
pub const PYTHON: &str = "python";

/// Packages a bot's environment starts with.
pub const DEFAULT_PACKAGES: &[&str] = &[
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

/// Where the launcher, the environment and the scripts written from `code` are, in the workspace.
const HOME: &str = super::files::PYTHON_HOME;

/// The most images a run attaches to its result.
const MOST_IMAGES: usize = crate::images::MOST_IMAGES;
/// The most changed files a result names.
const MOST_NAMED: usize = 50;

/// How the tool finds Python and what a new environment starts with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Setup {
    /// Folders looked in, in order, for `uv` and for `python3.x`.
    pub folders: Vec<PathBuf>,
    /// The CPython version uv is asked for first, as a uv-managed one (downloaded once for the
    /// bot); `None` to use only a Python already on the machine.
    pub pinned: Option<String>,
    /// Installed when the environment is made.
    pub packages: Vec<String>,
}

impl Setup {
    /// As Spade runs: the system folders commands find programs in (the clean `PATH`), the
    /// pinned version, the default packages.
    pub fn system() -> Self {
        Self {
            folders: SYSTEM_FOLDERS.iter().map(PathBuf::from).collect(),
            pinned: Some(PINNED.to_owned()),
            packages: DEFAULT_PACKAGES.iter().map(|&p| p.to_owned()).collect(),
        }
    }
}

/// The folders a command's clean `PATH` holds (`shell.rs`), where uv and Python are looked for.
const SYSTEM_FOLDERS: &[&str] = &[
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/usr/bin",
    "/bin",
];

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

/// The launcher Spade writes to `.spade/python/run.sh` before each run. Run as
/// `/bin/sh <workspace>/.spade/python/run.sh <script> <args>…`: it moves to the workspace, finds
/// a Python and makes the bot's environment if it has none, installs the packages until they
/// are in, and runs the script with the environment's Python.
pub fn launcher(setup: &Setup) -> String {
    let words = |paths: Vec<String>| {
        paths
            .iter()
            .map(|p| quote(p))
            .collect::<Vec<_>>()
            .join(" ")
    };
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
            "    \"$uv\" venv --quiet --seed --managed-python --python {} \"$venv\" >/dev/null 2>&1 && made=uv\n",
            quote(version)
        )
    });
    let packages = setup
        .packages
        .iter()
        .map(|p| quote(p))
        .collect::<Vec<_>>()
        .join(" ");
    let install = if setup.packages.is_empty() {
        "  : > \"$home/ready\"\n".to_owned()
    } else {
        format!(
            r#"  echo "[Installing Python's default packages for this bot: {list}.]" >&2
  if [ -n "$uv" ]; then
    "$uv" pip install --quiet --python "$venv/bin/python" {packages}
  else
    "$venv/bin/python" -m pip install --quiet {packages}
  fi
  if [ $? -eq 0 ]; then
    : > "$home/ready"
  else
    echo "[The default packages could not all be installed (see above), so the script runs with what is there. Installing reaches the network, which the person's Network permission decides; the next run tries again.]" >&2
  fi
"#,
            list = setup.packages.join(", "),
        )
    };
    format!(
        r#"# Spade's Python launcher for the python tool. Spade writes it again before every run.
cd "$(dirname "$0")/../.." || exit 1
home={home}
venv="$home/venv"
export MPLBACKEND=Agg MPLCONFIGDIR="$PWD/$home/matplotlib" UV_CACHE_DIR="$PWD/$home/uv-cache" \
  UV_PYTHON_INSTALL_DIR="$PWD/$home/pythons" PIP_CACHE_DIR="$PWD/$home/pip-cache" \
  PIP_DISABLE_PIP_VERSION_CHECK=1 PYTHONUNBUFFERED=1 VIRTUAL_ENV="$PWD/$venv"
uv=''
for found in {uvs}; do
  if [ -x "$found" ]; then uv=$found; break; fi
done
if [ ! -x "$venv/bin/python" ]; then
  rm -rf "$venv" "$home/ready"
  made=''
  if [ -n "$uv" ]; then
{pinned}    [ -n "$made" ] || {{ "$uv" venv --quiet --seed --no-python-downloads --python '>=3.10' "$venv" >/dev/null 2>&1 && made=uv; }}
  fi
  if [ -z "$made" ]; then
    for found in {pythons}; do
      if [ -x "$found" ] && "$found" -c 'import sys; sys.exit(sys.version_info < (3, 10))' 2>/dev/null; then
        "$found" -m venv "$venv" && made=venv && break
      fi
    done
  fi
  if [ -z "$made" ]; then
    echo "No Python 3.10 or newer was found on this machine (looked for uv and python3 in {looked}). The person can install one, for example with Homebrew: brew install python." >&2
    exit 127
  fi
  echo "[Set up Python for this bot: $("$venv/bin/python" -c 'import platform; print(platform.python_version())').]" >&2
fi
if [ ! -f "$home/ready" ]; then
{install}fi
exec "$venv/bin/python" "$@"
"#,
        home = quote(HOME),
    )
}

/// The command that runs `script` (relative to the workspace) with `args` through the launcher
/// in the workspace at `workspace`.
pub fn command(workspace: &Path, script: &str, args: &[String]) -> String {
    let launcher = workspace.join(HOME).join("run.sh");
    let mut words = vec![
        "/bin/sh".to_owned(),
        quote(&launcher.to_string_lossy()),
        quote(script),
    ];
    words.extend(args.iter().map(|arg| quote(arg)));
    words.join(" ")
}

/// What a run made or changed in the workspace, in words, from snapshots before and after it.
pub fn made(before: &Snapshot, after: &Snapshot) -> (String, Vec<String>) {
    let mut lines = Vec::new();
    let mut files = Vec::new();
    for (path, how) in changes(before, after) {
        let size = after.get(&path).and_then(|seen| seen.size);
        match (how, size) {
            // A folder made on the way to a file says nothing the file doesn't.
            ("new", None) => continue,
            ("removed", _) => lines.push(format!("{path} (removed)")),
            (how, Some(size)) => {
                lines.push(format!("{path} ({how}, {size} bytes)"));
                files.push(path);
            }
            _ => {}
        }
    }
    if lines.is_empty() {
        return (String::new(), files);
    }
    let count = lines.len();
    lines.truncate(MOST_NAMED);
    let mut text = format!("Files it made or changed:\n{}", lines.join("\n"));
    if count > MOST_NAMED {
        text.push_str(&format!("\n[and {} more]", count - MOST_NAMED));
    }
    (text, files)
}

pub struct PythonTool {
    commands: ShellTool,
    setup: Arc<Setup>,
}

impl PythonTool {
    pub(super) fn new(commands: ShellTool, setup: Setup) -> Self {
        Self {
            commands,
            setup: Arc::new(setup),
        }
    }

    /// Whether the bot's sandbox holds its commands, the only place this tool runs.
    fn held(&self, workspace: &Path) -> bool {
        self.commands.shell.contains(workspace) && !self.commands.shell.outside(workspace)
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

/// What the run is: code Spade writes to a script first, or a script already in the workspace.
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

/// Why the tool doesn't run here.
const NOT_HELD: &str = "Not run: the python tool runs only inside Spade's sandbox, which isn't \
                        holding your commands here. Run python3 with shell instead.";

impl Tool for PythonTool {
    fn def(&self) -> ToolDef {
        shown_def(
            PYTHON,
            "Runs Python 3 in your workspace folder: code, or the script at path with args. \
             Your own environment comes with pandas, numpy, matplotlib (saves to files; no \
             windows), openpyxl, python-docx, pypdf and requests; install more with shell: \
             .spade/python/venv/bin/python -m pip install NAME. Answers the exit code, the output and the files it made or changed; images \
             it saved are shown. Same sandbox, timeout_s and 30-second background rule as shell.",
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

    /// In the bot's sandbox, as `shell` is: the OS holds it and nothing classifies it. Where the
    /// sandbox doesn't hold the bot's commands, the call is refused before anything runs.
    fn classed(&self, key: &str, _arguments: &Value) -> spade_core::autonomy::Classed {
        let held = self
            .commands
            .place
            .workspace(key)
            .ok()
            .and_then(|workspace| workspace.path().ok())
            .is_some_and(|workspace| self.held(&workspace));
        if held {
            spade_core::autonomy::Classed::sandboxed()
        } else {
            spade_core::autonomy::Classed::default()
        }
    }

    /// "Always" covers this exact run: the same code, or the same script with the same args.
    fn always_scope(&self, arguments: &Value) -> Option<String> {
        let field = |name: &str| arguments.get(name).cloned().unwrap_or(Value::Null);
        Some(json!([field("code"), field("path"), field("args")]).to_string())
    }

    fn run(&self, key: &str, arguments: Value) -> ToolFuture {
        let workspace = self.commands.place.workspace(key);
        let (place, shell) = (self.commands.place.clone(), self.commands.shell.clone());
        let setup = self.setup.clone();
        let name = output_name(key);
        let held = |path: &Path| self.held(path);
        let args: PythonArgs = match parse(arguments) {
            Ok(args) => args,
            Err(output) => return Box::pin(async move { output }),
        };
        let script = match args.script() {
            Ok(script) => script,
            Err(why) => return Box::pin(async move { ToolOutput::error(why) }),
        };
        let workspace = match workspace {
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
        if !held(&dir) {
            return Box::pin(async { ToolOutput::error(NOT_HELD) });
        }
        let key = key.to_owned();
        Box::pin(async move {
            let ready = {
                let (workspace, name) = (workspace.clone(), name.clone());
                tokio::task::spawn_blocking(move || prepare(&workspace, &setup, script, &name))
                    .await
                    .unwrap_or_else(|_| Err(PathError::Io("the file work stopped".to_owned())))
            };
            let (script, before) = match ready {
                Ok(ready) => ready,
                Err(error) => return ToolOutput::error(error.to_string()),
            };
            let timeout = args
                .timeout_s
                .map_or(super::tools::SHELL_TIMEOUT, Duration::from_secs)
                .max(Duration::from_secs(1));
            let command = command(&dir, &script, &args.args);
            let run = Run {
                command: &command,
                timeout,
                output_name: &name,
            };
            let output = run_command(&place, &shell, &key, &workspace, run).await;
            let found = tokio::task::spawn_blocking(move || look_again(&workspace, &before))
                .await
                .unwrap_or_default();
            with_files(&place, output, found)
        })
    }
}

/// Writes the launcher (and, for code, the script) and takes the snapshot the run is compared
/// against. Answers the script's path, relative to the workspace.
fn prepare(
    workspace: &Workspace,
    setup: &Setup,
    script: Script,
    name: &str,
) -> Result<(String, Snapshot), PathError> {
    // Spade's own files: written as any file is, never recorded as trusted.
    workspace.write(&format!("{HOME}/run.sh"), &launcher(setup))?;
    let script = match script {
        Script::Code(code) => {
            let path = format!("{HOME}/scripts/{name}.py");
            workspace.write(&path, &code)?;
            path
        }
        Script::Path(path) => {
            let path = workspace.normal(&path)?;
            if !workspace.plain_file(&path) {
                return Err(PathError::Io(format!(
                    "{path} is not a script in your workspace"
                )));
            }
            path
        }
    };
    Ok((script, workspace.snapshot()?))
}

/// What a run left: the words naming the files it made or changed, and the images among them.
#[derive(Default)]
struct Found {
    text: String,
    images: Vec<Vec<u8>>,
}

fn look_again(workspace: &Workspace, before: &Snapshot) -> Found {
    let Ok(after) = workspace.snapshot() else {
        return Found::default();
    };
    let (text, files) = made(before, &after);
    let images = files
        .iter()
        .filter(|path| after.get(*path).and_then(|seen| seen.size).is_some_and(|size| {
            size <= super::reading::LARGEST_IMAGE
        }))
        .filter_map(|path| workspace.bytes_up_to(path, super::reading::LARGEST_IMAGE).ok())
        .filter(|bytes| crate::images::sniff(bytes).is_some())
        .take(MOST_IMAGES)
        .collect();
    Found { text, images }
}

/// The run's result with the files it made named, and its images given to the model and shown
/// to the person.
fn with_files(place: &super::tools::Place, output: ToolOutput, found: Found) -> ToolOutput {
    let mut output = output;
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
    use crate::workspace::Seen;

    #[test]
    fn a_command_quotes_every_word_so_nothing_in_a_name_runs() {
        let command = command(
            Path::new("/data/workspace/b1"),
            "it's here.py",
            &["--out".to_owned(), "$(rm -rf ~)".to_owned()],
        );
        assert_eq!(
            command,
            "/bin/sh '/data/workspace/b1/.spade/python/run.sh' 'it'\\''s here.py' '--out' \
             '$(rm -rf ~)'"
        );
    }

    #[test]
    fn the_launcher_looks_where_it_is_told_and_installs_only_what_it_is_given() {
        let setup = Setup {
            folders: vec![PathBuf::from("/opt/homebrew/bin")],
            pinned: Some("3.12".to_owned()),
            packages: vec!["pandas".to_owned()],
        };
        let script = launcher(&setup);
        assert!(script.contains("for found in '/opt/homebrew/bin/uv'; do"));
        assert!(script.contains("'/opt/homebrew/bin/python3.13'"));
        assert!(script.contains("--managed-python --python '3.12'"));
        assert!(script.contains("pip install --quiet --python \"$venv/bin/python\" 'pandas'"));
        assert!(script.contains("MPLBACKEND=Agg"));

        let bare = launcher(&Setup {
            pinned: None,
            packages: Vec::new(),
            ..setup
        });
        assert!(!bare.contains("--managed-python"));
        assert!(!bare.contains("pip install"));
    }

    fn seen(size: Option<u64>, at: i64) -> Seen {
        Seen {
            size,
            modified_at: Some(at),
        }
    }

    #[test]
    fn a_run_names_the_files_it_made_changed_and_removed() {
        let before = Snapshot::from([
            ("data.csv".to_owned(), seen(Some(10), 1)),
            ("old.txt".to_owned(), seen(Some(3), 1)),
            ("same.txt".to_owned(), seen(Some(3), 1)),
        ]);
        let after = Snapshot::from([
            ("data.csv".to_owned(), seen(Some(12), 2)),
            ("out".to_owned(), seen(None, 2)),
            ("out/chart.png".to_owned(), seen(Some(900), 2)),
            ("same.txt".to_owned(), seen(Some(3), 1)),
        ]);
        let (text, files) = made(&before, &after);
        assert_eq!(
            text,
            "Files it made or changed:\ndata.csv (changed, 12 bytes)\nold.txt (removed)\n\
             out/chart.png (new, 900 bytes)"
        );
        assert_eq!(files, vec!["data.csv", "out/chart.png"]);
        assert_eq!(made(&before, &before), (String::new(), Vec::new()));
    }
}
