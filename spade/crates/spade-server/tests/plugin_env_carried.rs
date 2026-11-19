//! A plugin's environment never reaches Spade's own program outside the sandbox (ADR 0171,
//! amendment 4), with the actual `spade` binary as the launcher (Linux) or the trampoline in front
//! of `sandbox-exec` (macOS). A plugin's entry names a token and a library for the loader to run
//! first (`LD_PRELOAD`, `DYLD_INSERT_LIBRARIES`); the server still gets its token, and the library
//! never runs outside the sandbox, where it would write a file beside the test's folders.
#![cfg(any(target_os = "macos", all(target_os = "linux", feature = "landlock")))]

mod support;

use std::path::Path;
use std::process::Command;

use serde_json::{Value, json};
use spade_testkit::Script;
use support::plugins::{FakeAce, plugin};
use support::sandbox::world_with_options;
use support::{Options, Result};

/// A server whose one tool, `token`, answers the `API_TOKEN` it was started with.
const SERVER: &str = r#"#!/bin/sh
while IFS= read -r line; do
  id=$(printf '%s\n' "$line" | sed -n 's/^{"jsonrpc":"2.0","id":\([0-9][0-9]*\).*/\1/p')
  version=$(printf '%s\n' "$line" | sed -n 's/.*"protocolVersion":"\([^"]*\)".*/\1/p')
  case "$line" in
    *'"method":"initialize"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"%s","capabilities":{"tools":{}},"serverInfo":{"name":"tok","version":"1"}}}\n' "$id" "$version" ;;
    *'"method":"tools/list"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"tools":[{"name":"token","inputSchema":{"type":"object"},"annotations":{"readOnlyHint":true}}]}}\n' "$id" ;;
    *'"method":"tools/call"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"content":[{"type":"text","text":"token:%s"}]}}\n' "$id" "$API_TOKEN" ;;
    *)
      if [ -n "$id" ]; then printf '{"jsonrpc":"2.0","id":%s,"result":{}}\n' "$id"; fi ;;
  esac
done
"#;

/// The loader's variable that runs a library first, and how to build one, here.
#[cfg(target_os = "linux")]
const PRELOAD: (&str, &[&str], &str) = ("LD_PRELOAD", &["-shared", "-fPIC"], "inject.so");
#[cfg(target_os = "macos")]
const PRELOAD: (&str, &[&str], &str) = ("DYLD_INSERT_LIBRARIES", &["-dynamiclib"], "inject.dylib");

/// A library whose constructor writes `escaped` wherever it is loaded.
fn library(dir: &Path, escaped: &Path) -> Result<std::path::PathBuf> {
    let source = dir.join("inject.c");
    std::fs::write(
        &source,
        format!(
            "#include <stdio.h>\n\
             __attribute__((constructor)) static void run(void) {{\n\
               FILE *f = fopen(\"{}\", \"w\"); if (f) {{ fputs(\"ran\", f); fclose(f); }}\n\
             }}\n",
            escaped.display()
        ),
    )?;
    let library = dir.join(PRELOAD.2);
    let built = Command::new("cc")
        .args(PRELOAD.1)
        .arg("-o")
        .arg(&library)
        .arg(&source)
        .status()?;
    assert!(built.success());
    Ok(library)
}

#[tokio::test]
async fn a_preload_a_plugin_names_never_runs_in_spades_own_program() -> Result {
    let root = tempfile::tempdir()?;
    let root = std::fs::canonicalize(root.path())?;
    let escaped = root.join("escaped");
    let library = library(&root, &escaped)?;
    std::fs::write(root.join("server.sh"), SERVER)?;
    let tok = plugin(
        "tok",
        &"d".repeat(64),
        &root.to_string_lossy(),
        json!([]),
        json!([{ "kind": "stdio", "name": "tok", "command": "/bin/sh",
                 "args": ["${PLUGIN_ROOT}/server.sh"],
                 "env": { "API_TOKEN": "t0k", PRELOAD.0: library.to_string_lossy() } }]),
    );
    let options = Options {
        plugins: Some(FakeAce::with(vec![tok])),
        ..Options::default()
    };
    let w = world_with_options(options, true, |_| {
        vec![
            Script::reply("").call("c1", "tok__token", json!({})),
            Script::reply("Done."),
        ]
    })
    .await?;
    assert!(
        w.security.contains(),
        "this machine's sandbox must hold the test"
    );
    // Network off: on macOS too the server then starts through Spade's own program.
    for (path, body) in [
        (
            format!("/v1/agents/{}/security/plugin-network", w.bot),
            json!({ "mode": "off", "allow": [], "dropped": [] }),
        ),
        (
            format!("/v1/agents/{}/plugins", w.bot),
            json!({ "plugins": ["tok"] }),
        ),
    ] {
        let (status, answer) = w.spade.put(&path, body).await?;
        assert_eq!(status, 200, "{answer}");
    }
    let plugins = w.spade.engine.plugins().cloned().ok_or("no plugins")?;
    plugins.start_servers(&w.bot).await;
    w.spade.say(&w.conversation, "Token?").await?;
    // A server with an environment of its own isn't sealed: its tool, which declares nothing,
    // asks once. Allowed.
    w.spade
        .wait_for(&w.conversation, "approval_requested")
        .await?;
    let (status, _) = w
        .spade
        .post(
            &format!("/v1/conversations/{}/approvals/c1", w.conversation),
            json!({ "allowed": true }),
        )
        .await?;
    assert_eq!(status, 202);
    let events = w.spade.wait_for(&w.conversation, "reply_finished").await?;
    let said = events
        .iter()
        .find(|e| e["type"] == "tool_finished" && e["call_id"] == "c1")
        .and_then(|e| e["content"].as_str())
        .map(str::to_owned)
        .unwrap_or_default();
    // The server got its environment...
    assert!(said.contains("token:t0k"), "{said} {:?}", types(&events));
    // ...and the library never ran outside the sandbox.
    assert!(!escaped.exists(), "the preload ran outside the sandbox");
    Ok(())
}

fn types(events: &[Value]) -> Vec<String> {
    support::types(events)
}
