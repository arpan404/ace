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
        withdrawn_hashes: Vec::new(),
        pending: None,
        installing: false,
        code: Default::default(),
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

/// Asks the proxy, as a run would through `proxy` (its `HTTP_PROXY`), to open a tunnel to
/// `127.0.0.1:port`; the proxy's status line.
async fn tunnel(proxy: &str, port: u16) -> String {
    use base64::Engine as _;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let rest = proxy.trim_start_matches("http://");
    let (auth, address) = rest.split_once('@').unwrap_or_default();
    let Ok(mut stream) = tokio::net::TcpStream::connect(address).await else {
        return "unreachable".to_owned();
    };
    let basic = base64::engine::general_purpose::STANDARD.encode(auth);
    let request =
        format!("CONNECT 127.0.0.1:{port} HTTP/1.1\r\nProxy-Authorization: Basic {basic}\r\n\r\n");
    let _ = stream.write_all(request.as_bytes()).await;
    let mut line = vec![0u8; 64];
    let read = tokio::time::timeout(std::time::Duration::from_secs(5), stream.read(&mut line))
        .await
        .ok()
        .and_then(std::result::Result::ok)
        .unwrap_or(0);
    String::from_utf8_lossy(&line[..read])
        .lines()
        .next()
        .unwrap_or_default()
        .to_owned()
}

/// The person turns the package switch for `hosts` on or off.
async fn switch(w: &World, hosts: &str, on: bool) -> Result<(u16, serde_json::Value)> {
    let path = format!("/v1/agents/{}/package/effects", w.bot);
    let key = format!("network:hosts:{hosts}");
    w.spade.put(&path, json!({ "key": key, "on": on })).await
}

#[tokio::test]
async fn a_live_runs_egress_ends_when_one_host_switch_goes_off_while_another_stays_on() -> Result {
    use spade_server::workspace::shell::{Confine, Confinement, Kind};
    let open = || async {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let port = listener.local_addr()?.port();
        tokio::spawn(async move { while listener.accept().await.is_ok() {} });
        Ok::<u16, std::io::Error>(port)
    };
    let (first, second) = (open().await?, open().await?);
    let w = world(true, vec![], |_| Vec::new()).await?;
    let hosts = |port: u16| format!("127.0.0.1:{port}");
    two_hosts(&w, &hosts(first), &hosts(second));
    for port in [first, second] {
        let (status, body) = switch(&w, &hosts(port), true).await?;
        assert_eq!(status, 200, "{body}");
    }
    // A run under way, as a terminal or a service holds its ticket.
    let home = w
        .home
        .parent()
        .ok_or("no root")?
        .join("data/workspace")
        .join(&w.bot);
    let Confinement::Contained(run) = w.security.confine(&home, &Kind::Command)? else {
        panic!("the sandbox holds the run");
    };
    let proxy = run
        .env
        .iter()
        .find(|(name, _)| name == "HTTP_PROXY")
        .map(|(_, url)| url.clone())
        .ok_or("the run reaches the proxy")?;
    assert!(
        tunnel(&proxy, first).await.contains("200"),
        "both hosts allowed"
    );
    // The person turns the first host off; the second stays on.
    let (status, body) = switch(&w, &hosts(first), false).await?;
    assert_eq!(status, 200, "{body}");
    let after = tunnel(&proxy, first).await;
    assert!(
        !after.contains("200"),
        "the live run no longer reaches it: {after}"
    );
    // A run started now gets the narrower policy, which still reaches the second host.
    let Confinement::Contained(next) = w.security.confine(&home, &Kind::Command)? else {
        panic!("the sandbox holds the run");
    };
    let proxy = next
        .env
        .iter()
        .find(|(name, _)| name == "HTTP_PROXY")
        .map(|(_, url)| url.clone())
        .ok_or("the run reaches the proxy")?;
    assert!(tunnel(&proxy, second).await.contains("200"));
    assert!(!tunnel(&proxy, first).await.contains("200"));
    Ok(())
}

#[tokio::test]
async fn a_ticket_issued_while_a_host_switch_goes_off_never_keeps_the_host() -> Result {
    use spade_server::workspace::shell::{Confine, Confinement, Kind};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex, mpsc};
    use std::time::Duration;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let first = listener.local_addr()?.port();
    tokio::spawn(async move { while listener.accept().await.is_ok() {} });
    let w = world(true, vec![], |_| Vec::new()).await?;
    let host = format!("127.0.0.1:{first}");
    two_hosts(&w, &host, "127.0.0.1:9");
    for each in [host.as_str(), "127.0.0.1:9"] {
        let (status, body) = switch(&w, each, true).await?;
        assert_eq!(status, 200, "{body}");
    }
    // The run has read its policy when the person turns the host off; its ticket comes after.
    let (read, has_read) = mpsc::channel::<()>();
    let (switched, has_switched) = mpsc::channel::<()>();
    let has_switched = Mutex::new(has_switched);
    let once = AtomicBool::new(false);
    w.security.hold_ticket_issues(Arc::new(move |_| {
        if !once.swap(true, Ordering::SeqCst) {
            let _ = read.send(());
            let waiting = has_switched.lock().unwrap_or_else(|p| p.into_inner());
            let _ = waiting.recv_timeout(Duration::from_millis(500));
        }
    }));
    let home = w
        .home
        .parent()
        .ok_or("no root")?
        .join("data/workspace")
        .join(&w.bot);
    let security = w.security.clone();
    let run = tokio::task::spawn_blocking(move || security.confine(&home, &Kind::Command));
    tokio::task::spawn_blocking(move || has_read.recv_timeout(Duration::from_secs(5))).await??;
    let (engine, bot, key) = (
        w.spade.engine.clone(),
        w.bot.clone(),
        format!("network:hosts:{host}"),
    );
    let off = tokio::task::spawn_blocking(move || {
        let done = spade_server::packages::set_switch(&engine, &bot, &key, false, &|| false);
        let _ = switched.send(());
        done
    });
    let Confinement::Contained(run) = run.await?? else {
        panic!("the sandbox holds the run");
    };
    off.await?.map_err(|e| e.to_string())?;
    let proxy = run
        .env
        .iter()
        .find(|(name, _)| name == "HTTP_PROXY")
        .map(|(_, url)| url.clone())
        .ok_or("the run reaches the proxy")?;
    let after = tunnel(&proxy, first).await;
    assert!(
        !after.contains("200"),
        "the run never reaches the host: {after}"
    );
    Ok(())
}

/// Links the world's bot to a package declaring `network` to each of two hosts, both off.
fn two_hosts(w: &World, first: &str, second: &str) {
    let manifest = spade_server::packages::manifest(&json!({
        "format": "spade-bot", "version": 3, "name": "Fetcher", "blurb": "Fetches.",
        "task": "Fetch what the person asks.", "model": "capable",
        "effects": [
            { "effect": "network", "hosts": [first], "why": "Reads the first feed." },
            { "effect": "network", "hosts": [second], "why": "Reads the second feed." },
        ],
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
        on: BTreeSet::new(),
        granted: BTreeMap::new(),
        made: Made::default(),
        transaction: None,
        previous: None,
        withdrawn: None,
        withdrawn_hashes: Vec::new(),
        pending: None,
        installing: false,
        code: Default::default(),
    };
    w.spade
        .engine
        .set_bot_package(&w.bot, &link)
        .unwrap_or_else(|e| panic!("{e}"));
}
