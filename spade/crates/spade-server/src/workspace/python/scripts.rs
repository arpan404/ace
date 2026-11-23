//! The two files a run goes through (the launcher and `boot.py`), the command that starts them,
//! and how a workspace file names a module. Pure.

use std::path::{Path, PathBuf};

/// `text` as one POSIX shell word.
pub fn quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', r"'\''"))
}

/// The launcher each run goes through, `<shared>/control/run.sh`, run as `/bin/sh run.sh
/// <environment> <workspace> <staged script> <modules> <name> <args>…`: it moves to the workspace
/// and starts [`BOOT`] with that environment's Python, isolated (`-I`: no `PYTHON*` variables,
/// no user site, no script or working folder on `sys.path`), without `site` (`-S`: no `.pth`
/// file or `sitecustomize` runs at start) and unbuffered.
pub const LAUNCHER: &str = r#"# Spade's launcher for the python tool (ADR 0220). Spade writes it; no run can change it.
control=$(cd "$(dirname "$0")" && pwd -P) || exit 1
environment=$1
cd -- "$2" || exit 1
shift 2
tmp=${TMPDIR:-$PWD/.spade/tmp}
export MPLBACKEND=Agg MPLCONFIGDIR="$tmp/matplotlib"
exec "$environment/bin/python" -I -S -u "$control/boot.py" "$environment" "$@"
"#;

/// What runs a staged script, `<shared>/control/boot.py`, as `boot.py <environment> <staged>
/// <modules> <name> <args>…`. It puts that environment's installed packages on `sys.path` after
/// the standard library (without `site` Python doesn't find them itself, and no `.pth` file in
/// them is read), then runs the staged bytes as `__main__` under the
/// script's own name (`__file__` and `argv[0]` are its path in the workspace, `<code>` for
/// code). Workspace modules are imported only from the list Spade staged with the script
/// (`modules`): the trusted ones, each from its staged copy, found after the standard library
/// and the installed packages; any other module in the workspace raises `ImportError` saying
/// why. The workspace is never on `sys.path`.
pub const BOOT: &str = r#"# Spade's start of a python tool run (ADR 0220). Spade writes it; no run can change it.
import importlib.abc, importlib.util, json, os, sys, types
sys.dont_write_bytecode = True
environment, staged, listed, name = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
folder = os.path.join(environment, "lib", "python%d.%d" % sys.version_info[:2], "site-packages")
if os.path.isdir(folder) and folder not in sys.path:
    sys.path.append(folder)
sys.argv = [name] + sys.argv[5:]
with open(listed, "rb") as source:
    listed = json.loads(source.read())


class Workspace(importlib.abc.MetaPathFinder):
    """The workspace's modules Spade staged with the script, and nothing else of it."""

    def __init__(self, modules, refused):
        self.modules = modules
        self.refused = set(refused)

    def find_spec(self, fullname, path=None, target=None):
        entry = self.modules.get(fullname)
        if entry is not None:
            return importlib.util.spec_from_file_location(
                fullname,
                entry["file"],
                submodule_search_locations=[] if entry["package"] else None,
            )
        if fullname in self.refused:
            raise ImportError(
                f"{fullname} is a module in your workspace, but Spade imports only modules its "
                "file tools wrote from a clean prompt, and this one was written another way (by "
                "a command, or after reading untrusted content). Put its code in the script, or "
                "write the module again with workspace_write.",
                name=fullname,
            )
        return None


sys.meta_path.append(Workspace(listed["modules"], listed["refused"]))
with open(staged, "rb") as source:
    code = compile(source.read(), name, "exec")
main = types.ModuleType("__main__")
main.__file__ = name
main.__builtins__ = __builtins__
sys.modules["__main__"] = main
del environment, staged, listed, source, types, Workspace, folder
exec(code, main.__dict__)
"#;

/// Where a script runs from: the folder in the workspace its modules are looked for in
/// (relative to the workspace's top) and its name (`__file__`), absolute in the workspace, or
/// the top and `<code>` for code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Origin {
    pub folder: String,
    pub name: String,
}

impl Origin {
    /// For the script at `relative` (normalised) in the workspace at `workspace`, or code.
    pub fn of(workspace: &Path, relative: Option<&str>) -> Self {
        match relative {
            Some(relative) => Self {
                folder: relative
                    .rsplit_once('/')
                    .map_or(String::new(), |(folder, _)| folder.to_owned()),
                name: workspace.join(relative).to_string_lossy().into_owned(),
            },
            None => Self {
                folder: String::new(),
                name: "<code>".to_owned(),
            },
        }
    }
}

/// What a run starts: the staged script and its list of modules, in the bot's staging folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Staged {
    pub script: PathBuf,
    pub modules: PathBuf,
    pub name: String,
}

impl Staged {
    /// The staged bytes this call is bound to, by their hashes (the files are named by them).
    pub fn binding(&self) -> String {
        let stem = |path: &Path| {
            path.file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default()
        };
        format!("{} {}", stem(&self.script), stem(&self.modules))
    }
}

/// The command that runs `staged` with `args` through the launcher in `control`, with the
/// environment at `environment`, in the workspace at `workspace`. Every word is absolute or
/// quoted, so no name reads as an option.
pub fn command(
    control: &Path,
    environment: &Path,
    workspace: &Path,
    staged: &Staged,
    args: &[String],
) -> String {
    let mut words = vec![
        "/bin/sh".to_owned(),
        quote(&control.join("run.sh").to_string_lossy()),
        quote(&environment.to_string_lossy()),
        quote(&workspace.to_string_lossy()),
        quote(&staged.script.to_string_lossy()),
        quote(&staged.modules.to_string_lossy()),
        quote(&staged.name),
    ];
    words.extend(args.iter().map(|arg| quote(arg)));
    words.join(" ")
}

/// The module a workspace file is, from its path under the script's folder: `helper.py` is
/// `helper`, `pkg/__init__.py` the package `pkg`, `pkg/sub.py` `pkg.sub`. `None` for a name
/// Python can't import.
pub fn module_of(relative: &str) -> Option<(String, bool)> {
    let stem = relative.strip_suffix(".py")?;
    let (stem, package) = match stem.strip_suffix("/__init__") {
        Some(package) => (package, true),
        None => (stem, false),
    };
    let parts: Vec<&str> = stem.split('/').collect();
    let fine = parts.iter().all(|part| {
        part.chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
            && part.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
    });
    fine.then(|| (parts.join("."), package))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_command_is_absolute_and_quoted_so_no_name_runs_or_reads_as_an_option() {
        let workspace = Path::new("/data/workspace/b1");
        let staged = Staged {
            script: PathBuf::from("/r/bots/b1/scripts/ab.py"),
            modules: PathBuf::from("/r/bots/b1/scripts/cd.json"),
            name: Origin::of(workspace, Some("tools/-x.py")).name,
        };
        let command = command(
            Path::new("/r/shared/control"),
            Path::new("/r/shared/environments/e1"),
            workspace,
            &staged,
            &["-c".to_owned(), "$(rm -rf ~)".to_owned(), "it's".to_owned()],
        );
        assert_eq!(
            command,
            "/bin/sh '/r/shared/control/run.sh' '/r/shared/environments/e1' '/data/workspace/b1' \
             '/r/bots/b1/scripts/ab.py' '/r/bots/b1/scripts/cd.json' \
             '/data/workspace/b1/tools/-x.py' '-c' '$(rm -rf ~)' 'it'\\''s'"
        );
        assert_eq!(staged.binding(), "ab cd");
        assert_eq!(Origin::of(workspace, Some("tools/-x.py")).folder, "tools");
        assert_eq!(
            Origin::of(workspace, None),
            Origin {
                folder: String::new(),
                name: "<code>".to_owned()
            }
        );
    }

    #[test]
    fn a_workspace_file_is_the_module_python_would_name_it() {
        assert_eq!(module_of("helper.py"), Some(("helper".to_owned(), false)));
        assert_eq!(module_of("pkg/__init__.py"), Some(("pkg".to_owned(), true)));
        assert_eq!(module_of("pkg/sub.py"), Some(("pkg.sub".to_owned(), false)));
        assert_eq!(module_of("my-script.py"), None);
        assert_eq!(module_of("2fast.py"), None);
        assert_eq!(module_of("notes.txt"), None);
    }
}
