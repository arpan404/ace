//! The `python` tool (ADR 0220) through the real server and the machine's sandbox, with a real
//! interpreter: a script's files are named and its images attached, the bot's environment is
//! made once, a long script carries on as a background job, and a machine with no Python or no
//! sandbox says so plainly.
//!
//! The tests that run Python need Python 3.10 or newer (or uv) in `/opt/homebrew/bin`,
//! `/usr/local/bin` or `/usr/bin`, and the sandbox; without them they say so and pass.
#![cfg(any(target_os = "macos", all(target_os = "linux", feature = "landlock")))]

mod support;

use std::path::PathBuf;
use std::time::Duration;

use serde_json::{Value, json};
use spade_server::workspace::python::Setup;
use spade_testkit::Script;
use support::sandbox::{World, world_in_with_options, world_with_options};
use support::{Options, Result};

/// Where the tests look for Python: the system folders, no download, nothing to install (the
/// default packages need the network).
fn setup() -> Setup {
    Setup {
        folders: ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]
            .iter()
            .map(PathBuf::from)
            .collect(),
        pinned: None,
        packages: Vec::new(),
    }
}

/// Whether this machine has a Python the tool can use, checked as the launcher does.
fn python_here() -> bool {
    let setup = setup();
    let found = setup.folders.iter().any(|folder| {
        folder.join("uv").exists()
            || [
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
                    .args(["-c", "import sys; sys.exit(sys.version_info < (3, 10))"])
                    .status()
                    .is_ok_and(|status| status.success())
            })
    });
    if !found {
        eprintln!("skipped: no Python 3.10 or newer (or uv) on this machine");
    }
    found
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
    assert!(text.starts_with("Exit code 0.\n"), "{text}");
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
async fn the_bots_environment_is_made_on_first_use_and_reused_after() -> Result {
    if !python_here() {
        return Ok(());
    }
    let Some(world) = world(
        vec![
            Script::reply("").call(
                "p1",
                "python",
                json!({ "code": "import sys; print(sys.prefix)" }),
            ),
            Script::reply("").call(
                "p2",
                "python",
                json!({ "path": "tools/hello.py", "args": ["it's", "me"] }),
            ),
            Script::reply("Done."),
        ],
        Options::default(),
    )
    .await?
    else {
        return Ok(());
    };
    let root = world.workspaces.of(&world.bot)?.path()?;
    let venv = root.join(".spade/python/venv");
    assert!(!venv.exists(), "made before first use");
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
    assert!(first.contains(".spade/python/venv"), "{first}");
    let second = content(&events, "p2")?;
    assert!(!second.contains("Set up Python"), "made twice: {second}");
    assert!(second.contains("it's me"), "{second}");
    assert!(venv.join("pyvenv.cfg").exists());
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
    let nowhere = Setup {
        folders: vec![PathBuf::from("/nonexistent/spade-test")],
        pinned: None,
        packages: Vec::new(),
    };
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
    Ok(())
}
