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

/// The bot's last lines about connections (`closed`, `refused` or `failed`) once it holds
/// `count` of them: a connection's last line is written when both its directions have closed,
/// which can be just after the client saw the end.
async fn logged(log: &EgressLog, bot: &str, count: usize) -> Vec<spade_sandbox::egress::Entry> {
    let last = |log: &EgressLog| -> Vec<spade_sandbox::egress::Entry> {
        log.read(bot, usize::MAX)
            .into_iter()
            .filter(|e| matches!(e.phase.as_str(), "closed" | "refused" | "failed"))
            .collect()
    };
    for _ in 0..500 {
        let entries = last(log);
        if entries.len() >= count {
            return entries;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    last(log)
}

/// The bot's lines once any is written.
async fn any_logged(log: &EgressLog, bot: &str) -> Vec<spade_sandbox::egress::Entry> {
    for _ in 0..500 {
        let entries = log.read(bot, usize::MAX);
        if !entries.is_empty() {
            return entries;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    Vec::new()
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

// Bounds, cancellation and live logging (the proxy's limits set small for the tests).

use spade_sandbox::egress::Limits;

/// Answers `slow.example` only after a long wait; the rest as [`Rebinding`].
struct Slow;

impl Resolve for Slow {
    fn resolve<'a>(
        &'a self,
        host: &'a str,
        port: u16,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = std::io::Result<Vec<SocketAddr>>> + Send + 'a>,
    > {
        Box::pin(async move {
            if host == "slow.example" {
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                return Ok(vec![SocketAddr::from(([93, 184, 216, 34], port))]);
            }
            Rebinding.resolve(host, port).await
        })
    }
}

async fn bounded(limits: Limits) -> Setup {
    let dir = tempfile::tempdir().unwrap_or_else(|_| std::process::abort());
    let log = Arc::new(EgressLog::new(dir.path().to_path_buf()));
    let next = Arc::new(AtomicU64::new(0));
    let proxy = Proxy::start_with(
        log.clone(),
        Arc::new(Slow),
        Arc::new(|| 1_700_000_000_000),
        Arc::new(move || format!("token{}", next.fetch_add(1, Ordering::Relaxed))),
        limits,
    )
    .await
    .unwrap_or_else(|_| std::process::abort());
    Setup {
        proxy,
        log,
        _dir: dir,
    }
}

/// A server that echoes what each connection sends and never closes it.
async fn holding() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .unwrap_or_else(|_| std::process::abort());
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut buffer = vec![0u8; 4096];
                loop {
                    match stream.read(&mut buffer).await {
                        Ok(0) | Err(_) => {
                            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                            return;
                        }
                        Ok(read) => {
                            let _ = stream.write_all(&buffer[..read]).await;
                        }
                    }
                }
            });
        }
    });
    port
}

/// Opens a tunnel to `127.0.0.1:port` with `token`; the stream after `200`, or the answer.
async fn tunnel(proxy: &Proxy, port: u16, token: &str) -> std::result::Result<TcpStream, String> {
    let mut stream = TcpStream::connect(("127.0.0.1", proxy.port()))
        .await
        .map_err(|e| e.to_string())?;
    let request = format!(
        "CONNECT 127.0.0.1:{port} HTTP/1.1\r\nProxy-Authorization: Basic {}\r\n\r\n",
        basic(token)
    );
    let _ = stream.write_all(request.as_bytes()).await;
    let mut head = vec![0u8; 39];
    let read = tokio::time::timeout(std::time::Duration::from_secs(5), stream.read(&mut head))
        .await
        .map_err(|_| "no answer".to_owned())?
        .map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&head[..read]).into_owned();
    if text.starts_with("HTTP/1.1 200") {
        Ok(stream)
    } else {
        Err(text)
    }
}

/// Whether `stream` is closed (reads its end) within `within`.
async fn closes(stream: &mut TcpStream, within: std::time::Duration) -> bool {
    let mut buffer = [0u8; 256];
    let deadline = tokio::time::Instant::now() + within;
    loop {
        match tokio::time::timeout_at(deadline, stream.read(&mut buffer)).await {
            Ok(Ok(0)) | Ok(Err(_)) => return true,
            Ok(Ok(_)) => continue,
            Err(_) => return false,
        }
    }
}

#[tokio::test]
async fn a_runs_open_tunnels_end_when_its_ticket_is_dropped() {
    let setup = bounded(Limits::default()).await;
    let port = holding().await;
    let ticket = setup
        .proxy
        .open("bot1", "run1", allowing(format!("127.0.0.1:{port}")));
    let token = token_of(&ticket.url());
    let mut stream = tunnel(&setup.proxy, port, &token)
        .await
        .unwrap_or_else(|why| panic!("{why}"));
    assert!(!closes(&mut stream, std::time::Duration::from_millis(200)).await);
    drop(ticket);
    assert!(closes(&mut stream, std::time::Duration::from_secs(2)).await);
}

#[tokio::test]
async fn a_connection_still_being_made_when_the_ticket_drops_is_abandoned() {
    let setup = bounded(Limits::default()).await;
    let ticket = setup
        .proxy
        .open("bot1", "run1", allowing("slow.example:443".to_owned()));
    let mut stream = TcpStream::connect(("127.0.0.1", setup.proxy.port()))
        .await
        .unwrap_or_else(|_| std::process::abort());
    let request = format!(
        "CONNECT slow.example:443 HTTP/1.1\r\nProxy-Authorization: Basic {}\r\n\r\n",
        basic(&token_of(&ticket.url()))
    );
    let _ = stream.write_all(request.as_bytes()).await;
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    drop(ticket);
    assert!(closes(&mut stream, std::time::Duration::from_secs(1)).await);
}

#[tokio::test]
async fn connections_past_the_limit_are_closed_before_any_work_and_slots_free_again() {
    let setup = bounded(Limits {
        connections: 2,
        ..Limits::default()
    })
    .await;
    let address = ("127.0.0.1", setup.proxy.port());
    let first = TcpStream::connect(address).await.ok();
    let second = TcpStream::connect(address).await.ok();
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let mut third = TcpStream::connect(address)
        .await
        .unwrap_or_else(|_| std::process::abort());
    assert!(closes(&mut third, std::time::Duration::from_secs(1)).await);
    drop((first, second));
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    let answer = ask(&setup.proxy, "CONNECT example.org:443 HTTP/1.1\r\n\r\n").await;
    assert!(answer.starts_with("HTTP/1.1 407"), "{answer}");
}

#[tokio::test]
async fn a_client_that_never_sends_its_head_is_closed() {
    let setup = bounded(Limits {
        head: std::time::Duration::from_millis(200),
        ..Limits::default()
    })
    .await;
    let mut stream = TcpStream::connect(("127.0.0.1", setup.proxy.port()))
        .await
        .unwrap_or_else(|_| std::process::abort());
    assert!(closes(&mut stream, std::time::Duration::from_secs(1)).await);
}

#[tokio::test]
async fn a_run_has_at_most_its_cap_of_tunnels_open() {
    // A closed tunnel whose host keeps its half open frees its slot at the idle limit.
    let setup = bounded(Limits {
        per_session: 2,
        idle: std::time::Duration::from_millis(300),
        ..Limits::default()
    })
    .await;
    let port = holding().await;
    let ticket = setup
        .proxy
        .open("bot1", "run1", allowing(format!("127.0.0.1:{port}")));
    let token = token_of(&ticket.url());
    let one = tunnel(&setup.proxy, port, &token).await;
    let two = tunnel(&setup.proxy, port, &token).await;
    assert!(one.is_ok() && two.is_ok());
    let three = tunnel(&setup.proxy, port, &token).await;
    assert!(
        three
            .as_ref()
            .err()
            .is_some_and(|a| a.starts_with("HTTP/1.1 429")),
        "{:?}",
        three.err()
    );
    drop(one);
    tokio::time::sleep(std::time::Duration::from_millis(800)).await;
    assert!(tunnel(&setup.proxy, port, &token).await.is_ok());
}

#[tokio::test]
async fn an_idle_tunnel_is_closed() {
    let setup = bounded(Limits {
        idle: std::time::Duration::from_millis(300),
        ..Limits::default()
    })
    .await;
    let port = holding().await;
    let ticket = setup
        .proxy
        .open("bot1", "run1", allowing(format!("127.0.0.1:{port}")));
    let mut stream = tunnel(&setup.proxy, port, &token_of(&ticket.url()))
        .await
        .unwrap_or_else(|why| panic!("{why}"));
    assert!(closes(&mut stream, std::time::Duration::from_secs(2)).await);
}

#[tokio::test]
async fn a_tunnel_is_logged_when_admitted_and_its_bytes_as_it_runs() {
    let setup = bounded(Limits {
        progress: std::time::Duration::from_millis(100),
        ..Limits::default()
    })
    .await;
    let port = holding().await;
    let ticket = setup
        .proxy
        .open("bot1", "run1", allowing(format!("127.0.0.1:{port}")));
    let mut stream = tunnel(&setup.proxy, port, &token_of(&ticket.url()))
        .await
        .unwrap_or_else(|why| panic!("{why}"));
    let opened = any_logged(&setup.log, "bot1").await;
    assert_eq!(opened.first().map(|e| e.phase.as_str()), Some("opened"));
    let _ = stream.write_all(b"hello").await;
    let mut echo = [0u8; 5];
    let _ = stream.read_exact(&mut echo).await;
    // Counted as it moves, while the tunnel is still open.
    assert_eq!((ticket.usage().sent, ticket.usage().received), (5, 5));
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let entries = setup.log.read("bot1", usize::MAX);
    let progress = entries.iter().find(|e| e.phase == "progress");
    assert!(
        progress.is_some_and(|e| e.sent == 5 && e.received == 5),
        "{entries:?}"
    );
    assert!(entries.iter().all(|e| e.phase != "closed"));
}
