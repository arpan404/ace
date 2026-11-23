//! The `python` tool (ADR 0220) through the real server and the machine's sandbox, with a real
//! interpreter: a script's files are named and its images attached; the machine's environment is
//! built once by Spade from its lock, shared by every bot, rebuilt only for a new lock, never
//! deleted under a running script and never changed by a bot; the bytes classed are the bytes
//! run; a long script carries on as a background job; and a machine with no Python or no sandbox
//! says so plainly.
//!
//! The tests that run Python need Python 3.10 or newer (or uv) in `/opt/homebrew/bin`,
//! `/usr/local/bin` or `/usr/bin`, and the sandbox; the ones that install packages need uv.
//! Without them they say so and pass. Packages come from wheels the tests build, never the
//! network.
#![cfg(any(target_os = "macos", all(target_os = "linux", feature = "landlock")))]

mod support;

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{Value, json};
use spade_server::tools::Tool;
use spade_server::workspace::python::{Index, Setup};
use spade_server::workspace::workspace_tools_with;
use spade_testkit::Script;
use support::sandbox::{World, world_in_with_options, world_with_options};
use support::{Options, Result};

/// The system folders the tests look in.
const SYSTEM: &[&str] = &["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];

/// A test's wheels: name, version, its module's source, and other files at the wheel's top.
struct Wheel<'a> {
    name: &'a str,
    version: &'a str,
    source: &'a str,
    extra: &'a [(&'a str, &'a str)],
}

const CHECK: Wheel<'static> = Wheel {
    name: "spadecheck",
    version: "1.0",
    source: "VALUE = 42\n",
    extra: &[],
};

/// A set-up that looks for Python in `folders` and installs exactly `wheels` from a folder of
/// them, locked by their hashes.
fn locked_in(folders: &[&str], wheels: &[Wheel<'_>]) -> Result<Setup> {
    let dir = tempfile::tempdir()?.keep();
    let mut lock = String::new();
    for wheel in wheels {
        let bytes = wheel_with(wheel.name, wheel.version, wheel.source, wheel.extra)?;
        std::fs::write(
            dir.join(format!("{}-{}-py3-none-any.whl", wheel.name, wheel.version)),
            &bytes,
        )?;
        lock.push_str(&format!(
            "{}=={} \\\n    --hash=sha256:{}\n",
            wheel.name,
            wheel.version,
            spade_server::workspace::trust::hash(&bytes)
        ));
    }
    Ok(Setup {
        folders: folders.iter().map(PathBuf::from).collect(),
        pinned: None,
        lock,
        wanted: wheels.iter().map(|w| w.name.to_owned()).collect(),
        index: Index::Folder(dir),
        env: Vec::new(),
    })
}

fn setup() -> Setup {
    locked_in(SYSTEM, &[CHECK]).unwrap_or_else(|e| panic!("{e}"))
}

/// Whether `folder` holds a Python 3.10 or newer.
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

/// Whether this machine has uv where Spade looks (the tests that install packages need it).
fn uv_here() -> bool {
    let found = SYSTEM
        .iter()
        .any(|folder| Path::new(folder).join("uv").is_file());
    if !found {
        eprintln!("skipped: no uv on this machine");
    }
    found
}

/// Whether this machine has a Python the tool can use with packages: uv, and a Python.
fn python_here() -> bool {
    uv_here() && SYSTEM.iter().any(|folder| python_in(Path::new(folder)))
}

/// A folder the tests can read that has a Python 3.10 or newer and no uv, for the path without
/// uv.
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

/// A pure-Python wheel of `name` `version` whose module holds `source`, with `extra` files at
/// the wheel's top (a `.pth` hook, say).
fn wheel_with(name: &str, version: &str, source: &str, extra: &[(&str, &str)]) -> Result<Vec<u8>> {
    let info = format!("{name}-{version}.dist-info");
    let module = format!("{name}/__init__.py");
    let metadata = format!("Metadata-Version: 2.1\nName: {name}\nVersion: {version}\n");
    let record = format!("{module},,\n{info}/METADATA,,\n{info}/WHEEL,,\n{info}/RECORD,,\n");
    let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default();
    let mut files = vec![
        (module.clone(), source.to_owned()),
        (format!("{info}/METADATA"), metadata),
        (
            format!("{info}/WHEEL"),
            "Wheel-Version: 1.0\nGenerator: spade-test\nRoot-Is-Purelib: true\nTag: py3-none-any\n"
                .to_owned(),
        ),
        (format!("{info}/RECORD"), record),
    ];
    files.extend(
        extra
            .iter()
            .map(|(name, text)| ((*name).to_owned(), (*text).to_owned())),
    );
    for (name, text) in files {
        writer.start_file(name, options)?;
        writer.write_all(text.as_bytes())?;
    }
    Ok(writer.finish()?.into_inner())
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

/// The world's `python` tool built with `setup`, called directly (as the gate does: classed,
/// then run) for `conversation`'s call `call`.
struct Direct {
    tool: std::sync::Arc<dyn Tool>,
}

impl Direct {
    fn new(world: &World, setup: Setup) -> Result<Self> {
        let tools = workspace_tools_with(
            world.workspaces.clone(),
            world.bots.clone(),
            world.shell.clone(),
            setup,
        );
        let tool = tools
            .into_iter()
            .find(|tool| tool.def().spec.name == "python")
            .ok_or("no python tool")?;
        Ok(Self { tool })
    }

    async fn call(
        &self,
        conversation: &str,
        call: &str,
        arguments: Value,
    ) -> spade_server::tools::ToolOutput {
        let key = format!("{conversation}.{call}");
        let _ = self.tool.classed(&key, &arguments);
        self.tool.run(&key, arguments).await
    }
}

/// The machine's shared Python folder in `world`.
fn shared(world: &World) -> PathBuf {
    world.workspaces.root().join(".python/shared")
}

/// The environment recorded as current.
fn current(world: &World) -> Option<String> {
    let bytes = std::fs::read(shared(world).join("current.json")).ok()?;
    let value: Value = serde_json::from_slice(&bytes).ok()?;
    value["environment"].as_str().map(str::to_owned)
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
        text.starts_with("[Set up Python for Spade's bots: ") && text.contains("\nExit code 0.\n"),
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
async fn the_environment_is_built_once_by_spade_and_a_second_bot_reuses_it() -> Result {
    if !python_here() {
        return Ok(());
    }
    let Some(world) = world(Vec::new(), Options::default()).await? else {
        return Ok(());
    };
    let python = Direct::new(&world, setup())?;
    let second = world.spade.new_agent("Second", "").await?;
    let other = second["conversation"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let read = json!({ "code": "import spadecheck; print('value', spadecheck.VALUE, spadecheck.__file__)" });
    let first = python.call(&world.conversation, "p1", read.clone()).await;
    assert!(!first.is_error, "{}", first.content);
    assert!(
        first
            .content
            .contains("[Set up Python for Spade's bots: 3."),
        "{}",
        first.content
    );
    assert!(first.content.contains("value 42"), "{}", first.content);
    let again = python.call(&other, "p2", read).await;
    assert!(!again.is_error, "{}", again.content);
    assert!(
        !again.content.contains("Set up Python"),
        "built twice: {}",
        again.content
    );
    let prefix = |text: &str| {
        text.split("value 42 ")
            .nth(1)
            .map(|rest| rest.lines().next().unwrap_or("").to_owned())
    };
    assert_eq!(
        prefix(&first.content),
        prefix(&again.content),
        "not the same environment"
    );
    assert!(prefix(&first.content).is_some_and(|p| p.contains("/.python/shared/environments/")));
    Ok(())
}

#[tokio::test]
async fn a_new_lock_builds_a_new_environment_and_the_old_one_outlives_a_script_running_on_it()
-> Result {
    if !python_here() {
        return Ok(());
    }
    let Some(world) = world(Vec::new(), Options::default()).await? else {
        return Ok(());
    };
    let first = Wheel {
        extra: &[("spadecheck/later.py", "SAID = 'still here'\n")],
        ..CHECK
    };
    let newer = Wheel {
        version: "2.0",
        source: "VALUE = 43\n",
        ..CHECK
    };
    let old = std::sync::Arc::new(Direct::new(&world, locked_in(SYSTEM, &[first])?)?);
    let new = Direct::new(&world, locked_in(SYSTEM, &[newer])?)?;
    // Imports part of its package only after the switch, so it fails if the old one is gone.
    let slow = json!({ "code": "import time, spadecheck\ntime.sleep(4)\nimport spadecheck.later as later\nprint('value', spadecheck.VALUE, later.SAID)", "timeout_s": 60 });
    let running = {
        let (old, conversation) = (old.clone(), world.conversation.clone());
        tokio::spawn(async move { old.call(&conversation, "p1", slow).await })
    };
    // Until the slow script has the first environment, then a new lock.
    let started = std::time::Instant::now();
    while current(&world).is_none() && started.elapsed() < Duration::from_secs(60) {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let before = current(&world).ok_or("the first environment was never recorded")?;
    tokio::time::sleep(Duration::from_millis(500)).await;
    let switched = new
        .call(
            &world.conversation,
            "p2",
            json!({ "code": "import spadecheck; print('value', spadecheck.VALUE)" }),
        )
        .await;
    assert!(
        switched.content.contains("value 43"),
        "{}",
        switched.content
    );
    let after = current(&world).ok_or("no current environment")?;
    assert_ne!(before, after);
    assert!(
        shared(&world).join("environments").join(&before).exists(),
        "deleted under a running script"
    );
    let ran = running.await?;
    assert!(
        ran.content.contains("value 42 still here"),
        "{}",
        ran.content
    );
    // Once nothing holds it, the next switch deletes it.
    let back = old
        .call(
            &world.conversation,
            "p3",
            json!({ "code": "print('back')" }),
        )
        .await;
    assert!(back.content.contains("back"), "{}", back.content);
    assert!(!shared(&world).join("environments").join(&after).exists());
    Ok(())
}

#[cfg(unix)]
#[tokio::test]
async fn a_switch_whose_record_cant_be_written_leaves_the_old_environment_current_and_whole()
-> Result {
    use std::os::unix::fs::PermissionsExt;
    if !python_here() {
        return Ok(());
    }
    let Some(world) = world(Vec::new(), Options::default()).await? else {
        return Ok(());
    };
    let old = Direct::new(&world, setup())?;
    let new = Direct::new(
        &world,
        locked_in(
            SYSTEM,
            &[Wheel {
                version: "2.0",
                source: "VALUE = 43\n",
                ..CHECK
            }],
        )?,
    )?;
    let read = json!({ "code": "import spadecheck; print('value', spadecheck.VALUE)" });
    assert!(
        old.call(&world.conversation, "p1", read.clone())
            .await
            .content
            .contains("value 42")
    );
    let before = current(&world).ok_or("no current environment")?;
    // The shared folder refuses new files: the record can't be replaced.
    let folder = shared(&world);
    std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o555))?;
    let refused = new.call(&world.conversation, "p2", read.clone()).await;
    std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o755))?;
    assert!(refused.is_error, "{}", refused.content);
    assert!(
        refused.content.contains("couldn't record its Python"),
        "{}",
        refused.content
    );
    assert!(!refused.content.contains("value"), "{}", refused.content);
    assert_eq!(current(&world).as_deref(), Some(before.as_str()));
    let still = old.call(&world.conversation, "p3", read).await;
    assert!(
        still.content.contains("value 42") && !still.content.contains("Set up"),
        "{}",
        still.content
    );
    Ok(())
}

#[tokio::test]
async fn a_locked_package_with_a_start_up_hook_is_refused_and_nothing_is_published() -> Result {
    if !python_here() {
        return Ok(());
    }
    let Some(world) = world(Vec::new(), Options::default()).await? else {
        return Ok(());
    };
    let hooked = Wheel {
        name: "spadehook",
        version: "1.0",
        source: "",
        extra: &[("spadehook.pth", "import os; os.system('echo HOOK')\n")],
    };
    let python = Direct::new(&world, locked_in(SYSTEM, &[hooked])?)?;
    let ran = python
        .call(
            &world.conversation,
            "p1",
            json!({ "code": "open('ran.txt', 'w').write('x')" }),
        )
        .await;
    assert!(ran.is_error, "{}", ran.content);
    assert!(
        ran.content
            .contains("installs spadehook.pth, a start-up hook"),
        "{}",
        ran.content
    );
    assert!(current(&world).is_none());
    let root = world.workspaces.of(&world.bot)?.path()?;
    assert!(!root.join("ran.txt").exists());
    Ok(())
}

#[tokio::test]
async fn without_uv_python_has_its_standard_library_only_and_says_so() -> Result {
    let Some(folder) = python_without_uv() else {
        return Ok(());
    };
    let Some(world) = world(
        vec![
            Script::reply("").call(
                "p1",
                "python",
                json!({ "code": "import json, sys; print('stdlib', json.dumps([sys.prefix != sys.base_prefix]))" }),
            ),
            Script::reply("").call("p2", "python", json!({ "code": "import spadecheck" })),
            Script::reply("Done."),
        ],
        Options {
            python: Some(locked_in(&[folder], &[CHECK])?),
            ..Options::default()
        },
    )
    .await?
    else {
        return Ok(());
    };
    world.spade.say(&world.conversation, "Run it").await?;
    let events = world
        .spade
        .wait_for(&world.conversation, "reply_finished")
        .await?;
    let text = content(&events, "p1")?;
    assert_eq!(finished(&events, "p1")?["is_error"], false, "{text}");
    assert!(text.contains("stdlib [true]"), "{text}");
    assert!(
        text.contains("with its standard library only: uv isn't on this machine"),
        "{text}"
    );
    let missing = content(&events, "p2")?;
    assert!(missing.contains("ModuleNotFoundError"), "{missing}");
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
                json!({ "command": "RUNTIME=\"$(dirname \"$HOME\")/.python\"; \
                                    ls \"$RUNTIME\"/shared/environments/*/bin >/dev/null && echo listed; \
                                    echo 'echo planted' > \"$RUNTIME/shared/control/run.sh\"; \
                                    for p in \"$RUNTIME\"/shared/environments/*/bin/python; do printf '#!/bin/sh\\necho planted\\n' > \"$p\"; done; \
                                    mv \"$RUNTIME/bots/$(basename \"$HOME\")/scripts\" \"$RUNTIME/moved\"; \
                                    ln -s /tmp \"$RUNTIME/bots/$(basename \"$HOME\")/scripts\"; \
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
    let runtime = world.workspaces.root().join(".python");
    world
        .spade
        .say(&world.conversation, "Run, then try to change it")
        .await?;
    let events = world
        .spade
        .wait_for(&world.conversation, "reply_finished")
        .await?;
    assert!(content(&events, "p1")?.contains("first"));
    let launcher = std::fs::read_to_string(runtime.join("shared/control/run.sh"))?;
    assert!(
        !runtime.join("moved").exists(),
        "the bot moved Spade's staged scripts"
    );
    let scripts = world.workspaces.python_runtime(&world.bot)?.join("scripts");
    assert!(
        std::fs::symlink_metadata(&scripts)?.is_dir(),
        "the bot swapped the staging folder"
    );
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
    // The modules Spade's file tools wrote from a clean prompt are the trusted ones.
    let workspace = world.workspaces.of(&world.bot)?;
    for trusted in ["tools/helper.py", "rooted.py"] {
        let bytes = std::fs::read(root.join(trusted))?;
        workspace.trust().record_write(trusted, &bytes, None);
    }
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
async fn a_workspace_module_spade_did_not_write_cleanly_is_never_imported() -> Result {
    if !python_here() {
        return Ok(());
    }
    let Some(world) = world(
        vec![
            Script::reply("")
                .call("p1", "python", json!({ "code": "import sneaky" }))
                // Not installed here: a same-named workspace file never stands in for it.
                .call("p2", "python", json!({ "code": "import pandas" })),
            Script::reply("Done."),
        ],
        Options::default(),
    )
    .await?
    else {
        return Ok(());
    };
    let root = world.workspaces.of(&world.bot)?.path()?;
    // Written by a command (or after reading a page): no trust record, or a stale one.
    std::fs::write(root.join("sneaky.py"), "print('SNEAKY RAN')\n")?;
    std::fs::write(root.join("pandas.py"), "print('FAKE PANDAS RAN')\n")?;
    let workspace = world.workspaces.of(&world.bot)?;
    workspace
        .trust()
        .record_write("pandas.py", b"something else", None);
    world.spade.say(&world.conversation, "Import them").await?;
    let events = world
        .spade
        .wait_for(&world.conversation, "reply_finished")
        .await?;
    for (call, module) in [("p1", "sneaky"), ("p2", "pandas")] {
        let text = content(&events, call)?;
        assert_eq!(finished(&events, call)?["is_error"], true, "{text}");
        assert!(
            text.contains(&format!(
                "ImportError: {module} is a module in your workspace, but Spade imports only"
            )),
            "{text}"
        );
        assert!(!text.contains("RAN"), "{text}");
    }
    Ok(())
}

#[tokio::test]
async fn a_call_runs_only_the_copy_staged_when_it_was_classed_and_never_reads_the_workspace_again()
-> Result {
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
    std::fs::write(root.join("job.py"), "print('ran')\n")?;
    let arguments = json!({ "path": "job.py" });
    // Never classed: nothing staged, so nothing runs.
    let unclassed = python
        .run(&format!("{}.c1", world.conversation), arguments.clone())
        .await;
    assert!(
        unclassed.is_error
            && unclassed
                .content
                .starts_with("Not run: Spade runs only the copy"),
        "{}",
        unclassed.content
    );
    // Classed, then its staged copy changed: refused too, never read again from the workspace.
    let key = format!("{}.c2", world.conversation);
    let _ = python.classed(&key, &arguments);
    let scripts = world.workspaces.python_runtime(&world.bot)?.join("scripts");
    for entry in std::fs::read_dir(&scripts)? {
        let path = entry?.path();
        if path.extension().is_some_and(|e| e == "py") {
            std::fs::write(&path, "print('altered')\n")?;
        }
    }
    let altered = python.run(&key, arguments).await;
    assert!(
        altered.is_error
            && altered
                .content
                .starts_with("Not run: Spade runs only the copy"),
        "{}",
        altered.content
    );
    assert!(!altered.content.contains("altered") || altered.content.starts_with("Not run"));
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
    let nowhere = locked_in(&["/nonexistent/spade-test"], &[CHECK])?;
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
    assert!(
        text.starts_with("Python could not be set up: No Python"),
        "{text}"
    );
    assert!(text.ends_with("[The script was not run.]"), "{text}");
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
        !world.workspaces.python_runtime(&world.bot)?.exists()
            && !world
                .workspaces
                .root()
                .join(".python/shared/environments")
                .exists(),
        "no Python was staged or built"
    );
    Ok(())
}

/// A program that marks it ran and fails.
fn planted(path: &Path, marker: &Path) -> Result {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(path.parent().ok_or("no folder")?)?;
    std::fs::write(
        path,
        format!("#!/bin/sh\ntouch '{}'\nexit 1\n", marker.display()),
    )?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))?;
    Ok(())
}

#[cfg(unix)]
#[tokio::test]
async fn a_program_a_bot_could_have_put_or_changed_is_never_run_on_the_host() -> Result {
    let Some(world) = world(Vec::new(), Options::default()).await? else {
        return Ok(());
    };
    let root = world.workspaces.of(&world.bot)?.path()?;
    let markers = tempfile::tempdir()?;
    // One in the bot's own workspace, one in a folder it was granted to write.
    let in_workspace = root.join("tools");
    planted(&in_workspace.join("uv"), &markers.path().join("uv-ran"))?;
    let granted = tempfile::tempdir()?;
    planted(
        &granted.path().join("python3"),
        &markers.path().join("python-ran"),
    )?;
    world.security.add_grant(
        &world.bot,
        spade_core::grant::Scope::Folder {
            path: granted.path().to_string_lossy().into_owned(),
            write: true,
        },
        "test",
    )?;
    let folders = [
        in_workspace.to_string_lossy().into_owned(),
        granted.path().to_string_lossy().into_owned(),
    ];
    let folders: Vec<&str> = folders.iter().map(String::as_str).collect();
    let python = Direct::new(&world, locked_in(&folders, &[CHECK])?)?;
    let ran = python
        .call(&world.conversation, "p1", json!({ "code": "print(1)" }))
        .await;
    assert!(ran.is_error, "{}", ran.content);
    assert!(ran.content.contains("Spade didn't use"), "{}", ran.content);
    assert!(
        ran.content.contains("a folder a bot may write"),
        "{}",
        ran.content
    );
    assert!(
        !markers.path().join("uv-ran").exists(),
        "the bot's uv ran on the host"
    );
    assert!(
        !markers.path().join("python-ran").exists(),
        "the bot's python3 ran on the host"
    );
    Ok(())
}

#[tokio::test]
async fn what_the_reviewer_is_shown_and_what_an_answer_binds_are_one_snapshot() -> Result {
    if !python_here() {
        return Ok(());
    }
    let Some(world) = world(Vec::new(), Options::default()).await? else {
        return Ok(());
    };
    let python = Direct::new(&world, setup())?;
    let root = world.workspaces.of(&world.bot)?.path()?;
    std::fs::write(root.join("job.py"), "print('as shown')\n")?;
    let key = format!("{}.c1", world.conversation);
    let arguments = json!({ "path": "job.py" });
    let classed = python.tool.classed(&key, &arguments);
    assert_eq!(
        classed.shown.first().map(|s| s.content.as_str()),
        Some("print('as shown')\n")
    );
    // The file changes, and the staged copies are let go of before the person is asked.
    std::fs::write(root.join("job.py"), "print('swapped in')\n")?;
    for n in 0..1_000 {
        let other = format!("{}.x{n}", world.conversation);
        let _ = python
            .tool
            .classed(&other, &json!({ "code": format!("print({n})") }));
    }
    let scope = python
        .tool
        .always_scope_in(&key, &arguments)
        .unwrap_or_default();
    let swapped = spade_server::workspace::trust::hash(b"print('swapped in')\n");
    assert!(
        !scope.contains(&swapped),
        "the answer would bind bytes nobody was shown: {scope}"
    );
    assert!(scope.ends_with("[staged ]"), "{scope}");
    Ok(())
}

#[tokio::test]
async fn a_stopped_run_in_the_terminal_keeps_its_environment_until_its_processes_are_gone() -> Result
{
    if !python_here() {
        return Ok(());
    }
    let Some(world) = world_in(
        true,
        vec![
            Script::reply("").call(
                "p1",
                "python",
                json!({ "code": "import time\ntime.sleep(60)", "timeout_s": 120 }),
            ),
            Script::reply("Stopped."),
        ],
        Options {
            shell_end_delay: Some(Duration::from_millis(2_500)),
            ..Options::default()
        },
    )
    .await?
    else {
        return Ok(());
    };
    world
        .spade
        .say(&world.conversation, "Wait a minute")
        .await?;
    // Until the script is running on its environment.
    let held = |world: &World| -> Option<bool> {
        let environment = current(world)?;
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(
                shared(world)
                    .join("leases")
                    .join(format!("{environment}.lock")),
            )
            .ok()?;
        let held = file.try_lock().is_err();
        Some(held)
    };
    let started = std::time::Instant::now();
    while held(&world) != Some(true) && started.elapsed() < Duration::from_secs(60) {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(
        held(&world),
        Some(true),
        "the run never held its environment"
    );
    // While it is stopped, look every 50 ms at whether the environment is held and whether the
    // script's processes are still there.
    let mark = shared(&world)
        .join("control/boot.py")
        .to_string_lossy()
        .into_owned();
    let lease = {
        let environment = current(&world).ok_or("no environment")?;
        shared(&world)
            .join("leases")
            .join(format!("{environment}.lock"))
    };
    let looking = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
    let sampler = {
        let (looking, mark, lease) = (looking.clone(), mark.clone(), lease.clone());
        std::thread::spawn(move || {
            let mut samples = Vec::new();
            while looking.load(std::sync::atomic::Ordering::SeqCst) {
                let alive = std::process::Command::new("pgrep")
                    .args(["-f", &mark])
                    .output()
                    .is_ok_and(|o| !o.stdout.is_empty());
                let held = std::fs::OpenOptions::new()
                    .read(true)
                    .write(true)
                    .open(&lease)
                    .is_ok_and(|file| file.try_lock().is_err());
                samples.push((held, alive));
                std::thread::sleep(Duration::from_millis(50));
            }
            samples
        })
    };
    let (status, _) = world
        .spade
        .post(
            &format!("/v1/conversations/{}/stop", world.conversation),
            json!({}),
        )
        .await?;
    assert!(status < 300);
    let started = std::time::Instant::now();
    while held(&world) == Some(true) && started.elapsed() < Duration::from_secs(30) {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    looking.store(false, std::sync::atomic::Ordering::SeqCst);
    let samples = sampler.join().map_err(|_| "the sampler panicked")?;
    assert!(
        !samples.iter().any(|(held, alive)| !held && *alive),
        "the environment was let go while the script's processes were still there: {samples:?}"
    );
    assert!(
        samples.iter().any(|(held, alive)| *held && *alive),
        "the processes' end was never seen: {samples:?}"
    );
    assert_eq!(held(&world), Some(false), "never let go");
    Ok(())
}
