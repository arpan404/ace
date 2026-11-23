//! The `python` tool (ADR 0220) through the real server and the machine's sandbox, with a real
//! interpreter: a script's files are named and its images attached; the bot's environment is
//! Spade's, made once from a locked package source and never changed by the bot or its workspace;
//! the bytes classed are the bytes run; a long script carries on as a background job; and a
//! machine with no Python or no sandbox says so plainly.
//!
//! The tests that run Python need Python 3.10 or newer (or uv) in `/opt/homebrew/bin`,
//! `/usr/local/bin` or `/usr/bin`, and the sandbox; without them they say so and pass. Packages
//! come from a wheel the tests build, never the network.
#![cfg(any(target_os = "macos", all(target_os = "linux", feature = "landlock")))]

mod support;

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{Value, json};
use spade_server::workspace::python::{Index, Setup};
use spade_server::workspace::workspace_tools_with;
use spade_testkit::Script;
use support::sandbox::{World, world_in_with_options, world_with_options};
use support::{Options, Result};

/// The system folders the tests look in.
const SYSTEM: &[&str] = &["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];

/// Where the tests look for Python: `folders`, no download, nothing to install.
fn setup_in(folders: &[&str]) -> Setup {
    Setup {
        folders: folders.iter().map(PathBuf::from).collect(),
        pinned: None,
        packages: Vec::new(),
        index: Index::Folder("wheels".to_owned()),
    }
}

fn setup() -> Setup {
    setup_in(SYSTEM)
}

/// [`setup`], installing the test's own package from the wheel folder of the bot's runtime.
fn with_package(folders: &[&str]) -> Setup {
    Setup {
        packages: vec!["spadecheck==1.0".to_owned()],
        ..setup_in(folders)
    }
}

/// Whether `folder` holds a Python 3.10 or newer, checked as the set-up does.
fn python_in(folder: &Path) -> bool {
    [
        "python3.14",
        "python3.13",
        "python3.12",
        "python3.11",
        "python3.10",
        "python3",
    ]
    .iter()
    .any(|name| {
        std::process::Command::new(folder.join(name))
            .args([
                "-I",
                "-c",
                "import sys; sys.exit(sys.version_info < (3, 10))",
            ])
            .status()
            .is_ok_and(|status| status.success())
    })
}

/// Whether this machine has a Python the tool can use.
fn python_here() -> bool {
    let found = SYSTEM
        .iter()
        .map(Path::new)
        .any(|folder| folder.join("uv").exists() || python_in(folder));
    if !found {
        eprintln!("skipped: no Python 3.10 or newer (or uv) on this machine");
    }
    found
}

/// A folder the sandbox reads that has a Python 3.10 or newer and no uv, for the `venv` path.
fn python_without_uv() -> Option<&'static str> {
    let found = [
        "/opt/homebrew/opt/python@3.14/bin",
        "/opt/homebrew/opt/python@3.13/bin",
        "/opt/homebrew/opt/python@3.12/bin",
        "/usr/local/opt/python@3.13/bin",
        "/usr/bin",
    ]
    .into_iter()
    .find(|folder| !Path::new(folder).join("uv").exists() && python_in(Path::new(folder)));
    if found.is_none() {
        eprintln!("skipped: no Python 3.10 or newer without uv beside it here");
    }
    found
}

/// A wheel of the package `spadecheck` 1.0, whose `VALUE` is 42.
fn wheel() -> Result<Vec<u8>> {
    wheel_of("spadecheck", "1.0", "VALUE = 42\n")
}

/// A pure-Python wheel of `name` `version` whose module holds `source`.
fn wheel_of(name: &str, version: &str, source: &str) -> Result<Vec<u8>> {
    let info = format!("{name}-{version}.dist-info");
    let module = format!("{name}/__init__.py");
    let metadata = format!("Metadata-Version: 2.1\nName: {name}\nVersion: {version}\n");
    let record = format!("{module},,\n{info}/METADATA,,\n{info}/WHEEL,,\n{info}/RECORD,,\n");
    let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default();
    let files = [
        (module.clone(), source.to_owned()),
        (format!("{info}/METADATA"), metadata),
        (
            format!("{info}/WHEEL"),
            "Wheel-Version: 1.0\nGenerator: spade-test\nRoot-Is-Purelib: true\nTag: py3-none-any\n"
                .to_owned(),
        ),
        (format!("{info}/RECORD"), record),
    ];
    for (name, text) in files {
        writer.start_file(name, options)?;
        writer.write_all(text.as_bytes())?;
    }
    Ok(writer.finish()?.into_inner())
}

/// The bot's runtime folder, with the test's wheel in its wheel folder.
fn runtime_with_wheel(world: &World) -> Result<PathBuf> {
    let runtime = world.workspaces.python_runtime(&world.bot)?;
    std::fs::create_dir_all(runtime.join("wheels"))?;
    std::fs::write(
        runtime.join("wheels/spadecheck-1.0-py3-none-any.whl"),
        wheel()?,
    )?;
    Ok(runtime)
}

async fn world(scripts: Vec<Script>, options: Options) -> Result<Option<World>> {
    world_in(false, scripts, options).await
}

/// A sandboxed world whose commands run in the bot's terminal when `terminal`; `None` (after
/// saying why) when the sandbox isn't available.
async fn world_in(terminal: bool, scripts: Vec<Script>, options: Options) -> Result<Option<World>> {
    let options = Options {
        python: Some(options.python.clone().unwrap_or_else(setup)),
        ..options
    };
    let world = world_in_with_options(options, terminal, true, |_| scripts).await?;
    if !world.security.contains() {
        eprintln!("skipped: the sandbox isn't available here");
        return Ok(None);
    }
    Ok(Some(world))
}

fn finished<'a>(events: &'a [Value], call: &str) -> Result<&'a Value> {
    Ok(events
        .iter()
        .find(|e| e["type"] == "tool_finished" && e["call_id"] == call)
        .ok_or(format!("{call} has no result"))?)
}

fn content<'a>(events: &'a [Value], call: &str) -> Result<&'a str> {
    Ok(finished(events, call)?["content"]
        .as_str()
        .unwrap_or_default())
}

/// A script that writes a CSV and a PNG (a real one, made without packages) and prints a sum.
const CHART: &str = r#"
import csv, struct, zlib
rows = [("fruit", "count"), ("apples", 3), ("pears", 4)]
with open("out/fruit.csv", "w", newline="") as f:
    csv.writer(f).writerows(rows)
def chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)) \
    + chunk(b"IDAT", zlib.compress(b"\x00\xff\x00\x00")) + chunk(b"IEND", b"")
with open("out/chart.png", "wb") as f:
    f.write(png)
print("total", sum(r[1] for r in rows[1:]))
"#;

#[tokio::test]
async fn a_script_that_writes_a_csv_and_a_png_names_both_and_attaches_the_png() -> Result {
    if !python_here() {
        return Ok(());
    }
    let Some(world) = world(
        vec![
            Script::reply("").call("p1", "python", json!({ "code": CHART })),
            Script::reply("Seven fruit; the chart is above."),
        ],
        Options::default(),
    )
    .await?
    else {
        return Ok(());
    };
    std::fs::create_dir_all(world.workspaces.of(&world.bot)?.path()?.join("out"))?;
    world
        .spade
        .say(&world.conversation, "Count the fruit")
        .await?;
    let events = world
        .spade
        .wait_for(&world.conversation, "reply_finished")
        .await?;
    let ran = finished(&events, "p1")?;
    let text = content(&events, "p1")?;
    assert_eq!(ran["is_error"], false, "{ran}");
    // The first run says Python was set up, then how the script went.
    assert!(
        text.starts_with("[Set up Python for this bot: ") && text.contains("\nExit code 0.\n"),
        "{text}"
    );
    assert!(text.contains("total 7"), "{text}");
    assert!(
        text.contains("Files it made or changed:\nout/chart.png (new, ")
            && text.contains("\nout/fruit.csv (new, 32 bytes)"),
        "{text}"
    );
    // Its output, like a command's, is untrusted.
    assert_eq!(ran["untrusted"], true, "{ran}");
    // The PNG is given to the model and shown to the person.
    assert_eq!(ran["images"][0]["media_type"], "image/png", "{ran}");
    let shared = events
        .iter()
        .find(|e| e["type"] == "shared" && e["call_id"] == "p1")
        .ok_or("nothing was shown to the person")?;
    assert_eq!(shared["images"][0]["sha256"], ran["images"][0]["sha256"]);
    let ran_where = events
        .iter()
        .find(|e| e["type"] == "command_ran" && e["call_id"] == "p1")
        .ok_or("no command_ran")?;
    assert_eq!(ran_where["contained"], true, "{ran_where}");
    Ok(())
}

#[tokio::test]
async fn in_the_bots_terminal_a_script_runs_and_names_its_files_as_in_the_one_shot_shell() -> Result
{
    if !python_here() {
        return Ok(());
    }
    let Some(world) = world_in(
        true,
        vec![
            Script::reply("").call("p1", "python", json!({ "code": CHART })),
            Script::reply("Seven fruit."),
        ],
        Options::default(),
    )
    .await?
    else {
        return Ok(());
    };
    std::fs::create_dir_all(world.workspaces.of(&world.bot)?.path()?.join("out"))?;
    world
        .spade
        .say(&world.conversation, "Count the fruit")
        .await?;
    let events = world
        .spade
        .wait_for(&world.conversation, "reply_finished")
        .await?;
    let ran = finished(&events, "p1")?;
    let text = content(&events, "p1")?;
    assert_eq!(ran["is_error"], false, "{ran}");
    assert!(text.contains("total 7"), "{text}");
    assert!(text.contains("out/fruit.csv (new, 32 bytes)"), "{text}");
    assert_eq!(ran["images"][0]["media_type"], "image/png", "{ran}");
    Ok(())
}

#[tokio::test]
async fn the_environment_is_set_up_once_from_the_locked_source_and_its_package_imports_after()
-> Result {
    if !python_here() {
        return Ok(());
    }
    let read = "import spadecheck, sys; print('value', spadecheck.VALUE, sys.prefix)";
    let Some(world) = world(
        vec![
            Script::reply("").call("p1", "python", json!({ "code": read })),
            Script::reply("").call(
                "p2",
                "python",
                json!({ "path": "tools/hello.py", "args": ["it's", "me"] }),
            ),
            Script::reply("").call("p3", "python", json!({ "code": read })),
            Script::reply("Done."),
        ],
        Options {
            python: Some(with_package(SYSTEM)),
            ..Options::default()
        },
    )
    .await?
    else {
        return Ok(());
    };
    let runtime = runtime_with_wheel(&world)?;
    assert!(!runtime.join("venv").exists(), "made before first use");
    let root = world.workspaces.of(&world.bot)?.path()?;
    std::fs::create_dir_all(root.join("tools"))?;
    std::fs::write(
        root.join("tools/hello.py"),
        "import sys\nprint(' '.join(sys.argv[1:]))\n",
    )?;
    world.spade.say(&world.conversation, "Run them").await?;
    let events = world
        .spade
        .wait_for(&world.conversation, "reply_finished")
        .await?;
    let first = content(&events, "p1")?;
    assert!(first.contains("[Set up Python for this bot: 3."), "{first}");
    assert!(
        first.contains("[Installing Python's packages for this bot: spadecheck.]"),
        "{first}"
    );
    assert!(first.contains("value 42"), "{first}");
    // The environment is Spade's runtime folder, outside the workspace.
    assert!(first.contains("/.python/"), "{first}");
    assert!(!root.join(".spade/python").exists());
    for later in ["p2", "p3"] {
        let text = content(&events, later)?;
        assert!(
            !text.contains("Set up Python") && !text.contains("Installing"),
            "{later} set up again: {text}"
        );
    }
    assert!(content(&events, "p2")?.contains("it's me"));
    assert!(content(&events, "p3")?.contains("value 42"));
    Ok(())
}

#[tokio::test]
async fn the_venv_path_sets_up_isolated_from_modules_and_configuration_in_the_workspace() -> Result
{
    let Some(folder) = python_without_uv() else {
        return Ok(());
    };
    let Some(world) = world(
        vec![
            Script::reply("").call(
                "p1",
                "python",
                json!({ "code": "import spadecheck; print('value', spadecheck.VALUE)" }),
            ),
            Script::reply("Done."),
        ],
        Options {
            python: Some(with_package(&[folder])),
            ..Options::default()
        },
    )
    .await?
    else {
        return Ok(());
    };
    runtime_with_wheel(&world)?;
    let root = world.workspaces.of(&world.bot)?.path()?;
    // A `venv` module that would shadow the standard one, and installer configuration in the
    // bot's home (the workspace) that would break every install that read it.
    std::fs::write(
        root.join("venv.py"),
        "print('PLANTED'); raise SystemExit(3)\n",
    )?;
    for config in [
        ".config/pip/pip.conf",
        ".pip/pip.conf",
        ".config/uv/uv.toml",
    ] {
        let path = root.join(config);
        std::fs::create_dir_all(path.parent().ok_or("no parent")?)?;
        std::fs::write(path, "[global\nindex-url = http://127.0.0.1:9/\n")?;
    }
    world.spade.say(&world.conversation, "Run it").await?;
    let events = world
        .spade
        .wait_for(&world.conversation, "reply_finished")
        .await?;
    let text = content(&events, "p1")?;
    assert_eq!(finished(&events, "p1")?["is_error"], false, "{text}");
    assert!(!text.contains("PLANTED"), "{text}");
    assert!(text.contains("value 42"), "{text}");
    Ok(())
}

#[tokio::test]
async fn the_bots_own_commands_can_read_its_python_but_never_change_it() -> Result {
    if !python_here() {
        return Ok(());
    }
    let Some(world) = world(
        vec![
            Script::reply("").call("p1", "python", json!({ "code": "print('first')" })),
            Script::reply("").call(
                "s1",
                "shell",
                json!({ "command": "RUNTIME=\"$(dirname \"$HOME\")/.python/$(basename \"$HOME\")\"; \
                                    ls \"$RUNTIME/venv/bin\" >/dev/null && echo listed; \
                                    echo 'echo planted' > \"$RUNTIME/run.sh\"; \
                                    printf '#!/bin/sh\\necho planted\\n' > \"$RUNTIME/venv/bin/python\"; \
                                    echo done" }),
            ),
            Script::reply("").call("p2", "python", json!({ "code": "print('second')" })),
            Script::reply("Done."),
        ],
        Options::default(),
    )
    .await?
    else {
        return Ok(());
    };
    let runtime = world.workspaces.python_runtime(&world.bot)?;
    world
        .spade
        .say(&world.conversation, "Run, then try to change it")
        .await?;
    let events = world
        .spade
        .wait_for(&world.conversation, "reply_finished")
        .await?;
    assert!(content(&events, "p1")?.contains("first"));
    let launcher = std::fs::read_to_string(runtime.join("run.sh"))?;
    assert!(
        !launcher.contains("planted"),
        "the bot rewrote the launcher"
    );
    let second = content(&events, "p2")?;
    assert!(
        second.contains("second") && !second.contains("planted"),
        "{second}"
    );
    // It could read its Python, and every write was refused.
    let tried = content(&events, "s1")?;
    assert!(
        tried.contains("listed") && tried.contains("done"),
        "{tried}"
    );
    Ok(())
}

#[tokio::test]
async fn a_script_imports_modules_beside_it_but_never_in_place_of_the_standard_library() -> Result {
    if !python_here() {
        return Ok(());
    }
    let main = "import json, helper\n\
                print('twice', helper.twice(21), json.dumps({'a': 1}))\n\
                print('file', __file__)\n\
                print('data', open('data.txt').read())\n";
    let code = "import json, rooted\nprint('rooted', rooted.NAME, json.dumps([1]))\n";
    let Some(world) = world(
        vec![
            Script::reply("")
                .call("p1", "python", json!({ "path": "tools/main.py" }))
                .call("p2", "python", json!({ "code": code })),
            Script::reply("Done."),
        ],
        Options::default(),
    )
    .await?
    else {
        return Ok(());
    };
    let root = world.workspaces.of(&world.bot)?.path()?;
    std::fs::create_dir_all(root.join("tools"))?;
    std::fs::write(root.join("tools/main.py"), main)?;
    std::fs::write(
        root.join("tools/helper.py"),
        "def twice(n):\n    return n * 2\n",
    )?;
    std::fs::write(root.join("rooted.py"), "NAME = 'at the top'\n")?;
    // Would shadow the standard library if the workspace came first on the path.
    for shadow in ["tools/json.py", "json.py"] {
        std::fs::write(root.join(shadow), "raise SystemExit('SHADOWED')\n")?;
    }
    std::fs::write(root.join("data.txt"), "beside the workspace")?;
    world.spade.say(&world.conversation, "Run them").await?;
    let events = world
        .spade
        .wait_for(&world.conversation, "reply_finished")
        .await?;
    let first = content(&events, "p1")?;
    assert!(first.contains("twice 42 {\"a\": 1}"), "{first}");
    assert!(
        first.contains(&format!("file {}", root.join("tools/main.py").display())),
        "{first}"
    );
    assert!(first.contains("data beside the workspace"), "{first}");
    assert!(!first.contains("SHADOWED"), "{first}");
    let second = content(&events, "p2")?;
    assert!(second.contains("rooted at the top [1]"), "{second}");
    assert!(!second.contains("SHADOWED"), "{second}");
    // Nothing was cached beside the scripts.
    assert!(!root.join("tools/__pycache__").exists());
    Ok(())
}

#[tokio::test]
async fn a_call_asks_for_packages_and_spades_set_up_installs_them_once_from_wheels_only() -> Result
{
    if !python_here() {
        return Ok(());
    }
    let read = "import spadeextra; print('extra', spadeextra.VALUE)";
    let Some(world) = world(
        vec![
            Script::reply("").call(
                "p1",
                "python",
                json!({ "code": read, "packages": ["spadeextra==2.0"] }),
            ),
            Script::reply("").call("p2", "python", json!({ "code": read })),
            Script::reply("").call(
                "p3",
                "python",
                json!({ "code": read, "packages": ["spadeextra==2.0"] }),
            ),
            Script::reply("").call(
                "p4",
                "python",
                json!({ "code": "open('ran.txt', 'w').write('x')", "packages": ["spadesrc==1.0"] }),
            ),
            Script::reply("").call(
                "p5",
                "python",
                json!({ "code": "open('ran.txt', 'w').write('x')",
                        "packages": ["--index-url=http://127.0.0.1:9/"] }),
            ),
            Script::reply("Done."),
        ],
        Options::default(),
    )
    .await?
    else {
        return Ok(());
    };
    let runtime = world.workspaces.python_runtime(&world.bot)?;
    std::fs::create_dir_all(runtime.join("wheels"))?;
    std::fs::write(
        runtime.join("wheels/spadeextra-2.0-py3-none-any.whl"),
        wheel_of("spadeextra", "2.0", "VALUE = 'two'\n")?,
    )?;
    // Only a source distribution of this one: never built.
    std::fs::write(runtime.join("wheels/spadesrc-1.0.tar.gz"), b"not built")?;
    world
        .spade
        .say(&world.conversation, "Use the packages")
        .await?;
    let events = world
        .spade
        .wait_for(&world.conversation, "reply_finished")
        .await?;
    let first = content(&events, "p1")?;
    assert!(
        first.contains("[Installing the packages asked for: spadeextra==2.0.]"),
        "{first}"
    );
    assert!(first.contains("extra two"), "{first}");
    for later in ["p2", "p3"] {
        let text = content(&events, later)?;
        assert!(text.contains("extra two"), "{later}: {text}");
        assert!(
            !text.contains("Installing"),
            "{later} installed again: {text}"
        );
    }
    let root = world.workspaces.of(&world.bot)?.path()?;
    for refused in ["p4", "p5"] {
        assert_eq!(finished(&events, refused)?["is_error"], true, "{refused}");
    }
    assert!(
        content(&events, "p4")?.contains("never built from source"),
        "{}",
        content(&events, "p4")?
    );
    assert!(
        content(&events, "p5")?.contains("is not a package Spade installs"),
        "{}",
        content(&events, "p5")?
    );
    assert!(
        !root.join("ran.txt").exists(),
        "a refused call ran its script"
    );
    Ok(())
}

#[tokio::test]
async fn a_script_named_like_an_option_runs_as_a_script() -> Result {
    if !python_here() {
        return Ok(());
    }
    let Some(world) = world(
        vec![
            Script::reply("").call("p1", "python", json!({ "path": "-c", "args": ["-c"] })),
            Script::reply("Done."),
        ],
        Options::default(),
    )
    .await?
    else {
        return Ok(());
    };
    let root = world.workspaces.of(&world.bot)?.path()?;
    std::fs::write(
        root.join("-c"),
        "import sys\nprint('ran as a script with', sys.argv[1:])\n",
    )?;
    world.spade.say(&world.conversation, "Run it").await?;
    let events = world
        .spade
        .wait_for(&world.conversation, "reply_finished")
        .await?;
    let text = content(&events, "p1")?;
    assert!(text.contains("ran as a script with ['-c']"), "{text}");
    Ok(())
}

#[tokio::test]
async fn the_script_classed_is_the_script_that_runs_and_its_whole_text_is_shown() -> Result {
    if !python_here() {
        return Ok(());
    }
    let Some(world) = world(Vec::new(), Options::default()).await? else {
        return Ok(());
    };
    let tools = workspace_tools_with(
        world.workspaces.clone(),
        world.bots.clone(),
        world.shell.clone(),
        setup(),
    );
    let python = tools
        .iter()
        .find(|tool| tool.def().spec.name == "python")
        .ok_or("no python tool")?;
    let root = world.workspaces.of(&world.bot)?.path()?;
    std::fs::write(root.join("job.py"), "print('the reviewed script')\n")?;
    let key = format!("{}.c1", world.conversation);
    let arguments = json!({ "path": "job.py" });
    let classed = python.classed(&key, &arguments);
    assert_eq!(
        classed
            .shown
            .iter()
            .map(|s| (s.path.as_str(), s.content.as_str()))
            .collect::<Vec<_>>(),
        vec![("job.py", "print('the reviewed script')\n")]
    );
    // Swapped after it was classed: what runs is still what was classed.
    std::fs::write(root.join("job.py"), "print('swapped in')\n")?;
    let ran = python.run(&key, arguments).await;
    assert!(
        ran.content.contains("the reviewed script"),
        "{}",
        ran.content
    );
    assert!(!ran.content.contains("swapped in"), "{}", ran.content);
    Ok(())
}

#[tokio::test]
async fn a_long_script_carries_on_as_a_background_job() -> Result {
    if !python_here() {
        return Ok(());
    }
    let options = Options {
        limits: spade_server::engine::Limits {
            foreground: Duration::from_millis(300),
            ..Default::default()
        },
        ..Default::default()
    };
    let Some(world) = world(
        vec![
            Script::reply("").call(
                "p1",
                "python",
                json!({ "code": "import time\ntime.sleep(3)\nprint('crunched')",
                        "timeout_s": 600 }),
            ),
            Script::reply("It runs in the background."),
            Script::reply("").plain(r#"{"title":"Crunch"}"#),
            Script::reply("Crunched."),
        ],
        options,
    )
    .await?
    else {
        return Ok(());
    };
    world.spade.say(&world.conversation, "Crunch it").await?;
    let events = world
        .spade
        .wait_for(&world.conversation, "reply_finished")
        .await?;
    let answered = content(&events, "p1")?;
    assert!(answered.contains("background as job p1"), "{answered}");
    let events = world
        .spade
        .wait_for_count(&world.conversation, "reply_finished", 2)
        .await?;
    let result = events
        .iter()
        .find(|e| e["type"] == "job_finished")
        .and_then(|e| e["content"].as_str())
        .unwrap_or_default();
    assert!(
        result.contains("Exit code 0.") && result.contains("crunched"),
        "{result}"
    );
    Ok(())
}

#[tokio::test]
async fn with_no_python_on_the_machine_the_run_says_so_plainly() -> Result {
    let nowhere = setup_in(&["/nonexistent/spade-test"]);
    let Some(world) = world(
        vec![
            Script::reply("").call("p1", "python", json!({ "code": "print(1)" })),
            Script::reply("There is no Python here."),
        ],
        Options {
            python: Some(nowhere),
            ..Options::default()
        },
    )
    .await?
    else {
        return Ok(());
    };
    world.spade.say(&world.conversation, "Count").await?;
    let events = world
        .spade
        .wait_for(&world.conversation, "reply_finished")
        .await?;
    let ran = finished(&events, "p1")?;
    assert_eq!(ran["is_error"], true, "{ran}");
    let text = content(&events, "p1")?;
    assert!(text.starts_with("Exit code 127."), "{text}");
    assert!(
        text.contains("No Python 3.10 or newer was found on this machine (looked for uv and python3 in /nonexistent/spade-test)"),
        "{text}"
    );
    Ok(())
}

#[tokio::test]
async fn without_the_sandbox_python_is_refused_before_anything_runs() -> Result {
    let world = world_with_options(
        Options {
            python: Some(setup()),
            ..Options::default()
        },
        false,
        |_| {
            vec![
                Script::reply("").call(
                    "p1",
                    "python",
                    json!({ "code": "open('ran.txt', 'w').write('x')" }),
                ),
                Script::reply("Not here."),
            ]
        },
    )
    .await?;
    world.spade.say(&world.conversation, "Run it").await?;
    let events = world
        .spade
        .wait_for(&world.conversation, "reply_finished")
        .await?;
    let text = content(&events, "p1")?;
    assert!(
        text.starts_with("Not run: the python tool runs only inside Spade's sandbox"),
        "{text}"
    );
    let root = world.workspaces.of(&world.bot)?.path()?;
    assert!(!root.join("ran.txt").exists());
    assert!(!root.join(".spade/python").exists(), "nothing was written");
    assert!(
        !world.workspaces.python_runtime(&world.bot)?.exists(),
        "no runtime was made"
    );
    Ok(())
}
