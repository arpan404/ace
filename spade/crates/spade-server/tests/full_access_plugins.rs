//! Full access and a plugin's local server (ADR 0163, amendment 2): a sandbox that holds a
//! server's files doesn't hold what it does with an API token over the network, so its tools keep
//! the app-tool rules: a first-call ask when they declare nothing, the reviewer with the
//! classifier off. Only a server sealed offline with no token of its own runs as the sandbox
//! decides.
#![cfg(any(target_os = "macos", all(target_os = "linux", feature = "landlock")))]

mod support;

use std::path::Path;
use std::sync::Arc;

use serde_json::{Value, json};
use spade_server::security::attest::HEADER;
use spade_server::workspace::shell::{Confine, Confined, Confinement, Kind};
use spade_testkit::Script;
use support::plugins::{FakeAce, plugin};
use support::sandbox::{World, world_with_options};
use support::{Options, Result};

/// A sandbox that holds every plugin server's files, with its network on or off.
struct Holds {
    online: bool,
}

impl Confine for Holds {
    fn confine(&self, _home: &Path, kind: &Kind) -> std::result::Result<Confinement, String> {
        Ok(match kind {
            Kind::Plugin { .. } => Confinement::Contained(Box::new(Confined {
                launch: Box::new(|program: &Path, args: &[std::ffi::OsString]| {
                    Ok((program.to_path_buf(), args.to_vec()))
                }),
                env: Vec::new(),
                path_first: Vec::new(),
                hold: Box::new(()),
                watch: None,
                online: self.online,
            })),
            _ => Confinement::None,
        })
    }

    fn contains(&self, _home: &Path) -> bool {
        true
    }

    fn review(&self, _home: &Path, _kind: &Kind) -> Option<String> {
        None
    }
}

/// A mail server on stdio: `send_email` says nothing about itself, `post_message` is declared
/// `network` by its entry. Each call answers whether it held a token.
const SERVER: &str = r#"#!/bin/sh
while IFS= read -r line; do
  id=$(printf '%s\n' "$line" | sed -n 's/^{"jsonrpc":"2.0","id":\([0-9][0-9]*\).*/\1/p')
  version=$(printf '%s\n' "$line" | sed -n 's/.*"protocolVersion":"\([^"]*\)".*/\1/p')
  case "$line" in
    *'"method":"initialize"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"%s","capabilities":{"tools":{}},"serverInfo":{"name":"mail","version":"1"}}}\n' "$id" "$version" ;;
    *'"method":"tools/list"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"tools":[{"name":"send_email","inputSchema":{"type":"object"}},{"name":"post_message","inputSchema":{"type":"object"},"annotations":{"readOnlyHint":false}}]}}\n' "$id" ;;
    *'"method":"tools/call"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"content":[{"type":"text","text":"sent with token %s"}]}}\n' "$id" "${MAIL_TOKEN:-none}" ;;
    *)
      if [ -n "$id" ]; then printf '{"jsonrpc":"2.0","id":%s,"result":{}}\n' "$id"; fi ;;
  esac
done
"#;

/// A Full access bot allowed the `mail` plugin, its server held as `holds` says, with `env`.
async fn mail_world(holds: Holds, env: Value, root: &Path, scripts: Vec<Script>) -> Result<World> {
    std::fs::write(root.join("server.sh"), SERVER)?;
    let mail = plugin(
        "mail",
        &"b".repeat(64),
        &root.to_string_lossy(),
        json!([]),
        json!([{ "kind": "stdio", "name": "mail", "command": "/bin/sh",
                 "args": ["${PLUGIN_ROOT}/server.sh"], "env": env,
                 "effects": { "post_message": "network" } }]),
    );
    let options = Options {
        plugins: Some(FakeAce::with(vec![mail])),
        plugin_confine: Some(Arc::new(holds)),
        ..Options::default()
    };
    // The machine's sandbox holds the bot's work (and takes the checkpoints that let it run).
    let w = world_with_options(options, true, |_| scripts).await?;
    let (status, body) = w
        .spade
        .put(
            &format!("/v1/agents/{}/plugins", w.bot),
            json!({ "plugins": ["mail"] }),
        )
        .await?;
    assert_eq!(status, 200, "{body}");
    // Started as a tool search would, so the bot is offered its tools.
    let plugins = w.spade.engine.plugins().cloned().ok_or("no plugins")?;
    plugins.start_servers(&w.bot).await;
    let stamp = w.stamp(&w.bot, "full_access");
    let (status, body) = w
        .spade
        .put_with(
            &format!("/v1/agents/{}/security/autonomy", w.bot),
            json!({ "autonomy": "full_access" }),
            &[(HEADER, &stamp)],
        )
        .await?;
    assert_eq!(status, 200, "{body}");
    Ok(w)
}

fn asked(events: &[Value]) -> Vec<&Value> {
    events
        .iter()
        .filter(|e| e["type"] == "approval_requested")
        .collect()
}

#[tokio::test]
async fn in_full_access_a_contained_plugin_server_with_a_token_and_network_keeps_the_app_tool_rules()
-> Result {
    let root = tempfile::tempdir()?;
    let w = mail_world(
        Holds { online: true },
        json!({ "MAIL_TOKEN": "tok-123" }),
        root.path(),
        vec![
            Script::reply("").call("c1", "mail__send_email", json!({ "to": "bob@x.test" })),
            Script::reply("").call("c2", "mail__post_message", json!({ "text": "hi" })),
        ],
    )
    .await?;
    // The classifier is off here, as in every test that doesn't turn it on.
    w.spade.say(&w.conversation, "Tell Bob").await?;
    let events = w
        .spade
        .wait_for(&w.conversation, "approval_requested")
        .await?;
    let first = asked(&events);
    assert_eq!(first[0]["call_id"], "c1");
    assert_eq!(first[0]["ask"], "undeclared", "first call asks: {events:?}");
    // Declined: the bot goes on to the declared tool, which the reviewer must see.
    let (status, _) = w
        .spade
        .post(
            &format!("/v1/conversations/{}/approvals/c1", w.conversation),
            json!({ "allowed": false }),
        )
        .await?;
    assert_eq!(status, 202);
    let events = w
        .spade
        .wait_for_count(&w.conversation, "approval_requested", 2)
        .await?;
    let reviewed = events
        .iter()
        .find(|e| e["type"] == "call_reviewed" && e["call_id"] == "c2")
        .ok_or_else(|| format!("c2 wasn't reviewed: {events:?}"))?;
    // The test's reviewer can't be reached, so the review asks the person: never a plain run.
    assert_eq!(reviewed["model"], support::UNREACHABLE_REVIEWER);
    assert!(
        !events.iter().any(|e| e["type"] == "tool_finished"
            && e["content"]
                .as_str()
                .is_some_and(|c| c.contains("sent with token"))),
        "nothing was sent: {events:?}"
    );
    Ok(())
}

#[tokio::test]
async fn in_full_access_a_plugin_server_sealed_offline_with_no_token_runs_as_the_sandbox_decides()
-> Result {
    let root = tempfile::tempdir()?;
    let w = mail_world(
        Holds { online: false },
        json!({}),
        root.path(),
        vec![
            Script::reply("").call("c1", "mail__send_email", json!({ "to": "bob@x.test" })),
            Script::reply("Done."),
        ],
    )
    .await?;
    w.spade.say(&w.conversation, "Tell Bob").await?;
    let events = w.spade.wait_for(&w.conversation, "reply_finished").await?;
    assert!(asked(&events).is_empty(), "{events:?}");
    assert!(
        events.iter().any(|e| e["type"] == "tool_finished"
            && e["content"]
                .as_str()
                .is_some_and(|c| c.contains("sent with token none"))),
        "{events:?}"
    );
    Ok(())
}
