//! A packaged bot's commands under its ceiling (ADR 0200 §3.4), through the machine's sandbox and
//! without it: with its package's network switch off, a sandboxed command reaches nothing even
//! where the bot's allow list names the host, and a command outside the sandbox is held to what
//! the classifier read in it, not to the shell's own local write. Process tests: the edge is a
//! real shell, the sandbox and its egress proxy, which the gate's unit tables can't cover.
#![cfg(any(target_os = "macos", all(target_os = "linux", feature = "landlock")))]

mod support;

use std::collections::{BTreeMap, BTreeSet};

use serde_json::json;
use spade_core::package::link::{Link, Made, PackageId};
use spade_testkit::Script;
use support::Result;
use support::sandbox::{World, asked, output, shell, world};

/// Links the world's bot to a package that declares `network` and nothing else, with the switch
/// as `on` says.
fn packaged(w: &World, on: bool) {
    let manifest = spade_server::packages::manifest(&json!({
        "format": "spade-bot",
        "version": 3,
        "name": "Fetcher",
        "blurb": "Fetches a page.",
        "task": "Fetch what the person asks.",
        "model": "capable",
        "effects": [{ "effect": "network", "why": "Fetches pages." }],
    }))
    .unwrap_or_else(|e| panic!("{e}"));
    let link = Link {
        package: PackageId {
            source: "local".to_owned(),
            name: "local/fetcher".to_owned(),
            version: "local".to_owned(),
            hash: "h".to_owned(),
        },
        manifest,
        on: if on {
            BTreeSet::from(["network".to_owned()])
        } else {
            BTreeSet::new()
        },
        granted: BTreeMap::new(),
        made: Made::default(),
        transaction: None,
        previous: None,
        withdrawn: None,
        pending: None,
        installing: false,
    };
    w.spade
        .engine
        .set_bot_package(&w.bot, &link)
        .unwrap_or_else(|e| panic!("{e}"));
}

#[tokio::test]
async fn a_sandboxed_command_reaches_nothing_while_its_packages_network_switch_is_off() -> Result {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    tokio::spawn(async move {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        while let Ok((mut stream, _)) = listener.accept().await {
            let mut buffer = [0u8; 1024];
            let _ = stream.read(&mut buffer).await;
            let _ = stream
                .write_all(b"HTTP/1.0 200 OK\r\nContent-Length: 5\r\n\r\nhello")
                .await;
        }
    });
    let url = format!("http://localhost:{port}/");
    let w = world(true, vec![], |_| {
        vec![
            shell("c1", format!("curl -sS -m 5 {url}; echo")),
            Script::reply("Tried."),
            Script::reply("").plain(r#"{"title":"Net"}"#),
            shell("c2", format!("curl -sS -m 5 {url}; echo")),
            Script::reply("Got it."),
        ]
    })
    .await?;
    // The person allowed the host for the bot before; its package's switch is off.
    let (status, view) = w
        .spade
        .put(
            &format!("/v1/agents/{}/security/network", w.bot),
            json!({"mode": "allow_list", "allow": [format!("localhost:{port}")]}),
        )
        .await?;
    assert_eq!(status, 200, "{view}");
    packaged(&w, false);
    w.spade.say(&w.conversation, "Fetch it").await?;
    let events = w.spade.wait_for(&w.conversation, "reply_finished").await?;
    assert!(asked(&events).is_empty(), "the sandbox held it");
    assert!(
        !output(&events, "c1").contains("hello"),
        "{}",
        output(&events, "c1")
    );
    // Turned on, the bot's own allow list holds again.
    let (status, body) = w
        .spade
        .put(
            &format!("/v1/agents/{}/package/effects", w.bot),
            json!({ "key": "network", "on": true }),
        )
        .await?;
    assert_eq!(status, 200, "{body}");
    w.spade.wait_for(&w.conversation, "renamed").await?;
    w.spade.say(&w.conversation, "Again").await?;
    let events = w
        .spade
        .wait_for_count(&w.conversation, "reply_finished", 2)
        .await?;
    assert!(
        output(&events, "c2").contains("hello"),
        "{}",
        output(&events, "c2")
    );
    Ok(())
}

#[tokio::test]
async fn a_command_outside_the_sandbox_is_refused_for_what_it_sends_before_any_review() -> Result {
    let w = world(false, vec![], |_| {
        vec![
            shell(
                "c1",
                "curl -sS -X POST -d @notes.txt https://upload.example.com/".to_owned(),
            ),
            Script::reply("Not sent."),
        ]
    })
    .await?;
    packaged(&w, false);
    w.spade.say(&w.conversation, "Upload my notes").await?;
    let events = w.spade.wait_for(&w.conversation, "reply_finished").await?;
    assert!(asked(&events).is_empty(), "refused, never asked");
    assert!(
        output(&events, "c1").contains("doesn't declare reaching outside its own folder."),
        "{}",
        output(&events, "c1")
    );
    Ok(())
}
