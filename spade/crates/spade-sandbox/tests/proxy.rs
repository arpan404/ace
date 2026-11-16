//! The egress proxy against real local listeners (ADR 0167 decision 3).

use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use spade_sandbox::egress::{EgressLog, NetworkPolicy, Proxy, Resolve, SystemResolver};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// Resolves `evil.example` to this machine, everything else as the system does.
struct Rebinding;

impl Resolve for Rebinding {
    fn resolve<'a>(
        &'a self,
        host: &'a str,
        port: u16,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = std::io::Result<Vec<SocketAddr>>> + Send + 'a>,
    > {
        Box::pin(async move {
            if host == "evil.example" {
                return Ok(vec![SocketAddr::from(([127, 0, 0, 1], port))]);
            }
            SystemResolver.resolve(host, port).await
        })
    }
}

struct Setup {
    proxy: Proxy,
    log: Arc<EgressLog>,
    _dir: tempfile::TempDir,
}

async fn setup() -> Setup {
    let dir = tempfile::tempdir().unwrap_or_else(|_| std::process::abort());
    let log = Arc::new(EgressLog::new(dir.path().to_path_buf()));
    let next = Arc::new(AtomicU64::new(0));
    let proxy = Proxy::start(
        log.clone(),
        Arc::new(Rebinding),
        Arc::new(|| 1_700_000_000_000),
        Arc::new(move || format!("token{}", next.fetch_add(1, Ordering::Relaxed))),
    )
    .await
    .unwrap_or_else(|_| std::process::abort());
    Setup {
        proxy,
        log,
        _dir: dir,
    }
}

/// A server that answers each connection with what it received, after `HTTP/1.0 200`, then closes.
async fn echo() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .unwrap_or_else(|_| std::process::abort());
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut buffer = vec![0u8; 4096];
                let read = stream.read(&mut buffer).await.unwrap_or(0);
                let body = &buffer[..read];
                let head = format!("HTTP/1.0 200 OK\r\nContent-Length: {}\r\n\r\n", body.len());
                let _ = stream.write_all(head.as_bytes()).await;
                let _ = stream.write_all(body).await;
            });
        }
    });
    port
}

fn basic(token: &str) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(format!("spade:{token}"))
}

fn token_of(url: &str) -> String {
    url.trim_start_matches("http://spade:")
        .split('@')
        .next()
        .unwrap_or_default()
        .to_owned()
}

/// Sends `request` to the proxy and reads until it closes.
async fn ask(proxy: &Proxy, request: &str) -> String {
    let mut stream = TcpStream::connect(("127.0.0.1", proxy.port()))
        .await
        .unwrap_or_else(|_| std::process::abort());
    let _ = stream.write_all(request.as_bytes()).await;
    let mut out = Vec::new();
    let _ = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        stream.read_to_end(&mut out),
    )
    .await;
    String::from_utf8_lossy(&out).into_owned()
}

/// The bot's log once it holds `count` entries: a connection is logged when both its directions
/// have closed, which can be just after the client saw the end.
async fn logged(log: &EgressLog, bot: &str, count: usize) -> Vec<spade_sandbox::egress::Entry> {
    for _ in 0..500 {
        let entries = log.read(bot, usize::MAX);
        if entries.len() >= count {
            return entries;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    log.read(bot, usize::MAX)
}

fn allowing(entry: String) -> NetworkPolicy {
    NetworkPolicy {
        allow: vec![entry],
        ..NetworkPolicy::default()
    }
}

#[tokio::test]
async fn an_allowed_tunnel_carries_bytes_both_ways_and_is_logged_with_its_size() {
    let setup = setup().await;
    let port = echo().await;
    let ticket = setup
        .proxy
        .open("bot1", "run1", allowing(format!("127.0.0.1:{port}")));
    let token = token_of(&ticket.url());
    let answer = ask(
        &setup.proxy,
        &format!(
            "CONNECT 127.0.0.1:{port} HTTP/1.1\r\nProxy-Authorization: Basic {}\r\n\r\nhello",
            basic(&token)
        ),
    )
    .await;
    assert!(answer.starts_with("HTTP/1.1 200 Connection Established\r\n\r\n"));
    assert!(answer.ends_with("hello"), "{answer}");
    let logged = logged(&setup.log, "bot1", 1).await;
    let usage = ticket.usage();
    assert_eq!((usage.connections, usage.sent), (1, 5));
    assert_eq!(logged.len(), 1);
    assert!(logged[0].allowed && logged[0].method == "CONNECT" && logged[0].run == "run1");
    assert_eq!((logged[0].sent, logged[0].port), (5, port));
    assert!(logged[0].received > 5);
}

#[tokio::test]
async fn a_host_off_the_allow_list_is_refused_and_logged() {
    let setup = setup().await;
    let ticket = setup.proxy.open("bot1", "run1", NetworkPolicy::default());
    let answer = ask(
        &setup.proxy,
        &format!(
            "CONNECT exfil.example:443 HTTP/1.1\r\nProxy-Authorization: Basic {}\r\n\r\n",
            basic(&token_of(&ticket.url()))
        ),
    )
    .await;
    assert!(answer.starts_with("HTTP/1.1 403"), "{answer}");
    assert!(answer.contains("not on this bot's network allow-list"));
    let logged = logged(&setup.log, "bot1", 1).await;
    assert_eq!(ticket.usage().refused, 1);
    assert!(!logged[0].allowed && logged[0].host == "exfil.example");
}

#[tokio::test]
async fn a_request_without_a_live_ticket_is_asked_to_authenticate() {
    let setup = setup().await;
    let port = echo().await;
    let ticket = setup
        .proxy
        .open("bot1", "run1", allowing(format!("127.0.0.1:{port}")));
    let token = token_of(&ticket.url());
    let request = format!(
        "CONNECT 127.0.0.1:{port} HTTP/1.1\r\nProxy-Authorization: Basic {}\r\n\r\n",
        basic(&token)
    );
    let none = ask(
        &setup.proxy,
        &format!("CONNECT 127.0.0.1:{port} HTTP/1.1\r\n\r\n"),
    )
    .await;
    assert!(none.starts_with("HTTP/1.1 407"), "{none}");
    let wrong = ask(
        &setup.proxy,
        &format!(
            "CONNECT 127.0.0.1:{port} HTTP/1.1\r\nProxy-Authorization: Basic {}\r\n\r\n",
            basic("guess")
        ),
    )
    .await;
    assert!(wrong.starts_with("HTTP/1.1 407"));
    drop(ticket);
    let ended = ask(&setup.proxy, &request).await;
    assert!(
        ended.starts_with("HTTP/1.1 407"),
        "a run's access ends with it"
    );
}

#[tokio::test]
async fn a_plain_request_reaches_the_host_without_the_runs_credential() {
    let setup = setup().await;
    let port = echo().await;
    let ticket = setup
        .proxy
        .open("bot1", "run1", allowing(format!("localhost:{port}")));
    let answer = ask(
        &setup.proxy,
        &format!(
            "GET http://localhost:{port}/x HTTP/1.1\r\nHost: localhost\r\nProxy-Authorization: Basic {}\r\n\r\n",
            basic(&token_of(&ticket.url()))
        ),
    )
    .await;
    assert!(answer.contains("GET /x HTTP/1.1\r\n"), "{answer}");
    assert!(!answer.to_ascii_lowercase().contains("proxy-authorization"));
    assert!(answer.contains("Connection: close"));
}

#[tokio::test]
async fn a_public_name_that_resolves_to_this_machine_is_refused() {
    let setup = setup().await;
    let port = echo().await;
    let ticket = setup
        .proxy
        .open("bot1", "run1", allowing(format!("evil.example:{port}")));
    let answer = ask(
        &setup.proxy,
        &format!(
            "CONNECT evil.example:{port} HTTP/1.1\r\nProxy-Authorization: Basic {}\r\n\r\n",
            basic(&token_of(&ticket.url()))
        ),
    )
    .await;
    assert!(answer.starts_with("HTTP/1.1 403"), "{answer}");
    assert!(answer.contains("resolves to a private address"));
}

/// curl inside the macOS sandbox, with only the ticket's variables, through the proxy.
#[cfg(target_os = "macos")]
#[tokio::test]
async fn a_sandboxed_run_reaches_allowed_hosts_only_through_the_proxy() {
    use std::ffi::OsString;

    let setup = setup().await;
    let (allowed, other) = (echo().await, echo().await);
    let dir = tempfile::tempdir().unwrap_or_else(|_| std::process::abort());
    let root = std::fs::canonicalize(dir.path()).unwrap_or_else(|_| std::process::abort());
    let workspace = root.join("data/ws");
    std::fs::create_dir_all(&workspace).unwrap_or_default();
    let policy = spade_sandbox::Policy::build(&spade_sandbox::Facts {
        home: root.join("home"),
        spade_data: root.join("data"),
        workspace: workspace.clone(),
        proxy_port: Some(setup.proxy.port()),
        ..Default::default()
    });
    let ticket = setup
        .proxy
        .open("bot1", "run1", allowing(format!("localhost:{allowed}")));
    let runner = spade_sandbox::Runner::probe(None);
    let curl = |url: String| {
        let launch = runner
            .wrap(
                &policy,
                std::path::Path::new("/usr/bin/curl"),
                &[
                    OsString::from("-sS"),
                    OsString::from("-m5"),
                    OsString::from(url),
                ],
            )
            .unwrap_or_else(|error| panic!("{error}"));
        let env = ticket.env();
        async move {
            tokio::process::Command::new(&launch.program)
                .args(&launch.args)
                .env_clear()
                .envs(env)
                .output()
                .await
                .map(|out| {
                    (
                        out.status.success(),
                        String::from_utf8_lossy(&out.stdout).into_owned(),
                    )
                })
                .unwrap_or((false, String::new()))
        }
    };
    let (ran, body) = curl(format!("http://localhost:{allowed}/hi")).await;
    assert!(ran && body.contains("GET /hi"), "{body}");
    let (_, refused) = curl(format!("http://localhost:{other}/hi")).await;
    assert!(refused.contains("refused"), "{refused}");
    logged(&setup.log, "bot1", 2).await;
    assert!(ticket.usage().connections == 1 && ticket.usage().refused == 1);
}
