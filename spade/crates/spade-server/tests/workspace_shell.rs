//! The workspace shell with real child processes (ADR 0130): what asks and what runs at once,
//! the deadline that kills the whole process group, the clean environment, and large output kept
//! as a file. Process tests: each starts real shells.

mod support;

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use spade_server::tools::{EngineHandle, Tool};
use spade_server::workspace::shell::Shell;
use spade_server::workspace::{Workspaces, workspace_tools};
use spade_testkit::Script;
use support::{Result, Spade, types};

/// The command for this system: `unix` for `/bin/sh`, `windows` for `cmd.exe`.
fn on_this_system(unix: &'static str, windows: &'static str) -> &'static str {
    if cfg!(windows) { windows } else { unix }
}

async fn start(scripts: Vec<Script>, workspaces: &Workspaces) -> Result<Spade> {
    let bots = EngineHandle::default();
    let tools: Vec<Arc<dyn Tool>> =
        workspace_tools(workspaces.clone(), bots.clone(), Shell::system());
    let spade = Spade::start(scripts, tools).await?;
    bots.set(&spade.engine);
    Ok(spade)
}

async fn bot(spade: &Spade) -> Result<(String, String)> {
    let agent = spade.new_agent("Runner", "").await?;
    let field = |name: &str| agent[name].as_str().unwrap_or_default().to_owned();
    Ok((field("id"), field("conversation")))
}

fn finished<'a>(events: &'a [Value], call: &str) -> Option<&'a Value> {
    events
        .iter()
        .find(|e| e["type"] == "tool_finished" && e["call_id"] == call)
}

/// Answers approval `call` in `conversation`.
async fn answer(spade: &Spade, conversation: &str, call: &str, body: Value) -> Result {
    let (status, _) = spade
        .post(
            &format!("/v1/conversations/{conversation}/approvals/{call}"),
            body,
        )
        .await?;
    assert_eq!(status, 202);
    Ok(())
}

fn asked(events: &[Value]) -> Vec<String> {
    events
        .iter()
        .filter(|e| e["type"] == "approval_requested")
        .map(|e| e["call_id"].as_str().unwrap_or_default().to_owned())
        .collect()
}

#[tokio::test]
async fn every_command_asks_first_even_one_that_only_reads() -> Result {
    let dir = tempfile::tempdir()?;
    let workspaces = Workspaces::new(dir.path());
    let spade = start(
        vec![
            Script::reply("").call(
                "c1",
                "shell",
                json!({ "command": on_this_system("ls -a", "dir /a") }),
            ),
            Script::reply("Okay, I won't."),
        ],
        &workspaces,
    )
    .await?;
    let (_, conversation) = bot(&spade).await?;
    spade.say(&conversation, "Look around").await?;
    let events = spade.wait_for(&conversation, "approval_requested").await?;
    assert_eq!(asked(&events), vec!["c1"]);
    assert!(
        finished(&events, "c1").is_none(),
        "nothing ran before the answer"
    );
    answer(&spade, &conversation, "c1", json!({ "allowed": false })).await?;
    spade.wait_for(&conversation, "reply_finished").await?;
    Ok(())
}

#[tokio::test]
async fn always_allows_that_exact_command_and_no_other() -> Result {
    let dir = tempfile::tempdir()?;
    let workspaces = Workspaces::new(dir.path());
    let spade = start(
        vec![
            Script::reply("").call(
                "c1",
                "shell",
                json!({ "command": on_this_system("touch one.txt", "type nul > one.txt") }),
            ),
            Script::reply("Made it."),
            // The title, asked for after the first turn.
            Script::reply("").plain(r#"{"title":"Files"}"#),
            // A later turn: the same command runs at once; another command asks.
            Script::reply("").call(
                "c2",
                "shell",
                json!({ "command": on_this_system("touch one.txt", "type nul > one.txt") }),
            ),
            Script::reply("Again."),
            Script::reply("").call(
                "c3",
                "shell",
                json!({ "command": on_this_system("touch two.txt", "type nul > two.txt") }),
            ),
            Script::reply("Okay."),
        ],
        &workspaces,
    )
    .await?;
    let (bot_id, conversation) = bot(&spade).await?;
    spade.say(&conversation, "Make a file").await?;
    spade.wait_for(&conversation, "approval_requested").await?;
    answer(
        &spade,
        &conversation,
        "c1",
        json!({ "allowed": true, "always": true }),
    )
    .await?;
    spade.wait_for(&conversation, "renamed").await?;

    spade.say(&conversation, "Make it again").await?;
    let events = spade
        .wait_for_count(&conversation, "reply_finished", 2)
        .await?;
    assert_eq!(asked(&events), vec!["c1"], "{:?}", types(&events));
    assert_eq!(
        finished(&events, "c2").map(|e| e["is_error"].clone()),
        Some(json!(false))
    );

    spade.say(&conversation, "Make another").await?;
    let events = spade
        .wait_for_count(&conversation, "approval_requested", 2)
        .await?;
    assert_eq!(asked(&events), vec!["c1", "c3"]);
    answer(&spade, &conversation, "c3", json!({ "allowed": false })).await?;
    spade
        .wait_for_count(&conversation, "reply_finished", 3)
        .await?;
    let root = workspaces.of(&bot_id)?.path()?;
    assert!(root.join("one.txt").exists());
    assert!(
        !root.join("two.txt").exists(),
        "a declined command never runs"
    );
    Ok(())
}

#[cfg(unix)]
#[tokio::test]
async fn a_program_the_bot_planted_in_its_folder_is_never_found_by_name() -> Result {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir()?;
    std::fs::create_dir_all(dir.path().join("bin"))?;
    for planted in [dir.path().join("ls"), dir.path().join("bin/ls")] {
        std::fs::write(&planted, "#!/bin/sh\necho planted\n")?;
        std::fs::set_permissions(&planted, std::fs::Permissions::from_mode(0o755))?;
    }
    // Spade's own PATH, as a careless setup might have it: the current folder, an empty entry
    // and a folder inside the workspace.
    let workspace_bin = dir.path().join("bin").to_string_lossy().into_owned();
    let env: spade_server::workspace::shell::Env = Arc::new(move |name: &str| {
        (name == "PATH").then(|| format!(".:{workspace_bin}::/usr/bin:/bin"))
    });
    let shell = Shell::new(env);
    let path = shell
        .environment(dir.path())
        .into_iter()
        .find(|(name, _)| name == "PATH")
        .map(|(_, value)| value)
        .unwrap_or_default();
    for part in path.split(':') {
        assert!(part.starts_with('/'), "{path}");
        assert!(!part.starts_with(&*dir.path().to_string_lossy()), "{path}");
    }
    let ran = shell.run(dir.path(), "ls", Duration::from_secs(10)).await?;
    assert!(!ran.stdout.contains("planted"), "{ran:?}");
    assert!(ran.stdout.contains("bin"), "{ran:?}");
    Ok(())
}

#[cfg(unix)]
#[tokio::test]
async fn output_read_before_a_lingering_process_is_kept() -> Result {
    let dir = tempfile::tempdir()?;
    // A process that leaves the group keeps stdout open past the command's end.
    let ran = Shell::system()
        .run(
            dir.path(),
            "echo first; perl -e 'setpgrp(0,0); print STDERR $$, \"\\n\"; sleep 30' 2> escaped.pid & sleep 1",
            Duration::from_secs(10),
        )
        .await?;
    let escaped = std::fs::read_to_string(dir.path().join("escaped.pid")).unwrap_or_default();
    let _ = std::process::Command::new("/bin/kill")
        .args(["-KILL", escaped.trim()])
        .status();
    assert!(ran.stdout.contains("first"), "{ran:?}");
    assert!(ran.cut, "the run says some output may be missing");
    Ok(())
}

/// Whether process `pid` is still running (a zombie waiting to be reaped counts as gone).
#[cfg(unix)]
fn alive(pid: &str) -> bool {
    std::process::Command::new("ps")
        .args(["-o", "stat=", "-p", pid])
        .output()
        .map(|out| {
            let stat = String::from_utf8_lossy(&out.stdout);
            out.status.success() && !stat.trim().is_empty() && !stat.trim().starts_with('Z')
        })
        .unwrap_or(false)
}

#[cfg(unix)]
#[tokio::test]
async fn a_command_past_its_deadline_is_killed_with_everything_it_started() -> Result {
    let dir = tempfile::tempdir()?;
    let started = Instant::now();
    let ran = Shell::system()
        .run(
            dir.path(),
            "sleep 30 & echo $! > child.pid; sleep 30",
            Duration::from_secs(1),
        )
        .await?;
    assert!(ran.timed_out);
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "{:?}",
        started.elapsed()
    );
    let child = std::fs::read_to_string(dir.path().join("child.pid"))?;
    let child = child.trim();
    assert!(!child.is_empty());
    let deadline = Instant::now() + Duration::from_secs(3);
    while alive(child) && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(
        !alive(child),
        "the background child {child} outlived its group"
    );
    Ok(())
}

#[cfg(unix)]
#[tokio::test]
async fn a_finished_command_leaves_nothing_running_in_the_background() -> Result {
    let dir = tempfile::tempdir()?;
    let ran = Shell::system()
        .run(
            dir.path(),
            "sleep 30 > /dev/null 2>&1 & echo $! > child.pid",
            Duration::from_secs(5),
        )
        .await?;
    assert!(!ran.timed_out);
    let child = std::fs::read_to_string(dir.path().join("child.pid"))?;
    let deadline = Instant::now() + Duration::from_secs(3);
    while alive(child.trim()) && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(!alive(child.trim()));
    Ok(())
}

#[tokio::test]
async fn the_shell_environment_carries_none_of_spades_secrets() -> Result {
    let dir = tempfile::tempdir()?;
    // Spade's own environment as the shell would see it: its token, keys and ace's grant.
    let spade_env: spade_server::workspace::shell::Env = Arc::new(|name: &str| match name {
        "PATH" => std::env::var("PATH").ok(),
        "SPADE_TOKEN"
        | "SPADE_ACE_TOKEN"
        | "SPADE_ACE_MCP_TOKEN"
        | "OPENAI_API_KEY"
        | "ANTHROPIC_API_KEY" => Some("secret-value-1234".to_owned()),
        _ => None,
    });
    let command = if cfg!(windows) { "set" } else { "env" };
    let ran = Shell::new(spade_env)
        .run(dir.path(), command, Duration::from_secs(10))
        .await?;
    assert_eq!(ran.code, Some(0), "{ran:?}");
    assert!(!ran.stdout.contains("secret-value-1234"), "{}", ran.stdout);
    for name in ["SPADE_TOKEN", "OPENAI_API_KEY", "CARGO_MANIFEST_DIR"] {
        assert!(
            !ran.stdout.contains(&format!("{name}=")),
            "{name} reached the shell"
        );
    }
    assert!(ran.stdout.contains("HOME="), "{}", ran.stdout);
    Ok(())
}

#[tokio::test]
async fn output_too_large_for_the_model_is_kept_as_a_file_it_can_read() -> Result {
    let dir = tempfile::tempdir()?;
    let workspaces = Workspaces::new(dir.path());
    let spade = start(
        vec![
            Script::reply("").call(
                "c1",
                "shell",
                json!({ "command": on_this_system("cat big.txt", "type big.txt") }),
            ),
            Script::reply("That is long."),
        ],
        &workspaces,
    )
    .await?;
    let (bot_id, conversation) = bot(&spade).await?;
    let root = workspaces.of(&bot_id)?.path()?;
    let big: String = (0..4_000).map(|n| format!("line {n:05}\n")).collect();
    std::fs::write(root.join("big.txt"), &big)?;
    spade.say(&conversation, "Show the big file").await?;
    spade.wait_for(&conversation, "approval_requested").await?;
    answer(&spade, &conversation, "c1", json!({ "allowed": true })).await?;
    let events = spade.wait_for(&conversation, "reply_finished").await?;
    let content = finished(&events, "c1")
        .and_then(|e| e["content"].as_str())
        .unwrap_or_default()
        .to_owned();
    assert!(content.len() < big.len(), "the model got all of it");
    assert!(content.contains("line 00000") && content.contains("line 03999"));
    let kept = content
        .split_whitespace()
        .find(|word| word.starts_with(".spade/outputs/"))
        .map(|word| word.trim_end_matches(';'))
        .ok_or(format!("no path in {content}"))?;
    let stored = std::fs::read_to_string(root.join(kept))?;
    assert!(stored.contains(&big), "the file holds the whole output");
    Ok(())
}

/// Starts `ping` as a grandchild through PowerShell (a separate program, as a bot's command
/// would start one), writing its pid to `child.pid`; then runs `after`.
#[cfg(windows)]
fn windows_grandchild(after: &str) -> String {
    format!(
        "powershell -NoProfile -NonInteractive -Command \"$p = Start-Process -FilePath ping.exe \
         -ArgumentList '-n','60','127.0.0.1' -NoNewWindow -RedirectStandardOutput ping.out \
         -PassThru; Set-Content -Path child.pid -Value $p.Id\"{after}"
    )
}

/// Whether process `pid` is still running.
#[cfg(windows)]
fn alive(pid: &str) -> bool {
    std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
        .output()
        .map(|out| String::from_utf8_lossy(&out.stdout).contains(&format!("\"{pid}\"")))
        .unwrap_or(false)
}

#[cfg(windows)]
async fn gone_soon(pid: &str) -> bool {
    let deadline = Instant::now() + Duration::from_secs(5);
    while alive(pid) && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    !alive(pid)
}

#[cfg(windows)]
#[tokio::test]
async fn a_command_past_its_deadline_is_killed_with_everything_it_started() -> Result {
    let dir = tempfile::tempdir()?;
    let started = Instant::now();
    let ran = Shell::system()
        .run(
            dir.path(),
            &windows_grandchild(" & ping -n 60 127.0.0.1 > nul"),
            Duration::from_secs(10),
        )
        .await?;
    assert!(ran.timed_out, "{ran:?}");
    assert!(
        started.elapsed() < Duration::from_secs(20),
        "{:?}",
        started.elapsed()
    );
    let child = std::fs::read_to_string(dir.path().join("child.pid"))?;
    let child = child.trim();
    assert!(!child.is_empty(), "{ran:?}");
    assert!(
        gone_soon(child).await,
        "the grandchild {child} outlived the run"
    );
    Ok(())
}

#[cfg(windows)]
#[tokio::test]
async fn a_finished_command_leaves_nothing_running_in_the_background() -> Result {
    let dir = tempfile::tempdir()?;
    let ran = Shell::system()
        .run(dir.path(), &windows_grandchild(""), Duration::from_secs(30))
        .await?;
    assert!(!ran.timed_out, "{ran:?}");
    assert_eq!(ran.code, Some(0), "{ran:?}");
    let child = std::fs::read_to_string(dir.path().join("child.pid"))?;
    let child = child.trim();
    assert!(!child.is_empty(), "{ran:?}");
    assert!(
        gone_soon(child).await,
        "the background {child} outlived the run"
    );
    Ok(())
}

#[cfg(windows)]
#[tokio::test]
async fn a_command_that_starts_and_ends_with_quotes_runs_as_written() -> Result {
    let dir = tempfile::tempdir()?;
    let ran = Shell::system()
        .run(
            dir.path(),
            r#""cmd.exe" /D /C echo one "two three""#,
            Duration::from_secs(10),
        )
        .await?;
    assert_eq!(ran.code, Some(0), "{ran:?}");
    assert_eq!(ran.stdout.trim(), r#"one "two three""#, "{ran:?}");
    Ok(())
}

#[cfg(windows)]
#[tokio::test]
async fn a_program_the_bot_planted_in_its_folder_is_never_found_by_name() -> Result {
    let dir = tempfile::tempdir()?;
    std::fs::create_dir_all(dir.path().join("bin"))?;
    for planted in ["hostname.bat", "hostname.cmd", "bin/hostname.bat"] {
        std::fs::write(dir.path().join(planted), "@echo planted\r\n")?;
    }
    // Spade's own PATH, as a careless setup might have it: the current folder, an empty entry
    // and a folder inside the workspace.
    let workspace_bin = dir.path().join("bin").to_string_lossy().into_owned();
    let env: spade_server::workspace::shell::Env = Arc::new(move |name: &str| match name {
        "PATH" => Some(format!(".;{workspace_bin};;C:\\Windows\\System32")),
        _ => std::env::var(name).ok(),
    });
    let shell = Shell::new(env);
    let path = shell
        .environment(dir.path())
        .into_iter()
        .find(|(name, _)| name == "PATH")
        .map(|(_, value)| value)
        .unwrap_or_default();
    for part in path.split(';') {
        assert!(part.as_bytes().get(1..3) == Some(b":\\"), "{path}");
        assert!(!part.starts_with(&*dir.path().to_string_lossy()), "{path}");
    }
    let ran = shell
        .run(dir.path(), "hostname", Duration::from_secs(10))
        .await?;
    assert_eq!(ran.code, Some(0), "{ran:?}");
    assert!(!ran.stdout.contains("planted"), "{ran:?}");
    assert!(!ran.stdout.trim().is_empty(), "{ran:?}");
    Ok(())
}
