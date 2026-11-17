//! Real-process tests of Spade's Windows sandbox (ADR 0167 decision 1): small commands run inside
//! a throwaway AppContainer and must be held to what its policy allows — writes only in granted
//! folders, no credential or other-user reads, network only through the egress bridge to the
//! proxy, a job that kills the tree on stop, and ACLs that are cleaned up after a crash. Each test
//! makes and deletes its own AppContainer profile, so nothing real is touched.
#![cfg(windows)]

use std::ffi::OsString;
use std::os::windows::io::AsRawHandle;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use spade_sandbox::egress::{EgressLog, Mode, NetworkPolicy, Proxy, SystemResolver};
use spade_sandbox::windows::Container;
use spade_sandbox_windows::acl::{self, Access};
use spade_sandbox_windows::fs::Object;
use spade_sandbox_windows::job::{Job, Limits};
use spade_sandbox_windows::sid::Sid;
use spade_sandbox_windows::{launch, profile};

/// Deletes its AppContainer profile when dropped, so tests leave none behind.
struct Profile(Container);
impl Drop for Profile {
    fn drop(&mut self) {
        let _ = profile::delete(&self.0.name);
    }
}

fn container() -> (Container, Profile) {
    let name = format!("spade.test.{}", uuid::Uuid::new_v4().simple());
    let container = Container {
        name: name.clone(),
        display: "Spade sandbox test".to_owned(),
    };
    (container.clone(), Profile(container))
}

/// The test helper binary, and its folder (granted read-execute so the container can run it).
fn helper() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_scw_helper"))
}

fn grant(path: &Path, sid: &Sid, access: Access) {
    let object = Object::open(path).unwrap_or_else(|e| panic!("open {}: {e}", path.display()));
    acl::grant(&object, sid, access).unwrap_or_else(|e| panic!("grant {}: {e}", path.display()));
}

fn limits() -> Limits {
    Limits {
        active_processes: 64,
        memory_bytes: 2 * 1024 * 1024 * 1024,
    }
}

/// Runs the helper with `args` in `container`, granting its own folder read-execute first.
fn run_helper(container: &Container, sid: &Sid, args: &[&str]) -> u32 {
    let dir = helper();
    grant(
        dir.parent().unwrap_or_else(|| std::process::abort()),
        sid,
        Access::Read,
    );
    let args: Vec<OsString> = args.iter().map(OsString::from).collect();
    launch::run(
        &container.name,
        &container.display,
        limits(),
        None,
        helper().as_os_str(),
        &args,
    )
    .unwrap_or_else(|e| panic!("launch: {e}"))
}

#[test]
fn writes_land_only_in_granted_folders_and_denies_bite_inside_them() {
    let dir = tempfile::tempdir().unwrap_or_else(|_| std::process::abort());
    let workspace = dir.path().join("ws");
    let outside = dir.path().join("outside");
    let secret = workspace.join("secret");
    std::fs::create_dir_all(&secret).unwrap_or_else(|_| std::process::abort());
    std::fs::create_dir_all(&outside).unwrap_or_else(|_| std::process::abort());

    let (container, _profile) = container();
    let sid = profile::ensure(&container.name, &container.display)
        .unwrap_or_else(|_| std::process::abort());
    grant(&workspace, &sid, Access::Write);
    // A credential-like place inside the granted workspace: denied on top.
    grant(&secret, &sid, Access::Deny);

    let inside = workspace.join("a.txt");
    assert_eq!(
        run_helper(&container, &sid, &["write", &inside.to_string_lossy()]),
        0,
        "a write in the workspace should succeed"
    );
    assert!(inside.exists());

    assert_eq!(
        run_helper(
            &container,
            &sid,
            &["write", &outside.join("b.txt").to_string_lossy()]
        ),
        2,
        "a write outside every granted folder should fail"
    );
    assert!(!outside.join("b.txt").exists());

    assert_eq!(
        run_helper(&container, &sid, &["ls", &secret.to_string_lossy()]),
        2,
        "a denied folder inside the workspace should not be readable"
    );
}

#[test]
fn other_users_and_the_home_folder_cannot_be_read() {
    let (container, _profile) = container();
    let sid = profile::ensure(&container.name, &container.display)
        .unwrap_or_else(|_| std::process::abort());
    // Nothing under the real profile is granted, so the container can't list it.
    let home = std::env::var("USERPROFILE").unwrap_or_else(|_| std::process::abort());
    assert_eq!(
        run_helper(&container, &sid, &["ls", &home]),
        2,
        "the person's home folder should be unreadable"
    );
    assert_eq!(
        run_helper(&container, &sid, &["ls", r"C:\Users"]),
        2,
        "other users' folders should be unreadable"
    );
}

#[test]
fn a_job_kills_its_tree_when_it_is_dropped() {
    let job = Job::create(limits()).unwrap_or_else(|_| std::process::abort());
    // A process that would run for ~30s if left alone.
    let mut child = std::process::Command::new(format!(
        r"{}\System32\cmd.exe",
        std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_owned())
    ))
    .args(["/c", "ping -n 30 127.0.0.1 >nul"])
    .spawn()
    .unwrap_or_else(|_| std::process::abort());
    job.assign(child.as_raw_handle())
        .unwrap_or_else(|_| std::process::abort());
    drop(job);
    // Closing the job's last handle with kill-on-close ends the tree at once.
    let began = Instant::now();
    loop {
        if let Some(_status) = child.try_wait().unwrap_or_else(|_| std::process::abort()) {
            break;
        }
        assert!(
            began.elapsed() < Duration::from_secs(10),
            "the job should have killed the process"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// A local HTTP server that answers `200 OK` to any request; the host the test's proxy allows.
async fn upstream() -> (u16, tokio::task::JoinHandle<()>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap_or_else(|_| std::process::abort());
    let port = listener
        .local_addr()
        .unwrap_or_else(|_| std::process::abort())
        .port();
    let handle = tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            tokio::spawn(async move {
                let mut buf = [0u8; 1024];
                let _ = socket.read(&mut buf).await;
                let _ = socket
                    .write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
                    )
                    .await;
                let _ = socket.shutdown().await;
            });
        }
    });
    (port, handle)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn curl_reaches_an_allowed_host_through_the_proxy_but_nothing_reaches_it_directly() {
    let (container, _profile) = container();
    let sid = profile::ensure(&container.name, &container.display)
        .unwrap_or_else(|_| std::process::abort());
    grant(
        helper().parent().unwrap_or_else(|| std::process::abort()),
        &sid,
        Access::Read,
    );

    // A local "internet" host, and the real proxy allowed to reach it.
    let (srv_port, _srv) = upstream().await;
    let log_dir =
        std::env::temp_dir().join(format!("spade-egress-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&log_dir).unwrap_or_else(|_| std::process::abort());
    let proxy = Proxy::start(
        Arc::new(EgressLog::new(log_dir.clone())),
        Arc::new(SystemResolver),
        Arc::new(|| 0),
        Arc::new(|| uuid::Uuid::new_v4().simple().to_string()),
    )
    .await
    .unwrap_or_else(|_| std::process::abort());
    let policy = NetworkPolicy {
        mode: Mode::AllowList,
        // A literal local host with its port: the one way a private address is allowed.
        allow: vec![format!("127.0.0.1:{srv_port}")],
        dropped: Vec::new(),
    };
    let ticket = proxy.open(&container.name, "run1", policy);

    // The in-container bridge's loopback port, and the daemon-side acceptor splicing to the proxy.
    let cmd_port = free_port();
    let pipe = format!("spade-test-{}", uuid::Uuid::new_v4().simple());
    let stop = spade_sandbox::windows::bridge::Stop::new();
    {
        let (name, s, pport, st) = (pipe.clone(), sid.clone(), proxy.port(), stop.clone());
        tokio::spawn(async move {
            spade_sandbox::windows::bridge::serve(&name, &s, pport, &st).await;
        });
    }

    let curl = format!(
        r"{}\System32\curl.exe",
        std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_owned())
    );
    let proxy_url = ticket.url_on(cmd_port);
    let target = format!("http://127.0.0.1:{srv_port}/");

    // Through the proxy: curl --fail exits 0 only on a 2xx, so this proves the whole path works.
    let (name, display) = (container.name.clone(), container.display.clone());
    let bridge = launch::Bridge {
        pipe: pipe.clone(),
        port: cmd_port,
    };
    let helper_exe = helper();
    let (c2, t2, px, tg) = (
        name.clone(),
        display.clone(),
        proxy_url.clone(),
        target.clone(),
    );
    let through = tokio::task::spawn_blocking(move || {
        // --retry-all-errors so curl retries while the in-container bridge process is still
        // starting its listener (the bridge and curl launch together in the same job).
        let args: Vec<OsString> = [
            "-sS",
            "--fail",
            "--max-time",
            "40",
            "--retry",
            "15",
            "--retry-all-errors",
            "--retry-delay",
            "1",
            "-o",
            "NUL",
            "-x",
            px.as_str(),
            tg.as_str(),
        ]
        .iter()
        .map(OsString::from)
        .collect();
        launch::run_with(
            &c2,
            &t2,
            limits(),
            Some(bridge),
            Some(&helper_exe),
            std::ffi::OsStr::new(&curl),
            &args,
        )
    })
    .await
    .unwrap_or_else(|_| std::process::abort())
    .unwrap_or_else(|_| std::process::abort());
    assert_eq!(through, 0, "curl through the proxy should get 200");

    // Directly, with no bridge and no network: the same host can't be reached at all.
    let direct = run_helper(
        &container,
        &sid,
        &["connect", &format!("127.0.0.1:{srv_port}")],
    );
    assert_eq!(direct, 2, "a direct connection should be refused");

    stop.stop();
    drop(ticket);
    let _ = std::fs::remove_dir_all(&log_dir);
}

/// The bridge path on its own, no AppContainer and no proxy: a plain client → in-container bridge
/// → pipe → acceptor → echo server. Isolates the pipe splice.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_bridge_splices_bytes_both_ways() {
    use std::io::{Read, Write};

    // An echo "upstream": read a line, write it back.
    let echo =
        std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap_or_else(|_| std::process::abort());
    let echo_port = echo
        .local_addr()
        .unwrap_or_else(|_| std::process::abort())
        .port();
    std::thread::spawn(move || {
        for stream in echo.incoming() {
            let Ok(mut stream) = stream else { continue };
            std::thread::spawn(move || {
                let mut buf = [0u8; 16];
                if let Ok(n) = stream.read(&mut buf) {
                    let _ = stream.write_all(&buf[..n]);
                }
            });
        }
    });

    // The acceptor, with the pipe open to Everyone so a plain client can reach it in this test.
    let sid = Sid::parse("S-1-1-0").unwrap_or_else(|_| std::process::abort());
    let pipe = format!("spade-test-{}", uuid::Uuid::new_v4().simple());
    let stop = spade_sandbox::windows::bridge::Stop::new();
    {
        let (name, st) = (pipe.clone(), stop.clone());
        tokio::spawn(async move {
            spade_sandbox::windows::bridge::serve(&name, &sid, echo_port, &st).await;
        });
    }

    // The in-container bridge, run here as a plain process on a loopback port.
    let port = free_port();
    let pipe2 = pipe.clone();
    std::thread::spawn(move || spade_sandbox::windows::bridge::in_container(&pipe2, port));
    std::thread::sleep(Duration::from_millis(300));

    let got = tokio::task::spawn_blocking(move || {
        let mut stream = std::net::TcpStream::connect(("127.0.0.1", port))
            .unwrap_or_else(|_| std::process::abort());
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap_or_else(|_| std::process::abort());
        stream
            .write_all(b"hello")
            .unwrap_or_else(|_| std::process::abort());
        let mut buf = [0u8; 5];
        stream
            .read_exact(&mut buf)
            .unwrap_or_else(|_| std::process::abort());
        buf
    })
    .await
    .unwrap_or_else(|_| std::process::abort());
    stop.stop();
    assert_eq!(&got, b"hello", "the bridge should carry bytes both ways");
}

fn free_port() -> u16 {
    std::net::TcpListener::bind(("127.0.0.1", 0))
        .unwrap_or_else(|_| std::process::abort())
        .local_addr()
        .unwrap_or_else(|_| std::process::abort())
        .port()
}

#[test]
fn acls_are_taken_back_after_a_crash_and_when_a_bot_is_forgotten() {
    let journal = tempfile::tempdir().unwrap_or_else(|_| std::process::abort());
    let work = tempfile::tempdir().unwrap_or_else(|_| std::process::abort());
    let folder = work.path().join("project");
    std::fs::create_dir_all(&folder).unwrap_or_else(|_| std::process::abort());

    let (container, _profile) = container();
    let grants = vec![spade_sandbox::windows::Grant {
        path: folder.clone(),
        access: spade_sandbox::windows::Access::Write,
    }];

    // A run applies the grant and records it.
    let sid = spade_sandbox::windows::acls::reconcile(journal.path(), &container, &grants)
        .unwrap_or_else(|_| std::process::abort());
    assert!(
        acl::granted(
            &Object::open(&folder).unwrap_or_else(|_| std::process::abort()),
            &sid
        )
        .unwrap_or_else(|_| std::process::abort()),
        "the grant should be on the folder"
    );

    // Crash: nothing cleaned up. The next start recovers and takes the grant back.
    spade_sandbox::windows::acls::recover(journal.path());
    assert!(
        !acl::granted(
            &Object::open(&folder).unwrap_or_else(|_| std::process::abort()),
            &sid
        )
        .unwrap_or_else(|_| std::process::abort()),
        "recovery should have taken the grant back"
    );
    assert!(
        spade_sandbox::windows::acls::Journal::load(journal.path(), &container)
            .paths
            .is_empty(),
        "the journal should be cleared after recovery"
    );

    // Granting again and then forgetting the bot also takes it back.
    let sid = spade_sandbox::windows::acls::reconcile(journal.path(), &container, &grants)
        .unwrap_or_else(|_| std::process::abort());
    assert!(
        acl::granted(
            &Object::open(&folder).unwrap_or_else(|_| std::process::abort()),
            &sid
        )
        .unwrap_or_else(|_| std::process::abort())
    );
    spade_sandbox::windows::acls::forget(journal.path(), &container);
    assert!(
        !acl::granted(
            &Object::open(&folder).unwrap_or_else(|_| std::process::abort()),
            &sid
        )
        .unwrap_or_else(|_| std::process::abort())
    );
}
