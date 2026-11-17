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
fn writes_land_only_in_a_granted_folder_and_nothing_else_is_reachable() {
    let dir = tempfile::tempdir().unwrap_or_else(|_| std::process::abort());
    // A Spade-owned folder is granted; a sibling, standing in for the person's folders, is not.
    let workspace = dir.path().join("ws");
    let outside = dir.path().join("outside");
    std::fs::create_dir_all(&workspace).unwrap_or_else(|_| std::process::abort());
    std::fs::create_dir_all(&outside).unwrap_or_else(|_| std::process::abort());

    let (container, _profile) = container();
    let sid = profile::ensure(&container.name, &container.display)
        .unwrap_or_else(|_| std::process::abort());
    grant(&workspace, &sid, Access::Write);

    let inside = workspace.join("a.txt");
    assert_eq!(
        run_helper(&container, &sid, &["write", &inside.to_string_lossy()]),
        0,
        "a write in the granted folder should succeed"
    );
    assert!(inside.exists());

    assert_eq!(
        run_helper(
            &container,
            &sid,
            &["write", &outside.join("b.txt").to_string_lossy()]
        ),
        2,
        "a write to an ungranted folder should fail"
    );
    assert!(!outside.join("b.txt").exists());

    assert_eq!(
        run_helper(&container, &sid, &["ls", &outside.to_string_lossy()]),
        2,
        "an ungranted folder should not be readable"
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
fn an_lpac_run_does_not_reach_a_file_granted_only_to_all_application_packages() {
    // A folder and file readable by ALL APPLICATION PACKAGES but never by the run's own container
    // SID. An ordinary AppContainer carries the ALL APPLICATION PACKAGES SID and would read it; a
    // Less Privileged AppContainer opts that SID out, so granting it buys the run nothing. This is
    // the LPAC guarantee that keeps system-wide, app-package-readable files out of reach — a
    // stronger statement than the ungranted-folder case, because here the folder *is* granted.
    let dir = tempfile::tempdir().unwrap_or_else(|_| std::process::abort());
    let secret = dir.path().join("secret.txt");
    std::fs::write(&secret, b"top secret").unwrap_or_else(|_| std::process::abort());
    // S-1-15-2-1 is ALL APPLICATION PACKAGES.
    let all_packages = Sid::parse("S-1-15-2-1").unwrap_or_else(|_| std::process::abort());
    for path in [dir.path(), secret.as_path()] {
        let object = Object::open(path).unwrap_or_else(|_| std::process::abort());
        acl::grant(&object, &all_packages, Access::Read).unwrap_or_else(|_| std::process::abort());
    }

    let (container, _profile) = container();
    let sid = profile::ensure(&container.name, &container.display)
        .unwrap_or_else(|_| std::process::abort());
    // The container SID is granted nothing on the secret; only ALL APPLICATION PACKAGES is.
    assert_eq!(
        run_helper(&container, &sid, &["read", &secret.to_string_lossy()]),
        2,
        "a Less Privileged AppContainer must not read an ALL APPLICATION PACKAGES file"
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
        let (ready, _rx) = std::sync::mpsc::sync_channel(1);
        tokio::spawn(async move {
            spade_sandbox::windows::bridge::serve(&name, &s, pport, &st, ready).await;
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

    // Directly, with no bridge and no network: the same host can't be reached at all. A no-network
    // run is a Less Privileged AppContainer, which can't even initialise Winsock, so the refusal may
    // surface as a failed socket set-up rather than a refused connect — either way it is never
    // reached, so the run does not exit success.
    let direct = run_helper(
        &container,
        &sid,
        &["connect", &format!("127.0.0.1:{srv_port}")],
    );
    assert_ne!(direct, 0, "a direct connection should be refused");

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
    let (ready, ready_rx) = std::sync::mpsc::sync_channel(1);
    {
        let (name, st) = (pipe.clone(), stop.clone());
        tokio::spawn(async move {
            spade_sandbox::windows::bridge::serve(&name, &sid, echo_port, &st, ready).await;
        });
    }
    // The acceptor acknowledges it is listening before we drive bytes through it.
    assert_eq!(
        ready_rx.recv_timeout(Duration::from_secs(5)),
        Ok(true),
        "the bridge acceptor should report ready"
    );

    // The in-container bridge, run here as a plain process on a loopback port.
    let port = free_port();
    let pipe2 = pipe.clone();
    std::thread::spawn(move || spade_sandbox::windows::bridge::in_container(&pipe2, port, 0));
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

// ---- Group B: per-run identity, durable revocation by object id (review 3, 4) ----

use spade_sandbox::windows::acls;
use spade_sandbox::windows::{Access as WAccess, Grant as WGrant};

fn with_profile(container: &Container) -> Profile {
    Profile(container.clone())
}

#[test]
fn two_runs_of_a_bot_get_distinct_identities() {
    let a = Container::for_run("bot1", "run-a");
    let b = Container::for_run("bot1", "run-b");
    assert_ne!(a.name, b.name, "each run gets its own AppContainer name");
    assert_ne!(
        profile::ensure(&a.name, &a.display)
            .map(|s| s.to_string())
            .ok(),
        profile::ensure(&b.name, &b.display)
            .map(|s| s.to_string())
            .ok(),
        "each run's SID differs",
    );
    let _ = profile::delete(&a.name);
    let _ = profile::delete(&b.name);
}

#[test]
fn a_run_is_recovered_by_object_identity_even_after_the_folder_moves() {
    let journal = tempfile::tempdir().unwrap_or_else(|_| std::process::abort());
    let work = tempfile::tempdir().unwrap_or_else(|_| std::process::abort());
    let folder = work.path().join("project");
    std::fs::create_dir_all(&folder).unwrap_or_else(|_| std::process::abort());
    let container = Container::for_run("botM", "run1");
    let _p = with_profile(&container);
    let grants = vec![WGrant {
        path: folder.clone(),
        access: WAccess::Write,
    }];

    let sid = acls::reconcile(journal.path(), "botM", &container, &grants)
        .unwrap_or_else(|_| std::process::abort());
    assert!(
        acl::granted(
            &Object::open_pinned(&folder).unwrap_or_else(|_| std::process::abort()),
            &sid
        )
        .unwrap_or_else(|_| std::process::abort()),
        "the grant should be on the folder"
    );

    // The folder is renamed (same volume keeps its file id), then a crash: nothing cleaned up.
    let moved = work.path().join("renamed");
    std::fs::rename(&folder, &moved).unwrap_or_else(|_| std::process::abort());

    // Recovery takes the grant back by the object's identity, finding it at its new path.
    acls::recover(journal.path());
    assert!(
        !acl::granted(
            &Object::open_pinned(&moved).unwrap_or_else(|_| std::process::abort()),
            &sid
        )
        .unwrap_or_else(|_| std::process::abort()),
        "recovery should take the grant back from the moved object"
    );
    // The journal is gone once every grant is taken back and the profile deleted.
    assert!(
        acls::Journal::read(journal.path(), &container)
            .unwrap_or_else(|_| std::process::abort())
            .is_none()
    );
    assert!(!acls::stuck(journal.path(), "botM"));
}

#[test]
fn cleanup_restores_an_owned_folder_and_removes_the_profile() {
    let journal = tempfile::tempdir().unwrap_or_else(|_| std::process::abort());
    let work = tempfile::tempdir().unwrap_or_else(|_| std::process::abort());
    let folder = work.path().join("workspace");
    std::fs::create_dir_all(&folder).unwrap_or_else(|_| std::process::abort());
    let container = Container::for_run("botR", "run1");
    let _p = with_profile(&container);
    let grants = vec![WGrant {
        path: folder.clone(),
        access: WAccess::Write,
    }];

    let obj = Object::open_pinned(&folder).unwrap_or_else(|_| std::process::abort());
    let sid = acls::reconcile(journal.path(), "botR", &container, &grants)
        .unwrap_or_else(|_| std::process::abort());
    assert!(acl::granted(&obj, &sid).unwrap_or_else(|_| std::process::abort()));

    // Cleanup takes the grant back exactly: the folder has no ACE for the SID again, and the
    // journal is gone (profile deleted).
    acls::cleanup(journal.path(), &container).unwrap_or_else(|_| std::process::abort());
    let obj = Object::open_pinned(&folder).unwrap_or_else(|_| std::process::abort());
    assert!(
        !acl::granted(&obj, &sid).unwrap_or_else(|_| std::process::abort()),
        "cleanup should leave no ACE for the run's SID"
    );
    assert!(
        acls::Journal::read(journal.path(), &container)
            .unwrap_or_else(|_| std::process::abort())
            .is_none(),
        "the journal is removed only after revocation and profile deletion both succeed"
    );
}

#[test]
fn a_revocation_that_cannot_be_confirmed_gates_the_bot() {
    let journal = tempfile::tempdir().unwrap_or_else(|_| std::process::abort());
    let work = tempfile::tempdir().unwrap_or_else(|_| std::process::abort());
    let folder = work.path().join("project");
    std::fs::create_dir_all(&folder).unwrap_or_else(|_| std::process::abort());
    let container = Container::for_run("botS", "run1");
    let _p = with_profile(&container);
    let grants = vec![WGrant {
        path: folder.clone(),
        access: WAccess::Write,
    }];
    acls::reconcile(journal.path(), "botS", &container, &grants)
        .unwrap_or_else(|_| std::process::abort());

    // Delete the folder and put a junction in its place: the granted object is gone (so it can't
    // be found by id) and the path now holds a reparse point we must refuse. The revocation can't
    // be confirmed.
    std::fs::remove_dir_all(&folder).unwrap_or_else(|_| std::process::abort());
    let elsewhere = work.path().join("elsewhere");
    std::fs::create_dir_all(&elsewhere).unwrap_or_else(|_| std::process::abort());
    junction(&folder, &elsewhere);

    assert!(
        acls::cleanup(journal.path(), &container).is_err(),
        "an unconfirmable revocation must be reported, not swallowed"
    );
    assert!(
        acls::stuck(journal.path(), "botS"),
        "the bot is gated while the revoke is pending"
    );
    // A new run of the same bot is refused until the pending revocation clears.
    let container2 = Container::for_run("botS", "run2");
    let _p2 = with_profile(&container2);
    assert!(
        acls::reconcile(journal.path(), "botS", &container2, &grants).is_err(),
        "the bot's next run is refused while cleanup is stuck"
    );
}

// ---- Group A: pinned-handle grants, exact rights, inheritance (review 1, 2, 5) ----

const MODIFY: u32 = 0x1301BF;
const READ_EXECUTE: u32 = 0x1200A9;

/// `mklink /J <link> <target>` makes a directory junction (a reparse point) without privilege.
fn junction(link: &Path, target: &Path) {
    let status = std::process::Command::new(format!(
        r"{}\System32\cmd.exe",
        std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_owned())
    ))
    .args([
        "/c",
        "mklink",
        "/J",
        &link.to_string_lossy(),
        &target.to_string_lossy(),
    ])
    .status()
    .unwrap_or_else(|_| std::process::abort());
    assert!(status.success(), "mklink /J failed");
}

#[test]
fn open_pinned_refuses_a_reparse_point_in_the_path() {
    let dir = tempfile::tempdir().unwrap_or_else(|_| std::process::abort());
    let real = dir.path().join("real");
    std::fs::create_dir_all(real.join("sub")).unwrap_or_else(|_| std::process::abort());
    let link = dir.path().join("jlink");
    junction(&link, &real);

    // The old opener (last component only) traverses the junction; the pinned walk refuses it.
    assert!(
        Object::open(&link.join("sub")).is_ok(),
        "the plain opener follows the junction"
    );
    assert!(
        Object::open_pinned(&link.join("sub")).is_err(),
        "a path through a junction must be refused"
    );
    assert!(
        Object::open_pinned(&link).is_err(),
        "the junction itself must be refused"
    );
    // The real path, with no reparse point, is accepted.
    assert!(Object::open_pinned(&real.join("sub")).is_ok());
}

#[test]
fn open_pinned_and_grant_work_without_write_dac_on_ancestors() {
    // Green as admin, but its point is the standard-user run in the VM: walking to the target
    // opens C:\ and the other ancestors with traverse access only, not WRITE_DAC (which a standard
    // user lacks there). The ACL rights are asked for only on the final, Spade-owned folder.
    let dir = tempfile::tempdir().unwrap_or_else(|_| std::process::abort());
    let folder = dir.path().join("owned");
    std::fs::create_dir_all(&folder).unwrap_or_else(|_| std::process::abort());
    let sid = Sid::parse("S-1-1-0").unwrap_or_else(|_| std::process::abort());

    let object = Object::open_pinned(&folder)
        .unwrap_or_else(|e| panic!("open_pinned walked the ancestors: {e}"));
    acl::grant(&object, &sid, Access::Write)
        .unwrap_or_else(|e| panic!("granted on the owned folder: {e}"));
    assert!(acl::granted(&object, &sid).unwrap_or_else(|_| std::process::abort()));
}

#[test]
fn a_grant_from_write_to_read_is_reconciled_to_exact_rights() {
    let dir = tempfile::tempdir().unwrap_or_else(|_| std::process::abort());
    let folder = dir.path().join("folder");
    std::fs::create_dir_all(&folder).unwrap_or_else(|_| std::process::abort());
    let (container, _profile) = container();
    let sid = profile::ensure(&container.name, &container.display)
        .unwrap_or_else(|_| std::process::abort());

    let object = Object::open_pinned(&folder).unwrap_or_else(|_| std::process::abort());
    acl::grant(&object, &sid, Access::Write).unwrap_or_else(|_| std::process::abort());
    assert_eq!(
        acl::allow_mask(&object, &sid).unwrap_or_else(|_| std::process::abort()),
        Some(MODIFY),
        "a write grant should carry Modify"
    );
    acl::grant(&object, &sid, Access::Read).unwrap_or_else(|_| std::process::abort());
    assert_eq!(
        acl::allow_mask(&object, &sid).unwrap_or_else(|_| std::process::abort()),
        Some(READ_EXECUTE),
        "changing to read must leave exactly Read&execute, not a merge that keeps Modify"
    );
}

#[test]
fn revoking_a_parent_removes_the_inherited_ace_on_a_descendant() {
    let dir = tempfile::tempdir().unwrap_or_else(|_| std::process::abort());
    let parent = dir.path().join("parent");
    let child = parent.join("child");
    std::fs::create_dir_all(&child).unwrap_or_else(|_| std::process::abort());
    let (container, _profile) = container();
    let sid = profile::ensure(&container.name, &container.display)
        .unwrap_or_else(|_| std::process::abort());

    let parent_obj = Object::open_pinned(&parent).unwrap_or_else(|_| std::process::abort());
    acl::grant(&parent_obj, &sid, Access::Write).unwrap_or_else(|_| std::process::abort());
    let child_obj = Object::open_pinned(&child).unwrap_or_else(|_| std::process::abort());
    assert!(
        acl::inherited(&child_obj, &sid).unwrap_or_else(|_| std::process::abort()),
        "the child should inherit the parent's ACE"
    );

    acl::revoke(&parent_obj, &sid).unwrap_or_else(|_| std::process::abort());
    let child_obj = Object::open_pinned(&child).unwrap_or_else(|_| std::process::abort());
    assert!(
        !acl::inherited(&child_obj, &sid).unwrap_or_else(|_| std::process::abort()),
        "revoking the parent must remove the inherited ACE on the child"
    );
}

// ---- Group C: readiness acknowledgements, fail closed (review 6) ----

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_bridge_acceptor_acknowledges_success_and_failure() {
    let sid = Sid::parse("S-1-1-0").unwrap_or_else(|_| std::process::abort());
    let pipe = format!("spade-ready-{}", uuid::Uuid::new_v4().simple());

    // The first acceptor on this pipe name comes up and says so.
    let first = spade_sandbox::windows::bridge::Stop::new();
    let (ready1, rx1) = std::sync::mpsc::sync_channel(1);
    {
        let (name, st, s) = (pipe.clone(), first.clone(), sid.clone());
        tokio::spawn(async move {
            spade_sandbox::windows::bridge::serve(&name, &s, 9, &st, ready1).await;
        });
    }
    assert_eq!(
        rx1.recv_timeout(Duration::from_secs(5)),
        Ok(true),
        "the first acceptor should report ready"
    );

    // A second acceptor on the same name can't make the first pipe instance, and says so rather
    // than failing silently.
    let second = spade_sandbox::windows::bridge::Stop::new();
    let (ready2, rx2) = std::sync::mpsc::sync_channel(1);
    {
        let (name, st, s) = (pipe.clone(), second.clone(), sid.clone());
        tokio::spawn(async move {
            spade_sandbox::windows::bridge::serve(&name, &s, 9, &st, ready2).await;
        });
    }
    assert_eq!(
        rx2.recv_timeout(Duration::from_secs(5)),
        Ok(false),
        "a bridge that can't come up must report failure, not run silently"
    );
    first.stop();
    second.stop();
}

#[test]
fn the_launcher_fails_closed_when_the_in_container_bridge_cannot_bind() {
    // Occupy the loopback port so the in-container bridge can't bind it and never acknowledges.
    let occupied =
        std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap_or_else(|_| std::process::abort());
    let port = occupied
        .local_addr()
        .unwrap_or_else(|_| std::process::abort())
        .port();

    let (container, _profile) = container();
    let sid = profile::ensure(&container.name, &container.display)
        .unwrap_or_else(|_| std::process::abort());
    grant(
        helper().parent().unwrap_or_else(|| std::process::abort()),
        &sid,
        Access::Read,
    );
    let bridge = launch::Bridge {
        pipe: format!("spade-noack-{}", uuid::Uuid::new_v4().simple()),
        port,
    };
    let cmd = format!(
        r"{}\System32\cmd.exe",
        std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_owned())
    );
    let result = launch::run_with(
        &container.name,
        &container.display,
        limits(),
        Some(bridge),
        Some(&helper()),
        std::ffi::OsStr::new(&cmd),
        &[OsString::from("/c"), OsString::from("exit 0")],
    );
    assert!(
        result.is_err(),
        "the run must fail closed when the bridge can't bind its loopback port, not run the command"
    );
}

// ---- Group F: containability proven by file identity, not string prefix (review 3, item 5) ----

#[test]
fn only_spade_owned_and_system_toolchains_are_containable() {
    use spade_sandbox::policy::real;
    use spade_sandbox::windows::{Containability, containable};

    // Spade's own data directory, with a workspace and a scratch folder inside it.
    let data_dir = tempfile::tempdir().unwrap_or_else(|_| std::process::abort());
    let spade_data = real(data_dir.path());
    let workspace = spade_data.join("workspace/bot1");
    std::fs::create_dir_all(&workspace).unwrap_or_else(|_| std::process::abort());
    let scratch = spade_data.join("terminal/bot1");
    std::fs::create_dir_all(&scratch).unwrap_or_else(|_| std::process::abort());

    // A known system root and a toolchain that really lives inside it.
    let system_root = real(Path::new(
        &std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_owned()),
    ));
    let system_tool = system_root.join("System32");
    let system_roots = [system_root.clone()];

    // A folder that is neither under Spade's data nor under any system root.
    let outside = tempfile::tempdir().unwrap_or_else(|_| std::process::abort());
    let outside_tool = outside.path().join("bin");
    std::fs::create_dir_all(&outside_tool).unwrap_or_else(|_| std::process::abort());

    let spec = |workspace: &Path,
                scratch: &[PathBuf],
                consented: &[PathBuf],
                toolchains: &[PathBuf]|
     -> bool {
        containable(&Containability {
            workspace,
            scratch,
            consented,
            toolchains,
            plugin_root: None,
            spade_data: &spade_data,
            system_roots: &system_roots,
        })
    };

    use std::slice::from_ref;
    let owned_scratch = from_ref(&scratch);
    let system = from_ref(&system_tool);
    let consented_person = outside.path().to_path_buf();

    // Baseline: an owned workspace and scratch, with a toolchain in a known system root.
    assert!(
        spec(&workspace, owned_scratch, &[], system),
        "an owned workspace and a system-root toolchain are containable"
    );

    // A toolchain on another tree (not under Spade's data, not under a system root) is refused,
    // even though a string prefix of Spade's data would never have matched it anyway — identity
    // proves it, so a path on another drive or a UNC path is refused the same way.
    assert!(
        !spec(&workspace, owned_scratch, &[], from_ref(&outside_tool)),
        "a toolchain outside Spade's data and every system root is not containable"
    );

    // Any consented folder of the person's makes the run not containable.
    assert!(
        !spec(
            &workspace,
            owned_scratch,
            from_ref(&consented_person),
            system
        ),
        "a consented person folder is never containable"
    );

    // A workspace that is not inside Spade's data is refused.
    assert!(
        !spec(outside.path(), &[], &[], system),
        "a workspace outside Spade's data is not containable"
    );

    // A scratch folder outside Spade's data is refused.
    assert!(
        !spec(&workspace, from_ref(&outside_tool), &[], system),
        "a scratch folder outside Spade's data is not containable"
    );

    // A required place that is missing fails: identity can't be proven for a path that isn't there.
    assert!(
        !spec(&spade_data.join("gone"), &[], &[], system),
        "a missing workspace is not containable"
    );

    // A toolchain reached through a junction that lands inside Spade's data is refused: the walk
    // meets a reparse point and refuses it, so a junction can't smuggle a path past the check.
    let junc = outside.path().join("jtool");
    junction(&junc, &workspace);
    assert!(
        Object::open(&junc).is_ok(),
        "the junction resolves for a plain open"
    );
    assert!(
        !spec(&workspace, owned_scratch, &[], from_ref(&junc)),
        "a toolchain behind a junction into Spade's data is not containable"
    );
}

// ---- Group G: hard links can't give the person's files a second name in a granted folder ----

/// Runs the helper with `args` in `container` under the token chosen: a Less Privileged
/// AppContainer (`lpac`) or a plain one, with no network either way.
fn run_helper_as(container: &Container, sid: &Sid, lpac: bool, args: &[&str]) -> u32 {
    grant(
        helper().parent().unwrap_or_else(|| std::process::abort()),
        sid,
        Access::Read,
    );
    let args: Vec<OsString> = args.iter().map(OsString::from).collect();
    launch::run_in(
        lpac,
        &container.name,
        &container.display,
        limits(),
        None,
        None,
        helper().as_os_str(),
        &args,
    )
    .unwrap_or_else(|e| panic!("launch: {e}"))
}

/// The helper's exit codes for a hard-link attempt.
const LINKED: u32 = 0;
const SOURCE_REFUSED: u32 = 2;
const LINK_REFUSED: u32 = 5;
/// The helper's exit code when `CreateHardLinkW`, called directly, refused the link.
const DIRECT_REFUSED: u32 = 6;

#[test]
fn a_contained_run_links_only_its_own_files_into_its_own_folders() {
    // A hard link is a second name for one file's data. A contained run may make one between its
    // own files (the control: this must work, or the refusals below prove nothing); it must stop
    // at *opening the source* for one of the person's files, and at *creating the link* for one
    // of its own files into a folder it wasn't granted. Both the Win32 CreateHardLink path and the
    // native NtSetInformationFile path, under both the LPAC token and a plain AppContainer one.
    for lpac in [true, false] {
        let dir = tempfile::tempdir().unwrap_or_else(|_| std::process::abort());
        let workspace = dir.path().join("ws");
        let persons = dir.path().join("persons");
        let ungranted = dir.path().join("ungranted");
        for folder in [&workspace, &persons, &ungranted] {
            std::fs::create_dir_all(folder).unwrap_or_else(|_| std::process::abort());
        }
        let secret = persons.join("secret.txt");
        std::fs::write(&secret, b"the person's bytes").unwrap_or_else(|_| std::process::abort());

        let (container, _profile) = container();
        let sid = profile::ensure(&container.name, &container.display)
            .unwrap_or_else(|_| std::process::abort());
        grant(&workspace, &sid, Access::Write);
        // The run's own file, made after the grant so it carries the inherited ACE.
        let own = workspace.join("own.txt");
        std::fs::write(&own, b"the run's bytes").unwrap_or_else(|_| std::process::abort());

        for how in ["hardlink", "hardlink-nt"] {
            let token = if lpac { "LPAC" } else { "plain AppContainer" };
            let run = |args: &[&str]| run_helper_as(&container, &sid, lpac, args);
            let arg = |path: &Path| path.to_string_lossy().into_owned();

            // Control: its own file, a new name in its own folder — made, and the same file.
            let made = workspace.join(format!("{how}-own.txt"));
            assert_eq!(
                run(&[how, &arg(&own), &arg(&made)]),
                LINKED,
                "{how} under {token}: a link between the run's own files should be made"
            );
            let id = |path: &Path| {
                Object::open(path)
                    .and_then(|object| object.info())
                    .map(|info| info.id)
                    .unwrap_or_else(|e| panic!("{}: {e}", path.display()))
            };
            assert_eq!(
                id(&made),
                id(&own),
                "{how} under {token}: not the same file"
            );

            // The person's file: stopped at opening the source; no second name appears.
            let smuggled = workspace.join(format!("{how}-secret.txt"));
            assert_eq!(
                run(&[how, &arg(&secret), &arg(&smuggled)]),
                SOURCE_REFUSED,
                "{how} under {token}: the person's file must be refused at the source"
            );
            assert!(!smuggled.exists(), "{how} under {token}: a link appeared");

            // Its own file into a folder it wasn't granted: the source opens, the link is refused.
            let escaped = ungranted.join(format!("{how}-out.txt"));
            assert_eq!(
                run(&[how, &arg(&own), &arg(&escaped)]),
                LINK_REFUSED,
                "{how} under {token}: a link into an ungranted folder must be refused"
            );
            assert!(!escaped.exists(), "{how} under {token}: a link appeared");
        }

        // The same three through `CreateHardLinkW` called directly, with no pre-check of ours in
        // front of it: Windows itself refuses the person's file and the ungranted destination.
        let token = if lpac { "LPAC" } else { "plain AppContainer" };
        let run = |args: &[&str]| run_helper_as(&container, &sid, lpac, args);
        let arg = |path: &Path| path.to_string_lossy().into_owned();
        let made = workspace.join("direct-own.txt");
        assert_eq!(
            run(&["hardlink-direct", &arg(&own), &arg(&made)]),
            LINKED,
            "CreateHardLinkW under {token}: a link between the run's own files should be made"
        );
        let smuggled = workspace.join("direct-secret.txt");
        assert_eq!(
            run(&["hardlink-direct", &arg(&secret), &arg(&smuggled)]),
            DIRECT_REFUSED,
            "CreateHardLinkW under {token}: the person's file must be refused"
        );
        assert!(
            !smuggled.exists(),
            "CreateHardLinkW under {token}: a link appeared"
        );
        let escaped = ungranted.join("direct-out.txt");
        assert_eq!(
            run(&["hardlink-direct", &arg(&own), &arg(&escaped)]),
            DIRECT_REFUSED,
            "CreateHardLinkW under {token}: a link into an ungranted folder must be refused"
        );
        assert!(
            !escaped.exists(),
            "CreateHardLinkW under {token}: a link appeared"
        );
        // The person's file is untouched.
        assert_eq!(
            std::fs::read(&secret).unwrap_or_else(|_| std::process::abort()),
            b"the person's bytes"
        );
    }
}
