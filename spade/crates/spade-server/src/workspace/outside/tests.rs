use std::path::{Path, PathBuf};

use super::*;

/// A bot's folder with a script in it, and the environment a command starts with there.
struct Folder {
    _dir: tempfile::TempDir,
    root: PathBuf,
    env: Vec<(String, String)>,
}

impl Folder {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap_or_else(|_| std::process::abort());
        let root = std::fs::canonicalize(dir.path()).unwrap_or_else(|_| std::process::abort());
        let workspace = root.join("workspace");
        std::fs::create_dir_all(&workspace).unwrap_or_else(|_| std::process::abort());
        std::fs::write(workspace.join("run.sh"), "echo first\n")
            .unwrap_or_else(|_| std::process::abort());
        let env = vec![
            ("PATH".to_owned(), "/usr/bin:/bin".to_owned()),
            ("HOME".to_owned(), workspace.to_string_lossy().into_owned()),
        ];
        Self {
            _dir: dir,
            root,
            env,
        }
    }

    fn workspace(&self) -> PathBuf {
        self.root.join("workspace")
    }

    /// The warrant a verdict given now, for `limit`, carries for `command`.
    fn verdict(&self, command: &str, limit: Authorized) -> Warrant {
        let read = read(
            &self.workspace(),
            &self.workspace(),
            &self.env,
            &json!({ "command": command }),
        );
        assert!(!read.incomplete, "{command}");
        Warrant {
            limit,
            bound: binding(&read),
            incomplete: false,
        }
    }

    fn admit(
        &self,
        warrant: Option<&Warrant>,
        launch: Authorized,
        command: &str,
    ) -> Result<(), String> {
        admit(
            warrant,
            launch,
            &self.workspace(),
            &self.workspace(),
            &self.env,
            command,
        )
    }

    /// A program `name` in a folder of the person's, outside the system's and the bot's, put
    /// first on `PATH`.
    fn toolchain(&mut self, name: &str, body: &str) -> PathBuf {
        let bin = self.root.join("toolchain/bin");
        std::fs::create_dir_all(&bin).unwrap_or_else(|_| std::process::abort());
        let program = bin.join(name);
        write_program(&program, body);
        self.env[0].1 = format!("{}:/usr/bin:/bin", bin.display());
        program
    }
}

fn write_program(path: &Path, body: &str) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::write(path, body).unwrap_or_else(|_| std::process::abort());
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
        .unwrap_or_else(|_| std::process::abort());
}

fn said(result: Result<(), String>) -> String {
    result.err().unwrap_or_default()
}

#[test]
fn a_command_starts_outside_only_on_a_warrant_as_wide_as_its_launch() {
    let folder = Folder::new();
    // No verdict let it run: it never starts plainly.
    assert!(said(folder.admit(None, Authorized::Outside, "ls")).contains("Nothing allowed"));
    // A verdict for a narrower launch doesn't cover a wider one.
    for (limit, launch) in [
        (Authorized::Contained, Authorized::AsFound),
        (Authorized::AsFound, Authorized::Outside),
    ] {
        let warrant = folder.verdict("ls", limit);
        assert!(
            said(folder.admit(Some(&warrant), launch, "ls")).contains("wider than"),
            "{limit:?} for {launch:?}"
        );
    }
    let warrant = folder.verdict("ls", Authorized::Outside);
    for launch in [Authorized::AsFound, Authorized::Outside] {
        assert_eq!(folder.admit(Some(&warrant), launch, "ls"), Ok(()));
    }
}

#[test]
fn a_script_changed_since_its_verdict_doesnt_start() {
    let folder = Folder::new();
    let warrant = folder.verdict("sh run.sh", Authorized::Outside);
    assert_eq!(
        folder.admit(Some(&warrant), Authorized::Outside, "sh run.sh"),
        Ok(())
    );
    std::fs::write(folder.workspace().join("run.sh"), "echo rewritten\n")
        .unwrap_or_else(|_| std::process::abort());
    let refused = said(folder.admit(Some(&warrant), Authorized::Outside, "sh run.sh"));
    assert!(refused.contains("changed while it waited"), "{refused}");
}

#[test]
fn an_empty_binding_holds_only_while_the_command_runs_nothing_of_its_own() {
    let folder = Folder::new();
    let nothing = Warrant {
        limit: Authorized::Outside,
        bound: Bound::Nothing,
        incomplete: false,
    };
    assert_eq!(
        folder.admit(Some(&nothing), Authorized::Outside, "ls -la"),
        Ok(())
    );
    // It runs a script now: a verdict that bound nothing doesn't cover it.
    let refused = said(folder.admit(Some(&nothing), Authorized::Outside, "sh run.sh"));
    assert!(refused.contains("changed while it waited"), "{refused}");
}

#[test]
fn a_command_whose_reading_is_incomplete_never_starts_outside() {
    let folder = Folder::new();
    let any = Warrant {
        limit: Authorized::Outside,
        bound: Bound::Nothing,
        incomplete: false,
    };
    // Doesn't parse; a program no `PATH` entry has; a command name built at run time.
    for command in [
        "echo 'unterminated",
        "spade-nonesuch-xyzzy --all",
        "$RUN thing",
    ] {
        let refused = said(folder.admit(Some(&any), Authorized::Outside, command));
        assert!(
            refused.contains("couldn't be read whole"),
            "{command}: {refused}"
        );
    }
}

#[test]
fn a_persons_allow_on_an_incomplete_reading_starts_it_only_while_what_was_read_is_unchanged() {
    let folder = Folder::new();
    // A program no `PATH` entry has, after a script Spade can read.
    let command = "sh run.sh; spade-nonesuch-xyzzy --all";
    let asked = read(
        &folder.workspace(),
        &folder.workspace(),
        &folder.env,
        &json!({ "command": command }),
    );
    assert!(asked.incomplete);
    let allowed = Warrant {
        limit: Authorized::Outside,
        bound: binding(&asked),
        incomplete: true,
    };
    assert_eq!(
        folder.admit(Some(&allowed), Authorized::Outside, command),
        Ok(())
    );
    // The same reading on anyone else's verdict never starts.
    let reviewed = Warrant {
        incomplete: false,
        ..allowed.clone()
    };
    let refused = said(folder.admit(Some(&reviewed), Authorized::Outside, command));
    assert!(refused.contains("couldn't be read whole"), "{refused}");
    // Nor wider than the person allowed, nor once the part that was read changed.
    let contained = Warrant {
        limit: Authorized::Contained,
        ..allowed.clone()
    };
    let refused = said(folder.admit(Some(&contained), Authorized::Outside, command));
    assert!(refused.contains("wider than"), "{refused}");
    std::fs::write(folder.workspace().join("run.sh"), "echo rewritten\n")
        .unwrap_or_else(|_| std::process::abort());
    let refused = said(folder.admit(Some(&allowed), Authorized::Outside, command));
    assert!(refused.contains("changed while it waited"), "{refused}");
}

#[test]
fn git_whose_configuration_names_a_program_is_an_incomplete_reading() {
    let folder = Folder::new();
    let git = folder.workspace().join(".git");
    std::fs::create_dir_all(&git).unwrap_or_else(|_| std::process::abort());
    std::fs::write(git.join("HEAD"), "ref: refs/heads/main\n")
        .unwrap_or_else(|_| std::process::abort());
    std::fs::write(git.join("config"), "[core]\n\tfsmonitor = ./watch.sh\n")
        .unwrap_or_else(|_| std::process::abort());
    let read = read(
        &folder.workspace(),
        &folder.workspace(),
        &folder.env,
        &json!({ "command": "git status" }),
    );
    assert!(read.incomplete);
    // A command that runs no git reads no git configuration.
    let read = super::read(
        &folder.workspace(),
        &folder.workspace(),
        &folder.env,
        &json!({ "command": "ls" }),
    );
    assert!(!read.incomplete);
}

#[test]
fn a_program_of_the_persons_toolchain_is_bound_where_it_is_and_as_it_is() {
    let mut folder = Folder::new();
    let program = folder.toolchain("frob", "#!/bin/sh\necho one\n");
    let warrant = folder.verdict("frob --all", Authorized::Outside);
    assert!(matches!(warrant.bound, Bound::Of(_)));
    assert_eq!(
        folder.admit(Some(&warrant), Authorized::Outside, "frob --all"),
        Ok(())
    );
    // Replaced since the verdict: not what was allowed.
    write_program(&program, "#!/bin/sh\necho something else entirely\n");
    let refused = said(folder.admit(Some(&warrant), Authorized::Outside, "frob --all"));
    assert!(refused.contains("changed while it waited"), "{refused}");
}

#[test]
fn a_program_in_the_bots_folder_on_path_is_read_as_a_script_it_runs() {
    let mut folder = Folder::new();
    let bin = folder.workspace().join("bin");
    std::fs::create_dir_all(&bin).unwrap_or_else(|_| std::process::abort());
    write_program(&bin.join("deploy"), "#!/bin/sh\necho deploying\n");
    folder.env[0].1 = format!("{}:/usr/bin:/bin", bin.display());
    let read = read(
        &folder.workspace(),
        &folder.workspace(),
        &folder.env,
        &json!({ "command": "deploy" }),
    );
    let shown: Vec<&str> = read.shown.iter().map(|s| s.content.as_str()).collect();
    assert_eq!(shown, ["#!/bin/sh\necho deploying\n"]);
}

/// Every file of Spade's server, as text, by its path under `src/` (this one left out: it names
/// what it looks for).
fn sources() -> Vec<(String, String)> {
    fn walk(dir: &Path, root: &Path, out: &mut Vec<(String, String)>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, root, out);
            } else if path.extension().is_some_and(|e| e == "rs") {
                let name = path
                    .strip_prefix(root)
                    .map(|p| p.to_string_lossy().replace('\\', "/"))
                    .unwrap_or_default();
                if name != "workspace/outside/tests.rs" {
                    out.push((name, std::fs::read_to_string(&path).unwrap_or_default()));
                }
            }
        }
    }
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut out = Vec::new();
    walk(&root, &root, &mut out);
    out.sort();
    out
}

/// Every place Spade's server starts a process, and why each is not a bot's command that skips
/// [`admit`]. A new one fails here until it is routed through the shell (and so `admit`) or
/// added with its reason.
///
/// Scope: this crate's own source (`spade-server/src`) only, not the crates it uses
/// (`spade-sandbox`'s launcher, `spade-connect`) or ace's daemon. Plugin servers and hooks are
/// listed as what they are: trusted when the person installs or enables the plugin, contained
/// where there is a sandbox, started plainly where there is none (ADR 0171, amendment 6).
const SPAWNS: &[(&str, usize, &str)] = &[
    (
        "workspace/shell.rs",
        5,
        "the shell itself: one spawn, after `admit` for any bot's run nothing holds; the rest \
         build each platform's shell for it",
    ),
    (
        "computer/terminal.rs",
        1,
        "`/bin/kill` ending a finished run's process group",
    ),
    (
        "security/checkpoints.rs",
        1,
        "`/bin/cp` cloning the workspace for a checkpoint",
    ),
    (
        "security/read_only.rs",
        3,
        "`xcode-select` probing for the developer tools; the rest in macOS tests",
    ),
    (
        "plugins/servers.rs",
        1,
        "a plugin's MCP server, installed by the person (ADR 0151): sealed, or decided as remote",
    ),
    (
        "tools/outward/host.rs",
        2,
        "the typed outward tools' fixed `git` and `gh` (hooks off), decided by the person's rules",
    ),
];

/// Every shell run that isn't a bot's command, and why no verdict applies to it.
const NOT_A_BOTS: &[(&str, &str, &str)] = &[
    (
        "workspace/shell.rs",
        "By::Spade",
        "`Shell::run`: Spade's own command, which only tests call",
    ),
    (
        "computer/terminal.rs",
        "By::Spade",
        "`Terminal::run`: Spade's own run in a terminal, which only tests call",
    ),
    (
        "tools/outward/git.rs",
        "By::Spade",
        "bundling a push: Spade's fixed script, held in the sandbox",
    ),
    (
        "plugins/hooks.rs",
        "By::Plugin",
        "a plugin's hook, which the person installed (ADR 0151)",
    ),
];

#[test]
fn no_process_starts_outside_the_one_path_bots_commands_take() {
    let sources = sources();
    let mut spawns: Vec<(String, usize)> = sources
        .iter()
        .map(|(name, text)| {
            let found = text.matches("Command::new(").count() + text.matches(".spawn()").count();
            (name.clone(), found)
        })
        .filter(|(_, found)| *found > 0)
        .collect();
    spawns.sort();
    let mut expected: Vec<(String, usize)> = SPAWNS
        .iter()
        .map(|(name, found, _)| ((*name).to_owned(), *found))
        .collect();
    expected.sort();
    assert_eq!(
        spawns, expected,
        "a process start was added or moved: route a bot's command through the shell (and so \
         `outside::admit`), or list it in SPAWNS with why it isn't one"
    );
    // In the shell, a bot's run reaches its one spawn only through `admit`.
    let shell = sources
        .iter()
        .find(|(name, _)| name == "workspace/shell.rs")
        .map(|(_, text)| text.as_str())
        .unwrap_or_default();
    let (admit, spawn) = (
        shell.find("super::outside::admit(").unwrap_or(usize::MAX),
        shell.find(".spawn()").unwrap_or(0),
    );
    assert!(admit < spawn, "the spawn comes before `admit`");
}

#[test]
fn every_shell_run_is_a_bots_unless_listed_with_its_reason() {
    let mut not_bots: Vec<(String, String)> = Vec::new();
    for (name, text) in sources() {
        for marker in ["By::Spade", "By::Plugin"] {
            // As a word: `CancelledBy::Spade` is no shell run.
            let uses = text.match_indices(marker).filter(|(at, _)| {
                !text[..*at]
                    .chars()
                    .next_back()
                    .is_some_and(|c| c.is_alphanumeric() || c == '_')
            });
            for _ in uses {
                not_bots.push((name.clone(), marker.to_owned()));
            }
        }
    }
    not_bots.sort();
    let mut expected: Vec<(String, String)> = NOT_A_BOTS
        .iter()
        .map(|(name, marker, _)| ((*name).to_owned(), (*marker).to_owned()))
        .collect();
    expected.sort();
    assert_eq!(
        not_bots, expected,
        "a shell run that isn't a bot's was added: a bot's command is `By::Bot` with its \
         verdict's warrant; anything else needs its reason in NOT_A_BOTS"
    );
}

#[test]
fn a_program_rewritten_to_the_same_size_with_its_time_put_back_doesnt_start() {
    let mut folder = Folder::new();
    let program = folder.toolchain("frob", "#!/bin/sh\necho one\n");
    let warrant = folder.verdict("frob --all", Authorized::Outside);
    let changed = std::fs::metadata(&program)
        .and_then(|meta| meta.modified())
        .unwrap_or_else(|_| std::process::abort());
    write_program(&program, "#!/bin/sh\necho two\n");
    std::fs::File::options()
        .write(true)
        .open(&program)
        .and_then(|file| file.set_modified(changed))
        .unwrap_or_else(|_| std::process::abort());
    let refused = said(folder.admit(Some(&warrant), Authorized::Outside, "frob --all"));
    assert!(refused.contains("changed while it waited"), "{refused}");
}

#[test]
fn a_program_linked_from_path_is_bound_by_what_it_links_to() {
    let mut folder = Folder::new();
    // A link on `PATH` into a folder of the person's: bound by the target's content.
    let target = folder.root.join("home/frob");
    std::fs::create_dir_all(folder.root.join("home")).unwrap_or_else(|_| std::process::abort());
    write_program(&target, "#!/bin/sh\necho one\n");
    let link = folder.toolchain("placeholder", "");
    let bin = link.parent().map(Path::to_path_buf).unwrap_or_default();
    std::os::unix::fs::symlink(&target, bin.join("frob")).unwrap_or_else(|_| std::process::abort());
    let read = read(
        &folder.workspace(),
        &folder.workspace(),
        &folder.env,
        &json!({ "command": "frob" }),
    );
    let bound: Vec<&Path> = read.programs.iter().map(|(p, _)| p.as_path()).collect();
    assert_eq!(bound, [target.as_path()]);
    let warrant = folder.verdict("frob", Authorized::Outside);
    write_program(&target, "#!/bin/sh\necho two\n");
    let refused = said(folder.admit(Some(&warrant), Authorized::Outside, "frob"));
    assert!(refused.contains("changed while it waited"), "{refused}");
    // A link to the system's own is the system's: nothing to bind.
    std::os::unix::fs::symlink("/usr/bin/env", bin.join("myenv"))
        .unwrap_or_else(|_| std::process::abort());
    let warrant = folder.verdict("myenv", Authorized::Outside);
    if cfg!(target_os = "linux") {
        assert_eq!(warrant.bound, Bound::Nothing);
    }
}

#[test]
fn a_program_too_large_to_read_whole_is_an_incomplete_reading() {
    let mut folder = Folder::new();
    let program = folder.toolchain("huge", "#!/bin/sh\n");
    // Sparse: past the most Spade reads, without writing it.
    std::fs::File::options()
        .write(true)
        .open(&program)
        .and_then(|file| file.set_len(super::super::place::LONGEST_PROGRAM + 1))
        .unwrap_or_else(|_| std::process::abort());
    let read = read(
        &folder.workspace(),
        &folder.workspace(),
        &folder.env,
        &json!({ "command": "huge" }),
    );
    assert!(read.incomplete);
}
