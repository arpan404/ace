//! The scripts Spade writes into a bot's Python runtime and the commands that run them, and the
//! check of a package a call asks for. Pure.

use std::path::{Path, PathBuf};

use super::{Index, NAMES, Setup};

/// `text` as one POSIX shell word.
pub fn quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', r"'\''"))
}

/// The launcher each run goes through, `control/run.sh`, run as `/bin/sh run.sh <environment>
/// <workspace> <staged script> <modules> <name> <args>…`: it moves to the workspace and starts
/// [`BOOT`] with that environment's Python (the generation the run was given, which nothing
/// changes), isolated (`-I`: no `PYTHON*` variables, no user site, no script or working folder on
/// `sys.path`) and unbuffered.
pub const LAUNCHER: &str = r#"# Spade's launcher for the python tool (ADR 0220). Spade writes it; no run can change it.
control=$(cd "$(dirname "$0")" && pwd -P) || exit 1
environment=$1
cd -- "$2" || exit 1
shift 2
tmp=${TMPDIR:-$PWD/.spade/tmp}
export MPLBACKEND=Agg MPLCONFIGDIR="$tmp/matplotlib"
exec "$environment/bin/python" -I -u "$control/boot.py" "$@"
"#;

/// What runs a staged script, `control/boot.py`, as `boot.py <staged> <modules> <name> <args>…`.
/// The staged bytes run as `__main__` under the script's own name (`__file__` and `argv[0]` are
/// its path in the workspace, `<code>` for code). Workspace modules are imported only from the
/// list Spade staged with the script (`modules`): the trusted ones, each from its staged copy,
/// found after the standard library and the installed packages; any other module in the
/// workspace raises `ImportError` saying why. The workspace is never on `sys.path`.
pub const BOOT: &str = r#"# Spade's start of a python tool run (ADR 0220). Spade writes it; no run can change it.
import importlib.abc, importlib.util, json, sys, types
sys.dont_write_bytecode = True
staged, listed, name = sys.argv[1], sys.argv[2], sys.argv[3]
sys.argv = [name] + sys.argv[4:]
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
del staged, listed, source, types, Workspace
exec(code, main.__dict__)
"#;

/// The lines a resolution may hold, as an extended regular expression for `grep -E`: a pinned
/// name, or its hash. Anything else (a URL, a path, an option, a marker) is refused.
pub const RESOLVED_LINES: &str =
    r"^[A-Za-z0-9._-]+==[A-Za-z0-9.+!_-]+( \\)?$|^ +--hash=sha256:[0-9a-f]{64}( \\)?$|^$";

/// Spade's set-up of one environment generation, `control/setup.sh`, run as `/bin/sh setup.sh
/// <generation> <package>…` in a run that may write only that generation's folder and uv's own
/// folders. It makes the environment; with uv it resolves the packages (binary wheels from the
/// one index, each with its hash, held to the locked versions), refuses a resolution holding
/// anything but pinned names and hashes, and installs exactly that (`--no-deps
/// --require-hashes`). Python is never started after a package is in, and pip never runs. Without
/// uv the environment has the standard library only and asking for packages fails.
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
            "  \"$uv\" venv --no-config --quiet --allow-existing --managed-python --python {} \
             \"$environment\" >/dev/null 2>&1 && made=uv\n",
            quote(version)
        )
    });
    let index = match &setup.index {
        Index::Url(url) => format!("--index-url {}", quote(url)),
        Index::Folder(folder) => format!("--no-index --find-links \"$PWD\"/{}", quote(folder)),
    };
    let lines = quote(RESOLVED_LINES);
    format!(
        r#"# Spade's set-up of this bot's Python (ADR 0220). Spade writes it; no run can change it.
cd "$(dirname "$0")/.." || exit 1
environment="$PWD/generations/$1"
shift
unset PYTHONPATH PYTHONHOME PYTHONSTARTUP PYTHONUSERBASE VIRTUAL_ENV
export PYTHONNOUSERSITE=1 UV_NO_CONFIG=1 UV_NO_PROGRESS=1 UV_LINK_MODE=copy \
  UV_CACHE_DIR="$PWD/cache" UV_PYTHON_INSTALL_DIR="$PWD/pythons"
uv=''
for found in {uvs}; do
  if [ -x "$found" ]; then uv=$found; break; fi
done
made=''
if [ -n "$uv" ]; then
{pinned}  [ -n "$made" ] || {{ "$uv" venv --no-config --quiet --allow-existing --no-python-downloads --python '>=3.10' "$environment" >/dev/null 2>&1 && made=uv; }}
else
  for found in {pythons}; do
    if [ -x "$found" ] && "$found" -I -c 'import sys; sys.exit(sys.version_info < (3, 10))' 2>/dev/null; then
      "$found" -I -m venv --without-pip "$environment" && made=venv && break
    fi
  done
fi
if [ -z "$made" ]; then
  echo "No Python 3.10 or newer was found on this machine (looked for uv and python3 in {looked}). The person can install one, for example with Homebrew: brew install python." >&2
  exit 127
fi
echo "[Set up Python for this bot: $("$environment/bin/python" -I -c 'import platform; print(platform.python_version())').]" >&2
if [ "$made" = venv ]; then
  echo "[uv isn't on this machine, so this Python has only its standard library: Spade installs packages only with uv. The person can install it, for example with Homebrew: brew install uv.]" >&2
fi
if [ $# -gt 0 ]; then
  if [ "$made" != uv ]; then
    echo "Packages need uv, which isn't on this machine." >&2
    exit 5
  fi
  printf '%s\n' "$@" > "$environment/asked.txt"
  echo "[Installing Python's packages for this bot: $*.]" >&2
  failed="[The packages could not be installed (see above): Spade installs only binary wheels from the one index, never anything built from source or fetched from elsewhere, within the versions the environment is locked to. Installing reaches the network, which the person's Network permission decides.]"
  if ! "$uv" pip compile --no-config --quiet --python "$environment/bin/python" --only-binary :all: {index} --no-header --no-annotate --generate-hashes -c control/locked.txt "$environment/asked.txt" -o "$environment/resolved.txt"; then
    echo "$failed" >&2
    exit 3
  fi
  if grep -Ev {lines} "$environment/resolved.txt" >&2; then
    echo "[Spade refused what the packages asked for: only pinned names from the one index, each with its hash, are installed.]" >&2
    exit 4
  fi
  if ! "$uv" pip install --no-config --quiet --python "$environment/bin/python" --only-binary :all: {index} --no-deps --require-hashes -r "$environment/resolved.txt"; then
    echo "$failed" >&2
    exit 3
  fi
fi
"#
    )
}

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

/// What a run starts: the staged script and its list of modules, in the runtime.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Staged {
    pub script: PathBuf,
    pub modules: PathBuf,
    pub name: String,
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

/// The most packages one call asks for.
pub const MOST_ASKED: usize = 20;

/// A package a call asks for, as the set-up installs it: a name, optionally `==` a version, and
/// nothing else (no URL, path, option, extra or other specifier). Answers it trimmed.
pub fn package_spec(spec: &str) -> Result<String, String> {
    let spec = spec.trim();
    let (name, version) = match spec.split_once("==") {
        Some((name, version)) => (name, Some(version)),
        None => (spec, None),
    };
    let name_ok = !name.is_empty()
        && name.len() <= 100
        && name.starts_with(|c: char| c.is_ascii_alphanumeric())
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    let version_ok = version.is_none_or(|v| {
        !v.is_empty()
            && v.len() <= 50
            && v.starts_with(|c: char| c.is_ascii_alphanumeric())
            && v.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '+' | '!' | '_' | '-'))
    });
    if name_ok && version_ok {
        Ok(spec.to_owned())
    } else {
        Err(format!(
            "{spec:?} is not a package Spade installs: give a name, or name==version, from PyPI"
        ))
    }
}

/// The packages a call asks for, each checked, at most [`MOST_ASKED`], without repeats.
pub fn asked_packages(asked: &[String]) -> Result<Vec<String>, String> {
    if asked.len() > MOST_ASKED {
        return Err(format!("ask for {MOST_ASKED} packages at most in one call"));
    }
    let mut specs = Vec::new();
    for spec in asked {
        let spec = package_spec(spec)?;
        if !specs.contains(&spec) {
            specs.push(spec);
        }
    }
    Ok(specs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_command_is_absolute_and_quoted_so_no_name_runs_or_reads_as_an_option() {
        let workspace = Path::new("/data/workspace/b1");
        let staged = Staged {
            script: PathBuf::from("/r/control/scripts/ab.py"),
            modules: PathBuf::from("/r/control/scripts/cd.json"),
            name: Origin::of(workspace, Some("tools/-x.py")).name,
        };
        let command = command(
            Path::new("/r/control"),
            Path::new("/r/generations/g1"),
            workspace,
            &staged,
            &["-c".to_owned(), "$(rm -rf ~)".to_owned(), "it's".to_owned()],
        );
        assert_eq!(
            command,
            "/bin/sh '/r/control/run.sh' '/r/generations/g1' '/data/workspace/b1' \
             '/r/control/scripts/ab.py' '/r/control/scripts/cd.json' \
             '/data/workspace/b1/tools/-x.py' '-c' '$(rm -rf ~)' 'it'\\''s'"
        );
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
    fn the_set_up_installs_only_with_uv_from_one_index_by_hash_and_never_runs_pip() {
        let setup = Setup {
            folders: vec![PathBuf::from("/opt/homebrew/bin")],
            pinned: Some("3.12".to_owned()),
            packages: vec!["pandas==3.1.1".to_owned()],
            index: Index::Url(super::super::PYPI.to_owned()),
        };
        let script = setup_script(&setup);
        assert!(script.contains("for found in '/opt/homebrew/bin/uv'; do"));
        assert!(script.contains("--managed-python --python '3.12'"));
        assert!(script.contains("UV_NO_CONFIG=1") && script.contains("UV_LINK_MODE=copy"));
        assert!(script.contains(
            "--only-binary :all: --index-url 'https://pypi.org/simple' --no-header --no-annotate \
             --generate-hashes -c control/locked.txt"
        ));
        assert!(script.contains("--no-deps --require-hashes -r"));
        assert!(script.contains("-I -m venv --without-pip"));
        assert!(!script.contains("pip install --isolated") && !script.contains("-m pip"));
    }

    #[test]
    fn a_resolution_may_hold_only_pinned_names_and_their_hashes() {
        let lines = regex::Regex::new(RESOLVED_LINES).unwrap_or_else(|e| panic!("{e}"));
        let hash = format!("    --hash=sha256:{}", "a".repeat(64));
        for fine in ["numpy==2.4.6 \\", hash.as_str(), "spadecheck==1.0", ""] {
            assert!(lines.is_match(fine), "{fine}");
        }
        for refused in [
            "evil @ https://example.com/evil.whl",
            "-e ./local",
            "--index-url http://elsewhere/",
            "numpy==2.4.6 ; sys_platform == 'linux'",
            "file:///tmp/x.whl",
        ] {
            assert!(!lines.is_match(refused), "{refused}");
        }
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

    #[test]
    fn only_a_name_or_name_and_version_is_a_package_spade_installs() {
        for fine in [
            "pandas",
            "scikit-learn==1.7.2",
            "zope.interface==7.0",
            "torch==2.5.1+cpu",
        ] {
            assert_eq!(package_spec(fine).as_deref(), Ok(fine));
        }
        for refused in [
            "",
            "https://example.com/x.whl",
            "./local.whl",
            "--index-url=http://evil/",
            "-e git+https://x",
            "pandas>=2",
            "pandas[all]",
            "pandas ; sys_platform",
            "pandas==",
            "name with space",
        ] {
            assert!(package_spec(refused).is_err(), "{refused}");
        }
        let many: Vec<String> = (0..=MOST_ASKED).map(|n| format!("p{n}")).collect();
        assert!(asked_packages(&many).is_err());
        assert_eq!(
            asked_packages(&["a".to_owned(), " a ".to_owned()]),
            Ok(vec!["a".to_owned()])
        );
    }
}
