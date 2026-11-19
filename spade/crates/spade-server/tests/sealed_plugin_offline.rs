//! A sealed plugin server is really offline (ADR 0171, amendment 4), in the real Linux sandbox:
//! Landlock, the syscall filter and Spade's own launcher, no stand-in. A plugin server whose
//! network is off and that holds no token of its own is sealed, so its tools run as the sandbox
//! decides; that is safe only if it can reach nothing, so it launches under the enforced offline
//! policy. Here it tries a Unix socket in the bot's workspace that forwards to a TCP listener on
//! this machine, and fails. A server with its network on (not sealed, so its tool asks first)
//! reaches the same socket, which is why sealing can't rest on the network setting alone.
#![cfg(all(target_os = "linux", feature = "landlock"))]

mod support;

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::os::unix::net::UnixListener;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use serde_json::{Value, json};
use spade_testkit::Script;
use support::plugins::{FakeAce, plugin};
use support::sandbox::{World, world_with_options};
use support::{Options, Result};

/// A server whose one tool, `probe`, connects to the socket `s` in its working folder (the bot's
/// workspace), says `ping` and answers what came back, or why it couldn't.
const SERVER: &str = r#"#!/bin/sh
while IFS= read -r line; do
  id=$(printf '%s\n' "$line" | sed -n 's/^{"jsonrpc":"2.0","id":\([0-9][0-9]*\).*/\1/p')
  version=$(printf '%s\n' "$line" | sed -n 's/.*"protocolVersion":"\([^"]*\)".*/\1/p')
  case "$line" in
    *'"method":"initialize"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"%s","capabilities":{"tools":{}},"serverInfo":{"name":"probe","version":"1"}}}\n' "$id" "$version" ;;
    *'"method":"tools/list"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"tools":[{"name":"probe","inputSchema":{"type":"object"}}]}}\n' "$id" ;;
    *'"method":"tools/call"'*)
      out=$(python3 -c 'import socket
s = socket.socket(socket.AF_UNIX)
s.connect("s")
s.sendall(b"ping")
print("connected:" + s.recv(16).decode())' 2>&1 | tail -n 1 | tr -d '"\\' | tr '\n' ' ')
      printf '{"jsonrpc":"2.0","id":%s,"result":{"content":[{"type":"text","text":"%s"}]}}\n' "$id" "$out" ;;
    *)
      if [ -n "$id" ]; then printf '{"jsonrpc":"2.0","id":%s,"result":{}}\n' "$id"; fi ;;
  esac
done
"#;

/// A TCP listener on this machine that answers `pong`, and a Unix socket at `socket` forwarding
/// to it, as a local proxy to a network service would. Counts what reached the TCP side.
fn forwarder(socket: &Path) -> Result<Arc<AtomicUsize>> {
    let reached = Arc::new(AtomicUsize::new(0));
    let tcp = TcpListener::bind("127.0.0.1:0")?;
    let port = tcp.local_addr()?.port();
    let counted = reached.clone();
    std::thread::spawn(move || {
        for stream in tcp.incoming().flatten() {
            counted.fetch_add(1, Ordering::SeqCst);
            let mut stream = stream;
            let mut buf = [0u8; 16];
            let _ = stream.read(&mut buf);
            let _ = stream.write_all(b"pong");
        }
    });
    let unix = UnixListener::bind(socket)?;
    std::thread::spawn(move || {
        for client in unix.incoming().flatten() {
            let mut client = client;
            let Ok(mut upstream) = TcpStream::connect(("127.0.0.1", port)) else {
                continue;
            };
            let mut buf = [0u8; 16];
            let read = client.read(&mut buf).unwrap_or(0);
            let _ = upstream.write_all(&buf[..read]);
            let got = upstream.read(&mut buf).unwrap_or(0);
            let _ = client.write_all(&buf[..got]);
        }
    });
    Ok(reached)
}

/// A world in the real sandbox whose bot is allowed the `probe` plugin, its plugin network
/// `network`, with the forwarder's socket in the bot's workspace.
async fn probe_world(
    root: &Path,
    network: &str,
    scripts: Vec<Script>,
) -> Result<(World, Arc<AtomicUsize>)> {
    std::fs::write(root.join("server.sh"), SERVER)?;
    let probe = plugin(
        "probe",
        &"c".repeat(64),
        &root.to_string_lossy(),
        json!([]),
        json!([{ "kind": "stdio", "name": "probe", "command": "/bin/sh",
                 "args": ["${PLUGIN_ROOT}/server.sh"] }]),
    );
    let options = Options {
        plugins: Some(FakeAce::with(vec![probe])),
        ..Options::default()
    };
    let w = world_with_options(options, true, |_| scripts).await?;
    assert!(
        w.security.contains(),
        "this machine's sandbox must hold the test"
    );
    let (status, body) = w
        .spade
        .put(
            &format!("/v1/agents/{}/security/plugin-network", w.bot),
            json!({ "mode": network, "allow": [], "dropped": [] }),
        )
        .await?;
    assert_eq!(status, 200, "{body}");
    let (status, body) = w
        .spade
        .put(
            &format!("/v1/agents/{}/plugins", w.bot),
            json!({ "plugins": ["probe"] }),
        )
        .await?;
    assert_eq!(status, 200, "{body}");
    let workspace = w.workspaces.of(&w.bot)?.path()?;
    let reached = forwarder(&workspace.join("s"))?;
    let plugins = w.spade.engine.plugins().cloned().ok_or("no plugins")?;
    plugins.start_servers(&w.bot).await;
    Ok((w, reached))
}

fn output(events: &[Value], call: &str) -> String {
    events
        .iter()
        .find(|e| e["type"] == "tool_finished" && e["call_id"] == call)
        .and_then(|e| e["content"].as_str())
        .unwrap_or_default()
        .to_owned()
}

#[tokio::test]
async fn a_sealed_plugin_server_cant_reach_a_workspace_socket_that_forwards_to_the_network()
-> Result {
    let root = tempfile::tempdir()?;
    let (w, reached) = probe_world(
        root.path(),
        "off",
        vec![
            Script::reply("").call("c1", "probe__probe", json!({})),
            Script::reply("Done."),
        ],
    )
    .await?;
    w.spade.say(&w.conversation, "Probe").await?;
    let events = w.spade.wait_for(&w.conversation, "reply_finished").await?;
    // Sealed: its tool runs as the sandbox decides, with no request.
    assert!(
        !events.iter().any(|e| e["type"] == "approval_requested"),
        "{events:?}"
    );
    let said = output(&events, "c1");
    assert!(!said.is_empty(), "{events:?}");
    assert!(!said.contains("connected"), "{said}");
    assert!(
        said.contains("PermissionError") || said.contains("Operation not permitted"),
        "{said}"
    );
    assert_eq!(reached.load(Ordering::SeqCst), 0);
    Ok(())
}

#[tokio::test]
async fn a_plugin_server_with_its_network_on_isnt_sealed_and_reaches_the_same_socket() -> Result {
    let root = tempfile::tempdir()?;
    let (w, reached) = probe_world(
        root.path(),
        "allow_list",
        vec![
            Script::reply("").call("c1", "probe__probe", json!({})),
            Script::reply("Done."),
        ],
    )
    .await?;
    w.spade.say(&w.conversation, "Probe").await?;
    // Not sealed: a tool that declares nothing asks first.
    let events = w
        .spade
        .wait_for(&w.conversation, "approval_requested")
        .await?;
    let asked = events
        .iter()
        .find(|e| e["type"] == "approval_requested")
        .ok_or("not asked")?;
    assert_eq!(asked["ask"], "undeclared");
    let (status, _) = w
        .spade
        .post(
            &format!("/v1/conversations/{}/approvals/c1", w.conversation),
            json!({ "allowed": true }),
        )
        .await?;
    assert_eq!(status, 202);
    let events = w.spade.wait_for(&w.conversation, "reply_finished").await?;
    let said = output(&events, "c1");
    assert!(said.contains("connected:pong"), "{said}");
    assert_eq!(reached.load(Ordering::SeqCst), 1);
    Ok(())
}
